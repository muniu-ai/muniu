# 木牛 macOS 桌面端

木牛桌面端采用 Tauri 2 + React，连接本地 mn API 管理内嵌 Agent、模型 Provider、会话、审批和可观测性。运行桌面端不要求安装 Claude Code 或 Codex CLI；两者的配置、历史会话和 legacy executor 页面只用于可选兼容与迁移。

```bash
npm run dev:api
npm run dev:desktop
```

浏览器预览默认地址为 `http://127.0.0.1:5173`。

## 验证

Extensions 核心交互可用可重复脚本验证：

```bash
npm run verify:desktop-extensions
```

脚本会使用临时 HOME/MNIU root，启动本地 API 和 Vite 预览，通过 `playwright-core` 驱动系统 Chrome 完成 MCP、Prompt、Skill 的 CRUD 与确认写入，并刷新截图证据：

```text
.gdp-state/mniu-ccswitch-redesign/evidence/desktop-extensions-crud.png
```

Observability 面板可用可重复脚本验证：

```bash
npm run verify:desktop-observability
```

脚本会使用临时 HOME/MNIU root，启动本地 API、proxy、mock upstream 和 Vite 预览，通过 `playwright-core` 驱动系统 Chrome 验证 Provider 新增/编辑/复制/删除/启用/live probe、Provider export/import、usage、session 搜索/翻页/隐私提示、session export 浏览器回退、proxy logs 展示和移动无水平溢出，并刷新截图证据。若 proxy log 带有 run/candidate 关联，Observability 行会显示短 ID：

```text
.gdp-state/mniu-ccswitch-redesign/evidence/desktop-observability.png
```

Task Fusion 面板可用可重复脚本验证：

```bash
npm run verify:desktop-task-fusion
```

脚本会创建临时 npm demo repo，启动本地 API 和 Vite 预览，通过 `playwright-core` 驱动系统 Chrome 从桌面创建 task、验证后台 Codex mock run 完成态、下载 persisted artifact、下载 artifacts archive、预览并确认清理 artifact store、注入 run/candidate 关联 proxy usage 并验证 Run Detail 显示、验证长任务取消态、检查 gates/events 展示和移动无水平溢出，并刷新截图证据：

```text
.gdp-state/mniu-ccswitch-redesign/evidence/desktop-task-fusion.png
```

Settings 面板可用可重复脚本验证：

```bash
npm run verify:desktop-settings
```

脚本会启动本地 API 和 Vite 预览，通过 `playwright-core` 驱动系统 Chrome 保存 settings、重载后验证持久化、检查移动无水平溢出，并刷新截图证据：

```text
.gdp-state/mniu-ccswitch-redesign/evidence/desktop-settings.png
```

如果系统 Chrome 不在默认位置，可以设置 `PLAYWRIGHT_CHROME_EXECUTABLE`。

Tauri 环境中的 Provider export、Session export、Run artifact 和 artifacts archive 会优先打开原生保存对话框；Vite/browser 验证环境和 native save 失败时会回退浏览器下载。

Tauri 原生窗口需要本机安装 Rust/Cargo：

```bash
npm run tauri:desktop -- dev
```
