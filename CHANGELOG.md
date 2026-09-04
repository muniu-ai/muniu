# Changelog

Notable changes to Muniu Agent OS 0.2 are recorded here. Versions follow Semantic Versioning.

## 0.2.0 - 2026-09-04

### Changed

- Replaced separate Agent Session and Task/Run control planes with one Agent OS kernel and one event model.
- Made `apps/host` the Cordis composition root and separated persistent work into `apps/worker`.
- Moved product behavior into the bundled OPC and Coding plugins; made Claude and Codex CLI optional Runner adapters.
- Introduced workspace-scoped Thread, Execution, Approval, Event, Memory, Deliverable, Asset, Job, and Agent Runtime contracts.
- Replaced the public HTTP and CLI surfaces with the 0.2-only `/v2` and `mn` contracts.
- Added a four-screen macOS onboarding flow, business and professional views, a unified inbox, result-first cards, and plugin failure isolation.
- Added PostgreSQL/S3/Vault/KMS enterprise ports alongside the SQLite/file CAS/Keychain local implementation.

### Security

- Persisted model context and tool commitments before external dispatch.
- Added effect classes, one-shot approvals, authority commitments, TOCTOU checks, Job fencing, and manual reconciliation for unknown side-effect results.
- Added signed plugin repository metadata, monotonic release sequences, revocation handling, exact dependencies, projection replay, and atomic activation.
- Added tenant/workspace isolation, encrypted protected payloads, event HMAC, governed memory sharing, and bounded attachment handling.

### Removed

- Removed former control-plane packages, commands, projections, state loaders, protocol aliases, and active documentation.
- Removed automatic access to external Runner configuration, prompts, skills, tools, proxies, and historical sessions.

Earlier release history remains available from the repository's immutable [release tags](https://github.com/muniu-ai/muniu/tags).
