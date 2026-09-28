# 核心概念

本文解释架构、API 和运维文档共用的术语。组件依赖见[架构](architecture.md)，操作步骤见[快速开始](quickstart.md)和[企业运维](enterprise-operations.md)。

## 运行组件

| 术语 | 含义 |
| --- | --- |
| Host | 唯一组合根，装配 Kernel、Runtime、存储与插件，并提供 `/v2` 接口 |
| Kernel | 通用执行与治理内核，管理权限、审批、事件和恢复控制，不包含行业规则 |
| Agent Runtime | 管理 Scope、AgentHandle、Inbox、Session 与预算的执行层，通过注入端口持久化 |
| Worker | 领取持久 Job 的执行器，使用租约和 fencing token 提交结果 |
| Shell | Desktop、CLI 等交互入口；经营视图和专业视图只改变展示，不改变业务行为 |
| 产品插件 | 经 Host 装配的产品贡献，例如 OPC、Coding 和 Runner；使用公共契约与 SDK |
| `@mn/business-execution` | Host 与 Worker 共用的私有行业执行服务；不是公共插件 SDK |

生产插件是与宿主进程权限等价的可信代码。签名和清单校验不能隔离恶意插件；`ExecutionAuthority` 只约束 Agent 和经过内核准入的工具调用。完整限制见[插件信任边界](plugin-authoring.md#信任边界)。

## 身份与执行范围

| 术语 | 含义 |
| --- | --- |
| Tenant | 租户范围；身份、事件位置、插件安装和数据查询都按租户隔离 |
| Workspace | 工作区；成员角色、插件激活和业务资源的使用范围 |
| Thread | 会话；组织用户与 Agent 消息，可关联业务对象 |
| Execution | 一次持久执行；保存发起人权限、预算、执行状态和恢复要求，可包含多个 turn |
| Turn | 执行中的一轮处理；轮次开始后固定贡献 generation |
| Job | Worker 可领取的持久任务；其物理状态与 Execution 状态不是同一个对象 |
| Generation | 本轮贡献和执行配置的版本边界，用于检查恢复与批准是否仍适用 |

插件安装属于 tenant，启用属于 workspace。Scope 按 Host、Tenant、Workspace、Thread、Execution、Subagent 逐级组织；子 Scope 只能取得父级权限、预算和数据范围的子集。

## 事实与查询状态

`KernelEventV1` 是事实记录。它包含公开元数据，以及需要保护时指向加密正文的引用；正文保存在 CAS 中。CAS 是按内容摘要寻址的存储，本地使用文件目录，企业使用 S3。

查询投影和快照用于读取，不能替代事实。当前实现还用 `projection.fact_committed` 事件认证受保护查询状态的加密事实；查询表保存 `muniu.projection.reference`，授权读取时解密。重建要同时验证事件链和引用内容，因此只备份数据库事件表不足以恢复受保护内容，还需要 CAS 和相应密钥。

OPC、Coding 与签名插件的领域仓储目前仍由 Host 数据端口承载。业务主数据归应用所有这一边界，不表示已经完成应用独立数据库或独立消息协议。实施范围见 [ADR 0012](adr/0012-application-boundaries.md)。

## 版本、重复提交与恢复

| 标识或状态 | 用途 |
| --- | --- |
| `position` | tenant 内单调递增的事件位置，用于 SSE 续传 |
| `streamVersion` | 单个聚合的事件版本，用于并发控制 |
| `expectedStreamVersion` | 更新时声明预期版本；版本不符时拒绝提交 |
| `Idempotency-Key` | 识别同一次变更请求，防止重复提交造成重复写入 |
| fencing token | 每次 Job 租约的提交凭据，阻止旧 Worker 在接管后提交 |
| `needs_reconciliation` | 外部副作用结果未知，必须人工核对；不能自动重放原调用 |

模型上下文和工具承诺在外部调用前持久化。幂等键不能证明外部系统是否已经完成操作；未知结果仍须保留核对状态。具体恢复限制见[事实、并发与恢复](architecture.md#事实、并发与恢复)。
