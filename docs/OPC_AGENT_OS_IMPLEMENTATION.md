# Muniu OPC Agent OS v0.3 实施规范

本文规定 `v0.3.0 Developer Preview` 的协议、运行时边界、数据模型、公开接口、迁移和验收条件。产品定位与业务依据见 [OPC Agent OS 产品架构蓝图](OPC_AGENT_OS.md)。

## 1. 状态与基线

| 项目 | 状态 | 依据 |
| --- | --- | --- |
| app-server v2、Agent Event V3、运行时插件 V1、多 Agent 图、企业网关 | 已在 `codex/v0.2-platform` 实现 | 提交 `c9bbc329614e6d9970b6f71f5ba64cabe30848b9` |
| Operation 协议、Spec V2、插件 V2、注意力调度 | 已在 `codex/v0.3-opc-core` 实现 | 提交 `0414c228bc831fac7434b7d69919ac4e74061ea8` |
| OPC 记录、承诺、结算、发布信封和拜访业务包契约 | 已在 `codex/v0.3-opc-core` 实现 | 提交 `0414c228bc831fac7434b7d69919ac4e74061ea8` |
| 多租户存储、app-server RPC、同步执行和外部效果回执 | `v0.3.0` 后续实现 | 本文第 7 至 10 节 |
| 钉钉与 Web 管理端付费试点 | 受控发布目标 | 本文第 11 节 |

DeepSeek Harness 只用于产品比较。代码仍只能适配仓库批准的固定提交，不能从比较基线复制实现。

## 2. 不变量

1. 认证层确定 `tenantId`。业务请求不能通过正文、查询参数或业务包替换租户。
2. `SpecRevision`、`GovernanceSnapshot`、`HarnessManifest`、领域模块和工作流的摘要在 Run 创建后保持不变。
3. Skill、Prompt、业务包和领域模块只能收紧能力，不能绕过工具策略、预算、审批、Gate 或证据追加。
4. 原始事实与派生结果分开保存。派生结果不能覆盖来源，未经确认的模型结果标记为 `proposed`。
5. 高影响动作使用 `ActionIntentV1`。授权绑定输入摘要和 Run generation，不接受宽松重放。
6. 外部效果必须幂等或声明补偿动作。结果不明时记录 `unknown`，禁止自动重试。
7. required Gate 缺失、跳过或无法执行时失败关闭。
8. 生产运行时插件是进程等价可信代码，不向租户开放代码上传。
9. 历史对象保持可读，不重写原摘要，也不把兼容包装声明为新证据。

## 3. 包与职责

| 包或应用 | 职责 |
| --- | --- |
| `@mn/specs` | 读取 V1，创建和校验通用 `SpecRevisionV2` |
| `@mn/runtime` | 校验 `RuntimePluginManifestV2`，管理官方领域模块和连接器 |
| `@mn/operations` | `OperationRunV1`、事件链、动作授权、注意力项和确定性排序 |
| `@mn/opc` | 经营记录、客户承诺、结算、发布协议和拜访业务包 |
| `@mn/evidence` | `LearningProposalV2` 及其评审、试运行、晋升和回滚 |
| `@mn/app-server-protocol` | app-server v2 方法、schema 和错误目录 |
| `@mn/sdk` | 与 app-server schema 同源的 TypeScript 客户端 |
| `apps/api` | PostgreSQL、RLS、S3/CAS、OIDC、事务 outbox 和钉钉回调 |
| `apps/desktop-mac` | 创始人本地事实源、Keychain 密钥和发布队列 |

目标架构把 `coding` 与 `opc` 注册为官方领域模块。现有 `RunRecord` 暂时保留为 `coding` 投影；`OperationRunV1` 是新领域运行的权威对象。

## 4. 通用协议

### 4.1 标识、时间、摘要和金额

- 标识使用已有安全公共 ID 规则，不接受路径分隔符、控制字符和未规范化 Unicode。
- 时间使用规范 RFC 3339 UTC 字符串。
- 摘要使用 64 位小写十六进制 SHA-256，输入采用仓库现有 canonical JSON。
- 金额使用 `MoneyV1 { currency, minorUnits }`。`currency` 是三位大写 ISO 4217 代码，`minorUnits` 是无前导零的十进制整数字符串，允许 `0` 和负成本调整。

### 4.2 `SpecRevisionV2`

```ts
interface SpecRevisionV2 {
  readonly schemaVersion: 2;
  readonly specSetId: string;
  readonly revision: number;
  readonly status: "draft" | "approved" | "superseded";
  readonly domainId: string;
  readonly subjectRefs: readonly SubjectRefV1[];
  readonly title: string;
  readonly objective: string;
  readonly outcomes: readonly string[];
  readonly nonGoals: readonly string[];
  readonly contracts: SpecContracts;
  readonly acceptanceCases: readonly AcceptanceCaseV1[];
  readonly risks: readonly RiskV1[];
  readonly unknowns: readonly UnknownV1[];
  readonly domainExtension?: JsonValue;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly approvedAt?: string;
  readonly approvedBy?: string;
  readonly previousDigest?: string;
  readonly digest: string;
}
```

V2 使用 `domainId` 和 `subjectRefs` 代替面向代码仓库的目标字段。通用合同仍覆盖接口、数据、状态、权限、异常、质量和可观测性。`domainExtension` 只能补充领域数据，不能改变通用合同和摘要规则。

### 4.3 `OperationRunV1`

```ts
type OperationRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "needs_human"
  | "completed"
  | "failed"
  | "cancelled";

interface OperationRunV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly tenantId: string;
  readonly domainId: string;
  readonly subjectRefs: readonly SubjectRefV1[];
  readonly specRef: VersionedDigestRefV1;
  readonly governanceDigest: string;
  readonly harnessDigest: string;
  readonly domainModuleRef: VersionedDigestRefV1;
  readonly workflowRef: VersionedDigestRefV1;
  readonly generation: number;
  readonly status: OperationRunStatus;
  readonly currentStage: string;
  readonly budgetUsage: Readonly<Record<string, number>>;
  readonly evidenceHeadDigest?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Operation 编译入口只接受 `approved` Spec。恢复执行可以增加 generation，但必须复用 Spec、治理、Harness、领域模块和工作流摘要。

### 4.4 事件、动作和授权

`OperationEventV1` 使用 `(tenantId, runId, sequence)` 唯一键和 `previousDigest` 组成摘要链。事件可以引用 Agent Event、Artifact、Gate、外部回执和业务记录，载荷使用受保护 JSON 视图。

`ActionIntentV1` 必须包含稳定 `effectId`、目标引用、`inputDigest`、`governanceDigest`、Run generation、后果等级、可逆性、补偿引用、幂等键和失效时间。后果等级为 `low | medium | high | critical`。

`AuthorityDecisionV1` 支持：

- `approve`：为完全匹配的动作意图生成一次授权；
- `reject`：终止当前动作；
- `request_changes`：不授权，Run 转 `needs_human`；
- `defer`：不授权，必须给出未来的 `deferUntil`。

授权检查失败返回 `STALE_DECISION`，不得回退到会话级宽松授权。

### 4.5 注意力调度

`AttentionItemV1` 保存来源类型、来源 ID、后果等级、`dueAt`、受阻承诺、预计人工分钟、可处理角色、证据引用、输入摘要和状态。

待处理项按以下元组稳定排序：

```text
overdue DESC,
consequenceTier DESC,
earliestCommitmentDueAt ASC,
blockedCommitmentCount DESC,
createdAt ASC,
id ASC
```

模型分数、自然语言中的紧急措辞和提示词不能参与排序。治理可以设置 SLA、允许角色和人工预算，但不能改变排序字段语义。

## 5. 领域模块与业务包

### 5.1 `RuntimePluginManifestV2`

V2 保留 V1 的 `name`、`version`、`integrity`、`entry`、Skill、MCP、Hook、Tool、配置 schema 和必需能力，增加：

- `release.sequence` 与 `release.publishedAt`；
- Ed25519 `signature`；
- `trustClass: official-domain | official-connector`；
- `contributes.domains/recordSchemas/workflows/gates/connectors/renderers`；
- 稳定 `externalEffects`；
- 版本化 migration 清单。

当前首批实现完成签名、完整性和宿主能力校验，并保留 V1 兼容。生产加载的后续目标是增加迁移预检、新 Cordis Context 健康检查、原子切换和全过程审计；任一步失败都必须保留旧 Context。

### 5.2 `BusinessPackManifestV1`

业务包包含 `id`、`version`、`domainId`、字段 schema、状态机、工作流引用、Gate 引用、审批模板、验收案例、Renderer 引用和 Connector 引用。解析器拒绝以下内容：

- `entry`、JavaScript、命令或动态表达式；
- 未在领域模块注册的 effect、Connector、Gate 或 Renderer；
- 放宽租户治理或扩大数据范围的声明；
- Secret 值和跨租户引用。

Skill 和 Prompt 只引用业务包允许的能力，不能贡献 effect 或权限。

## 6. OPC 记录

`BusinessRecordEnvelopeV1` 是追加修订信封：

```ts
interface BusinessRecordEnvelopeV1<T extends JsonValue> {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly domainId: "opc";
  readonly kind: string;
  readonly id: string;
  readonly revision: number;
  readonly status: "proposed" | "verified" | "superseded" | "void";
  readonly payload: T;
  readonly payloadDigest: string;
  readonly previousDigest?: string;
  readonly digest: string;
  readonly createdAt: string;
  readonly createdBy: string;
}
```

`CustomerCommitmentV1` 必须写明客户账户、承诺结果、范围、非目标、金额、期限、数据授权、验收标准、双方责任和批准人。批准后修改任一字段都创建新修订和新 Spec，不修改活动 Run。

`SettlementRecordV1` 记录合同、开票、到账、模型成本、外部服务费和人工分钟。每个金额或时间值都引用合同、发票、银行回执、用量回执或人工确认。该协议没有付款、退款和自动报价 effect。

## 7. 公开接口

app-server v2 保持当前 `initialize` 能力协商和 `muniu/*` 命名方式。新增方法：

```text
muniu/domain/domains/get
muniu/domain/runs/post
muniu/domain/runs/byId/get
muniu/domain/runs/byId/events/get
muniu/opc/records/post
muniu/opc/records/byId/revisions/post
muniu/opc/commitments/byId/approve/post
muniu/opc/commitments/byId/runs/post
muniu/attention/items/get
muniu/attention/items/byId/decide/post
muniu/action/intents/byId/decide/post
muniu/opc/deliveries/byId/acceptances/post
muniu/opc/settlements/post
muniu/evidence/domainRuns/byId/export/get
muniu/extension/businessPacks/get
muniu/extension/businessPacks/byId/enable/post
muniu/sync/publications/post
muniu/sync/receipts/get
```

所有写方法要求 `requestId` 和 `expectedRevision`。服务端从认证上下文加入 `tenantId`。app-server 和 SDK 使用同一份 schema，内部 REST 路由不属于公开接口。

错误目录固定为：

- `REVISION_CONFLICT`
- `TENANT_SCOPE_VIOLATION`
- `STALE_DECISION`
- `APPROVAL_REQUIRED`
- `POLICY_DENIED`
- `BUDGET_EXHAUSTED`
- `EFFECT_OUTCOME_UNKNOWN`
- `DOMAIN_MODULE_UNAVAILABLE`

## 8. 存储与隔离

PostgreSQL 使用以下逻辑表：

- `domain_record_revisions`
- `operation_runs`
- `operation_events`
- `attention_items`
- `action_intents`
- `authority_decisions`
- `effect_receipts`
- `settlement_records`
- `publication_outbox`
- `publication_receipts`
- `business_pack_bindings`

所有唯一键和外键包含 `tenant_id`。API 在事务开始后设置租户上下文，RLS 作为第二道隔离。对象存储键包含租户和内容摘要，服务端拒绝客户端提供完整对象键。

SQLite 使用同一存储端口和约束，支持创始人本地权威库。私有机会、报价和内部笔记默认不发布。`PublicationEnvelopeV1` 明确目的、目标租户、字段白名单、保留期、源摘要和幂等键；云端只能返回新回执，不能修改本地源记录。

本地敏感字段使用 macOS Keychain 保存的 AES-GCM 密钥。云端使用每租户 KMS/Vault 引用。Secret 不得进入业务包、事件、日志、fixture 或导出包。

## 9. 拜访助手

`opc.visit-assistant@1` 定义 `Visit`、`VisitSource`、`VisitBrief`、`VisitClaim`、`Commitment`、`NextAction` 和 `WritebackRequest`。状态机为：

```text
draft → prepared → in_progress → processing → review_required
      → confirmed → writeback_pending → completed
```

`failed` 和 `cancelled` 是终态。`confirmed` 可以直接进入 `completed`，表示只归档、不写回。

转写、摘要和字段提取分别版本化。每个确认字段必须引用原始语音或文本片段。钉钉待办、CRM 写入和外部消息先生成预览与 `ActionIntentV1`，授权后由 Connector 执行并保存资源 ID、响应摘要和结果状态。

钉钉回调验证签名、时间窗和幂等键。租户映射来自安装记录，不能从回调正文直接信任企业或租户 ID。

## 10. 迁移

1. `SpecRevisionV1`、`RunRecord`、`AgentEventV3` 和 `LearningProposalV1` 保持可读。
2. OPC 只创建 V2 Spec 和 `OperationRunV1`。
3. 新编程 Run 同时写 `OperationRunV1` 和旧 `RunRecord` 投影，兼容期为一个产品版本。
4. 历史 Run 使用带 `legacySourceDigest` 的只读包装，不生成虚构事件或新证据头。
5. Runtime Plugin V1 继续用于已有单租户配置；多租户领域模块和连接器必须使用签名 V2。
6. `LearningProposalV2` 单独增加 `business_pack`、`workflow` 和 `plugin_config`，不扩大 V1 枚举。
7. 数据迁移先写 shadow 表并校验数量与摘要，再切换读取；失败时旧表保持权威。

## 11. 测试与发布

测试先覆盖失败行为，再写实现。最低场景包括：

- V1/V2 schema、摘要和兼容投影；
- 插件签名篡改、能力缺失和原子切换失败；
- 跨租户 RPC、缓存、检索、对象存储、会话恢复和钉钉回调；
- 承诺修订、审批过期、输入摘要变化和 generation 变化；
- 注意力排序稳定，模型分数不参与权限或优先级；
- 未批准效果失败关闭，重复回调幂等，未知结果不盲目重试；
- 原始事实不可覆盖，确认字段能回溯来源；
- 本地发布默认拒绝，字段白名单生效，云端不能修改本地源；
- 拜访材料、人工确认、批准写回、回执、验收和结算的端到端流程；
- 支付、退款和自动价格承诺没有可调用 effect。

仓库验证命令包括现有基线以及：

```text
npm run verify:domain-compat
npm run verify:opc-contracts
npm run verify:opc-tenant-isolation
npm run verify:visit-pilot
```

试点按只读影子运行、草稿、批准后写回、有限自动化四个阶段开放。每个租户、Connector 和 effect 都有单独开关、容量上限和人工接管入口。公开 GA 不在 `v0.3.0` 范围内。

商业验证记录 15 次目标访谈、3 个付费试点、每周真实使用、至少 1 次续费、2 个跨客户业务包，以及每个客户每月人工投入。数字是发布决策目标，不是现有成果。
