# Muniu

[English](README.md) · [文档](docs/index.md) · [安全](SECURITY.zh-CN.md) · [贡献](CONTRIBUTING.zh-CN.md)

Muniu 是一个开源、证据优先的编码 Agent 控制平面，把工程任务变成可追踪闭环：

```text
task → run → candidate → gate → evidence
```

默认运行时是内嵌 `builtin` Agent。Claude Code 与 Codex CLI 仅作为显式兼容运行时，默认工程运行不依赖它们。

> v0.1.0 是开发者预览版。生产可用性以状态矩阵和测试事实为准，不能仅根据 API 或配置项推断。

## 完成度

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| task/run/candidate/Gate/evidence | 已实现 | 本地持久化与治理检查点 |
| builtin Agent | 已实现 | 必须绑定有效 provider/model |
| 工作区工具 | 已实现 | 边界、策略、审批、超时、审计 |
| Gate 修复循环 | 已实现 | 有界结构化反馈 |
| Agent 会话恢复 | 已实现 | 企业 S3 保存 runtime overlay |
| Cordis Context/effect/事件 | 已实现 | 固定来源和逐文件哈希 |
| 本地/npm 动态插件 | 实验性 | 与宿主等权，不是安全沙箱 |
| Claude/Codex CLI | 兼容能力 | 必须显式选择 |
| PostgreSQL/S3 企业会话 | 实验性 | 租户 CAS 和篡改检测 |
| 多副本运行队列 | 已实现 | PostgreSQL 权威存储 |
| Helm API 部署 | 实验性 | sandbox Pod provisioner 交付前 Worker 仅限 fixture |
| Kubernetes 候选沙箱 Pod | 计划中 | 已有默认拒绝策略，provisioner 未完成 |
| macOS Desktop 构建 | 已实现 | 不承诺 v0.1 签名、公证、自动更新 |

v0.1.0 不发布或启用桌面运行时 updater；签名、公证和自动更新制品不属于本次发布。

## 五分钟开始

需要 Node.js `22.19.x`、npm `11.10.1` 和 Git：

```bash
git clone https://github.com/muniu-ai/muniu.git
cd muniu
npm ci
npm run build
npm run dev:api
```

另开终端：

```bash
node apps/cli/dist/index.js init
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js agent run \
  --provider YOUR_PROVIDER_ID \
  --model YOUR_MODEL_ID \
  --prompt "检查仓库并完成一个聚焦改进" \
  --cwd .
```

请先用 `mn provider add` 或 Desktop 设置页创建 provider。provider/model 缺失、禁用或不支持 Agent 时，builtin 会失败关闭。

## V2 策略

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

旧 `providers: ["claude", "codex"]` 保留一个版本的读取兼容，并按原顺序确定性转换为 V2；响应和新快照只输出 V2。

## Agent、Profile、插件

```bash
mn agent run --provider ID --model ID --prompt "..." [--cwd .]
mn agent chat --provider ID --model ID [--prompt "..."] [--cwd .]
mn agent resume SESSION_ID --prompt "..."
mn agent sessions [--limit 100]

mn profile inspect
mn profile validate --file config/runtime/profiles/local.yml
mn plugin list
mn plugin install ./my-plugin.mjs
mn plugin install @scope/my-plugin@1.2.3
mn plugin reload
mn plugin remove PLUGIN_ID
```

配置顺序固定为：

```text
基础 bundle → 部署 profile → ~/.muniu 用户 patch → CLI patch
```

内置 profile 为 `local`、`enterprise-api`、`enterprise-worker`、`desktop`。插件安装记录精确版本和完整性值。

动态插件是与宿主进程等权的可信代码，可以访问宿主可见的凭据、文件、网络和进程能力。Muniu 不宣称插件安全沙箱隔离；生产环境应由管理员逐个固定、审查和安装。

## 兼容迁移

- `~/.mniu` 自动迁移为 `~/.muniu`。
- API 快照 V1/V2 在写入版本备份后迁移至 V3。
- 迁移可重复；未知版本和损坏快照不会被覆盖。
- `muniu://` 是正式深链，`mniu://` 保留一个版本的兼容别名。

## 企业部署

`deploy/helm/muniu` 包含 API 多副本、迁移 Job、Service、Ingress、HPA、PDB、ServiceAccount 和 NetworkPolicy。v0.1.0 默认关闭 Worker，仅允许在显式 mock fixture 模式下启用；生产 values 只引用外部 PostgreSQL、S3、OIDC/JWKS、OTLP、KMS/Vault，不绑定云厂商。

```bash
helm upgrade --install muniu deploy/helm/muniu \
  --namespace muniu --create-namespace \
  -f values.production.yaml
```

Chart 禁止自动挂载 ServiceAccount token，以 UID 10001 运行，丢弃全部 Linux capabilities，并使用只读根文件系统。候选 Pod 必须禁用 `hostPath`、Kubernetes API 权限和默认网络。Kubernetes sandbox provisioner 在 v0.1.0 仍是计划中能力。

## 门禁

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run test:coverage:agent
npm run verify:oss-baseline
npm run verify:enterprise-fixture
npm audit --omit=dev
npm run typecheck:desktop
npm run build:desktop
```

## Cordis 来源

Cordis、cosmokit、schemastery、loader、include、group、hmr、timer、logger-console 固定来自 DeepSeek Harness 提交 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`。MIT 许可证、包名、逐文件哈希和 provenance 保留在 `vendor/` 与 `docs/upstream-provenance/`；这些包不单独发布。

## 文档

- [快速开始](docs/quickstart.md) · [English](docs/quickstart.en.md)
- [架构](docs/architecture.md) · [English](docs/architecture.en.md)
- [插件开发](docs/plugin-authoring.md) · [English](docs/plugin-authoring.en.md)
- [企业运维](docs/enterprise-operations.md)
- [故障排查](docs/troubleshooting.md)
- [v0.1 迁移](docs/migration-v0.1.md)
- [安全](SECURITY.zh-CN.md) · [English](SECURITY.md)
- [贡献](CONTRIBUTING.zh-CN.md) · [English](CONTRIBUTING.md)

## 许可证

Muniu 使用 Apache-2.0；vendored Cordis 保留 MIT。参见 `LICENSE`、`NOTICE`、`THIRD_PARTY_LICENSES.md`。
