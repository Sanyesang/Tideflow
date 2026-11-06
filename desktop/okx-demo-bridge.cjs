const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SUPPORTED_INSTRUMENTS = new Set(['BTC-USDT', 'ETH-USDT', 'SOL-USDT']);
const OKX_DEMO_MARKET_HOSTS = new Set(['wspap.okx.com', 'wseeapap.okx.com', 'wsuspap.okx.com']);
const DEFAULT_CONFIG = Object.freeze({
  restBaseUrl: 'https://www.okx.com',
  endpoint: 'wss://wspap.okx.com/ws/v5/public',
  instId: 'BTC-USDT',
  quoteBudget: '25',
  stopLossBps: 35,
  takeProfitBps: 50,
});

function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模拟盘配置格式无效。');
  const config = { ...DEFAULT_CONFIG, ...input };
  let rest, socket;
  try { rest = new URL(String(config.restBaseUrl).trim()); } catch { throw new Error('请填写 OKX 账户所属站点的 HTTPS REST 域名。'); }
  if (rest.protocol !== 'https:' || !/(^|\.)okx\.com$/i.test(rest.hostname) || rest.username || rest.password || rest.search || rest.hash || !['', '/'].includes(rest.pathname)) {
    throw new Error('REST 地址必须使用 OKX 官方 HTTPS 域名，不能含凭据、路径、查询参数或片段。');
  }
  try { socket = new URL(String(config.endpoint).trim()); } catch { throw new Error('请填写账户所属站点的模拟盘公开行情 WebSocket 地址。'); }
  if (socket.protocol !== 'wss:' || !OKX_DEMO_MARKET_HOSTS.has(socket.hostname.toLowerCase())
    || socket.username || socket.password || socket.search || socket.hash || (socket.port && socket.port !== '443')
    || socket.pathname !== '/ws/v5/public') {
    throw new Error('行情地址须使用 OKX 官方模拟盘 public WebSocket 地址、/ws/v5/public 路径与 443 端口。');
  }
  if (!SUPPORTED_INSTRUMENTS.has(config.instId)) throw new Error('当前版本仅支持 BTC-USDT、ETH-USDT、SOL-USDT 现货模拟。');
  const budget = String(config.quoteBudget).trim();
  const numericBudget = Number(budget);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(budget) || !Number.isFinite(numericBudget) || numericBudget < 1 || numericBudget > 500) {
    throw new Error('单次预算需为 1–500 USDT，最多四位小数。');
  }
  const stopLossBps = Number(config.stopLossBps);
  const takeProfitBps = Number(config.takeProfitBps);
  if (!Number.isFinite(stopLossBps) || stopLossBps < 5 || stopLossBps > 500
    || !Number.isFinite(takeProfitBps) || takeProfitBps < 5 || takeProfitBps > 1000) {
    throw new Error('止损需为 5–500 bps，止盈需为 5–1000 bps。');
  }
  return {
    restBaseUrl: rest.origin,
    endpoint: socket.toString(),
    instId: config.instId,
    quoteBudget: budget,
    stopLossBps,
    takeProfitBps,
  };
}

function validateCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请填写模拟盘 API Key、Secret 与 Passphrase。');
  const credentials = {};
  for (const [key, label] of [['apiKey', 'API Key'], ['secretKey', 'Secret'], ['passphrase', 'Passphrase']]) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 512) throw new Error(`${label} 无效。`);
    credentials[key] = value[key].trim();
  }
  return credentials;
}

class EncryptedCredentialStore {
  constructor(filePath, safeStorage) { this.filePath = filePath; this.safeStorage = safeStorage; }
  async assertEncryptionAvailable() {
    if (typeof this.safeStorage?.isAsyncEncryptionAvailable !== 'function'
      || !await this.safeStorage.isAsyncEncryptionAvailable()) {
      throw new Error('系统加密服务当前不可用；凭据未保存，也不会降级为明文。');
    }
  }
  async save(value) {
    const credentials = validateCredentials(value);
    await this.assertEncryptionAvailable();
    const encrypted = await this.safeStorage.encryptStringAsync(JSON.stringify(credentials));
    const payload = JSON.stringify({ version: 1, encrypted: encrypted.toString('base64') });
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, payload, { encoding: 'utf8', flag: 'w' });
    await fs.rename(temporary, this.filePath);
    return { configured: true };
  }
  async load() {
    await this.assertEncryptionAvailable();
    let text;
    try { text = await fs.readFile(this.filePath, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw new Error('本机加密凭据文件损坏；请清除后重新配置。'); }
    if (envelope?.version !== 1 || typeof envelope.encrypted !== 'string') throw new Error('本机加密凭据文件版本无法识别。');
    try {
      const decrypted = await this.safeStorage.decryptStringAsync(Buffer.from(envelope.encrypted, 'base64'));
      return validateCredentials(JSON.parse(decrypted.result));
    } catch { throw new Error('无法解密已保存的凭据；请在原 Windows 用户账户下重试，或清除后重新配置。'); }
  }
  async status() {
    try { await fs.access(this.filePath); return { configured: true }; }
    catch (error) { if (error?.code === 'ENOENT') return { configured: false }; throw error; }
  }
  async clear() {
    try { await fs.unlink(this.filePath); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return { configured: false };
  }
}

class OkxDemoBridge extends EventEmitter {
  constructor({ root, dataDirectory, credentialStore, modules, now = () => new Date() }) {
    super();
    this.root = root;
    this.dataDirectory = dataDirectory;
    this.credentialStore = credentialStore;
    this.modules = modules;
    this.now = now;
    this.runtime = null;
    this.state = { status: 'idle', config: null, preflight: null, events: [], lastError: null, lastRuntimeSnapshot: null };
    this.journalPath = path.join(dataDirectory, 'okx-demo-orders.jsonl');
    this.journal = null;
    this.coordinator = null;
    this.client = null;
  }
  async loadModules() {
    if (!this.modules) {
      const names = [
        'adapters/okx_execution.js', 'adapters/okx_instruments.js',
        'execution/order_coordinator.js', 'persistence/trade_journal.js',
        'runtime/demo_spot_runtime.js',
      ];
      const loaded = await Promise.all(names.map(name => import(pathToFileURL(path.join(this.root, 'dist', name)).href)));
      this.modules = Object.fromEntries(names.map((name, index) => [name, loaded[index]]));
    }
    const [execution, instruments, orders, journal, runtime] = [
      this.modules['adapters/okx_execution.js'], this.modules['adapters/okx_instruments.js'],
      this.modules['execution/order_coordinator.js'], this.modules['persistence/trade_journal.js'],
      this.modules['runtime/demo_spot_runtime.js'],
    ];
    if (!execution || !instruments || !orders || !journal || !runtime) throw new Error('桌面包缺少模拟盘运行模块。');
    this.classes = { ...execution, ...instruments, ...orders, ...journal, ...runtime };
  }
  pushEvent(message) {
    this.state.events = [...this.state.events.slice(-99), { time: this.now().toISOString(), message: String(message) }];
    this.emit('state', this.snapshot());
  }
  snapshot() {
    return { ...this.state, events: this.state.events.slice(-100), runtime: this.runtime?.snapshot?.() ?? this.state.lastRuntimeSnapshot };
  }
  async readJournal() {
    await this.loadModules();
    const journal = new this.classes.TradeJournal(new this.classes.FileJournalStorage(this.journalPath));
    const events = await journal.readEvents();
    const closed = events.filter(row => row.kind === 'spot_trade_closed').slice(-100).reverse();
    const positions = new Map();
    for (const row of events) {
      if (row.kind === 'spot_position_open') positions.set(row.clientOrderId, row);
      if (row.kind === 'spot_trade_closed') positions.delete(row.entryClientOrderId);
    }
    return { closed, openLots: [...positions.values()] };
  }
  createClient(config, credentials) {
    const client = new this.classes.OkxExecutionClient({ environment: 'demo', restBaseUrl: config.restBaseUrl, credentials });
    if (client.configuredEnvironment !== 'demo') throw new Error('安全检查失败：拒绝非模拟盘环境。');
    return client;
  }
  async preflight(input, { duringStart = false } = {}) {
    if (this.state.status === 'running' || (this.state.status === 'starting' && !duringStart)) throw new Error('运行中的模拟盘不可重新预检。');
    const config = normalizeConfig(input);
    const credentials = await this.credentialStore.load();
    if (!credentials) throw new Error('尚未配置模拟盘凭据。请创建 OKX 模拟盘 API Key，并只授予读取与交易权限。');
    await this.loadModules();
    const client = this.createClient(config, credentials);
    const instrument = await new this.classes.OkxPublicInstrumentClient(config.restBaseUrl).getSpotInstrument(config.instId);
    if (instrument.quoteCcy !== 'USDT') throw new Error('交易对计价币不是 USDT；模拟盘保持停止。');
    const journal = new this.classes.TradeJournal(new this.classes.FileJournalStorage(this.journalPath));
    const coordinator = new this.classes.OkxOrderCoordinator(client, journal);
    const snapshot = await coordinator.assertSafeSpotStartup(instrument.instId, instrument.baseCcy, instrument.quoteCcy);
    if (snapshot.quoteAvailable < Number(config.quoteBudget)) throw new Error('模拟账户可用 USDT 余额低于本次预算。');
    const result = {
      environment: 'demo', instId: instrument.instId, quoteCcy: instrument.quoteCcy,
      quoteAvailable: snapshot.quoteAvailable, quoteEquity: snapshot.quoteEquity,
      budget: Number(config.quoteBudget), baseCurrencyFlat: true, noPendingOrders: true,
      unresolvedLocalOrders: false, orderSubmission: 'none', checkedAt: this.now().toISOString(),
    };
    this.client = client; this.journal = journal; this.coordinator = coordinator;
    this.state = { ...this.state, status: 'ready', config, preflight: result, lastError: null };
    this.pushEvent(`预检通过：${instrument.instId} 模拟现货账户无该币种余额、无挂单、无本地未决委托；未提交订单。`);
    return result;
  }
  async start(input) {
    if (this.runtime || ['running', 'starting'].includes(this.state.status)) throw new Error('已有 OKX 模拟盘会话运行中。');
    const config = normalizeConfig(input);
    this.state = { ...this.state, status: 'starting', config, lastError: null };
    this.pushEvent('启动前再次核验模拟账户、可用余额、挂单与本地账本。');
    try {
      await this.preflight(config, { duringStart: true });
      const credentials = await this.credentialStore.load();
      const client = this.createClient(config, credentials);
      const instrument = await new this.classes.OkxPublicInstrumentClient(config.restBaseUrl).getSpotInstrument(config.instId);
      const journal = new this.classes.TradeJournal(new this.classes.FileJournalStorage(this.journalPath));
      const coordinator = new this.classes.OkxOrderCoordinator(client, journal);
      this.client = client; this.journal = journal; this.coordinator = coordinator;
      this.state.lastRuntimeSnapshot = null;
      this.runtime = new this.classes.DemoSpotRuntime({
        endpoint: config.endpoint,
        instId: config.instId,
        instrument,
        client,
        coordinator,
        journal,
        quoteBudget: config.quoteBudget,
        slippagePct: '0.005',
        stopLossBps: config.stopLossBps,
        takeProfitBps: config.takeProfitBps,
        lookbackTicks: 5,
        entryThresholdBps: 8,
        riskLimits: {
          maxOrderNotionalUsd: Number(config.quoteBudget),
          maxPositionNotionalUsd: Number(config.quoteBudget),
          dailyLossLimitUsd: Math.max(1, Math.min(25, Number(config.quoteBudget))),
          maxOrdersPerMinute: 4,
          maxSpreadBps: 20,
          orderCooldownMs: 10_000,
          maxMarketAgeMs: 2_000,
        },
        onStatus: message => {
          if (/^market-data disconnected/.test(message)) this.state.status = 'disconnected';
          else if (/runtime is fail-stopped/.test(message)) this.state.status = 'halted';
          else if (/^Demo SPOT connected/.test(message)) this.state.status = 'running';
          this.pushEvent(message);
        },
      });
      await this.runtime.start();
      const runtimeStatus = this.runtime.snapshot().status;
      this.state.status = runtimeStatus === 'running' ? 'running' : runtimeStatus === 'halted' ? 'halted' : 'disconnected';
      this.state.config = config;
      this.emit('state', this.snapshot());
      return this.snapshot();
    } catch (error) {
      this.runtime?.stop(); this.runtime = null;
      this.state.status = 'error'; this.state.lastError = error instanceof Error ? error.message : '模拟盘启动失败。';
      this.pushEvent(`启动失败，未继续自动重试：${this.state.lastError}`);
      throw error;
    }
  }
  stop() {
    if (this.runtime) {
      this.runtime.stop();
      this.state.lastRuntimeSnapshot = this.runtime.snapshot?.() ?? null;
    }
    this.runtime = null;
    if (['running', 'starting', 'disconnected', 'halted'].includes(this.state.status)) this.state.status = 'stopped';
    this.pushEvent('模拟盘会话已停止。若账户仍有资产，需人工检查；停止后本机止损/止盈监控也停止。');
    return this.snapshot();
  }
}

module.exports = { DEFAULT_CONFIG, normalizeConfig, EncryptedCredentialStore, OkxDemoBridge };
