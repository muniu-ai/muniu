# Muniu

[中文](README.zh-CN.md) · [Documentation](docs/index.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

Muniu is an open-source, evidence-first coding-agent platform. Its TypeScript agent kernel connects interactive work to a governed engineering chain:

```text
Thread → Turn → Item
             │
             └→ task → run → candidate → gate → evidence
```

v0.2.0 uses a JSON-RPC app-server as the single control entry point for the CLI, Desktop, Worker coordinator, and embedded clients. Claude Code and Codex CLI remain explicit compatibility targets; the default runtime does not depend on them.

> v0.2.0 is a Developer Preview and a one-time protocol cutover. Legacy control REST/SSE clients cannot connect to this version; migrate state to V3 before upgrading.

## Status

| Capability | Status | Boundary |
| --- | --- | --- |
| app-server v2 and `@mn/sdk` | Implemented | Fixed Codex stable subset; SDK remains private |
| `AgentEventV3` and Thread projection | Implemented | Notifications persist before delivery |
| Spec/Governance/Harness/Loop/Evidence | Implemented | Central policy remains authoritative |
| Provider/model binding | Implemented | OpenAI, Anthropic, and compatible providers |
| Governed tools, MCP, plugins, and skills | Implemented | Effect commitment, sandbox, approval, audit |
| Context compaction and CAS spill | Implemented | Fails closed instead of silently truncating |
| Persistent multi-agent graph | Implemented | Default limit: 6 agents, 4 concurrent, depth 1 |
| SQLite and PostgreSQL/S3 migration | Implemented | After the first V3 write, restore the complete backup |
| Enterprise WSS gateway | Experimental | TLS, OIDC/JWKS, tenant isolation, RBAC, recovery cursor |
| Kubernetes candidate sandbox Pods | Experimental | Independent Pods, least privilege, default-deny network |
| macOS Desktop | Build verification | No signing, notarization, or updater release |
| SBOM, licenses, and provenance | Release workflow | Generated and attested for tags |

Muniu implements only the [declared Codex app-server v2 subset](docs/compatibility-v0.2.md). It does not embed the Codex Rust kernel or claim complete Codex app-server compatibility.

## Local start

Prerequisites: Node.js `22.19.x`, npm `11.10.1`, and Git.

```bash
git clone https://github.com/muniu-ai/muniu.git
cd muniu
npm ci
npm run build
node apps/cli/dist/index.js app-server --transport ws --port 0
```

The server listens on loopback and writes its address and random bearer token to owner-only `~/.muniu/app-server.json`. In another terminal:

```bash
node apps/cli/dist/index.js init
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js agent run \
  --provider YOUR_PROVIDER_ID \
  --model YOUR_MODEL_ID \
  --prompt "Inspect this repository and improve one focused issue" \
  --cwd .
```

Create the provider first with `mn provider add` or the Desktop settings UI. The builtin Agent fails closed when its provider/model binding is missing, disabled, or incompatible.

Local app-server transports also include stdio JSONL and an owner-only Unix socket:

```bash
mn app-server --transport stdio
mn app-server --transport unix --socket ~/.muniu/app-server.sock
```

See [app-server v2 integration](docs/app-server.md) for handshake, SDK, approval, and recovery behavior.

## Strategy and extensions

An execution strategy binds the runtime, provider, model, sandbox, Gates, and approval policy:

```json
{
  "schemaVersion": 2,
  "targets": [{
    "runtimeId": "builtin",
    "providerId": "deepseek",
    "modelId": "deepseek-chat",
    "candidates": 2
  }],
  "sandbox": "isolated-worktree",
  "requiredGates": ["unit_test", "lint", "typecheck"],
  "humanApproval": "on-risk",
  "timeoutSeconds": 3600
}
```

Runtime configuration resolves in this order:

```text
base bundle → deployment profile → ~/.muniu user patch → CLI patch
```

Built-in profiles are `local`, `enterprise-api`, `enterprise-worker`, and `desktop`. Plugin manifests pin the exact version, integrity, entry point, skills, MCP servers, hooks, tools, configuration schema, and required capabilities.

Dynamic plugins, JavaScript configuration, and explicitly enabled HMR are executable, process-equivalent trusted code. They are not a sandbox. Production installations must pin and review each source and audit every configuration change.

## v0.2.0 migration

Stop all writers and complete preflight, full backup, legacy-chain verification, conversion, record mapping, V3-chain verification, and atomic cutover:

```bash
mn migrate app-server-v3 --dry-run
mn migrate app-server-v3 --apply
```

Legacy SQLite/API state, JSONL, and S3 prefixes become read-only archives. Rollback is allowed only before the first V3 write and only when all counts and digests still match. After a V3 write, stop the deployment and restore PostgreSQL, S3, and local state as one backup set. See the [v0.2.0 migration guide](docs/migration-v0.2.md).

## Enterprise deployment

`deploy/helm/muniu` includes API/Worker workloads, the V3 migration Job, WSS gateway, Service, Ingress, HPA, PDB, ServiceAccounts, and NetworkPolicies. Production values reference external PostgreSQL, S3, OIDC/JWKS, OTLP, and KMS/Vault services.

```bash
helm upgrade --install muniu deploy/helm/muniu \
  --namespace muniu --create-namespace \
  -f values.production.yaml
```

The enterprise entry point accepts WSS only. OIDC identity is verified before upgrade; tenant, subject, RBAC, permission profile, and sandbox are then fixed to the connection. Candidate workspaces are materialized from S3 content-addressed snapshots into independent Pods. Candidate Pods receive no model credentials, object-store credentials, ServiceAccount token, `hostPath`, sidecar, privilege, or default network access.

Worker claims, generations, tool mailboxes, approvals, and recovery state are PostgreSQL-backed. If an owner is lost, its generation remains immutable and unconfirmed tools are not replayed. The recovered model must issue a new tool call and approval.

## Release gates

```bash
npm ci
npm test
npm run typecheck
npm run verify:app-server-schema
npm run verify:rpc-coverage
npm run verify:migration-v3
npm run verify:sdk-e2e
npm run verify:gateway-e2e
npm run verify:desktop-e2e
npm run typecheck:desktop
npm run build:desktop
npm run verify:enterprise-fixture
npm run verify:helm
npm audit --omit=dev
```

`npm run verify:kind` additionally requires Docker, Kind, kubectl, Helm, buildx, and curl. It exercises candidate Pods, network isolation, multi-replica owner loss, PostgreSQL restart, evidence export, and lease cleanup.

## Provenance and license

The OpenAI Codex compatibility analysis is pinned to commit `99660ab3c7b861c916e467581fa9b8723504d66b` in `docs/upstream-provenance/openai-codex.yaml`. Cordis is pinned to DeepSeek Harness commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`; per-file hashes and upstream MIT notices remain under `vendor/` and `docs/upstream-provenance/`.

New Muniu code is Apache-2.0. Vendored Cordis components retain MIT. See `LICENSE`, `NOTICE`, and `THIRD_PARTY_LICENSES.md`.

## Documentation

- [app-server v2 integration](docs/app-server.md)
- [v0.2.0 compatibility matrix](docs/compatibility-v0.2.md)
- [v0.2.0 migration guide](docs/migration-v0.2.md)
- [Architecture](docs/architecture.en.md) · [中文](docs/architecture.md)
- [Plugin authoring](docs/plugin-authoring.en.md) · [中文](docs/plugin-authoring.md)
- [Enterprise operations](docs/enterprise-operations.md)
- [Security](SECURITY.md) · [中文](SECURITY.zh-CN.md)
- [Contributing](CONTRIBUTING.md) · [中文](CONTRIBUTING.zh-CN.md)
