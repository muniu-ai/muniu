# 子计划 05：木牛控制面与产品集成实现计划

> **执行要求：** 使用 `dev-executing-plans` 逐任务执行此计划；计划执行不绑定任何外部 Agent CLI。

**目标：** 将 builtin Agent 作为默认候选执行器接入治理 Loop，并向 CLI、API、桌面和旧数据提供兼容路径。

**范围说明：** 版本化 Agent 会话和模型 Provider 调用已经由内嵌 runtime 执行，不依赖 Claude Code/Codex CLI。本计划只负责把同一 builtin runtime 接入仍保留的 classic `task/run` 产品面；不得把 legacy CLI 重新引入为隐式依赖或 fallback。

**架构：** executeGovernedIncrement 继续控制 discovery、implementation、verification 与 repair；ExecutorRegistry 只切换执行实现。不可变 Harness binding 将上下文、权限、预算、停止条件和输出 schema 传入内循环。

**技术栈：** TypeScript、Fastify、React/Tauri、SQLite、原子文件迁移。

---

## 依赖与任务

- 依赖子计划 04 的完整工具安全门禁。
- 先为 legacy ExecutionStrategy、Provider、任务记录和 doctor 行为写兼容测试，再引入 runtime/provider 分离与 ExecutorRegistry。
- builtin 默认启用；claude/codex 显式 legacy runtime 保留至 v0.2.0。
- CLI 增加 agent run/chat/resume/sessions；API/桌面提供消息流、工具状态和审批，不引入 DSH Web。
- 迁移 ~/.mniu 至 ~/.muniu 时加锁、安全备份、跳过活跃 lease、保留旧目录且不双写；muniu:// canonical，mniu:// 一版兼容。
- 新建 governance builtin v2，保留 v1 digest 和历史记录原值。
- CLI、API、桌面和证据视图统一执行数据策略：业务内容仅手机号/身份证号脱敏，其余姓名、邮箱、地址、路径、普通用户名和模型文本原样保留；凭据始终隐藏且 raw/debug 不可绕过。

## 测试命令与退出门槛

~~~sh
npm test
npm run typecheck:desktop
npm run build:desktop
(cd apps/desktop-mac/src-tauri && cargo test --locked)
npm run verify:enterprise-fixture
~~~

现有 CLI/API/桌面主流程无回归；旧数据 fixture 可迁移并回滚；builtin Agent 完成治理、验证、证据和 repair 全流程；跨产品 fixture 验证仅手机号/身份证号业务脱敏与凭据强制隐藏的一致性。
