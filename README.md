# 木牛 Agent OS 0.2

木牛是面向 macOS 本地使用和企业部署的 Agent 执行平台：把会话、模型调用、工具审批、成果与中断恢复放在同一套 Host 契约中。Desktop、CLI 和 API 提供不同入口；OPC 负责机会验证，Coding 负责受控研发任务。

## 选择入口

| 你要做什么 | 从这里开始 |
| --- | --- |
| 第一次启动，创建工作区和任务 | [快速开始](docs/quickstart.md) |
| 理解项目概念、现有能力和限制 | [文档首页](docs/index.md) · [能力与验证状态](docs/status.md) |
| 用 CLI 或 API 操作已有 Host | [CLI 参考](docs/reference/cli.md) · [API 路由](docs/reference/api-routes.md) |
| 修改代码或开发插件 | [开发指南](docs/development.md) · [插件开发](docs/plugin-authoring.md) |
| 让 Agent 接手仓库任务 | [AGENTS.md](AGENTS.md) · [Agent 工作指南](docs/agent-guide.md) |
| 部署和维护企业环境 | [企业运维](docs/enterprise-operations.md) · [安全边界](docs/security/overview.md) |

## 从源码启动 macOS Desktop

准备 Node.js `22.19.x`、npm `11.10.1`、Git、Rust `1.88.0` 和 Apple 构建工具。完成桌面首次设置还需要可用的模型 API Key；暂时没有密钥时，可先按 [CLI 使用指南](docs/guides/cli.md)检查 Host 和创建工作区。完整前置条件见[快速开始](docs/quickstart.md)。

```bash
git clone https://github.com/muniu-ai/muniu.git
cd muniu
npm ci
npm run build:host-sidecar
npm run tauri:dev -w @mn/desktop-mac
```

Desktop 启动本机 Host，默认地址为 `http://127.0.0.1:7318`，状态目录为 `~/.muniu/v2`。首次设置选择视图、启用插件、连接模型并创建工作区。经营视图与专业视图只改变信息密度。

保持 Desktop 运行，在仓库根目录的另一个终端执行只读检查：

```bash
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js plugin list --json
```

模型调用需要自备 API Key（BYOK）；通过 Desktop 向导录入，密钥存入 macOS Keychain。不要把密钥放在命令行参数或文档示例中。

## 理解运行边界

- `apps/host` 是唯一组合根，装配领域无关的 Kernel、Runtime、存储和产品插件。[架构说明](docs/architecture.md)解释依赖方向与事实归属。
- OPC 支持机会发现、研究、访谈、反证和人工决策；不会自动外联、发送报价或收款。Coding 在规格、检查和审批约束下执行变更。
- 工具承诺先持久化再执行；外部副作用结果未知时进入人工核对，不自动重放。
- 生产插件与宿主进程权限等价，是可信代码。插件签名不提供恶意代码隔离；需要沙箱的 Coding 执行在沙箱不可用时停止。
- 企业控制存储使用 PostgreSQL、S3 与 Vault/KMS。源码功能、测试通过和生产发布是不同状态，具体范围见[能力与验证状态](docs/status.md)。
- 遥测默认关闭。0.2 状态和协议与早期版本隔离，不自动读取旧状态。

## 参与开发

遵循[贡献指南](CONTRIBUTING.zh-CN.md)和[仓库规则](AGENTS.md)。代码地图、构建顺序、按改动选择检查及生成文档的维护方法集中在[开发指南](docs/development.md)。

使用文档时遇到问题，先查[故障排查](docs/troubleshooting.md)；报告问题见[支持说明](SUPPORT.md)。安全问题按[安全报告流程](SECURITY.md)私下提交。

## 许可证与来源

木牛新增代码采用 [Apache-2.0](LICENSE)。DeepSeek Harness 的适配使用仓库批准的固定提交，vendored Cordis 保留 MIT 许可证；具体边界见[上游说明](docs/architecture.md#上游边界)、[NOTICE](NOTICE)、[第三方声明](THIRD_PARTY_NOTICES.md)和 [vendored 摘要清单](vendor/SOURCE_MANIFEST.sha256)。
