const desktop = window.tideflowDesktop;
if (desktop) {
  const panel = document.createElement('section');
  panel.id = 'desktop-runtime'; panel.className = 'panel desktop-runtime';
  panel.innerHTML = `<div class="panel-heading"><div><div class="panel-kicker">DESKTOP ENGINE / PAPER</div><h2>公开行情 · 本地纸面交易</h2></div><span class="desktop-status" id="desktop-status">待连接</span></div>
    <p class="desktop-intro">订阅交易所公开行情，由本机动量策略连续判断和模拟成交。无需交易密钥，成交与报告保存在本机。</p>
    <form id="desktop-paper-form"><div class="desktop-fields"><label class="endpoint-field">公开行情 WebSocket 地址<input id="desktop-endpoint" type="url" placeholder="wss://账户区域对应的公开行情地址" required autocomplete="off" spellcheck="false" /></label><label>交易标的<select id="desktop-asset"><option>BTC-USDT</option><option>ETH-USDT</option><option>SOL-USDT</option></select></label><label>风险指数<input id="desktop-risk" type="number" min="0" max="100" step="1" value="42" required /></label></div>
    <div class="desktop-actions"><button class="primary-button" id="desktop-start" type="submit">连接行情并启动纸面交易</button><button class="quiet-button" id="desktop-stop" type="button" disabled>停止会话</button><button class="text-button" id="desktop-export" type="button">导出报告 ↗</button><button class="text-button" id="desktop-open-data" type="button">打开数据目录 ↗</button></div></form>
    <p class="desktop-note">使用该账户区域的公开行情地址和 443 端口。策略：动量；模拟资金：1,000 USDT；手续费：每边 5 bps；滑点：每边 1 bps。下方离线样本和 CSV 回测为独立研究区。</p>
    <p class="desktop-error" id="desktop-error" role="alert" hidden></p>
    <div class="desktop-metrics"><div><span>最新行情</span><strong id="desktop-price">—</strong><small id="desktop-price-age">尚未收到行情</small></div><div><span>本会话已平仓净盈亏</span><strong id="desktop-pnl">—</strong><small id="desktop-count">0 笔平仓</small></div><div><span>本会话胜率 / 盈亏因子</span><strong id="desktop-winrate">—</strong><small id="desktop-pf">—</small></div><div><span>纸面持仓</span><strong id="desktop-position">—</strong><small id="desktop-equity">停止后生成权益报告</small></div></div>
    <div class="desktop-results"><div><h3>运行事件</h3><ol id="desktop-events"><li>等待启动公开行情会话。</li></ol></div><div><h3>最近纸面平仓 <small>最多显示100笔，完整数据见报告与日志</small></h3><div class="table-scroll"><table class="trade-table"><thead><tr><th>时间</th><th>方向</th><th>价格</th><th>净盈亏</th></tr></thead><tbody id="desktop-trades"><tr><td colspan="4">尚无纸面成交。</td></tr></tbody></table></div></div></div>`;
  document.querySelector('.page-heading').after(panel);
  document.querySelector('.page-heading p').textContent = '桌面研究工作台：公开行情纸面交易、历史 CSV 回测与离线策略实验。';
  document.querySelector('.sidebar-note span').textContent = '桌面研究版';
  document.querySelector('.user-copy strong').textContent = '本机用户';
  document.querySelector('.user-copy span').textContent = '桌面研究工作台';
  document.querySelector('#logout-button').style.display = 'none';
  document.querySelector('.top-avatar').textContent = '潮';
  document.querySelector('.demo-pill').innerHTML = '<i></i> RESEARCH · 本地研究';
  document.querySelector('.workspace-footer').innerHTML = '<span>潮序 TIDEFLOW · DESKTOP 0.4.0</span><span>公开行情纸面交易 · OKX 模拟盘 · CSV 回测</span>';
  document.querySelector('#run-simulation').innerHTML = '<span class="button-icon">▶</span><span>离线样本回放</span>';
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/desktop-runtime.css'; document.head.append(style);
  const byId = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const format = value => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—';
  let state, pending = false;
  const messages = { idle: '待连接', connecting: '连接中', running: '公开行情运行中', stopped: '已停止', disconnected: '连接断开，已停止', error: '连接失败', interrupted: '上次运行已中断' };
  function showError(error) { byId('desktop-error').textContent = error || ''; byId('desktop-error').hidden = !error; }
  async function call(action) { const result = await action; if (!result.ok) throw new Error(result.error); return result.value; }
  function render(next) {
    state = next; const active = ['running', 'connecting'].includes(state.status);
    byId('desktop-status').textContent = messages[state.status] || state.status;
    byId('desktop-status').classList.toggle('connected', state.status === 'running');
    byId('desktop-start').disabled = active || pending; byId('desktop-stop').disabled = !active;
    for (const id of ['desktop-endpoint', 'desktop-asset', 'desktop-risk']) byId(id).disabled = active;
    const m = state.metrics;
    byId('desktop-price').textContent = format(state.ticker?.last);
    byId('desktop-pnl').textContent = `${m.netPnlUsd >= 0 ? '+' : ''}${m.netPnlUsd.toFixed(4)} USDT`;
    byId('desktop-pnl').className = m.netPnlUsd < 0 ? 'negative' : 'positive';
    byId('desktop-count').textContent = `${m.closedTrades} 笔平仓 · 已平仓手续费 ${m.closedTradeFeesUsd.toFixed(4)} USDT`;
    byId('desktop-winrate').textContent = `${m.winRatePct.toFixed(1)}%`;
    byId('desktop-pf').textContent = `盈亏因子 ${typeof m.profitFactor === 'number' ? m.profitFactor.toFixed(2) : m.profitFactor ?? '—'}`;
    byId('desktop-position').textContent = state.positionOpen ? '持仓中（纸面）' : '无纸面持仓';
    const report = state.lastReport;
    byId('desktop-equity').textContent = report ? `期末权益 ${report.endingEquityUsd.toFixed(4)} · 未实现 ${report.unrealizedGrossPnlUsd.toFixed(4)} USDT` : '停止后生成权益报告';
    if (report?.openPosition) byId('desktop-position').textContent = `${report.openPosition.side === 'long' ? '多' : '空'} ${format(report.openPosition.quantity)} · 未平仓`;
    byId('desktop-events').innerHTML = state.events.slice(-12).reverse().map(e => `<li><time>${escape(new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false }))}</time>${escape(e.message)}</li>`).join('') || '<li>等待启动公开行情会话。</li>';
    byId('desktop-trades').innerHTML = [...state.trades].reverse().map(t => `<tr><td>${escape(new Date(t.exitAtMs).toLocaleTimeString('zh-CN', { hour12: false }))}</td><td>${t.side === 'long' ? '做多' : '做空'}</td><td>${format(t.entryPrice)} → ${format(t.exitPrice)}</td><td class="${t.netPnlUsd < 0 ? 'negative' : 'positive'}">${t.netPnlUsd.toFixed(4)}</td></tr>`).join('') || '<tr><td colspan="4">尚无纸面成交。</td></tr>';
    updateAge();
  }
  function updateAge() {
    if (!state?.ticker) return;
    const age = Math.max(0, Date.now() - state.ticker.exchangeTimestampMs);
    byId('desktop-price-age').textContent = `${state.config.asset} · ${age < 5000 ? `${(age / 1000).toFixed(1)} 秒前` : '行情已过期'}${state.status !== 'running' ? ' · 会话已停止' : ''}`;
  }
  byId('desktop-paper-form').addEventListener('submit', async event => {
    event.preventDefault(); showError(''); pending = true; byId('desktop-start').disabled = true;
    try { render(await call(desktop.startPaper({ endpoint: byId('desktop-endpoint').value.trim(), asset: byId('desktop-asset').value, riskScore: Number(byId('desktop-risk').value) }))); }
    catch (error) { showError(error.message); }
    finally { pending = false; if (state) render(state); else byId('desktop-start').disabled = false; }
  });
  byId('desktop-stop').addEventListener('click', async () => { try { render(await call(desktop.stopPaper())); } catch (error) { showError(error.message); } });
  byId('desktop-export').addEventListener('click', async () => { try { await call(desktop.exportReport()); } catch (error) { showError(error.message); } });
  byId('desktop-open-data').addEventListener('click', async () => { try { await call(desktop.openData()); } catch (error) { showError(error.message); } });
  desktop.onState(render);
  call(desktop.snapshot()).then(snapshot => {
    if (snapshot.config) { byId('desktop-endpoint').value = snapshot.config.endpoint; byId('desktop-asset').value = snapshot.config.asset; byId('desktop-risk').value = snapshot.config.riskScore; }
    render(snapshot);
  }).catch(error => showError(error.message));
  setInterval(updateAge, 1000);
}
