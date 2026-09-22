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
| A2 | Sales 镜像、租户映射、同源入口及兼容矩阵 | 待实施 |
| A3 | OSS/COS 原子防覆盖、错误归一化和恢复适配 | 待实施；需要供应商环境验证 |
| B1 | 活性与就绪分离、停止领取、优雅退出 | 待实施 |
| B2 | 版本切换、签名准入、联合恢复及完整故障矩阵 | 待实施；需要隔离验收环境和发布责任人 |
| C | 量测、outbox、报表及独立锁粒度改造 | 待实施 |
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
