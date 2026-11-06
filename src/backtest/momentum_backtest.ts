import type { Candle } from "./csv_candles.js";

export type StrategyMode = "momentum" | "breakout" | "mean-reversion";

export type BacktestOptions = {
  initialBalanceUsd: number;
  fixedNotionalUsd: number;
  lookbackBars: number;
  entryThresholdBps: number;
  stopLossBps: number;
  takeProfitBps: number;
  takerFeeBps: number;
  slippageBps: number;
  allowShort: boolean;
  dailyLossLimitUsd?: number;
};

export type BacktestTrade = {
  side: "long" | "short";
  entryTimestampMs: number;
  exitTimestampMs: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  exitReason: "signal" | "stop_loss" | "take_profit" | "end_of_data";
};

export type BacktestResult = {
  trades: BacktestTrade[];
  metrics: {
    initialBalanceUsd: number;
    endingBalanceUsd: number;
    netPnlUsd: number;
    netReturnPct: number;
    totalFeesUsd: number;
    tradeCount: number;
    winRatePct: number;
    profitFactor: number | null;
    maxDrawdownPct: number;
  };
  assumptions: string[];
};

type Position = {
  side: 1 | -1;
  entryTimestampMs: number;
  entryPrice: number;
  quantity: number;
  entryFeeUsd: number;
  stopPrice: number;
  takeProfitPrice: number;
};

function validateOptions(options: BacktestOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${name} must be finite.`);
  }
  if (options.initialBalanceUsd <= 0 || options.fixedNotionalUsd <= 0 || options.fixedNotionalUsd > options.initialBalanceUsd) {
    throw new Error("fixedNotionalUsd must be positive and no greater than initialBalanceUsd.");
  }
  if (!Number.isInteger(options.lookbackBars) || options.lookbackBars < 1) throw new Error("lookbackBars must be a positive integer.");
  if (options.entryThresholdBps <= 0 || options.stopLossBps <= 0 || options.takeProfitBps <= 0) {
    throw new Error("Signal threshold, stop loss, and take profit must be greater than zero.");
  }
  if (options.takerFeeBps < 0 || options.slippageBps < 0 || options.slippageBps >= 10_000) {
    throw new Error("Fees cannot be negative and slippage must be between 0 and 10,000 bps.");
  }
  if (options.dailyLossLimitUsd !== undefined && options.dailyLossLimitUsd <= 0) {
    throw new Error("dailyLossLimitUsd must be positive when configured.");
  }
}

/**
 * Next-bar-open historical strategy backtest. Signals use only completed
 * candles. If stop and target both fall inside one candle, stop-loss is assumed
 * to happen first. Funding, partial fills, queue priority and exchange outages
 * are not simulated.
 */
export function runStrategyBacktest(candles: Candle[], options: BacktestOptions, strategy: StrategyMode = "momentum"): BacktestResult {
  validateOptions(options);
  if (!["momentum", "breakout", "mean-reversion"].includes(strategy)) throw new Error(`Unsupported strategy: ${strategy}`);
  if (candles.length < options.lookbackBars + 2) throw new Error("Not enough candles for the selected lookback.");

  let balance = options.initialBalanceUsd;
  let totalFeesUsd = 0;
  let position: Position | undefined;
  const trades: BacktestTrade[] = [];
  let peakEquity = balance;
  let maxDrawdownPct = 0;
  let activeUtcDay = Number.NaN;
  let realizedPnlTodayUsd = 0;
  const feeRate = options.takerFeeBps / 10_000;
  const slippageRate = options.slippageBps / 10_000;

  const signalForCompletedBar = (index: number): 1 | -1 | 0 => {
    const current = candles[index]!;
    if (strategy === "momentum") {
      const start = candles[index - options.lookbackBars]!;
      const moveBps = ((current.close - start.close) / start.close) * 10_000;
      if (moveBps >= options.entryThresholdBps) return 1;
      if (options.allowShort && moveBps <= -options.entryThresholdBps) return -1;
      return 0;
    }
    if (strategy === "breakout") {
      let high = Number.NEGATIVE_INFINITY;
      let low = Number.POSITIVE_INFINITY;
      for (let offset = index - options.lookbackBars; offset < index; offset += 1) {
        high = Math.max(high, candles[offset]!.high);
        low = Math.min(low, candles[offset]!.low);
      }
      if (current.close >= high * (1 + options.entryThresholdBps / 10_000)) return 1;
      if (options.allowShort && current.close <= low * (1 - options.entryThresholdBps / 10_000)) return -1;
      return 0;
    }
    let average = 0;
    for (let offset = index - options.lookbackBars; offset < index; offset += 1) average += candles[offset]!.close;
    average /= options.lookbackBars;
    const deviationBps = ((current.close - average) / average) * 10_000;
    if (deviationBps <= -options.entryThresholdBps) return 1;
    if (options.allowShort && deviationBps >= options.entryThresholdBps) return -1;
    return 0;
  };

  const closePosition = (rawPrice: number, candle: Candle, reason: BacktestTrade["exitReason"]): void => {
    if (!position) return;
    const exitPrice = position.side === 1 ? rawPrice * (1 - slippageRate) : rawPrice * (1 + slippageRate);
    const grossPnlUsd = (exitPrice - position.entryPrice) * position.quantity * position.side;
    const exitFeeUsd = position.quantity * exitPrice * feeRate;
    const feesUsd = position.entryFeeUsd + exitFeeUsd;
    const netPnlUsd = grossPnlUsd - feesUsd;
    balance += grossPnlUsd - exitFeeUsd;
    totalFeesUsd += exitFeeUsd;
    trades.push({
      side: position.side === 1 ? "long" : "short",
      entryTimestampMs: position.entryTimestampMs,
      exitTimestampMs: candle.timestampMs,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      grossPnlUsd,
      feesUsd,
      netPnlUsd,
      exitReason: reason,
    });
    realizedPnlTodayUsd += netPnlUsd;
    position = undefined;
  };

  const openPosition = (side: 1 | -1, rawPrice: number, candle: Candle): void => {
    const entryPrice = side === 1 ? rawPrice * (1 + slippageRate) : rawPrice * (1 - slippageRate);
    const quantity = options.fixedNotionalUsd / entryPrice;
    const entryFeeUsd = options.fixedNotionalUsd * feeRate;
    balance -= entryFeeUsd;
    totalFeesUsd += entryFeeUsd;
    position = {
      side,
      entryTimestampMs: candle.timestampMs,
      entryPrice,
      quantity,
      entryFeeUsd,
      stopPrice: entryPrice * (1 - side * options.stopLossBps / 10_000),
      takeProfitPrice: entryPrice * (1 + side * options.takeProfitBps / 10_000),
    };
  };

  for (let i = options.lookbackBars + 1; i < candles.length; i += 1) {
    const candle = candles[i]!;
    const utcDay = Math.floor(candle.timestampMs / 86_400_000);
    if (utcDay !== activeUtcDay) {
      activeUtcDay = utcDay;
      realizedPnlTodayUsd = 0;
    }
    const signal = signalForCompletedBar(i - 1);
    let closedByBarrier = false;

    if (position) {
      const stopHit = position.side === 1 ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
      const targetHit = position.side === 1 ? candle.high >= position.takeProfitPrice : candle.low <= position.takeProfitPrice;
      if (stopHit) {
        closePosition(position.stopPrice, candle, "stop_loss");
        closedByBarrier = true;
      } else if (targetHit) {
        closePosition(position.takeProfitPrice, candle, "take_profit");
        closedByBarrier = true;
      } else if (signal !== position.side) {
        closePosition(candle.open, candle, "signal");
      }
    }

    const dailyLossLimitReached = options.dailyLossLimitUsd !== undefined
      && realizedPnlTodayUsd <= -options.dailyLossLimitUsd;
    if (!position && !closedByBarrier && signal !== 0 && !dailyLossLimitReached) openPosition(signal, candle.open, candle);

    // A position opened or reversed at this bar's open is exposed to the
    // remainder of the same candle; resolve ambiguous stop/target bars against
    // the position conservatively.
    if (position && !closedByBarrier) {
      const stopHit = position.side === 1 ? candle.low <= position.stopPrice : candle.high >= position.stopPrice;
      const targetHit = position.side === 1 ? candle.high >= position.takeProfitPrice : candle.low <= position.takeProfitPrice;
      if (stopHit) closePosition(position.stopPrice, candle, "stop_loss");
      else if (targetHit) closePosition(position.takeProfitPrice, candle, "take_profit");
    }

    const markedEquity = position
      ? balance + (candle.close - position.entryPrice) * position.quantity * position.side
      : balance;
    peakEquity = Math.max(peakEquity, markedEquity);
    if (peakEquity > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peakEquity - markedEquity) / peakEquity) * 100);
  }

  const finalCandle = candles.at(-1)!;
  if (position) closePosition(finalCandle.close, finalCandle, "end_of_data");
  const grossWins = trades.filter((trade) => trade.netPnlUsd > 0).reduce((sum, trade) => sum + trade.netPnlUsd, 0);
  const grossLosses = Math.abs(trades.filter((trade) => trade.netPnlUsd < 0).reduce((sum, trade) => sum + trade.netPnlUsd, 0));
  const wins = trades.filter((trade) => trade.netPnlUsd > 0).length;

  return {
    trades,
    metrics: {
      initialBalanceUsd: options.initialBalanceUsd,
      endingBalanceUsd: balance,
      netPnlUsd: balance - options.initialBalanceUsd,
      netReturnPct: ((balance - options.initialBalanceUsd) / options.initialBalanceUsd) * 100,
      totalFeesUsd,
      tradeCount: trades.length,
      winRatePct: trades.length === 0 ? 0 : (wins / trades.length) * 100,
      profitFactor: grossLosses === 0 ? null : grossWins / grossLosses,
      maxDrawdownPct,
    },
    assumptions: [
      "Signals use completed candles and execute no earlier than the next candle open.",
      "Taker fees and fixed slippage are charged on entries and exits.",
      "If a candle crosses both stop and target, stop-loss is assumed to fill first.",
      "Funding, partial fills, queue priority, market impact, outages and liquidation are not modeled.",
      ...(options.dailyLossLimitUsd === undefined ? [] : [`New entries stop for the UTC day after realized losses reach $${options.dailyLossLimitUsd.toFixed(2)}.`]),
    ],
  };
}

/** Backward-compatible momentum-only entry point used by the CLI. */
export function runMomentumBacktest(candles: Candle[], options: BacktestOptions): BacktestResult {
  return runStrategyBacktest(candles, options, "momentum");
}
