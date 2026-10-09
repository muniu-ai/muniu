# 模型与外部 Agent

进入工作区的**设置**，分别查看“模型连接”和“外部 Agent 调度检查”。两类连接独立：Kimi、Qwen 等模型为木牛内置 Agent 提供推理；Codex CLI、Claude Code 是外部执行器，使用各自的账号和权限。

## 判断能否调度

检测卡逐项显示当前工作区的条件：Coding 是否启用、是否允许发起执行、木牛模型连接、Runner 插件、文件身份、执行进程、沙箱、登录验证和任务批准。

| 显示状态 | 含义与处理 |
| --- | --- |
| 暂不可启动 | 至少一项已确认条件不满足，按卡片提示补齐 |
| 尚待验证 | 已检查的条件没有阻断，但仍有登录、额度或隔离环境等未验证项 |
| 已确认文件 | 只确认路径、人工版本和摘要；不能据此判断模型调用成功 |
| 尚未接入 | 木牛没有该 Agent 的执行适配器 |

“重新检查”不会启动外部 CLI，不会读取或回显 CLI 凭据，也不会产生模型费用。本地执行进程状态与 Host 健康分别显示；沙箱功能需要在实际执行中验证。只有实际任务完成，并留下执行结果与验证证据，才能确认该环境中的调用成功。

Codex CLI 与 Claude Code 当前仅用于 **Coding 任务**。启用 Coding 及对应 Runner 插件后，在卡片中展开文件配置，选择官方原生 macOS 可执行文件，检查并人工确认版本与摘要。npm/shebang 包装器不在当前 Worker 支持范围内。然后在 Coding 对话中显式选择执行器，按待办完成任务所需批准。运行时还会复核固定副本与隔离证据，检查失败不会退回无隔离执行。

外部 CLI 的登录态、账号权限和额度目前不由木牛自动探测或转交。已有 CLI 登录也不证明其凭据可在木牛隔离环境中访问；这部分仍需受控任务验证，不能把木牛模型连接成功当作外部 Agent 登录成功。官方分别提供 [Codex 非交互调用](https://learn.chatgpt.com/docs/non-interactive-mode)和 [Claude Code 命令行接口](https://code.claude.com/docs/en/cli-reference)。

## WorkBuddy 的接入边界

木牛当前尚未接入 WorkBuddy。本机 WorkBuddy 桌面与腾讯 CodeBuddy Code 是不同产品接口。WorkBuddy Managed Agents 提供使用 Agent Key 的 API，但官方当前说明其仍处于白名单内测；要接入需单独实现凭据、任务生命周期和执行证据适配。[腾讯官方说明](https://cloud.tencent.com/document/product/1831/138968)

## 没有 CLI 的 Agent

CLI 不是接入的必要条件。对于新的执行器，可按其官方接口实现木牛适配器：

| 对方提供的接口 | 接入判断 |
| --- | --- |
| REST API、SDK 或 A2A | 可实现任务提交、状态查询、取消与结果接收；仍需核实认证、幂等和结果未知时的恢复规则 |
| MCP | 先确认是否有完整任务接口；单个工具可被调用，不等于整个 Agent 可被调度 |
| 只有桌面界面 | 需要界面自动化，受窗口状态、登录和弹窗影响，不能承诺稳定无人值守 |

这些是新增适配器的设计路径，当前木牛没有通用 HTTP Agent 接入表单。新适配器仍需经过中央工具策略、审批、持久任务和结果核对；不能因换成 API 而自动重试结果未知的外部副作用。

## 连接 Kimi 和 Qwen

在设置选择厂商，输入该区域的模型开放平台 API Key，保存并检查连接。密钥通过当前部署的密钥存储保存，不在页面回显或浏览器存储中持久化。向导与设置都使用 Host 返回的同一厂商列表。

| 厂商预设 | 本次支持的模型 | 账号要求 |
| --- | --- | --- |
| Kimi（月之暗面，中国区） | `kimi-k2.6` | 月之暗面中国区 API Key |
| 通义千问（百炼北京） | `qwen-plus`、`qwen-flash`、`qwen3.5-plus` 及已核实快照 | 百炼北京区 API Key |
| DeepSeek | `deepseek-flash`、`deepseek-v4-pro`；仍被官方接受的 Flash 别名 | DeepSeek API Key |
| OpenAI | `gpt-5` 及已配置快照 | OpenAI API Key |
| Anthropic | `claude-sonnet-4-5` 及已配置快照 | Anthropic API Key |

这张表表示当前已有请求和计费策略的范围，不代表厂商全部模型。选择框会列出实际发现的模型；未配置计费策略的模型显示原因并禁用。Kimi K3、K2.7 以及其他地区的 Qwen 当前没有在此预设下开放。模型开放平台密钥与 Coding Plan、聊天订阅登录不通用。

Kimi 通过模型目录发现可用项；Qwen 使用百炼的分页模型目录。目录探测验证凭据与目录访问，不保证账号有每个模型的推理权限或余额。第一次实际任务仍可能因权限、额度或厂商服务状态失败。

本次 Kimi、Qwen、DeepSeek 请求使用非思考模式。用量按厂商响应结算，参考价格用于预算检查，不能保证最终账单；缺少价格或遇到未适配的缓存计费字段时停止调用。当前不开放任意 Base URL，也不把协议相似的厂商默认视为已支持。

在“为新任务选择模型”中选择可用项并确认后，木牛创建新模型连接并设为新任务默认，已有执行继续引用原连接。其他旧连接仍保留。主动“检查连接”会更新该连接的探测版本，已固定此版本的目标计划需要重新生成和授权。

## 命令行检查

已安装 CLI 时使用 `mn`；从源码运行则将其替换为 `node apps/cli/dist/index.js`，并先按[开发指南](../development.md)构建。

```bash
mn doctor --workspace <工作区ID> --json
mn model presets
mn model list --json
mn model select <连接ID> --model qwen-plus --version <连接版本>
```

`doctor` 不指定工作区时只检查 Host，不能据此判断 Agent 已就绪。工作区检测结果在 `data.agents`，每个 Agent 的缺项在 `checks`；`ok: true` 和退出码 `0` 仅表示诊断请求完成。

## 厂商资料

接口与价格核对日期：2026-10-09。实际模型权限以厂商账号为准。

- [Kimi 模型目录](https://platform.kimi.com/docs/models)、[Kimi K2.6 请求](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)、[Kimi 价格](https://platform.kimi.com/)。
- [百炼 OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[模型列表](https://help.aliyun.com/zh/model-studio/list-models)、[Qwen Plus](https://help.aliyun.com/zh/model-studio/qwen-plus)、[Qwen Flash](https://help.aliyun.com/zh/model-studio/qwen-flash)、[Qwen3.5 Plus](https://help.aliyun.com/zh/model-studio/qwen3-5-plus)。
- [DeepSeek 定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。
