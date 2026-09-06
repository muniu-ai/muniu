# Agent OS 0.2 架构

0.2 的目标是一个通用内核和一套事实模型。Desktop、CLI 与 HTTP API 是 Shell；OPC、Coding 与外部 Runner 通过插件贡献能力。当前分支尚未完成整体验收：产品投影重建、Coding 的完整 AgentHandle 控制链和 API 响应类型仍有缺口，不应作为完成版发布。

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

Cordis 是唯一组合根。Scope 按下列层级创建：

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

Scope 销毁必须撤销监听、计时器、资源句柄和子 Scope。内核不得导入产品插件，插件也不得绕过公共契约访问其他插件的领域状态。

## Agent 与 Session

`AgentHandle + Inbox` 是执行入口，支持 `follow_up`、`steer`、`cancel`、`resume` 和 `whenIdle`：

- `follow_up` 按 FIFO 进入下一 turn。
- `steer` 只在下一模型边界注入，不改写已经持久化的上下文。
- `resume` 只接受 `paused` 或 `interrupted`。
- 内部 `inject` 不向普通插件开放。

Session Log 保存模型可见上下文。Surface 和 Compaction 可以改变模型看到的内容，但不能覆盖事实事件、原始访谈或工具记录。模型请求的完整上下文必须先持久化，再发送给模型服务。

Thread 输入、Inbox 消息和 RuntimeRecord 正文使用独立 DEK 加密后写入 CAS；数据库事件只保存引用与执行元数据。运行时可从事件恢复丢失的记录索引。后续 turn 从同一 tenant、workspace、plugin 和 thread 的已完成 Execution 读取历史用户与助手消息。OPC 上下文另行装入当前机会的证据、反证和授权访谈资料，并标记为不可信业务输入，不能据此修改权限。

已提交轮次通过 Thread 的 `threadStreamVersion` 排序，读取对话历史不依赖 SSE 游标保留期。Coding builtin 已使用共用 Session Log，并在模型边界接收 steer；但执行主体仍是 CodingExecutionEngine，尚未完成通过 AgentHandle 消费后续 follow_up 的控制链。不能把上述通用运行时能力等同于 Coding 全部接入。

Execution 状态为：

```text
queued → running → waiting_approval → completed
                    ↘ paused / interrupted / needs_reconciliation
                    ↘ failed / cancelled
```

Workflow 使用类型化声明式状态机，不执行插件提供的任意 JavaScript 工作流。

## 事实、并发与恢复

`KernelEventV1` 是事实记录，包含：

- tenant 级单调 `position`，供 SSE 断点续传；
- aggregate 级 `streamVersion`，供乐观并发；
- `causationId`、`correlationId` 与 generation；
- 公开 payload 与加密 payload 引用；
- 前序摘要、当前摘要与 HMAC。

所有写入提供 `expectedStreamVersion`。版本冲突返回 `409`。事件、投影、Job、outbox、审批和幂等结果在同一数据库事务提交。查询表与快照应能从事件重建，不得作为事实源。

当前 `replayCoreProjections` 可校验完整 tenant 事件链的连续位置、摘要和 HMAC，并重建核心元数据；受保护 RuntimeRecord 可通过事件引用恢复索引。OPC 领域事件数组、Coding 领域状态与成果正文仍有仅存于查询投影的内容，尚不能只凭 KernelEvent 完整重建。补齐加密领域事实和重放测试前，不得删除这些产品投影，也不得将核心重建测试视为全部数据可重建的证明。

文件先按摘要 create-only 写入 CAS，再在事务中提交事件引用。未被事件引用的对象由保留期 GC 清理。已经提交的事件不会因 Host 或 Worker 重启而丢失。

Job 使用至少一次投递、30 秒租约与 fencing token。数据库拒绝陈旧 Worker 的续租和提交。外部副作用若无法确认结果，Execution 进入 `needs_reconciliation`，等待人选择终止、标记已完成或创建新调用；系统不会自动重放原调用。

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

受保护 Asset 的明文先由随机 DEK 和 AES-256-GCM 加密，CAS 只接收密文。Asset 保存密文摘要，独立的可删除密钥记录保存 wrapped DEK 与认证参数。密钥记录不进入事件重放。删除事务移除当前 Asset 与密钥记录，并追加只含对象摘要和原因摘要的 tombstone 事件；孤立密文由 CAS 保留期 GC 清理。

当前删除不覆盖 SQLite WAL、存储快照和历史备份。若其中仍有 wrapped DEK 且包装密钥仍有效，副本仍可能解密。因此当前实现不能宣称跨备份的密码学擦除；独立密钥撤销和恢复后的删除约束仍需补齐。

Host、Worker 的 engine lock 与 plugin lock 摘要必须一致，否则 readiness 或 Job claim 失败。企业环境使用蓝绿切换，不进行混合版本滚动升级。

## 插件边界

`PluginManifestV1` 声明服务、Worker、UI、CLI、路由、导航和组件。清单还包含命令、Agent、Skill、Workflow、Tool、Memory schema、健康检查、权限、数据 namespace、事件 schema 和投影。

生产插件与 Host 同进程运行，拥有宿主进程可见的能力。这是信任边界，不是沙箱；`ExecutionAuthority` 无法约束恶意插件直接调用进程能力。生产安装只接受受信仓库的 Ed25519 签名、精确依赖、包 SHA-256 和单调 release sequence。

插件升级先排空 Execution，在独立 namespace 重放并校验投影，再原子切换。已经发布的事件类型不能重新定义；新版本产生事件后不支持自动降级。全局停用会先阻止新任务并排空执行，再原子移除工作区激活状态。清除只删除安装态、可重建投影和本地制品引用，不能删除事实事件。被撤销的插件不再接收新任务，活动任务在安全边界中断。

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
