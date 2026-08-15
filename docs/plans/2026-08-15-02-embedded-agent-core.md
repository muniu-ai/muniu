# 子计划 02：内嵌 Agent 核心实现计划

> **致 Claude：** 必须使用子技能 dev-executing-plans 逐任务执行此计划。

**目标：** 在没有 Claude Code/Codex 可执行文件时，由进程内 mock 模型完成一轮 Agent 执行并产生可恢复事件日志。

**架构：** 新增 agent-protocol、agent-session、agent-llm、agent-tools、agent-kernel、agent-host 六层；选择性适配固定 DSH 提交的 Registry/Loop/Scope/Session/Prompt/Tool/LLM 闭包，外部由 Apache-2.0 木牛 façade 隔离。

**技术栈：** TypeScript 5.7、Node 22、静态依赖注入、Node test runner。

---

## 依赖与任务

- 依赖子计划 01 全绿和 provenance 格式就绪。
- 先为生命周期回滚、事件排序、取消、预算、mock tool call 写失败测试，再逐层实现最小接口。
- 不引入 DSH CLI/Web、ACP、Claude/Codex 子进程、遥测、动态配置、eval/new Function 或未签名插件。
- 每个 copied/adapted 文件保留 MIT 头并立即追加 provenance 的 upstream path、local path、mode 和修改摘要。
- 接入 AgentHost 后，用 PATH 中无 Claude/Codex 的测试进程运行一轮 mock 会话。

## 测试命令与退出门槛

~~~sh
npm run typecheck
npm test
npm audit --omit=dev
git diff --check
~~~

新生产逻辑行/函数/分支覆盖率均不低于 70%；mock 轮次、取消和崩溃后事件重建通过；无外部 Agent CLI 依赖。完成后进入子计划 03。
