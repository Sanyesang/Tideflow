# 潮序：电脑、iPhone、Android 共用产品方向

2026-10-21，依据用户提供的 Quantum 手机截图确定本轮方向。

## 参考与取舍（实现前记录）

- 用户截图：借鉴首页、策略、运行、账户四个入口，以及策略创建与运行列表分开的流程。不复用截图里的商标、账号、会员价格、新闻或盈利宣传。
- Mobbin：https://mobbin.com/discover/apps/ios 。公开页面只返回登录入口，无法查看足够具体案例。
- Page Flows：Robinhood 页面无法访问；Behance 交易 App 案例返回 403。再次回退至 Dribbble 的 Tradewise：https://dribbble.com/shots/27704489-Tradewise-Trading-Mobile-App-UI-Design 。该页面可访问，参考其公开说明中的余额、观察列表、交易历史分层；视觉与导航的直接依据仍是用户本次截图。采用单列卡片、底部导航与大触控区域，保留潮序的深色、暖白、青柠品牌。
- 开源评估：PWABuilder pwa-starter（https://github.com/pwa-builder/pwa-starter）采用 Lit/Vite，当前项目是无框架静态页面，整体迁移成本高于本轮需要。借鉴 Web App Manifest/独立窗口入口的标准模式，不复制其代码、不增加依赖。
- Android 封装候选：GoogleChromeLabs/bubblewrap（https://github.com/GoogleChromeLabs/bubblewrap），Apache-2.0，面向已部署 PWA 的 TWA。正式域名、站点关联与签名确定后再评估，当前不生成空壳 APK。

## 分发与运行

iPhone：HTTPS 网页 + 添加到主屏幕，可选仅包含 Web Clip 的描述文件。描述文件提供入口和图标，业务由网站实现。截图本身无法证明竞品的实际安装机制。原生企业分发不等于 Web Clip，企业开发者计划面向组织员工内部应用。

Android：同一网站先通过浏览器/PWA 使用；需要 APK 时再封装并进行真机验收。

电脑：同一产品的宽屏工作台。正式版本需共用逐用户账号、策略配置与账本。

持续行情订阅和策略执行应运行在常在线电脑或服务器；手机承担配置、查看与控制。手机锁屏、网页退出不能被当作后台执行器的运行保障。

Apple 依据：https://support.apple.com/en-ca/guide/deployment/depbc7c7808/web 、https://support.apple.com/en-lamr/guide/iphone/iphea86e5236/ios 、https://developer.apple.com/programs/enterprise/ 。

## 本轮已实现范围

`workbench/mobile.html` 是独立手机布局预览，复用已有 `simulator.js`，提供首页、策略、运行、账户、参数配置、阶段状态、中止、计算指标与本机回放记录。桌面浏览器中居中展示手机宽度，手机浏览器中铺满屏幕。

记录保存在独立的手机预览 localStorage 中；与旧电脑版演示账本不共用，也没有跨设备同步。未部署公网 HTTPS、未生成可安装描述文件、未构建 Android APK、未实现中心账户、会员收费、远程公告或真实交易。

下一阶段先统一手机与电脑的数据和执行状态，再做域名部署、安装入口与真机测试。收费档位和钱包不沿用竞品价格，也不以竞品截图当作已验证的交易能力。

## 本轮验收

- 手机宽度布局在桌面浏览器预览，首页、策略、运行、账户及参数弹窗均已查看。
- 选择均值回归、SOL-USDT、15 秒、风险指数 70：单笔名义上限 48 USDT、单轮亏损停止线 32.50 USDT；回放得到 71 笔平仓，净模拟盈亏 -8.80 USDT，模拟胜率 31.0%，盈亏因子 0.29，最大回撤 0.88%。均为合成样本结果，不是市场或账户成绩。
- 中止下一轮没有新增成交；刷新后配置与上述 71 笔记录恢复；浏览器未捕获控制台错误。
- 尚未完成 iPhone/Android 真机安装、跨设备登录同步、锁屏控制链路或实际交易验收。
