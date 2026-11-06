# AI Quant Tool

独立的 Windows 优先 OKX 自动化交易工具项目；与旧 `okx-demo-agent` 隔离。目标是可配置、可回测、默认模拟盘、带硬性风控的秒级策略执行。它不承诺盈利，也不把秒级执行称作机构级 HFT：个人电脑、公共互联网和交易所 API 的延迟及限频都不具备共置机房撮合的条件。

## 当前开发状态

目前已有公共行情 WebSocket、签名 REST 适配器、确认 K 线历史拉取、CSV 动量回测、时间顺序训练/样本外验证的逻辑回归基线、本地模拟运行、追加式订单账本和订单不确定结果恢复协调器。`paper` 在本机按行情模拟成交；`demo-run` 是新增的单交易对、USDT 现货、只做多的 OKX 模拟盘执行器，会在每笔委托前写入 intent，并在之后核对订单状态/账户余额。另有 `demo-preflight` 只读预检。当前没有实盘策略执行器，也没有真实 OKX 模拟账户端到端验收。

本地 `paper` 不向交易所下单。`demo-run` 会真实向交易所模拟盘发送现货市价单，但不会连接实盘；止盈/止损由本地行情监控触发，不是交易所托管的保护单，客户端断线或关机时不会自动执行。未经过模拟账户验收、断线/部分成交恢复、长时间运行和 Windows 分发独立验收前，不应拿它接实盘或宣传为已验证的自动盈利产品。

另有品牌工作台“潮序 Tideflow”（`workbench/`），含策略/标的/频率/风险选择、纸面回放、指标账本、历史 CSV 回测和官方公告预留位。`npm run workbench` 启动时必须配置 `TIDEFLOW_INVITE_CODES`；未认证不能读取工作台页面与脚本，也没有公开注册入口。此认证目前只用于绑定 `127.0.0.1` 的本机预览，邀请码为共享访问码，不是正式逐用户账号/商业授权；公告发布服务也尚未接入。安装和边界详见 [workbench/README.md](workbench/README.md)。

## 开源方案评估

- [Hummingbot](https://github.com/hummingbot/hummingbot)：活跃的 Apache-2.0 交易机器人项目，功能面较广；完整运行时和既有应用结构较重，不直接 fork，以其连接器/策略分层作为参考。
- [CCXT](https://github.com/ccxt/ccxt)：活跃的 MIT 多交易所 API 适配库；本项目第一阶段限定 OKX，避免额外抽象层，并直接按 OKX 官方文档维护请求和协议。
- [NautilusTrader](https://github.com/nautechsystems/nautilus_trader)：成熟的回测与实盘引擎，有 OKX adapter；Rust/Python 技术栈和 LGPL-3.0 交付义务需要单独评估，不符合当前轻量 Windows 本地工具方向。
- 逻辑回归基线评估过 [machine-learning](https://github.com/erikgerrits/machine-learning) 与 [@kanaries/ml](https://github.com/Kanaries/ml)：前者 README 明示仍处早期开发，后者覆盖面较广但当前只需要一个可审计的小型二分类基线；本项目自写最小梯度下降实现，不复制第三方代码，也不增加机器学习运行依赖。

当前选择 Node.js + TypeScript 的小型模块化实现；只借鉴成熟系统的行情/执行解耦、持久化对账和 fail-closed 思路，不复制其代码。以后如自行引入第三方运行依赖，必须记录版本及许可证并随交付保留要求的 notices。

## 安全边界

- 适配器不内置默认区域地址；操作者必须显式配置 OKX 给该账户分配的 REST 与 WebSocket 地址。
- 不把密钥写入代码、JSON 配置、日志或仓库；密钥由启动进程的环境注入，后续再接入 Windows Credential Manager。
- 未完成启动对账、行情过期、订单结果不明、风控状态不完整或 kill switch 激活时，禁止新增委托。
- `demo-run` 强制 `environment: demo` 与模拟盘请求头，只允许 USDT 现货做多；没有实盘执行命令。任何网络超时后的订单状态均先查询/对账，禁止盲目重试。
- 止盈止损是客户端监控逻辑；断网、关机、进程崩溃或行情失效时，仓位可能继续暴露。模拟运行期间不要在其他终端手工交易或转入转出目标币/计价币，否则余额差额和盈亏记录不再可信。
- 不提供提现、资金划转或 API 密钥管理权限。

## 开发环境

需要 Node.js 22.15+。安装依赖后运行：

```powershell
npm install
npm run typecheck
npm test
npm run build
node .\dist\cli.js help
```

可用的本地回测入口：

```powershell
node .\dist\cli.js backtest .\examples\synthetic-ohlcv.csv --lookback 2 --allow-short
```

历史 K 线下载、样本外模型验证与推断：

```powershell
node .\dist\cli.js fetch-candles BTC-USDT 1m 5000 `
  --rest-url https://<your-region-origin> --out .\data\btc-1m.csv
node .\dist\cli.js ai-backtest .\data\btc-1m.csv --allow-short --model-out .\models\btc-logistic.json
node .\dist\cli.js predict .\models\btc-logistic.json .\data\btc-1m.csv
```

下载器仅调用公开行情端点，不需要 API 凭证；区域 HTTPS 源站必须由操作者提供。导出的 CSV 和模型会以新文件方式写入，若目标已存在则拒绝覆盖。K 线信号以未来一根 candle 的涨跌作为分类标签，研究模拟以下一根开盘入场、收盘退出，仍无法模拟资金费率、排队、滑点波动、部分成交、宕机和强平；单一留出区间成绩不代表可交易盈利。`predict` 只报告方向概率，不直接发出下单动作。

公共行情模拟模式要求操作者显式设置适用区域的 WebSocket 地址，例如当前 PowerShell 会话中的 `OKX_PUBLIC_WS_URL`。该模式只订阅公开行情并在本机模拟成交，不会调用私有账户 API 或发单。行情连接实现了 OKX 要求的空闲 `ping`/`pong` 保活；8443 端口将于 2026-10-31 停用，程序拒绝该端口，部署时应使用区域服务在 443 上的地址。详见 [OKX WebSocket 指南](https://app.okx.com/docs-v5/en/)及[端口迁移公告](https://app.okx.com/docs-v5/log_en/)。

启动一个本地行情模拟会话，并把模拟成交/结束报告追加到 JSONL：

```powershell
$env:OKX_PUBLIC_WS_URL = 'wss://<your-region-public-endpoint>'
node .\dist\cli.js paper BTC-USDT --journal .\data\paper-sessions.jsonl
```

每次运行使用独立会话 ID；停止时写入一份报告。未平仓仓位会在报告中显示，不会在停止时假装平仓。账本只记录模拟成交和汇总，不保存 API 凭证。

模拟盘现货账户预检只进行交易所只读请求；密钥必须由启动进程环境提供，程序不读取凭证文件，也不会输出密钥。预检会把核对结果追加到指定 JSONL 账本；若交易品种的基础币已有余额、存在未完成委托、本地存在未决订单，或响应格式不完整，则停止并要求人工复核。`demo-run` 只接受模拟盘专用 API 凭证，并要求启动时目标基础币为零、无未完成委托、无本地未决订单，且计价币可用余额覆盖预算。

```powershell
$env:OKX_API_KEY = '<demo-api-key>'
$env:OKX_SECRET_KEY = '<demo-secret-key>'
$env:OKX_PASSPHRASE = '<demo-passphrase>'
node .\dist\cli.js demo-preflight BTC-USDT `
  --rest-url https://<your-region-origin> --journal .\data\demo-orders.jsonl
```

模拟盘策略运行（会实际在 OKX 模拟盘提交委托，绝非离线回测）：

```powershell
$env:OKX_PUBLIC_WS_URL = 'wss://<your-region-public-endpoint>'
node .\dist\cli.js demo-run BTC-USDT `
  --rest-url https://<your-region-origin> --journal .\data\demo-orders.jsonl `
  --budget-usdt 25 --max-order-usd 25 --max-exposure-usd 25
```

默认只在动量信号成立时买入；触发本地止盈/止损价或出现足够强的反向动量时，先将可用基础币余额按 lot size 向下取整，再以最新买一价估算收到的计价币目标额提交卖出市价单（`tgtCcy=quote_ccy`，并受 `slippagePct` 限制）。实际成交量仍以交易所回报和账户余额对账为准。程序最多保留一个未决订单；`live`/`partially_filled` 会阻止新单，订单结果不明时只查单、不重发。启动会重新核对现货余额、未完成委托和本地账本。若进程停止时尚有订单或持仓，程序不会擅自撤单或卖出；先查看 JSONL 并人工处理。报价成交额差用于估算净盈亏，计价币之外支付的手续费不一定包含在该估算中。

针对网络超时或进程中断造成的未决订单，可用以下只读恢复命令；它只查询，不重发、不撤单。订单仍在挂单或交易所查询不到时，会继续保持未决状态：

```powershell
node .\dist\cli.js demo-reconcile BTC-USDT `
  --client-order-id <journal里的clientOrderId> `
  --rest-url https://<your-region-origin> --journal .\data\demo-orders.jsonl
```

只有模拟盘专用凭证可用于此预检。OKX 现货市场单的 `sz` 单位可由 `tgtCcy` 指定；订单还可使用 `banAmend` 禁止交易所自动调整下单数量，并可指定 `slippagePct`。项目会在适用的现货市价单中显式固定这些单位，减少单位歧义；滑点上限字段按 OKX 限制校验在 0–5% 范围内。字段语义与状态取值按 [OKX V5 API 官方文档](https://app.okx.com/docs-v5/en/)实现。

API 接入依据：[OKX V5 API 文档](https://www.okx.com/docs-v5/en/)。实盘/模拟盘域名按账号所属区域由用户明确提供，不在项目中猜测。

开源核对：评估了 OKX 官方 [agent-trade-kit](https://github.com/okx/agent-trade-kit) 的 TypeScript/ESM 分层和交易端点组织方式。它面向 MCP/CLI 的多产品工具集，本项目需要小型、可审计、默认模拟盘且不引入额外运行依赖的单币现货执行器，因此只借鉴模块边界与官方字段核对思路，没有复制其代码或引入该依赖。订单字段最终以 OKX 官方 API 文档为准。
