# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog and versions follow Semantic Versioning where practical
during the Developer Preview.

## Unreleased

### Added

- Versioned OPC domain contracts for governed Operation Runs, business records,
  customer commitments, attention items, action authority, settlements,
  controlled publication, and declarative business packs.
- Eighteen app-server v2 OPC methods and matching TypeScript SDK services while
  retaining the v0.2 coding Run projection for one compatibility cycle.
- Append-only tenant-scoped OPC persistence for local SQLite and PostgreSQL
  with composite tenant keys, forced RLS, revision CAS, and idempotent replay.

### Security

- OPC decision roles are bound to the authenticated principal, and every OPC
  write derives its tenant from request authentication rather than request data.

## 0.2.0 - 2026-08-23

### Added

- JSON-RPC app-server v2 protocol, stdio/Unix socket/WebSocket transports, an
  OIDC-authenticated enterprise WSS gateway, and the private TypeScript SDK.
- Durable `AgentEventV3` Thread/Turn/Item facts, context compaction, structured
  output, attachments, resumable approvals, MCP runtime, and multi-agent graphs.
- SQLite and PostgreSQL/S3 migration tools with immutable archives, digest
  mapping, dry-run, atomic activation, and write-protected rollback.
- Desktop thread timeline, approval center, execution inspectors, sub-agent
  graph, evidence export, and reconnect recovery verification.

### Changed

- CLI, Worker coordination, and Desktop control traffic now use `@mn/sdk` and
  one app-server capability contract.
- OpenAI Codex compatibility is pinned to commit
  `99660ab3c7b861c916e467581fa9b8723504d66b` and limited to the declared stable
  method and field subset.

### Removed

- Public control REST/SSE routes, legacy control DTOs, and silent compatibility
  for v0.1 clients. HTTP remains only for operations and controlled content.

### Migration

- Stop all writers and follow `docs/migration-v0.2.md`. After the first V3
  write, rollback requires restoring PostgreSQL, S3, and local state together.

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
