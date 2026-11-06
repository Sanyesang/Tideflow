import { describe, expect, it } from "vitest";
import { parseAiModel, predictNextCandle, runAiChronologicalHoldout } from "../src/ai/logistic_walk_forward.js";

function makeCandles(count: number) {
  const candles = [];
  let close = 100;
  let direction: 1 | -1 = 1;
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && index % 7 === 0) direction = direction === 1 ? -1 : 1;
    const open = close;
    close = open * (1 + direction * 0.001);
    candles.push({
      timestampMs: 1_000 + index * 60_000,
      open,
      high: Math.max(open, close) * 1.0001,
      low: Math.min(open, close) * 0.9999,
      close,
      volume: 10 + (index % 9),
    });
  }
  return candles;
}

const options = {
  initialBalanceUsd: 1_000,
  fixedNotionalUsd: 10,
  trainFraction: 0.7,
  longProbabilityThreshold: 0.55,
  shortProbabilityThreshold: 0.45,
  allowShort: true,
  takerFeeBps: 5,
  slippageBps: 2,
};

describe("walk-forward AI baseline", () => {
  it("fits preprocessing only on the training block and reports later holdout metrics", () => {
    const result = runAiChronologicalHoldout(makeCandles(1_000), options);
    expect(result.model.trainingSamples).toBeGreaterThan(100);
    expect(result.model.trainedThroughMs).toBeLessThanOrEqual(result.model.validationStartsAtMs);
    expect(result.validation.sampleCount).toBeGreaterThan(20);
    expect(result.validation.brierScore).toBeGreaterThanOrEqual(0);
    expect(result.validation.brierScore).toBeLessThanOrEqual(1);
    expect(result.paperSimulation.endingBalanceUsd).toBeCloseTo(1_000 + result.paperSimulation.netPnlUsd);
    expect(result.assumptions.join(" ")).toContain("not proof of robustness");
    expect(predictNextCandle(result.model, makeCandles(1_000)).probabilityUp).toBeGreaterThan(0);
    expect(() => predictNextCandle(result.model, makeCandles(20))).toThrow("later than the model's last training-label candle");
    expect(() => parseAiModel({ ...result.model, weights: [Number.NaN] })).toThrow("unsupported");
  });

  it("refuses undersized or one-class training data", () => {
    expect(() => runAiChronologicalHoldout(makeCandles(60), options)).toThrow("100 training and 20 validation");
    const flat = Array.from({ length: 1_000 }, (_, index) => ({
      timestampMs: 1_000 + index * 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1,
    }));
    expect(() => runAiChronologicalHoldout(flat, options)).toThrow("both positive and negative");
  });
});
