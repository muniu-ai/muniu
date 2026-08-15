# Muniu repository instructions

These rules apply to the whole repository unless a deeper AGENTS.md narrows them.

## Toolchain

- Use Node.js 22.19.x and npm 11.10.1. Keep TypeScript on the 5.7 line until an approved migration plan changes it.
- Install from package-lock.json with npm ci. Do not commit generated dist, dist-test, target, coverage, sidecar binaries, local state, or credentials.
- First-party workspaces remain private for v0.1.0; publishing an npm package requires a separate release review.

## Development workflow

- Work in a dedicated Git worktree and keep changes scoped to one approved sub-plan.
- Use test-driven development for production behavior: reproduce or add a failing test, make the smallest implementation change, then rerun the focused and affected suites.
- Run git diff --check and the verification commands named in the active plan before committing.
- Preserve the Spec, Governance, Harness, Loop, verification, and evidence control-plane contracts unless the plan explicitly versions them.

## Upstream and licensing

- DeepSeek Harness adaptations are based only on commit 47f943859bef60e4160492346772ded9b24f765a.
- Every copied or adapted upstream file must retain its original MIT notice and be added to docs/upstream-provenance/deepseek-harness.yaml before commit.
- New Muniu code is Apache-2.0. Do not relabel adapted MIT code as solely Apache-2.0 and do not imply DeepSeek trademark endorsement.
- Do not import the excluded Claude SDK payload, DSH Web/CLI, ACP, Linux Landlock, telemetry, anonymous identifiers, or feedback upload modules.

## Security and tests

- Runtime plugin composition is static and typed. Never add eval, new Function, executable YAML/JS configuration, HMR-loaded code, or unsigned third-party executable plugins.
- Side effects must pass the centralized tool policy and approval path. Never silently fall back from a required sandbox to unsandboxed execution.
- Keep telemetry disabled by default and redact secrets from logs, fixtures, diagnostics, and test output.
- Baseline verification is npm test, npm run typecheck, npm run typecheck:desktop, npm run build:desktop, Cargo tests with --locked, npm run verify:enterprise-fixture, and npm audit --omit=dev.

