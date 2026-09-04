# ADR 0011：Agent OS 0.2 单一控制面

- 状态：已接受
- 日期：2026-09-04
- 版本：0.2.0

## 决策

木牛 0.2 只保留一套 Agent OS 控制面。`apps/host` 是唯一组合根，`apps/worker` 执行持久任务与受控工具，Desktop 和 CLI 是 Shell。公共能力分别位于 `packages/contracts`、`packages/kernel`、`packages/agent-runtime`、`packages/plugin-sdk` 与 `packages/storage`；OPC、Coding 和外部 Runner 都是插件。

0.2 使用独立的本地状态根 `~/.muniu/v2`、Keychain service、企业数据库 schema `mn_v2` 与 S3 `v2/` 前缀。不读取、不迁移、不修改早期状态，也不提供旧协议、命令、链接或配置投影入口。旧版本仍可在自己的发布标签中读取原数据，但不能与 0.2 同时运行。

生产插件是与 Host 同进程的可信代码，不是沙箱。`ExecutionAuthority` 约束 Agent 和经内核调用的工具，无法约束恶意插件直接使用宿主进程能力。安装界面必须展示这一边界。

## 依据

多套 Agent、任务与运行控制面会造成身份、事件、审批和恢复事实不一致，也迫使用户理解内部厂商标识、模型标识、Harness 与 Worker。单一内核让 OPC 与 Coding 共用 Thread、Execution、Approval、Event、Memory、Artifact、Job 和 Agent Runtime。

经营视图与专业视图调用同一接口、产生同一事件，只改变信息密度。插件故障可以限制在对应 Scope 内，核心页面与其他插件继续工作。

## DeepSeek Harness 借鉴边界

架构适配只使用批准的固定提交 `47f943859bef60e4160492346772ded9b24f765a` 和 `141eb6fef83422698aef7a981029e843e8161534`；vendored Cordis 固定在 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`。

木牛采用 Scope 分层、AgentHandle、Inbox、Session Log、Surface、Compaction 与贡献注册表。Workflow 使用木牛的类型化声明，不引入上游任意 JavaScript 工作流，也不引入上游 Web/CLI、ACP、Claude SDK payload、Linux Landlock、遥测、匿名标识或反馈上传。

## 后果

- 启动 0.2 前必须退出占用本机 Host 端口的早期 daemon。
- 企业切换使用蓝绿部署；Host、Worker 和插件 lock 摘要不一致时拒绝 readiness 或 claim。
- 插件升级必须先排空执行，在独立投影 namespace 重放并校验后原子切换。
- 新版本产生事件后不支持自动降级；外部副作用结果未知时只进入人工核对。
