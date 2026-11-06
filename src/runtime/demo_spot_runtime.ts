import { OkxExecutionClient, type PreparedOkxOrder } from "../adapters/okx_execution.js";
import { OkxMarketDataClient, type OkxMarketMessage, type OkxWebSocketFactory } from "../adapters/okx_market_data.js";
import type { OkxSpotInstrument } from "../adapters/okx_instruments.js";
import { parseSpotCurrencyBalance, parseSpotCurrencyBalanceExact } from "../execution/spot_balance.js";
import { quantizeSpotBuySize, quantizeSpotSellSize } from "../execution/spot_sizing.js";
import { OkxOrderCoordinator } from "../execution/order_coordinator.js";
import { parseOkxTickerMessage, type OkxTicker } from "../market/okx_ticker.js";
import { TradeJournal } from "../persistence/trade_journal.js";
import { RiskGuard, type RiskLimits } from "../risk/risk_guard.js";
import { TickMomentumStrategy } from "../strategy/tick_momentum.js";

type SpotPosition = {
  quantity: number;
  quantityText: string;
  entryPrice: number;
  entryPriceText: string;
  entryCostQuote: number;
  entryClientOrderId: string;
  entryOrderId: string;
  stopPrice: number;
  takeProfitPrice: number;
};

type PendingSpotOrder = {
  prepared: PreparedOkxOrder;
  purpose: "open" | "close";
  quoteBefore: number;
  positionBefore?: SpotPosition;
  exitReason?: "stop_loss" | "take_profit" | "signal";
};

export type DemoSpotRuntimeOptions = {
  endpoint: string;
  instId: string;
  instrument: OkxSpotInstrument;
  client: OkxExecutionClient;
  coordinator: OkxOrderCoordinator;
  journal: TradeJournal;
  quoteBudget: string;
  slippagePct: string;
  stopLossBps: number;
  takeProfitBps: number;
  lookbackTicks: number;
  entryThresholdBps: number;
  riskLimits: RiskLimits;
  onStatus?: (message: string) => void;
  webSocketFactory?: OkxWebSocketFactory;
};

function field(value: unknown, name: string): string | undefined {
  if (typeof value !== "object" || value === null || !(name in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[name];
  return typeof candidate === "string" ? candidate : undefined;
}

function positiveNumber(value: string | undefined, name: string): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Exchange ${name} is missing or invalid; automation remains stopped.`);
  return parsed;
}

function decimalText(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) throw new Error("Numeric result is outside the supported decimal range; manual reconciliation required.");
  const text = value.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" || text === "" ? "0" : text;
}

/**
 * Single-symbol, spot-only demo executor. It is deliberately long-only and
 * fail-stops on uncertain order/account state; it never reconnects or retries.
 */
export class DemoSpotRuntime {
  private readonly market: OkxMarketDataClient;
  private readonly strategy: TickMomentumStrategy;
  private readonly riskGuard: RiskGuard;
  private readonly onStatus: (message: string) => void;
  private started = false;
  private stopped = false;
  private halted = false;
  private reconciled = false;
  private active: PendingSpotOrder | undefined;
  private position: SpotPosition | undefined;
  private initialQuoteBalance = 0;
  private realizedQuotePnl = 0;
  private lastOrderTimes: number[] = [];
  private queue = Promise.resolve();
  private lastValidTickerAtMs = 0;
  private lastTicker: OkxTicker | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: DemoSpotRuntimeOptions) {
    if (options.client.configuredEnvironment !== "demo") {
      throw new Error("DemoSpotRuntime requires an OKX client explicitly configured for the simulated-trading environment.");
    }
    if (options.instrument.instId !== options.instId || options.instrument.state !== "live"
      || options.instrument.quoteCcy !== "USDT") {
      throw new Error("DemoSpotRuntime currently supports active USDT-quoted SPOT instruments only.");
    }
    const budget = Number(options.quoteBudget);
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(options.quoteBudget) || !Number.isFinite(budget) || budget <= 0) {
      throw new Error("quoteBudget must be a positive decimal string.");
    }
    if (!Number.isFinite(options.stopLossBps) || options.stopLossBps <= 0 || options.stopLossBps >= 10_000
      || !Number.isFinite(options.takeProfitBps) || options.takeProfitBps <= 0) {
      throw new Error("Stop-loss and take-profit distances must be positive; stop-loss must be below 10,000 bps.");
    }
    if (!/^(?:0|0\.\d{1,4})$/.test(options.slippagePct) || Number(options.slippagePct) > 0.05) {
      throw new Error("slippagePct must be a decimal fraction from 0 to 0.05 with at most four decimal places.");
    }
    this.strategy = new TickMomentumStrategy({
      lookbackTicks: options.lookbackTicks,
      entryThresholdBps: options.entryThresholdBps,
      allowShort: false,
    });
    this.riskGuard = new RiskGuard(options.riskLimits);
    this.onStatus = options.onStatus ?? ((message) => process.stdout.write(`${message}\n`));
    this.market = new OkxMarketDataClient({
      endpoint: options.endpoint,
      instId: options.instId,
      channels: ["tickers"],
      ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
      onMessage: (message) => {
        this.queue = this.queue.then(() => this.handleMarketMessage(message)).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : "unknown runtime error";
          this.failStop(`execution halted: ${detail}`);
        });
      },
      onError: (error) => this.onStatus(`market-data error: ${error.message}`),
      onClose: (code, reason) => {
        this.started = false;
        this.clearWatchdog();
        this.onStatus(`market-data disconnected (code ${code ?? "unknown"}); no reconnect or order retry. ${reason ?? ""}`);
        if (this.active) this.onStatus(`unresolved ${this.active.purpose} order ${this.active.prepared.clientOrderId}; inspect the local journal and reconcile manually.`);
        if (this.position) this.onStatus("A spot position remains open; local stop/target monitoring is unavailable while disconnected. Manage it manually.");
      },
    });
  }

  async start(): Promise<void> {
    if (this.started || this.reconciled || this.stopped) throw new Error("Demo spot runtime instances are single-use.");
    const snapshot = await this.options.coordinator.assertSafeSpotStartup(
      this.options.instId,
      this.options.instrument.baseCcy,
      this.options.instrument.quoteCcy,
    );
    const budget = Number(this.options.quoteBudget);
    if (snapshot.quoteAvailable < budget) throw new Error("Configured quote budget exceeds the available demo balance.");
    this.initialQuoteBalance = snapshot.quoteAvailable;
    this.reconciled = true;
    this.started = true;
    try {
      await this.market.connect();
    } catch (error) {
      this.started = false;
      throw error;
    }
    this.lastValidTickerAtMs = Date.now();
    this.watchdog = setInterval(() => {
      if (this.started && Date.now() - this.lastValidTickerAtMs > this.options.riskLimits.maxMarketAgeMs) {
        this.failStop("market-data silence exceeded the freshness limit");
      }
    }, Math.min(500, Math.max(100, Math.floor(this.options.riskLimits.maxMarketAgeMs / 4))));
    this.onStatus(`Demo SPOT connected for ${this.options.instId}; startup balances, pending orders, and local journal were reconciled. No live account is permitted.`);
  }

  /** Read-only UI snapshot; it never returns credentials or enables execution. */
  snapshot(): {
    status: "idle" | "running" | "stopped" | "halted";
    ticker: OkxTicker | null;
    pendingOrder: { purpose: "open" | "close"; clientOrderId: string } | null;
    position: { quantity: number; entryPrice: number; stopPrice: number; takeProfitPrice: number } | null;
    realizedQuotePnl: number;
  } {
    return {
      status: this.halted ? "halted" : this.started && !this.stopped ? "running" : this.stopped ? "stopped" : "idle",
      ticker: this.lastTicker ?? null,
      pendingOrder: this.active ? { purpose: this.active.purpose, clientOrderId: this.active.prepared.clientOrderId } : null,
      position: this.position ? {
        quantity: this.position.quantity,
        entryPrice: this.position.entryPrice,
        stopPrice: this.position.stopPrice,
        takeProfitPrice: this.position.takeProfitPrice,
      } : null,
      realizedQuotePnl: this.realizedQuotePnl,
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.clearWatchdog();
    this.market.close();
    this.onStatus(this.active
      ? `Stopped with an unresolved ${this.active.purpose} order; do not restart until it is reconciled.`
      : this.position
        ? `Stopped with a confirmed spot position of ${this.position.quantity}; it remains open and will no longer have local stop/target monitoring.`
        : "Demo spot runtime stopped flat.");
  }

  private async handleMarketMessage(message: OkxMarketMessage): Promise<void> {
    if (!this.started || this.stopped || this.halted) return;
    const receivedAtMs = Date.now();
    for (const ticker of parseOkxTickerMessage(message, receivedAtMs)) {
      if (ticker.instId !== this.options.instId) continue;
      const age = receivedAtMs - ticker.exchangeTimestampMs;
      if (age < 0 || age > this.options.riskLimits.maxMarketAgeMs) {
        this.onStatus(`ignored stale/future market tick (age=${age}ms); no order action taken.`);
        continue;
      }
      this.lastTicker = ticker;
      this.lastValidTickerAtMs = receivedAtMs;
      if (this.active) {
        await this.progressActiveOrder();
        continue;
      }

      const signal = this.strategy.update(ticker.last);
      if (this.position) {
        if (ticker.last <= this.position.stopPrice) {
          await this.submitClose(ticker, receivedAtMs, ticker.exchangeTimestampMs, "stop_loss");
        } else if (ticker.last >= this.position.takeProfitPrice) {
          await this.submitClose(ticker, receivedAtMs, ticker.exchangeTimestampMs, "take_profit");
        } else if (signal.moveBps !== null && signal.moveBps <= -this.options.entryThresholdBps) {
          await this.submitClose(ticker, receivedAtMs, ticker.exchangeTimestampMs, "signal");
        }
        return;
      }
      if (signal.direction !== "long") continue;
      await this.submitOpen(ticker, receivedAtMs, ticker.exchangeTimestampMs);
    }
  }

  private async submitOpen(ticker: { bid: number; ask: number }, nowMs: number, marketObservedAtMs: number): Promise<void> {
    const budget = Number(this.options.quoteBudget);
    const quantity = quantizeSpotBuySize(this.options.quoteBudget, String(ticker.ask), this.options.instrument);
    const decision = this.riskGuard.evaluate({
      nowMs,
      bid: ticker.bid,
      ask: ticker.ask,
      marketObservedAtMs,
      proposedPrice: ticker.ask,
      proposedQuantity: Number(quantity),
      equityUsd: this.initialQuoteBalance + this.realizedQuotePnl,
      realizedPnlTodayUsd: this.realizedQuotePnl,
      unrealizedPnlUsd: 0,
      currentPositionNotionalUsd: 0,
      openOrderNotionalUsd: 0,
      recentOrderTimestampsMs: this.lastOrderTimes,
      killSwitch: this.halted || this.stopped,
      accountReconciled: this.reconciled,
    });
    if (!decision.allowed) {
      this.onStatus(`risk blocked demo buy: ${decision.reason}`);
      return;
    }
    if (decision.orderNotionalUsd > budget) {
      this.onStatus("risk blocked demo buy: rounded quantity exceeds quote budget.");
      return;
    }
    const quoteBalance = parseSpotCurrencyBalance(await this.options.client.getAccountBalance(), this.options.instrument.quoteCcy);
    if (quoteBalance.available < budget) {
      this.onStatus("risk blocked demo buy: available quote balance fell below configured budget.");
      return;
    }
    this.lastOrderTimes.push(nowMs);
    await this.submitOrder({
      instId: this.options.instId,
      tdMode: "cash",
      side: "buy",
      ordType: "market",
      sz: quantity,
      tgtCcy: "base_ccy",
      banAmend: true,
      slippagePct: this.options.slippagePct,
    }, "open", quoteBalance.available);
  }

  private async submitClose(
    ticker: { bid: number; ask: number },
    nowMs: number,
    marketObservedAtMs: number,
    exitReason: "stop_loss" | "take_profit" | "signal",
  ): Promise<void> {
    const position = this.position;
    if (!position) return;
    const recentAttempts = this.lastOrderTimes.filter((timestamp) => timestamp >= nowMs - 60_000 && timestamp <= nowMs);
    if (recentAttempts.length >= this.options.riskLimits.maxOrdersPerMinute) {
      throw new Error("Protective sell reached the configured order-attempt limit; automatic retries are stopped for manual review.");
    }
    const balances = await this.options.client.getAccountBalance();
    const base = parseSpotCurrencyBalanceExact(balances, this.options.instrument.baseCcy);
    const availableBase = Number(base.available);
    if (Number(base.frozen) > 0 || availableBase <= 0) throw new Error("Spot base balance is frozen or unavailable while a position is recorded; manual reconciliation required.");
    const balanceTolerance = Math.max(Number(this.options.instrument.lotSz) * 1e-6, 1e-12);
    if (Math.abs(availableBase - position.quantity) > balanceTolerance) {
      throw new Error("Spot base balance changed outside this runtime; refusing to sell an unexpected amount.");
    }
    const baseSize = quantizeSpotSellSize(base.available, this.options.instrument);
    if (!Number.isFinite(ticker.bid) || !Number.isFinite(ticker.ask) || ticker.bid <= 0 || ticker.ask < ticker.bid
      || nowMs - marketObservedAtMs > this.options.riskLimits.maxMarketAgeMs) {
      throw new Error("Protective sell requires a valid, fresh quote; position remains open for manual review.");
    }
    const quoteTarget = decimalText(Number(baseSize) * ticker.bid);
    this.lastOrderTimes.push(nowMs);
    await this.submitOrder({
      instId: this.options.instId,
      tdMode: "cash",
      side: "sell",
      ordType: "market",
      // OKX expects tgtCcy to describe the received currency when slippagePct
      // is used; for a sell this means quote_ccy. Proceeds are anchored to the
      // available, lot-quantized base balance and current bid.
      sz: quoteTarget,
      tgtCcy: "quote_ccy",
      banAmend: false,
      slippagePct: this.options.slippagePct,
    }, "close", parseSpotCurrencyBalance(balances, this.options.instrument.quoteCcy).available, position, exitReason);
  }

  private async submitOrder(
    order: Parameters<OkxExecutionClient["prepareOrder"]>[0],
    purpose: "open" | "close",
    quoteBefore: number,
    positionBefore?: SpotPosition,
    exitReason?: "stop_loss" | "take_profit" | "signal",
  ): Promise<boolean> {
    const prepared = this.options.client.prepareOrder(order);
    try {
      const submitted = await this.options.coordinator.submitPrepared(prepared);
      this.active = {
        prepared: submitted.prepared,
        purpose,
        quoteBefore,
        ...(positionBefore ? { positionBefore } : {}),
        ...(exitReason ? { exitReason } : {}),
      };
      this.onStatus(`demo ${purpose} order submitted once (${submitted.prepared.clientOrderId}); awaiting exchange-state reconciliation.`);
      return true;
    } catch (error) {
      // If the durable ledger still considers this ID unresolved, the exchange
      // may have accepted it even when the caller saw a local write failure.
      const unresolved = await this.options.journal.getUnresolvedOrderIntents();
      if (unresolved.some((intent) => intent.clientOrderId === prepared.clientOrderId)) {
        this.active = {
          prepared,
          purpose,
          quoteBefore,
          ...(positionBefore ? { positionBefore } : {}),
          ...(exitReason ? { exitReason } : {}),
        };
        this.onStatus(`demo order outcome is unresolved (${prepared.clientOrderId}); automatic retries are disabled and lookup is required.`);
        return true;
      }
      this.onStatus(`demo ${purpose} order rejected before acceptance: ${error instanceof Error ? error.message : "unknown error"}`);
      return false;
    }
  }

  private async progressActiveOrder(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const result = await this.options.coordinator.reconcile(active.prepared.clientOrderId, this.options.instId);
    const state = field(result, "state");
    const filledSizeText = field(result, "accFillSz");
    const filledSize = Number(filledSizeText);
    if (state === "live" || state === "partially_filled") return;
    if (!["filled", "canceled", "mmp_canceled"].includes(state ?? "") || !Number.isFinite(filledSize) || filledSize < 0) {
      throw new Error("Order reconciliation did not return a supported terminal state.");
    }
    if (active.purpose === "open") {
      await this.finishOpen(active, result, filledSize);
    } else {
      await this.finishClose(active, result, filledSize, filledSizeText ?? "0");
    }
    this.active = undefined;
  }

  private async finishOpen(active: PendingSpotOrder, order: unknown, filledSize: number): Promise<void> {
    const balances = await this.options.client.getAccountBalance();
    const base = parseSpotCurrencyBalanceExact(balances, this.options.instrument.baseCcy);
    const quote = parseSpotCurrencyBalance(balances, this.options.instrument.quoteCcy);
    const availableBase = Number(base.available);
    if (Number(base.frozen) > 0 || availableBase < 0) throw new Error("Post-buy base balance is frozen/invalid; manual reconciliation required.");
    if (availableBase === 0) {
      if (filledSize > 0) throw new Error("Exchange reports a buy fill but the account shows no base asset; manual reconciliation required.");
      this.onStatus(`demo buy ended ${field(order, "state")} with zero fill; account remains flat.`);
      return;
    }
    if (filledSize <= 0) throw new Error("Account has base exposure without a matching buy fill; automation remains stopped.");
    const entryPrice = positiveNumber(field(order, "avgPx"), "average fill price");
    if (availableBase > filledSize + Number(this.options.instrument.lotSz)) {
      throw new Error("Account base balance exceeds the reconciled order fill; possible outside balance change, stop for manual review.");
    }
    const entryCostQuote = active.quoteBefore - quote.available;
    if (!Number.isFinite(entryCostQuote) || entryCostQuote <= 0) throw new Error("Post-buy quote balance did not confirm a positive cost; manual reconciliation required.");
    const position: SpotPosition = {
      quantity: availableBase,
      quantityText: base.available,
      entryPrice,
      entryPriceText: field(order, "avgPx")!,
      entryCostQuote,
      entryClientOrderId: active.prepared.clientOrderId,
      entryOrderId: field(order, "ordId") ?? "",
      stopPrice: entryPrice * (1 - this.options.stopLossBps / 10_000),
      takeProfitPrice: entryPrice * (1 + this.options.takeProfitBps / 10_000),
    };
    if (!position.entryOrderId) throw new Error("Filled buy is missing the exchange order ID; manual reconciliation required.");
    this.position = position;
    await this.options.journal.append({
      kind: "spot_position_open",
      at: new Date().toISOString(),
      instId: this.options.instId,
      clientOrderId: position.entryClientOrderId,
      orderId: position.entryOrderId,
      baseSize: position.quantityText,
      entryPrice: position.entryPriceText,
      entryCostQuote: decimalText(position.entryCostQuote),
      quoteCcy: this.options.instrument.quoteCcy,
    });
    this.onStatus(`confirmed demo spot position: ${position.quantity} ${this.options.instrument.baseCcy} at avg ${position.entryPrice}; stop=${position.stopPrice}, target=${position.takeProfitPrice}.`);
  }

  private async finishClose(active: PendingSpotOrder, order: unknown, filledSize: number, filledSizeText: string): Promise<void> {
    const previous = active.positionBefore;
    if (!previous) throw new Error("Close order has no recorded starting position; manual reconciliation required.");
    const balances = await this.options.client.getAccountBalance();
    const base = parseSpotCurrencyBalanceExact(balances, this.options.instrument.baseCcy);
    const quote = parseSpotCurrencyBalance(balances, this.options.instrument.quoteCcy);
    const remaining = Number(base.available);
    if (Number(base.frozen) > 0 || remaining > previous.quantity + Number(this.options.instrument.lotSz)) {
      throw new Error("Post-sell base balance is inconsistent with the recorded position; manual reconciliation required.");
    }
    if (filledSize <= 0) {
      this.position = previous;
      this.onStatus(`demo sell ended ${field(order, "state")} with zero fill; position remains open.`);
      return;
    }
    const exitPriceText = field(order, "avgPx");
    const exitPrice = positiveNumber(exitPriceText, "average exit fill price");
    const soldQuantity = Math.min(filledSize, previous.quantity);
    const allocatedEntryCost = previous.entryCostQuote * (soldQuantity / previous.quantity);
    const quoteProceeds = quote.available - active.quoteBefore;
    if (!Number.isFinite(quoteProceeds) || quoteProceeds < 0) throw new Error("Post-sell quote balance did not confirm sale proceeds; manual reconciliation required.");
    const realizedPnlQuote = quoteProceeds - allocatedEntryCost;
    await this.options.journal.append({
      kind: "spot_trade_closed",
      at: new Date().toISOString(),
      instId: this.options.instId,
      entryClientOrderId: previous.entryClientOrderId,
      exitClientOrderId: active.prepared.clientOrderId,
      baseSize: filledSizeText,
      entryPrice: previous.entryPriceText,
      exitPrice: exitPriceText!,
      realizedPnlQuote: decimalText(realizedPnlQuote),
      quoteCcy: this.options.instrument.quoteCcy,
    });
    this.realizedQuotePnl += realizedPnlQuote;
    if (remaining > 0) {
      this.position = { ...previous, quantity: remaining, quantityText: base.available, entryCostQuote: Math.max(0, previous.entryCostQuote - allocatedEntryCost) };
      this.onStatus(`demo sell partially closed; ${remaining} ${this.options.instrument.baseCcy} remains. No new position will open until this is fully sold.`);
    } else {
      this.position = undefined;
      this.onStatus(`demo spot position closed at avg ${exitPrice}; quote-balance realized change=${realizedPnlQuote.toFixed(8)} ${this.options.instrument.quoteCcy} (fees paid outside quote currency may not be reflected).`);
    }
  }

  private failStop(message: string): void {
    if (this.halted) return;
    this.halted = true;
    this.started = false;
    this.clearWatchdog();
    this.market.close();
    this.onStatus(`${message}; runtime is fail-stopped. Do not restart before reviewing the account and local journal.`);
    if (this.position) this.onStatus("A spot position remains open; local stop/target monitoring has stopped. Manage it manually.");
  }

  private clearWatchdog(): void {
    if (this.watchdog !== undefined) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }
}
