# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog and versions follow Semantic Versioning where practical
during the Developer Preview.

## Unreleased

## 0.1.1 - 2026-08-20

### Added

- Embedded, event-sourced Agent runtime that connects directly to configured
  model providers without requiring Claude Code or Codex CLI.
- DeepSeek-first model provider with OpenAI-compatible, OpenAI Responses, and
  Anthropic Messages adapters.
- Versioned Agent session REST/SSE API, resumable sessions, durable approvals,
  protected event history, and bounded model audit receipts.
- Built-in policy-controlled workspace tools, Kubernetes candidate Pod
  isolation, PostgreSQL/S3 enterprise persistence, Helm deployment, and
  Cordis-based profiles and plugin lifecycle management.

### Fixed

- Deterministic built-in Agent session identifiers now use a non-numeric safe
  alphabet, so a hash can never be mistaken for protected phone or identity
  material.
- Release recovery remains bound to immutable tags and emits a production-only
  SPDX dependency SBOM while retaining complete npm/Cargo license inventories.

## 0.1.0 - Withdrawn before release

The immutable `v0.1.0` qualification tag did not produce a GitHub Release,
release asset, or GHCR image. A release-gate defect was corrected in v0.1.1;
the original tag remains unchanged for auditability.

### Added

- Initial open-source baseline for the Muniu governance control plane.
- Apache-2.0 licensing, DCO contribution policy, security policy, upstream
  provenance format, and release planning.
- Full-history secret scanning and reproducible npm/Cargo license policy gates.

### Known limitations

- Developer Preview; interfaces may change.
- macOS 12+ is the only formally supported host platform.
- No npm package or signed/notarized desktop application is published.
- The desktop runtime updater is not shipped; v0.1.x updates require an
  immutable new release and manual installation.
- Claude Code and Codex CLI are optional legacy compatibility executors. They
  are not installation or runtime prerequisites for embedded Agent sessions.
