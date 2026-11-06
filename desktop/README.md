# 潮序 Tideflow 桌面版

Windows 一键安装包包含历史 CSV 回测、本地纸面交易与 OKX 模拟盘现货实验。侧栏页面为独立工作区；安装程序会创建“潮序 Tideflow”桌面和开始菜单快捷方式，并使用项目图标。

## OKX 模拟盘

1. 在 OKX 的模拟交易环境中创建 API Key。仅授予读取和交易权限，关闭提币权限。
2. 打开“OKX 模拟盘”页，按账户所属站点填写 REST 域名和对应的模拟盘公共行情 WebSocket 地址，再输入模拟 API Key、Secret、Passphrase 并点击“加密保存”。
3. 选择 BTC-USDT、ETH-USDT 或 SOL-USDT，设置 1–500 USDT 单次预算、止损和止盈距离。
4. 点击“只读账户预检”。预检会读取账户模式、余额、标的余额和挂单，并检查本机账本；它不会提交订单。若账户已有该币种、存在挂单或本地状态未决，程序会拒绝启动。
5. 核对结果后，明确确认“启动 OKX 模拟盘”。策略会自动提交模拟现货市价单；启动前再次预检。可随时停止，但停止不会自动平掉持仓。

程序仅接受 OKX 官方 HTTPS REST 域名和官方模拟盘公共 WebSocket 域名。默认全球站示例为 `https://www.okx.com` 与 `wss://wspap.okx.com/ws/v5/public`；其他受支持站点请采用 OKX 官方文档对应的模拟端点。WebSocket 使用 443；不要再配置 8443。

凭据经 Electron `safeStorage` 调用当前 Windows 用户的系统加密后存放在 `%APPDATA%\tideflow-desktop\okx-demo\credentials.bin`。加密不可用时程序会拒绝保存，不写明文。删除应用不会自动清除此目录。

模拟盘运行范围固定为单标的 USDT 现货、只做多、单笔/单仓预算上限相同，无杠杆和提现功能。行情、止盈和止损依赖本机网络、应用持续运行及未休眠；保护逻辑不是交易所托管订单。断线、未知委托结果或状态不一致时策略停机，不自动重连、不重试委托；请先在 OKX 模拟账户和本机账本人工核对。关闭程序或停止策略不会替用户平仓。模拟结果不代表实盘效果或盈利能力。

完整模拟运行账本位于 `%APPDATA%\tideflow-desktop\okx-demo\okx-demo-orders.jsonl`。界面按钮可打开该目录。离线回测、公开行情纸面交易和 OKX 模拟盘记录相互独立。

## 开发与验收

在项目根目录运行 `npm run build` 和 `npm test`；在 `desktop` 目录运行 `npm test`、`npm run package`。安装包输出到 `release/windows-0.4.0/`。桌面安装包与 OKX 真正账户凭据不会打包进程序。
