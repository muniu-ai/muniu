# v0.2.0 兼容矩阵

木牛 v0.2.0 在 TypeScript 边界实现 Codex app-server v2 的稳定子集。分析与 schema fixture 固定到 OpenAI Codex 提交 [`99660ab3c7b861c916e467581fa9b8723504d66b`](https://github.com/openai/codex/tree/99660ab3c7b861c916e467581fa9b8723504d66b)，声明为 `app-server-v2` / `core-stable-subset`。木牛不嵌入 Codex Rust 内核，也不宣称完整 Codex app-server 兼容。

## 客户端方法

| 领域 | 方法 |
| --- | --- |
| 握手 | `initialize` |
| Thread | `thread/start`、`thread/resume`、`thread/fork`、`thread/list`、`thread/loaded/list`、`thread/read`、`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/unsubscribe`、`thread/name/set` |
| 目标与上下文 | `thread/goal/set`、`thread/goal/get`、`thread/goal/clear`、`thread/compact/start` |
| Turn | `turn/start`、`turn/steer`、`turn/interrupt` |
| Review 与模型 | `review/start`、`model/list` |
| Skill 与 hook | `skills/list`、`skills/extraRoots/set`、`hooks/list` |
| 配置与 MCP | `config/read`、`config/mcpServer/reload`、`mcpServerStatus/list`、`mcpServer/resource/read`、`mcpServer/tool/call` |

方法只接受 `packages/app-server-protocol` 中 strict Zod schema 声明的字段。其他 Codex 方法不在 capabilities 中出现，并返回 `-32601`。

## 服务端请求

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `item/tool/call`
- `mcpServer/elicitation/request`

木牛策略引擎决定是否需要审批及可授予的范围；兼容请求只表达该决定。一次、turn 和 session 授权都绑定 effect commitment 与实际参数摘要。持久授权只能通过有权限的 `muniu/policy/*` 管理操作创建。

## 通知

| 类别 | 通知 |
| --- | --- |
| Thread | `thread/started`、`thread/status/changed`、`thread/archived`、`thread/unarchived`、`thread/deleted`、`thread/name/updated`、`thread/goal/updated`、`thread/goal/cleared`、`thread/compacted`、`thread/tokenUsage/updated` |
| Turn | `turn/started`、`turn/completed`、`turn/diff/updated` |
| Item | `item/started`、`item/completed`、agent message、plan、reasoning summary、命令输出、文件补丁和 MCP progress delta |
| 服务状态 | `mcpServer/startupStatus/updated`、`warning`、`error` |

通知先持久化再投递。客户端必须按 cursor 恢复，不能根据网络到达时间重建事实链。

## 木牛方法

控制面使用 `muniu/*` 命名空间。当前目录由 `packages/app-server-protocol/schema/method-catalog.json` 生成，并由 `npm run verify:rpc-coverage` 校验旧 operation 与 RPC method 一一映射。

| 命名空间 | 对象 |
| --- | --- |
| `muniu/project/*`、`muniu/task/*` | Project、Task 与索引 |
| `muniu/run/*`、`muniu/runJob/*` | Run、会话、队列、Worker 和恢复 |
| `muniu/evidence/*`、`muniu/artifact/*` | 证据、trace、learning、制品与导出 |
| `muniu/provider/*`、`muniu/modelCatalog/*` | Provider、模型目录、用量与对账 |
| `muniu/policy/*`、`muniu/approval/*` | Spec、Governance、waiver、策略解释与审批 |
| `muniu/extension/*`、`muniu/skillRegistry/*` | 插件、MCP、profile、skill 与 registry |
| `muniu/config/*`、`muniu/diagnostics/*` | 配置、能力、诊断、本地代理和系统状态 |

`docs/reference/openapi.yaml` 只记录 `muniu/*` handler 背后的内部 Fastify adapter，不是公开 HTTP 控制协议。

## 传输与客户端

| 接入 | 状态 | 认证与限制 |
| --- | --- | --- |
| stdio JSONL | 支持 | 子进程边界；16 MiB frame |
| Unix socket | 支持 | owner-only，socket 权限 `0600` |
| 回环 WebSocket | 支持 | 随机短期 bearer token；拒绝非回环明文 |
| 企业 WSS | 支持 | TLS、OIDC/JWKS、tenant/subject 固定、方法级 RBAC |
| `@mn/sdk` Node/browser | 支持，私有 | v0.2.0 不发布 npm 包 |
| Python SDK | 不支持 | 不在 v0.2.0 范围 |
| 旧控制 REST/SSE 客户端 | 不支持 | 控制请求返回 protocol mismatch；SSE 路由已删除 |

## Provider 与运行时

OpenAI、Anthropic 和兼容 Provider 继续由木牛 agent kernel 驱动。Claude Code 与 Codex CLI 是显式兼容 target，其输出归一化为 `AgentEventV3`；它们不会成为 app-server 内核。

v0.2.0 不包含以下能力：

- Codex Rust 内核和 Python SDK；
- 远程 daemon、设备配对、realtime voice 和 computer use；
- OpenAI account/login 与托管 marketplace；
- 自动 updater、匿名标识和反馈上传。

macOS Desktop 只进入构建和打包验证，不进入签名、公证或自动更新发布边界。
