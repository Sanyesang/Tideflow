import { describe, expect, it } from "vitest";
import { parseCandleCsv } from "../src/backtest/csv_candles.js";
import { runMomentumBacktest, runStrategyBacktest, type BacktestOptions } from "../src/backtest/momentum_backtest.js";

const options: BacktestOptions = {
  initialBalanceUsd: 10_000,
  fixedNotionalUsd: 1_000,
  lookbackBars: 2,
  entryThresholdBps: 20,
  stopLossBps: 100,
  takeProfitBps: 100,
  takerFeeBps: 5,
  slippageBps: 2,
  allowShort: true,
};

function candlesFromCloses(closes: number[]) {
  return closes.map((close, index) => ({
    timestampMs: 1_000 + index * 60_000,
    open: close,
    high: close * 1.0002,
    low: close * 0.9998,
    close,
    volume: 1,
  }));
}

describe("OHLCV parser", () => {
  it("parses and preserves strict chronological order", () => {
    const result = parseCandleCsv("timestamp,open,high,low,close,volume\n1000,10,11,9,10.5,4\n2000,10.5,12,10,11,5");
    expect(result).toHaveLength(2);
    expect(result[1]?.close).toBe(11);
  });

  it("rejects unsorted timestamps and inconsistent OHLC", () => {
    expect(() => parseCandleCsv("timestamp,open,high,low,close,volume\n2000,10,11,9,10,2\n1000,10,11,9,10,2"))
      .toThrow("strictly chronological");
    expect(() => parseCandleCsv("timestamp,open,high,low,close,volume\n1000,10,9,8,10,2"))
      .toThrow("inconsistent");
  });
});

describe("momentum backtest", () => {
  it("uses next-bar open execution and deducts fees/slippage", () => {
    const input = candlesFromCloses([100, 100, 100, 101, 102, 103]);
    const result = runMomentumBacktest(input, options);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0]?.entryTimestampMs).toBe(input[4]?.timestampMs);
    expect(result.metrics.totalFeesUsd).toBeGreaterThan(0);
    expect(result.assumptions.join(" ")).toContain("next candle open");
  });

  it("returns no trades when the threshold cannot be met", () => {
    const result = runMomentumBacktest(candlesFromCloses([100, 100, 100, 100, 100]), {
      ...options,
      entryThresholdBps: 500,
    });
    expect(result.metrics.tradeCount).toBe(0);
    expect(result.metrics.netPnlUsd).toBe(0);
  });

  it("requires sufficient data and a fixed size within starting balance", () => {
    expect(() => runMomentumBacktest(candlesFromCloses([100, 101]), options)).toThrow("Not enough candles");
    expect(() => runMomentumBacktest(candlesFromCloses([100, 101, 102, 103]), { ...options, fixedNotionalUsd: 11_000 }))
      .toThrow("no greater than initialBalanceUsd");
  });
});

describe("historical strategy modes", () => {
  it("executes breakout and mean-reversion signals on the next bar open", () => {
    const breakoutCandles = candlesFromCloses([100, 100, 100, 101, 102, 103]);
    const breakout = runStrategyBacktest(breakoutCandles, {
      ...options,
      lookbackBars: 2,
      entryThresholdBps: 10,
      stopLossBps: 1_000,
      takeProfitBps: 1_000,
      takerFeeBps: 0,
      slippageBps: 0,
      allowShort: false,
    }, "breakout");
    expect(breakout.trades.length).toBeGreaterThan(0);
    expect(breakout.trades[0]?.entryTimestampMs).toBe(breakoutCandles[4]?.timestampMs);

    const reversionCandles = candlesFromCloses([100, 100, 100, 98, 96, 97]);
    const reversion = runStrategyBacktest(reversionCandles, {
      ...options,
      lookbackBars: 2,
      entryThresholdBps: 100,
      stopLossBps: 1_000,
      takeProfitBps: 1_000,
      takerFeeBps: 0,
      slippageBps: 0,
      allowShort: false,
    }, "mean-reversion");
    expect(reversion.trades.length).toBeGreaterThan(0);
    expect(reversion.trades[0]?.side).toBe("long");
  });

  it("rejects an unknown mode and documents the optional UTC daily-loss guard", () => {
    const input = candlesFromCloses([100, 100, 100, 101, 102, 103]);
    expect(() => runStrategyBacktest(input, options, "unknown" as never)).toThrow("Unsupported strategy");
    const result = runStrategyBacktest(input, { ...options, dailyLossLimitUsd: 25 }, "momentum");
    expect(result.assumptions.join(" ")).toContain("UTC day");
  });

  it("blocks additional same-day entries after realized loss reaches the configured limit", () => {
    const input = candlesFromCloses([100, 100, 102, 99, 100, 101, 102, 103]);
    input[3]!.low = 98;
    const result = runStrategyBacktest(input, {
      ...options,
      lookbackBars: 2,
      stopLossBps: 50,
      takeProfitBps: 500,
      dailyLossLimitUsd: 1,
    }, "momentum");

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.exitReason).toBe("stop_loss");
    expect(result.trades[0]?.netPnlUsd).toBeLessThan(-1);
  });
});
