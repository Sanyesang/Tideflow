import { describe, expect, it } from "vitest";
import { RiskGuard, type RiskLimits, type RiskSnapshot } from "../src/risk/risk_guard.js";

const limits: RiskLimits = {
  maxOrderNotionalUsd: 500,
  maxPositionNotionalUsd: 1_000,
  dailyLossLimitUsd: 100,
  maxOrdersPerMinute: 5,
  maxSpreadBps: 20,
  orderCooldownMs: 1_000,
  maxMarketAgeMs: 2_000,
};

function snapshot(overrides: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    nowMs: 10_000,
    bid: 99.95,
    ask: 100.05,
    marketObservedAtMs: 9_500,
    proposedPrice: 100,
    proposedQuantity: 1,
    equityUsd: 5_000,
    realizedPnlTodayUsd: 0,
    unrealizedPnlUsd: 0,
    currentPositionNotionalUsd: 0,
    openOrderNotionalUsd: 0,
    recentOrderTimestampsMs: [],
    killSwitch: false,
    accountReconciled: true,
    ...overrides,
  };
}

describe("RiskGuard", () => {
  it("allows an order only when all required state is current and within limits", () => {
    expect(new RiskGuard(limits).evaluate(snapshot())).toEqual({
      allowed: true,
      orderNotionalUsd: 100,
      projectedGrossNotionalUsd: 100,
    });
  });

  it.each<[string, Partial<RiskSnapshot>]>([
    ["kill switch", { killSwitch: true }],
    ["unreconciled account", { accountReconciled: false }],
    ["stale market", { marketObservedAtMs: 7_000 }],
    ["daily loss", { realizedPnlTodayUsd: -100 }],
    ["order size", { proposedQuantity: 6 }],
    ["position exposure", { currentPositionNotionalUsd: 950 }],
    ["rate cap", { recentOrderTimestampsMs: [9_900, 9_800, 9_700, 9_600, 9_500] }],
  ])("blocks on %s", (_name, overrides) => {
    expect(new RiskGuard(limits).evaluate(snapshot(overrides))).toMatchObject({ allowed: false });
  });

  it("blocks exchange timestamps that are ahead of the local clock", () => {
    expect(new RiskGuard(limits).evaluate(snapshot({ marketObservedAtMs: 10_001 }))).toMatchObject({ allowed: false });
  });
});
