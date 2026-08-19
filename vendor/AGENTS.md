# AGENTS.md — Vendored Packages

This directory contains source-vendored copies of the Cordis framework and its foundation libraries. See `vendor/README.md` for the manifest, local-modification log, and the upstream sync procedure.

**Do NOT edit `vendor/*/src/` files casually.** Every local divergence from upstream must be logged exhaustively in `vendor/README.md` under "Local modifications." The `vendor/*/tsconfig.json` files are the exception — regenerated to fit the monorepo build, and they may be touched for type-checking policy changes (e.g., `noImplicitAny`).

When changes are unavoidable, follow the sync procedure in `vendor/README.md`.

Muniu builds this snapshot with npm and TypeScript 5.7.2. After an import run
`npm run build:vendor && npm run typecheck:vendor`; do not use the upstream pnpm
commands as the Muniu acceptance gate.
