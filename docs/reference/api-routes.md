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
| `POST` | `/v2/plugins/{pluginId}/{commandId}` | `runPluginCommand` | 必需 | 必需 |
| `GET` | `/v2/workspaces/{workspaceId}/plugin-surfaces` | `getPluginSurfaces` | — | — |
| `GET` | `/v2/plugins/catalog` | `listPluginCatalog` | — | — |
| `GET` | `/v2/openapi.json` | `getOpenApi` | — | — |
| `GET` | `/v2/health` | `getHealth` | — | — |
| `GET` | `/v2/readiness` | `getReadiness` | — | — |
| `POST` | `/v2/setup` | `setup` | 必需 | — |
| `GET` | `/v2/workspaces` | `listWorkspaces` | — | — |
| `POST` | `/v2/workspaces` | `createWorkspace` | 必需 | — |
| `GET` | `/v2/workspaces/{workspaceId}` | `getWorkspace` | — | — |
| `PATCH` | `/v2/workspaces/{workspaceId}` | `updateWorkspace` | 必需 | 必需 |
| `GET` | `/v2/workspaces/{workspaceId}/members` | `listWorkspaceMembers` | — | — |
| `PUT` | `/v2/workspaces/{workspaceId}/members/{principalId}` | `setWorkspaceMember` | 必需 | 必需 |
| `DELETE` | `/v2/workspaces/{workspaceId}/members/{principalId}` | `removeWorkspaceMember` | 必需 | 必需 |
| `GET` | `/v2/workspaces/{workspaceId}/agent-catalog` | `getWorkspaceAgentCatalog` | — | — |
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
| `POST` | `/v2/assets` | `createAssets` | 必需 | 必需 |
| `GET` | `/v2/assets/{assetId}` | `getAsset` | — | — |
| `DELETE` | `/v2/assets/{assetId}` | `deleteAsset` | 必需 | 必需 |
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
| `PATCH` | `/v2/plugins/installations/{pluginId}` | `updatePlugin` | 必需 | 必需 |
| `POST` | `/v2/plugins/installations/{pluginId}/disable` | `disablePlugin` | 必需 | 必需 |
| `DELETE` | `/v2/plugins/installations/{pluginId}` | `purgePlugin` | 必需 | 必需 |
| `POST` | `/v2/workspaces/{workspaceId}/plugin-activations` | `activatePlugin` | 必需 | 必需 |
| `DELETE` | `/v2/workspaces/{workspaceId}/plugin-activations/{pluginId}` | `deactivatePlugin` | 必需 | 必需 |
| `GET` | `/v2/plugins/opc/opportunities` | `listOpcOpportunities` | — | — |
| `POST` | `/v2/plugins/opc/opportunities` | `createOpcOpportunity` | 必需 | 必需 |
| `GET` | `/v2/plugins/opc/opportunities/{opportunityId}` | `getOpcOpportunity` | — | — |
| `POST` | `/v2/plugins/opc/opportunities/{opportunityId}/commands` | `commandOpcOpportunity` | 必需 | 必需 |
| `GET` | `/v2/plugins/opc/opportunities/{opportunityId}/deliverables` | `previewOpcDeliverables` | — | — |
| `POST` | `/v2/plugins/opc/opportunities/{opportunityId}/exports` | `exportOpcDeliverables` | 必需 | 必需 |
| `POST` | `/v2/plugins/opc/samples/read-only` | `runOpcReadOnlySample` | 必需 | 必需 |
| `POST` | `/v2/plugins/coding/repositories` | `createCodingRepository` | 必需 | 必需 |
| `GET` | `/v2/plugins/coding/tasks` | `listCodingTasks` | — | — |
| `POST` | `/v2/plugins/coding/tasks` | `createCodingTask` | 必需 | 必需 |
| `POST` | `/v2/plugins/coding/samples/read-only` | `runCodingReadOnlySample` | 必需 | 必需 |
| `GET` | `/v2/plugins/coding/runners` | `listCodingRunners` | — | — |
| `POST` | `/v2/plugins/coding/runners/{runnerId}/inspections` | `inspectCodingRunner` | 必需 | — |
| `POST` | `/v2/plugins/coding/runners/{runnerId}/confirmations` | `confirmCodingRunner` | 必需 | 必需 |
| `GET` | `/v2/plugins/coding/executions/{executionId}/reconciliation` | `getCodingReconciliation` | — | — |
| `POST` | `/v2/plugins/coding/executions/{executionId}/reconciliation-decisions` | `decideCodingReconciliation` | 必需 | 必需 |

<!-- generated:contracts-routes:end -->

`POST /v2/assets` 接受 1 至 20 个 Base64 编码附件，新建请求的 `expectedStreamVersion` 固定为 `0`。Host 先校验文件名、MIME、内容签名和大小。`protected: true` 的附件先使用 AES-256-GCM 加密，再以 create-only 语义写入 CAS；wrapped DEK 与 CAS 摘要分开保存。全部对象写入成功后，Asset、wrapped DEK 记录、事件和幂等记录才在同一数据库事务提交。客户端不能提交 `protectedPayloadRef`。

`GET /v2/assets/{assetId}?content=1` 先校验工作区权限，再读取 CAS。受保护附件还需通过 Keychain 或 Vault/KMS 解包 DEK 并完成认证解密。`DELETE /v2/assets/{assetId}` 只允许工作区 owner 调用，要求当前 `expectedStreamVersion` 和删除原因；事务会删除 Asset 与 wrapped DEK，保留对象摘要和原因摘要 tombstone。CAS 密文作为孤立对象等待保留期 GC，删除后的 API 不再提供解密路径。

OPC 的 `record_signal` 在 `sourceKind=file` 时必须提交 `sourceAssetId`。Host 从当前 tenant 读取 Asset，并在写入领域事件的同一事务再次校验工作区归属；跨 tenant 引用表现为不存在，跨工作区引用被拒绝。`record_interview` 不接受 `rawRecord`，只接受 `rawRecordAssetId`，且目标必须是当前工作区内受保护的 UTF-8 纯文本或 Markdown Asset。

机会详情、成果预览和导出会在工作区授权通过后读取受保护 Asset，并只在当前响应中解密访谈原文。OPC 事件、机会投影、幂等记录和持久化成果只保存 Asset ID。Asset 被删除、数据密钥被销毁或调用方失去工作区权限后，读取与导出失败关闭，不使用缓存原文继续响应。访谈原文不能覆盖；后续解释只能通过 `annotate_interview` 追加。

工作区与会话路由负责创建 Thread 和 turn。创建 turn 会先持久化模型可见输入，再返回 queued Execution；客户端从 SSE 或活动页跟踪后续状态。

Coding turn 的 `runnerId` 可选值为 `builtin`、`claude-cli` 或 `codex-cli`。省略该字段时固定选择 `builtin`；非 Coding 会话拒绝 `runnerId`。外部 Runner 必须已在同一工作区确认，Host 才会把 Runner ID 和对应工具权限原子写入 Execution 与 authority commitment。

## Coding Runner 身份

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v2/plugins/coding/runners?workspaceId=...` | 查询内置 Runner 与外部 Runner 确认状态 |
| `POST` | `/v2/plugins/coding/runners/{runnerId}/inspections` | 不执行目标路径，仅检查绝对路径、SHA-256 和文件身份 |
| `POST` | `/v2/plugins/coding/runners/{runnerId}/confirmations` | 再次被动检查并原子保存人工声明的版本和摘要 |

`runnerId` 路径参数只接受 `claude-cli` 或 `codex-cli`。检查请求包含 `workspaceId` 与 `binaryPath`，响应不包含版本，因为 Host 不执行未确认的路径。确认请求还包含由用户核实的 `version`、检查返回的 `sha256` 和当前配置的 `expectedStreamVersion`。这些 mutation 都需要 `Idempotency-Key`。

检查、确认和显式创建外部 Runner turn 前，对应的 `runner-claude-cli` 或 `runner-codex-cli` 插件必须在工作区启用且健康。Host 只从已激活插件的贡献中取得 `external_side_effect` 工具，不为未激活的 Runner 手工授予工具权限。

生产 Worker 只接受官方原生安装提供的 macOS Mach-O CLI，不支持 npm 或 shebang wrapper。Host 不执行待确认路径；确认后，Worker 才会把制品复制到其管理的只读目录，并在受限环境中探测版本。

确认接口不会信任客户端转述的身份：Host 会重新检查同一绝对路径，并要求版本和 SHA-256 与请求完全一致。Worker 在副作用承诺前再次检查持久化身份；任何差异都会 fail closed。外部 CLI 已启动但无法获得确定终态时，Execution 进入 `needs_reconciliation`，同一 Job 不会自动重放。

## Coding 人工核对

`GET /v2/plugins/coding/executions/{executionId}/reconciliation` 返回任务标题、下一步、可用决定、人可读权威证据摘要，以及 core/Coding 当前 stream version。它不返回沙箱或 Runner 制品路径。CLI 会先调用该接口，再自动把两个版本提交给决定接口。

`POST /v2/plugins/coding/executions/{executionId}/reconciliation-decisions` 同时要求 core `expectedStreamVersion` 和 `expectedCodingStreamVersion`。`decision` 支持：

- `terminate`：终止未知调用并把清理 Job 入队；
- `mark_completed`：先返回 `202 verification_pending` 并入队 `coding.reconciliation.verify`；Worker 只验证保留候选，不重放 Runner，权威 Gate 通过并持久化 CodeEvidence 后才原子标记完成。企业环境只有在受信发布配置同时声明验证与清理 handler 时才提供该决定；
- `create_new_call`：终止旧调用并创建新的 Execution 与 Job，不重放旧 Job。

`terminate` 与 `create_new_call` 会在同一数据库事务中收敛旧状态并写入清理 Job、`job.available` 事件及 outbox。`mark_completed` 的首个事务只固定人工意图和验证 Job；验证 Job 的全部业务写入均受租约与 fencing token 保护。Gate 失败时仍保持 `needs_reconciliation`，随后只允许终止或创建新调用。清理 Job 只携带原 Execution ID；Worker 从已持久化的 `externalInvocation` 读取受控路径。详情接口只展示当前确实可执行的决定，并给出新调用就绪状态；停用 Runner 插件后仍可终止，但不能创建新调用。

执行命令包括 `follow_up`、`steer`、`cancel` 和 `resume`。审批决定只接受 `approve_once` 或 `deny`。调用参数、资源、工具版本、generation 或 authority commitment 变化后，原批准失效。

记忆创建接口只生成 proposal，不代表用户接受。客户端不能指定 `protectedPayloadRef`；该引用只能由 Host 的受保护存储链生成。跨 namespace 读取需要显式 share grant；接受、修改、拒绝、撤销和删除都应产生事件。

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
