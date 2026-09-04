# 参与木牛开发

感谢参与木牛 Agent OS 0.2。每次改动应保持范围明确、可测试，并说明安全与数据影响。

## 开始前

- 使用 Node.js 22.19.x、npm 11.10.1、TypeScript 5.7.2，以及 `rust-toolchain.toml` 指定的 Rust 工具链。
- 为单一子计划创建独立 Git worktree 和聚焦分支。
- 使用 `npm ci` 按 `package-lock.json` 安装依赖。
- 不提交构建产物、本地状态、sidecar 二进制、测试凭据或受保护业务数据。
- 安全问题使用 GitHub 私密漏洞报告，不要提交公开 issue。

## 架构规则

- `apps/host` 是唯一组合根。Desktop 与 CLI 调用相同的 Host 契约。
- `packages/kernel` 不得导入产品插件。产品插件只依赖 `@mn/contracts` 与 `@mn/plugin-sdk`，除非批准的设计明确增加其他公共 SDK 边界。
- 公共 HTTP 操作位于 `/v2`。mutation 必须提供 `Idempotency-Key`；修改现有 aggregate 时还要提供 `expectedStreamVersion`。
- 事件是事实源，投影、快照、搜索索引和 UI 卡片必须可以重建。
- 模型上下文与工具承诺必须先持久化，再执行外部工作。外部副作用结果未知时进入人工核对，不得自动重放。
- 所需 sandbox 不可用时必须失败关闭。生产插件是进程等价的可信代码，不是沙箱。
- 不得在 0.2 契约外增加状态加载器、协议别名、命令别名或兼容投影。

## 开发流程

生产行为按 TDD 实施：

1. 增加或复现聚焦失败测试。
2. 确认缺失行为导致失败。
3. 实现最小且完整的改动。
4. 运行聚焦测试、受影响 workspace 测试与相关集成门禁。
5. 检查 secret、生成产物、越界修改和过期文档。

最终仓库门禁为：

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

需要 Docker、Kind、PostgreSQL、S3 或 Apple 凭据的测试，必须说明前置条件，并在启用后失败关闭。fixture 通过只证明对应场景，不代表生产隔离已经认证。

## 文档

修改公共契约、CLI 命令、插件、配置、安全行为或发布步骤后运行：

```bash
npm run docs:generate
npm run docs:check
npm run docs:links
npm run docs:build
```

`scripts/generate-docs.mjs` 从 0.2 来源生成公共路由、OpenAPI、CLI 帮助与内置插件目录。不要手工修改生成区块。面向用户的中文应简洁，并与 Desktop 和 CLI 术语保持一致。

## 许可证与上游来源

木牛新增代码使用 Apache-2.0。不要复制许可证或再分发条件不明确的代码。

DeepSeek Harness 适配仅限固定提交 `47f943859bef60e4160492346772ded9b24f765a` 与 `141eb6fef83422698aef7a981029e843e8161534`。适配文件保留 MIT 声明，并在 `docs/upstream-provenance/deepseek-harness.yaml` 记录精确来源提交。Vendored Cordis 单独固定到 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`，由 `vendor/SOURCE_MANIFEST.sha256` 校验。

不得引用浮动 tag 或分支，不得引入排除的 DSH Web/CLI、ACP、Claude SDK payload、Linux Landlock、遥测、匿名标识或反馈上传模块。ColaOS 只作为产品和交互参考，不能声称代码来源于它。

## DCO 与拉取请求

每个提交都要使用本人姓名和有权使用的邮箱签署：

```bash
git commit -s -m "type: concise description"
```

签署表示同意 `DCO-1.1.txt`。拉取请求应说明用户影响、契约变化、安全与数据影响、已运行测试和 provenance 变化。npm 包发布或信任边界变化需要单独评审。
