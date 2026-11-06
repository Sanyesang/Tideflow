const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EncryptedCredentialStore, OkxDemoBridge, normalizeConfig } = require('./okx-demo-bridge.cjs');

test('OKX demo config accepts explicit 443 endpoints and rejects unsafe endpoints or budgets', () => {
  const value = normalizeConfig({});
  assert.equal(value.restBaseUrl, 'https://www.okx.com');
  assert.equal(value.endpoint, 'wss://wspap.okx.com/ws/v5/public');
  assert.equal(value.quoteBudget, '25');
  assert.throws(() => normalizeConfig({ endpoint: 'wss://wspap.okx.com:8443/ws/v5/public' }), /443/);
  assert.throws(() => normalizeConfig({ endpoint: 'wss://user:pass@wspap.okx.com/ws/v5/public' }), /OKX 官方/);
  assert.throws(() => normalizeConfig({ endpoint: 'wss://wspap.okx.com/ws/v5/private' }), /public/);
  assert.throws(() => normalizeConfig({ endpoint: 'wss://attacker.example/ws/v5/public' }), /OKX 官方/);
  assert.throws(() => normalizeConfig({ restBaseUrl: 'https://okx.com.attacker.example' }), /OKX 官方/);
  assert.doesNotThrow(() => normalizeConfig({ restBaseUrl: 'https://us.okx.com', endpoint: 'wss://wsuspap.okx.com/ws/v5/public' }));
  assert.throws(() => normalizeConfig({ restBaseUrl: 'http://www.okx.com' }), /HTTPS/);
  assert.throws(() => normalizeConfig({ quoteBudget: '999' }), /1–500/);
});

test('credential store encrypts before writing and fails closed if OS encryption is unavailable', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tideflow-credential-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'credentials.bin');
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async text => Buffer.from(`cipher:${text}`),
    decryptStringAsync: async bytes => ({ result: bytes.toString().slice('cipher:'.length) }),
  };
  const store = new EncryptedCredentialStore(file, safeStorage);
  await store.save({ apiKey: 'example-api-key', secretKey: 'example-secret-key', passphrase: 'example-passphrase' });
  const onDisk = await fs.readFile(file, 'utf8');
  assert.equal(onDisk.includes('example-api-key'), false);
  assert.equal(onDisk.includes('example-secret-key'), false);
  assert.deepEqual(await store.load(), { apiKey: 'example-api-key', secretKey: 'example-secret-key', passphrase: 'example-passphrase' });

  const unavailable = new EncryptedCredentialStore(path.join(directory, 'must-not-exist.bin'), {
    isAsyncEncryptionAvailable: async () => false,
  });
  await assert.rejects(unavailable.save({ apiKey: 'x', secretKey: 'y', passphrase: 'z' }), /不会降级为明文/);
  await assert.rejects(fs.access(path.join(directory, 'must-not-exist.bin')));
});

test('demo bridge pins demo mode, preflights without orders, starts and preserves exposure snapshot on stop', async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tideflow-demo-bridge-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = { orderWrites: 0, runtime: null };
  class OkxExecutionClient {
    constructor(options) { calls.environment = options.environment; this.configuredEnvironment = options.environment; }
  }
  class OkxPublicInstrumentClient {
    async getSpotInstrument(instId) { return { instId, baseCcy: 'BTC', quoteCcy: 'USDT', lotSz: '0.00001', minSz: '0.00001', tickSz: '0.1', state: 'live' }; }
  }
  class TradeJournal {
    constructor() {}
    async readEvents() { return []; }
  }
  class FileJournalStorage { constructor(file) { this.file = file; } }
  class OkxOrderCoordinator {
    constructor(client) { this.client = client; }
    async assertSafeSpotStartup() { return { quoteAvailable: 100, quoteEquity: 100 }; }
  }
  class DemoSpotRuntime {
    constructor(options) { this.options = options; calls.runtime = this; this.isRunning = false; }
    async start() { this.isRunning = true; this.options.onStatus('Demo SPOT connected for BTC-USDT.'); }
    stop() { this.isRunning = false; }
    snapshot() { return { status: this.isRunning ? 'running' : 'stopped', position: { quantity: 0.01, entryPrice: 50000, stopPrice: 49825, takeProfitPrice: 50250 }, pendingOrder: null }; }
  }
  const names = ['adapters/okx_execution.js', 'adapters/okx_instruments.js', 'execution/order_coordinator.js', 'persistence/trade_journal.js', 'runtime/demo_spot_runtime.js'];
  const modules = Object.fromEntries(names.map(name => [name, {}]));
  Object.assign(modules[names[0]], { OkxExecutionClient });
  Object.assign(modules[names[1]], { OkxPublicInstrumentClient });
  Object.assign(modules[names[2]], { OkxOrderCoordinator });
  Object.assign(modules[names[3]], { TradeJournal, FileJournalStorage });
  Object.assign(modules[names[4]], { DemoSpotRuntime });
  const credentialStore = { load: async () => ({ apiKey: 'test-key', secretKey: 'test-secret', passphrase: 'test-passphrase' }) };
  const bridge = new OkxDemoBridge({ root: directory, dataDirectory: directory, credentialStore, modules });
  const preflight = await bridge.preflight({});
  assert.equal(preflight.environment, 'demo');
  assert.equal(preflight.orderSubmission, 'none');
  assert.equal(calls.environment, 'demo');
  assert.equal(calls.orderWrites, 0);
  const started = await bridge.start({});
  assert.equal(started.status, 'running');
  assert.equal(calls.runtime.options.slippagePct, '0.005');
  const stopped = bridge.stop();
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.runtime.position.quantity, 0.01);
  assert.equal(calls.orderWrites, 0);
});
