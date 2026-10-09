# Agent OS S0 复用审查

日期：2026-10-09。主分支基线：`0609e2a6fcfb1b9efae0fadf4039888d98df1166`。结论：裁剪复用 P1 的 Goal 与版本化验收设计，先修复原子派发和取消恢复；P2/P3 按功能保留为后续候选，禁止整体合并。

用户已授权依据[总体提案](../proposals/agent-os-multi-agent-optimization-2026-10-09.md)升级尚未发版的项目。实施先完成 S0，再按 [ADR 0013](../adr/0013-goal-delivery-orchestration.md)执行 S1；该范围不等于 S0–S7 全部完成。提案原文作为研究记录保留，本记录与 ADR 说明本次采用的范围。

## 候选及提交关系

| 候选 | 固定提交 | 直接父提交 | 本次处理 |
| --- | --- | --- | --- |
| 草稿保护与导航 | `ede15b5da0ec5c5dd29d68a42f9ff3bd991c539e` | `0609e2a6fcfb1b9efae0fadf4039888d98df1166` | P1 的前置差异，按需要独立选择，不整体吸收 |
| P1 目标与交付 | `5fde5c01baed233efbd142ac03bad3d503e7f978` | `ede15b5da0ec5c5dd29d68a42f9ff3bd991c539e` | 裁剪到现有 OPC/Coding Thread 单执行者路径 |
| P2 方法与上下文复用 | `7938bde2c9ae8482018e4a4b0a0f58c35d4433d7` | `5fde5c01baed233efbd142ac03bad3d503e7f978` | 保留候选，本次不引入模板和记忆新行为 |
| P3 跟进与方法改进 | `df6f8aaaae8ae6e9621bf5de27aab24884a54f8a` | `7938bde2c9ae8482018e4a4b0a0f58c35d4433d7` | 延至 S7，并调整无变化时的模型调用方式 |

三个候选都不是基准 main 的祖先。P2/P3 是依赖前序契约的连续提交，不能按分支名当作独立组件。下文文件与行号均指表中的固定候选提交，不能用于定位本次裁剪后的源码。

## 事实来源与模块边界

P1 已包含 Goal、计划修订、预算预留、执行引用、成果集合、程序检查和语义复核，并非仅保存对象链接。P2/P3 在此基础上增加方法模板、上下文选择、跟进和配对试验，因此另建一套无关 Goal 系统会造成重复。

这些服务的 `putProjection` 由存储层受保护 journal 捕获：`packages/storage/src/projection-journal.ts:108` 的默认范围包含 `*non-core`，`:280–329` 将变更写为带加密 CAS 引用的 `projection.fact_committed` 事件。事件及受保护内容仍是事实来源。不能仅因业务事件的公开字段只含 ID，就断言对应状态不可重建。

`apps/host/test/goal-templates.test.ts:71–93` 和 `research-schedules.test.ts:116–128` 包含删除投影及幂等表后重建的测试。此处确认的是测试代码和存储机制；本轮静态审查没有重新执行这些测试。S1 必须保留生产 journal 配置、事件完整性和 CAS/密钥失败时拒绝恢复的行为。

Host 保持唯一组合根。S1 在 Kernel 中只提取事务内通用 `submitTurn` 原语，领域准入和成果验收留在 Host 与原插件端口。新代码不引入早期协议、兼容加载器或迁移流程。

## P1：复用范围与必须修复的缺口

复用目标、不可变计划、稳定执行引用、版本及幂等检查、成果集合摘要和验收绑定的设计与适用测试。研究插件、PDF/DOCX 生成、跨领域交接及其依赖超出本次单执行者范围，不作为 S1 的前置条件。

| 已确认问题 | 固定提交中的证据 | S1 处理与验证要求 |
| --- | --- | --- |
| 派发跨多个事务；中间崩溃可能永久停留在派发中 | `apps/host/src/goals.ts:493–507` 先写 `dispatching` 再调用 `ports.start`；`goal-runtime.ts:353–364` 再建 Operation/Thread，`:197–213` 提交 Execution 后才绑定；恢复在 `:632–635` 遇到无查询结果直接跳过 | Goal/计划/尝试绑定与 Execution、Authority、Job、outbox 同事务提交；对每个提交边界做故障注入，确认回滚或恢复同一执行 |
| Job 可能早于 Goal 的执行绑定对 Worker 可见 | `apps/host/src/goal-runtime.ts:468–470` 找不到 Operation 就返回 | 原子创建绑定；Worker 对属于 Goal 而绑定缺失的执行拒绝外部工作，测试提交后立即领取的情况 |
| 取消先写 Goal 终态，Host 周期恢复不再处理该目标 | `apps/host/src/goals.ts:544–548` 立即 `cancelled`；`goals-api.ts:183–184` 在另一调用传播取消；`host.ts:3005–3006` 排除该状态 | Goal 取消与原 Execution 命令同事务；原 Execution 保留待核对状态，Host 继续核实已取消目标的用量 |
| 现有取消测试不足以证明生产恢复 | `apps/host/test/goal-final-audit.test.ts:47–90` 依赖手动推进 | 增加 Host 生命周期测试：取消后重启仍核对原执行，不重复派发，不清零未知预留 |
| 从未派发模型请求的执行也可能一直显示未知用量 | `apps/host/src/goal-runtime.ts:277` 没有 `model/settled` 就不产生已知用量 | 区分无请求、请求已知结算及请求结果未知；仅有事实证明未发请求时可确认零用量 |
| 验收没有独立标准版本和逐条复核记录 | `packages/contracts/src/goals.ts:44–81` 缺少对应字段；`apps/host/src/goal-coding.ts:252` 根据 Gate 和批准直接标记 `semantic: verified` | 固定 `criteriaVersion`，程序检查保存证据引用；用户以 `reviewedCriterionIds` 明确逐条复核，不能把程序检查当作语义结论 |
| 人工停止可直接进入已接收状态，与本阶段出口定义不符 | `apps/host/src/goals.ts:570–573` 允许停止决定以空验收清单进入 `accepted` | 停止与验收分开；必需成果及条款未满足时不能进入 `accepted` |

验收字段只能由 Host 根据领域事实生成，Shell 不提交 `checks`。Coding 保留 Spec、Governance、Harness、Sandbox、Gate、Evidence 绑定；OPC 保留证据与人工商业决定的界限。后续 S2–S5 再增加独立节点 Job、多币种额度、模型路由和并行调度。

## P2/P3：保留的候选与延期理由

| 功能 | 已核实的设计与测试范围 | 采用决定 |
| --- | --- | --- |
| P2 本地记忆筛选 | `apps/worker/src/memory-retrieval.ts` 限制 6 个身份、8 KiB，保留完整来源；`memory.ts:124–204` 在读取和模型请求提交时复查来源、任务及代际。测试覆盖解密期间撤权、未进入请求不登记采用、来源变化后禁止继续外发 | 算法和安全检查可选择性复用；本次不增加记忆行为，待节点上下文契约确定后纳入 S7 |
| P2 按步骤选择技能 | `apps/host/src/goal-skills.ts` 核对计划/执行绑定、能力、技能版本与工具权限，按 UTF-8 字节限额；测试包含计划绑定和事件重建 | 保留候选，不能把技能文本当作授权或业务事实 |
| P2 私有方法模板 | `goal-templates.ts:53–76` 核对精确成果验收；`goal-template-method.ts` 只提取方法结构和人工节点；新实例不继承旧资料、批准和预算，在途实例固定旧版本 | 延至 S7；固定工作流枚举需按新的节点契约适配，不能整体复制原系统 |
| P3 固定资料跟进 | 草稿与启用分开；固定来源、授权摘要、有效期、单次/累计额度；稳定运行 ID 与 Goal 在事务内创建；未知用量阻止重新启用。测试覆盖并发领取、重复时刻、取消、到期和重建 | 延至 S7；当前单币种、Host 定时扫描及固定研究流程不构成 S2–S5 调度实现 |
| P3 方法配对试验 | 固定新资料、模型配置、相同预算和成果摘要；禁用记忆/搜索；取消、未知结果及控制条件变化不能判为候选胜出；明确采用后新增模板版本 | 延至 S7；复用治理和测试样本，真实模型质量、留出集及用户评价仍需独立验收 |

P3 的无变化策略需要重做：`apps/host/src/research-schedules.ts:118–155` 在完整研究完成后比较来源，`:259–267` 每个周期先创建新 Goal。`research-schedule-flow.test.ts:72–81` 验证无变化不通知，但相同正文仍执行研究。总体提案第 6.4 节要求没有变化时不反复调用模型；后续应先通过确定性读取和摘要比较判断变化，再准入模型任务。

P3 的 Host 通过每 500 ms 扫描推进目标（`apps/host/src/host.ts:3066–3093`）。这不证明已具备事件唤醒、父子 outbox 汇合、公平性、冲突资源锁或外部 Runner 恢复。本次不以这些候选替代后续阶段验收。

## 本次证据边界与退出记录

本记录依据固定提交关系、源码、相邻测试和候选验证文档的静态审查。候选中的 `docs/verification/goal-upgrade-p2-2026-10-08.md`、`goal-upgrade-p3-2026-10-09.md` 分别报告 983 项和 1,032 项测试通过，同时注明企业 fixture 缺少 Docker，真实模型质量与签名发布验收未完成。这些历史结果不能算作本次工作树的测试结果。

S0 已确定候选依赖、选择范围、关键修复及模块边界。S1 的生产行为、生成契约和工程门禁按 ADR 0013 验收；执行结果须另行补充，不得用文档检查证明产品门禁通过。
