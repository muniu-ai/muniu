# 快速开始

本指南从源码启动 macOS Desktop，并完成 Agent OS 0.2 的首次设置。需要 Node.js `22.19.x`、npm `11.10.1`、Git、Rust 工具链和 Apple 构建工具。

## 启动 Desktop

```bash
git clone https://github.com/muniu-ai/muniu.git
cd muniu
npm ci
npm run build:host-sidecar
npm run tauri:dev -w @mn/desktop-mac
```

Desktop 管理本机 Host。默认监听 `127.0.0.1:7318`，权威状态写入 `~/.muniu/v2`。如果同一端口上已有早期 daemon，Host 会拒绝启动；先退出旧进程，再重试。两个版本不能同时运行。

## 完成四屏向导

1. 选择经营视图或专业视图。两者只改变信息密度。
2. 启用 OPC、Coding 或两者。官方插件随应用提供，按工作区激活。
3. 选择厂商预设并输入自己的 API Key。向导把密钥写入 Keychain，探测连接后选择默认模型；无需填写内部厂商标识、模型标识、Base URL 或报文格式。
4. 创建工作区和第一个机会或仓库，并运行只读样例。

首次连接失败时，密钥不会写入日志或导出物。先在向导中重新探测，再运行 `mn doctor --fix` 查看 Host 与插件健康状态。

## 创建第一个 OPC 机会

在快速捕获中输入一句业务描述，例如：

```text
独立顾问每周花半天整理客户访谈，希望自动归纳证据，但不能改写原始记录。
```

系统生成可审阅的 `Opportunity`、目标客户、问题和可证伪假设。确认后再进入研究与访谈。证据卡必须同时容纳支持、反对和中立信号；最终 `pursue`、`revise` 或 `stop` 只能由人选择。

记录文件信号时直接选择文件，Desktop 会先把文件作为受保护 Asset 上传，再保存信号引用。访谈可选择 UTF-8 文本或 Markdown，也可粘贴原文；两种方式都会加密保存。机会事件和投影不复制访谈原文，后续分析只能追加标注。

OPC 固定输出机会验证档案、访谈包、证据账本、反证清单、最小收费方案和决策记录。它不会自动联系客户、发布内容、发送报价或收款。

## 创建第一个 Coding 任务

启用 Coding 后选择本地仓库，描述一个边界明确的变更。默认 Runner 是内置 Agent，界面只展示任务、diff、检查、审批、成果和下一步。Harness、候选数和预算位于高级执行设置。

Gate 失败最多自动修复 3 次，总执行时长默认不超过 3600 秒。达到上限后进入人工决策。选择 Claude 或 Codex Runner 前，系统会展示并记录可执行文件的绝对路径、版本和摘要；二进制变化后必须重新确认。

## 使用 CLI

Desktop 运行时，可从另一个终端调用 CLI：

```bash
node apps/cli/dist/index.js doctor --fix
node apps/cli/dist/index.js inbox
node apps/cli/dist/index.js plugin list
```

为脚本添加 `--json` 可获得稳定机器格式。不要使用 CLI 参数传递模型密钥，以免密钥进入 shell history；密钥应通过 Desktop 向导写入 Keychain。

## 下一步

- [CLI 参考](./reference/cli.md)
- [架构](./architecture.md)
- [插件开发](./plugin-authoring.md)
- [故障排查](./troubleshooting.md)
