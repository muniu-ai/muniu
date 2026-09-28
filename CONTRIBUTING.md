# Contributing to Muniu

[中文版](CONTRIBUTING.zh-CN.md)

Keep each contribution scoped to one approved sub-plan, with a clear user impact and verifiable result. This page covers contribution policy; the [development guide](docs/development.md) covers repository navigation, setup, commands, and verification prerequisites.

## Start here

1. Read [AGENTS.md](AGENTS.md) and any instructions in the directories you will change. Follow the architecture, security, upstream, and toolchain rules there.
2. Work in a dedicated Git worktree. Use Node.js `22.19.x`, npm `11.10.1`, TypeScript `5.7.2`, and the Rust toolchain in [rust-toolchain.toml](rust-toolchain.toml). Install with `npm ci`.
3. Confirm the approved scope and acceptance criteria. Use the [repository map](docs/development.md#仓库地图) to find the implementation and its tests. Agents should also read the [Agent guide](docs/agent-guide.md).

Report security issues through the private channel described in [SECURITY.md](SECURITY.md), not a public issue. Keep credentials, protected business data, local state, build output, and sidecar binaries out of commits.

## Implement and verify

For production behavior, add or reproduce a focused failing test, confirm the cause, make the smallest change, and run the focused and affected suites. Preserve the Host composition root, public plugin dependencies, event-derived state, `/v2` contracts, approval requirements, and fail-closed execution rules in [AGENTS.md](AGENTS.md).

Select checks using the [verification matrix](docs/development.md#验证矩阵): documentation-only tasks run the documentation checks; production behavior, deployment, and release changes run the [final gates](docs/development.md#最终门禁). Additional checks explicitly required by the active plan or CI still apply; focused tests do not replace a required baseline. Rust checks run from `apps/desktop-mac/src-tauri` after building the macOS Host sidecar. UI and enterprise checks require the dependencies listed in the guide.

Review the diff for unintended scope, secrets, generated artifacts, and stale documentation. Run `git diff --check` before committing. Report exact commands and their outcomes, including checks that failed or were not run. Documentation-only checks do not establish that the product test suite passed.

## Maintain documentation

Update documentation when public contracts, CLI commands, plugins, configuration, security behavior, or release steps change. Follow [generated-file maintenance](docs/development.md#生成文件维护): edit the source, regenerate tracked outputs, and review the resulting diff. Do not hand-edit generated blocks.

Run `npm run docs:check`, `npm run docs:links`, and `npm run docs:build`. When generated sources change, run the relevant generator first. Keep user-facing Chinese concise and consistent with Desktop and CLI terminology. This guide and its [Chinese version](CONTRIBUTING.zh-CN.md) must remain equivalent.

## Licensing and upstream source

New Muniu contributions use Apache-2.0. Do not copy code with unclear licensing or redistribution terms. Follow the exact approved commits, exclusions, and MIT-notice requirements in [AGENTS.md](AGENTS.md).

Before committing any copied or adapted upstream file, record its exact source commit and file mapping in [DeepSeek Harness provenance](docs/upstream-provenance/deepseek-harness.yaml). Vendored Cordis has [separate provenance](docs/upstream-provenance/deepseek-harness-cordis.yaml) and a [source manifest](vendor/SOURCE_MANIFEST.sha256); follow [vendor instructions](vendor/AGENTS.md) before changing it. ColaOS is a product and interaction reference only; do not copy its code or claim implementation provenance from it.

## Sign and submit

Sign off every commit using your real name and an email address you are authorized to use:

```bash
git commit -s -m "type: concise description"
```

The sign-off certifies the [Developer Certificate of Origin](DCO-1.1.txt). Commits without a DCO sign-off cannot merge.

Use the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) to explain the user impact, contract changes, security and data effects, validation results, and upstream provenance changes. Keep unrelated work in separate pull requests. First-party 0.2 workspaces remain private; npm package publishing requires a separate release review, and trust-boundary changes require architecture review.
