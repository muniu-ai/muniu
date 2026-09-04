# Agent OS 0.2 技术与发布契约

本文保留稳定文档路径，供发布检查引用。系统设计详见 [架构](./architecture.md)，接口详见 [API 路由](./reference/api-routes.md) 与 [OpenAPI](./reference/openapi.md)。

## 版本边界

- 所有一方工作区、Tauri 配置、Cargo 包、Helm Chart 与发布标签使用 `0.2.0`。
- 本地状态根为 `~/.muniu/v2`，企业 PostgreSQL schema 为 `mn_v2`，S3 对象前缀为 `v2/`。
- 0.2 不读取或改写早期状态；本地版本不能同时运行，企业部署不能混合版本滚动升级。
- Desktop 不发布或启用运行时 updater。公开安装包必须经过 Developer ID 签名、Apple 公证与 Gatekeeper 验收。

## 发布物

不可变标签 `v0.2.0` 对应以下发布物：

- `muniu-v0.2.0.tar.gz`：源码归档；
- `muniu-v0.2.0.spdx.json`：生产依赖 SBOM；
- `Muniu_0.2.0_universal.dmg` 与 `Muniu_0.2.0_universal.zip`：macOS universal 安装包；
- `ghcr.io/muniu-ai/muniu:v0.2.0`：Linux `amd64` 与 `arm64` 企业镜像；
- npm/Cargo 第三方许可证清单、notice、vendored source manifest 与 `SHA256SUMS`。

现有标签和发布物不可覆盖。恢复发布必须检出同一不可变标签，并重新执行签名、摘要和来源证明检查。

## 运行时契约

- `apps/host` 是唯一组合根；`apps/worker` 只领取 lock 摘要一致的 Job。
- 事件、投影、Job、outbox、审批与幂等结果在同一数据库事务提交。
- 模型上下文和工具承诺先持久化再发送或执行。
- 外部副作用结果未知时进入 `needs_reconciliation`，不得自动重放。
- 生产插件与 Host 同进程运行，属于宿主级可信代码，不是安全沙箱。
- 遥测默认关闭；模型只使用 BYOK 连接。

## 发布门禁

```text
npm test
npm run typecheck
npm run typecheck:desktop
npm run build:desktop
cargo test --locked
npm run verify:enterprise-fixture
npm run verify:kind
npm run verify:plugins
npm run verify:opc-ui
npm run verify:coding-ui
npm audit --omit=dev
git diff --check
```

macOS Desktop 只有在签名、公证、staple、`spctl` 与干净设备安装检查都有证据时，才可声明公开分发就绪。企业发布还必须验证两个 Host、两个 Worker、租户隔离、租约恢复、PostgreSQL 重启、S3 CAS 与 Kubernetes runtime proof。
