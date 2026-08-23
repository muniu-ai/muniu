# 企业运维

生产部署需要外部 PostgreSQL、S3、OIDC/JWKS、OTLP、Standard Pack trust secret 和 sandbox attestation secret。先复制 `deploy/helm/muniu/values.yaml`，只在私有 values 中填写地址，凭据使用 existing Secret。

启用默认拒绝 NetworkPolicy 时，必须在私有 values 中配置以下目标：

- 在 `networkPolicy.apiEgress` 中填写 PostgreSQL、S3、OIDC/JWKS 和 OTLP 的精确 namespace selector 或 CIDR/端口；
- 在 `networkPolicy.kubernetesApiEgress` 中填写 Kubernetes API ClusterIP，通常为单个 `/32`。

若 CNI 在 Service DNAT 后执行出站策略，还必须加入 API Server 实际 endpoint CIDR，并在 `networkPolicy.kubernetesApiPorts` 中加入目标端口。NetworkPolicy 不能可移植地按 DNS 名放行，Chart 不会猜测生产网段。

升级顺序：停止写入 → 备份 PostgreSQL 与 S3 → 在副本执行 V3 dry-run → `helm upgrade` → 等待 migration Job → 检查 `/healthz` → 通过 WSS 提交只读验证任务 → 检查 OTLP 和审计事件。详细回退边界见 [v0.2.0 迁移指南](migration-v0.2.md)。

恢复验证必须覆盖：API/Worker Pod 重建、过期租约回收、PostgreSQL 重启、S3 对象缺失/篡改失败关闭、OIDC 租户隔离。

API 与 Worker 使用不同 ServiceAccount。Worker 只拥有候选 Pod 的 create/get/delete 与 pods/exec；API 使用独立 Role 验证候选 Pod，并创建/执行/删除只读权威 Gate Pod。候选 ServiceAccount 禁止自动挂载 token 且没有任何 RBAC。不要把 Worker/API Role 绑定到候选 ServiceAccount。

生产必须显式设置 `sandbox.runtimeClassName`，并在该 RuntimeClass 对应的运行时配置中落实 PID 限制。Chart 不会回退到默认运行时。共享 PVC 必须支持 API 与 Worker 副本并发挂载；多节点集群通常需要 RWX 存储。

非 fixture Worker 默认只声明 `builtin`。模型 Provider 凭据仅配置在 API 的 secret/vault 中，不得写入 Worker 或候选 Pod。`node` 必须同时存在于 Harness command allowlist 和候选镜像，因为文件工具通过无 shell 的 Node runtime 执行；任意命令仍需命中签名租约的可执行文件白名单。

活动工具 broker 使用 PostgreSQL generation、owner lease、mailbox 与运行绑定的审批决定，不依赖负载均衡粘滞。API Pod 名通过 Downward API 绑定为稳定 owner identity，优雅退出会释放 owner。

租约过期或 claim 变更会创建新 generation，并在恢复 durable session 后继续。未确认工具不得自动重放；旧审批必须以 `interrupted/deny` 结束，恢复后的模型重新发起工具调用和审批。

app-server 审批先写入 V3 事实链，再通过当前 WSS 连接投递。客户端重连后按 cursor 恢复。运行绑定的 `on-risk` 审批由请求事件摘要、binding 摘要和决定共同幂等绑定，任意 API 副本均可提交。Gate CAS 句柄与权威回执是追加型元数据，不能由副本缓存对账裁剪。

唯一租户 scope 的 Provider 非敏感目录元数据由 PostgreSQL 保存并在替换副本启动时恢复；旧的无 scope 或多租户目录保持进程本地兼容，不会被权威 restore 删除，也不具备跨副本保证。首次从旧企业快照升级时只追加迁移 provider kind，不用尚未 hydrate 的内存镜像覆盖权威数据。API key 等密钥不进入 provider 元数据，必须由每个 API 副本通过环境变量或 Vault/KMS 获取。

上线前运行 `npm run verify:helm`。具备 Docker、Kind、kubectl、Helm、buildx 和 curl 的环境还应运行 `npm run verify:kind`。

Kind 门使用 Calico 启动两个 API 与两个 Worker，并验证候选 Pod 的源码摘要、命令执行、token 缺失和 Kubernetes API 网络隔离。测试随后删除精确 owner API Pod，验证 generation、会话、审批恢复和证据导出，再重启 PostgreSQL 并检查结果与租约清理。

候选 Pod 和独立 Gate Pod 的 CPU `limit` 采用签名 attestation 上限，调度 `request` 最高为 250m。并发总量仍由 Worker capacity、HPA 与资源限额共同约束。共享 PVC 上的候选源码使用可跨非 root Pod 读取的 `0644/0755` 模式，不承载 Provider 凭据或其他 secret。
