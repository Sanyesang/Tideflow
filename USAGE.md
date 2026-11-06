# 潮序 Tideflow 使用说明

潮序是一个 Windows 量化研究工作台，包含历史数据回测、本地纸面交易和 OKX 模拟盘现货实验。当前项目仍处于开发阶段，模拟盘连接尚未完成真实账户端到端验收；回测和模拟结果不代表真实收益。

## Windows 安装

1. 打开 [项目的 Releases 页面](https://github.com/Sanyesang/Tideflow/releases)，下载 `Tideflow-Setup-0.4.0-x64.exe`。
2. 运行安装程序。安装完成后，可通过桌面或开始菜单中的“潮序 Tideflow”启动。
3. 在工作台中选择策略、交易标的和风险参数，先使用本地纸面交易或导入历史 CSV 进行回测。

0.3.0 和 0.3.1 是历史安装包，供查看旧版本使用。0.4.0 安装包没有数字签名，Windows 可能显示安全提示，请核对下载来源。程序安装包未经本次独立复测；遇到启动问题时请保留错误信息并在项目中反馈。

## 模拟交易说明

本地纸面交易在电脑上模拟成交。OKX 模拟盘功能会向交易所的模拟环境发送模拟委托；配置方法与运行限制见 [桌面版说明](desktop/README.md)。当前没有实盘策略执行器，也未完成真实模拟账户端到端验收。

模拟盘策略的止盈止损依赖电脑、应用和网络持续运行；停止程序不等于自动平仓。使用前应先了解桌面版说明中的对账和停止规则。

## 从源码运行

需要 Node.js 22.15.0 或更高版本，以及 npm。克隆仓库后，在项目根目录运行：

```powershell
npm ci
npm run build
cd desktop
npm ci
npm start
```

项目根目录提供 CLI 与研究模块，`workbench/` 是工作台界面，`desktop/` 是 Electron 桌面程序。浏览器工作台的本机预览方式见 [工作台说明](workbench/README.md)。

## 保存完整目录

Releases 中的 `Tideflow-full-2026-11-07.tar.gz` 是原项目目录的完整归档，包含依赖和旧构建输出，体积较大。下载后可在 PowerShell 中运行 `tar -xzf Tideflow-full-2026-11-07.tar.gz` 解压。GitHub 仓库的 `main` 分支适合浏览和获取源码。

`Tideflow-presentation-materials-safe-20261021.tar.gz` 包含演示文稿及其制作资料。原制作目录使用的共享 `node_modules` 连接未打入该归档，恢复制作环境时需要另行准备依赖。
