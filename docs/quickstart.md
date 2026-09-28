# 快速开始

本指南从源码启动 macOS Desktop，确认本机 Host 可用，再创建第一个 OPC 机会。首次成功的标志是：CLI 显示“Host 已就绪”，Desktop 中能打开机会档案。真实模型执行另行发起。

## 准备环境

需要以下工具，所有命令均在仓库根目录执行：

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS；应用声明的最低版本为 12.0 |
| JavaScript 工具链 | Node.js `22.19.x`、npm `11.10.1` |
| 原生构建 | Git、Rust `1.88.0`、Apple Command Line Tools，包含 `clang`、`lipo` 和 `codesign` |
| 本机服务 | `127.0.0.1:7318` 未被其他 Host 或旧版 daemon 占用 |
| 模型 | 完成 Desktop 向导需要自己的 OpenAI、Anthropic 或 DeepSeek API Key |

没有模型密钥也能启动 Host、执行只读诊断，并通过 CLI 创建工作区和业务对象，见[无模型密钥的 CLI 练习](./guides/cli.md#无模型密钥的首次练习)。当前 Desktop 向导不能跳过“连接模型”。

## 1. 安装并构建

```bash
git clone https://github.com/muniu-ai/muniu.git
cd muniu
node --version
npm --version
rustc --version
xcode-select -p
npm ci
npm run build:host-sidecar
```

版本输出应分别为 `v22.19.x`、`11.10.1`、`rustc 1.88.0`。仓库的 `rust-toolchain.toml` 固定 Rust 版本；请使用能读取该配置的 Rust 工具链。`xcode-select -p` 应返回有效的开发工具目录。

构建结束后应出现 `mn-host sidecar 已生成`。该命令也会构建 CLI，后续无需全局安装 `mn`。它只构建文件，不会启动 Host。

## 2. 启动并检查 Host

在同一终端执行，并保持终端运行：

```bash
npm run tauri:dev -w @mn/desktop-mac
```

出现“木牛”窗口后，在另一个终端进入同一仓库根目录，执行只读检查：

```bash
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js plugin list --json
```

`doctor` 显示“Host 已就绪”后再继续。`plugin list --json` 应包含随应用提供的 `opc` 和 `coding` 插件；已安装不等于已在工作区启用。若显示未就绪或无法连接，见[故障排查](./troubleshooting.md)。

Desktop 自动启动并管理 Host，不需要同时执行 `npm run dev:host`。Host 默认使用 `http://127.0.0.1:7318`，本地状态位于 `~/.muniu/v2`。首次启动会在 macOS Keychain 中创建本地状态保护密钥；模型密钥在向导提交后另行保存。退出应用会停止它管理的 Host，状态会保留。

## 3. 完成四步向导

首次练习只启用 OPC，避免同时处理机会和仓库两种对象。

1. 在“选择视图”保留默认的“经营视图”，点击“继续”。经营视图与专业视图使用相同数据和操作。
2. 在“启用插件”保留默认的“OPC 机会验证”，点击“继续”。插件按工作区启用；生产插件拥有 Host 进程权限，不是沙箱。
3. 在“连接模型”选择厂商，填写自己的 API Key，点击“继续”。密钥不能留空。真正保存和连接探测会在最后提交向导时发生。
4. 在“开始工作”填写工作区名称，将“第一条机会”替换为以下练习文本，保留“运行只读样例”，点击“进入工作台”。

```text
独立顾问每周花半天整理客户访谈，希望自动归纳证据，但不能改写原始记录。
```

这是练习输入，不是真实客户证据。提交后会保存模型连接、探测模型、创建工作区和机会，并记录样例完成事件。

进入工作台后，打开“OPC”，点击机会卡片的“查看档案”。看到“界定这项机会”及关联的 OPC Agent 会话，即已完成首次设置。档案中的目标客户、问题和假设需要审阅补全，不能直接视为验证结论。

::: tip “只读样例”的范围
当前样例只检查工作区已启用对应插件，并写入本地完成事件。它不会调用模型、抓取公开网页或读取真实仓库。样例完成不代表真实研究或 Coding 执行已经通过验证。
:::

## 4. 选择下一项工作

- [完成一次 OPC 机会验证](./guides/opc.md)：界定假设、记录信号与访谈、人工决策、导出成果。
- [创建并执行 Coding 任务](./guides/coding.md)：登记仓库、生成任务、发送给 Agent、审阅差异与审批。
- [使用 CLI](./guides/cli.md)：不启动 Desktop 窗口的方式、无模型练习、JSON 输出与工作区定位。
- [故障排查](./troubleshooting.md)：构建失败、端口冲突、模型连接与执行阻塞。
