// UI-only routes. Existing controls are moved, never copied, preserving engine listeners.
const $ = selector => document.querySelector(selector);
const names = { overview: '总览', 'okx-demo': 'OKX 模拟盘', strategies: '策略实验室', journal: '交易日志', risk: '风险中心', announcements: '官方公告' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const wrap = $('.content-wrap');
if (window.tideflowDesktop) $('.workspace-footer span:first-child').textContent = '潮序 TIDEFLOW · DESKTOP 0.4.0';
const overview = document.createElement('section'); overview.id = 'page-overview'; overview.className = 'workspace-page';
for (const child of [...wrap.children]) if (!child.matches('.page-heading,.workspace-footer')) overview.append(child);
$('.page-heading').after(overview);
const routes = { overview };
for (const key of Object.keys(names).slice(1)) {
  const page = document.createElement('section'); page.id = `page-${key}`; page.className = 'workspace-page'; page.hidden = true;
  page.innerHTML = `<div class="route-intro"><h2>${names[key]}</h2><p id="${key}-intro"></p></div><div class="route-content"></div>`;
  wrap.insertBefore(page, $('.workspace-footer')); routes[key] = page;
}
const into = (page, selector) => routes[page].querySelector('.route-content').append($(selector));
$('#okx-demo-intro').textContent = '独立的 OKX 模拟盘现货执行区。先保存模拟盘 API 凭据并完成账户预检，确认后才启动；运行期间只允许 USDT 现货做多。';
$('#strategies-intro').textContent = '选择策略与参数，运行离线实验，或导入真实历史 K 线进行回测。公开行情纸面会话在总览中独立运行。';
const cards = document.createElement('div'); cards.className = 'strategy-catalog';
cards.innerHTML = [['momentum','01','脉冲动量','跟随短窗方向，按反向信号、止盈或止损退出。'],['breakout','02','区间突破','观察区间边界，突破达到门槛后进场。'],['mean-reversion','03','均值回归','围绕短窗均值进行反向进场和退出。']].map(([id,n,title,copy]) => `<button type="button" class="strategy-choice" data-strategy-choice="${id}" aria-pressed="false"><small>STRATEGY / ${n}</small><h3>${title}</h3><p>${copy}</p><span>选择此策略 →</span></button>`).join('');
routes.strategies.querySelector('.route-content').append(cards);
into('strategies', '.strategy-panel'); into('strategies', '.history-panel'); into('strategies', '.execution-panel');
const controls = document.createElement('div'); controls.className = 'route-actions';
controls.append($('#run-simulation'), $('#stop-simulation')); cards.after(controls);
controls.after($('.status-strip'));
const overviewAction = document.createElement('button'); overviewAction.className = 'primary-button'; overviewAction.dataset.route = 'strategies'; overviewAction.textContent = '进入策略实验室 →'; $('.heading-tools').append(overviewAction);
$('#risk-intro').textContent = '调整离线实验与 CSV 回测的风险参数；修改后需重新回测。总览中的公开行情纸面会话使用独立风险指数，不会被这里的调整静默修改。';
into('risk', '.risk-panel');
const riskDetails = document.createElement('article'); riskDetails.className = 'panel route-risk-details'; routes.risk.querySelector('.route-content').append(riskDetails);
function renderRisk() {
  riskDetails.innerHTML = `<h3>当前参数与适用范围</h3><dl><dt>离线 / CSV 风险指数</dt><dd>${escape($('#risk-value').textContent)} / 100</dd><dt>单笔名义上限</dt><dd>${escape($('#risk-order-cap').textContent)}</dd><dt>单轮亏损停止线</dt><dd>${escape($('#risk-daily-cap').textContent)}</dd><dt>入场门槛</dt><dd>${escape($('#risk-threshold').textContent)}</dd><dt>回放周期</dt><dd>${escape($('#frequency-select').selectedOptions[0].textContent)}</dd></dl><p>调整风险指数会改变仓位与退出参数，不能保证盈利。CSV 模型不涵盖资金费、排队成交、断线和强平。</p><button class="quiet-button" data-route="strategies">用这些参数回测 →</button>`;
}
$('#risk-slider').addEventListener('input', renderRisk); $('#frequency-select').addEventListener('change', renderRisk);
$('#journal-intro').textContent = '按来源区分离线合成回放与公开行情纸面记录。这里没有真实资金订单；CSV 回测结果保留在策略实验室。';
routes.journal.querySelector('.route-content').innerHTML = `<div class="journal-toolbar"><label>记录来源<select id="journal-source"><option value="offline">离线合成回放</option><option value="public">公开行情纸面会话（最近100笔）</option></select></label><label>标的筛选<select id="journal-asset"><option value="all">全部标的</option><option>BTC-USDT</option><option>ETH-USDT</option><option>SOL-USDT</option></select></label><button class="quiet-button" id="journal-export">导出当前列表 CSV</button><button class="quiet-button" id="journal-refresh">刷新记录</button></div><p id="journal-count" role="status"></p><article class="panel"><div class="table-scroll"><table class="route-table"><thead><tr><th>时间</th><th>标的 / 策略</th><th>方向</th><th>进场 → 出场</th><th>净盈亏</th></tr></thead><tbody id="route-journal-rows"></tbody></table></div></article><article class="panel"><h3>公开行情运行事件</h3><ol id="route-events"></ol><p>本页公开行情列表最多100笔，完整会话数据请在总览使用「导出报告」。</p><button class="text-button" data-route="overview">返回总览查看行情与完整报告 →</button></article>`;
let journalRows = [];
function renderJournal() {
  const source = $('#journal-source').value;
  let rows;
  if (source === 'offline') {
    try { rows = (JSON.parse(localStorage.getItem('tideflow.workbench.v1'))?.trades ?? []).map(t => [t.time, `${t.asset} / ${{momentum:'脉冲动量',breakout:'区间突破','mean-reversion':'均值回归'}[t.strategy] || t.strategy}`, t.direction === 'long' ? '做多' : '做空', `${t.entry} → ${t.exit}`, Number(t.pnl).toFixed(4)]); }
    catch (error) { $('#journal-count').textContent = `本地账本读取失败：${error.message}`; return; }
  } else {
    rows = [...document.querySelectorAll('#desktop-trades tr')].filter(tr => tr.cells.length === 4).map(tr => [tr.cells[0].textContent, $('#desktop-asset').value + ' / 动量', tr.cells[1].textContent, tr.cells[2].textContent, tr.cells[3].textContent]);
  }
  const asset = $('#journal-asset').value;
  journalRows = rows.filter(row => asset === 'all' || row[1].startsWith(asset));
  $('#journal-count').textContent = `${source === 'offline' ? '离线合成回放' : '公开行情纸面会话'} · ${journalRows.length} 笔匹配记录`;
  $('#route-journal-rows').innerHTML = journalRows.length ? journalRows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('') : '<tr><td colspan="5">当前来源没有匹配记录。运行对应实验后刷新查看。</td></tr>';
  $('#route-events').innerHTML = $('#desktop-events')?.innerHTML || '<li>此环境未连接桌面公开行情引擎。</li>';
}
for (const id of ['journal-source','journal-asset']) $(`#${id}`).addEventListener('change', renderJournal);
$('#journal-refresh').addEventListener('click', renderJournal);
$('#journal-export').addEventListener('click', () => {
  renderJournal(); const csv = [['时间','标的/策略','方向','进场→出场','净盈亏'], ...journalRows].map(row => row.map(value => `"${String(value).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF',csv], {type:'text/csv;charset=utf-8'})); const a = document.createElement('a'); a.href = url; a.download = '潮序-研究记录.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
});
$('#announcements-intro').textContent = '随安装包交付的本地版本说明。支持阅读状态和筛选；尚未接入远程公告发布或消息推送。';
routes.announcements.querySelector('.route-content').innerHTML = `<div class="route-actions"><label>显示范围 <select id="notice-filter"><option value="all">全部说明</option><option value="unread">未读</option></select></label><button class="quiet-button" id="notice-read-all">全部标为已读</button><span id="notice-feedback" role="status"></span></div><div id="notice-list"></div>`;
const notices = [{id:'okx-demo-v0.4.0',title:'OKX 模拟盘现货实验已加入',body:'桌面版支持 BTC/ETH/SOL-USDT 模拟现货、加密保存凭据、只读账户预检、运行状态和本机账本。仅模拟环境；止盈/止损依赖电脑持续在线。断线或状态不明时停机并要求人工核对。',date:'2026-10-23'},{id:'workspace-pages-v1',title:'桌面工作台：独立页面与可读字号',body:'策略、日志、风险和版本说明现为独立工作区。策略页可选策略、导入 CSV 与运行实验；日志支持筛选、刷新和导出。',date:'2026-10-22'},{id:'research-boundary-v1',title:'当前研究版能力说明',body:'公开行情仅驱动本地纸面交易，不提交真实订单。离线实验、CSV 历史回测与公开行情会话独立计账。行情或回测结果不构成收益承诺。',date:'2026-10-22'}];
let read;
try { read = new Set(JSON.parse(localStorage.getItem('tideflow.notices.read.v1')) || []); } catch { read = new Set(); }
function renderNotices() {
  $('#notice-list').innerHTML = notices.filter(n => $('#notice-filter').value !== 'unread' || !read.has(n.id)).map(n => `<article class="panel notice-entry"><small>${n.date} · ${read.has(n.id) ? '已读' : '未读'} · 本地版本说明</small><h3>${n.title}</h3><p>${n.body}</p><button class="text-button" data-notice-read="${n.id}">${read.has(n.id) ? '标为未读' : '标为已读'}</button></article>`).join('') || '<article class="panel">没有未读的本地版本说明。</article>';
}
function saveRead() { try { localStorage.setItem('tideflow.notices.read.v1',JSON.stringify([...read])); $('#notice-feedback').textContent = '阅读状态已保存在本机'; } catch (error) { $('#notice-feedback').textContent = `保存失败：${error.message}`; } renderNotices(); }
$('#notice-filter').addEventListener('change', renderNotices); $('#notice-read-all').addEventListener('click', () => { notices.forEach(n=>read.add(n.id)); saveRead(); });
function syncStrategies() { document.querySelectorAll('[data-strategy-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.strategyChoice === $('#strategy-select').value))); }
$('#strategy-select').addEventListener('change',syncStrategies);
let current;
function navigate(page, updateHash = true) {
  if (!Object.hasOwn(routes,page)) page = 'overview';
  current = page;
  for (const [key, section] of Object.entries(routes)) section.hidden = key !== page;
  document.querySelectorAll('.nav-item').forEach(button => { const active = button.dataset.page === page; button.classList.toggle('active',active); if(active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
  $('#page-breadcrumb').textContent = names[page];
  overviewAction.dataset.route = page === 'strategies' ? 'overview' : 'strategies';
  overviewAction.textContent = page === 'strategies' ? '返回总览 →' : '进入策略实验室 →';
  const heading = $('.page-heading h1'); heading.textContent = page === 'overview' ? '把波动，变成可检验的节奏。' : names[page];
  document.title = `潮序 Tideflow · ${names[page]}`;
  $('#modal-backdrop').hidden = true; document.body.style.overflow = '';
  if (page === 'journal') renderJournal(); if(page === 'risk') renderRisk(); if(page === 'announcements') renderNotices(); syncStrategies();
  if(updateHash && location.hash !== `#${page}`) location.hash = page;
  window.scrollTo(0,0); heading.tabIndex = -1; heading.focus({preventScroll:true});
}
document.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('[data-page],[data-open-page],[data-route],#announcements-shortcut,.brand');
  if(button) { event.preventDefault(); event.stopImmediatePropagation(); navigate(button.dataset.page || button.dataset.openPage || button.dataset.route || (button.id === 'announcements-shortcut' ? 'announcements' : 'overview')); return; }
  const strategy = event.target.closest('[data-strategy-choice]');
  if(strategy) { $('#strategy-select').value = strategy.dataset.strategyChoice; $('#strategy-select').dispatchEvent(new Event('change')); }
  const notice = event.target.closest('[data-notice-read]'); if(notice) { const id = notice.dataset.noticeRead; read.has(id) ? read.delete(id) : read.add(id); saveRead(); }
},true);
window.addEventListener('hashchange', () => { const page = location.hash.slice(1); if(page !== current) navigate(page,false); });
const observed = $('#desktop-events'); if(observed) new MutationObserver(() => { if(current === 'journal') renderJournal(); }).observe(observed,{childList:true,subtree:true});
navigate(location.hash.slice(1) || 'overview',false);
