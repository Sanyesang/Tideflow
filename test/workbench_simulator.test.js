import { describe, expect, it } from "vitest";
import {
  buildSyntheticPrices,
  getRiskParameters,
  getSyntheticMarketSnapshot,
  runSyntheticSimulation,
} from "../workbench/simulator.js";

describe("offline workbench simulator", () => {
  it("creates a stable local fixture for the same asset, cadence, and seed", () => {
    expect(buildSyntheticPrices("BTC-USDT", "5s", 2)).toEqual(buildSyntheticPrices("BTC-USDT", "5s", 2));
    expect(buildSyntheticPrices("BTC-USDT", "5s", 2)).not.toEqual(buildSyntheticPrices("BTC-USDT", "5s", 3));
  });

  it("changes sample size and risk parameters with the selected cadence and risk score", () => {
    expect(buildSyntheticPrices("BTC-USDT", "1s")).toHaveLength(3_600);
    expect(buildSyntheticPrices("BTC-USDT", "1m")).toHaveLength(60);
    expect(getRiskParameters(0, "5s").entryThresholdBps).toBeGreaterThan(getRiskParameters(100, "5s").entryThresholdBps);
    expect(getRiskParameters(100, "5s").maxOrderNotionalUsd).toBeGreaterThan(getRiskParameters(0, "5s").maxOrderNotionalUsd);
    const conservative = runSyntheticSimulation({ strategy: "momentum", frequency: "5s", riskScore: 0, seed: 7 });
    const aggressive = runSyntheticSimulation({ strategy: "momentum", frequency: "5s", riskScore: 100, seed: 7 });
    expect(conservative.metrics.closedTrades).not.toBe(aggressive.metrics.closedTrades);
    expect(conservative.metrics.netPnlUsd).not.toBe(aggressive.metrics.netPnlUsd);
  });

  it("returns market snapshots derived from the selected asset's synthetic series", () => {
    const btc = getSyntheticMarketSnapshot("BTC-USDT", "5s");
    const sol = getSyntheticMarketSnapshot("SOL-USDT", "5s");
    expect(btc.label).toContain("非实时行情");
    expect(btc.lastPrice).toBeGreaterThan(10_000);
    expect(sol.lastPrice).toBeLessThan(1_000);
    expect(btc.asset).not.toBe(sol.asset);
  });

  it("runs all implemented strategies using costs and emits internally consistent statistics", () => {
    const tradeCounts = new Set();
    for (const strategy of ["momentum", "breakout", "mean-reversion"]) {
      const result = runSyntheticSimulation({ strategy, asset: "ETH-USDT", frequency: "5s", seed: 4 });
      expect(result.dataSource).toBe("deterministic_synthetic_fixture");
      expect(result.strategy).toBe(strategy);
      expect(result.metrics.closedTrades).toBe(result.trades.length);
      expect(result.metrics.endingEquityUsd).toBeCloseTo(1_000 + result.metrics.netPnlUsd, 8);
      expect(result.metrics.totalFeesUsd).toBeGreaterThanOrEqual(0);
      tradeCounts.add(result.metrics.closedTrades);
    }
    expect(tradeCounts.size).toBeGreaterThan(1);
  });

  it("reduces net results when simulated fees and slippage increase", () => {
    const lowCost = runSyntheticSimulation({ strategy: "momentum", seed: 2, takerFeeBps: 0, slippageBps: 0 });
    const highCost = runSyntheticSimulation({ strategy: "momentum", seed: 2, takerFeeBps: 10, slippageBps: 5 });
    expect(highCost.metrics.netPnlUsd).toBeLessThan(lowCost.metrics.netPnlUsd);
  });

  it("rejects unsupported controls instead of silently substituting values", () => {
    expect(() => runSyntheticSimulation({ strategy: "unknown" })).toThrow("Unsupported strategy");
    expect(() => runSyntheticSimulation({ frequency: "5m" })).toThrow("Unsupported frequency");
    expect(() => runSyntheticSimulation({ asset: "DOGE-USDT" })).toThrow("Unsupported asset");
  });
});
