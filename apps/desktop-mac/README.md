# 木牛 macOS 桌面端

桌面端是木牛 Agent OS 0.2 的原生 Shell。它负责首次向导、全局导航、托盘入口和插件 UI 宿主；业务状态、审批与执行统一由本地 `mn-host` 的 `/v2` 接口处理。

## 本地开发

```bash
npm run dev:desktop
```

浏览器预览默认使用 `http://127.0.0.1:5173`，连接 `http://127.0.0.1:7318`。Tauri 启动时会托管 `mn-host` sidecar，并把新状态写入 `~/.muniu/v2`。它不会读取或迁移 0.1 状态；若 7318 端口已有 daemon，应用会提示先退出旧版本并中止启动。

## 体验验收

```bash
npm run verify:onboarding-ui --workspace @mn/desktop-mac
npm run verify:opc-ui --workspace @mn/desktop-mac
npm run verify:coding-ui --workspace @mn/desktop-mac
```

脚本使用临时 mock Host 和系统 Chrome，验证四屏向导、经营/专业视图、插件故障隔离、审批卡、成果优先展示、Cmd-K 和最小窗口尺寸。

## 安全边界

- 模型密钥由 Host 写入 Keychain，页面只提交一次，不写入桌面设置。
- 生产脚本只允许同源加载；`object`、`frame`、`base` 与 `form` 均被 CSP 禁止。
- Webview 不拥有任意文件系统、进程、深链或外部命令权限。
- 签名产品插件是与 Host 同进程的可信代码，不是沙箱。
