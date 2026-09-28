# Agent OS 0.2 技术与发布契约

本文记录 Agent OS 0.2 的版本边界和发布要求，不表示当前构建已通过发布验收。组件职责见[架构](./architecture.md)，术语见[核心概念](./concepts.md)，接口见 [API 路由](./reference/api-routes.md)与 [OpenAPI](./reference/openapi.md)。

## 版本边界

- 所有一方工作区、Tauri 配置、Cargo 包、Helm Chart 与发布标签使用 `0.2.0`。
- 本地状态根为 `~/.muniu/v2`，企业 PostgreSQL schema 为 `mn_v2`，S3 对象前缀为 `v2/`。
- 0.2 不读取或改写早期状态；本地版本不能同时运行，企业部署不能混合版本滚动升级。
- Desktop 不发布或启用运行时 updater。公开安装包必须经过 Developer ID 签名、Apple 公证与 Gatekeeper 验收。

## 发布物

发布契约要求不可变标签 `v0.2.0` 包含以下发布物：

- `muniu-v0.2.0.tar.gz`：源码归档；
- `muniu-v0.2.0.spdx.json`：生产依赖 SBOM；
- `Muniu_0.2.0_universal.dmg` 与 `Muniu_0.2.0_universal.zip`：macOS universal 安装包；
- `ghcr.io/muniu-ai/muniu:v0.2.0`：Linux `amd64` 与 `arm64` 企业镜像；
- npm/Cargo 第三方许可证清单、notice、vendored source manifest 与 `SHA256SUMS`。

现有标签和发布物不可覆盖。恢复发布必须检出同一不可变标签，并重新执行签名、摘要和来源证明检查。

## 运行时契约

- `apps/host` 是唯一组合根；`apps/worker` 只领取 lock 摘要一致的 Job。
- Kernel 只管理通用执行与治理；行业控制规则位于私有 `@mn/business-execution`，不向产品插件开放。
- 事实来自 `KernelEventV1` 及其认证的加密正文；查询投影和快照不能作为事实源。
- 事件、投影、Job、outbox、审批与幂等结果在同一数据库事务提交。
- 模型上下文和工具承诺先持久化再发送或执行。
- 外部副作用结果未知时进入 `needs_reconciliation`，不得自动重放。
- 生产插件与 Host 同进程运行，属于宿主级可信代码，不是安全沙箱。
- 遥测默认关闭；模型只使用 BYOK 连接。

## 发布门禁

先按[贡献指南](https://github.com/muniu-ai/muniu/blob/main/CONTRIBUTING.md)安装并构建。下列 npm 命令在仓库根目录执行；`cargo test --locked` 在 `apps/desktop-mac/src-tauri` 执行。企业验证会创建测试基础设施并注入故障，前置条件和清理范围见[企业 fixture 验证](./enterprise-operations.md#企业-fixture-验证)；UI 验证见 [Desktop README](https://github.com/muniu-ai/muniu/blob/main/apps/desktop-mac/README.md#体验验收)。

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
