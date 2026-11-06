const desktop = window.tideflowDesktop;
if (desktop) {
  const page = document.querySelector('#page-okx-demo .route-content');
  page.innerHTML = `<section class="panel demo-hero">
      <div><div class="panel-kicker">EXCHANGE SANDBOX / OKX</div><h2>OKX 模拟盘 · 现货策略</h2><p>仅使用 OKX 模拟交易接口。单标的、USDT 现货、只做多；策略信号会自动提交模拟市价单。</p></div>
      <span class="demo-badge">DEMO ONLY · 不接实盘</span>
    </section>
    <div class="demo-grid">
      <section class="panel demo-setup">
        <div class="demo-section-title"><div><div class="panel-kicker">01 / ACCESS</div><h3>账户与 API 配置</h3></div><span id="demo-credential-state" class="demo-state">读取中</span></div>
        <p class="demo-help">在 OKX 的“模拟交易”中创建 API Key。权限只需“读取 + 交易”，不要开启提币权限；这里的凭据只由 Windows 系统加密后保存在本机。</p>
        <div class="demo-form-grid">
          <label>REST API 域名<input id="demo-rest-url" type="url" value="https://www.okx.com" spellcheck="false" autocomplete="off"></label>
          <label>模拟盘公开行情 WebSocket<input id="demo-ws-url" type="url" value="wss://wspap.okx.com/ws/v5/public" spellcheck="false" autocomplete="off"></label>
          <label>模拟盘 API Key<input id="demo-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="仅模拟盘 Key"></label>
          <label>Secret<input id="demo-secret-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="仅在保存时短暂提交"></label>
          <label>Passphrase<input id="demo-passphrase" type="password" autocomplete="new-password" spellcheck="false" placeholder="仅在保存时短暂提交"></label>
        </div>
        <div class="demo-actions"><button class="quiet-button" id="demo-save-credentials" type="button">加密保存凭据</button><button class="text-button" id="demo-clear-credentials" type="button">清除本机凭据</button></div>
        <p class="demo-help">默认填入 OKX 全球站示例地址。账户若注册在其他站点，请按 OKX 官方 API 文档修改 REST 与模拟盘 WebSocket 域名；使用 443 端口，不要填入 :8443。</p>
      </section>
      <section class="panel demo-setup">
        <div class="demo-section-title"><div><div class="panel-kicker">02 / GUARDRAILS</div><h3>策略与预算</h3></div><span class="demo-state">启动前强制预检</span></div>
        <div class="demo-form-grid demo-controls">
          <label>交易标的<select id="demo-inst-id"><option>BTC-USDT</option><option>ETH-USDT</option><option>SOL-USDT</option></select></label>
          <label>单次预算（USDT）<input id="demo-budget" type="number" min="1" max="500" step="0.1" value="25"></label>
          <label>止损距离（bps）<input id="demo-stop-bps" type="number" min="5" max="500" step="1" value="35"></label>
          <label>止盈距离（bps）<input id="demo-target-bps" type="number" min="5" max="1000" step="1" value="50"></label>
        </div>
        <div class="demo-actions demo-primary-actions"><button class="quiet-button" id="demo-preflight" type="button">只读账户预检</button><button class="primary-button" id="demo-start" type="button" disabled>启动 OKX 模拟盘</button><button class="quiet-button" id="demo-stop" type="button" disabled>停止策略</button></div>
        <div id="demo-preflight-result" class="demo-preflight-result" role="status">预检会读取账户模式、余额、该标的现货余额与挂单；不会下单。</div>
        <p class="demo-error" id="demo-error" role="alert" hidden></p>
      </section>
    </div>
    <section class="panel demo-live-panel">
      <div class="demo-section-title"><div><div class="panel-kicker">03 / LIVE SIMULATION STATE</div><h3>模拟盘实时状态</h3></div><span id="demo-runtime-status" class="demo-state">尚未连接</span></div>
      <div class="demo-metrics"><div><span>最新成交价</span><strong id="demo-last-price">—</strong><small id="demo-price-age">未连接行情</small></div><div><span>本次预算</span><strong id="demo-budget-view">—</strong><small>USDT · 单笔、单仓上限</small></div><div><span>已实现 P&amp;L 估算</span><strong id="demo-realized-pnl">—</strong><small>按报价余额差估算，可能未含所有费用</small></div><div><span>当前仓位</span><strong id="demo-position-view">无持仓</strong><small id="demo-protection-view">—</small></div></div>
      <div class="demo-risk-callout"><strong>运行边界</strong><span>止盈/止损由本机行情监控触发，不是交易所托管保护单。断网、关闭软件或电脑休眠时，自动监控停止；如账户发现已有币种余额或挂单，程序会拒绝自动启动。</span></div>
    </section>
    <div class="demo-grid">
      <section class="panel"><div class="demo-section-title"><div><div class="panel-kicker">AUDIT TRAIL</div><h3>运行事件</h3></div><button class="quiet-button" id="demo-open-data" type="button">打开本机记录目录</button></div><ol class="demo-events" id="demo-events"><li>尚无模拟盘运行记录。</li></ol></section>
      <section class="panel"><div class="demo-section-title"><div><div class="panel-kicker">LOCAL RECONCILIATION</div><h3>本机账本未平仓记录</h3></div><button class="quiet-button" id="demo-refresh-journal" type="button">刷新</button></div><div id="demo-open-lots"><p>暂无本机账本未平仓记录。</p></div><h3 class="demo-subheading">已完成模拟交易</h3><div class="table-scroll"><table class="route-table"><thead><tr><th>时间</th><th>标的</th><th>数量</th><th>入场 → 出场</th><th>报价差额 P&amp;L</th></tr></thead><tbody id="demo-trade-rows"><tr><td colspan="5">暂无已完成模拟交易。</td></tr></tbody></table></div></section>
    </div>`;
  const byId = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const formIds = ['demo-rest-url', 'demo-ws-url', 'demo-inst-id', 'demo-budget', 'demo-stop-bps', 'demo-target-bps'];
  const config = () => ({
    restBaseUrl: byId('demo-rest-url').value.trim(), endpoint: byId('demo-ws-url').value.trim(),
    instId: byId('demo-inst-id').value, quoteBudget: byId('demo-budget').value,
    stopLossBps: Number(byId('demo-stop-bps').value), takeProfitBps: Number(byId('demo-target-bps').value),
  });
  const configKey = value => JSON.stringify(value);
  const format = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—';
  let lastPreflightKey = '';
  let preflightReady = false;
  let state = null;
  let pending = false;
  function call(action) { return action.then(result => { if (!result.ok) throw new Error(result.error); return result.value; }); }
  function setError(message = '') { byId('demo-error').textContent = message; byId('demo-error').hidden = !message; }
  function persistConfig() { try { localStorage.setItem('tideflow.okx-demo.config.v1', JSON.stringify(config())); } catch {} }
  function invalidatePreflight() {
    preflightReady = false; lastPreflightKey = '';
    byId('demo-start').disabled = true;
    byId('demo-preflight-result').textContent = '配置已变化；请重新执行只读账户预检。';
    persistConfig();
  }
  function renderState(next) {
    if (!next) return;
    state = next;
    const runtime = state.runtime;
    const active = ['running', 'starting', 'disconnected', 'halted'].includes(state.status) || runtime?.status === 'running';
    const labels = { idle: '尚未连接', ready: '预检通过 · 待启动', starting: '启动中', running: '模拟盘运行中', disconnected: '行情断开 · 已停止监控', halted: '故障停机 · 待人工复核', stopped: '已停止', error: '启动失败' };
    byId('demo-runtime-status').textContent = labels[state.status] || state.status;
    byId('demo-runtime-status').classList.toggle('connected', state.status === 'running');
    byId('demo-start').disabled = active || pending || !preflightReady;
    byId('demo-preflight').disabled = active || pending;
    byId('demo-stop').disabled = !active;
    for (const id of formIds) byId(id).disabled = active;
    byId('demo-budget-view').textContent = state.config ? `${format(state.config.quoteBudget)} USDT` : '—';
    byId('demo-last-price').textContent = format(runtime?.ticker?.last);
    byId('demo-price-age').textContent = runtime?.ticker ? `${state.config?.instId || ''} · ${Math.max(0, (Date.now() - runtime.ticker.exchangeTimestampMs) / 1000).toFixed(1)} 秒前` : '未连接行情';
    const pnl = runtime?.realizedQuotePnl;
    byId('demo-realized-pnl').textContent = Number.isFinite(pnl) ? `${pnl >= 0 ? '+' : ''}${format(pnl)} USDT` : '—';
    byId('demo-realized-pnl').className = pnl < 0 ? 'negative' : 'positive';
    if (runtime?.position) {
      byId('demo-position-view').textContent = `${format(runtime.position.quantity)} ${state.config?.instId?.split('-')[0] || ''}`;
      byId('demo-protection-view').textContent = `入场 ${format(runtime.position.entryPrice)} · 止损 ${format(runtime.position.stopPrice)} · 止盈 ${format(runtime.position.takeProfitPrice)}`;
    } else if (runtime?.pendingOrder) {
      byId('demo-position-view').textContent = runtime.pendingOrder.purpose === 'open' ? '买单待核对' : '卖单待核对';
      byId('demo-protection-view').textContent = `委托 ${runtime.pendingOrder.clientOrderId} · 禁止自动重试`;
    } else {
      byId('demo-position-view').textContent = '无持仓';
      byId('demo-protection-view').textContent = state.status === 'running' ? '等待策略信号' : '未运行';
    }
    byId('demo-events').innerHTML = state.events?.length ? [...state.events].reverse().slice(0, 12).map(event => `<li><time>${escape(new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false }))}</time>${escape(event.message)}</li>`).join('') : '<li>尚无模拟盘运行记录。</li>';
  }
  async function refreshSnapshot() {
    try { renderState(await call(desktop.demoSnapshot())); }
    catch (error) { setError(error.message); }
  }
  async function refreshJournal() {
    try {
      const journal = await call(desktop.demoJournal());
      byId('demo-open-lots').innerHTML = journal.openLots.length ? `<ul class="demo-open-lots">${journal.openLots.map(row => `<li><strong>${escape(row.instId)}</strong><span>${escape(row.baseSize)} ${escape(row.instId.split('-')[0])}</span><span>入场 ${escape(row.entryPrice)} ${escape(row.quoteCcy)}</span><small>${escape(new Date(row.at).toLocaleString('zh-CN', { hour12: false }))} · 请先在 OKX 模拟账户核对，不要直接重启策略</small></li>`).join('')}</ul>` : '<p>暂无本机账本未平仓记录。若 OKX 账户仍有标的余额，启动预检会拦截，请人工核对。</p>';
      byId('demo-trade-rows').innerHTML = journal.closed.length ? journal.closed.map(row => `<tr><td>${escape(new Date(row.at).toLocaleString('zh-CN', { hour12: false }))}</td><td>${escape(row.instId)}</td><td>${escape(row.baseSize)}</td><td>${escape(row.entryPrice)} → ${escape(row.exitPrice)}</td><td class="${Number(row.realizedPnlQuote) < 0 ? 'negative' : 'positive'}">${Number(row.realizedPnlQuote) >= 0 ? '+' : ''}${escape(row.realizedPnlQuote)} ${escape(row.quoteCcy)}</td></tr>`).join('') : '<tr><td colspan="5">暂无已完成模拟交易。</td></tr>';
    } catch (error) { byId('demo-trade-rows').innerHTML = `<tr><td colspan="5">账本读取失败：${escape(error.message)}</td></tr>`; }
  }
  async function credentialStatus() {
    try {
      const status = await call(desktop.demoCredentialStatus());
      byId('demo-credential-state').textContent = status.configured ? 'Windows 加密凭据已保存' : '未配置模拟盘凭据';
      byId('demo-credential-state').classList.toggle('connected', status.configured);
    } catch (error) { byId('demo-credential-state').textContent = `加密存储不可用：${error.message}`; }
  }
  function clearCredentialInputs() { for (const id of ['demo-api-key', 'demo-secret-key', 'demo-passphrase']) byId(id).value = ''; }
  byId('demo-save-credentials').addEventListener('click', async () => {
    setError(''); pending = true;
    try {
      await call(desktop.saveDemoCredentials({ apiKey: byId('demo-api-key').value, secretKey: byId('demo-secret-key').value, passphrase: byId('demo-passphrase').value }));
      clearCredentialInputs(); await credentialStatus(); byId('demo-preflight-result').textContent = '凭据已使用 Windows 系统加密保存在本机。';
    } catch (error) { clearCredentialInputs(); setError(error.message); }
    finally { pending = false; if (state) renderState(state); }
  });
  byId('demo-clear-credentials').addEventListener('click', async () => {
    if (!window.confirm('确定移除本机保存的 OKX 模拟盘凭据？')) return;
    try { await call(desktop.clearDemoCredentials()); clearCredentialInputs(); preflightReady = false; lastPreflightKey = ''; await credentialStatus(); renderState(state); }
    catch (error) { setError(error.message); }
  });
  byId('demo-preflight').addEventListener('click', async () => {
    setError(''); pending = true; preflightReady = false; byId('demo-start').disabled = true;
    try {
      const settings = config(); const result = await call(desktop.preflightDemo(settings));
      lastPreflightKey = configKey(settings); preflightReady = true;
      byId('demo-preflight-result').textContent = `预检通过 · ${result.instId} · 可用 ${format(result.quoteAvailable)} USDT · 本次预算 ${format(result.budget)} USDT · ${new Date(result.checkedAt).toLocaleString('zh-CN', { hour12: false })}。没有下单。`;
      await refreshSnapshot(); await refreshJournal();
    } catch (error) { byId('demo-preflight-result').textContent = '预检未通过，启动保持关闭。'; setError(error.message); }
    finally { pending = false; byId('demo-start').disabled = !preflightReady; }
  });
  byId('demo-start').addEventListener('click', async () => {
    const settings = config();
    if (!preflightReady || lastPreflightKey !== configKey(settings)) { invalidatePreflight(); return; }
    if (!window.confirm(`启动 ${settings.instId} 的 OKX 模拟盘现货策略？\n\n单次预算 ${settings.quoteBudget} USDT，单笔和单仓上限相同。启动前会再次只读核验账户；策略信号将自动提交模拟市价单。止损/止盈依赖本机在线监控。`)) return;
    setError(''); pending = true;
    try { renderState(await call(desktop.startDemo(settings))); preflightReady = false; lastPreflightKey = ''; await refreshJournal(); }
    catch (error) { setError(error.message); await refreshSnapshot(); }
    finally { pending = false; if (state) renderState(state); }
  });
  byId('demo-stop').addEventListener('click', async () => {
    if (!window.confirm('停止本机行情监控与策略？若模拟账户仍有币种余额，停止不会替你卖出，且本机止损/止盈监控将结束。')) return;
    try { renderState(await call(desktop.stopDemo())); preflightReady = false; lastPreflightKey = ''; await refreshJournal(); }
    catch (error) { setError(error.message); }
  });
  byId('demo-refresh-journal').addEventListener('click', refreshJournal);
  byId('demo-open-data').addEventListener('click', async () => { try { await call(desktop.openDemoData()); } catch (error) { setError(error.message); } });
  for (const id of formIds) byId(id).addEventListener('input', invalidatePreflight);
  byId('demo-inst-id').addEventListener('change', invalidatePreflight);
  desktop.onDemoState(next => { renderState(next); refreshJournal(); });
  let savedConfig;
  try { savedConfig = JSON.parse(localStorage.getItem('tideflow.okx-demo.config.v1') || 'null'); } catch {}
  if (savedConfig && typeof savedConfig === 'object') {
    for (const id of formIds) {
      const key = { 'demo-rest-url': 'restBaseUrl', 'demo-ws-url': 'endpoint', 'demo-inst-id': 'instId', 'demo-budget': 'quoteBudget', 'demo-stop-bps': 'stopLossBps', 'demo-target-bps': 'takeProfitBps' }[id];
      if (savedConfig[key] !== undefined) byId(id).value = savedConfig[key];
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearCredentialInputs(); });
  const demoPage = page.closest('.workspace-page');
  new MutationObserver(() => { if (demoPage.hidden) clearCredentialInputs(); }).observe(demoPage, { attributes: true, attributeFilter: ['hidden'] });
  credentialStatus(); refreshSnapshot(); refreshJournal();
  setInterval(() => { if (!document.hidden) refreshSnapshot(); }, 1000);
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/okx-demo.css'; document.head.append(style);
}
