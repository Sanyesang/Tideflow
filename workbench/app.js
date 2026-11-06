import {
  buildSyntheticPrices,
  getRiskParameters,
  getSyntheticMarketSnapshot,
  runSyntheticSimulation,
} from "./simulator.js";
import { parseCandleCsv } from "/modules/csv_candles.js";
import { runStrategyBacktest } from "/modules/momentum_backtest.js";

const strategies = {
  momentum: { name: "脉冲动量", description: "按短窗方向变化进场，反向信号、止盈或止损时退出。", mark: "01" },
  breakout: { name: "区间突破", description: "价格越过观察窗口高低边界并达到门槛时进场。", mark: "02" },
  "mean-reversion": { name: "均值回归", description: "价格偏离短窗均值后反向进场，等待回归或触发退出。", mark: "03" },
};
const assets = {
  "BTC-USDT": { name: "Bitcoin", icon: "₿", className: "btc" },
  "ETH-USDT": { name: "Ethereum", icon: "◆", className: "eth" },
  "SOL-USDT": { name: "Solana", icon: "◎", className: "sol" },
};

const riskSlider = document.querySelector("#risk-slider");
const WORKBENCH_STORAGE_KEY = "tideflow.workbench.v1";
const validFrequencies = new Set(["1s", "5s", "15s", "1m"]);
let trades = [];
let equityHistory = [1_000];
let sessionEquity = 1_000;
let busy = false;
let sessionCount = 0;
let runGeneration = 0;
let storageWarning = "";
let historyCandles = [];
let historyFileName = "";
let lastHistoryConfiguration = null;
let toastTimer;
let previousFocus = null;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function strategyKeyFor(value) {
  if (Object.hasOwn(strategies, value)) return value;
  return Object.entries(strategies).find(([, strategy]) => strategy.name === value)?.[0] ?? null;
}

function restoreWorkbenchState() {
  let raw;
  try {
    raw = localStorage.getItem(WORKBENCH_STORAGE_KEY);
  } catch {
    storageWarning = "浏览器未开放本地存储；本次模拟记录可能在刷新后丢失。";
    return;
  }
  if (!raw) return;

  try {
    const saved = JSON.parse(raw);
    const tradeIssue = (trade) => {
      if (!trade || typeof trade !== "object") return "对象";
      if (!Object.hasOwn(assets, trade.asset)) return "asset";
      if (!strategyKeyFor(trade.strategy)) return "strategy";
      if (!["long", "short"].includes(trade.direction)) return "direction";
      if (typeof trade.entry !== "string") return "entry";
      if (typeof trade.exit !== "string") return "exit";
      if (!Number.isFinite(trade.pnl)) return "pnl";
      if (typeof trade.time !== "string") return "time";
      if (typeof trade.exitReason !== "string") return "exitReason";
      return "";
    };
    let invalidStateReason = "";
    if (saved?.version !== 1) invalidStateReason = "版本号";
    else if (!Array.isArray(saved.trades)) invalidStateReason = "记录列表";
    else if (saved.trades.length > 20_000) invalidStateReason = "记录数量";
    else {
      const invalidTradeIndex = saved.trades.findIndex((trade) => tradeIssue(trade));
      if (invalidTradeIndex >= 0) {
        invalidStateReason = "第 " + (invalidTradeIndex + 1) + " 条记录的 " + tradeIssue(saved.trades[invalidTradeIndex]) + " 字段";
      }
      else if (!saved.settings || typeof saved.settings !== "object") {
        invalidStateReason = "配置结构";
      }
    }
    if (invalidStateReason) {
      storageWarning = `本地演示账本的${invalidStateReason}无法识别；原数据未删除，当前以空白工作台启动。`;
      return;
    }

    trades = saved.trades.map((trade) => ({ ...trade, strategy: strategyKeyFor(trade.strategy) }));
    sessionCount = Number.isSafeInteger(saved.completedRuns) && saved.completedRuns >= 0
      ? saved.completedRuns
      : 0;
    if (Object.hasOwn(strategies, saved.settings.strategy)) {
      $("#strategy-select").value = saved.settings.strategy;
    }
    if (Object.hasOwn(assets, saved.settings.asset)) {
      $("#asset-select").value = saved.settings.asset;
    }
    if (validFrequencies.has(saved.settings.frequency)) {
      $("#frequency-select").value = saved.settings.frequency;
    }
    if (Number.isInteger(saved.settings.riskScore) && saved.settings.riskScore >= 0 && saved.settings.riskScore <= 100) {
      riskSlider.value = String(saved.settings.riskScore);
    }

    equityHistory = [1_000];
    sessionEquity = 1_000;
    for (const trade of [...trades].reverse()) {
      sessionEquity += trade.pnl;
      equityHistory.push(sessionEquity);
    }
    if (saved.trades.some((trade, index) => trade.strategy !== trades[index].strategy)) {
      persistWorkbenchState();
    }
  } catch {
    storageWarning = "本地演示账本读取失败；原数据未删除，当前以空白工作台启动。";
  }
}

function persistWorkbenchState() {
  const saved = {
    version: 1,
    completedRuns: sessionCount,
    settings: {
      strategy: $("#strategy-select").value,
      asset: $("#asset-select").value,
      frequency: $("#frequency-select").value,
      riskScore: Number(riskSlider.value),
    },
    trades,
  };
  try {
    localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(saved));
    storageWarning = "";
    return true;
  } catch {
    showToast("本机保存失败；刷新页面可能丢失这次模拟记录。");
    return false;
  }
}

function fmtMoney(value, sign = true) {
  const amount = Math.abs(value).toFixed(2);
  if (value < 0) return `−$${amount}`;
  return `${sign ? "+" : ""}$${amount}`;
}

function fmtPrice(value) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value >= 1_000 ? 2 : 4 });
}

function renderTrades(target = $("#trade-rows")) {
  if (!target) return;
  if (!trades.length) {
    target.innerHTML = '<tr><td colspan="5" class="empty-trades">还没有本地回放记录。选择参数后运行一轮。</td></tr>';
    return;
  }
  const rows = trades.slice(0, 5).map((trade) => {
    const symbol = trade.asset.split("-")[0];
    const icon = assets[trade.asset]?.icon ?? "·";
    const pnlClass = trade.pnl >= 0 ? "positive" : "negative";
    const strategyName = strategies[trade.strategy]?.name ?? trade.strategy;
    return `<tr><td><div class="trade-asset"><span class="trade-coin">${icon}</span><span><strong>${trade.asset}</strong><small>${strategyName} · ${trade.time}</small></span></div></td><td><span class="direction ${trade.direction}">${trade.direction === "long" ? "LONG" : "SHORT"}</span></td><td>${trade.entry} → ${trade.exit}</td><td class="${pnlClass}">${fmtMoney(trade.pnl)}</td><td><span class="trade-state">纸面回放</span></td></tr>`;
  });
  target.innerHTML = rows.join("");
}

function updateMetrics() {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const net = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossWins = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const profitFactor = grossLosses ? (grossWins / grossLosses).toFixed(2) : grossWins > 0 ? "∞" : "—";
  let peak = equityHistory[0] ?? 1_000;
  let drawdownPct = 0;
  for (const equity of equityHistory) {
    peak = Math.max(peak, equity);
    if (peak > 0) drawdownPct = Math.max(drawdownPct, ((peak - equity) / peak) * 100);
  }
  const equity = 1_000 + net;
  $("#metric-pnl").innerHTML = `${fmtMoney(net)} <small>USDT</small>`;
  $("#metric-pnl").classList.toggle("negative", net < 0);
  $("#metric-pnl").classList.toggle("positive", net >= 0);
  $("#metric-pnl-pct").textContent = `${net >= 0 ? "+" : "−"}${(Math.abs(net) / 1_000 * 100).toFixed(2)}%`;
  $("#metric-pnl-pct").classList.toggle("negative", net < 0);
  $("#metric-pnl-pct").classList.toggle("positive", net >= 0);
  $("#metric-winrate").innerHTML = `${winRate.toFixed(1)}<small>%</small>`;
  $("#winrate-count").textContent = `${wins.length} / ${trades.length} 笔`;
  $("#metric-pf").innerHTML = `${profitFactor}<small> : 1</small>`;
  $("#metric-drawdown").innerHTML = `−${drawdownPct.toFixed(2)}<small>%</small>`;
  $("#chart-value").textContent = equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $(".chart-tooltip strong").textContent = `${$("#chart-value").textContent} USDT`;
  $(".chart-summary b").textContent = `${net >= 0 ? "+" : "−"}${(Math.abs(net) / 1_000 * 100).toFixed(2)}%`;
  $(".chart-summary b").classList.toggle("negative", net < 0);
  drawChart();
}

function drawChart() {
  const values = equityHistory.length ? equityHistory : [1_000];
  let low = values[0];
  let high = values[0];
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const span = Math.max(high - low, 0.1);
  const padding = span * 0.12;
  const points = values.map((value, index) => ({
    x: values.length === 1 ? 0 : (index / (values.length - 1)) * 760,
    y: 194 - ((value - low + padding) / (span + padding * 2)) * 170,
  }));
  const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = `${line} L760 226 L0 226 Z`;
  $("#chart-line").setAttribute("d", line);
  $("#chart-area").setAttribute("d", area);
  const last = points.at(-1);
  $("#chart-endpoint").setAttribute("cx", last.x.toFixed(1));
  $("#chart-endpoint").setAttribute("cy", last.y.toFixed(1));
  $("#chart-guide").setAttribute("x1", last.x.toFixed(1));
  $("#chart-guide").setAttribute("x2", last.x.toFixed(1));
  const miniPath = values.map((value, index) => {
    const x = values.length === 1 ? 1 : (index / (values.length - 1)) * 92 + 1;
    const y = 23 - ((value - low + padding) / (span + padding * 2)) * 20;
    return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  $("#metric-sparkline").setAttribute("d", miniPath);
}

function updateRiskReadout() {
  const score = Number(riskSlider.value);
  const frequency = $("#frequency-select").value;
  const params = getRiskParameters(score, frequency);
  const label = score < 34 ? "稳健" : score < 68 ? "平衡" : "进取";
  $("#risk-value").textContent = String(score);
  $("#risk-label").textContent = label;
  $("#risk-order-cap").textContent = `$${params.maxOrderNotionalUsd.toFixed(2)}`;
  $("#risk-daily-cap").textContent = `$${params.dailyLossLimitUsd.toFixed(2)}`;
  $("#risk-threshold").textContent = `${params.entryThresholdBps} bps`;
  riskSlider.style.background = `linear-gradient(90deg,#bfe867 0 ${score}%,#36444a ${score}% 100%)`;
}

function updateStrategy() {
  const selected = strategies[$("#strategy-select").value];
  $("#strategy-description").textContent = selected.description;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function setStage(index, status) {
  const stage = $(`.stage[data-stage="${index}"]`);
  if (!stage) return;
  stage.classList.remove("current", "completed");
  const mark = stage.querySelector(".stage-mark");
  if (status === "current") {
    stage.classList.add("current");
    mark.textContent = "●";
    stage.querySelector("time").textContent = "进行中";
  } else if (status === "completed") {
    stage.classList.add("completed");
    mark.textContent = "✓";
    stage.querySelector("time").textContent = "完成";
  } else if (status === "cancelled") {
    mark.textContent = "×";
    stage.querySelector("time").textContent = "中止";
  } else {
    mark.textContent = String(index + 1);
    stage.querySelector("time").textContent = "待命";
  }
}

function setRunState(title, detail) {
  $("#run-state").textContent = title;
  $("#run-state-detail").textContent = detail;
}

function addSimulationResult(result, completedAt) {
  const batchTrades = result.trades.map((trade) => ({
    asset: result.asset,
    strategy: result.strategy,
    direction: trade.side,
    entry: fmtPrice(trade.entryPrice),
    exit: fmtPrice(trade.exitPrice),
    pnl: trade.netPnlUsd,
    time: completedAt,
    exitReason: trade.exitReason,
  }));
  trades = [...batchTrades.reverse(), ...trades];
  for (const trade of result.trades) {
    sessionEquity += trade.netPnlUsd;
    equityHistory.push(sessionEquity);
  }
  renderTrades();
  updateMetrics();
  updateMarket();
  persistWorkbenchState();
  return batchTrades.length;
}

async function runSimulation() {
  if (busy) return;
  const generation = ++runGeneration;
  busy = true;
  sessionCount += 1;
  const config = {
    strategy: $("#strategy-select").value,
    asset: $("#asset-select").value,
    frequency: $("#frequency-select").value,
    riskScore: Number(riskSlider.value),
    seed: sessionCount,
    startingEquityUsd: sessionEquity,
  };
  const strategyName = strategies[config.strategy].name;
  $("#run-simulation").disabled = true;
  $("#run-simulation").innerHTML = '<span class="button-icon">◌</span><span>回放计算中</span>';
  $("#stop-simulation").disabled = false;
  $("#execution-label").textContent = "运行中";
  $(".live-label").classList.add("active");
  setRunState("本地合成样本回放中", "离线计算 · 不连接账户、网络行情或交易所");
  for (let i = 0; i < 4; i += 1) setStage(i, "idle");

  const phases = [
    ["合成样本生成", `${config.asset} · ${config.frequency} 回放频率`],
    ["策略信号判断", `${strategyName} · 风险偏好 ${config.riskScore}`],
    ["风控参数评估", `单笔上限 $${getRiskParameters(config.riskScore, config.frequency).maxOrderNotionalUsd.toFixed(2)}`],
    ["纸面回放与记账", "写入当前浏览器本地演示账本"],
  ];
  for (let i = 0; i < phases.length; i += 1) {
    if (generation !== runGeneration) return;
    setStage(i, "current");
    for (let j = 0; j < i; j += 1) setStage(j, "completed");
    $("#execution-label").textContent = phases[i][0];
    setRunState(phases[i][0], phases[i][1]);
    $("#last-check").textContent = "计算中";
    await new Promise((resolve) => setTimeout(resolve, 360));
    if (generation !== runGeneration) return;
  }
  if (generation !== runGeneration) return;
  const result = runSyntheticSimulation(config);
  const completedAt = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const tradeCount = addSimulationResult(result, completedAt);
  for (let i = 0; i < 4; i += 1) setStage(i, "completed");
  $("#execution-label").textContent = "回放完成";
  $(".live-label").classList.remove("active");
  const net = result.metrics.netPnlUsd;
  const detail = tradeCount
    ? `${tradeCount} 笔平仓 · 净模拟盈亏 ${fmtMoney(net)} USDT · 合成样本，不代表实盘表现`
    : "本组参数未触发入场 · 没有生成模拟成交";
  setRunState("本地纸面回放完成", detail);
  $("#last-check").textContent = completedAt;
  $("#run-simulation").disabled = false;
  $("#run-simulation").innerHTML = '<span class="button-icon">▶</span><span>再运行一轮回放</span>';
  $("#stop-simulation").disabled = true;
  busy = false;
  showToast(tradeCount ? `回放完成：${tradeCount} 笔 · ${fmtMoney(net)} USDT` : "回放完成：该参数组合没有触发入场信号");
}

function stopSimulation() {
  if (!busy) return;
  runGeneration += 1;
  busy = false;
  const activeStage = $(".stage.current");
  const activeIndex = activeStage ? Number(activeStage.dataset.stage) : -1;
  for (let i = 0; i < 4; i += 1) {
    const stage = $(`.stage[data-stage="${i}"]`);
    if (stage?.classList.contains("completed")) continue;
    setStage(i, i === activeIndex ? "cancelled" : "idle");
  }
  $("#execution-label").textContent = "已中止";
  $(".live-label").classList.remove("active");
  setRunState("本轮纸面回放已中止", "结果未入账 · 无模拟成交、订单或真实仓位");
  $("#last-check").textContent = "已中止";
  $("#run-simulation").disabled = false;
  $("#run-simulation").innerHTML = '<span class="button-icon">▶</span><span>重新运行纸面模拟</span>';
  $("#stop-simulation").disabled = true;
  showToast("本轮已中止；结果未入账，也未连接账户或交易所。");
}

function clearPaperJournal() {
  trades = [];
  equityHistory = [1_000];
  sessionEquity = 1_000;
  sessionCount = 0;
  renderTrades();
  updateMetrics();
  updateMarket();
  persistWorkbenchState();
  $("#modal-body").innerHTML = pageMarkup("journal");
  showToast("本地纸面回放记录已清空。");
}

function pageMarkup(page) {
  const names = { strategies: "策略实验室", journal: "交易日志", risk: "风险中心", announcements: "官方公告" };
  const intro = "本地合成样本回放，不调用网络行情、账户或交易所；统计结果只用于验证界面和策略逻辑。";
  if (page === "strategies") {
    return `<p class="modal-intro">${intro}三种策略均已接入离线回放。合成数据不能证明策略有效，结果也不可作为收益承诺。</p><div class="modal-grid">${Object.entries(strategies).map(([key, item]) => `<article class="modal-card ${key === $("#strategy-select").value ? "active" : ""}"><span class="card-mark">${item.mark} / STRATEGY</span><h3>${item.name}</h3><p>${item.description}</p><span class="coming">离线合成回放 · 已接入</span></article>`).join("")}</div><div class="modal-callout">本机访问由邀请码入口验证；纸面回放不连接行情、账户或交易所，公告服务与真实下单尚未接入。</div>`;
  }
  if (page === "journal") {
    return `<p class="modal-intro">${intro}纸面回放记录与累计统计保存在当前浏览器本机，不会上传。清空操作只影响这份本地演示账本。</p><div class="journal-actions"><span>LOCAL ONLY · ${trades.length} 笔记录</span><button class="text-button journal-clear" id="clear-paper-journal" type="button">清空本地记录</button></div><div class="clear-confirmation" id="clear-confirmation" hidden role="alertdialog" aria-modal="true" aria-labelledby="clear-confirmation-title" aria-describedby="clear-confirmation-copy"><div><strong id="clear-confirmation-title">确认清空本地演示账本？</strong><p id="clear-confirmation-copy">这会移除此浏览器内的纸面记录、累计指标和权益曲线；当前策略配置会保留。</p></div><div class="clear-confirmation-actions"><button class="quiet-button" id="cancel-clear-paper-journal" type="button">保留记录</button><button class="clear-confirmation-button" id="confirm-clear-paper-journal" type="button">确认清空</button></div></div><div class="table-scroll"><table class="modal-table"><thead><tr><th>时间</th><th>标的</th><th>策略</th><th>方向</th><th>净模拟盈亏</th></tr></thead><tbody>${trades.length ? trades.map((trade) => `<tr><td>${trade.time}</td><td>${trade.asset}</td><td>${strategies[trade.strategy]?.name ?? trade.strategy}</td><td>${trade.direction.toUpperCase()}</td><td class="${trade.pnl >= 0 ? "positive" : "negative"}">${fmtMoney(trade.pnl)}</td></tr>`).join("") : '<tr><td colspan="5">暂无回放记录</td></tr>'}</tbody></table></div>`;
  }
  if (page === "risk") {
    const params = getRiskParameters(Number(riskSlider.value), $("#frequency-select").value);
    return `<p class="modal-intro">${intro}本地参数映射会直接影响回放下单规模、入场门槛和退出条件。</p><div class="risk-detail-grid"><div class="risk-detail"><span>风险偏好指数</span><strong>${$("#risk-value").textContent} / 100 · ${$("#risk-label").textContent}</strong></div><div class="risk-detail"><span>单笔名义上限</span><strong>$${params.maxOrderNotionalUsd.toFixed(2)}</strong></div><div class="risk-detail"><span>单轮亏损停止线</span><strong>$${params.dailyLossLimitUsd.toFixed(2)}</strong></div><div class="risk-detail"><span>入场门槛</span><strong>${params.entryThresholdBps} bps</strong></div><div class="risk-detail"><span>止损 / 止盈</span><strong>${params.stopLossBps.toFixed(1)} / ${params.takeProfitBps.toFixed(1)} bps</strong></div><div class="risk-detail"><span>执行方式</span><strong>本地合成样本回放</strong></div></div><div class="modal-callout">合成样本的成交、滑点和费用只是模型假设，不是实盘风控验证或投资建议。</div>`;
  }
  return `<p class="modal-intro">公告发布服务尚未接入。正式版本可在这里发布版本更新、计划维护、风险提示与服务状态。</p><div class="notice-modal-empty"><span>◌</span><strong>暂时没有公告</strong><p>此处已为官方消息推送预留位置，不会把演示内容冒充为真实通知。</p></div><div class="modal-callout">发布权限、公告签名与推送服务属于后续后端工作；当前版本没有任何外部公告渠道。</div>`;
}

function openModal(page) {
  const names = { strategies: "策略实验室", journal: "交易日志", risk: "风险中心", announcements: "官方公告" };
  previousFocus = document.activeElement;
  $("#modal-kicker").textContent = `TIDEFLOW / ${page.toUpperCase()}`;
  $("#modal-title").textContent = names[page] ?? "工作台";
  $("#modal-body").innerHTML = pageMarkup(page);
  $("#modal-backdrop").hidden = false;
  $("#modal-close").focus();
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("#modal-backdrop").hidden = true;
  document.body.style.overflow = "";
  previousFocus?.focus?.();
}

async function logoutSession() {
  stopSimulation();
  try {
    const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    if (!response.ok) throw new Error(`Logout failed with status ${response.status}`);
    window.location.replace("/");
  } catch {
    showToast("退出失败；本地认证服务未响应，请确认工作台仍在运行。");
  }
}

function updateMarket() {
  const frequency = $("#frequency-select").value;
  const selectedAsset = $("#asset-select").value;
  let selectedSnapshot;
  for (const [asset, definition] of Object.entries(assets)) {
    const snapshot = getSyntheticMarketSnapshot(asset, frequency, sessionCount);
    const row = $(`[data-asset="${asset}"]`);
    if (row) {
      $(".coin-price", row).textContent = fmtPrice(snapshot.lastPrice);
      const change = $$(".coin-change", row)[0];
      change.textContent = `${snapshot.changePct >= 0 ? "+" : "−"}${Math.abs(snapshot.changePct).toFixed(3)}%`;
      change.classList.toggle("positive", snapshot.changePct >= 0);
      change.classList.toggle("negative", snapshot.changePct < 0);
    }
    if (asset === selectedAsset) selectedSnapshot = snapshot;
  }
  if (!selectedSnapshot) return;
  const definition = assets[selectedAsset];
  $(".asset-symbol").textContent = selectedAsset.split("-")[0];
  $(".asset-name").textContent = definition.name;
  $("#market-price").textContent = fmtPrice(selectedSnapshot.lastPrice);
  $("#market-change").textContent = `${selectedSnapshot.changePct >= 0 ? "+" : "−"}${Math.abs(selectedSnapshot.changePct).toFixed(3)}%`;
  $("#market-change").classList.toggle("positive", selectedSnapshot.changePct >= 0);
  $("#market-change").classList.toggle("negative", selectedSnapshot.changePct < 0);
  const spans = $$(".market-meta strong");
  spans[0].textContent = fmtPrice(selectedSnapshot.high);
  spans[1].textContent = fmtPrice(selectedSnapshot.low);
  const points = buildSyntheticPrices(selectedAsset, frequency, sessionCount).slice(-48).map((point) => point.price);
  const low = Math.min(...points);
  const span = Math.max(Math.max(...points) - low, low * 0.00001);
  const path = points.map((price, index) => {
    const x = (index / (points.length - 1)) * 340;
    const y = 64 - ((price - low) / span) * 54;
    return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  $(".market-sparkline .spark-line").setAttribute("d", path);
  $(".market-sparkline .spark-area").setAttribute("d", `${path} L340 74 L0 74 Z`);
}

const frequencyMilliseconds = { "1s": 1_000, "5s": 5_000, "15s": 15_000, "1m": 60_000 };

function currentHistoryConfiguration() {
  return JSON.stringify({
    strategy: $("#strategy-select").value,
    asset: $("#asset-select").value,
    frequency: $("#frequency-select").value,
    riskScore: Number(riskSlider.value),
    allowShort: $("#history-allow-short").checked,
    fileName: historyFileName,
    candleCount: historyCandles.length,
  });
}

function markHistoryResultStale() {
  if (!lastHistoryConfiguration || $("#history-results").hidden) return;
  const stale = currentHistoryConfiguration() !== lastHistoryConfiguration;
  $("#history-result-badge").textContent = stale ? "参数已变更 · 需重新运行" : "样本内历史回放";
  $("#history-result-badge").classList.toggle("stale", stale);
}

function showHistoryError(message) {
  $("#history-error").textContent = message;
  $("#history-error").hidden = false;
  $("#history-results").hidden = true;
}

function formatBarInterval(milliseconds) {
  if (milliseconds >= 3_600_000 && milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000} 小时`;
  if (milliseconds < 60_000) return `${milliseconds / 1_000} 秒`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000} 分钟`;
  return `${(milliseconds / 1_000).toFixed(1)} 秒`;
}

function prepareHistoryCsv(file) {
  const status = $("#history-file-status");
  const runButton = $("#run-history-backtest");
  runButton.disabled = true;
  status.textContent = `正在本机读取 ${file.name}…`;
  status.classList.remove("loaded", "invalid");
  return file.text().then((csv) => {
    if (file.size > 20 * 1024 * 1024) throw new Error("CSV 超过 20 MB 限制，请先按时间范围拆分。");
    const candles = parseCandleCsv(csv);
    if (candles.length > 250_000) throw new Error("CSV 超过 250,000 根 K 线限制，请先按时间范围拆分。");
    if (candles.length < 2) throw new Error("至少需要两根 K 线才能识别 CSV 周期。");
    const intervalMs = candles[1].timestampMs - candles[0].timestampMs;
    if (candles.some((candle, index) => index > 0 && candle.timestampMs - candles[index - 1].timestampMs !== intervalMs)) {
      throw new Error("K 线时间戳存在缺口或间隔变化。请先整理为固定周期数据；程序不会自动补齐或重排。");
    }
    historyCandles = candles;
    historyFileName = file.name;
    $("#history-error").hidden = true;
    $("#history-results").hidden = true;
    const first = new Date(candles[0].timestampMs).toLocaleString("zh-CN");
    const last = new Date(candles.at(-1).timestampMs).toLocaleString("zh-CN");
    status.textContent = `${file.name} · ${candles.length.toLocaleString("zh-CN")} 根 · ${formatBarInterval(intervalMs)} · ${first} — ${last}。${candles.length < 40 ? "样本偏短，可能无法覆盖全部策略观察窗口。" : "已通过格式与时间连续性检查。"}`;
    status.classList.add("loaded");
    status.classList.remove("invalid");
    $("#run-history-backtest").disabled = false;
    markHistoryResultStale();
  }).catch((error) => {
    historyCandles = [];
    historyFileName = "";
    $("#run-history-backtest").disabled = true;
    const status = $("#history-file-status");
    status.textContent = error instanceof Error ? error.message : "CSV 读取失败。";
    status.classList.remove("loaded");
    status.classList.add("invalid");
    showHistoryError(status.textContent);
  });
}

function drawHistoryEquity(trades, initialBalanceUsd) {
  const equity = [initialBalanceUsd];
  for (const trade of trades) equity.push(equity.at(-1) + trade.netPnlUsd);
  let low = equity[0];
  let high = equity[0];
  for (const value of equity) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const span = Math.max(high - low, 0.1);
  const maxPoints = 360;
  const interiorCount = equity.length - 2;
  const bucketCount = Math.min(maxPoints / 2, interiorCount);
  const sampledIndices = [0];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor((bucket * interiorCount) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * interiorCount) / bucketCount);
    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      if (equity[index] < equity[minIndex]) minIndex = index;
      if (equity[index] > equity[maxIndex]) maxIndex = index;
    }
    for (const index of [minIndex, maxIndex].sort((left, right) => left - right)) {
      if (index !== sampledIndices.at(-1)) sampledIndices.push(index);
    }
  }
  if (equity.length > 1 && sampledIndices.at(-1) !== equity.length - 1) sampledIndices.push(equity.length - 1);
  const sampled = sampledIndices.map((index) => equity[index]);
  const line = sampled.map((value, index) => {
    const x = sampled.length === 1 ? 0 : (index / (sampled.length - 1)) * 720;
    const y = 105 - ((value - low) / span) * 88;
    return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  $("#history-equity-line").setAttribute("d", line);
  $("#history-equity-area").setAttribute("d", `${line} L720 120 L0 120 Z`);
}

function renderHistoricalBacktest(result, configuration, parameters) {
  const strategyName = strategies[configuration.strategy].name;
  const assetName = assets[configuration.asset].name;
  $("#history-result-name").textContent = `${assetName} · ${strategyName}`;
  $("#history-result-detail").textContent = `${historyFileName} · ${historyCandles.length.toLocaleString("zh-CN")} 根 ${configuration.frequency} K 线 · 风险指数 ${configuration.riskScore} · 单笔上限 $${parameters.maxOrderNotionalUsd.toFixed(2)} · 手续费 5 bps / 滑点 1 bps`;
  $("#history-result-badge").textContent = "样本内历史回放";
  $("#history-result-badge").classList.remove("stale");
  $("#history-pnl").textContent = `${fmtMoney(result.metrics.netPnlUsd)} USDT`;
  $("#history-pnl").classList.toggle("negative", result.metrics.netPnlUsd < 0);
  $("#history-pnl").classList.toggle("positive", result.metrics.netPnlUsd >= 0);
  $("#history-winrate").textContent = `${result.metrics.winRatePct.toFixed(1)}% · ${result.metrics.tradeCount} 笔`;
  $("#history-pf").textContent = result.metrics.profitFactor === null ? "—" : result.metrics.profitFactor.toFixed(2);
  $("#history-drawdown").textContent = `−${result.metrics.maxDrawdownPct.toFixed(2)}%`;
  $("#history-ending-equity").textContent = `${result.metrics.endingBalanceUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
  drawHistoryEquity(result.trades, result.metrics.initialBalanceUsd);
  const reasonLabels = { signal: "反向信号", stop_loss: "止损", take_profit: "止盈", end_of_data: "样本结束" };
  const rows = result.trades.slice(-8).reverse().map((trade) => {
    const pnlClass = trade.netPnlUsd >= 0 ? "positive" : "negative";
    const timestamp = new Date(trade.exitTimestampMs).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `<tr><td>${timestamp}</td><td><span class="direction ${trade.side}">${trade.side.toUpperCase()}</span></td><td>${fmtPrice(trade.entryPrice)} → ${fmtPrice(trade.exitPrice)}</td><td class="${pnlClass}">${fmtMoney(trade.netPnlUsd)}</td><td>${reasonLabels[trade.exitReason]}</td></tr>`;
  });
  $("#history-trade-rows").innerHTML = rows.length ? rows.join("") : '<tr><td colspan="5">该参数下没有触发平仓交易。</td></tr>';
  $("#history-assumptions").textContent = `模型假设：${result.assumptions.join(" ")} 回测结果不是实盘表现，也不代表未来收益。`;
  $("#history-results").hidden = false;
  $("#history-error").hidden = true;
  lastHistoryConfiguration = currentHistoryConfiguration();
}

function runHistoricalBacktest() {
  if (!historyCandles.length) return;
  try {
    const configuration = {
      strategy: $("#strategy-select").value,
      asset: $("#asset-select").value,
      frequency: $("#frequency-select").value,
      riskScore: Number(riskSlider.value),
    };
    const candleInterval = historyCandles[1].timestampMs - historyCandles[0].timestampMs;
    if (candleInterval !== frequencyMilliseconds[configuration.frequency]) {
      throw new Error(`文件周期是 ${formatBarInterval(candleInterval)}，当前选择是 ${configuration.frequency}。请切换到相同周期或选择对应数据。`);
    }
    const parameters = getRiskParameters(configuration.riskScore, configuration.frequency);
    const initialBalanceUsd = 1_000;
    const fixedNotionalUsd = Math.min(parameters.maxOrderNotionalUsd, initialBalanceUsd * 0.1);
    const result = runStrategyBacktest(historyCandles, {
      initialBalanceUsd,
      fixedNotionalUsd,
      lookbackBars: parameters.lookbackBars,
      entryThresholdBps: parameters.entryThresholdBps,
      stopLossBps: parameters.stopLossBps,
      takeProfitBps: parameters.takeProfitBps,
      takerFeeBps: 5,
      slippageBps: 1,
      allowShort: $("#history-allow-short").checked,
      dailyLossLimitUsd: parameters.dailyLossLimitUsd,
    }, configuration.strategy);
    renderHistoricalBacktest(result, configuration, parameters);
  } catch (error) {
    showHistoryError(error instanceof Error ? error.message : "历史回测失败。");
  }
}

function updateClock() {
  $("#local-clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

restoreWorkbenchState();
renderTrades();
updateStrategy();
updateMetrics();
updateRiskReadout();
updateMarket();
updateClock();
if (storageWarning) showToast(storageWarning);
setInterval(updateClock, 1_000);

riskSlider.addEventListener("input", () => { updateRiskReadout(); markHistoryResultStale(); });
riskSlider.addEventListener("change", persistWorkbenchState);
$("#strategy-select").addEventListener("change", () => { updateStrategy(); markHistoryResultStale(); persistWorkbenchState(); });
$("#frequency-select").addEventListener("change", () => { updateRiskReadout(); updateMarket(); markHistoryResultStale(); persistWorkbenchState(); });
$("#asset-select").addEventListener("change", (event) => {
  $$(".market-row").forEach((item) => item.classList.toggle("active", item.dataset.asset === event.target.value));
  updateMarket();
  markHistoryResultStale();
  persistWorkbenchState();
});
$("#history-allow-short").addEventListener("change", markHistoryResultStale);
$("#select-history-file").addEventListener("click", () => $("#history-file").click());
$("#history-file").addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) prepareHistoryCsv(file);
  event.target.value = "";
});
$("#run-history-backtest").addEventListener("click", runHistoricalBacktest);
$("#run-simulation").addEventListener("click", runSimulation);
$("#stop-simulation").addEventListener("click", stopSimulation);
$("#logout-button").addEventListener("click", logoutSession);
$("#announcements-shortcut").addEventListener("click", () => openModal("announcements"));
$("#modal-close").addEventListener("click", closeModal);
$("#modal-body").addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("#clear-paper-journal")) {
    $("#clear-confirmation").hidden = false;
    $("#cancel-clear-paper-journal").focus();
  } else if (event.target.closest("#cancel-clear-paper-journal")) {
    $("#clear-confirmation").hidden = true;
    $("#clear-paper-journal").focus();
  } else if (event.target.closest("#confirm-clear-paper-journal")) {
    clearPaperJournal();
  }
});
$("#modal-backdrop").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeModal(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#modal-backdrop").hidden) closeModal();
});

$$('[data-page]').forEach((button) => button.addEventListener("click", () => {
  const page = button.dataset.page;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
  $("#page-breadcrumb").textContent = page === "overview" ? "总览" : button.querySelector("span:nth-child(2)").textContent;
  if (page !== "overview") openModal(page);
}));
$$('[data-open-page]').forEach((button) => button.addEventListener("click", () => openModal(button.dataset.openPage)));

$$('[data-asset]').forEach((button) => button.addEventListener("click", () => {
  $$(".market-row").forEach((item) => item.classList.toggle("active", item === button));
  $("#asset-select").value = button.dataset.asset;
  updateMarket();
  markHistoryResultStale();
  persistWorkbenchState();
}));
