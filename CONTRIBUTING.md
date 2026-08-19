# Contributing to Muniu

Thank you for helping improve Muniu. v0.1.x is a Developer Preview, so public
interfaces may change with an explicit changelog entry.

## Before contributing

- Use macOS 12+, Node.js 22.19.x, npm 11.10.1, and Rust 1.88.0 for Desktop
  work. `rust-toolchain.toml` selects the pinned Rust toolchain automatically.
- Create a focused branch and isolated Git worktree.
- Install exactly from the lockfile with npm ci.
- Open a security report through private vulnerability reporting instead of a
  public issue when the report could expose users or credentials.

## Development

Production behavior follows test-driven development:

1. Add or reproduce a focused failing test.
2. Confirm the failure is caused by the missing behavior.
3. Implement the smallest change that passes it.
4. Run the focused test, affected workspace suites, and repository gates.
5. Keep generated output and local state out of commits.

Run before opening a pull request:

~~~sh
npm run typecheck
npm test
npm run typecheck:desktop
npm run build:desktop
(cd apps/desktop-mac/src-tauri && cargo test --locked)
npm run verify:enterprise-fixture
npm audit --omit=dev
git diff --check
~~~

Tests that need Docker or PostgreSQL must document their prerequisites and
must fail closed when enabled. New production logic requires at least 70%
line, function, and branch coverage when the workspace runner supports it.

## Licensing and upstream source

New Muniu contributions are accepted under Apache License 2.0. Do not copy
source from another project unless its license is compatible and provenance is
recorded. DeepSeek Harness work is limited to commit
99f6f02fecdb7dff40c3fbc9470f5907c29f74ca; adapted files retain MIT notices and
must be listed in docs/upstream-provenance/deepseek-harness.yaml.

Do not submit proprietary model payloads, credentials, generated platform
binaries, or code whose redistribution rights are unclear.

## Developer Certificate of Origin

Every commit must be signed off with the contributor's real name and an email
address they are authorized to use:

~~~sh
git commit -s -m "type: concise description"
~~~

The sign-off certifies DCO-1.1.txt. Pull requests with unsigned commits cannot
merge.

## Pull requests

Keep a pull request scoped to one concern. Explain user impact, security and
compatibility effects, tests run, and any upstream provenance changes.
Maintainers may request that unrelated changes be split before review.
