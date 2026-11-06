import { buildSyntheticPrices, getRiskParameters, getSyntheticMarketSnapshot, runSyntheticSimulation } from "./simulator.js";

const $ = (selector) => document.querySelector(selector);
const definitions = {
  momentum: { name: "脉冲动量", text: "跟随短窗价格变化，在方向反转时重新评估。", tags: ["顺势观察", "信号驱动"] },
  breakout: { name: "区间突破", text: "等待价格越过观察区间，再由风控决定入场。", tags: ["区间识别", "突破确认"] },
  "mean-reversion": { name: "均值回归", text: "观察价格与短窗均值的偏离，检验回归假设。", tags: ["偏离判断", "反向假设"] },
};
const validAssets = ["BTC-USDT", "ETH-USDT", "SOL-USDT"];
const frequencies = { "1s": "1 秒", "5s": "5 秒", "15s": "15 秒", "1m": "1 分钟" };
const storageKey = "tideflow.mobile-preview.v1";
let settings = { strategy: "momentum", asset: "BTC-USDT", frequency: "5s", riskScore: 42 };
let runs = [];
let tab = "home";
let busy = false;
let phaseIndex = -1;
let generation = 0;
let outcome = "尚未开始回放";
let toastTimer;
let storageIssue = "";
let restoreFailed = false;
const money = (value) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
const number = (value) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function validSettings(value) {
  return value && Object.hasOwn(definitions, value.strategy) && validAssets.includes(value.asset) && Object.hasOwn(frequencies, value.frequency) && Number.isInteger(value.riskScore) && value.riskScore >= 0 && value.riskScore <= 100;
}
try {
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    const saved = JSON.parse(raw);
    if (saved?.version !== 1 || !validSettings(saved.settings) || !Array.isArray(saved.runs) || saved.runs.length > 200 || saved.runs.some((run) => !validSettings(run.config) || typeof run.time !== "string" || !Array.isArray(run.trades) || run.trades.some((trade) => !["long", "short"].includes(trade.side) || !Number.isFinite(trade.netPnlUsd) || !Number.isFinite(trade.entryPrice) || !Number.isFinite(trade.exitPrice)))) throw new Error("记录格式无法识别");
    settings = { ...saved.settings }; runs = saved.runs;
  }
} catch {
  restoreFailed = true;
  storageIssue = "手机预览记录读取失败。原记录已保留，本页暂不覆盖保存。";
}
function persist() {
  if (restoreFailed) return false;
  try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, settings, runs })); return true; }
  catch { storageIssue = "浏览器未能保存记录；本次结果只在当前页面保留。"; toast(storageIssue); return false; }
}
function metrics() {
  const trades = runs.flatMap((run) => run.trades);
  let equity = 1000, peak = 1000, drawdown = 0;
  const values = [1000];
  for (const trade of trades) { equity += trade.netPnlUsd; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, (peak - equity) / peak * 100); values.push(equity); }
  const wins = trades.filter((trade) => trade.netPnlUsd > 0);
  const positive = wins.reduce((sum, trade) => sum + trade.netPnlUsd, 0);
  const negative = Math.abs(trades.filter((trade) => trade.netPnlUsd < 0).reduce((sum, trade) => sum + trade.netPnlUsd, 0));
  return { trades, values, equity, pnl: equity - 1000, winRate: trades.length ? wins.length / trades.length * 100 : 0, pf: negative ? (positive / negative).toFixed(2) : positive ? "∞" : "—", drawdown };
}
function spark(values, className = "") {
  if (values.length === 1) values = [values[0], values[0]];
  const low = Math.min(...values), high = Math.max(...values), spread = high - low || 1;
  const path = values.map((value, index) => `${index ? "L" : "M"}${(index / Math.max(1, values.length - 1) * 300 + 3).toFixed(2)} ${(65 - (value - low) / spread * 54).toFixed(2)}`).join(" ");
  return `<svg class="spark ${className}" viewBox="0 0 306 76" preserveAspectRatio="none" role="img" aria-label="${className ? "离线样本价格曲线" : "本机模拟权益曲线"}"><path d="${path}"/></svg>`;
}
function hero() {
  const m = metrics();
  return `<article class="hero"><div class="hero-label"><span class="eyebrow">YOUR STRATEGY, IN VIEW</span><span class="sample-badge">离线回放</span></div><span class="subtitle">累计模拟盈亏 · USDT</span><div class="hero-value ${m.pnl >= 0 ? "up" : "down"}">${money(m.pnl)}<small>USDT</small></div>${spark(m.values)}<div class="hero-stats"><div><span>模拟权益</span><strong>${number(m.equity)}</strong></div><div><span>已平仓笔数</span><strong>${m.trades.length}</strong></div><div><span>模拟胜率</span><strong>${m.winRate.toFixed(1)}%</strong></div></div></article>`;
}
function home() {
  const market = ["BTC-USDT", "ETH-USDT"].map((asset, index) => {
    const value = getSyntheticMarketSnapshot(asset, settings.frequency, runs.length);
    const prices = buildSyntheticPrices(asset, settings.frequency, runs.length).slice(-25).map((point) => point.price);
    return `<article class="market-card"><div class="ticker"><span class="coin ${index ? "eth" : ""}">${index ? "◆" : "₿"}</span>${asset.split("-")[0]} <small>/ USDT</small></div><strong>${number(value.lastPrice)}</strong><small class="${value.changePct >= 0 ? "up" : "down"}">${money(value.changePct)}%</small>${spark(prices, "mini-chart")}</article>`;
  }).join("");
  return `<div class="eyebrow">MARKET RHYTHM / 潮序</div><h1>每一个策略，<br>都值得被检验。</h1><p style="margin-bottom:21px">你的策略、表现与运行记录，随手可查。</p>${hero()}<div class="quick-grid"><button data-go="strategies"><b>⌁</b>选择策略</button><button data-action="configure"><b>⛨</b>风险偏好</button><button data-go="activity"><b>▤</b>回放记录</button><button data-info="install"><b>↗</b>手机安装</button></div><div class="section-heading"><h2>样本观察</h2><small>离线合成 · 非实时行情</small></div><div class="market-grid">${market}</div><div class="section-heading"><h2>官方消息</h2><button class="text-button" data-info="notice">查看 ↗</button></div><article class="card notice"><span class="dot"></span><div><h3>手机工作台 · 首版预览</h3><p>首页、策略、运行与账户已经归位。官方远程公告服务待接入。</p></div></article><p class="caption">本页使用合成样本检验交互。模拟记录不能代表真实成交或未来收益。${storageIssue ? `<br>${escape(storageIssue)}` : ""}</p>`;
}
function strategiesScreen() {
  return `<div class="eyebrow">STRATEGY STUDIO</div><h1>选择你的交易思路</h1><p>先选假设，再调参数，最后看回放结果。</p>${Object.entries(definitions).map(([key, value], index) => `<button class="card strategy-card ${settings.strategy === key ? "selected" : ""}" data-strategy="${key}"><div class="row"><span class="strategy-number">0${index + 1} / ${key.toUpperCase()}</span><span class="selected-label">${settings.strategy === key ? "当前配置 ✓" : "配置 ↗"}</span></div><h2 style="margin-top:13px">${value.name}</h2><p>${value.text}</p><div class="tags">${value.tags.map((tag) => `<span>${tag}</span>`).join("")}<span>纸面回放</span></div></button>`).join("")}<div class="section-heading"><h2>当前配置</h2><button class="text-button" data-action="configure">调整 ↗</button></div><article class="card"><h3>${settings.asset} · ${frequencies[settings.frequency]}</h3><p>风险指数 ${settings.riskScore}/100 · ${definitions[settings.strategy].name}</p><button class="primary" style="margin-top:18px" data-go="activity">进入运行工作台 →</button></article>`;
}
const phases = ["生成样本", "判断策略信号", "评估风控参数", "纸面回放与记账"];
function activity() {
  const m = metrics();
  const trades = runs.flatMap((run) => run.trades.map((trade) => ({ ...trade, asset: run.config.asset, time: run.time }))).reverse().slice(0, 20);
  return `<div class="eyebrow">EXECUTION / PAPER</div><h1>看见策略的每一步</h1><p>本机单轮回放 · ${settings.asset} · ${definitions[settings.strategy].name}</p><div class="metric-row"><div class="metric-box"><span>净模拟盈亏 · USDT</span><strong class="${m.pnl >= 0 ? "up" : "down"}">${money(m.pnl)}</strong></div><div class="metric-box"><span>模拟最大回撤</span><strong>${m.drawdown.toFixed(2)}%</strong></div><div class="metric-box"><span>模拟胜率</span><strong>${m.winRate.toFixed(1)}%</strong></div><div class="metric-box"><span>盈亏因子</span><strong>${m.pf}</strong></div></div><article class="card run-panel"><div class="hero-label"><h3>${busy ? "回放进行中" : "运行控制"}</h3><span class="pill">${busy ? "计算中" : "待命"}</span></div>${phases.map((phase, index) => `<div class="phase ${phaseIndex === index && busy ? "current" : phaseIndex > index || phaseIndex === 4 ? "done" : ""}"><i>${phaseIndex > index || phaseIndex === 4 ? "✓" : index + 1}</i><span>${phase}</span><small>${phaseIndex === index && busy ? "进行中" : phaseIndex > index || phaseIndex === 4 ? "完成" : "待命"}</small></div>`).join("")}<p id="run-outcome">${escape(outcome)}</p><div class="run-actions"><button class="primary" data-action="run" ${busy ? "disabled" : ""}>${busy ? "回放计算中…" : "▶ 运行一轮纸面回放"}</button>${busy ? '<button class="secondary" data-action="stop">中止</button>' : ""}</div></article><div class="section-heading"><h2>最近模拟成交</h2><small>共 ${m.trades.length} 笔</small></div><article class="card">${trades.length ? trades.map((trade) => `<div class="trade"><div><strong>${trade.asset} <small style="display:inline">${trade.side === "long" ? "做多" : "做空"}</small></strong><small>${escape(trade.time)} · 纸面回放</small></div><div class="trade-end"><strong class="${trade.netPnlUsd >= 0 ? "up" : "down"}">${money(trade.netPnlUsd)}</strong><small>${number(trade.entryPrice)} → ${number(trade.exitPrice)}</small></div></div>`).join("") : '<div class="empty"><span>⌁</span><h3>让第一个假设开始运行</h3><p>运行一轮回放后，成交与结果会显示在这里。</p></div>'}</article><p class="caption">成交在本机合成样本上计算；已计入模型手续费和滑点，不是交易所成交。关闭本页会停止当前回放。</p>`;
}
function account() {
  return `<div class="eyebrow">YOUR WORKSPACE</div><div class="account-hero"><div class="avatar">潮</div><div><h2>受邀体验用户</h2><p>潮序 · 手机工作台预览</p></div></div><article class="hero"><div class="eyebrow">PRIVATE PREVIEW</div><h2>把工作台装进口袋。</h2><p style="color:#b7c6ba">电脑深入研究，手机随时查看。统一账户与跨设备同步是下一阶段。</p><button class="primary lime" data-info="install">查看手机安装方式 ↗</button></article><div class="card account-links"><button data-info="access"><span>邀请与访问</span><small>本机访问码 ›</small></button><button data-info="sync"><span>数据与设备</span><small>仅当前浏览器 ›</small></button><button data-info="notice"><span>官方消息</span><small>公告预留位 ›</small></button><a href="/"><span>电脑工作台</span><small>打开 ›</small></a></div><p class="caption">当前没有会员收费、充值、钱包托管或云端执行服务。页面数据由本机演示回放产生。</p><div class="version">TIDEFLOW / MOBILE PREVIEW 0.1</div>`;
}
function render() {
  $("#screen").innerHTML = ({ home, strategies: strategiesScreen, activity, account })[tab]();
  document.querySelectorAll("[data-tab]").forEach((button) => { if (button.dataset.tab === tab) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
}
function navigate(next) { if (!["home", "strategies", "activity", "account"].includes(next)) return; tab = next; render(); window.scrollTo({ top: 0, behavior: "instant" }); }
function toast(text) { const element = $("#toast"); clearTimeout(toastTimer); element.textContent = text; element.hidden = false; toastTimer = setTimeout(() => { element.hidden = true; }, 4200); }
function dialog(title, body) { $("#dialog-title").textContent = title; $("#dialog-content").innerHTML = body; $("#detail-dialog").showModal(); }
function configure(strategy = settings.strategy) {
  if (busy) { toast("本轮回放运行中，结束后可调整配置。"); return; }
  dialog(definitions[strategy].name, `<p>${definitions[strategy].text}</p><form id="configuration-form"><input name="strategy" type="hidden" value="${strategy}"/><div class="field"><label for="mobile-asset">交易标的</label><select name="asset" id="mobile-asset">${validAssets.map((asset) => `<option ${settings.asset === asset ? "selected" : ""}>${asset}</option>`).join("")}</select></div><div class="field"><label for="mobile-frequency">样本回放频率</label><select name="frequency" id="mobile-frequency">${Object.entries(frequencies).map(([key, value]) => `<option value="${key}" ${settings.frequency === key ? "selected" : ""}>${value}</option>`).join("")}</select></div><div class="field"><label for="mobile-risk">风险承受指数 <strong id="risk-value">${settings.riskScore} / 100</strong></label><input name="riskScore" id="mobile-risk" type="range" min="0" max="100" value="${settings.riskScore}"/></div><div id="risk-parameters"></div><button class="primary" type="submit">保存配置</button><p class="caption">这些参数用于离线样本实验；秒级频率不代表实盘高频交易能力。</p></form>`);
  updateRisk();
}
function updateRisk() {
  const score = Number($("#mobile-risk").value), frequency = $("#mobile-frequency").value;
  const params = getRiskParameters(score, frequency);
  $("#risk-value").textContent = `${score} / 100`;
  $("#risk-parameters").innerHTML = `<div class="parameter-grid"><div><span>单笔名义上限</span><strong>$${params.maxOrderNotionalUsd.toFixed(2)}</strong></div><div><span>单轮亏损停止线</span><strong>$${params.dailyLossLimitUsd.toFixed(2)}</strong></div><div><span>入场门槛</span><strong>${params.entryThresholdBps} bps</strong></div><div><span>止损距离</span><strong>${params.stopLossBps.toFixed(1)} bps</strong></div></div>`;
}
const information = {
  notice: ["官方消息", '<div class="help-step"><strong>手机工作台首版预览</strong><p>已接入本地合成回放引擎，可切换策略并检验参数。此条为本版本说明；远程公告发布服务尚未接入。</p></div>'],
  install: ["装进你的手机", '<div class="help-step"><strong>iPhone · 主屏幕 Web App</strong><p>正式 HTTPS 网站部署后，可在 Safari 使用“添加到主屏幕”。也可提供只包含桌面网页入口的 Web Clip 描述文件。</p></div><div class="help-step"><strong>Android · 网页 / PWA / APK</strong><p>优先共用手机版网站；后续按需提供 PWA 安装或签名 APK。</p></div><div class="help-step"><strong>当前进度</strong><p>这是电脑上的本地预览，地址仅能在这台电脑访问。尚未部署手机可访问的网址，未生成 iPhone 安装文件或 Android APK。</p></div>'],
  access: ["邀请与访问", '<p>当前沿用本机工作台的访问码。正式版本计划由管理员邀请并发放逐用户权限，不开放自由注册。</p>'],
  sync: ["数据与设备", '<p>本页记录仅保存在当前浏览器的手机预览账本中，未上传，也未与电脑版旧演示账本合并。跨设备同步和统一账号尚未接入。</p>'],
};
async function run() {
  if (busy) return;
  if (runs.length >= 200) { toast("本地预览已达到 200 轮记录上限；原记录保留，暂不新增。"); return; }
  busy = true; const current = ++generation; const config = { ...settings };
  navigate("activity");
  try {
    for (phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) { if (generation !== current) return; outcome = `${phases[phaseIndex]} · ${config.asset}`; render(); await new Promise((resolve) => setTimeout(resolve, 500)); if (generation !== current) return; }
    const result = runSyntheticSimulation({ ...config, seed: runs.length + 1, startingEquityUsd: metrics().equity });
    runs.push({ config, time: new Date().toLocaleString("zh-CN", { hour12: false }), trades: result.trades });
    outcome = `${result.trades.length} 笔平仓 · 净模拟盈亏 ${money(result.metrics.netPnlUsd)} USDT`;
    phaseIndex = 4; persist(); toast(result.trades.length ? "本轮回放已完成，可在运行页查看结果。" : "本轮未触发入场信号，没有模拟成交。");
  } catch (error) { phaseIndex = -1; outcome = `回放失败：${error.message}`; }
  finally { if (generation === current) { busy = false; render(); } }
}
document.addEventListener("click", (event) => {
  if (event.target.closest("a.brand")) { event.preventDefault(); navigate("home"); return; }
  const button = event.target.closest("button"); if (!button) return;
  if (button.dataset.tab || button.dataset.go) navigate(button.dataset.tab || button.dataset.go);
  if (button.dataset.strategy) configure(button.dataset.strategy);
  if (button.dataset.info) { const [title, content] = information[button.dataset.info]; dialog(title, content); }
  if (button.dataset.action === "configure") configure();
  if (button.dataset.action === "run") void run();
  if (button.dataset.action === "stop") { generation++; busy = false; phaseIndex = -1; outcome = "本轮已中止，未新增模拟成交。"; render(); }
  if (button.id === "close-dialog") $("#detail-dialog").close();
});
document.addEventListener("input", (event) => { if (["mobile-risk", "mobile-frequency"].includes(event.target.id)) updateRisk(); });
document.addEventListener("submit", (event) => {
  if (event.target.id !== "configuration-form") return; event.preventDefault();
  const fields = new FormData(event.target);
  const next = { strategy: fields.get("strategy"), asset: fields.get("asset"), frequency: fields.get("frequency"), riskScore: Number(fields.get("riskScore")) };
  if (!validSettings(next)) { toast("配置值无法识别，请重新选择。"); return; }
  settings = next; const saved = persist(); $("#detail-dialog").close(); render(); toast(saved ? "配置已保存到当前浏览器。" : "配置本页已生效，但未能保存到浏览器。");
});
render();
if (storageIssue) toast(storageIssue);
