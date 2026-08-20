# Enterprise Spec–Harness–Loop

`mn` 提供同一领域内核下的两个运行 profile。`local` 保留单机、隐式单租户和桌面体验；`enterprise` 启用版本化 Spec、确定性治理解析、不可变 Harness、有界修复循环、租户隔离、远程 worker、PostgreSQL 队列、S3-compatible artifact、OIDC/JWT、OTLP 和追加式审计。

本仓库的完成级别是 `locally_verified`：代码、迁移、容器化依赖和真实微服务 fixture 在本地通过。它不代表真实企业 IdP、生产 Vault/KMS、生产集群切流或 Apple 签名已经验收。

## 研发闭环

```mermaid
flowchart LR
  spec["SpecRevision\n定义什么是对"] --> governance["GovernanceSnapshot\n解析企业规范"]
  governance --> harness["HarnessManifest\n限定上下文与执行"]
  harness --> loop["Bounded Loop\n实现、验证、修复"]
  loop --> evidence["Evidence Graph\n条款到证据"]
  evidence --> learning["Learning Proposal\n只生成提案"]
  learning -->|"review + canary + sign"| governance
```

`governed-increment-v1` 固定为七个阶段：Discovery、Specification、Impact/Architecture、Implementation、Verification、Approval/Demo、Learning。每次运行绑定批准后的 `SpecRevision`、唯一 `GovernanceSnapshot` 和编译后的 `HarnessManifest`；digest、stage attempt、预算、GateResultV2 和审批证据持久化。规格变化必须创建新 revision，不能在运行中静默改写。

验证失败最多进行三次受预算约束的 repair。连续两轮 failure signature 与 diff 都没有有效变化时停止并转人工。Spec 批准、跨服务所有权/一致性、waiver、外部副作用和 Learning 晋升必须人工门禁；Learning Proposal 不会自动激活。

## 企业规范定制

企业规范以声明式 `StandardPack` 分发，远程包不能执行任意 TypeScript。作用域优先级是：

```text
builtin < organization < team < project < service < task
```

解析遵循单调收紧：required gates、deny、protected paths 取并集；provider、command、network allowlist 取交集；预算取最小值；审批取更严格级别。只有包含原因、审批人、作用域和过期时间且命中可豁免规则的 waiver 才能生效。

Standard Pack registry 支持 SHA-256、Ed25519、多 key、撤销、release metadata、dry-run、diff、lock 与 rollback。企业 profile 必须配置受信 key profile，Run 保存最终 pack digest 和 policy explain，避免组织规范被项目静默覆盖。

仓库约定：

- `.mn/project.yaml`：服务、owner、契约、依赖、数据归属、项目命令和观测声明。
- `.mn/standards.lock`：已激活 Standard Pack revision 与 digest。
- `specs/<increment-id>/spec.yaml`：mn 原生机器可读规格。
- `AGENTS.md`、`CLAUDE.md`、CODEOWNERS、OpenAPI、AsyncAPI、protobuf、迁移、CI 与相关测试：Harness 的可追溯 context source。

Spec Kit 目录可双向导入/导出，运行时不依赖 Spec Kit。旧 `prompt + acceptanceCriteria` 会包装为 legacy Spec 并继续使用 `classic-v1`。

## Gate、Sandbox 与证据

Gate 是 registry ID，不再是封闭枚举。内置 runner 覆盖 Node、Go、Java、Python、Rust 项目命令，以及 Spec schema/approval/acceptance coverage、protected path、diff scope、OpenAPI/AsyncAPI contract、migration safety 和 security adapter。企业 required gate 若缺 runner、unsupported 或 skipped，统一 fail-closed。

每个 `GateResultV2` 包含 Spec 条款映射、命令、工具版本、工作目录、退出码、输入/输出 digest、日志/SARIF/JUnit artifact、时间与 freshness。Trace Graph 串联业务假设、Spec 条款、设计/契约、diff、测试/Gate、审批和观测，并报告规格漂移、契约漂移与证据缺口。

`worktree-postcheck` 只隔离源码污染，不宣称是强沙箱。企业 Harness 要求 container/remote enforced backend，并把挂载、网络、资源、Secret、允许工具和预算写入 manifest。worker 只有在 tenant、provider、language、gate runner 与 sandbox capability 全部满足快照要求时才能 claim。

## 运行 enterprise profile

API 在非 loopback 或 enterprise profile 下 fail-closed。企业启动必须同时提供 PostgreSQL、OIDC/JWT、CORS allowlist、S3-compatible store、OTLP endpoint、Standard Pack trust profile 和仓库根目录 allowlist；缺少任一必需能力会拒绝启动。enterprise 进程还使用 method-aware 路由白名单，只暴露 Spec–Governance–Harness–Loop 控制面；Provider、Proxy、MCP、Prompt、Skill、Session、系统诊断和全局 artifact-store 等 local desktop API 统一返回 404。

```bash
export MN_RUNTIME_PROFILE=enterprise
export MN_API_HOST=0.0.0.0
export MN_POSTGRES_URL='postgresql://mn:secret@postgres/mn'
export MN_OIDC_ISSUER='https://id.example.com/'
export MN_OIDC_AUDIENCE='mn-enterprise'
export MN_OIDC_JWKS_URL='https://id.example.com/.well-known/jwks.json'
export MN_CORS_ALLOWLIST='https://mn.example.com'
export MN_ARTIFACT_REMOTE_STORE_TYPE=s3
export MN_ARTIFACT_REMOTE_STORE_ENDPOINT_URL='https://s3.example.com'
export MN_ARTIFACT_REMOTE_STORE_BUCKET=mn-artifacts
export MN_ARTIFACT_S3_REGION=us-east-1
export MN_ARTIFACT_S3_ACCESS_KEY_ID='...'
export MN_ARTIFACT_S3_SECRET_ACCESS_KEY='...'
export MN_OTEL_EXPORTER_OTLP_ENDPOINT='https://otel.example.com/v1/traces'
export MN_STANDARD_PACK_TRUST_FILE='/etc/mn/standard-pack-trust.json'
export MN_ENTERPRISE_PROJECT_ROOTS='/srv/mn/repos/orders,/srv/mn/repos/inventory'
export MN_SANDBOX_ATTESTATION_KEY='replace-with-at-least-32-random-bytes'
export MN_PROVIDER_USAGE_JOURNAL_INTEGRITY_FILE='/etc/mn/provider-usage-journal-integrity.json'
node apps/api/dist/index.js
```

Journal keyring 文件必须由 secret manager 以只读方式挂载，格式为
`{"activeKeyId":"journal-v2","keys":[{"id":"journal-v2","secret":"...","status":"active"},{"id":"journal-v1","secret":"...","status":"retired"}]}`。
轮换时先把旧 key 标记为 `retired` 并完成 replay；需要撤销前，必须为仍需保留的旧 journal 创建受审计 revocation checkpoint，再将 key 标记为 `revoked`。

固定角色是 `org_admin`、`governance_admin`、`project_owner`、`developer`、`reviewer`、`auditor`。授权默认拒绝，并按 tenant/project 隔离资源；Agent 工具副作用的决定接口只允许 `reviewer` 或 `org_admin` 调用，`project_owner` 不能以运行所有者身份代替独立审批。JWT subject 是企业审计 actor 的唯一来源，请求体不能替换认证身份。human principal 不能调用 queue worker 协议；machine principal 必须声明 `principal_type=worker` 和最小化 `run_jobs:claim|heartbeat|checkpoint|finish|events|release` scopes，且不能获得 human role。`POST /v1/projects` 只接受 allowlist 内已存在目录；服务端会拒绝相对路径、`..`、symlink escape 和任意主机路径。外部 worker 也不能通过 candidate、checkpoint 或 Gate artifact 字段让 API 读取本地文件。

PostgreSQL 使用事务 claim/outbox；claim token 绑定 tenant、run、worker、capability 和过期时间。API 还以服务端 HMAC 签发 sandbox lease，绑定 Run、tenant、worker、Harness digest、能力 digest、backend 和策略。参考 Docker backend 在真实容器中执行 Gate，使用只读 rootfs、只读源码挂载、独立 scratch、`network=none`、CPU/内存/PID 限制、drop capabilities、`no-new-privileges`、非 root 用户和工具 allowlist；API 验证 attestation、容器运行时 evidence 与 Gate digest，并以 append-only 历史支持 crash/reclaim。RunEvent 面向用户时间线；AuditEvent 追加记录 actor、策略决策、before/after digest、pack digest、traceId 和结果。artifact 使用 SigV4 S3-compatible API，遥测使用 OTLP/HTTP 并延续 W3C trace ID。

## API 与 CLI

动态发现入口：

- `GET /v1/capabilities`
- `GET /v1/workflows` 与 `GET /v1/harness-profiles`
- `/v1/standard-packs/*`
- `/v1/spec-sets/*/revisions/*`
- `/v1/projects/:id/effective-governance`
- `/v1/projects/:id/policy/explain`
- `/v1/learning-proposals`、`/v1/audit-events` 与 evidence/maturity endpoints

常用 CLI：

```bash
mn standards validate|import|diff|activate|lock
mn spec init|import|validate|diff|approve|status
mn policy explain
mn workflow list|show
mn run --spec <id@revision> --workflow governed-increment-v1 --harness-profile enterprise
mn audit export
```

企业 CLI 通过 `MN_API_TOKEN` 读取 Bearer JWT；该变量仅接受 token 本体，CLI 不持久化或输出它。CLI 和桌面端以 `/v1/capabilities` 与 effective governance 为准，不应硬编码 Gate、候选数或审批策略。

企业队列由产品 worker 命令消费。worker 先以 machine JWT 上报 provider、language、Gate runner、tool 与 enforced sandbox capability，再认领 digest 绑定的 Project/Task/Spec/Run bundle。阶段 checkpoint、API 签发的预算证明、Gate CAS artifact、sandbox runtime proof 和终态都经 claim token 回写；进入人工审批时，worker 会先持久化 waiting checkpoint，再释放 claim，使审批后可以立即重新入队和恢复。

```bash
MN_API_TOKEN="$WORKER_JWT" node apps/cli/dist/index.js run worker \
  --enterprise --once --mock --owner "$WORKER_SUB" \
  --sandbox-image node:22-alpine --provider codex \
  --language javascript --tool node --tool npm
```

`--mock` 仅用于仓库内 `locally_verified` fixture：mock agent 本身仍在真实 enforced sandbox backend 中运行，真实项目命令和 Gate 不会旁路到宿主机。企业内嵌 Agent 不依赖 Claude Code/Codex CLI 凭据；真实 provider 执行经过 API 内受治理的 provider broker，工作区工具经活跃 claim 进入已检查的候选 Pod。PostgreSQL/S3 Agent 会话、execution generation、owner lease、工具 mailbox 与运行绑定审批已经进入企业链路；Kind + Calico 门禁以双 API/Worker 注入 owner Pod 丢失和 PostgreSQL 重启。该验收仍只代表实验性 `locally_verified`，不应描述为生产认证。

## 本地验收

`examples/microservice-repo` 是权威验收 fixture：包含 orders/inventory 两个服务、OpenAPI/AsyncAPI、CODEOWNERS、正向迁移与回滚、契约/集成测试、签名规范包、批准 Spec 和 `.mn/project.yaml`。负例覆盖 contract breaking、共享数据所有权、无 rollback 与 protected path。

```bash
npm run verify:enterprise-fixture
npm run verify:enterprise-dependencies
npm run verify:enterprise-e2e
```

完整 E2E 使用 Docker Compose 启动 PostgreSQL、MinIO 和本地 JWKS/OTLP stub，并由上述产品 worker 命令完成两次 claim/release/reclaim，验证：批准 Spec → 解析规范 → 影响分析 → Gate fail → repair → owner approval → resume → evidence/audit/usage → Learning Proposal。成功结果只能表述为 `locally_verified`。

生产落地仍需企业自行完成真实 IdP 联调、attestation key 的 secret manager/KMS 托管、remote sandbox/集群调度、对象存储 lifecycle/备份、数据库高可用、OTel collector、容量与灾备、供应链发布及生产变更审批。仓库内 Docker backend 与 Compose 验收只构成 `locally_verified`，不等同生产强隔离认证。
