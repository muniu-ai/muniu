# 子计划 04：完整工具集与安全边界实现计划

> **执行要求：** 使用 `dev-executing-plans` 逐任务执行此计划；计划执行不绑定任何外部 Agent CLI。

**目标：** 提供接近 DSH 全工具集的内置能力，同时在 macOS 上默认 fail-closed。

**架构：** 所有工具经统一 registry、预算和审批管线；文件系统叠加 realpath/symlink 围栏，命令经 canonical worktree 与 /usr/bin/sandbox-exec。Web 仅 brokered search，Workflow 为声明式数据。

**技术栈：** TypeScript、macOS Seatbelt、child_process、LSP、受控后台任务。

---

## 依赖与任务

- 依赖子计划 03 的事件、审批、取消和预算协议。
- 逐类 TDD 实现文件、Shell、终端、LSP、Skills、子 Agent、Jobs、Workflow、Todo/Plan、Web Search、附件、spill 和 compaction。
- Seatbelt 启动时执行正反向有界探测；探测失败只返回 SANDBOX_UNAVAILABLE，绝不裸跑。
- 只读范围内操作自动允许；越界路径、网络、后台及外部副作用逐次审批；破坏性操作不能永久授权。
- 终端、Job 和子 Agent 继承父预算并在关闭/取消/崩溃恢复时清理。
- 收紧 Tauri CSP、Home 文件权限和 updater 能力。

## 测试命令与退出门槛

~~~sh
npm test
npm run typecheck:desktop
npm run build:desktop
(cd apps/desktop-mac/src-tauri && cargo test --locked)
~~~

路径/符号链接逃逸、Home 敏感文件、工作区外写、Shell 网络、审批绕过、资源泄漏和恢复重放测试全绿；SECURITY.md 明示 Seatbelt 残余风险。
