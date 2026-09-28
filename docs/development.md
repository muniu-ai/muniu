# 开发指南

本页面向修改木牛源码或文档的开发者，说明代码位置、验证入口和提交前检查。首次运行产品见[快速开始](quickstart.md)；Agent 执行任务前先读 [Agent 工作指南](agent-guide.md)。

## 阅读顺序与事实来源

1. 阅读根目录 [AGENTS.md](https://github.com/muniu-ai/muniu/blob/main/AGENTS.md) 和修改目录内的同名文件，确认工具链、依赖与安全约束。
2. 阅读[架构](architecture.md)和任务涉及的 ADR。[ADR 0011](adr/0011-agent-os-v2-hard-cutover.md)规定 0.2 隔离边界；[ADR 0012](adr/0012-application-boundaries.md)说明应用与内核边界及尚未完成的存储分离。
3. 确认本次已批准子计划的范围、验收条件和额外检查，再读目标模块源码、测试与 README。
4. 按[验证矩阵](#验证矩阵)执行检查，按[贡献指南](https://github.com/muniu-ai/muniu/blob/main/CONTRIBUTING.zh-CN.md)准备拉取请求。

| 要确认的内容 | 维护位置 |
| --- | --- |
| 工具链与可执行命令 | 根目录 [package.json](https://github.com/muniu-ai/muniu/blob/main/package.json)、各 workspace 的 `package.json`、[rust-toolchain.toml](https://github.com/muniu-ai/muniu/blob/main/rust-toolchain.toml) |
| 架构约束与设计决定 | [AGENTS.md](https://github.com/muniu-ai/muniu/blob/main/AGENTS.md)、[架构](architecture.md)、[ADR](adr/)及当前已批准子计划 |
| HTTP 路由、输入与响应 | [api.ts](https://github.com/muniu-ai/muniu/blob/main/packages/contracts/src/api.ts)、[openapi.ts](https://github.com/muniu-ai/muniu/blob/main/packages/contracts/src/openapi.ts)、[api-outputs.ts](https://github.com/muniu-ai/muniu/blob/main/packages/contracts/src/api-outputs.ts)；查阅入口为 [API 路由](reference/api-routes.md)和 [OpenAPI](reference/openapi.md) |
| CLI 命令与参数 | [CLI 源码](https://github.com/muniu-ai/muniu/blob/main/apps/cli/src/index.ts)中的 `HELP` 与命令处理；生成结果见 [CLI 参考](reference/cli.md) |
| 插件贡献与依赖 | [公共 SDK](https://github.com/muniu-ai/muniu/tree/main/packages/plugin-sdk)、插件的 `package.json` 与源码；编写规则见[插件开发](plugin-authoring.md) |
| 实际行为与已验证范围 | 当前源码、对应测试及标明提交和环境的验收记录，例如[应用边界验收](verification/application-boundaries-2026-09-28.md) |
| CI 执行内容 | [ci.yml](https://github.com/muniu-ai/muniu/blob/main/.github/workflows/ci.yml)；发布检查另见 [release.yml](https://github.com/muniu-ai/muniu/blob/main/.github/workflows/release.yml) |

设计要求、当前实现和验收结果分别回答“应该怎样”“目前怎样”“已验证什么”。发现不一致时记录差异，不把提案或历史验收记录当成当前实现，也不以现有代码为理由放宽约束。[TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md)保留供发布检查引用的稳定路径，详细设计由架构页维护。

## 仓库地图

| 目录 | 修改入口与边界 |
| --- | --- |
| `apps/host` | 唯一组合根；装配 Kernel、Runtime、存储和插件，提供 `/v2` |
| `apps/worker` | 领取持久 Job，处理租约、执行、结果提交和人工核对 |
| `apps/cli` | Host 契约的命令行 Shell |
| `apps/desktop-mac` | React 界面；`src-tauri` 是原生 Shell 和 Rust crate |
| `packages/contracts` | 公共类型、事件、API 与客户端契约 |
| `packages/kernel` | 通用执行、权限、审批和事实事件；不得导入产品插件或行业执行规则 |
| `packages/agent-runtime` | Scope、Session、Inbox 和 Agent 执行语义 |
| `packages/plugin-sdk` | 产品插件获准使用的公共能力边界 |
| `packages/storage` | SQLite、PostgreSQL、CAS、密钥、备份与完整性校验 |
| `packages/business-execution` | 第一方私有业务执行服务，由 Host 与 Worker 调用；不是公共插件 SDK |
| `plugins/opc`、`plugins/coding` | 产品领域逻辑、命令、事件与 UI 贡献 |
| `plugins/runner-*` | 用户显式选择的外部 CLI Runner Adapter |
| `vendor` | 固定版本的上游代码；修改前读 [vendor/AGENTS.md](https://github.com/muniu-ai/muniu/blob/main/vendor/AGENTS.md) |
| `scripts`、`deploy` | 生成器、跨模块验证、企业运行入口与部署配置 |
| `docs`、`examples` | 指南、参考、ADR、验收证据和版本化示例 |

大多数第一方 workspace 的 `src/` 保存实现，`test/` 保存对应测试。跨模块与部署检查主要位于 `scripts/test/`。Desktop 的浏览器验收位于 `apps/desktop-mac/scripts/`，Rust 测试在 `src-tauri` 中执行。

## 准备工作区

使用 Node.js `22.19.x`、npm `11.10.1`、TypeScript `5.7.2`。Rust 版本由根目录 `rust-toolchain.toml` 固定。先创建或复用没有其他任务占用的专用 Git worktree，再在该目录安装依赖：

```bash
node --version
npm --version
npm ci
```

不要用依赖升级解决工具链不匹配。`npm ci` 使用现有锁文件；修改依赖和锁文件应属于当前批准范围。

生产行为按 TDD 修改：先增加或复现失败测试，确认失败原因，再实现最小改动，执行目标测试和受影响模块检查。纯文档改动不需要虚构行为测试，验证要求见下一节。

首次执行单个 workspace 测试前，先在根目录执行 `npm run build`。包间导入使用构建后的输出，单包测试不会自动构建全部上游依赖。修改上游源码后也应重建依赖，避免测试读取旧产物。

本地 Host、浏览器与原生 Desktop 的启动步骤见[快速开始](quickstart.md)和 [Desktop README](https://github.com/muniu-ai/muniu/blob/main/apps/desktop-mac/README.md)。启动前先检查[状态与操作边界](#状态与操作边界)。

## 验证矩阵

以下命令除明确标出的 Rust 命令外，都从 worktree 根目录执行。按改动范围选择检查，同时遵守 [AGENTS.md](https://github.com/muniu-ai/muniu/blob/main/AGENTS.md)、当前计划要求的最终门禁或 CI。

| 修改范围 | 优先执行的检查 | 前置条件与覆盖范围 |
| --- | --- | --- |
| 纯文档、导航、示例文字 | `npm run docs:check`、`npm run docs:links`、`npm run docs:build`、`git diff --check` | 已执行 `npm ci`；检查生成内容、相对文件链接和站点构建，不证明产品行为通过 |
| API 契约或客户端生成器 | `npm run generate:contracts`、`npm run docs:generate`、`npm run test:boundaries`，再执行受影响 workspace 测试 | 同步 Host、CLI、Desktop 调用方；生成规则见下一节 |
| Kernel、Runtime、Storage | `npm run test:core`、`npm run test:apps`、`npm run test:boundaries` | 先构建；涉及持久化、恢复或权限时补充对应企业验证 |
| Host、Worker、CLI、业务执行服务 | `npm run test:apps`、`npm run test:boundaries` | 先构建；跨插件行为补充 `npm run verify:plugins` |
| 产品插件、SDK、Runner | `npm run verify:plugins` 和受影响 Worker、UI 检查 | 先构建；外部 Runner 的 macOS 行为需在 macOS 验证 |
| Desktop 界面与交互 | `npm run typecheck:desktop`、`npm run build:desktop`，以及对应的 `verify:onboarding-ui`、`verify:opc-ui`、`verify:coding-ui` | 先构建 Node workspace；UI 脚本需要系统 Chrome 或 Chromium，自行启动 Host fixture 与 Vite |
| 原生 Desktop、sidecar | `npm run verify:mac-release`，再执行下方 macOS/Rust 门禁 | macOS、Apple 构建工具、固定 Rust 工具链；先生成 sidecar |
| 企业部署与 sandbox | `npm run verify:helm`、`npm run verify:enterprise-fixture`、`npm run verify:kind` | Helm、Docker Compose；Kind 检查还需要 Docker、Kind、kubectl、curl 和镜像下载网络 |
| 依赖、许可证、上游适配 | `npm run verify:oss-baseline`、`npm run test:oss-policy`、`npm run verify:licenses`、`npm audit --omit=dev` | 更新对应许可证清单；Cargo 许可证另按 CI 执行 `cargo-deny` 检查 |

`verify:enterprise-fixture` 默认会启动 Docker Compose 中的真实依赖，并在结束时清理该 Compose 项目的容器与卷。只执行静态检查时使用 `npm run verify:enterprise-fixture -- --static`；该命令仍需要已构建的 workspace 和 Helm，其结果不能代替完整企业验证。

UI fixture 使用真实 Host 路由和内存存储、测试密钥及模型模拟。UI 验收通过不等于真实模型、Keychain 或生产存储已经通过。需要真实 macOS Keychain 读回与撤销证据时执行 `npm run verify:local-keychain`，详见[架构](architecture.md)。

### 最终门禁

以下是产品行为、部署和发布采用的完整工程基线。纯文档任务执行矩阵中的文档检查；当前计划或 [CI](https://github.com/muniu-ai/muniu/blob/main/.github/workflows/ci.yml) 明确要求的额外检查仍须执行。准备完整基线时，先具备矩阵列出的环境。`npm test` 和根目录 `npm run typecheck` 会自行执行 Node workspace 构建，但不包含 Desktop 与 Rust 验证。

```bash
npm test
npm run typecheck
npm run typecheck:desktop
npm run build:desktop
COMPOSE_PROJECT_NAME="muniu-check-$(date +%s)" npm run verify:enterprise-fixture
MN_KIND_CLUSTER_NAME="muniu-check-$(date +%s)" npm run verify:kind
npm run verify:plugins
npm run verify:onboarding-ui
npm run verify:opc-ui
npm run verify:coding-ui
npm audit --omit=dev
git diff --check
```

在 macOS 的仓库根目录生成 sidecar，然后进入 Rust crate：

```bash
npm run build:host-sidecar -- --smoke
cd apps/desktop-mac/src-tauri
cargo check --locked
cargo test --locked
cd ../../..
```

sidecar 构建只支持 macOS，使用 Apple 的 `lipo` 和 `codesign`。`--smoke` 会启动真实 Host，使用临时状态目录和 `7318` 端口，并访问默认 macOS Keychain service；临时状态清理不代表清除了 Keychain 条目。执行前先正常退出占用该端口的开发 Host 或 Desktop。sidecar 文件生成在被忽略的 `apps/desktop-mac/src-tauri/binaries/`，不要提交。

记录实际执行命令、环境和通过、失败、未执行的状态。缺少依赖时说明原因，不把未执行写成通过。纯文档检查通过只能证明文档检查通过；不能据此宣称全量测试或发布门禁通过。

## 生成文件维护

生成的参考文件可以是受版本控制的交付内容，构建产物则不可提交。先修改来源，再执行对应生成器，审阅生成差异并提交应追踪的文件。

| 生成内容 | 修改来源 | 更新与检查 |
| --- | --- | --- |
| `packages/contracts/src/generated-api.ts`、`generated-responses.ts` | `api.ts`、`openapi.ts`、`api-outputs.ts` 及引用的契约类型 | `npm run generate:contracts`；`npm run verify:contracts` |
| `docs/reference/api-routes.md` 的生成区块、`openapi.yaml` | `packages/contracts/src/openapi.ts` 及关联契约 | `npm run docs:generate`；`npm run docs:check` |
| `docs/reference/cli.md` 的生成区块 | `apps/cli/src/index.ts` 中的 `HELP` | 同上 |
| `docs/reference/plugins.md` 的生成区块 | `plugins/*/package.json` | 同上 |
| `THIRD_PARTY_NPM_LICENSES.json` | `package-lock.json` | `npm run generate:npm-license-inventory`；`npm run verify:licenses` |
| `THIRD_PARTY_CARGO_LICENSES.json` | `apps/desktop-mac/src-tauri/Cargo.lock` 与 crates.io 许可证元数据 | `npm run generate:cargo-license-inventory`；`npm run verify:licenses` |

不要直接修改标为 `Generated` 的契约文件，或 Markdown 中 `generated:…:start` 与 `generated:…:end` 之间的内容。区块外说明可直接编辑。API 响应类型变更后先生成契约，再生成文档，以免 OpenAPI 使用过期响应结构。

修改公共契约、CLI、插件、配置、安全行为或发布步骤后，更新对应参考或指南并执行：

```bash
npm run docs:generate
npm run docs:check
npm run docs:links
npm run docs:build
```

`docs:links` 检查相对链接目标是否存在，不验证标题锚点或外部网页。新增或改名页面时还需检查页内导航，并更新[文档首页](index.md)与 [VitePress 配置](https://github.com/muniu-ai/muniu/blob/main/docs/.vitepress/config.mts)。本地预览使用 `npm run docs:dev`。

## 状态与操作边界

- 本地权威状态默认位于 `~/.muniu/v2`，包含数据库和 CAS；模型密钥与包装密钥另存于 macOS Keychain。它们都不属于 Git 工作树。`MN_V2_STATE_ROOT` 只更改状态根，不隔离默认 Keychain service。测试优先使用已有 fixture，手工开发使用明确的 0.2 专用目录和测试数据。
- Git worktree 隔离源码，不隔离进程、端口、用户状态或 Keychain。不要让多个 Host 使用同一状态目录，不要删除锁文件绕过状态锁，也不要结束不属于本任务的进程。
- 不把 `~/.muniu/v2`、旧版状态、生产数据库、S3 或 KMS 当作可丢弃测试资源。备份、重建、升级和清理按[企业运维](enterprise-operations.md)及 [CLI 参考](reference/cli.md)的前置条件执行；不要通过手工删除事件、查询表或密钥修复测试。
- 企业 fixture 会创建和清理本地服务。执行前检查 [Compose 配置](https://github.com/muniu-ai/muniu/blob/main/docker-compose.enterprise.yml)的项目资源与端口；Kind 脚本拒绝覆盖同名现存集群，正常结束时删除本次创建的集群。不要复用业务环境执行这些检查。
- 不提交 `.env`、凭据、受保护业务数据、日志、`dist/`、`dist-test/`、`target/`、coverage 或 sidecar。忽略规则见 [.gitignore](https://github.com/muniu-ai/muniu/blob/main/.gitignore)；`examples/microservice-repo/` 内显式追踪的 `.mn` 示例是例外，不能按目录名批量清除。
- 发布包、签名、公证、部署、数据维护或真实外部调用必须属于已授权范围，并遵守对应发布或运维流程。发布入口见 [macOS 发布](release/macos.md)；npm 包发布需要独立发布评审。不要以调试为由绕过审批、关闭必需 sandbox 或重放结果未知的副作用。
