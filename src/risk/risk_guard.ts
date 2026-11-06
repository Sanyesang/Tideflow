export type RiskLimits = {
  maxOrderNotionalUsd: number;
  maxPositionNotionalUsd: number;
  dailyLossLimitUsd: number;
  maxOrdersPerMinute: number;
  maxSpreadBps: number;
  orderCooldownMs: number;
  maxMarketAgeMs: number;
};

export type RiskSnapshot = {
  nowMs: number;
  bid: number;
  ask: number;
  marketObservedAtMs: number;
  proposedPrice: number;
  proposedQuantity: number;
  equityUsd: number;
  realizedPnlTodayUsd: number;
  unrealizedPnlUsd: number;
  currentPositionNotionalUsd: number;
  openOrderNotionalUsd: number;
  recentOrderTimestampsMs: number[];
  killSwitch: boolean;
  /** False until an authoritative exchange reconciliation has completed. */
  accountReconciled: boolean;
};

export type RiskDecision =
  | { allowed: true; orderNotionalUsd: number; projectedGrossNotionalUsd: number }
  | { allowed: false; reason: string };

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export class RiskGuard {
  constructor(private readonly limits: RiskLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number.`);
    }
    if (limits.maxOrderNotionalUsd <= 0 || limits.maxPositionNotionalUsd <= 0 || limits.dailyLossLimitUsd <= 0
      || !Number.isInteger(limits.maxOrdersPerMinute) || limits.maxOrdersPerMinute <= 0
      || limits.maxSpreadBps <= 0 || !Number.isInteger(limits.orderCooldownMs) || limits.maxMarketAgeMs <= 0) {
      throw new Error("Order, position, rate, and market-age limits must be greater than zero.");
    }
  }

  evaluate(snapshot: RiskSnapshot): RiskDecision {
    if (snapshot.killSwitch) return { allowed: false, reason: "Kill switch is active." };
    if (!snapshot.accountReconciled) return { allowed: false, reason: "Account/order reconciliation is incomplete." };
    if (!isFinitePositive(snapshot.equityUsd)) return { allowed: false, reason: "Verified positive account equity is required." };
    if (!isFinitePositive(snapshot.bid) || !isFinitePositive(snapshot.ask) || snapshot.ask < snapshot.bid) {
      return { allowed: false, reason: "Market bid/ask is invalid." };
    }
    if (!Number.isFinite(snapshot.marketObservedAtMs) || snapshot.marketObservedAtMs > snapshot.nowMs || snapshot.nowMs - snapshot.marketObservedAtMs > this.limits.maxMarketAgeMs) {
      return { allowed: false, reason: "Market data is stale or timestamp-invalid." };
    }
    if (!isFinitePositive(snapshot.proposedPrice) || !isFinitePositive(snapshot.proposedQuantity)) {
      return { allowed: false, reason: "Proposed price and quantity must be positive finite numbers." };
    }

    const mid = (snapshot.bid + snapshot.ask) / 2;
    const spreadBps = ((snapshot.ask - snapshot.bid) / mid) * 10_000;
    if (!Number.isFinite(spreadBps) || spreadBps > this.limits.maxSpreadBps) {
      return { allowed: false, reason: "Spread exceeds the configured maximum." };
    }

    const dailyPnl = snapshot.realizedPnlTodayUsd + snapshot.unrealizedPnlUsd;
    if (!Number.isFinite(dailyPnl) || dailyPnl <= -this.limits.dailyLossLimitUsd) {
      return { allowed: false, reason: "Daily loss limit reached or PnL state is invalid." };
    }

    const orderNotionalUsd = snapshot.proposedPrice * snapshot.proposedQuantity;
    if (!isFinitePositive(orderNotionalUsd) || orderNotionalUsd > this.limits.maxOrderNotionalUsd) {
      return { allowed: false, reason: "Order notional exceeds the configured maximum." };
    }

    const currentExposure = snapshot.currentPositionNotionalUsd + snapshot.openOrderNotionalUsd;
    if (!Number.isFinite(currentExposure) || currentExposure < 0) {
      return { allowed: false, reason: "Position/open-order exposure is invalid." };
    }
    const projectedGrossNotionalUsd = currentExposure + orderNotionalUsd;
    if (projectedGrossNotionalUsd > this.limits.maxPositionNotionalUsd) {
      return { allowed: false, reason: "Projected gross exposure exceeds the configured maximum." };
    }

    const cutoff = snapshot.nowMs - 60_000;
    const recentOrders = snapshot.recentOrderTimestampsMs.filter((timestamp) => timestamp >= cutoff && timestamp <= snapshot.nowMs);
    if (snapshot.recentOrderTimestampsMs.some((timestamp) => !Number.isFinite(timestamp) || timestamp > snapshot.nowMs)) {
      return { allowed: false, reason: "Order history contains an invalid or future timestamp." };
    }
    if (recentOrders.length >= this.limits.maxOrdersPerMinute) {
      return { allowed: false, reason: "Order-rate limit reached." };
    }
    const lastOrderAt = recentOrders.length > 0 ? Math.max(...recentOrders) : undefined;
    if (lastOrderAt !== undefined && snapshot.nowMs - lastOrderAt < this.limits.orderCooldownMs) {
      return { allowed: false, reason: "Order cooldown is active." };
    }

    return { allowed: true, orderNotionalUsd, projectedGrossNotionalUsd };
  }
}
