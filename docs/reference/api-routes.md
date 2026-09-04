# API 路由

Agent OS 0.2 默认监听 `http://127.0.0.1:7318`。成功的 JSON 响应使用 `{ "data": ..., "traceId": "..." }`；错误直接返回统一错误对象。企业请求由部署的身份解析器认证，本地 profile 使用隐式 `local` tenant 与 `local-owner`。

## 通用规则

- 所有 mutation 都需要非空 `Idempotency-Key` 请求头。
- 修改现有 aggregate 的请求体还需要 `expectedStreamVersion`。
- 相同幂等键与相同请求返回原结果；相同键用于不同请求返回 `409`。
- stream version 冲突返回 `409`，客户端读取最新实体后重新构造请求。
- 路径参数必须逐段进行 URL 编码。
- `X-Trace-Id` 可由客户端提供；Host 始终在响应中返回 trace ID。

## 生命周期

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v2/openapi.json` | 返回运行中 Host 的公共 OpenAPI |
| `GET` | `/v2/health` | 返回核心或工作区插件健康状态 |
| `GET` | `/v2/readiness` | 返回存储、lock 与运行条件是否就绪 |

`/v2/health?workspaceId=...` 会包含该工作区的插件状态。插件 degraded 不应使核心健康检查或其他插件路由失效。

## 公共契约

下表由 `packages/contracts/src/openapi.ts` 生成。`—` 表示该项不适用。

<!-- generated:contracts-routes:start -->

| 方法 | 路径 | operationId | 幂等键 | stream version |
| --- | --- | --- | --- | --- |
| `GET` | `/v2/openapi.json` | `getOpenApi` | — | — |
| `GET` | `/v2/health` | `getHealth` | — | — |
| `GET` | `/v2/readiness` | `getReadiness` | — | — |
| `POST` | `/v2/setup` | `setup` | 必需 | — |
| `GET` | `/v2/workspaces` | `listWorkspaces` | — | — |
| `POST` | `/v2/workspaces` | `createWorkspace` | 必需 | — |
| `PATCH` | `/v2/workspaces/{workspaceId}` | `updateWorkspace` | 必需 | 必需 |
| `GET` | `/v2/workspaces/{workspaceId}/home` | `getWorkspaceHome` | — | — |
| `GET` | `/v2/workspaces/{workspaceId}/threads` | `listThreads` | — | — |
| `POST` | `/v2/workspaces/{workspaceId}/threads` | `createThread` | 必需 | — |
| `GET` | `/v2/workspaces/{workspaceId}/threads/{threadId}/turns` | `listThreadTurns` | — | — |
| `POST` | `/v2/workspaces/{workspaceId}/threads/{threadId}/turns` | `createTurn` | 必需 | 必需 |
| `GET` | `/v2/workspaces/{workspaceId}/events` | `streamWorkspaceEvents` | — | — |
| `POST` | `/v2/executions/{executionId}/commands` | `commandExecution` | 必需 | 必需 |
| `GET` | `/v2/inbox` | `listInbox` | — | — |
| `GET` | `/v2/activity` | `listActivity` | — | — |
| `POST` | `/v2/approvals/{approvalId}/decisions` | `decideApproval` | 必需 | 必需 |
| `GET` | `/v2/deliverables` | `listDeliverables` | — | — |
| `GET` | `/v2/assets/{assetId}` | `getAsset` | — | — |
| `GET` | `/v2/memories` | `listMemories` | — | — |
| `POST` | `/v2/memories` | `proposeMemory` | 必需 | — |
| `PATCH` | `/v2/memories/{memoryId}` | `reviseMemoryProposal` | 必需 | 必需 |
| `DELETE` | `/v2/memories/{memoryId}` | `deleteMemory` | 必需 | 必需 |
| `POST` | `/v2/memories/{memoryId}/decisions` | `decideMemory` | 必需 | 必需 |
| `GET` | `/v2/share-grants` | `listShareGrants` | — | — |
| `POST` | `/v2/share-grants` | `createShareGrant` | 必需 | 必需 |
| `DELETE` | `/v2/share-grants/{grantId}` | `revokeShareGrant` | 必需 | 必需 |
| `GET` | `/v2/model-connections/presets` | `listModelPresets` | — | — |
| `GET` | `/v2/model-connections` | `listModelConnections` | — | — |
| `POST` | `/v2/model-connections` | `createModelConnection` | 必需 | — |
| `POST` | `/v2/model-connections/{connectionId}/probe` | `probeModelConnection` | 必需 | 必需 |
| `POST` | `/v2/plugins/installations` | `installPlugin` | 必需 | — |
| `GET` | `/v2/plugins/installations` | `listPluginInstallations` | — | — |
| `POST` | `/v2/workspaces/{workspaceId}/plugin-activations` | `activatePlugin` | 必需 | 必需 |
| `GET` | `/v2/plugins/opc/opportunities/{opportunityId}` | `getOpcOpportunity` | — | — |
| `POST` | `/v2/plugins/opc/opportunities/{opportunityId}/commands` | `commandOpcOpportunity` | 必需 | 必需 |
| `GET` | `/v2/plugins/opc/opportunities/{opportunityId}/deliverables` | `previewOpcDeliverables` | — | — |
| `POST` | `/v2/plugins/opc/opportunities/{opportunityId}/exports` | `exportOpcDeliverables` | 必需 | 必需 |
| `GET` | `/v2/plugins/{pluginId}/{path}` | `getPluginResource` | — | — |
| `POST` | `/v2/plugins/{pluginId}/{path}` | `mutatePluginResource` | 必需 | 必需 |

<!-- generated:contracts-routes:end -->

工作区与会话路由负责创建 Thread 和 turn。创建 turn 会先持久化模型可见输入，再返回 queued Execution；客户端从 SSE 或活动页跟踪后续状态。

执行命令包括 `follow_up`、`steer`、`cancel` 和 `resume`。审批决定只接受 `approve_once` 或 `deny`。调用参数、资源、工具版本、generation 或 authority commitment 变化后，原批准失效。

记忆创建接口只生成 proposal，不代表用户接受。跨 namespace 读取需要显式 share grant；接受、修改、拒绝、撤销和删除都应产生事件。

模型连接使用 `presetId`、`apiKey` 与可选 `displayName`。Host 拒绝底层 Base URL、报文格式和内部 ID；响应不会包含 Keychain 引用或 API Key。

插件领域接口统一位于 `/v2/plugins/{pluginId}/{path}`。mutation 请求体包含 `workspaceId` 与 `expectedStreamVersion`，插件路径不能覆盖核心路由。

Host 还提供工作区详情、share grant 列表、厂商预设、模型连接列表和插件安装列表等只读查询。运行时完整文档由 `/v2/openapi.json` 返回。

## SSE 续传

客户端通过 `Last-Event-ID` 或 `after` 提交最后处理的 tenant `position`。SSE `id` 也是 tenant position。工作区过滤会造成 position 不连续，客户端不得用“上一值加一”推导游标。

游标仍在保留期内时，Host 无缺口续传；游标过期返回 `410`。客户端应重新读取相关快照，再从响应给出的最新游标订阅。

## 错误格式

```json
{
  "code": "STREAM_VERSION_CONFLICT",
  "message": "对象已被其他操作更新",
  "action": "刷新后重试",
  "fieldIssues": [],
  "traceId": "trace-id",
  "retryable": false
}
```

`message` 面向用户，`action` 给出下一步；客户端不能依赖自然语言判断错误类别。字段校验错误放入 `fieldIssues`，日志关联使用 `traceId`。

静态契约见 [OpenAPI](./openapi.md)，运行时以 `/v2/openapi.json` 为准。
