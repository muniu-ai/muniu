# 架构升级实施记录

依据 2026-09-22《木牛系统架构优化与部署方案》，从 OS `1fbd9cbb83596110633736aa075e6cab8fb8c874` 实施。Sales 对照版本为 `b2e5a13ae59b40d5a51b869bb1159595c064ff12`。升级按独立子计划推进，生产准入仍取决于原有 P5、P6、P7 证据。

## A1：企业工业组合

本工作区仅实现 A 阶段的 OS 企业工业入口：Host 加载受信 Sales 服务、工作区映射及执行授权凭据；企业 Worker 注册候选和动作处理器；Helm 提供只读配置与凭据挂载，并校验能力声明。沿用现有候选再授权、双审批、租约、fencing、unknown 和核对协议。

标准企业部署仍要求 Kubernetes Coding 隔离资源。专用 RFQ-only profile、云存储原生适配、Sales 镜像及身份路由、探针、联合恢复和性能改造分别实施，不通过修改默认值绕过这些要求。

验证顺序：新增组合与部署负面测试并确认失败；最小接线后重新执行；执行 `npm test`、`npm run typecheck`、`npm run typecheck:desktop`、`npm run build:desktop`、桌面 Cargo `test --locked`、`npm run verify:enterprise-fixture`、`npm run verify:helm`、`npm audit --omit=dev` 及 `git diff --check`。真实依赖、Kind、跨仓候选九项和 72 次故障矩阵分别记录，测试替身不能替代。

## 待实施与外部验收

| 子计划 | 范围 | 状态 |
| --- | --- | --- |
| A1 | OS 企业工业组合 | 代码与本地检查通过；真实依赖验收未完成 |
| A2 | Sales 镜像、租户映射、同源入口及兼容矩阵 | 代码已整合至 Sales `307d954`；本地数据库与 PDF 通过，实际镜像待验 |
| A3 | OSS/COS 原子防覆盖、错误归一化和恢复适配 | 待实施；需要供应商环境验证 |
| B1 | OS Worker 活性与就绪分离、停止领取 | 两端代码与本地检查通过；容器及真实依赖故障待验 |
| B2 | 版本切换、签名准入、联合恢复及完整故障矩阵 | 离线清单校验已实现；切换、全故障矩阵和真实恢复待验 |
| C | 量测、outbox、报表及独立锁粒度改造 | 迁移、outbox、报表和本地量测已实现；完整负载与锁粒度改造单独实施 |
| D | 获准真实资料、模型与业务试点 | 未开始；保持原有准入门禁 |

## A1 验证结果（2026-09-22）

- `npm test`：631 项通过。工业动作和 Host 边界的测试存储已注入与 Worker 相同的固定时钟，避免随执行日期变化误判租约过期；未放宽生产租约校验。
- 类型检查、桌面类型检查与构建、sidecar 构建和 smoke：通过。
- `cargo test --locked`：6 项通过；使用 2 个编译任务和既有 Cargo 缓存。
- 组合测试、Helm 正反例和企业静态 fixture：通过。
- 原样执行 `npm run verify:enterprise-fixture`：静态部分通过，随后因 Docker 不在命令路径且守护进程未运行而失败。`--static` 补验通过，不替代真实依赖或 Kind。
- `npm audit --omit=dev`：两次连接官方审计接口失败，分别为 ETIMEDOUT 和 ECONNRESET，安全审计未通过验证。
- `git diff --check`：通过。

## 主线整合依据

用户要求 `muniu/main` 保存最新完整代码。工业交付基线完整继承原 main `5069165ad921d94366941f0b3ce99a5c1b5f13c5`，领先 126 个提交，并包含 `codex/agent-os-0.2` 的运行时和产品集成。整合采用快进，保留原提交历史。

早期 app-server、v0.3 试验和旧 UI 工作区不满足[现行单控制面决策](../adr/0011-agent-os-v2-hard-cutover.md)，不能通过合并旧目录恢复为第二套控制面。其他工作区的未提交内容保持原样；memory-security 工作区的加密记忆等实现已在当前集成代码中出现，不重复套用旧补丁。

GitHub 远端读取因连接 github.com:443 超时失败。此处主线整合指本地 main，不能据此宣称已同步远端。

## B1：Worker 健康与领取控制

本子计划从 A1 提交 `d2cbae2` 建立独立工作区。就绪检查核对 KMS 和数据库 lock；未通过时阻止下一次领取。活性文件独立检查进程事件循环，不把依赖不可用当作进程死亡。停止信号到达后，即使探测返回成功也不能发起新领取。在途任务仍使用既有取消、租约和未知结果协议。

先执行新增依赖故障、探测期间停止、文件写入失败及 Helm 双探针用例，再执行受影响测试和仓库基线。保持 `Recreate`、30 秒租约与版本 lock。真实 KMS/数据库故障和 Pod 行为需在部署环境复验。

B1 验证：`npm test` 634 项通过，类型与桌面检查、桌面构建、9 项定向测试和企业静态 fixture 通过。Cargo 代码、依赖及锁文件与 A1 相同，沿用 A1 的 6 项结果；真实 Docker/Kind 与依赖审计仍受上述环境条件阻塞，未宣称完整企业验收通过。

## 2026-09-22 配套基线

OS 代码版本 `94a73ea` 已整合至本地 `muniu/main`；Sales 代码版本 `cefec9f` 已快进整合至方案所在工作区 `muniu-system-architecture`。Sales 实现认证租户路由、返回范围检查、OS 身份头转交，以及固定工具链和基础镜像的多阶段 Dockerfile。最终镜像构建包含非 root 中文 PDF 测试，但尚未实际构建。

两端源码及契约摘要见[配套工程候选清单](https://github.com/muniu-ai/muniu/blob/main/docs/industry-delivery/architecture-paired-candidate.json)。该文件没有签名、生产镜像 digest 或业务准入效力。Sales 的 11 项领域测试、类型、契约和三种构建通过；严格 lint 仍有 180 项错误。完整数据库、RFQ 与双仓库验收未执行。

原方案 A～D 尚未整体完成。A3 云存储、Sales 探针和退出、发布切换、完整故障与联合恢复、性能量测和优化，以及真实模型与业务试点继续按原计划验收；不能用本次代码提交替代。

## 2026-09-23 本地实施与整合

本轮按独立工作区完成五组改动，并保留工程门禁与业务准入的区别：

- Sales 健康与退出：独立活性、数据库就绪、本机 PDF 能力检查；退出等待请求、后台工作及探测结束。容器直接运行 Node，API 和独立 Worker 分别配置 35 秒、150 秒退出期限。
- Sales 迁移：登记 SHA-256、执行时间与角色，事务锁保护执行；拒绝历史篡改和缺失/未知版本。迁移表对应用身份只读；部署前须用迁移身份执行 009、010 及首次登记。
- Sales outbox：索引领取、每轮 1 项 pending 和至多 100 项过期租约；独立 Worker 的 2 个租户槽位及轮换；调用与提交都核对 attempt 和租约，未知结果不自动重发。
- Sales 报表：数据库先过滤访问范围，保留来源复核；按订单读取收款并使用索引；商机、阶段和归因历史一次分组。
- OS 联合恢复：[离线清单校验](joint-recovery-inventory.md)核对受信签名、文件摘要、对象映射、撤销检查点和完整副作用窗口；输出待核对 operationKey，始终不允许重放或生产准入。

Sales 已快进整合至方案所在仓库 `307d954`。OS 实现为 `b9d97fc`，整合至本地 `muniu/main`。配套源码及摘要见[当前工程候选](https://github.com/muniu-ai/muniu/blob/main/docs/industry-delivery/architecture-paired-candidate.json)。两仓库边界保留，Sales 代码不复制进 OS 内核。

验证结果：OS 638 项测试、类型与桌面检查、桌面构建、sidecar smoke、6 项离线 Cargo 测试、企业静态 fixture 通过。恢复模块补充的 4 项定向测试通过。Sales 131 项完整回归通过，包含嵌入式数据库和实际中文 PDF；类型、契约、Web/小程序/完整构建通过；容器入口补充的 3 项源码检查通过。未启动 Docker、真实数据库、云服务或模型。

单租户 10 万条 outbox 历史的本机量测中，读取从 100001 条降至 1 条，约从 398.64 ms 降至 1.18 ms；只能证明本地夹具中的查询变化，不能替代原计划的 5 租户混合负载与 PostgreSQL 容量验收。

仍有本地待办：Sales 严格 lint 的 180 项既有错误需要类型及 UI 专项整改；RFQ-only 专用部署与锁粒度改造需各自的设计及验证子计划。真实镜像、OSS/COS、防故障切换、联合恢复与业务试点仍未完成。依赖安全审计和 GitHub 同步本轮未连接外部服务，P5/P6/P7 状态未放开。
