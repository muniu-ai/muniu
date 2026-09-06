# Changelog

Notable changes to Muniu Agent OS 0.2 are recorded here. Versions follow Semantic Versioning.

## 0.2.0 - Unreleased

Architecture acceptance is incomplete. Product projections are not yet fully rebuildable from events, Coding does not yet consume `follow_up` through AgentHandle, and public API response types remain incomplete. Historical backups can retain deleted wrapped data keys. Do not treat this branch as the completed 0.2 release.

### Added

- Added encrypted Memory, Thread input, Inbox, and runtime payload storage with scoped reads and revocable memory sharing.
- Added signed plugin installation and UI/CLI/Worker contribution loading, including explicit host-process trust confirmation.
- Added an OpenAPI-generated client operation catalog shared by Desktop and CLI.
- Added Kubernetes candidate command execution with pinned images, runtime checks, and authoritative Coding Gate verification.

### Fixed

- Rebuilt protected runtime indexes from event references and retained same-thread model context across restarts.
- Made Worker readiness recheck database locks; retry only PostgreSQL transactions confirmed aborted by serialization conflicts or deadlocks.
- Removed event-head rewrites from read-only PostgreSQL queries and aligned Worker and Kernel tenant-lock ordering to prevent renewal deadlocks.
- Sent complete UID preconditions when deleting Kubernetes candidate Pods and verified imported image manifests before creating digest-pinned references.
- Applied a container-local PID limit to the dedicated Kind sandbox runtime and bounded Calico manifest downloads before applying them.

### Changed

- Introduced a shared Agent OS kernel and event contract; Coding execution orchestration still requires consolidation.
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
