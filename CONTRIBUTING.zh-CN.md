# 参与木牛开发

[English](CONTRIBUTING.md)

每次贡献围绕一个已批准子计划，说明用户影响和可验证的结果。本页维护贡献规则；仓库导航、环境准备、命令与验证前置条件见[开发指南](docs/development.md)。

## 开始任务

1. 阅读 [AGENTS.md](AGENTS.md) 及修改目录内的说明，遵守其中的架构、安全、上游与工具链约束。
2. 使用专用 Git worktree。工具链固定为 Node.js `22.19.x`、npm `11.10.1`、TypeScript `5.7.2`，以及 [rust-toolchain.toml](rust-toolchain.toml) 指定的 Rust 版本。使用 `npm ci` 安装依赖。
3. 确认已批准范围和验收条件，通过[仓库地图](docs/development.md#仓库地图)定位实现与测试。Agent 还需阅读 [Agent 工作指南](docs/agent-guide.md)。

安全问题使用 [SECURITY.md](SECURITY.md) 说明的私密渠道，不要提交公开 issue。不得提交凭据、受保护业务数据、本地状态、构建产物或 sidecar 二进制。

## 实施与验证

生产行为采用 TDD：先增加或复现针对性失败测试，确认失败原因，再实施最小改动，执行目标和受影响测试。保留 [AGENTS.md](AGENTS.md) 规定的 Host 组合根、公共插件依赖、事件派生状态、`/v2` 契约、审批要求和失败关闭语义。

按[验证矩阵](docs/development.md#验证矩阵)选择检查：纯文档任务执行文档检查；产品行为、部署和发布执行[最终门禁](docs/development.md#最终门禁)。当前计划和 CI 明确要求的额外检查仍须执行，目标测试不能代替规定的基线。Rust 检查在 `apps/desktop-mac/src-tauri` 中执行，先构建 macOS Host sidecar。UI 与企业检查需要指南列出的依赖。

审阅差异中的越界修改、密钥、生成产物和过期文档。提交前执行 `git diff --check`。记录实际执行的命令和结果，包括失败或未执行的检查。纯文档检查通过不能证明产品测试已通过。

## 维护文档

公共契约、CLI 命令、插件、配置、安全行为或发布步骤变化时，同步更新文档。按[生成文件维护](docs/development.md#生成文件维护)修改来源、重新生成受版本控制的输出并审阅差异，不要手工修改生成区块。

执行 `npm run docs:check`、`npm run docs:links` 和 `npm run docs:build`。生成来源变化时先执行对应生成器。面向用户的中文应简洁，并与 Desktop 和 CLI 术语一致。本页与[英文版](CONTRIBUTING.md)应保持语义一致。

## 许可证与上游来源

木牛新增代码使用 Apache-2.0。不得复制许可证或再分发条件不明确的代码。遵守 [AGENTS.md](AGENTS.md) 规定的精确上游提交、排除范围和 MIT 声明要求。

复制或适配上游文件时，提交前在 [DeepSeek Harness 来源记录](docs/upstream-provenance/deepseek-harness.yaml)中记录精确来源提交和文件映射。Vendored Cordis 有[独立来源记录](docs/upstream-provenance/deepseek-harness-cordis.yaml)与[来源清单](vendor/SOURCE_MANIFEST.sha256)，修改前需遵守 [vendor 说明](vendor/AGENTS.md)。ColaOS 仅作产品和交互参考，不得复制其代码或声称实现来源于它。

## 签署与提交

每个提交都要使用本人姓名和有权使用的邮箱签署 DCO：

```bash
git commit -s -m "type: concise description"
```

签署表示确认[开发者来源证书](DCO-1.1.txt)。缺少 DCO 签署的提交不能合并。

使用[拉取请求模板](.github/PULL_REQUEST_TEMPLATE.md)说明用户影响、契约变化、安全与数据影响、验证结果和上游来源变化。无关改动分别提交拉取请求。第一方 0.2 workspace 保持 private；npm 包发布需要独立发布评审，信任边界变化需要架构评审。
