# 潮序 Tideflow 本地工作台预览

在项目根目录启动邀请制本地工作台：

```powershell
npm run build
$inviteCode = node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))"
$env:TIDEFLOW_INVITE_CODES = $inviteCode
npm run workbench
```

默认打开 `http://127.0.0.1:4179`。把 `$inviteCode` 交给受邀体验者；需要多个访问码时，可将多个 32 位以上 base64url 码用逗号分隔后写入 `TIDEFLOW_INVITE_CODES`。不要把访问码提交到仓库或写入项目文件。端口可用 `TIDEFLOW_PORT` 环境变量指定。

这是本地产品预览，不连接网络行情、账户或交易所。市场观察与纸面回放使用 `simulator.js` 生成的确定性合成样本；脉冲动量、区间突破、均值回归三种策略都会实际运行本地信号/退出逻辑，频率、标的和风险分数会影响样本、门槛、仓位及统计。另可导入自行准备的 OHLCV CSV 做本地历史回测；文件仅由浏览器读取，受 20 MB / 250,000 根 K 线限制，需严格按时间升序并为等间隔数据。界面也提供一份极小的合成 CSV，仅用于验证导入链路。当前策略为样本内回放，未提供样本外验证；费用与滑点是固定模型假设，不等同于交易所真实撮合。结果用于研究与代码演示，不是实盘表现、收益承诺或投资建议。

每轮回放后，累计盈亏、胜率、盈亏因子、最大回撤、曲线和交易日志根据纸面回放产生的模拟平仓记录计算。参数与账本写入当前浏览器的本地存储，刷新后保留；不会上传。交易日志内提供清空本地记录的入口。历史 CSV 文件及回测结果不会持久化，刷新后需要重新导入。秒级选项仅代表合成数据回放频率，不代表实盘高频交易能力。

邀请入口现由本机 Node 服务验证：邀请码只在服务端进程内存中做 SHA-256 摘要比较；会话使用随机不透明 token、HttpOnly + SameSite=Strict Cookie，12 小时过期，服务器重启即失效；同一来源 15 分钟最多 8 次尝试。未认证时服务端只发登录页和必要静态资源，工作台页面、脚本和回测模块会被挡回登录入口。没有注册路由。

这只是绑定 `127.0.0.1` 的本机访问门，不是可对抗本机管理员的授权产品，也不是中心化的逐用户账户系统；共享邀请码可被转发，无法单独停用某位用户。不得把端口暴露到公网或当作正式商业登录服务。正式外部发售前需另行接入 HTTPS 中央身份服务、逐用户邀请/撤销、发布权限与审计。公告窗口仍是预留位，当前没有真实公告推送服务。

开源方案核对：参考了 [Better Auth 禁用注册配置](https://better-auth.com/docs/reference/options) 与 [Fastify Secure Session](https://github.com/fastify/fastify-secure-session) 的会话安全提示；前者面向有数据库的正式身份系统，后者依赖 Fastify，而当前工作台是一个仅供本机体验的原生 Node 静态服务。故本地原型不引入额外身份/数据库依赖，采用高熵邀请码 + 服务端会话映射；这不是生产级认证实现。邀请码采用定长摘要并用 Node `timingSafeEqual` 比较，具体 API 见 [Node.js Crypto 文档](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)。

当前代码库里的 `paper` 与 `demo-run` CLI 能力和本预览相互独立；本地 UI simulator 也不是现有 CLI 交易运行时。连接真实行情、账户或下单链路仍需单独实现、测试并审计，不能把本机登录门描述成远端授权系统。
