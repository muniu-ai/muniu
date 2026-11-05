# 内置业务提供方

本页面向开发者与运维人员，说明 E5.1 的内置提供方、Host 接口及恢复边界。内置提供方已接入企业业务服务和持久执行体系；Sales 的协议实现、联合身份和双系统流程仍由 E5.2 完成。本页记录实现，不代替工作包出口验收或生产准入记录。

设计依据见[企业经营平台执行计划](proposals/enterprise-operating-platform-2026-11-02.md)和 [ADR 0015](adr/0015-enterprise-operating-platform.md)。共用断言、冻结包导出和 Sales 接入要求见[提供方契约套件](enterprise-provider-contracts.md)。

## 装配与对象归属

`apps/host` 装配 `EnterpriseProviderService`、`EnterpriseBuiltinProvider` 和 `EnterpriseExecutionRuntime`。业务变化仍由 `plugins/business` 的领域规则决定，事实通过企业事件仓库提交到认证事件历史。快照、游标和查询投影不取得业务权威。

`startEnterpriseLocalHost()` 默认装配内置提供方。显式传入的 `executionProviders` 解析器和计量器优先使用。原 Worker 增加 `provider.action.execute` 处理器，与评估、任务共用 Job 存储；`runOperatingCycle()` 每轮只领取一个 Job，不增加第二套队列或执行引擎。启用后台循环时每五秒触发一轮，上一轮未结束时复用正在执行的轮次。存储与 Worker 使用同一注入时钟。

工作区创建时固定 `builtin` 或 `sales` 模式，不提供在线切换。在已装配提供方服务的 Host 中，`POST /v2/workspaces` 创建工作区后初始化版本 1 的 `ProviderBinding`。同一创建请求重发不会重复增版。已有新企业工作区可由管理员通过初始化接口登记绑定；该接口不读取或迁移旧状态。

| 工作区模式 | 对象归属 | 当前可用能力 |
| --- | --- | --- |
| `builtin` | 已登记业务对象均由 `builtin` 负责，每类对象仅一个条目 | 全部条目支持快照和增量读取；客户、商机支持两种跟进动作；报价版本支持出包 |
| `sales` | 客户、联系人、商机、跟进任务、服务版本、报价版本、合同、订单、付款期、到账、退款、调整、费用归 Sales；其余已登记类型归内置提供方 | 当前所有条目的 `supportedPorts` 与 `allowedActions` 均为空，尚未接通实际服务 |

初始化请求只接受 `expectedStreamVersion`，不能由请求指定提供方代码、对象归属或模式。首次登记使用 `0`；后续登记必须匹配当前绑定版本，成功后产生新版本。绑定增版会使依赖旧绑定的执行授权失效。管理员配置权限不自动授予对象读取、业务批准或执行批准权限。

## 五端口

签名以 `packages/plugin-sdk/src/business-provider.ts` 为准，输入输出结构以 `packages/contracts/src/enterprise-providers-schema.ts` 及其引用的企业 schema 为准。端口返回 `supported` 和结果，或明确的 `not_supported`；Host 将不支持的能力转换为 `PROVIDER_CAPABILITY_UNAVAILABLE`。

| 端口 | 内置行为 |
| --- | --- |
| `readSnapshot` | 核对对象原始流版本与摘要，返回对象引用、受保护内容引用和观察时间；历史读取保留历史版本 |
| `listChanges` | 按原业务事件返回变化，包含稳定来源事件标识及对应快照；自身写入保留原操作和工作来源，以便过滤回环 |
| `prepareAction` | 校验当前权限与目标版本，固定输入和有效期，保存受保护准备记录；不创建跟进业务事实，也不正式出包 |
| `executeAction` | 核对真实已承诺动作及原 Job 租约，在同一业务事务中写入效果和提供方回执 |
| `getReceipt` | 查询原 `operationKey` 的持久回执，并重验当前读取权限；缺少可信证据时保持未知 |

准备请求 `EnterpriseProviderActionPreparation` 尚不包含执行授权、预算预留、执行批准或执行状态。正式 `ActionIntent` 由 E3 持久执行体系生成。不能把模型或客户端填写的 `committed` 字符串当作执行资格。

增量读取首次传入 `cursor: null`。游标绑定租户、工作区、主体、提供方绑定版本及权限依据，不能跨主体复用；绑定版本或该主体的角色、对象授权记录变化后，旧游标会被拒绝。每次内容访问仍核对授权期限。重复读取同一游标保留相同来源事件标识，读取本身不产生业务变化。客户端应保存服务返回的 `nextCursor`，不要从时间戳自行推导位置。

## Host 接口

下表对应 `packages/contracts/src/enterprise-api-schema.ts` 中的八项已实现操作。`W` 表示 `/v2/workspaces/{workspaceId}`。完整字段及生成客户端以[企业 OpenAPI](reference/enterprise-openapi.yaml)为准，不手工修改生成文件。

| 方法与路径 | 请求 schema | 响应 schema | 用途 |
| --- | --- | --- | --- |
| POST `W/providers/initializations` | `EnterpriseProviderInitialization` | `ProviderBinding` | 管理员登记固定归属及能力 |
| POST `W/providers/snapshots` | `EnterpriseProviderObjectReference` | `EnterpriseProviderSnapshot` | 读取指定原版本的快照引用 |
| POST `W/providers/changes` | `EnterpriseProviderChangesQuery` | `EnterpriseProviderChanges` | 读取增量变化 |
| POST `W/providers/content/reads` | `EnterpriseProviderContentQuery` | `EnterpriseBusinessObjectView` | 读取快照的受保护内容 |
| POST `W/providers/actions` | `EnterpriseProviderActionCreate` | `EnterpriseActionView` | 准备人工动作并进入统一批准流程 |
| GET `/v2/actions/{actionId}/preview` | 无 | `EnterpriseProviderActionPreview` | 查看固定输入及报价文件描述 |
| POST `W/providers/packages/reads` | `EnterpriseProviderContentQuery` | `EnterpriseProviderPackageContent` | 读取报价文件字节、摘要和正式状态 |
| POST `W/providers/receipts/reads` | `EnterpriseProviderContentQuery` | `EnterpriseProviderReceiptEvidence` | 核对回执、原目标和实际结果对象引用 |

八项操作均通过企业服务端会话识别人员；全部 POST 校验同源和 CSRF。初始化、创建动作是写操作，必须提供 `Idempotency-Key`。其余 POST 为读取接口。内容、文件、证据读取的正文为 `{ "reference": "受保护引用" }`，不能填写文件系统路径或 CAS 地址绕过权限检查。

创建动作需要目标对象引用、`responsibilityId`、`expiresAt` 和对应动作输入。目标引用固定流版本与摘要；初始化及后续审批、取消、核对请求使用各自聚合的 `expectedStreamVersion`。职责能力和字段上限须先由管理员通过[执行配置接口](enterprise-execution-admission.md)登记。

尚未装配 `businessProviders` 的 Host 返回 `PROVIDER_RUNTIME_UNCONFIGURED`。存在工作区但未登记绑定时返回 `PROVIDER_BINDING_REQUIRED`。选择 Sales 模式不会自动启用连接，当前提供方调用返回 `PROVIDER_CONNECTION_UNCONFIGURED`。

## 当前权限与受保护内容

Host 捕获已认证主体；执行端从原授权范围恢复责任主体及身份代次。`BusinessProviderContext` 中的租户、人员、身份代次和租约字段只用于传递受信上下文，本身不授予权限。

快照按当前对象和字段权限筛选，内容加密保存，并绑定读取主体。获得一个受保护引用不等于获得内容权限。读取快照内容、准备预览、报价文件和回执证据时仍检查当前权限；异步读取或加密之后再次检查，防止撤权期间返回旧内容。重复执行只查询既有回执时也进行当前权限复验。

管理员没有默认业务全量读取权。报价预览要求当前价格读取权限；非发起人查看尚未正式出包的准备内容还需要相应执行批准权限。正式文件的读取仍受当前业务权限约束。撤权、成员停用或身份失效后，原请求键和原内容引用均不能恢复读取资格。

## 三类动作与报价批准

| 动作 | 输入 | 业务效果 |
| --- | --- | --- |
| `create_followup_task` | 标题、到期时间，可选描述 | 创建独立跟进任务，并在同一事务中更新目标客户或商机的下一次跟进时间和下一步说明 |
| `update_followup_date` | 下一次跟进时间 | 推进目标客户或商机的独立版本 |
| `issue_quote_package` | 真实 `businessApprovalRef` 与 `docx`、`pdf` 或 `xlsx` 格式 | 为固定报价版本登记正式出包引用，不改变报价金额或客户接受事实 |

人工动作先固定输入，再由执行服务创建动作、授权范围、预算预留和精确批准请求。当前内置动作不调用模型，按零 token、零模型费用记账，但仍创建预算预留和回执。该路径不能用来申请非零模型额度，也不能跳过执行批准。

普通跟进可使用已接受且仍有效的有限策略；策略必须固定负责人、对象范围、能力、有效期和次数。正式报价不能使用自动批准策略，必须同时满足业务批准与逐次执行批准。报价制单人和执行发起人不能批准该正式执行动作；同一名具备两类资格的其他人员可以分别办理两项决定，后台分别留存。

报价准备阶段根据固定报价内容渲染候选文件，将实际字节、SHA-256、格式及准备请求一起保存。预览不表示已正式出包。文件读取的 `official` 由成功提供方回执决定，不能由客户端设置；读取时再次核对实际文件字节摘要。出包不会自动发送客户，也不表示客户已接受、已付款或内部成果已验收。文件资源要求见[知识、成果与流程](enterprise-knowledge-workflows.md)。

## 原租约、未知结果与核对

Worker 传递原 `jobId`、`workerId` 和 `fencingToken`。内置提供方在业务提交前核对实际动作摘要、执行状态、责任主体、当前权限、两类批准及该租约；只有字符串相同而没有真实持久记录的请求会被拒绝。异步保护阶段后再次执行同步提交检查，失败时业务事件和提供方回执一起回滚。

内置业务效果与提供方成功回执原子提交。E3 动作结算随后根据该回执完成；若业务已提交但响应丢失，E3 仍可能处于 `needs_reconciliation`。此时保留原操作标识和预算，通过已有 `POST /v2/actions/{actionId}/reconciliation` 查询原回执，由当前有资格人员核对。不要通过更换请求键或再次执行端口处理未知结果。

成功结算后，`EnterpriseActionView.action.status` 为 `settled`，成功回执的 `status` 为 `succeeded`。同一请求键和相同输入复用原操作；已经结算的动作不会因目标版本已推进或原有效期已过而再次执行。重放仍检查当前权限和职责配置，满足条件时返回同一动作的当前状态；同键更改输入会被拒绝。

没有原回执时，当前生产装配不提供 `hasContinuousHistory` 证明，默认返回 `PROVIDER_RECEIPT_UNAVAILABLE`。不能仅凭到期或记录缺失写成 `not_executed`。该分支仅在受信存储连续性证明、真实原动作、对应到期准备记录及当前权限全部满足时成立；恢复窗口的证明要求和合成测试边界见[提供方契约套件](enterprise-provider-contracts.md)。E7 恢复验收完成前不能将测试中的连续性假定用于生产。

## 验证与当前限制

从已安装锁定依赖的工作树根目录，按顺序执行对应检查：

```bash
npm run verify:provider-contracts
npm run verify:provider-contracts-postgres
```

第一项构建后检查内置五端口、三类动作、Host HTTP、本地装配、原生提交保护及套件自测。第二项使用已构建产物，在隔离 PostgreSQL 上复验提供方和其 E3/E4 依赖；需要 Docker，脚本限制新增数据库容器为 192 MiB、0.5 CPU，并清理本次创建的资源。两项应串行执行，不能与其他重型构建或验收并行；资源不足或环境缺失须记为未运行。

Sales 当前仅登记对象归属和协议形状，尚无真实读取、持久增量轮询、联合身份、跟进回写或报价回执实现；Sales 模式中标为内置负责的对象也未通过该提供方服务启用。接口中存在 `ExternalObjectRef` 联合类型不表示外部目标已经可以执行。真实 Sales、企业微信、双系统流程、灾备容量和试点验收分别属于后续工作包，不能由内置模式或套件自测结果替代。
