# Worker

`@mn/worker` 是木牛 Agent OS 0.2 的持久任务执行器。Worker 通过存储端口领取 Job，使用 30 秒租约和 fencing token 提交结果。无法确认结果的外部副作用进入人工核对，不会自动重放。

## 入口与开发

| 入口 | 用途 |
| --- | --- |
| [src/index.ts](src/index.ts) | `AgentOsWorker`、租约循环和通用 Agent turn 处理器 |
| [src/coding.ts](src/coding.ts) | Coding 执行与受控验证 |
| [src/runtime-store.ts](src/runtime-store.ts) | Runtime 记录持久化适配 |
| [Host 本地入口](../host/src/local.ts) | 本地 Worker 的装配和生命周期 |
| [企业 Worker 入口](../../scripts/enterprise-worker.mjs) | 企业配置、readiness 与处理器装载 |

本地开发通过仓库根目录的 `npm run dev:host` 启动配套 Worker；前置安装步骤见[Host README](../host/README.md#本地运行)。企业部署使用独立 Worker 进程，配置和验证见[企业运维](../../docs/enterprise-operations.md)。

`src/main.ts` 是要求 `MN_WORKER_BOOTSTRAP_MODULE` 的受信自定义入口。根目录的 `dev:worker` 当前执行 `dist/index.js`，不会启动领取循环；不要将它当作企业启动命令。

## Coding Runner 执行

Coding Execution 没有 `runnerId` 时使用 `builtin`。显式选择 `claude-cli` 或 `codex-cli` 后，Worker 重读工作区插件激活状态，并核对确认记录、Execution authority 中的 Runner 工具权限、绝对真实路径、SHA-256 和文件身份。任一条件不一致时，Worker 在启动进程前 fail closed。

生产 Worker 只接受官方原生安装提供的 macOS Mach-O CLI，不支持 npm 或 shebang wrapper。Worker 以 `O_NOFOLLOW` 打开已确认文件，在同一句柄上复核文件身份与摘要，再写入 Worker 管理的只读副本。用户批准外部调用后，Worker 才在无网络、只读的受限环境中执行 `--version`，确认版本完全一致后启动该副本。

外部 CLI 只在源仓库的隔离候选副本中运行。macOS Worker 使用 `/usr/bin/sandbox-exec` 限制写入候选目录；无法建立 sandbox 时不会回退到无隔离执行。外部 CLI 仍属于宿主级受信程序，可读取进程可见资源并按自身配置访问网络，因此启用前必须审阅二进制身份和副作用审批。

### 候选固化与 Gate

Worker 不把 Runner 可写的 Git 工作树当作可验证输入。启动 Runner 前，Worker 在其写入范围之外固化基础文件树。确认进程组停止后，再以 `O_NOFOLLOW` 逐文件读取候选。

候选读取忽略根 `.git`，拒绝嵌套 `.git`、符号链接、硬链接、特殊文件和路径逃逸，并限制目录深度、文件数、单文件与总字节数。每次读取都复核设备、inode、大小和修改时间。

Gate 只比较两棵由 Worker 管理、不含 Git 元数据的快照，执行 `git diff --no-index --binary --no-ext-diff --no-textconv`，并关闭 system/global config 和仓库发现。Runner 改写的 Git 配置、属性和扩展命令不会进入固化与验证链路。所有受控命令都有 `AbortSignal` 和硬超时。

Worker 只使用 Runner Adapter 的 `start/events/cancel/resume`。Claude 与 Codex CLI 继续使用各自的 provider、登录、代理和 MCP 配置；适配器不会读取木牛的 BYOK 密钥，也不会接管 Prompt、Skill 或历史会话。

### 中断与人工核对

Worker 会在启动外部 CLI 前持久化不可自动重放的调用检查点。每个进程组由独立监督器持有，Worker 控制管道在崩溃或强制退出时关闭，监督器会终止整个 Runner 进程组并写入带随机令牌摘要的终止证明。无法证明旧 Runner 已停止时，系统保持 `needs_reconciliation`，不允许验证、清理或创建新调用。

CLI 已启动但缺少可确认终态、Worker 中断或结果持久化失败时，后续 claim 不会再次启动同一调用，必须由用户核对。

人工选择标记完成后，受 fencing token 保护的验证 Job 会重新校验 ExecutionAuthority、Repository、模型、Runner 身份与 generation。固化和 Gate 前分别持久化绑定资源摘要的 ToolCallIntent。它只验证保留候选，不重放 Runner。通过后持久化 Candidate、Gate、CodeEvidence 与成果，失败则继续等待人工核对。

正常完成、失败或取消也会先原子持久化业务结果和物理 Job 结算，再安排独立的持久化清理 Job；清理失败只保留 `cleanupStatus=pending`，不会把已完成业务投影回滚为运行中。

当前生产实现只为 macOS 本地 Worker 提供外部 CLI sandbox。企业 Kubernetes Worker 仍使用 `builtin`；启用外部 Runner 前需要实现节点侧身份确认与相同的 fail-closed RuntimeClass 隔离。

## 验证

按[贡献指南](../../CONTRIBUTING.md)安装依赖，在仓库根目录完成 `npm run build` 后执行：

```bash
npm run typecheck -w @mn/worker
npm run test -w @mn/worker
```

通用执行语义见 [Agent Runtime](../../packages/agent-runtime/README.md)。修改企业租约、持久化或 sandbox 时，还需执行[企业 fixture 验证](../../docs/enterprise-operations.md#企业-fixture-验证)。
