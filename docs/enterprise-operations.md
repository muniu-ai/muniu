# 企业运维

生产部署需要外部 PostgreSQL、S3、OIDC/JWKS、OTLP、Standard Pack trust secret 和 sandbox attestation secret。先复制 `deploy/helm/muniu/values.yaml`，只在私有 values 中填写地址，凭据使用 existing Secret。

启用默认拒绝 NetworkPolicy 时，必须在私有 values 中为 `networkPolicy.apiEgress` 配置 PostgreSQL、S3、OIDC/JWKS 和 OTLP 的精确 namespace selector 或 CIDR/端口；NetworkPolicy 不能可移植地按 DNS 名放行，Chart 不会猜测生产网段。

升级顺序：备份 PostgreSQL 与 S3 → `helm upgrade` → 等待 migration Job → 检查 `/healthz` → 提交一个只读验证任务 → 检查 OTLP 和审计事件。

恢复验证必须覆盖：API/Worker Pod 重建、过期租约回收、PostgreSQL 重启、S3 对象缺失/篡改失败关闭、OIDC 租户隔离。

不要授予 Muniu 主 ServiceAccount Kubernetes RBAC。候选 Pod provisioner 应使用独立、最小权限身份；v0.1.0 尚未交付该 provisioner。
