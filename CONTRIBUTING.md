# Contributing to Muniu

Thank you for improving Muniu Agent OS 0.2. Keep each change focused, testable, and explicit about security and data effects.

## Before contributing

- Use Node.js 22.19.x, npm 11.10.1, TypeScript 5.7.2, and the Rust toolchain selected by `rust-toolchain.toml`.
- Create an isolated Git worktree and a focused branch.
- Install dependencies from `package-lock.json` with `npm ci`.
- Keep generated build output, local state, sidecar binaries, test credentials, and protected business data out of commits.
- Report security issues through private vulnerability reporting, not a public issue.

## Architecture rules

- `apps/host` is the only composition root. Desktop and CLI are shells over the same Host contract.
- `packages/kernel` must not import product plugins. Product plugins depend only on `@mn/contracts` and `@mn/plugin-sdk` unless an approved design names another public SDK boundary.
- Public HTTP operations belong to `/v2`. Mutations require `Idempotency-Key`; updates to an existing aggregate also require `expectedStreamVersion`.
- Events are facts. Projections, snapshots, search indexes, and UI cards must remain rebuildable.
- Model context and tool commitments must be persisted before external work. Unknown external-side-effect results enter reconciliation and are never replayed automatically.
- Required sandbox execution fails closed. Production plugins are process-equivalent trusted code, not sandboxes.
- Do not add state loaders, protocol aliases, command aliases, or compatibility projections outside the 0.2 contract.

## Development workflow

Use test-driven development for production behavior:

1. Add or reproduce a focused failing test.
2. Confirm that the missing behavior causes the failure.
3. Implement the smallest coherent change.
4. Run the focused suite, affected workspaces, and relevant integration gates.
5. Review the diff for secrets, generated artifacts, unintended scope, and stale documentation.

The final repository gate is:

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

Tests that require Docker, Kind, PostgreSQL, S3, or Apple credentials must document those prerequisites and fail closed when enabled. A passing fixture is evidence for that fixture, not a claim of production isolation.

## Documentation

Run the documentation checks whenever public contracts, CLI commands, plugins, configuration, security behavior, or release steps change:

```bash
npm run docs:generate
npm run docs:check
npm run docs:links
npm run docs:build
```

`scripts/generate-docs.mjs` derives public routes, OpenAPI, CLI help, and the built-in plugin catalog from their 0.2 sources. Do not hand-edit generated blocks. Keep user-facing Chinese concise and consistent with Desktop and CLI terminology.

## Licensing and upstream source

New Muniu contributions are accepted under Apache License 2.0. Do not copy code whose license or redistribution terms are unclear.

Selective DeepSeek Harness adaptations are restricted to commits `47f943859bef60e4160492346772ded9b24f765a` and `141eb6fef83422698aef7a981029e843e8161534`. Adapted files retain their MIT notices and record the exact source commit in `docs/upstream-provenance/deepseek-harness.yaml`. Vendored Cordis is pinned separately to `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` and verified by `vendor/SOURCE_MANIFEST.sha256`.

Do not use floating upstream tags or branches. Do not import the excluded DSH Web/CLI, ACP, Claude SDK payload, Linux Landlock, telemetry, anonymous identifier, or feedback-upload modules. ColaOS is a product and interaction reference only; do not claim source provenance from it.

## Developer Certificate of Origin

Sign every commit with a real name and an email address you are authorized to use:

```bash
git commit -s -m "type: concise description"
```

The sign-off certifies `DCO-1.1.txt`. Pull requests with unsigned commits cannot merge.

## Pull requests

Explain the user impact, contract changes, security and data effects, tests run, and any upstream provenance changes. Keep unrelated work in separate pull requests. Publishing an npm package or changing a trust boundary requires a separate release or architecture review.
