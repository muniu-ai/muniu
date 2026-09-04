# ADR 0011：Agent OS 0.2 断代架构

- 状态：已接受
- 日期：2026-09-04
- 版本：0.2.0

## 决策

木牛 0.2 只保留一套 Agent OS 控制面。组合根是 `apps/host`，持久执行位于 `apps/worker`，macOS 与 CLI 只作为 Shell。公共能力分别放入 `packages/contracts`、`packages/kernel`、`packages/agent-runtime`、`packages/plugin-sdk` 和 `packages/storage`。OPC、Coding 及外部 Runner 都是产品插件。

生产插件是与 Host 同进程的可信代码，不是沙箱。Agent 和经内核调用的工具受 `ExecutionAuthority` 约束；同进程恶意插件不受该权限模型约束。安装界面必须展示这个边界。

0.2 不读取、不迁移、不修改 0.1 状态。新本地状态根为 `~/.muniu/v2`，企业数据库 schema 为 `mn_v2`，对象前缀为 `v2/`。`/v1`、旧 CLI、`mniu://`、旧状态加载器和迁移器不进入 0.2。

## 依据

现有 Agent Session 与 Task/Run 控制面语义重叠，桌面端仍要求用户理解 Provider、Model、Harness 和 Worker。继续兼容会让身份、事件、审批、恢复和插件生命周期出现多套事实源。

断代后，经营视图和专业视图使用同一 API 与事件，只改变信息密度。OPC 与 Coding 共享 Thread、Execution、Approval、Event、Memory、Artifact、Job 和 Agent Runtime。

## DeepSeek Harness 借鉴边界

Cordis、Scope、Agent、Session 的借鉴只来自仓库批准的固定提交 `47f943859bef60e4160492346772ded9b24f765a` 和 `141eb6fef83422698aef7a981029e843e8161534`。Vendored Cordis 固定在 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`。

采用 Scope 分层、AgentHandle 与 Inbox、Session Log、Surface、Compaction 和贡献注册表。工作流使用木牛自己的类型化声明，不引入上游 JavaScript 或 `vm.Script` 工作流，也不引入 DSH Web/CLI、ACP、Claude SDK、Landlock、遥测、匿名标识或反馈上传。

## 后果

- 升级 0.2 前必须退出旧 daemon；两个版本不能同时运行。
- 蓝绿部署切换时，Host、Worker 和插件 lock 摘要必须一致。
- 旧版本仍可读取旧数据，但 0.2 不提供迁移入口。
- 插件升级在独立投影 namespace 重放和校验；切换后产生新事件便不自动降级。
