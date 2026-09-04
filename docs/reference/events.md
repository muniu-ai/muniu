# 事件与恢复

`KernelEventV1` 是 Agent OS 0.2 的事实记录。查询表、投影、快照、搜索索引和 UI 卡片均可从事件重建。

## 结构

```ts
interface KernelEventV1 {
  schemaVersion: 1;
  id: string;
  tenantId: string;
  position: number;
  aggregateType: string;
  aggregateId: string;
  streamVersion: number;
  type: string;
  occurredAt: string;
  actorId: string;
  executionId?: string;
  generation: number;
  causationId?: string;
  correlationId: string;
  publicPayload: Record<string, unknown>;
  protectedPayloadRef?: string;
  previousDigest?: string;
  digest: string;
  hmac: string;
}
```

`position` 在 tenant 内单调增加，供 SSE 和投影 checkpoint 使用。`streamVersion` 只在一个 aggregate 内递增，供乐观并发使用。两者不能互换。

`publicPayload` 只能包含展示、路由与投影所需的非敏感字段。密钥、原始访谈、客户资料和受保护附件放入加密 payload 或 CAS，并由 `protectedPayloadRef` 引用。

## 写入规则

1. 调用方提供当前 `expectedStreamVersion`。
2. 存储在同一事务中校验版本并追加事件。
3. 同一事务更新投影、Job、outbox、审批状态和幂等记录。
4. 事务提交后才向 SSE、Worker 或外部调用发布可见结果。

版本不匹配返回 `409`。同一个 `Idempotency-Key` 只可绑定同一个规范化请求。CAS 内容先 create-only 写入，事件事务只引用经过摘要校验的对象。

## 核心事件族

| 事件族 | 示例 |
| --- | --- |
| tenant / workspace | `tenant.bootstrapped`、`workspace.created`、`workspace.updated`、`workspace.plugin_activated` |
| thread / execution | `thread.created`、`thread.turn_submitted`、`execution.queued`、`execution.running`、`execution.waiting_approval`、终态事件 |
| tool / approval | `tool.intent_recorded`、`approval.requested`、`approval.approved_once`、`approval.denied` |
| memory / sharing | `memory.proposed`、`memory.accepted`、`memory.rejected`、`memory.shared`、`memory.deleted`、`share_grant.revoked` |
| asset | `asset.created`、`asset.deleted` |
| model connection | `model_connection.saved`、`model_connection.probed` |

插件在自己的 `eventSchemas` 中声明领域事件。事件类型发布后不能重定义；结构或语义不兼容时必须新增类型。

OPC 事件覆盖捕获、成形、信号、访谈、访谈标注、实验、承诺证据、收费方案、暂停、恢复、放弃与人工决策。原始访谈事件不可由模型覆盖，只能追加 annotation 事件。

## 摘要链与 HMAC

事件摘要包含规范化事件内容与 `previousDigest`，HMAC 使用部署密钥计算。验证失败时停止投影重放和 readiness，保留原始介质用于调查。

HMAC 可发现没有密钥的数据库改写，不证明宿主、数据库管理员或 KMS 管理员没有作恶。敏感数据的机密性依赖 AES-256-GCM 与 Keychain/KMS 包装密钥。

## SSE

工作区事件流以 tenant position 作为 SSE `id`。因为服务端会过滤其他工作区事件，收到的 ID 可能跳号。客户端保存最后成功处理的 ID，并通过 `Last-Event-ID` 或 `after` 续传。

游标低于 `retentionFloor` 时返回 `410`。客户端重新读取快照和最新游标，再恢复订阅；不能猜测缺失事件或继续使用旧投影。

## Generation 与恢复

每次执行恢复或 owner 更换都产生新的 generation。模型上下文、工具 intent、批准和 Worker claim 都绑定 generation。旧 generation 的 fencing token、批准或结果不得写入当前执行。

外部副作用结果未知时记录 `needs_reconciliation`，不生成推测性成功或失败事件。人工核对结果必须以新事件追加，不能改写原记录。
