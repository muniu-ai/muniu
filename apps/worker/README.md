# `@mn/worker`

木牛 Agent OS 0.2 的持久任务执行器。Worker 只从新存储端口 claim Job，使用 30 秒租约和 fencing token 提交结果。无法确认结果的外部副作用进入人工核对，不会自动重放。

## Coding Runner 执行

Coding Execution 没有 `runnerId` 时使用 `builtin`。显式选择 `claude-cli` 或 `codex-cli` 后，Worker 重读工作区插件激活状态，并核对确认记录、Execution authority 中的 Runner 工具权限、绝对真实路径、SHA-256 和文件身份。任一条件不一致时，Worker 在启动进程前 fail closed。

生产 Worker 只接受官方原生安装提供的 macOS Mach-O CLI，不支持 npm 或 shebang wrapper。Worker 以 `O_NOFOLLOW` 打开已确认文件，在同一句柄上复核文件身份与摘要，再写入 Worker 管理的只读副本。用户批准外部调用后，Worker 才在无网络、只读的受限环境中执行 `--version`，确认版本完全一致后启动该副本。

外部 CLI 只在源仓库的隔离候选副本中运行。macOS Worker 使用 `/usr/bin/sandbox-exec` 限制写入候选目录；无法建立 sandbox 时不会回退到无隔离执行。外部 CLI 仍属于宿主级受信程序，可读取进程可见资源并按自身配置访问网络，因此启用前必须审阅二进制身份和副作用审批。

Worker 只使用 Runner Adapter 的 `start/events/cancel/resume`。Claude 与 Codex CLI 继续使用各自的 provider、登录、代理和 MCP 配置；适配器不会读取木牛的 BYOK 密钥，也不会接管 Prompt、Skill 或历史会话。

Worker 会在启动外部 CLI 前持久化不可自动重放的调用检查点。CLI 已启动但缺少可确认终态、Worker 中断或结果持久化失败时，Execution 进入 `needs_reconciliation`。后续 claim 不会再次启动同一调用，必须由用户核对。正常取消会持久化 Coding `cancelled` 并删除候选目录；人工核对的清理由受 fencing token 保护的持久 Job 执行。

当前生产实现只为 macOS 本地 Worker 提供外部 CLI sandbox。企业 Kubernetes Worker 仍使用 `builtin`；启用外部 Runner 前需要实现节点侧身份确认与相同的 fail-closed RuntimeClass 隔离。
