# 0013：目标与成果验收的单执行者编排

日期：2026-10-09。基线：`0609e2a6fcfb1b9efae0fadf4039888d98df1166`。状态：采用为本次 S1 实施子计划；工程验收另行记录。

## 决策与实施范围

在现有 OPC、Coding Thread 之上增加 Goal、不可变计划和版本化成果验收。每个计划使用一个现有内部 Agent 执行，Host 在同一事务内绑定 Goal、计划、执行与 Job。业务是否成立、代码是否通过权威检查，继续由原领域事实决定。

用户于 2026-10-09 授权依据[多 Agent、多模型提案](../proposals/agent-os-multi-agent-optimization-2026-10-09.md)升级项目，并明确尚未发版、无需兼容。实施顺序为 S0 复用审查、S1 目标与验收，再按依赖推进后续子计划。原提案保留为研究与总体设计；本 ADR 冻结本次允许修改的范围。S1 完成不等于整个提案完成。

本次裁剪复用 `p1-goals@5fde5c01baed233efbd142ac03bad3d503e7f978` 的目标、计划版本、权限检查和成果验收设计，修复[复用审查](../verification/agent-os-s0-reuse-2026-10-09.md)确认的派发与取消恢复缺口。既有 Thread 和领域产物是接入点，不整体引入该分支的研究插件、文档生成依赖及交接流程。

| 本次纳入 | 后续子计划 |
| --- | --- |
| Goal、单执行者计划、原子派发、绑定现有 Thread 的执行、成果验收、Desktop/CLI 入口 | S2：独立节点 Job、目标预算分配和结果汇合 |
| 同一租户及工作区的当前成员、输入和计划版本检查 | S3：能力目录、节点级模型配置和路由决策 |
| 现有内部执行的取消、未知结果核对和事件重建 | S4：通用 Codex/Claude 外部 Runner 委托 |
| 现有 OPC/Coding 权威事实的验收引用 | S5–S7：并行与重规划、受限外部配置、模板/记忆/跟进和策略改进 |

不增加旧版本加载器、协议别名、数据迁移或兼容投影。S1 的公开接口按下一节冻结，完整多节点提案中的其余接口留到对应阶段。

## S1 契约

`GoalV2` 固定 Thread、目标正文、输入版本、交付项、逐项验收条件和执行预算。`GoalPlanRevisionV2` 固定领域输入摘要、插件、Agent、内置 Runner、模型连接及版本、工具、数据范围和预算。模型选择是明确指定的单一连接，不构成自动路由。OPC 和 Coding 均只接收一个完整交付项，多个验收方面写入该项的条款。

`GoalExecutionRefV2` 绑定计划版本、Execution、Thread 和 generation；`GoalDeliverySetV2` 固定成果摘要与验收条件版本。`GoalDeliveryAcceptanceV2` 保存用户接收的成果摘要及已复核条款 ID。Execution 的预算与用量保留原币种；本阶段不增加目标级多币种分配。

| 接口 | 请求要点 |
| --- | --- |
| `GET /v2/workspaces/:workspaceId/goals` | 列出当前可读目标 |
| `POST /v2/workspaces/:workspaceId/goals` | `threadId`、`objective`、`resourceRefs`、`budget`、`deliverables` |
| `GET /v2/goals/:goalId?workspaceId=...` | 返回 Goal、计划及当前成果集合 |
| `POST /v2/goals/:goalId/plan-revisions` | `workspaceId`、`expectedStreamVersion`、`modelBindingId` |
| `POST /v2/goals/:goalId/commands` | `workspaceId`、`expectedStreamVersion`、`command`；`start` 另需 `planRevisionId`、`planDigest`，另支持 `refresh`、`cancel` |
| `POST /v2/goals/:goalId/acceptances` | `workspaceId`、`expectedStreamVersion`、`deliverySetId`、`criteriaVersion`、`items[{key,digest,reviewedCriterionIds}]` |

状态采用 `draft`、`awaiting_authorization`、`running`、`waiting_approval`、`needs_reconciliation`、`failed`、`awaiting_acceptance`、`accepted`、`cancelled`。`accepted` 表示成果已通过程序检查并由用户逐项复核接收。刷新只观察原执行，不创建新尝试。

## 模块与事实来源

`apps/host` 仍是唯一组合根，负责目标规则、领域适配、权限入口及 Shell 共用 API。`packages/contracts` 保存公开数据结构与 API schema；生成文件由生成器更新。产品插件继续只依赖批准的公共契约和 SDK。

Kernel 从现有 `submitTurn` 提取通用的事务内提交原语，供 Host 在已有事务中创建 Execution、Authority、Job、事件、outbox 和幂等记录。原语沿用现有执行准入，不导入 Goal、OPC、Coding 或模板规则。Host 负责检查计划和领域对象，Kernel 负责提交通用执行事实。

持久状态继续由 `KernelEventV1` 及其受保护内容重建。现有 projection journal 将产品投影变更写入带 `protectedPayloadRef` 的 `projection.fact_committed` 事件；不能因方法名为 `putProjection` 就把查询缓存视为独立事实源。生产入口必须配置受保护 journal、CAS 和密钥，缺失时拒绝 Goal 变更。用户目标、验收正文与原始资料不得进入明文事件或幂等表。

本阶段保持现有 Runtime、Job 租约、fencing、模型计量和审批机制。目标服务不引入第二套持久化引擎，也不把进程内 Promise 当成执行状态。

## 生命周期与提交约束

1. 创建 Goal 时固定预期结果、输入引用、验收条件和对应 Thread。读取与变更均核对 tenant、workspace、当前成员和对象授权，不能只检查 URL 中的 ID。
2. 保存计划时生成不可变版本及摘要。授权绑定该版本、输入版本和当前成员资格；改变计划或输入后，旧批准不能启动新执行。
3. 启动时在同一事务内验证当前版本、申请既有执行额度、创建尝试绑定，并提交 Execution、Authority、Job、事件、outbox 与幂等回执。同一 Thread 还有活动执行或待核实用量时拒绝另一个 Goal 启动。失败则整体回滚；事务提交前没有 Worker 可见的 Job。重试相同请求只返回原执行。
4. Worker 在每次模型请求、工具准入和恢复边界检查绑定、计划、输入、成员权限、Execution generation 与 Job fencing。记录属于 Goal 的执行缺少绑定时拒绝继续，不能回退为普通 Thread 执行。
5. 模型上下文和工具承诺仍在外部工作前持久化。未知用量或未知副作用保留原执行和预留，不能换新执行来重试。
6. 取消在同一事务内调用通用执行命令并保存取消意图。原 Execution 存在未知副作用或尚不能确认用量时，Goal 显示 `needs_reconciliation` 并保留预留；确认原执行终态及用量后才显示 `cancelled`。Host 继续同步原执行，刷新和重启均不得清除取消意图或创建新执行。

所有公开变更要求 `Idempotency-Key`；更新已有聚合还要求 `expectedStreamVersion`。幂等重放也检查当前读取权限。多 Host 同时启动同一计划只能创建一个尝试和 Job；租约过期的 Worker 不能提交可验收成果。

公开成果读取重新核对当前来源权限。内部费用核对仅处理原执行和计量事实，不读取或生成交付正文；即使发起成员或来源已撤权，也应记录已发生用量，且不得启动模型请求或新执行。

## 成果与验收

Execution 完成只允许进入成果检查，不能直接完成 Goal。成果集合固定计划版本、执行代际、输入版本、Asset/CAS 摘要和领域检查依据；任何正文或绑定变化都产生新版本，并使旧验收不可用于当前版本。

Host 从持久事实生成程序检查结果。Desktop、CLI 和普通 API 请求提交对指定成果版本的接收决定及已复核条款 ID，不能提交或覆盖 `checks`、测试通过、Gate 或 Evidence。缺少必需产物或检查依据时保留未满足项。

Coding 沿用不可变 Spec、Governance、Harness、Sandbox、Gate 和 Evidence；目标验收不得越过这些检查。OPC 将现有 Worker 的最终答复固定为成果，程序检查验证答复、来源及计量，语义条款由用户逐项复核；本阶段没有独立模型复核。OPC 保留支持证据、反证及真实承诺的区别；目标完成表示交付材料符合要求，不自动证明机会成立，也不授予联系客户、付款或发布权限。

用户接收必须绑定当前成果版本和验收条件。只有必需交付项全部满足领域检查且用户接收后，Goal 才能完成。Shell 展示同一 Host 状态、等待原因和验收结果。

## 实施与退出条件

生产行为按 TDD 实施：先补足以下失败场景，再完成最小改动和受影响回归。保持 Node.js `22.19.x`、npm `11.10.1`、TypeScript `5.7.2`，依赖用 `npm ci` 安装。

| 验证范围 | 可观察的退出条件 |
| --- | --- |
| 原子派发 | 在绑定及提交各边界注入失败，无孤立 Job、无只有派发状态的永久等待；并发启动只有一个尝试和 Execution |
| 权限与并发 | 跨租户、跨工作区、撤权、输入变更、旧计划、旧 generation 和旧 fencing 均不能启动或提交当前成果 |
| 取消与恢复 | 取消意图经真实 Host 恢复循环继续核对；已知费用保留，未知结果不重放，不能以 `cancelled` 掩盖未知结果；撤权后内部结算继续，内容不再向失权用户返回 |
| 事实重建 | 删除可重建投影和幂等缓存后，从认证事件及加密 CAS 恢复 Goal、计划、执行绑定、成果和验收；缺密钥或摘要不符时拒绝恢复 |
| 验收 | 伪造检查、缺少领域证据、成果摘要变化、过期输入及旧验收均被拒绝；OPC 与 Coding 各完成一个单执行者路径 |
| Shell 一致性 | Desktop、CLI 与 API 对同一目标得到相同状态、版本、权限错误和验收结论 |

基线门禁：`npm test`、`npm run typecheck`、`npm run typecheck:desktop`、`npm run build:desktop`、`cargo test --locked`（`apps/desktop-mac/src-tauri`）、`npm run verify:enterprise-fixture`、`npm run verify:plugins`、`npm run verify:onboarding-ui`、`npm run verify:opc-ui`、`npm run verify:coding-ui`、`npm audit --omit=dev`、`git diff --check`。新增 Goal 的 Kernel、Host、契约和 Shell 聚焦测试须纳入对应工作区测试入口；文档执行 `npm run docs:check`、`npm run docs:links`、`npm run docs:build`。

上述内容是验收要求，尚不构成通过记录。最终记录须写明被测提交、环境、执行命令、失败及未运行项。固定模型测试不证明真实模型质量；S1 不宣称多 Agent、多模型、外部 Runner 或完整提案已验收。
