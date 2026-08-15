# 企业级微服务验收样板

这个目录是 `mn` 的可执行 Spec–Harness–Loop 验收仓库。它用两个零依赖
Node.js 服务演示一个跨服务可验证增量：订单服务创建订单时，通过库存服务
预留库存，并在成功后发布 `orders.confirmed` 事件契约。

## 目录

```text
.mn/project.yaml                         权威服务、owner、数据和命令目录
.mn/standards.lock                       已签名企业规范包的确定性锁
.github/CODEOWNERS                       服务与治理资产 owner
specs/order-reservation/spec.yaml        已批准的 mn 原生 SpecRevision
standards/enterprise-standard-pack.json  声明式、Ed25519 签名规范包
services/orders/                         订单 HTTP 服务、契约、迁移与测试
services/inventory/                      库存 HTTP 服务、契约、迁移与测试
tests/cross-service.e2e.test.mjs         真实跨服务正例
negative/                                四类必须失败的 Gate/架构样板
infra/jwks-server.mjs                    企业 profile 的本地 OIDC/JWKS stub
```

## 本地验证

从仓库根目录运行：

```bash
npm test --prefix examples/microservice-repo
node scripts/enterprise-e2e.mjs
```

第二条命令使用 `mn` 自身的 Spec、Governance、Architecture 和 Gate 实现，
验证主样板以及下面四个反例：

- `contract-breaking`：OpenAPI 删除既有端点；
- `shared-data-ownership`：两个服务共享同一个数据库；
- `no-rollback`：迁移没有 rollback；
- `protected-path`：变更命中企业保护路径。

若本机安装了 Docker，可同时验证企业依赖：

```bash
node scripts/enterprise-e2e.mjs --with-compose
```

这会启动根目录的 `docker-compose.enterprise.yml`，等待 PostgreSQL、MinIO、
bucket 初始化和 JWKS stub 健康，然后运行相同验收。默认会在结束后清理；添加
`--keep-compose` 可保留容器。该编排只代表 `locally_verified` 依赖，不声称真实
企业 IdP、KMS/Vault 或生产集群已经验证。

脚本会严格区分完成级别：默认输出 `fixture_verified`，成功启动上述依赖后输出
`enterprise_dependencies_verified`；只有显式运行并通过完整 API flow 才输出
`locally_verified`，避免把尚未执行的企业闭环误报为完成。

内置 API 全流程会启动构建后的企业 API，验证 OIDC/RBAC、Spec 与受信 Ed25519
签名 StandardPack、
不可变 Governance/Harness、PostgreSQL capability claim、真实 GateResultV2 repair、
owner approval、S3 evidence、Audit/Maturity 和不会自动激活的 Learning Proposal：

```bash
node scripts/enterprise-e2e.mjs --with-compose --api-flow
```

也可以直接运行 `node scripts/enterprise-api-flow.mjs` 来连接已经启动的 Compose
依赖；设置 `MN_ENTERPRISE_API_URL` 时，它会连接已有 API 而不自行启动。若需要接入
额外的企业验证驱动，仍可用 `MN_ENTERPRISE_API_E2E_COMMAND` 覆盖内置 flow。

内置 flow 或覆盖命令会收到 API 当前约定的环境变量：`MN_RUNTIME_PROFILE=enterprise`、
`MN_POSTGRES_URL`、`MN_OIDC_ISSUER` / `MN_OIDC_AUDIENCE` /
`MN_OIDC_JWKS_URL`、`MN_CORS_ALLOWLIST`、`MN_STANDARD_PACK_TRUST_FILE`，以及
`MN_ARTIFACT_REMOTE_STORE_*` /
`MN_ARTIFACT_S3_*`。同时保留 `MN_ENTERPRISE_*` 别名，便于专用 E2E 驱动直接探测
依赖。JWT 的 `iss` 是容器网络中的 `http://jwks:8080`，宿主 API 通过单独的
`MN_OIDC_JWKS_URL=http://127.0.0.1:59080/jwks.json` 获取同一把公钥。
