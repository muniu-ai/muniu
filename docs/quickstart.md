# 快速开始

本指南从源码启动 macOS Desktop，确认本机 Host 可用，再建立 OPC 经营工作区。首次成功的标志是：CLI 显示“Host 已就绪”，Desktop 中能打开经营计划或客户页面。真实模型执行另行发起。

## 准备环境

需要以下工具，所有命令均在仓库根目录执行：

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS；应用声明的最低版本为 12.0 |
| JavaScript 工具链 | Node.js `22.19.x`、npm `11.10.1` |
| 原生构建 | Git、Rust `1.88.0`、Apple Command Line Tools，包含 `clang`、`lipo` 和 `codesign` |
| 本机服务 | `127.0.0.1:7318` 未被其他 Host 或旧版 daemon 占用 |
| 模型 | OPC 基础台账无需模型；Agent 执行及 Coding 需要自己的模型 API Key |

没有模型密钥也能通过 Desktop 建立 OPC 工作区、维护经营台账，或按[无模型密钥的 CLI 练习](./guides/cli.md#无模型密钥的首次练习)检查服务。

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

首次练习只启用 OPC，先建立经营台账。

1. 在“选择视图”保留默认的“经营视图”，点击“继续”。经营视图与专业视图使用相同数据和操作。
2. 在“启用插件”保留默认的“OPC 经营管理”，点击“继续”。插件按工作区启用；生产插件拥有 Host 进程权限，不是沙箱。
3. 在“连接模型”可直接继续；需要使用 Agent 时也可现在填写厂商和 API Key。填写后，会在最后提交向导时保存并探测连接。
4. 在“开始工作”填写工作区名称，选择“探索新业务”“已有客户”或“已有订单”，保留“检查插件启用状态”，点击“进入工作台”。

提交后创建工作区，并打开所选经营入口。探索新业务从经营计划开始，已有客户可直接登记需求，已有订单根据合同录入历史事实和剩余义务。

::: tip 插件检查的范围
检查只确认当前工作区已启用对应插件，并写入本地完成事件。它不会调用模型、抓取公开网页或读取真实仓库，不代表真实研究或 Coding 执行已验证。
:::

## 4. 选择下一项工作

- [管理 OPC 持续经营](./guides/business.md)：经营计划、客户、产品、订单、交付、收支和复盘。
- [完成一次 OPC 机会验证](./guides/opc.md)：界定假设、记录信号与访谈、人工决策、导出成果。
- [创建并执行 Coding 任务](./guides/coding.md)：登记仓库、生成任务、发送给 Agent、审阅差异与审批。
- [使用 CLI](./guides/cli.md)：不启动 Desktop 窗口的方式、无模型练习、JSON 输出与工作区定位。
- [故障排查](./troubleshooting.md)：构建失败、端口冲突、模型连接与执行阻塞。
