# 木牛 Agent OS 0.2

[文档](docs/index.md) · [快速开始](docs/quickstart.md) · [架构](docs/architecture.md) · [安全](docs/security/overview.md) · [参与贡献](CONTRIBUTING.zh-CN.md)

木牛为 macOS 本地环境和企业部署提供同一套 Agent OS 内核。Desktop、CLI 与 API 共用工作区、会话、执行、审批、事件、记忆、成果和持久任务；OPC 与 Coding 以产品插件的形式提供业务能力。

```text
Desktop / CLI / API Shell
            ↓
      Agent OS 内核
      ↙          ↘
  OPC 插件      Coding 插件
                    ↘
          Claude / Codex Runner Adapter
```

## 产品边界

- OPC 支持机会发现、证据验证、人工访谈、反证、最小收费方案和人工决策。它不提供 CRM、自动外联、发布、报价发送或收款工具。
- Coding 保留 Spec、Governance、Harness、Gate、Evidence 与 fail-closed sandbox。内置 Agent 是默认 Runner，Claude 与 Codex CLI 仅在用户明确选择后启用。
- 模型只通过 BYOK 连接；本地密钥写入独立的 macOS Keychain service。
- 生产插件与 Host 同进程运行，是宿主级可信代码，不是安全沙箱。安装前必须核对来源、签名、摘要、版本和权限。
- 遥测默认关闭。

## 本地启动

需要 Node.js `22.19.x`、npm `11.10.1`、Git、Rust 工具链和 Apple 构建工具。

```bash
git clone https://github.com/muniu-ai/muniu.git
cd muniu
npm ci
npm run build:host-sidecar
npm run tauri:dev -w @mn/desktop-mac
```

首次启动通过四屏向导完成视图选择、插件启用、模型连接与工作区创建。经营视图和专业视图调用相同接口并产生相同事件，只改变信息密度。

本机 Host 默认监听 `http://127.0.0.1:7318`，状态写入 `~/.muniu/v2`。桌面端运行后，可以在另一个终端检查状态：

```bash
node apps/cli/dist/index.js doctor --fix
node apps/cli/dist/index.js inbox
```

不要用命令行参数传递模型密钥，以免密钥进入 shell history。完整流程见 [快速开始](docs/quickstart.md)，命令说明见 [CLI 参考](docs/reference/cli.md)。

## 工作区结构

| 路径 | 职责 |
| --- | --- |
| `apps/host` | 本地 daemon 与企业 API 的组合根 |
| `apps/worker` | 持久任务、受控工具与 Coding sandbox 执行 |
| `apps/desktop-mac` | macOS Shell、原生能力与插件 UI 宿主 |
| `apps/cli` | 类型化命令宿主 |
| `packages/contracts` | 公共类型、错误、事件与 OpenAPI 来源 |
| `packages/kernel` | 身份、权限、插件、Job、Memory 与审计 |
| `packages/agent-runtime` | Agent、会话、模型、工具与子 Agent 运行时 |
| `packages/plugin-sdk` | 产品插件、UI、CLI 与服务贡献契约 |
| `packages/storage` | SQLite/PostgreSQL、文件/S3 CAS、Keychain/KMS |
| `plugins/opc` | 机会验证领域与成果 |
| `plugins/coding` | 研发控制面 |
| `plugins/runner-*` | 可选外部 Runner 适配器 |

## 开发门禁

```bash
npm test
npm run typecheck
npm run typecheck:desktop
npm run build:desktop
cargo test --locked
npm run verify:enterprise-fixture
npm run verify:kind
npm run verify:plugins
npm run verify:opc-ui
npm run verify:coding-ui
npm audit --omit=dev
git diff --check
```

修改文档后还应运行 `npm run docs:check`、`npm run docs:links` 和 `npm run docs:build`。

## 上游与许可证

木牛新增代码采用 Apache-2.0。DeepSeek Harness 适配只使用仓库批准的固定提交；vendored Cordis 保留 MIT 许可证。来源、文件映射和摘要记录在 `docs/upstream-provenance/` 与 `vendor/SOURCE_MANIFEST.sha256`。详情见 [架构说明](docs/architecture.md#上游边界)和仓库内 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`。
