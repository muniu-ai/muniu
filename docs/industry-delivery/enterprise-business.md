# 企业工业组合配置

企业 Host 和 Worker 可以加载同一份受信 Sales 配置，提供询价候选与正式出包。该配置沿用标准企业部署，仍需要 PostgreSQL、S3 CAS、Vault、OIDC 和 Kubernetes 执行隔离。它不构成 RFQ-only 部署，也不授予真实租户准入。

## 部署输入

使用 `deploy/helm/muniu/values-industry.example.yaml` 与目标环境 values 合并。替换示例 HTTPS 地址、租户、工作区及现有 Secret 名称；保留既有镜像、lock、Vault、网络和隔离配置。

| 输入 | 要求 |
| --- | --- |
| `business.salesEndpoint` | Sales 的受信 HTTPS `/api/v1/os-business` 入口，不包含账号、查询参数或片段 |
| `business.workspaceScopes` | 经审核的 `tenantId`、`workspaceId` 数组；同一工作区只能出现一次 |
| `business.existingSecret` | 预先创建的 Kubernetes Secret，包含不同的 `sales-token` 和 `authority-token` 键 |
| `worker.supportedKinds` | 保留标准 kinds，并增加 `business.action.execute` 和 `business.candidate.extract` |

Sales 服务令牌用于当前资料、快照、核准、admit、execute、lookup 和 reconcile；执行授权令牌供 Sales 查询 OS 当前执行资格。两种身份的权限与 Sales 成员映射仍在 Sales 配置中单独维护。此处未实现按接口拆分服务身份。

Host 与 Worker 从只读文件读取令牌；令牌内容不会写入 Helm values 或 ConfigMap。工作区配置在进程启动时加载。变更映射应登记配置版本与审计，经维护流程排空任务并重启，不依赖 ConfigMap 热更新改变运行中的权限映射。

配置生成的文件路径如下：

- `/etc/muniu/business/scopes.json`：受信工作区映射。
- `/etc/muniu/business-credentials/sales-token`：Sales 服务凭据。
- `/etc/muniu/business-credentials/authority-token`：执行授权查询凭据。

Sales 回调必须能通过受控 TLS 入口访问 Host。OS 到 Sales、Vault、对象存储及模型的出站访问需要在目标环境显式配置。默认 NetworkPolicy 不自动允许这些新业务链路；启用 Sales 网关密钥的环境仍需提供已验收的网关转发路径。

## 启动与验收

启用业务服务时，缺失工业 kind、工作区重复、非 HTTPS 地址、空凭据或 fixture 模式均会拒绝启动。Helm 模板提前拒绝不完整声明。Worker 沿用 Host 组合根创建的 Kernel；候选使用 Vault 模型凭据、加密 CAS、当前 Sales 再授权与无工具模型流程。

先执行 `npm run verify:helm` 和组合测试，再在隔离环境完成候选九项验收、演示出包、未知结果核对及完整故障矩阵。已有单元测试与模板检查不能证明云端依赖、真实模型或联合恢复通过。当前交付状态仍见[交付记录](delivery-status.md)。
