# 木牛 macOS 桌面端

桌面端是木牛 Agent OS 0.2 的原生 Shell。它负责首次向导、全局导航、托盘入口和插件 UI 宿主；业务状态、审批与执行统一由本地 `mn-host` 的 `/v2` 接口处理。

## 本地开发

浏览器模式适合快速修改界面。先在仓库根目录启动 Host：

```bash
npm run dev:host
```

再开一个终端启动页面：

```bash
npm run dev:desktop
```

浏览器预览默认使用 `http://127.0.0.1:5173`，连接 `http://127.0.0.1:7318`。

验证原生集成时，构建 Host sidecar 后启动 Tauri：

```bash
npm run build:host-sidecar
npm run tauri:dev -w @mn/desktop-mac
```

Tauri 托管 `mn-host` sidecar，本地权威状态位于 `~/.muniu/v2`。同一端口已有 daemon 时，应用会提示退出冲突进程并中止启动。

## Shell 契约

- 首次向导固定为视图选择、插件启用、BYOK 模型连接和工作区创建四屏。
- 一级导航固定为首页、工作区、收件箱、成果和活动；Agents、集成与设置默认折叠。
- 经营视图和专业视图调用相同接口并产生相同事件，只改变信息密度。
- 插件只能贡献二级路由、首页卡片与命令，不能替换全局安全、审批和设置页面。
- 工具日志默认折叠；成果、审批、决定和下一步优先展示。

## 体验验收

```bash
npm run verify:onboarding-ui
npm run verify:opc-ui
npm run verify:coding-ui
```

脚本使用临时 mock Host 和系统 Chrome，验证四屏向导、经营/专业视图、插件故障隔离、审批卡、成果优先展示、Cmd-K 和最小窗口尺寸。

## 安全边界

- 模型密钥由 Host 写入 Keychain，页面只提交一次，不写入桌面设置。
- 生产脚本只允许同源加载；`object`、`frame`、`base` 与 `form` 均被 CSP 禁止。
- Webview 不拥有任意文件系统、进程、深链或外部命令权限。
- 签名产品插件是与 Host 同进程的可信代码，不是沙箱。

发布、签名和公证要求见 [macOS 发布](../../docs/release/macos.md)。
