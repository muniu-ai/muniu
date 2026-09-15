# Agent OS 0.2 架构

0.2 使用通用内核和统一事实模型。Desktop、CLI 与 HTTP API 是 Shell；OPC、Coding 与外部 Runner 通过插件贡献能力。0.1 数据与协议保持隔离，不提供迁移或兼容入口。

```text
Desktop / CLI / API Shell
            ↓
       apps/host（Cordis）
            ↓
  contracts / kernel / agent-runtime
       ↙                    ↘
  OPC 插件                Coding 插件
                              ↘
                  Claude / Codex Runner Adapter
            ↓
       storage / apps/worker
```

## Scope 与贡献解析

Host 在 Cordis 插件中创建 Kernel，并通过同一个组合根启动本地和企业 Worker。产品插件按租户、工作区创建子上下文；AgentScope 的贡献注册表和资源清理由 Cordis 子上下文持有。Scope 层级如下：

```text
Host
└── Tenant
    └── Workspace
        └── Thread
            └── Execution
                └── Subagent
```

- Host Scope 装载身份、事件、存储、插件和运行时定义。
- Tenant 与 Workspace Scope 决定插件激活、成员权限和数据范围。
- Thread Scope 隔离 Session、Tool 与 Model。
- Execution 与 Subagent Scope 只获得父级权限、预算、工具和数据范围的子集。
- Prompt、LLM、Tool、Skill、Job 与 Subagent 从 Scope 内的贡献注册表解析。每个 turn 固定 generation；开发热更新只影响下一 turn。

Scope 销毁撤销其资源和子 Scope。产品插件通过 `onDispose` 注册清理操作；停用或升级时释放旧版本资源，Host 退出时递归清理。签名插件仍是进程等价可信代码，内核无法约束插件自行创建且未登记的资源。内核不得导入产品插件，插件通过公共契约访问领域状态。

## Agent 与 Session

`AgentHandle + Inbox` 是执行入口，支持 `follow_up`、`steer`、`cancel`、`resume` 和 `whenIdle`：

- `follow_up` 按 FIFO 进入下一 turn。
- `steer` 只在下一模型边界注入，不改写已经持久化的上下文。
- 本轮结束时仍未应用的 `steer` 会保留，执行进入 `paused`，由人恢复或取消。
- `resume` 只接受 `paused` 或 `interrupted`。
- 内部 `inject` 不向普通插件开放。

Session Log 保存模型可见上下文。Surface 和 Compaction 可以改变模型看到的内容，但不能覆盖事实事件、原始访谈或工具记录。模型请求的完整上下文必须先持久化，再发送给模型服务。

Thread 输入、Inbox 消息和 RuntimeRecord 正文使用独立 DEK 加密后写入 CAS；数据库事件只保存引用与执行元数据。运行时可从事件恢复丢失的记录索引。后续 turn 从同一 tenant、workspace、plugin 和 thread 的已完成 Execution 读取历史用户与助手消息。OPC 上下文另行装入当前机会的证据、反证和授权访谈资料，并标记为不可信业务输入，不能据此修改权限。

已提交轮次通过 Thread 的 `threadStreamVersion` 排序，读取对话历史不依赖 SSE 游标保留期。CodingExecutionEngine 作为编译期定义的 Job 接入 AgentHandle，按 FIFO 消费后续消息，并在模型边界接收 steer。每轮固定不可变 Spec、Governance、Harness 和仓库索引；审批后的成果按 turn 分开保存。Job 恢复只读取已提交检查点，未知副作用进入人工核对。

执行时间预算从首次执行开始计时并持久化，包含等待和中断时间；恢复或下一 turn 不重置期限。Coding 在修复前持久化预算预留，同一 Execution 最多自动修复三次，跨 turn 和 generation 累计。子 Agent 的身份与权限预算也先预留、后创建，父 Agent 重启后不能重置累计配额。耗尽后进入人工决定；外部 Runner 已启动但结果未知时仍进入人工核对，不能按普通超时重试。

OPC 与 Coding 内置 Runner 通过 `PersistentModelBudget` 在发送模型请求前预留额度，按厂商返回用量单次结算。父 Agent 的模型消耗与子 Agent 预算分配共用额度；请求用量未知时保留预留，暂停执行并生成收件箱提醒，重启与 `resume` 不会重发请求。会话和活动页显示原币种预估费用；经营视图与专业视图使用同一用量接口。外部 Runner 不由木牛接管模型连接，不能从 BYOK 账本推断其 token 或费用，界面要求核对厂商账单。

参考价格按厂商公布币种记录，不隐含汇率换算，也不代表账单保证。价格来源为 [OpenAI GPT-5](https://developers.openai.com/api/docs/models/gpt-5)、[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) 和 [DeepSeek](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，核对日期为 2026-09-06。DeepSeek 采用高峰参考价估算；输入预检使用明确标注的 UTF-8 保守估算，实际用量超出预留后停止后续调用。OpenAI 与 Anthropic 的预检使用厂商计数接口。模型用量包含输出中的推理 token，不能重复计入。

Execution 状态为：

```text
queued → running → waiting_approval → completed
                    ↘ paused / interrupted / needs_reconciliation
                    ↘ failed / cancelled
```

人工核对保留候选时，Worker 重新校验 Spec、Governance、Harness、仓库索引的内容及绑定，并在验证前后重新计算当前 sandbox 配置摘要。内容、版本或执行配置不一致时保留人工核对状态，不沿用旧摘要生成通过证据。

Workflow 使用类型化声明式状态机，不执行插件提供的任意 JavaScript 工作流。

## 事实、并发与恢复

`KernelEventV1` 是事实记录，包含：

- tenant 级单调 `position`，供 SSE 断点续传；
- aggregate 级 `streamVersion`，供乐观并发；
- `causationId`、`correlationId` 与 generation；
- 公开 payload 与加密 payload 引用；
- 前序摘要、当前摘要与 HMAC。

所有写入提供 `expectedStreamVersion`。版本冲突返回 `409`。事件、投影、Job、outbox、审批和幂等结果在同一数据库事务提交。查询表与快照应能从事件重建，不得作为事实源。

`replayCoreProjections` 校验 tenant 事件链的连续位置、摘要和 HMAC，并重建核心元数据。生产 Host 与 Worker 的非核心投影写入加密事实日志；SQLite 与 PostgreSQL 的 `rebuildProjections` 在一个事务内校验并恢复核心、产品查询投影及受保护幂等结果。重建不执行模型、工具或 Job，不重建物理任务队列。CLI 备份恢复会在新目录执行这项验证，成功后才允许启动；企业通过 `maintenance:enterprise` 在停机维护窗口验证、重建和清理孤儿对象，不能手工删除运行中的表。前置检查、数据库连接隔离和失败恢复步骤见[企业运维](enterprise-operations.md)。

文件先按摘要 create-only 写入 CAS，再在事务中提交事件引用。引用校验覆盖所有历史事件与加密投影事实，不能只扫描当前查询表。企业离线维护入口在完整校验后按保留期清理未提交的孤儿对象；运行中的写入必须先停止，不提供在线定时清理。已经提交的事件不会因 Host 或 Worker 重启而丢失。

本地 Host 在整个生命周期持有状态目录的 OS 文件锁。正常关闭后释放文件描述符，进程崩溃后由 OS 释放；不能通过换端口启动第二个使用同一状态目录的 daemon。锁文件保留，不通过删除文件解除活跃锁。macOS 使用系统 `lockf` 的文件描述符模式；Linux 本地开发使用系统 `flock`，缺少工具时拒绝启动。

冷启动在接受 HTTP 请求和启动 Worker 前检查 GC。距上次成功清理满 24 小时时，校验所有租户的完整事件与历史密文引用，再清理超过 7 天的孤儿对象；空数据库不授权清理。引用校验预算为 10 秒，超时或校验失败时不进入删除阶段，核心页面仍可启动，readiness 和 Doctor 显示维护问题。清理成功写入审计事件和下次检查时间，不重新执行模型或工具调用。

Job 使用至少一次投递、30 秒租约与 fencing token。数据库拒绝陈旧 Worker 的续租和提交。外部副作用若无法确认结果，Execution 进入 `needs_reconciliation`，等待人选择终止、标记已完成或创建新调用；系统不会自动重放原调用。

Host 与 Worker 的 PostgreSQL 连接固定使用 20 秒 `idle_in_transaction_session_timeout`。Pod 丢失但 TCP 连接未关闭时，数据库会回滚长期空闲的未提交事务并释放租户锁，避免它阻塞租约接管。该限制同样适用于正常事务：外部存储长时间无响应会使事务失败，调用方不能自动重放结果未知的写入。参数语义见 [PostgreSQL 16 文档](https://www.postgresql.org/docs/16/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT)。

## 权限与工具

`ExecutionAuthority` 同时约束 Agent 与经内核调用的工具。每次调用在执行前持久化工具标识、参数摘要、资源摘要、generation 和 authority commitment。

工具 effect class 固定为：

| 类别 | 默认处理 |
| --- | --- |
| `local_read` | 可按策略自动执行 |
| `external_read` | 可按策略自动执行 |
| `local_reversible_write` | 可按策略自动执行 |
| `local_irreversible_write` | 需要 `approve_once` 或 `deny` |
| `external_side_effect` | 需要 `approve_once` 或 `deny` |
| `financial` | 需要 `approve_once` 或 `deny` |
| `privileged` | 需要 `approve_once` 或 `deny` |
| `unknown` | 需要 `approve_once` 或 `deny` |

执行前重新规范化路径和资源摘要。工具版本、参数、资源、generation 或 authority commitment 变化时，原批准失效。提示文本不能授予权限。

## 存储实现

本地实现使用：

- SQLite WAL 与 `synchronous=FULL`；
- 文件 CAS；
- macOS Keychain 包装数据密钥；
- AES-256-GCM 加密敏感 payload。

企业实现使用 PostgreSQL schema `mn_v2`、S3 `v2/` 对象前缀与 Vault/KMS。事件 HMAC 能检测没有密钥的数据库改写，不用于抵御宿主或 KMS 管理员失陷。

受保护 Asset 的明文先由随机 DEK 和 AES-256-GCM 加密，CAS 只接收密文。Asset 保存密文摘要，独立的可删除密钥记录保存 wrapped DEK 与认证参数。查询重建不会恢复已删除的密钥记录。删除事务移除当前 Asset 与密钥记录，并追加只含对象摘要和原因摘要的 tombstone 事件。历史事实仍引用的密文保留，业务内容通过销毁对应独立包装密钥变得不可解密；GC 只删除没有历史引用的孤儿对象。

每份敏感 payload 使用独立的 Keychain 包装密钥或 Vault transit key。删除先提交 tombstone 与密钥撤销记录，再销毁对应包装密钥；即使恢复旧 wrapped DEK，也不能使用已销毁的包装密钥解密。撤销结果未知时进入收件箱，不自动重复删除。协议测试不等于真实 Vault 故障验证；独立恢复 KMS 管理员备份不在此保证范围内。

macOS 密钥写入使用 `security -i -q` 的命令标准输入和十六进制密码参数，并通过独立查询完整读回。密钥不进入子进程 argv，不依赖读取终端的密码提示。命令长度、运行时间和输出大小均受限，错误信息不携带原始输出。该调用方式依据 [Apple 的 security 工具接口](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c)，没有复制其实现；`npm run verify:local-keychain` 使用独立临时 service 验证读回与撤销，并清理本次测试条目。

Host、Worker 的 engine lock 与 plugin lock 摘要必须一致，否则 readiness 或 Job claim 失败。企业环境使用蓝绿切换，不进行混合版本滚动升级。

## 插件边界

`PluginManifestV1` 声明服务、Worker、UI、CLI、路由、导航和组件。清单还包含命令、Agent、Skill、Workflow、Tool、Memory schema、健康检查、权限、数据 namespace、事件 schema 和投影。

生产插件与 Host 同进程运行，拥有宿主进程可见的能力。这是信任边界，不是沙箱；`ExecutionAuthority` 无法约束恶意插件直接调用进程能力。生产安装只接受受信仓库的 Ed25519 签名、精确依赖、包 SHA-256 和单调 release sequence。

插件升级先排空 Execution，在独立 namespace 重放并校验投影，再原子切换。已经发布的事件类型不能重新定义；新版本产生事件后不支持自动降级。全局停用会先阻止新任务并排空执行，再原子移除工作区激活状态。清除只删除安装态、可重建投影和本地制品引用，不能删除事实事件。被撤销的插件不再接收新任务，活动任务在安全边界中断。

Host 默认使用内核投影管理器。签名包内的声明式 JSON 定义必须同时提供 SQLite 和 PostgreSQL 变体，且规范化内容一致。安装和升级从经过完整性校验的历史事件重放，不受 SSE 游标保留期影响；切换前检查领域写入水位，变化时拒绝提交。投影布局记录全部版本，清除后仍保留领域事实、发布序号下限和原事件结构约束。

插件命令通过 SDK 数据端口按 tenant、workspace 和 plugin 隔离读写。领域内容先加密写入 CAS，再将事件、密钥引用、投影、写入水位和幂等结果一并提交。事件内容必须符合清单声明的有界 JSON Schema 子集。HTTP 异步命令的幂等结果也写入加密事实日志，不另存明文响应。

文件仓库会重新读取签名索引；Host 在请求前和每 30 秒检查更新，并持久化已观察的仓库序号。撤销使排队 Job 失效，活动执行在下一模型、工具或审批边界处理中断请求。单个插件故障或排空不使 Host 失去 readiness；插件锁不一致、缺少部署所需仓库等问题仍拒绝就绪。

## 产品插件

OPC 的一等对象是 `Opportunity`、`Hypothesis`、`Signal`、`Interview`、`Experiment`、`CommitmentEvidence`、`MinimumPaidOffer` 与 `Decision`。流程为：

```text
captured → framed → researching → interviewing
→ evaluating → offer_ready → decided
```

非终态可进入 `paused` 或 `abandoned`。承诺和付费证据必须人工确认；最终决策也只能由人作出。公开网页研究通过受控只读工具访问，阻止本机、私网、link-local、DNS rebinding 与跨协议重定向。

文件信号引用当前 tenant、当前工作区中的 Asset。访谈原文必须先写入受保护文本 Asset，OPC 事实事件和可重建投影只保存不可变 Asset ID。详情与导出在授权边界临时解密；持久化成果仍保存引用。Asset 删除、密钥销毁或工作区授权撤销后，相关详情与导出失败关闭。模型和人员都不能覆盖原文，只能追加访谈标注。

Coding 的一等对象是 `Repository`、`Service`、`Spec`、`CodingTask`、`Candidate`、`GateResult` 与 `CodeEvidence`。流程为：

```text
discover → specify → impact → implement → verify → approve → learn
```

内置 Agent 是默认 Runner。Claude 与 Codex CLI 必须由用户显式选择，并先按工作区确认二进制绝对真实路径、版本、SHA-256 和文件身份。Host 把 Runner ID 与工具权限原子写入 Execution；Worker 在外部副作用前重新检查身份，变化时 fail closed。

桌面集成页提供插件启用、被动文件检查和人工确认。任务详情页与 OPC 共用 Thread 会话组件；本轮执行方式默认仍为内置 Agent。活动执行中的补充消息、调整方向和取消使用同一 Execution，恢复必须显式发起。

外部 CLI 在隔离候选仓库中运行，不能直接修改源仓库。适配器只实现 `start/events/cancel/resume`，不接管模型连接、代理、MCP、Prompt、Skill 或历史会话。Worker 在启动前持久化不可自动重放检查点；缺少确定终态时进入 `needs_reconciliation`。

## 记忆与共享

`MemoryRecord` 使用 `scopeType + namespace + resourceId`，并记录来源事件、置信度、确认时间、有效期和 share grant。模型只能提出记忆 proposal；用户可接受、修改、拒绝或删除。

记忆正文始终保存为加密 payload，公开事件和投影不保存正文。Worker 只读取已接受、未过期且在当前 Execution 数据范围内的记忆，每个模型边界重新检查授权；删除来源记忆或撤销共享会递归使派生记忆失效。

跨插件默认不可见。撤销 share grant 会立即阻止后续读取，并使派生记忆失效；已经发送到模型或外部服务的数据无法召回，授权界面必须说明这一限制。删除敏感内容时销毁对应数据密钥并写入 tombstone，不可变审计只保留操作者、时间、对象摘要和删除原因。

## Shell 与视图

一级导航是首页、工作区、收件箱、成果和活动；Agents、集成与设置默认折叠。插件只能贡献二级路由、首页卡片和命令，不能替换全局安全、审批或设置页面。

经营视图与专业视图共享 API 和事件，只改变展示密度。会话按工作区与业务对象组织；工具日志折叠为阶段与结果卡；自然语言输入先生成可审阅结构对象。以上交互原则参考了 [Vibe Cola 的 Mod 设计](https://colaos.ai/blog/vibe-cola-mod-design/) 与 [ColaOS Memory](https://docs.colaos.ai/en/memory-and-preferences/)，没有复制其代码、协议或插件实现。

## 上游边界

DeepSeek Harness 的架构适配只来自固定提交 `47f943859bef60e4160492346772ded9b24f765a` 与 `141eb6fef83422698aef7a981029e843e8161534`。Vendored Cordis 固定在提交 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`。

采用范围限于 Cordis、Scope、Agent、Session、AgentHandle、Inbox、Surface、Compaction 和 Scope 内贡献注册。木牛不引入上游 Web/CLI、ACP、Claude SDK payload、Linux Landlock、遥测、匿名标识或 feedback upload。

固定提交、许可证、文件映射与摘要见 `docs/upstream-provenance/`。适配文件保留 MIT 声明；木牛新增代码使用 Apache-2.0。
