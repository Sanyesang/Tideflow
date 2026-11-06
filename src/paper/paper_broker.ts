import type { Direction } from "../strategy/tick_momentum.js";

export type PaperTrade = {
  side: "long" | "short";
  entryAtMs: number;
  exitAtMs: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  exitReason: "signal" | "stop_loss" | "take_profit";
};

export type PaperPosition = {
  side: "long" | "short";
  entryAtMs: number;
  entryPrice: number;
  quantity: number;
  entryFeeUsd: number;
  stopPrice: number;
  takeProfitPrice: number;
};

export type PaperBrokerOptions = {
  initialBalanceUsd: number;
  fixedNotionalUsd: number;
  takerFeeBps: number;
  slippageBps: number;
  stopLossBps: number;
  takeProfitBps: number;
};

export class PaperBroker {
  readonly trades: PaperTrade[] = [];
  readonly orderTimestampsMs: number[] = [];
  private balance: number;
  private feesUsd = 0;
  private current: PaperPosition | undefined;

  constructor(private readonly options: PaperBrokerOptions) {
    if (!Number.isFinite(options.initialBalanceUsd) || options.initialBalanceUsd <= 0) throw new Error("Paper balance must be positive.");
    if (!Number.isFinite(options.fixedNotionalUsd) || options.fixedNotionalUsd <= 0 || options.fixedNotionalUsd > options.initialBalanceUsd) {
      throw new Error("Paper order notional must be positive and no greater than initial balance.");
    }
    if (!Number.isFinite(options.takerFeeBps) || options.takerFeeBps < 0) throw new Error("Paper taker fee cannot be negative.");
    if (!Number.isFinite(options.slippageBps) || options.slippageBps < 0 || options.slippageBps >= 10_000) throw new Error("Paper slippage must be between 0 and 10,000 bps.");
    if (!Number.isFinite(options.stopLossBps) || options.stopLossBps <= 0 || !Number.isFinite(options.takeProfitBps) || options.takeProfitBps <= 0) {
      throw new Error("Paper stop-loss and take-profit distances must be positive.");
    }
    this.balance = options.initialBalanceUsd;
  }

  get initialBalanceUsd(): number {
    return this.options.initialBalanceUsd;
  }

  get position(): PaperPosition | undefined {
    return this.current;
  }

  get realizedPnlUsd(): number {
    return this.balance - this.options.initialBalanceUsd;
  }

  get totalFeesUsd(): number {
    return this.feesUsd;
  }

  get cashBalanceUsd(): number {
    return this.balance;
  }

  equityUsd(bid: number, ask: number): number {
    return this.balance + this.unrealizedPnlUsd(bid, ask);
  }

  unrealizedPnlUsd(bid: number, ask: number): number {
    if (!this.current) return 0;
    const exitPrice = this.current.side === "long" ? bid : ask;
    return this.current.side === "long"
      ? (exitPrice - this.current.entryPrice) * this.current.quantity
      : (this.current.entryPrice - exitPrice) * this.current.quantity;
  }

  positionNotionalUsd(bid: number, ask: number): number {
    if (!this.current) return 0;
    return this.current.quantity * (this.current.side === "long" ? bid : ask);
  }

  open(direction: Exclude<Direction, "flat">, bid: number, ask: number, timestampMs: number): void {
    if (this.current) throw new Error("Paper broker already has an open position.");
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) throw new Error("Invalid bid/ask.");
    const slippage = this.options.slippageBps / 10_000;
    const entryPrice = direction === "long" ? ask * (1 + slippage) : bid * (1 - slippage);
    const quantity = this.options.fixedNotionalUsd / entryPrice;
    const entryFeeUsd = this.options.fixedNotionalUsd * this.options.takerFeeBps / 10_000;
    this.balance -= entryFeeUsd;
    this.feesUsd += entryFeeUsd;
    this.current = {
      side: direction,
      entryAtMs: timestampMs,
      entryPrice,
      quantity,
      entryFeeUsd,
      stopPrice: entryPrice * (1 - (direction === "long" ? 1 : -1) * this.options.stopLossBps / 10_000),
      takeProfitPrice: entryPrice * (1 + (direction === "long" ? 1 : -1) * this.options.takeProfitBps / 10_000),
    };
    this.orderTimestampsMs.push(timestampMs);
  }

  close(bid: number, ask: number, timestampMs: number, exitReason: PaperTrade["exitReason"] = "signal"): PaperTrade {
    if (!this.current) throw new Error("Paper broker has no open position.");
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) throw new Error("Invalid bid/ask.");
    const position = this.current;
    const slippage = this.options.slippageBps / 10_000;
    const exitPrice = position.side === "long" ? bid * (1 - slippage) : ask * (1 + slippage);
    const signedMove = position.side === "long" ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
    const grossPnlUsd = signedMove * position.quantity;
    const exitFeeUsd = position.quantity * exitPrice * this.options.takerFeeBps / 10_000;
    const feesUsd = position.entryFeeUsd + exitFeeUsd;
    const trade: PaperTrade = {
      side: position.side,
      entryAtMs: position.entryAtMs,
      exitAtMs: timestampMs,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      grossPnlUsd,
      feesUsd,
      netPnlUsd: grossPnlUsd - feesUsd,
      exitReason,
    };
    this.balance += grossPnlUsd - exitFeeUsd;
    this.feesUsd += exitFeeUsd;
    this.orderTimestampsMs.push(timestampMs);
    this.trades.push(trade);
    this.current = undefined;
    return trade;
  }
}
