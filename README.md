# OpenClaw Console（EXE 全功能版）

OpenClaw 微信机器人控制台的**完整桌面版**：Electron + NSIS 安装包，Windows 7 SP1 ~ Windows 11 全支持。用于管理本机网关、配置模型供应商、切换模型优先级、绑定微信，并实时查看 Token 消耗。

> 配套的轻量 UWP/MSIX 版：[openclaw-console-lite](https://github.com/a2109246162-tech/openclaw-console-lite)

## 功能

- **网关管理**：启动 / 关闭本地 OpenClaw 网关，实时显示状态、PID、端口与当前模型
- **模型管理**：添加任意 OpenAI 兼容 API（内置火山方舟 / DeepSeek / OpenAI / 智谱 / Moonshot 预设），上移 / 下移调整优先级、删除模型；改动后自动重启网关
- **微信绑定**：调用官方 `openclaw-weixin` 插件拉取二维码，本地生成 PNG（不依赖外部二维码服务）
- **用量统计**：按模型统计当日 Token 消耗
- **开机自启 / 防休眠**：可写入任务管理器可见的启动项；可阻止系统休眠保持机器人在线
- **托盘**：隐藏到托盘后网关继续运行，右键菜单可启停网关 / 打开主界面
- **操作日志**：带时间戳的实时日志

## 目录结构

```
app/
  main.js             Electron 主进程：IPC、模型管理、插件安装、二维码、网关、用量、托盘
  index.html          渲染进程界面 + 样式
  preload.js          预加载桥接
  hostname-shim.cjs   Node hostname 兼容处理
  preset-config.json  出厂预置模型配置（API Key 为占位符，需自行填写）
  package.json        Electron 应用描述
  icon.png            应用图标
installer.nsi         NSIS 安装包脚本（Unicode / LZMA，默认装到 D 盘）
test/                 端到端、接口、二维码等测试脚本
```

## 快速开始

### 1. 准备运行环境

```bash
# 需要 Node.js 18+
npm install electron --save-dev
npm install qrcode
```

### 2. 准备 OpenClaw 运行时

本项目**不包含** OpenClaw CLI、Node 运行时和微信插件源码（它们各有独立许可证）。运行时目录结构：

```
runtime/
  node.exe
  openclaw/            # openclaw CLI 包（openclaw.mjs、dist/index.js、node_modules）
system-ca-bundle.pem   # 可选，自定义 CA 根证书
resources/app/plugins/tencent-weixin-openclaw-weixin-*/   # 官方微信插件包
```

### 3. 填入 API Key

打开 `app/preset-config.json`，把所有 `REPLACE_WITH_YOUR_*` 换成你自己的值：

```jsonc
"gateway": { "auth": { "token": "REPLACE_WITH_YOUR_GATEWAY_TOKEN" } },
"models": { "providers": {
  "deepseek": { "apiKey": "sk-REPLACE_WITH_YOUR_API_KEY" },
  "ark":      { "apiKey": "ark-REPLACE_WITH_YOUR_API_KEY" }
}}
```

也可以不填，启动后在界面里点「＋ 添加 API」逐条添加。

### 4. 启动

```bash
npx electron app
```

### 5. 打包 EXE 安装包

```bash
# 需要安装 NSIS（makensis.exe）
makensis installer.nsi
```

产物默认输出到 `D:\opclaw\OpenClaw-Setup.exe`，可在 `installer.nsi` 顶部修改 `OutFile`。

## 测试

`test/` 目录下是开发期用过的真实测试脚本（`e2e-verify.js`、`test-runner.js`、`mock-provider.js` 等）。它们需要一个隔离的测试 profile 与 mock 上游，不会碰真实数据目录；按文件头部注释配置端口与目录后运行。

## 安全说明

- 本仓库**不含**任何真实 API Key、网关 Token、证书私钥或用户数据。
- 配置与运行数据存放在 `%USERPROFILE%\.openclaw\`，首次启动会自动创建。
- 微信扫码绑定仅调用官方插件，二维码在本机生成，不上传任何图像。

## 许可证

本项目代码采用 [MIT License](LICENSE)。

依赖组件各自遵循其原始许可证，本项目不重新授权它们：
- [Electron](https://github.com/electron/electron) — MIT
- [Node.js](https://github.com/nodejs/node) — MIT
- [qrcode](https://github.com/nayuki/QR-Code-generator) — MIT
- [OpenClaw](https://github.com/openclaw/openclaw) — 按其项目许可证
- `@tencent-weixin/openclaw-weixin` — 按腾讯官方插件许可证

打包分发时请附带各依赖的许可证文本（Electron 构建产物自带 `LICENSES.chromium.html`）。
