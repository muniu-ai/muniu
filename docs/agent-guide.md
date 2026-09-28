# Agent 工作指南

本页供在木牛仓库执行任务的 Agent 使用。[AGENTS.md](https://github.com/muniu-ai/muniu/blob/main/AGENTS.md)及更深目录的同名文件是必须遵守的约束；本页提供执行顺序，命令与前置条件由[开发指南](development.md)维护。

## 开始任务

1. 确认当前工作目录、分支、`git status --short` 和 `git worktree list`。使用本任务的专用 worktree，保留已有改动，不覆盖其他任务的工作。
2. 阅读根目录和目标目录的 `AGENTS.md`，确认已批准子计划、允许修改的范围和验收命令。用户只要求分析时不要修改；不得把讨论中的方案当作已批准实现。
3. 按[仓库地图](development.md#仓库地图)定位模块，再读目标源码、相邻测试和必要 ADR。用文件与符号搜索缩小范围，避免先遍历生成产物或整个 `vendor/`。
4. 记录当前行为、期望行为、需要保留的不变量和最小验证方式。产品行为走 TDD；纯文档按文档检查处理。

## 选择依据

| 任务 | 先读 |
| --- | --- |
| API、CLI、Desktop 行为 | [契约来源](development.md#阅读顺序与事实来源)、对应 Shell 和 Host 测试 |
| 执行、审批、权限、恢复 | [架构](architecture.md)、[事件与恢复](reference/events.md)、Kernel/Runtime/Worker 测试 |
| 产品插件与 Runner | [插件开发](plugin-authoring.md)、目标插件及 [Worker README](https://github.com/muniu-ai/muniu/blob/main/apps/worker/README.md) |
| 应用与内核分层 | [ADR 0012](adr/0012-application-boundaries.md)及边界测试 |
| 文档、导航、生成参考 | [生成文件维护](development.md#生成文件维护)、[文档首页](index.md)和 `docs/.vitepress/config.mts` |
| 企业维护与发布 | [企业运维](enterprise-operations.md)、[macOS 发布](release/macos.md)及当前授权范围 |

源码说明当前实现，ADR 与仓库规则说明约束，验收记录只证明记录中的环境和提交。发现三者不一致时明确记录，不静默选取较宽松的解释。

## 修改与验证

- 先确认 Node/npm 版本，再用 `npm ci` 安装锁定依赖。单 workspace 测试前构建依赖；按[验证矩阵](development.md#验证矩阵)选择受影响检查，保留当前计划和最终门禁要求。
- 行为改动先执行失败测试，再实施最小修改。不要同时升级工具链、调整无关模块或添加早期协议兼容入口。
- 改来源文件后使用生成器。不得手工修补生成契约、OpenAPI 或 Markdown 生成区块以使检查通过。
- 执行命令前区分源码、构建产物、测试 fixture 和用户状态。[状态与操作边界](development.md#状态与操作边界)说明端口、Keychain、Compose 清理及不可直接删除的数据。
- 检查失败时报告可复现原因。缺少环境不能视为通过，也不能关闭安全检查或将必需 sandbox 改为无隔离执行。

## 交付与交接

完成前检查 `git diff --check`、完整差异和新增文件。只在任务授权范围内提交、推送或发布；准备提交时遵守[贡献指南](https://github.com/muniu-ai/muniu/blob/main/CONTRIBUTING.zh-CN.md)的 DCO 要求。

交付内容至少包含：

- 修改结果、涉及文件，以及契约或安全边界的变化。
- 已执行命令与结果，未执行检查及原因；文档检查不代表产品测试通过。
- 未解决问题、下一步需要的环境或决定。

跨 Agent 或跨会话交接时，再附工作树路径、分支、已改文件和仍在运行的进程。不要在交接、日志或测试输出中粘贴密钥、用户状态或受保护业务数据。
