# 企业运维

生产部署需要外部 PostgreSQL、S3、OIDC/JWKS、OTLP、Standard Pack trust secret 和 sandbox attestation secret。先复制 `deploy/helm/muniu/values.yaml`，只在私有 values 中填写地址，凭据使用 existing Secret。

启用默认拒绝 NetworkPolicy 时，必须在私有 values 中为 `networkPolicy.apiEgress` 配置 PostgreSQL、S3、OIDC/JWKS 和 OTLP 的精确 namespace selector 或 CIDR/端口，并在 `networkPolicy.kubernetesApiEgress` 中填写 Kubernetes API ClusterIP（通常为单个 `/32`）。NetworkPolicy 不能可移植地按 DNS 名放行，Chart 不会猜测生产网段。

升级顺序：备份 PostgreSQL 与 S3 → `helm upgrade` → 等待 migration Job → 检查 `/healthz` → 提交一个只读验证任务 → 检查 OTLP 和审计事件。

恢复验证必须覆盖：API/Worker Pod 重建、过期租约回收、PostgreSQL 重启、S3 对象缺失/篡改失败关闭、OIDC 租户隔离。

API 与 Worker 使用不同 ServiceAccount。Worker 只拥有候选 Pod 的 create/get/delete 与 pods/exec；API 使用独立 Role 验证候选 Pod，并创建/执行/删除只读权威 Gate Pod。候选 ServiceAccount 禁止自动挂载 token 且没有任何 RBAC。不要把 Worker/API Role 绑定到候选 ServiceAccount。

生产必须显式设置 `sandbox.runtimeClassName`，并在该 RuntimeClass 对应的运行时配置中落实 PID 限制。Chart 不会回退到默认运行时。共享 PVC 必须支持 API 与 Worker 副本并发挂载；多节点集群通常需要 RWX 存储。

非 fixture Worker 默认只声明 `builtin`。模型 Provider 凭据仅配置在 API 的 secret/vault 中，不得写入 Worker 或候选 Pod。`node` 必须同时存在于 Harness command allowlist 和候选镜像，因为文件工具通过无 shell 的 Node runtime 执行；任意命令仍需命中签名租约的可执行文件白名单。

活动工具 broker 已使用 PostgreSQL generation、owner lease、mailbox 与运行绑定的审批决定，不依赖负载均衡粘滞。API 优雅退出会 relinquish owner；租约过期或 claim 变更会创建新 generation，并在恢复 durable session 后继续。broker 表中的原始工具载荷只承担活动传输，长期证据仍写入受保护的 Agent session。运行绑定的 `on-risk` 审批由请求事件摘要、binding 摘要和决定共同幂等绑定，任意 API 副本均可提交；独立 `/v1/agent-sessions` 审批仍需命中持有本机会话 waiter 的 API。完整 API/Worker/Pod 组合故障注入完成前，builtin 企业路径仍保持实验性标记。

上线前运行 `npm run verify:helm`；具备 Docker/Kind/kubectl/buildx/jq 的环境还应运行 `npm run verify:kind`。后者使用 Calico 验证真实候选 Pod 的源码摘要、命令执行、token 缺失、Kubernetes API 网络隔离与租约清理。
