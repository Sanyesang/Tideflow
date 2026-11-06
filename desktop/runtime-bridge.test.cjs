const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeBridge } = require('./runtime-bridge.cjs');
test('historical results have every statically referenced DOM target', () => {
  const source = fs.readFileSync(path.join(__dirname, '../workbench/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../workbench/index.html'), 'utf8');
  const ids = [...source.matchAll(/\$\("#(history-[\w-]+)"\)/g)].map(match => match[1]);
  for (const id of new Set(ids)) assert.ok(html.includes(`id="${id}"`), `Missing historical UI target: ${id}`);
});
class Socket {
  constructor(open = true) { this.readyState = 0; this.listeners = new Map(); this.sent = []; if (open) queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); }); }
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
  emit(type, event) { for (const callback of this.listeners.get(type) || []) callback(event); }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; queueMicrotask(() => this.emit('close', { code: 1000, reason: 'test close' })); }
  tick(price) { this.emit('message', { data: JSON.stringify({ arg: { channel: 'tickers' }, data: [{ instId: 'BTC-USDT', last: String(price), bidPx: String(price - .1), askPx: String(price + .1), ts: String(Date.now()) }] }) }); }
}
function fixture(context, open = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tideflow-bridge-test-'));
  let socket;
  const bridge = new RuntimeBridge({ root: path.resolve(__dirname, '..'), dataDirectory: directory, timeoutMs: 40, webSocketFactory: () => (socket = new Socket(open)) });
  context.after(() => { bridge.stop(); if (!directory.startsWith(path.join(os.tmpdir(), 'tideflow-bridge-test-'))) throw new Error('Unexpected test directory.'); fs.rmSync(directory, { recursive: true }); });
  return { bridge, directory, socket: () => socket };
}
const config = { endpoint: 'wss://example.invalid/ws/v5/public', asset: 'BTC-USDT', riskScore: 42 };
test('real paper engine subscribes, generates trades, persists reports and restores them', async context => {
  const f = fixture(context); await f.bridge.start(config);
  assert.equal(f.bridge.snapshot().status, 'running');
  assert.equal(JSON.parse(f.socket().sent[0]).args[0].instId, 'BTC-USDT');
  for (let i = 0; i < 25; i++) f.socket().tick(10000 + i * 20);
  assert.ok(f.bridge.snapshot().metrics.closedTrades > 0);
  const stopped = f.bridge.stop(); assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.lastReport); assert.equal(stopped.metrics.closedTrades, stopped.lastReport.closedTradeCount);
  const restored = new RuntimeBridge({ root: path.resolve(__dirname, '..'), dataDirectory: f.directory });
  assert.equal(restored.snapshot().metrics.netPnlUsd, stopped.metrics.netPnlUsd);
  const history = fs.readFileSync(path.join(f.directory, 'paper-history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(history.some(row => row.type === 'closed_trade')); assert.equal(history.filter(row => row.type === 'session_report').length, 1);
});
test('stop retains an open paper position rather than creating a closing trade', async context => {
  const f = fixture(context); await f.bridge.start(config);
  for (let i = 0; i < 13; i++) f.socket().tick(10000 + i * 20);
  assert.equal(f.bridge.snapshot().positionOpen, true);
  const result = f.bridge.stop(); assert.ok(result.lastReport.openPosition);
  assert.equal(result.metrics.closedTrades, 0);
});
test('rejects endpoints with credentials and duplicate starts before connecting', async context => {
  const f = fixture(context);
  await assert.rejects(f.bridge.start({ ...config, endpoint: 'wss://user:secret@example.invalid/private' }));
  const first = f.bridge.start(config);
  await assert.rejects(f.bridge.start(config), /已有/); await first;
});
test('connection timeout stops transport and reports an error without any simulated fills', async context => {
  const f = fixture(context, false);
  await assert.rejects(f.bridge.start(config), /超时/);
  assert.equal(f.bridge.snapshot().status, 'error'); assert.equal(f.bridge.snapshot().metrics.closedTrades, 0);
});
test('stop during startup cancels the request and does not resurrect the session', async context => {
  const f = fixture(context, false); const pending = f.bridge.start(config);
  f.bridge.stop(); await pending;
  assert.equal(f.bridge.snapshot().status, 'stopped'); assert.equal(f.bridge.snapshot().metrics.closedTrades, 0);
});
