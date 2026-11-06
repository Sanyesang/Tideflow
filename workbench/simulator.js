const ASSET_DEFINITIONS = {
  "BTC-USDT": { base: 67_000, volatility: 1 },
  "ETH-USDT": { base: 3_500, volatility: 1.25 },
  "SOL-USDT": { base: 180, volatility: 1.7 },
};

const FREQUENCY_DEFINITIONS = {
  "1s": { stride: 1, lookback: 32, baseThresholdBps: 10 },
  "5s": { stride: 5, lookback: 12, baseThresholdBps: 14 },
  "15s": { stride: 15, lookback: 6, baseThresholdBps: 19 },
  "1m": { stride: 60, lookback: 3, baseThresholdBps: 28 },
};

const STRATEGIES = new Set(["momentum", "breakout", "mean-reversion"]);

function assertFinite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
}

export function getRiskParameters(riskScore, frequency = "5s") {
  assertFinite(riskScore, "riskScore");
  if (riskScore < 0 || riskScore > 100) throw new RangeError("riskScore must be between 0 and 100.");
  const frequencyDefinition = FREQUENCY_DEFINITIONS[frequency];
  if (!frequencyDefinition) throw new RangeError(`Unsupported frequency: ${frequency}`);
  return {
    riskScore,
    frequency,
    lookbackBars: frequencyDefinition.lookback,
    entryThresholdBps: Math.max(3, Math.round(frequencyDefinition.baseThresholdBps - riskScore * 0.06)),
    maxOrderNotionalUsd: 20 + riskScore * 0.4,
    dailyLossLimitUsd: 15 + riskScore * 0.25,
    stopLossBps: 12 + riskScore * 0.18,
    takeProfitBps: (12 + riskScore * 0.18) * 1.8,
  };
}

export function buildSyntheticPrices(asset = "BTC-USDT", frequency = "5s", seed = 0) {
  assertFinite(seed, "seed");
  const assetDefinition = ASSET_DEFINITIONS[asset];
  const frequencyDefinition = FREQUENCY_DEFINITIONS[frequency];
  if (!assetDefinition) throw new RangeError(`Unsupported asset: ${asset}`);
  if (!frequencyDefinition) throw new RangeError(`Unsupported frequency: ${frequency}`);

  const rawPointCount = 3_600;
  const points = [];
  let price = assetDefinition.base;
  for (let index = 0; index < rawPointCount; index += 1) {
    const phase = (index + seed * 137) % rawPointCount;
    const wave = Math.sin(phase / 47) * 0.00013
      + Math.sin(phase / 13) * 0.000075
      + Math.sin(phase / 3.7) * 0.000025;
    const regime = Math.floor(phase / 600) % 2 === 0 ? 0.000018 : -0.000018;
    const slowDrift = Math.sin(phase / 390) * 0.000012;
    price *= 1 + (wave + regime + slowDrift) * assetDefinition.volatility;
    if (index % frequencyDefinition.stride === 0) points.push({ index, price });
  }
  return points;
}

function signalFor(strategy, points, index, parameters) {
  const price = points[index].price;
  const start = Math.max(0, index - parameters.lookbackBars);
  const window = points.slice(start, index);
  if (window.length < parameters.lookbackBars) return null;

  if (strategy === "momentum") {
    const reference = window[0].price;
    const moveBps = ((price - reference) / reference) * 10_000;
    if (moveBps >= parameters.entryThresholdBps) return "long";
    if (moveBps <= -parameters.entryThresholdBps) return "short";
    return null;
  }

  if (strategy === "breakout") {
    const high = Math.max(...window.map((point) => point.price));
    const low = Math.min(...window.map((point) => point.price));
    if (price >= high * (1 + parameters.entryThresholdBps / 10_000)) return "long";
    if (price <= low * (1 - parameters.entryThresholdBps / 10_000)) return "short";
    return null;
  }

  const average = window.reduce((sum, point) => sum + point.price, 0) / window.length;
  const deviationBps = ((price - average) / average) * 10_000;
  if (deviationBps >= parameters.entryThresholdBps) return "short";
  if (deviationBps <= -parameters.entryThresholdBps) return "long";
  return null;
}

function summarize(trades, startingEquityUsd, equityCurve) {
  const wins = trades.filter((trade) => trade.netPnlUsd > 0);
  const losses = trades.filter((trade) => trade.netPnlUsd < 0);
  const netPnlUsd = trades.reduce((sum, trade) => sum + trade.netPnlUsd, 0);
  const grossWinsUsd = wins.reduce((sum, trade) => sum + trade.netPnlUsd, 0);
  const grossLossesUsd = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnlUsd, 0));
  const totalFeesUsd = trades.reduce((sum, trade) => sum + trade.feesUsd, 0);
  let peak = startingEquityUsd;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equityUsd);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equityUsd) / peak) * 100);
  }
  return {
    startingEquityUsd,
    endingEquityUsd: startingEquityUsd + netPnlUsd,
    netPnlUsd,
    netReturnPct: (netPnlUsd / startingEquityUsd) * 100,
    closedTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLossesUsd ? grossWinsUsd / grossLossesUsd : (grossWinsUsd > 0 ? Infinity : null),
    maxDrawdownPct,
    totalFeesUsd,
  };
}

export function getSyntheticMarketSnapshot(asset = "BTC-USDT", frequency = "5s", seed = 0) {
  const points = buildSyntheticPrices(asset, frequency, seed);
  const latest = points.at(-1);
  const recent = points.slice(-25);
  const previous = recent[0].price;
  return {
    asset,
    frequency,
    lastPrice: latest.price,
    changePct: ((latest.price - previous) / previous) * 100,
    high: Math.max(...recent.map((point) => point.price)),
    low: Math.min(...recent.map((point) => point.price)),
    sampleIndex: latest.index,
    label: "本地合成样本 · 非实时行情",
  };
}

export function runSyntheticSimulation({
  strategy = "momentum",
  asset = "BTC-USDT",
  frequency = "5s",
  riskScore = 42,
  seed = 0,
  startingEquityUsd = 1_000,
  takerFeeBps = 5,
  slippageBps = 1,
} = {}) {
  if (!STRATEGIES.has(strategy)) throw new RangeError(`Unsupported strategy: ${strategy}`);
  assertFinite(startingEquityUsd, "startingEquityUsd");
  assertFinite(takerFeeBps, "takerFeeBps");
  assertFinite(slippageBps, "slippageBps");
  assertFinite(seed, "seed");
  if (startingEquityUsd <= 0 || takerFeeBps < 0 || slippageBps < 0) throw new RangeError("Equity must be positive and costs cannot be negative.");

  const parameters = getRiskParameters(riskScore, frequency);
  const points = buildSyntheticPrices(asset, frequency, seed);
  const trades = [];
  const equityCurve = [{ index: 0, equityUsd: startingEquityUsd }];
  const frictionBps = takerFeeBps * 2 + slippageBps * 2;
  let equityUsd = startingEquityUsd;
  let position = null;
  let stoppedByRisk = false;

  const closePosition = (point, reason) => {
    const direction = position.side === "long" ? 1 : -1;
    const exitPrice = point.price * (1 - direction * slippageBps / 10_000);
    const grossPnlUsd = ((exitPrice - position.entryPrice) / position.entryPrice) * direction * position.notionalUsd;
    const exitFeeUsd = position.notionalUsd * takerFeeBps / 10_000;
    const feesUsd = position.entryFeeUsd + exitFeeUsd;
    const netPnlUsd = grossPnlUsd - feesUsd;
    const trade = {
      side: position.side,
      entryIndex: position.entryIndex,
      exitIndex: point.index,
      entryPrice: position.entryPrice,
      exitPrice,
      notionalUsd: position.notionalUsd,
      grossPnlUsd,
      feesUsd,
      netPnlUsd,
      exitReason: reason,
    };
    trades.push(trade);
    equityUsd += netPnlUsd;
    equityCurve.push({ index: point.index, equityUsd });
    position = null;
  };

  for (let index = parameters.lookbackBars; index < points.length; index += 1) {
    const point = points[index];
    const signal = signalFor(strategy, points, index, parameters);
    if (position) {
      const direction = position.side === "long" ? 1 : -1;
      const moveBps = ((point.price - position.referenceEntryPrice) / position.referenceEntryPrice) * direction * 10_000;
      const exitReason = moveBps <= -parameters.stopLossBps
        ? "止损"
        : moveBps >= parameters.takeProfitBps
          ? "止盈"
          : signal && signal !== position.side
            ? "反向信号"
            : null;
      if (exitReason) {
        closePosition(point, exitReason);
        if (startingEquityUsd - equityUsd >= parameters.dailyLossLimitUsd) {
          stoppedByRisk = true;
          break;
        }
        continue;
      }
      continue;
    }

    if (startingEquityUsd - equityUsd >= parameters.dailyLossLimitUsd) {
      stoppedByRisk = true;
      break;
    }
    if (!signal) continue;
    const notionalUsd = Math.min(parameters.maxOrderNotionalUsd, Math.max(1, equityUsd * 0.1));
    const direction = signal === "long" ? 1 : -1;
    const entryPrice = point.price * (1 + direction * slippageBps / 10_000);
    position = {
      side: signal,
      entryIndex: point.index,
      entryPrice,
      referenceEntryPrice: point.price,
      notionalUsd,
      entryFeeUsd: notionalUsd * takerFeeBps / 10_000,
    };
  }

  if (position && !stoppedByRisk) closePosition(points.at(-1), "样本结束");

  const metrics = summarize(trades, startingEquityUsd, equityCurve);
  return {
    strategy,
    asset,
    frequency,
    riskScore,
    parameters: { ...parameters, roundTripFrictionBps: frictionBps },
    metrics,
    trades,
    equityCurve,
    market: getSyntheticMarketSnapshot(asset, frequency, seed),
    candleCount: points.length,
    stoppedByRisk,
    dataSource: "deterministic_synthetic_fixture",
  };
}
