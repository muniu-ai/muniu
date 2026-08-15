# 子计划 05：木牛控制面与产品集成实现计划

> **致 Claude：** 必须使用子技能 dev-executing-plans 逐任务执行此计划。

**目标：** 将 builtin Agent 作为默认候选执行器接入治理 Loop，并向 CLI、API、桌面和旧数据提供兼容路径。

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

## 测试命令与退出门槛

~~~sh
npm test
npm run typecheck:desktop
npm run build:desktop
(cd apps/desktop-mac/src-tauri && cargo test --locked)
npm run verify:enterprise-fixture
~~~

现有 CLI/API/桌面主流程无回归；旧数据 fixture 可迁移并回滚；builtin Agent 完成治理、验证、证据和 repair 全流程。

