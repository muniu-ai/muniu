# Muniu repository instructions

These rules apply to the whole repository unless a deeper `AGENTS.md` narrows them.

Navigation: [Agent workflow](docs/agent-guide.md) · [Development guide](docs/development.md) · [Documentation](docs/index.md) · [Contributing](CONTRIBUTING.md).

## Toolchain

- Use Node.js 22.19.x and npm 11.10.1. Keep TypeScript exactly at 5.7.2 until an approved plan changes it.
- Install from `package-lock.json` with `npm ci`.
- Do not commit generated `dist`, `dist-test`, `target`, coverage, sidecar binaries, local state, or credentials.
- First-party 0.2 workspaces remain private. Publishing an npm package requires a separate release review.

## Architecture boundaries

- `apps/host` is the only composition root. Product plugins must not be imported by `packages/kernel`.
- Plugins may depend only on `@mn/contracts` and `@mn/plugin-sdk`, unless their approved design explicitly names another public SDK boundary.
- Desktop and CLI are shells over the same Host contract. View modes may change presentation, never business behavior.
- Product state is derived from `KernelEventV1`; projections and snapshots are not sources of truth.
- New public HTTP routes belong under `/v2`. Mutations require `Idempotency-Key`; updates to an existing aggregate also require `expectedStreamVersion`.
- Pre-0.2 state and protocols remain isolated. Do not add loaders, migrations, aliases, or compatibility projections to current code.

## Development workflow

- Work in a dedicated Git worktree and keep changes scoped to one approved sub-plan.
- Use test-driven development for production behavior: add a failing test, make the smallest implementation change, then run the focused and affected suites.
- Run `git diff --check` and the verification commands named in the active plan before committing.
- Preserve immutable Spec, Governance, Harness, Gate, Evidence and fail-closed sandbox semantics when changing the Coding plugin.
- Keep user-facing Chinese concise and consistent with the terms already used by the Desktop and CLI.

## Upstream and licensing

- DeepSeek Harness adaptations are based only on approved commits `47f943859bef60e4160492346772ded9b24f765a` and `141eb6fef83422698aef7a981029e843e8161534`. Provenance must name the exact source commit; tags and branches are not accepted.
- Vendored Cordis is pinned separately to DeepSeek Harness commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` and verified by its source manifest.
- Every copied or adapted upstream file must retain its MIT notice and be recorded in `docs/upstream-provenance/deepseek-harness.yaml` before commit.
- New Muniu code is Apache-2.0. Do not relabel adapted MIT code as solely Apache-2.0 or imply DeepSeek trademark endorsement.
- Do not import the excluded Claude SDK payload, DSH Web/CLI, ACP, Linux Landlock, telemetry, anonymous identifiers, or feedback upload modules.
- ColaOS is a product and interaction reference only. Do not copy its code or claim implementation provenance from it.

## Security and tests

- Production plugins are process-equivalent trusted code, not sandboxes. Pin versions and integrity, record lifecycle changes, and show this boundary to operators.
- Development HMR is allowed only in an explicit development profile and must remain visibly marked.
- Do not use `eval` or `new Function` outside the audited vendored Cordis configuration implementation.
- Side effects must pass the central tool policy and approval path. Never fall back from a required sandbox to unsandboxed execution.
- Persist model context and tool commitments before external work. Never replay an external side effect whose result is unknown.
- Keep telemetry disabled by default. Redact secrets and protected business data from logs, fixtures, diagnostics, and test output.
- Baseline verification is `npm test`, `npm run typecheck`, `npm run typecheck:desktop`, `npm run build:desktop`, `cargo test --locked`, `npm run verify:enterprise-fixture`, `npm audit --omit=dev`, and the focused plugin/UI gates named by the active plan.
