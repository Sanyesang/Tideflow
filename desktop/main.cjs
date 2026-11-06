const { app, BrowserWindow, Menu, ipcMain, dialog, session, shell, safeStorage } = require('electron');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const { RuntimeBridge } = require('./runtime-bridge.cjs');
const { EncryptedCredentialStore, OkxDemoBridge } = require('./okx-demo-bridge.cjs');
let window, server, bridge, demoBridge, base, inviteCode, authTimer;
const root = app.isPackaged ? path.join(__dirname, 'bundle') : path.join(__dirname, '..');
const port = 4188;
app.setName('潮序 Tideflow');
app.disableHardwareAcceleration();
app.setAppUserModelId('com.tideflow.workbench');
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(launch).catch(error => { dialog.showErrorBox('潮序启动失败', error.message); app.quit(); });
}
async function authenticate() {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ inviteCode }) });
  if (!response.ok) throw new Error(`本机工作台会话创建失败（${response.status}）。`);
  const header = response.headers.get('set-cookie');
  const match = /^tideflow_session=([^;]+)/.exec(header || '');
  if (!match) throw new Error('本机会话响应缺少必要 Cookie。');
  await session.defaultSession.cookies.set({ url: base, name: 'tideflow_session', value: match[1], httpOnly: true, sameSite: 'strict', expirationDate: Date.now() / 1000 + 43200 });
}
function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== base) throw new Error('拒绝非工作台页面的桌面操作。');
}
async function launch() {
  app.setAccessibilitySupportEnabled(true);
  const log = message => syncFs.appendFileSync(path.join(app.getPath('userData'), 'desktop-startup.log'), `${new Date().toISOString()} ${message}\n`);
  const { createWorkbenchServer } = await import(pathToFileURL(path.join(root, 'scripts/serve-workbench.mjs')).href);
  inviteCode = randomBytes(24).toString('base64url');
  server = createWorkbenchServer({ inviteCodes: inviteCode });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${port}`;
  const userData = app.getPath('userData');
  bridge = new RuntimeBridge({ root, dataDirectory: path.join(userData, 'research-data') });
  const demoDataDirectory = path.join(userData, 'okx-demo');
  demoBridge = new OkxDemoBridge({
    root,
    dataDirectory: demoDataDirectory,
    credentialStore: new EncryptedCredentialStore(path.join(demoDataDirectory, 'credentials.bin'), safeStorage),
  });
  await authenticate();
  authTimer = setInterval(() => { authenticate().catch(error => dialog.showErrorBox('本机会话刷新失败', error.message)); }, 3600000);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 1000, minHeight: 720, backgroundColor: '#10171c', title: '潮序 Tideflow · 桌面研究工作台', icon: path.join(__dirname, 'assets/tideflow.ico'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ label: '打开研究数据目录', click: () => shell.openPath(path.join(app.getPath('userData'), 'research-data')) }, { type: 'separator' }, { role: 'quit', label: '退出潮序' }] },
    { label: '视图', submenu: [{ role: 'reload', label: '重新加载工作台' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
    { label: '帮助', submenu: [{ label: '关于潮序', click: () => dialog.showMessageBox(window, { title: '关于潮序', message: `潮序 Tideflow ${app.getVersion()}`, detail: '桌面研究版：CSV 历史回测、本地纸面交易与 OKX 模拟盘现货实验。\n模拟盘功能不会连接实盘账户；不构成收益承诺。' }) }] },
  ]));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== base) event.preventDefault(); });
  window.webContents.on('did-fail-load', (_event, code, description) => { if (code !== -3) dialog.showErrorBox('工作台加载失败', description); });
  window.webContents.on('did-finish-load', () => log(`page-loaded ${window.webContents.getURL()}`));
  window.webContents.on('render-process-gone', (_event, details) => log(`renderer-gone ${details.reason} ${details.exitCode}`));
  window.webContents.on('preload-error', (_event, _path, error) => log(`preload-error ${error.message}`));
  window.webContents.on('console-message', (_event, ...args) => { const detail = args[0]; if (typeof detail === 'object') { if (detail.level === 'error' || detail.level === 3) log(`console-error ${detail.message}`); } else if (detail === 3) log(`console-error ${args[1]}`); });
  bridge.on('state', state => { if (window && !window.isDestroyed()) window.webContents.send('tideflow:state', state); });
  demoBridge.on('state', state => { if (window && !window.isDestroyed()) window.webContents.send('tideflow:demo-state', state); });
  const handle = (name, callback) => ipcMain.handle(name, async (event, ...args) => { trusted(event); try { return { ok: true, value: await callback(...args) }; } catch (error) { return { ok: false, error: error.message }; } });
  handle('tideflow:snapshot', () => bridge.snapshot());
  handle('tideflow:paper-start', config => bridge.start(config));
  handle('tideflow:paper-stop', () => bridge.stop());
  handle('tideflow:demo-credential-status', () => demoBridge.credentialStore.status());
  handle('tideflow:demo-credentials-save', async credentials => {
    if (['running', 'starting'].includes(demoBridge.state.status)) throw new Error('模拟盘运行中，不能更换凭据。');
    return demoBridge.credentialStore.save(credentials);
  });
  handle('tideflow:demo-credentials-clear', async () => {
    if (['running', 'starting'].includes(demoBridge.state.status)) throw new Error('模拟盘运行中，不能清除凭据。');
    return demoBridge.credentialStore.clear();
  });
  handle('tideflow:demo-preflight', config => demoBridge.preflight(config));
  handle('tideflow:demo-start', config => demoBridge.start(config));
  handle('tideflow:demo-stop', () => demoBridge.stop());
  handle('tideflow:demo-snapshot', () => demoBridge.snapshot());
  handle('tideflow:demo-journal', () => demoBridge.readJournal());
  handle('tideflow:demo-open-data', async () => { const error = await shell.openPath(demoDataDirectory); if (error) throw new Error(error); return true; });
  handle('tideflow:open-data', async () => { const error = await shell.openPath(bridge.dataDirectory); if (error) throw new Error(error); return true; });
  handle('tideflow:export-report', async () => {
    const result = await dialog.showSaveDialog(window, { title: '导出纸面交易报告', defaultPath: `潮序-纸面交易-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON 报告', extensions: ['json'] }] });
    if (result.canceled) return false;
    await fs.writeFile(result.filePath, JSON.stringify({ ...bridge.snapshot(), trades: bridge.state.trades }, null, 2), { encoding: 'utf8' }); return true;
  });
  window.on('close', event => {
    const paperActive = ['running', 'connecting'].includes(bridge.state.status);
    const demoActive = ['running', 'starting', 'disconnected', 'halted'].includes(demoBridge.state.status);
    if (paperActive || demoActive) {
      const demoSnapshot = demoBridge.snapshot();
      const demoPosition = demoSnapshot.runtime?.position || demoSnapshot.runtime?.pendingOrder;
      const detail = demoActive
        ? `退出会停止本机策略监控。${demoPosition ? '当前可能有模拟盘持仓或未决委托；程序退出后本机止盈止损监控停止，请先核对账户。' : '模拟盘会话将停止；没有自动平仓。'}\n本机模拟盘记录保存在 ${demoDataDirectory}。`
        : '退出会停止本机纸面交易运行；纸面未平仓不会被伪造为平仓。';
      const choice = dialog.showMessageBoxSync(window, { type: 'warning', title: '停止运行中的会话？', message: '退出会停止当前本机交易监控。', detail, buttons: ['继续运行', '停止并退出'], defaultId: 0, cancelId: 0 });
      if (choice === 0) { event.preventDefault(); return; }
      if (paperActive) bridge.stop();
      if (demoActive) demoBridge.stop();
    }
  });
  await window.loadURL(base);
}
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  clearInterval(authTimer);
  if (bridge && ['running', 'connecting'].includes(bridge.state.status)) bridge.stop();
  if (demoBridge && ['running', 'starting', 'disconnected', 'halted'].includes(demoBridge.state.status)) demoBridge.stop();
  server?.close();
});
