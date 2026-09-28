# Host

`@mn/host` 是木牛 Agent OS 0.2 的唯一组合根。它通过 Cordis 装载内核、Agent Runtime、存储实现和已启用插件，并向 Desktop、CLI 与企业客户端提供同一套 `/v2` 接口。

## 代码入口

| 文件 | 职责 |
| --- | --- |
| [src/main.ts](src/main.ts)、[src/local.ts](src/local.ts) | 本地启动、状态锁、存储与 Worker 生命周期 |
| [src/composition.ts](src/composition.ts) | Cordis 组合根与 Kernel 实例 |
| [src/host.ts](src/host.ts) | Host 创建、路由与请求处理 |
| [src/projection-journal.ts](src/projection-journal.ts) | Host 使用的加密投影事实配置 |
| [企业 Host 入口](../../scripts/enterprise-host.mjs) | PostgreSQL、S3、Vault 与企业身份装配 |

## 组合边界

- Host Scope 装载身份、事件、存储、插件与运行时定义。
- tenant、workspace、thread 和 execution 分别创建子 Scope。
- 官方 OPC 与 Coding 插件随应用提供，由工作区按需启用。
- 官方 Claude CLI 与 Codex CLI Runner 定义随应用提供，但不会被默认选择。
- 插件故障只降低对应插件能力；核心健康检查、收件箱、设置和其他插件保持可用。
- 生产插件与 Host 同进程运行，是宿主级可信代码，不是沙箱。
- `@mn/business-execution` 是 Host 与 Worker 共用的私有行业执行服务；Kernel 与产品插件不能依赖该服务。

本地 profile 使用隐式 `local` tenant 和 `local-owner`，权威状态位于 `~/.muniu/v2`。企业 profile 通过注入的 PostgreSQL、S3 与 Vault/KMS 端口运行，使用 `mn_v2` schema 和 `v2/` 对象前缀。

本地组合根默认使用 v2 Keychain provider 包装受保护附件的随机 DEK。企业组合根通过相同 `KeyProvider` 端口接入 Vault Transit 或 KMS。Host 先把 AES-256-GCM 密文写入 CAS，再在事件事务中保存 Asset 与独立 wrapped DEK 记录；删除事务移除 wrapped DEK，只留下摘要 tombstone。

## 本地运行

在 macOS 上按[贡献指南](../../CONTRIBUTING.md)准备 Node.js 22.19.x、npm 11.10.1 并执行 `npm ci`。下列命令在仓库根目录构建工作区并启动 Host，同时创建或打开本地状态和 Keychain 条目；本地 Worker 由 Host 一起启动。

```bash
npm run dev:host
```

Host 默认监听 `http://127.0.0.1:7318`。常用只读入口：

```text
GET /v2/health
GET /v2/readiness
GET /v2/openapi.json
```

所有变更请求都要求 `Idempotency-Key`；修改现有聚合时还要求 `expectedStreamVersion`。完整契约见 [API 路由](../../docs/reference/api-routes.md) 与 [OpenAPI](../../docs/reference/openapi.md)。

## Coding Runner

Host 通过 `/v2/plugins/coding/runners` 提供工作区级 Runner 状态，并通过 `inspections`、`confirmations` 两个 mutation 完成二进制身份确认。检查只读取绝对真实路径、SHA-256、文件设备与 inode，不执行未确认路径。确认会再次被动检查同一路径，并把用户声明的版本绑定到匹配的摘要。

创建 Coding turn 时省略 `runnerId` 会选择 `builtin`。`claude-cli` 与 `codex-cli` 只能显式选择；对应 Runner 插件未启用、健康检查失败、工具贡献缺失、身份未确认或配置已变化时，Host 拒绝创建外部 Runner Execution。Host 只从已激活插件贡献中取得 Runner 工具，Runner ID 和工具权限与 Execution 在同一事务提交。

本地 profile 默认使用本机被动身份检查器。企业 profile 不假定 Host 能读取 Worker 节点上的二进制，因此必须注入受信的同节点检查实现，否则外部 Runner 检查 fail closed。生产 Worker 只接受官方原生安装提供的 macOS Mach-O CLI，不支持 npm 或 shebang wrapper。确认后，Worker 才会把制品复制到其管理的只读目录，并在受限环境中探测版本。

## 就绪与恢复

Host 仅在权威存储、密钥服务、engine lock 和 plugin lock 一致时就绪。事件、投影、Job、outbox、审批与幂等结果必须在同一数据库事务提交；结果未知的外部副作用进入 `needs_reconciliation`，不会自动重放。

Coding 人工核对详情提供任务标题、下一步、双 stream version、当前可用决定、新调用就绪原因和权威证据摘要，但不暴露本地清理路径。Worker 未持久化带随机令牌摘要的 Runner 进程组终止证明时，Host 不提供验证、清理或创建新调用。

本地组合根具备受控验证和清理 handler；企业 Host 只有在受信 Worker capability 同时包含 `coding.reconciliation.verify` 与 `coding.sandbox.cleanup` 时才提供标记完成。该决定先入队受控验证；Worker 不重放 Runner，只有保留候选通过权威 Gate 并持久化 CodeEvidence 后才完成并清理。

企业环境使用蓝绿切换。Host 与 Worker 的 lock 摘要不一致时，Host 拒绝 readiness，Worker 拒绝领取 Job。

企业第三方插件按 tenant 创建独立安装器和贡献宿主，避免 installation、激活状态、命令和健康状态跨租户共享。企业组合根可注入 `tenantPluginInstallerFactory`；标准入口使用镜像内文件仓库，先验证 Ed25519 和实际字节摘要，再加载 Host 定义。存储必须实现 `listTenantIds`，Host 启动时才能逐租户恢复 lock；无法证明完整恢复时 readiness 失败。

跨 Host 更新、全局停用和清除先持久化租户级操作锁；执行与工作区启用持有互斥的短期使用租约。操作发起者异常退出后不自动清锁，readiness 失败并要求人工核对，避免未知结果被另一个副本重放。

## 验证

先在仓库根目录完成 `npm run build`，再执行本包检查：

```bash
npm run typecheck -w @mn/host
npm run test -w @mn/host
```

存储事实和组件依赖见[架构](../../docs/architecture.md)，企业启动、维护和 fixture 验证见[企业运维](../../docs/enterprise-operations.md)。
