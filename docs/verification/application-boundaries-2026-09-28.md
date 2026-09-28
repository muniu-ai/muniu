# 领域边界与执行准入验收

日期：2026-09-28。基线：`69e4dceca40204292fe091d0da715ea8d146a197`。实施范围见 [ADR 0012](../adr/0012-application-boundaries.md)。本记录对应包含本文件的实现提交，不代表产品发布准入。

使用 Node.js 22.19.0、npm 11.10.1、TypeScript 5.7.2，从锁文件安装依赖。测试使用临时状态和专用企业容器；原本地状态、现有企业数据和其他 Docker 部署未用于测试。

| 检查 | 结果 |
| --- | --- |
| `npm test` | 通过；14 组进程报告共 700 项测试，0 失败 |
| `npm run typecheck` | 通过 |
| `npm run typecheck:desktop`、`npm run build:desktop` | 通过 |
| Desktop Rust 目录的 `cargo test --locked` | 通过；6 项测试通过 |
| `npm run verify:plugins` | 通过；插件 SDK、全部插件与 Host 均通过 |
| `npm run verify:onboarding-ui`、`npm run verify:opc-ui`、`npm run verify:coding-ui` | 通过 |
| `npm run verify:enterprise-fixture` | 通过；真实 PostgreSQL、S3、Vault、双 Host 与双 Worker |
| PostgreSQL 旧核心事实显式升级 | 通过；双租户加密升级、历史不变、重复升级为零、授权读取与升级后重建 |
| `npm run verify:kind` | 未完成；镜像构建与临时控制面启动成功，镜像导出持续超过 6 分钟且未生成文件后中止，尚未进入沙箱断言 |
| `npm audit --omit=dev` | 0 个已报告漏洞 |
| 文档生成一致性、链接、构建与第三方许可检查 | 通过 |
| `git diff --check` | 通过 |

本机并行验证期间出现内存压力，Worker 的 Coding 审批等待测试超时。该文件单独复验 9 项全部通过；最终全量测试以 `--test-concurrency=1` 顺序执行测试文件，使用相同 Node.js、测试代码、断言和超时配置。全量测试中 Worker 133 项、Host 166 项、CLI 30 项全部通过。

企业最终验证使用 `COMPOSE_PARALLEL_LIMIT=1`，保留双实例拓扑。准备阶段等待 Vault 就绪；生产连接与探测超时保持原值。验证通过 Host/Worker 故障恢复、陈旧租约拒绝、PostgreSQL 与 S3 重启、Vault 独立密钥撤销与连接中断、加密核心事实重建、插件租户隔离与幂等重建，以及离线维护排他、孤儿对象清理和校验失败保持离线。

Kind 验证使用独立的 `muniu-application-boundaries` 集群和临时 `KUBECONFIG`。镜像导出期间本机交换空间使用约 11.7 GiB，随后诊断出现控制面 TLS 连接超时，未取得完整集群验收结果；这不证明沙箱通过或失败。该项需在环境恢复后重新执行。

回归覆盖当前撤权、批准失效、已派发未知效果、重新授权后不重放、查询状态重建、敏感记录与幂等回执加密、旧核心事实的显式升级、HMAC/CAS 缺失或损坏、事务回滚，以及 PostgreSQL Worker 适配器的结算逻辑。架构检查禁止 Kernel 引入行业逻辑，禁止产品插件导入内核事务或私有业务执行服务。

未执行真实模型质量或费用实验、生产数据升级、生产负载试点、完整 Kind 集群验收、恶意插件隔离验证和研究候选准入。应用独立数据库、正式应用 SDK 与全面核心重写未包含在本次实现中。
