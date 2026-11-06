import { OkxMarketDataClient, type OkxMarketMessage, type OkxWebSocketFactory } from "../adapters/okx_market_data.js";
import { parseOkxTickerMessage } from "../market/okx_ticker.js";
import { PaperBroker, type PaperPosition, type PaperTrade } from "../paper/paper_broker.js";
import { RiskGuard, type RiskLimits } from "../risk/risk_guard.js";
import { TickMomentumStrategy } from "../strategy/tick_momentum.js";

export type PaperRuntimeOptions = {
  endpoint: string;
  instId: string;
  initialBalanceUsd: number;
  fixedNotionalUsd: number;
  takerFeeBps: number;
  slippageBps: number;
  stopLossBps: number;
  takeProfitBps: number;
  lookbackTicks: number;
  entryThresholdBps: number;
  allowShort: boolean;
  riskLimits: RiskLimits;
  onTrade?: (trade: PaperTrade) => void;
  onStatus?: (message: string) => void;
  onReport?: (report: PaperSessionReport) => void;
  /** Injection point for deterministic tests; omit in normal use. */
  webSocketFactory?: OkxWebSocketFactory;
};

export type PaperSessionReport = {
  instrumentId: string;
  startedAt: string;
  stoppedAt: string;
  stopReason: "operator_stop" | "market_data_disconnected";
  initialBalanceUsd: number;
  cashBalanceUsd: number;
  realizedCashChangeUsd: number;
  unrealizedGrossPnlUsd: number;
  endingEquityUsd: number;
  totalFeesUsd: number;
  closedTradeCount: number;
  wins: number;
  winRatePct: number;
  closedTradeNetPnlUsd: number;
  openPosition: PaperPosition | null;
  note: string;
};

export class PaperRuntime {
  private readonly broker: PaperBroker;
  private readonly strategy: TickMomentumStrategy;
  private readonly riskGuard: RiskGuard;
  private readonly market: OkxMarketDataClient;
  private readonly onStatus: (message: string) => void;
  private readonly onTrade: (trade: PaperTrade) => void;
  private readonly onReport: (report: PaperSessionReport) => void;
  private started = false;
  private startedAtMs: number | undefined;
  private lastTicker: ReturnType<typeof parseOkxTickerMessage>[number] | undefined;
  private reportEmitted = false;

  constructor(private readonly options: PaperRuntimeOptions) {
    this.broker = new PaperBroker(options);
    this.strategy = new TickMomentumStrategy({
      lookbackTicks: options.lookbackTicks,
      entryThresholdBps: options.entryThresholdBps,
      allowShort: options.allowShort,
    });
    this.riskGuard = new RiskGuard(options.riskLimits);
    this.onStatus = options.onStatus ?? ((message) => process.stdout.write(`${message}\n`));
    this.onTrade = options.onTrade ?? ((trade) => process.stdout.write(`${JSON.stringify({ type: "paper_trade", ...trade })}\n`));
    this.onReport = options.onReport ?? ((report) => process.stdout.write(`${JSON.stringify({ type: "paper_session_report", ...report }, null, 2)}\n`));
    this.market = new OkxMarketDataClient({
      endpoint: options.endpoint,
      instId: options.instId,
      channels: ["tickers"],
      ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
      onMessage: (message) => this.handleMarketMessage(message),
      onError: (error) => this.onStatus(`market-data error: ${error.message}`),
      onClose: (code, reason) => {
        this.started = false;
        this.onStatus(`market-data disconnected (code ${code ?? "unknown"}); fail-stopped without auto-reconnect. ${reason ?? ""}`);
        if (this.startedAtMs !== undefined) this.emitReport("market_data_disconnected");
      },
    });
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Paper runtime already started.");
    if (this.startedAtMs !== undefined) throw new Error("A paper session cannot be restarted after stop/disconnect; create a fresh runtime instance.");
    this.started = true;
    try {
      await this.market.connect();
    } catch (error) {
      this.started = false;
      throw error;
    }
    this.startedAtMs = Date.now();
    this.reportEmitted = false;
    this.onStatus(`Paper mode connected for ${this.options.instId}; no authenticated/private endpoint is used.`);
  }

  stop(): void {
    this.market.close();
    this.started = false;
    this.onStatus("Paper runtime stopped. Any simulated position remains in the session report only.");
    if (this.startedAtMs !== undefined) this.emitReport("operator_stop");
  }

  private handleMarketMessage(message: OkxMarketMessage): void {
    const receivedAtMs = Date.now();
    for (const ticker of parseOkxTickerMessage(message, receivedAtMs)) {
      if (ticker.instId !== this.options.instId) continue;
      this.lastTicker = ticker;
      const marketAgeMs = receivedAtMs - ticker.exchangeTimestampMs;
      if (marketAgeMs < 0 || marketAgeMs > this.options.riskLimits.maxMarketAgeMs) {
        this.onStatus(`ignored stale/future market tick for ${ticker.instId} (age=${marketAgeMs}ms); no position action taken.`);
        continue;
      }
      const signal = this.strategy.update(ticker.last);
      const position = this.broker.position;

      if (position) {
        const stopHit = position.side === "long" ? ticker.last <= position.stopPrice : ticker.last >= position.stopPrice;
        const targetHit = position.side === "long" ? ticker.last >= position.takeProfitPrice : ticker.last <= position.takeProfitPrice;
        if (stopHit) {
          this.onTrade(this.broker.close(ticker.bid, ticker.ask, receivedAtMs, "stop_loss"));
          return;
        }
        if (targetHit) {
          this.onTrade(this.broker.close(ticker.bid, ticker.ask, receivedAtMs, "take_profit"));
          return;
        }
      }
      if (position && signal.direction !== position.side) {
        this.onTrade(this.broker.close(ticker.bid, ticker.ask, receivedAtMs));
        return;
      }
      if (position || signal.direction === "flat") return;

      const decision = this.riskGuard.evaluate({
        nowMs: receivedAtMs,
        bid: ticker.bid,
        ask: ticker.ask,
        // Trust the exchange timestamp for freshness, not the local receive
        // time; otherwise a delayed/stale packet would always appear fresh.
        marketObservedAtMs: ticker.exchangeTimestampMs,
        proposedPrice: signal.direction === "long" ? ticker.ask : ticker.bid,
        // Size against the executable side (ask for a long, bid for a short),
        // so spread does not push the risk check above the configured cap.
        proposedQuantity: this.options.fixedNotionalUsd / (signal.direction === "long" ? ticker.ask : ticker.bid),
        equityUsd: this.broker.equityUsd(ticker.bid, ticker.ask),
        realizedPnlTodayUsd: this.broker.realizedPnlUsd,
        unrealizedPnlUsd: this.broker.unrealizedPnlUsd(ticker.bid, ticker.ask),
        currentPositionNotionalUsd: this.broker.positionNotionalUsd(ticker.bid, ticker.ask),
        openOrderNotionalUsd: 0,
        recentOrderTimestampsMs: this.broker.orderTimestampsMs,
        killSwitch: false,
        accountReconciled: true,
      });
      if (!decision.allowed) {
        this.onStatus(`risk blocked ${signal.direction} at ${ticker.last}: ${decision.reason}`);
        return;
      }

      this.broker.open(signal.direction, ticker.bid, ticker.ask, receivedAtMs);
      this.onStatus(`paper ${signal.direction} ${ticker.instId} price=${ticker.last} moveBps=${signal.moveBps?.toFixed(2) ?? "n/a"}`);
    }
  }

  private emitReport(stopReason: PaperSessionReport["stopReason"]): void {
    if (this.reportEmitted || this.startedAtMs === undefined) return;
    this.reportEmitted = true;
    const stoppedAtMs = Date.now();
    const last = this.lastTicker;
    const unrealizedGrossPnlUsd = last ? this.broker.unrealizedPnlUsd(last.bid, last.ask) : 0;
    const closedTradeNetPnlUsd = this.broker.trades.reduce((sum, trade) => sum + trade.netPnlUsd, 0);
    const wins = this.broker.trades.filter((trade) => trade.netPnlUsd > 0).length;
    this.onReport({
      instrumentId: this.options.instId,
      startedAt: new Date(this.startedAtMs).toISOString(),
      stoppedAt: new Date(stoppedAtMs).toISOString(),
      stopReason,
      initialBalanceUsd: this.broker.initialBalanceUsd,
      cashBalanceUsd: this.broker.cashBalanceUsd,
      realizedCashChangeUsd: this.broker.realizedPnlUsd,
      unrealizedGrossPnlUsd,
      endingEquityUsd: this.broker.cashBalanceUsd + unrealizedGrossPnlUsd,
      totalFeesUsd: this.broker.totalFeesUsd,
      closedTradeCount: this.broker.trades.length,
      wins,
      winRatePct: this.broker.trades.length === 0 ? 0 : (wins / this.broker.trades.length) * 100,
      closedTradeNetPnlUsd,
      openPosition: this.broker.position ? { ...this.broker.position } : null,
      note: "Paper simulation only. Open positions are not closed automatically on stop/disconnect; unrealized PnL excludes estimated exit fees.",
    });
  }
}
