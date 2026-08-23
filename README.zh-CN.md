# Muniu

[English](README.md) · [文档](docs/index.md) · [安全](SECURITY.zh-CN.md) · [贡献](CONTRIBUTING.zh-CN.md)

Muniu 是一个开源、证据优先的编码 Agent 平台。它以 TypeScript agent kernel 执行交互线程，并把工程任务纳入可验证的受治理执行链：

```text
Thread → Turn → Item
             │
             └→ task → run → candidate → gate → evidence
```

v0.2.0 使用 JSON-RPC app-server 统一 CLI、Desktop、Worker 协调器和嵌入式客户端。Claude Code 与 Codex CLI 只作为显式兼容 target；默认运行不依赖它们。

> v0.2.0 是 Developer Preview，也是一次性协议切换。旧控制 REST/SSE 客户端不能连接此版本，升级前必须执行 V3 迁移。

## 状态

| 能力 | 状态 | 边界 |
| --- | --- | --- |
| app-server v2 与 `@mn/sdk` | 已实现 | 固定 Codex 稳定子集；SDK 保持 private |
| `AgentEventV3` 与 Thread 投影 | 已实现 | notification 先持久化再投递 |
| Spec/Governance/Harness/Loop/Evidence | 已实现 | 集中策略仍是执行权威 |
| Provider/Model 绑定 | 已实现 | OpenAI、Anthropic 与兼容 Provider |
| 文件、patch、shell、PTY、MCP 与扩展工具 | 已实现 | 全部经过 effect commitment、sandbox 与审批 |
| 上下文压缩与 CAS spill | 已实现 | 失败时中断，不静默截断 |
| 插件、skill 与 MCP runtime | 已实现 | 命令插件与 HMR 是宿主等权可信代码 |
| 持久化多 Agent 图 | 已实现 | 默认最多 6 个 Agent、4 个并发、深度 1 |
| SQLite 与 PostgreSQL/S3 迁移 | 已实现 | 首次 V3 写入后只能恢复整套备份 |
| 企业 WSS gateway | 实验性 | TLS、OIDC/JWKS、租户隔离、RBAC 与恢复 cursor |
| Kubernetes 候选 sandbox Pod | 实验性 | 独立 Pod、最小 RBAC、默认拒绝网络 |
| macOS Desktop | 构建验证 | 不包含签名、公证或自动更新发布 |
| SBOM、许可证与 provenance | 发布工作流 | tag 时生成并证明 |

木牛只实现 [Codex app-server v2 的声明子集](docs/compatibility-v0.2.md)，不嵌入 Codex Rust 内核，也不宣称完整 Codex app-server 兼容。

## 本地启动

需要 Node.js `22.19.x`、npm `11.10.1` 和 Git：

```bash
git clone https://github.com/muniu-ai/muniu.git
cd muniu
npm ci
npm run build
node apps/cli/dist/index.js app-server --transport ws --port 0
```

服务端只监听回环地址，并把连接地址和随机 bearer token 写入权限为 `0600` 的 `~/.muniu/app-server.json`。另开终端初始化配置并检查环境：

```bash
node apps/cli/dist/index.js init
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js agent run \
  --provider YOUR_PROVIDER_ID \
  --model YOUR_MODEL_ID \
  --prompt "检查仓库并完成一个聚焦改进" \
  --cwd .
```

请先用 `mn provider add` 或 Desktop 设置页创建 Provider。Provider/Model 缺失、禁用或不支持 Agent 时，builtin Agent 会失败关闭。

本地 app-server 还支持 stdio JSONL 与 owner-only Unix socket：

```bash
mn app-server --transport stdio
mn app-server --transport unix --socket ~/.muniu/app-server.sock
```

接入、握手、SDK 和恢复语义见 [app-server v2 接入](docs/app-server.md)。

## 策略与扩展

执行策略绑定 runtime、Provider、Model、sandbox、Gate 和审批要求：

```json
{
  "schemaVersion": 2,
  "targets": [{
    "runtimeId": "builtin",
    "providerId": "deepseek",
    "modelId": "deepseek-chat",
    "candidates": 2
  }],
  "sandbox": "isolated-worktree",
  "requiredGates": ["unit_test", "lint", "typecheck"],
  "humanApproval": "on-risk",
  "timeoutSeconds": 3600
}
```

运行时配置顺序固定为：

```text
基础 bundle → 部署 profile → ~/.muniu 用户 patch → CLI patch
```

内置 profile 为 `local`、`enterprise-api`、`enterprise-worker` 和 `desktop`。插件 manifest 记录精确版本、完整性、入口、skill、MCP、hook、tool、配置 schema 和所需 capability。

动态插件、JavaScript 配置和明确启用的 HMR 可以访问宿主可见的凭据、文件、网络和进程能力。它们属于宿主等权可信代码，不是 sandbox；生产环境必须由管理员固定版本、审查来源并记录配置变更。

## v0.2.0 迁移

迁移必须停写，并按 preflight、全量备份、旧链校验、转换、逐记录映射校验、新链校验和原子切换执行：

```bash
mn migrate app-server-v3 --dry-run
mn migrate app-server-v3 --apply
```

旧 SQLite/API state、JSONL 和 S3 prefix 会进入只读归档。首次 V3 写入前可执行受摘要校验保护的 rollback；产生 V3 写入后只能停机并恢复 PostgreSQL、S3 与本地状态的整套备份。详见 [v0.2.0 迁移指南](docs/migration-v0.2.md)。

## 企业部署

`deploy/helm/muniu` 包含 API/Worker、V3 migration Job、WSS gateway、Service、Ingress、HPA、PDB、ServiceAccount 和 NetworkPolicy。生产 values 引用外部 PostgreSQL、S3、OIDC/JWKS、OTLP 与 KMS/Vault：

```bash
helm upgrade --install muniu deploy/helm/muniu \
  --namespace muniu --create-namespace \
  -f values.production.yaml
```

企业入口只接受 WSS。OIDC 身份在升级前验证，tenant、subject、RBAC 和 permission profile 固定到连接。候选任务从 S3 内容寻址快照物化到独立 Pod；候选 Pod 不获得模型凭据、对象存储凭据、ServiceAccount token、`hostPath`、sidecar、特权或默认网络访问。

Worker 的 claim、generation、工具 mailbox、审批和恢复状态由 PostgreSQL 管理。owner 丢失时，旧 generation 保留为不可变历史，未确认工具不会重放；恢复后的模型必须生成新的工具调用和审批。

## 发布门

```bash
npm ci
npm test
npm run typecheck
npm run verify:app-server-schema
npm run verify:rpc-coverage
npm run verify:migration-v3
npm run verify:sdk-e2e
npm run verify:gateway-e2e
npm run verify:desktop-e2e
npm run typecheck:desktop
npm run build:desktop
npm run verify:enterprise-fixture
npm run verify:helm
npm audit --omit=dev
```

`npm run verify:kind` 需要 Docker、Kind、kubectl、Helm、buildx 和 curl。它覆盖候选 Pod、网络隔离、多副本 owner 丢失、PostgreSQL 重启、证据导出和租约清理。

## 来源与许可证

OpenAI Codex 兼容分析固定到提交 `99660ab3c7b861c916e467581fa9b8723504d66b`，记录在 `docs/upstream-provenance/openai-codex.yaml`。Cordis 来源固定到 DeepSeek Harness 提交 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`，逐文件哈希和 MIT 声明保留在 `vendor/` 与 `docs/upstream-provenance/`。

木牛新代码使用 Apache-2.0；vendored Cordis 保留 MIT。参见 `LICENSE`、`NOTICE` 和 `THIRD_PARTY_LICENSES.md`。

## 文档

- [app-server v2 接入](docs/app-server.md)
- [v0.2.0 兼容矩阵](docs/compatibility-v0.2.md)
- [v0.2.0 迁移指南](docs/migration-v0.2.md)
- [架构](docs/architecture.md) · [English](docs/architecture.en.md)
- [插件开发](docs/plugin-authoring.md) · [English](docs/plugin-authoring.en.md)
- [企业运维](docs/enterprise-operations.md)
- [安全](SECURITY.zh-CN.md) · [English](SECURITY.md)
- [贡献](CONTRIBUTING.zh-CN.md) · [English](CONTRIBUTING.md)
