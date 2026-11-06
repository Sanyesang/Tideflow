import type { Candle } from "../backtest/csv_candles.js";

export const AI_FEATURE_NAMES = [
  "logReturn1",
  "meanLogReturn3",
  "meanLogReturn5",
  "meanLogReturn10",
  "rangeFraction",
  "volumeSurprise",
] as const;

export type AiModel = {
  formatVersion: 1;
  algorithm: "standardized-logistic-regression";
  featureNames: string[];
  means: number[];
  scales: number[];
  weights: number[];
  bias: number;
  trainingSamples: number;
  trainedThroughMs: number;
  validationStartsAtMs: number;
};

export type AiWalkForwardOptions = {
  initialBalanceUsd: number;
  fixedNotionalUsd: number;
  trainFraction: number;
  longProbabilityThreshold: number;
  shortProbabilityThreshold: number;
  allowShort: boolean;
  takerFeeBps: number;
  slippageBps: number;
};

export type AiWalkForwardResult = {
  model: AiModel;
  validation: {
    sampleCount: number;
    positiveRatePct: number;
    accuracyPct: number;
    balancedAccuracyPct: number;
    brierScore: number;
    logLoss: number;
    confusion: { truePositive: number; trueNegative: number; falsePositive: number; falseNegative: number };
  };
  paperSimulation: {
    trades: number;
    wins: number;
    winRatePct: number;
    initialBalanceUsd: number;
    endingBalanceUsd: number;
    netPnlUsd: number;
    netReturnPct: number;
    feesUsd: number;
    maxDrawdownPct: number;
  };
  assumptions: string[];
};

type Sample = { timestampMs: number; executionIndex: number; features: number[]; label: 0 | 1 };

function sigmoid(value: number): number {
  if (value >= 0) {
    const inverse = Math.exp(-value);
    return 1 / (1 + inverse);
  }
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function validateOptions(options: AiWalkForwardOptions): void {
  const numericValues = Object.entries(options).filter(([, value]) => typeof value === "number");
  for (const [name, value] of numericValues) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`);
  }
  if (options.initialBalanceUsd <= 0 || options.fixedNotionalUsd <= 0 || options.fixedNotionalUsd > options.initialBalanceUsd) {
    throw new Error("fixedNotionalUsd must be positive and no greater than initialBalanceUsd.");
  }
  if (options.trainFraction < 0.5 || options.trainFraction > 0.9) throw new Error("trainFraction must be between 0.5 and 0.9.");
  if (options.longProbabilityThreshold <= 0.5 || options.longProbabilityThreshold >= 1
    || options.shortProbabilityThreshold <= 0 || options.shortProbabilityThreshold >= 0.5
    || options.shortProbabilityThreshold >= options.longProbabilityThreshold) {
    throw new Error("Probability thresholds must satisfy 0 < short < 0.5 < long < 1.");
  }
  if (options.takerFeeBps < 0 || options.slippageBps < 0 || options.slippageBps >= 10_000) {
    throw new Error("Fees cannot be negative and slippage must be between 0 and 10,000 bps.");
  }
}

function featureAt(candles: Candle[], index: number): number[] {
  const current = candles[index]!;
  const priorClose = (bars: number): number => candles[index - bars]!.close;
  const meanVolumeLog = [1, 2, 3, 4, 5].reduce((sum, offset) => sum + Math.log1p(candles[index - offset]!.volume), 0) / 5;
  return [
    Math.log(current.close / priorClose(1)),
    Math.log(current.close / priorClose(3)) / 3,
    Math.log(current.close / priorClose(5)) / 5,
    Math.log(current.close / priorClose(10)) / 10,
    (current.high - current.low) / current.close,
    Math.log1p(current.volume) - meanVolumeLog,
  ];
}

function makeSamples(candles: Candle[]): Sample[] {
  if (candles.length < 12) throw new Error("At least 12 chronological candles are required for AI features.");
  const samples: Sample[] = [];
  for (let index = 10; index < candles.length - 1; index += 1) {
    const next = candles[index + 1]!;
    samples.push({
      timestampMs: candles[index]!.timestampMs,
      executionIndex: index + 1,
      features: featureAt(candles, index),
      label: next.close > next.open ? 1 : 0,
    });
  }
  return samples;
}

function standardize(samples: Sample[]): { means: number[]; scales: number[]; values: number[][] } {
  const dimensions = AI_FEATURE_NAMES.length;
  const means = Array.from({ length: dimensions }, (_, feature) =>
    samples.reduce((sum, row) => sum + row.features[feature]!, 0) / samples.length,
  );
  const scales = Array.from({ length: dimensions }, (_, feature) => {
    const variance = samples.reduce((sum, row) => sum + (row.features[feature]! - means[feature]!) ** 2, 0) / samples.length;
    const standardDeviation = Math.sqrt(variance);
    return standardDeviation > 1e-12 ? standardDeviation : 1;
  });
  return {
    means,
    scales,
    values: samples.map((row) => row.features.map((value, index) => (value - means[index]!) / scales[index]!)),
  };
}

function fitLogistic(values: number[][], labels: Array<0 | 1>): { weights: number[]; bias: number } {
  const weights = Array.from({ length: AI_FEATURE_NAMES.length }, () => 0);
  let bias = 0;
  const learningRate = 0.08;
  const l2 = 0.01;
  const epochs = 1_000;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradients = Array.from({ length: weights.length }, () => 0);
    let biasGradient = 0;
    for (let row = 0; row < values.length; row += 1) {
      const features = values[row]!;
      const linear = features.reduce((sum, value, index) => sum + value * weights[index]!, bias);
      const error = sigmoid(linear) - labels[row]!;
      for (let feature = 0; feature < weights.length; feature += 1) gradients[feature]! += error * features[feature]!;
      biasGradient += error;
    }
    for (let feature = 0; feature < weights.length; feature += 1) {
      weights[feature]! -= learningRate * (gradients[feature]! / values.length + l2 * weights[feature]!);
    }
    bias -= learningRate * biasGradient / values.length;
  }
  return { weights, bias };
}

function predict(model: Pick<AiModel, "means" | "scales" | "weights" | "bias">, features: number[]): number {
  const linear = features.reduce((sum, value, index) =>
    sum + ((value - model.means[index]!) / model.scales[index]!) * model.weights[index]!, model.bias);
  return sigmoid(linear);
}

/** Validates an untrusted JSON model artifact before it is loaded for inference. */
export function parseAiModel(value: unknown): AiModel {
  if (typeof value !== "object" || value === null) throw new Error("AI model must be a JSON object.");
  const candidate = value as Partial<AiModel>;
  if (candidate.formatVersion !== 1 || candidate.algorithm !== "standardized-logistic-regression"
    || !Array.isArray(candidate.featureNames) || candidate.featureNames.length !== AI_FEATURE_NAMES.length
    || !candidate.featureNames.every((name, index) => name === AI_FEATURE_NAMES[index])
    || !Array.isArray(candidate.means) || !Array.isArray(candidate.scales) || !Array.isArray(candidate.weights)
    || candidate.means.length !== AI_FEATURE_NAMES.length || candidate.scales.length !== AI_FEATURE_NAMES.length
    || candidate.weights.length !== AI_FEATURE_NAMES.length) {
    throw new Error("AI model format or feature schema is unsupported.");
  }
  const vectors = [candidate.means, candidate.scales, candidate.weights];
  if (vectors.some((vector) => !vector.every((value) => typeof value === "number" && Number.isFinite(value)))) {
    throw new Error("AI model contains non-finite coefficients.");
  }
  if (candidate.scales.some((scale) => scale <= 0)
    || typeof candidate.bias !== "number" || !Number.isFinite(candidate.bias)
    || typeof candidate.trainingSamples !== "number" || !Number.isInteger(candidate.trainingSamples) || candidate.trainingSamples < 1
    || typeof candidate.trainedThroughMs !== "number" || !Number.isSafeInteger(candidate.trainedThroughMs)
    || typeof candidate.validationStartsAtMs !== "number" || !Number.isSafeInteger(candidate.validationStartsAtMs)
    || candidate.trainedThroughMs > candidate.validationStartsAtMs) {
    throw new Error("AI model metadata or scales are invalid.");
  }
  return {
    formatVersion: 1,
    algorithm: "standardized-logistic-regression",
    featureNames: [...candidate.featureNames],
    means: [...candidate.means],
    scales: [...candidate.scales],
    weights: [...candidate.weights],
    bias: candidate.bias,
    trainingSamples: candidate.trainingSamples,
    trainedThroughMs: candidate.trainedThroughMs,
    validationStartsAtMs: candidate.validationStartsAtMs,
  };
}

/** Computes a one-candle directional probability from the latest 11 completed candles. */
export function predictNextCandle(modelInput: unknown, candles: Candle[]): { asOfMs: number; probabilityUp: number; direction: "up_bias" | "down_bias" } {
  const model = parseAiModel(modelInput);
  if (candles.length < 11) throw new Error("At least 11 completed chronological candles are required for inference.");
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index]!.timestampMs <= candles[index - 1]!.timestampMs) throw new Error("Inference candles must be strictly chronological.");
  }
  const latest = candles.at(-1)!;
  if (latest.timestampMs <= model.trainedThroughMs) {
    throw new Error("Inference candle must be later than the model's last training-label candle.");
  }
  const probabilityUp = predict(model, featureAt(candles, candles.length - 1));
  return { asOfMs: latest.timestampMs, probabilityUp, direction: probabilityUp >= 0.5 ? "up_bias" : "down_bias" };
}

/**
 * Trains only on the earliest contiguous block, then reports metrics and a
 * one-bar, fixed-notional simulation on the untouched later block.
 */
export function runAiChronologicalHoldout(candles: Candle[], options: AiWalkForwardOptions): AiWalkForwardResult {
  validateOptions(options);
  const samples = makeSamples(candles);
  const splitIndex = Math.floor(samples.length * options.trainFraction);
  const training = samples.slice(0, splitIndex);
  const validation = samples.slice(splitIndex);
  if (training.length < 100 || validation.length < 20) {
    throw new Error("Walk-forward AI evaluation requires at least 100 training and 20 validation samples.");
  }
  const positiveTraining = training.filter((row) => row.label === 1).length;
  if (positiveTraining === 0 || positiveTraining === training.length) {
    throw new Error("Training block must contain both positive and negative next-candle outcomes.");
  }

  const normalized = standardize(training);
  const fitted = fitLogistic(normalized.values, training.map((row) => row.label));
  const model: AiModel = {
    formatVersion: 1,
    algorithm: "standardized-logistic-regression",
    featureNames: [...AI_FEATURE_NAMES],
    means: normalized.means,
    scales: normalized.scales,
    weights: fitted.weights,
    bias: fitted.bias,
    trainingSamples: training.length,
    // Training labels consume the next candle's close, so this records the
    // model's actual information boundary, not only the feature timestamp.
    trainedThroughMs: candles[training.at(-1)!.executionIndex]!.timestampMs,
    validationStartsAtMs: validation[0]!.timestampMs,
  };

  const predictions = validation.map((row) => ({ ...row, probability: predict(model, row.features) }));
  const positive = predictions.filter((row) => row.label === 1).length;
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let brierTotal = 0;
  let logLossTotal = 0;
  for (const row of predictions) {
    const predictedPositive = row.probability >= 0.5;
    if (predictedPositive && row.label === 1) truePositive += 1;
    else if (predictedPositive) falsePositive += 1;
    else if (row.label === 0) trueNegative += 1;
    else falseNegative += 1;
    brierTotal += (row.probability - row.label) ** 2;
    const clipped = Math.min(1 - 1e-15, Math.max(1e-15, row.probability));
    logLossTotal += -(row.label * Math.log(clipped) + (1 - row.label) * Math.log(1 - clipped));
  }
  const truePositiveRate = positive === 0 ? 0 : truePositive / positive;
  const negatives = predictions.length - positive;
  const trueNegativeRate = negatives === 0 ? 0 : trueNegative / negatives;
  const accuracy = (truePositive + trueNegative) / predictions.length;

  let balance = options.initialBalanceUsd;
  let peak = balance;
  let maxDrawdownPct = 0;
  let feesUsd = 0;
  let wins = 0;
  let trades = 0;
  const feeRate = options.takerFeeBps / 10_000;
  const slippageRate = options.slippageBps / 10_000;
  for (const prediction of predictions) {
    const side = prediction.probability >= options.longProbabilityThreshold
      ? 1
      : options.allowShort && prediction.probability <= options.shortProbabilityThreshold ? -1 : 0;
    if (side !== 0) {
      const candle = candles[prediction.executionIndex]!;
      const entry = side === 1 ? candle.open * (1 + slippageRate) : candle.open * (1 - slippageRate);
      const exit = side === 1 ? candle.close * (1 - slippageRate) : candle.close * (1 + slippageRate);
      const quantity = options.fixedNotionalUsd / entry;
      const grossPnl = (exit - entry) * quantity * side;
      const tradeFees = (entry + exit) * quantity * feeRate;
      const netPnl = grossPnl - tradeFees;
      balance += netPnl;
      feesUsd += tradeFees;
      trades += 1;
      if (netPnl > 0) wins += 1;
      peak = Math.max(peak, balance);
      if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - balance) / peak) * 100);
    }
  }

  return {
    model,
    validation: {
      sampleCount: predictions.length,
      positiveRatePct: (positive / predictions.length) * 100,
      accuracyPct: accuracy * 100,
      balancedAccuracyPct: ((truePositiveRate + trueNegativeRate) / 2) * 100,
      brierScore: brierTotal / predictions.length,
      logLoss: logLossTotal / predictions.length,
      confusion: { truePositive, trueNegative, falsePositive, falseNegative },
    },
    paperSimulation: {
      trades,
      wins,
      winRatePct: trades === 0 ? 0 : (wins / trades) * 100,
      initialBalanceUsd: options.initialBalanceUsd,
      endingBalanceUsd: balance,
      netPnlUsd: balance - options.initialBalanceUsd,
      netReturnPct: ((balance - options.initialBalanceUsd) / options.initialBalanceUsd) * 100,
      feesUsd,
      maxDrawdownPct,
    },
    assumptions: [
      "Features use only completed candles through the prediction timestamp; validation rows are later in time than training rows.",
      "The binary label is whether the next candle closes above its open; it is not a forecast of net tradable profit.",
      "The paper simulation enters at the next candle open and exits at that candle close with fixed slippage and taker fees.",
      "No funding, queue position, market impact, partial fills, exchange outages or liquidation are modeled.",
      "A single chronological holdout is not proof of robustness; repeat across instruments, periods and walk-forward windows before any deployment.",
    ],
  };
}
