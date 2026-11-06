const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

class RuntimeBridge extends EventEmitter {
  constructor({ root, dataDirectory, modules, webSocketFactory, timeoutMs = 15000 }) {
    super(); this.root = root; this.dataDirectory = dataDirectory; this.modules = modules;
    this.socketFactory = webSocketFactory; this.timeoutMs = timeoutMs; this.generation = 0;
    this.state = { status: 'idle', trades: [], events: [], ticker: null, lastReport: null, config: null, positionOpen: false };
    fs.mkdirSync(dataDirectory, { recursive: true });
    const saved = path.join(dataDirectory, 'paper-latest.json');
    if (fs.existsSync(saved)) {
      const previous = JSON.parse(fs.readFileSync(saved, 'utf8'));
      if (!Array.isArray(previous.trades) || !Array.isArray(previous.events)) throw new Error('纸面交易记录格式无法识别，原文件已保留。');
      this.state = { ...this.state, ...previous, status: ['running', 'connecting'].includes(previous.status) ? 'interrupted' : previous.status };
      if (this.state.status === 'interrupted') this.event('上次运行未正常结束，保留原纸面记录；新会话使用独立模拟资金。');
    }
  }
  async loadModules() {
    if (!this.modules) {
      const [runtime, ticker, risk] = await Promise.all([
        import(pathToFileURL(path.join(this.root, 'dist/runtime/paper_runtime.js')).href),
        import(pathToFileURL(path.join(this.root, 'dist/market/okx_ticker.js')).href),
        import(pathToFileURL(path.join(this.root, 'workbench/simulator.js')).href),
      ]);
      this.modules = { PaperRuntime: runtime.PaperRuntime, parseTicker: ticker.parseOkxTickerMessage, risk: risk.getRiskParameters };
    }
  }
  snapshot() {
    const trades = this.state.trades;
    const profit = trades.filter(t => t.netPnlUsd > 0).reduce((n, t) => n + t.netPnlUsd, 0);
    const loss = -trades.filter(t => t.netPnlUsd < 0).reduce((n, t) => n + t.netPnlUsd, 0);
    return { ...this.state, trades: trades.slice(-100), metrics: {
      closedTrades: trades.length, netPnlUsd: profit - loss,
      winRatePct: trades.length ? trades.filter(t => t.netPnlUsd > 0).length / trades.length * 100 : 0,
      profitFactor: loss > 0 ? profit / loss : profit > 0 ? '∞' : null,
      closedTradeFeesUsd: trades.reduce((n, t) => n + t.feesUsd, 0),
    } };
  }
  notify() { this.emit('state', this.snapshot()); }
  persist() {
    const target = path.join(this.dataDirectory, 'paper-latest.json');
    const temp = target + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.state)); fs.renameSync(temp, target);
  }
  journal(type, payload) {
    fs.appendFileSync(path.join(this.dataDirectory, 'paper-history.jsonl'), JSON.stringify({ time: new Date().toISOString(), sessionId: this.sessionId, type, ...payload }) + '\n');
  }
  event(message) {
    this.state.events = [...this.state.events.slice(-99), { time: new Date().toISOString(), message }];
    this.notify();
  }
  async start(config) {
    if (this.starting || ['running', 'connecting'].includes(this.state.status)) throw new Error('已有纸面交易会话运行中。');
    if (!config || typeof config.endpoint !== 'string') throw new Error('请填写账户区域对应的公开行情 WebSocket 地址。');
    const endpoint = new URL(config.endpoint.trim());
    if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.port === '8443' || /private|business/i.test(endpoint.pathname)) throw new Error('只接受无凭据、无查询参数的 wss:// 公开行情地址，端口不可为 8443。');
    if (!['BTC-USDT', 'ETH-USDT', 'SOL-USDT'].includes(config.asset)) throw new Error('不支持的交易标的。');
    if (!Number.isInteger(config.riskScore) || config.riskScore < 0 || config.riskScore > 100) throw new Error('风险指数必须为 0–100 整数。');
    const token = ++this.generation;
    this.starting = true; this.state.status = 'connecting'; this.notify();
    try { await this.loadModules(); }
    catch (error) { this.state.status = 'error'; this.event(error.message); throw error; }
    finally { this.starting = false; }
    if (token !== this.generation) return this.snapshot();
    this.sessionId = randomUUID();
    this.state = { status: 'connecting', trades: [], events: [], ticker: null, lastReport: null, config: { endpoint: endpoint.href, asset: config.asset, riskScore: config.riskScore }, positionOpen: false };
    this.journal('start', { config: this.state.config }); this.persist(); this.notify();
    const parameters = this.modules.risk(config.riskScore, '5s');
    const socketFactory = (url) => {
      const socket = this.socketFactory ? this.socketFactory(url) : new WebSocket(url);
      socket.addEventListener('message', event => {
        if (token !== this.generation || typeof event.data !== 'string' || event.data === 'pong') return;
        let message; try { message = JSON.parse(event.data); } catch { return; }
        const ticker = this.modules.parseTicker(message).find(row => row.instId === config.asset);
        if (ticker) { this.state.ticker = ticker; this.notify(); }
      });
      return socket;
    };
    this.runtime = new this.modules.PaperRuntime({
      endpoint: endpoint.href, instId: config.asset, initialBalanceUsd: 1000,
      fixedNotionalUsd: parameters.maxOrderNotionalUsd, takerFeeBps: 5, slippageBps: 1,
      stopLossBps: parameters.stopLossBps, takeProfitBps: parameters.takeProfitBps,
      lookbackTicks: parameters.lookbackBars, entryThresholdBps: parameters.entryThresholdBps,
      allowShort: true, webSocketFactory: socketFactory,
      riskLimits: { maxOrderNotionalUsd: parameters.maxOrderNotionalUsd, maxPositionNotionalUsd: parameters.maxOrderNotionalUsd, dailyLossLimitUsd: parameters.dailyLossLimitUsd, maxOrdersPerMinute: 12, maxSpreadBps: 25, orderCooldownMs: 1000, maxMarketAgeMs: 5000 },
      onStatus: message => {
        if (token !== this.generation) return;
        if (/^paper (long|short) /.test(message)) { this.state.positionOpen = true; this.journal('position_open', { message }); this.persist(); }
        this.event(message);
      },
      onTrade: trade => {
        if (token !== this.generation) return;
        this.state.trades.push(trade); this.state.positionOpen = false;
        this.journal('closed_trade', { trade }); this.persist(); this.notify();
      },
      onReport: report => {
        if (token !== this.generation) return;
        this.state.lastReport = report; this.state.positionOpen = Boolean(report.openPosition);
        this.state.status = report.stopReason === 'market_data_disconnected' ? 'disconnected' : 'stopped';
        this.journal('session_report', { report }); this.persist(); this.notify();
      },
    });
    let timer;
    try {
      await Promise.race([this.runtime.start(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('公开行情连接超时，请检查地址、网络和代理。')), this.timeoutMs); })]);
      if (token !== this.generation) return this.snapshot();
      if (this.state.status === 'connecting') this.state.status = 'running';
      this.persist(); this.notify(); return this.snapshot();
    } catch (error) {
      if (token !== this.generation) return this.snapshot();
      if (token === this.generation) {
        this.runtime.stop(); this.state.status = 'error'; this.event(error.message); this.persist();
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  stop() {
    if (this.runtime) this.runtime.stop();
    this.generation++;
    if (['running', 'connecting'].includes(this.state.status)) this.state.status = 'stopped';
    this.persist(); this.notify(); return this.snapshot();
  }
}
module.exports = { RuntimeBridge };
