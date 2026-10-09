# Agent 检测与模型接入验证记录

日期：2026-10-09。源码基线：`c3d5d46`。范围见[实施子计划](../proposals/agent-model-connectivity-2026-10-09.md)，操作说明见[模型与外部 Agent](../guides/agents-and-models.md)。

## 实现与边界

- 工作区设置与 `doctor --workspace` 分项报告模型、插件、权限、文件身份、执行进程、沙箱和外部账号验证。读取已确认文件，不启动外部程序；未知条件不显示为已就绪。
- Codex CLI、Claude Code 仍只用于 Coding。WorkBuddy 明确显示尚未接入。没有 CLI 的 Agent 可另做 API、SDK 或 A2A 适配器；本轮没有通用外部 Agent 接入表单。
- 接入 Kimi 中国区与 Qwen 百炼北京区，分别处理模型目录、非思考模式、工具调用、用量和参考价格。未适配价格的模型不能执行，不接受任意 Base URL。
- 选择模型创建独立连接；新任务默认项写入单独的事件与投影。旧连接、执行绑定和目标计划不因默认项变化而被改写。
- SQLite 关闭重开、删除投影与幂等查询记录后可从受保护事件重建；选择和探测的同键回执保持一致，公开事件不含密钥。
- 修复经营表单保存结果未知时，事件刷新或手动读取清除错误提示的问题；重试继续使用原幂等键与版本。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| Node.js / npm / TypeScript | 22.19.0 / 11.10.1 / 5.7.2 |
| `npm test` | 796 项通过，0 失败、0 跳过 |
| `npm run typecheck` | 通过 |
| `npm run typecheck:desktop`、`npm run build:desktop` | 启动修复后重新通过 |
| `cargo test --locked` | 9 项通过 |
| `npm audit --omit=dev` | 0 项漏洞 |
| Desktop 首次设置、Coding、机会验证、目标与经营流程 | 分别 90、195、340、137、147 次真实 Host 请求通过 |
| 企业 fixture | 静态检查 22 项、Helm 检查 4 项通过；容器阶段因本机没有 Docker 而未完成 |
| 启动专项 `node apps/desktop-mac/scripts/verify-agent-os-ui.mjs startup` | 221 次请求通过；连接拒绝及 503 恢复、权限与契约错误及时停止、重试上限、15 秒超时和卸载取消 |
| 文档生成一致性、链接、构建及中文检查 | 通过 |

UI 流程使用隔离 Host 与合成资料。未用真实账号调用收费模型或外部 Agent，不能将这些测试视为账号权限、余额、登录或真实推理成功的证明。

## 安装验收

本地安装路径为 `/Applications/木牛.app`。更新前备份原应用与 `~/.muniu/v2`，保留回退副本。应用采用 ad-hoc 签名，仅供本机安装；未做 Apple Developer ID 公证，也未生成本轮公开发行包。

首次原生启动复现了界面先于 Host 就绪的错误；Host 健康且工作区响应通过契约验证，点击重试后恢复。已为首次只读请求增加最多 6 次尝试及 15 秒总截止时间；错误不会触发任何写操作重试。权限与契约错误保留原因并立即停止。

安装后的设置页已显示 Kimi、Qwen 厂商项，以及木牛内置 Agent、Codex CLI、Claude Code、WorkBuddy 的分项诊断。本机当前工作区的两个 CLI Runner 尚未启用，WorkBuddy 尚未接入；这与实际 `doctor --workspace` 结果一致。本轮未改变外部 Agent 授权、未向用户台账写入合成数据。

最终 arm64/x86_64 应用完成本地签名与校验；隔离数据目录下首次设置及重放均为 200，经营订单、收退款、复盘与幂等验证通过。安装后的主程序与 Host 摘要均匹配构建产物。再次冷启动无需手动重试，直接进入工作台；后台健康与诊断检查通过。
