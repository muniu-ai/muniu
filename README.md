# 木牛 Agent OS 0.2

[文档](docs/index.md) · [快速开始](docs/quickstart.md) · [架构](docs/architecture.md) · [安全](docs/security/overview.md) · [参与贡献](CONTRIBUTING.md)

木牛是面向本地与企业环境的 Agent OS。桌面端、CLI 和 API 共用一个内核；OPC 与 Coding 作为产品插件，共用会话、执行、审批、事件、记忆、成果和持久任务。

```text
Desktop / CLI / API Shell
            ↓
      Agent OS 内核
      ↙          ↘
  OPC 插件      Coding 插件
                    ↘
          Claude / Codex Runner Adapter
```

## 0.2 的使用边界

- 本地版以 macOS 为首要体验，状态保存在 `~/.muniu/v2`，模型密钥写入独立的 macOS Keychain service。
- 企业版使用 PostgreSQL、S3 与 Vault/KMS，可部署多个 Host 和 Worker 副本。
- OPC 覆盖机会发现、证据验证、人工访谈、反证、最小收费方案与人工决策；不提供 CRM、自动外联、发布、报价发送或收款工具。
- Coding 保留 Spec、Governance、Harness、Gate、Evidence 和 fail-closed sandbox；内置 Agent 是默认 Runner，Claude 与 Codex CLI 仅在显式选择后使用。
- 生产插件是与 Host 同进程的可信代码，不是沙箱。安装前必须核对来源、权限、版本和摘要。
- 遥测默认关闭，BYOK 是唯一模型接入方式。

## 本地启动

需要 Node.js `22.19.x`、npm `11.10.1`、Git、Rust 工具链和 Apple 构建工具。

```bash
git clone https://github.com/muniu-ai/muniu.git
cd muniu
npm ci
npm run build:host-sidecar
npm run tauri:dev -w @mn/desktop-mac
```

首次启动按四屏向导选择视图、启用插件、连接模型，再创建工作区与第一个机会或仓库。经营视图和专业视图调用同一接口，只改变信息密度。

CLI 连接本机 Host，默认地址为 `http://127.0.0.1:7318`：

```bash
node apps/cli/dist/index.js setup \
  --view business \
  --plugins opc,coding \
  --workspace "我的工作区"
node apps/cli/dist/index.js doctor --fix
```

请在桌面向导中录入模型密钥，避免密钥进入 shell history。完整命令见 [CLI 参考](docs/reference/cli.md)。

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
| `packages/business-execution` | 询价候选与报价动作的执行控制服务 |
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

`verify:kind` 需要 Docker、Kind、kubectl、Helm、buildx 和 curl。按修改范围运行 focused suite 后，再运行相关门禁。

## 上游与许可证

新代码采用 Apache-2.0。DeepSeek Harness 的适配只使用仓库批准的固定提交；vendored Cordis 保留上游 MIT 许可证。固定提交、文件映射和摘要记录在 `docs/upstream-provenance/` 与 `vendor/SOURCE_MANIFEST.sha256`。详见 [架构说明](docs/architecture.md#上游边界) 与仓库内 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`。
