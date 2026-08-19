# Muniu

[中文](README.zh-CN.md) · [Documentation](docs/index.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

Muniu is an open-source, evidence-first coding-agent control plane. It turns an engineering task into a durable chain:

```text
task → run → candidate → gate → evidence
```

The default runtime is the embedded `builtin` Agent. Claude Code and Codex CLI remain explicit compatibility runtimes; they are not required for a default engineering run.

> v0.1.0 is a Developer Preview. Do not infer production readiness from an API or configuration surface alone; use the status matrix below.

## Why Muniu

- Durable Agent sessions bind model input, tool calls, approvals and results.
- Multiple candidates run under one immutable strategy and Gate plan.
- Evidence remains attributable to its runtime, model, profile, plugin set and sandbox capability.
- Local, enterprise API, enterprise worker and macOS Desktop share runtime contracts.
- Cordis provides dependency injection, isolated Contexts, effects, cleanup, executable configuration and trusted plugin reload.

## Status

| Capability | Status | Notes |
| --- | --- | --- |
| Task/run/candidate/Gate/evidence flow | Implemented | Durable local state; governed checkpoints |
| Embedded builtin Agent | Implemented | Provider/model binding required |
| Workspace tools | Implemented | Boundary, policy, approval, timeout and audit |
| Gate repair loop | Implemented | Bounded structured failure feedback |
| Agent session recovery | Implemented | Enterprise S3 retains runtime overlays |
| Cordis Context/effects/events | Implemented | Fixed upstream snapshot and provenance |
| Trusted local/npm plugins | Experimental | Same authority as host; not a sandbox |
| Claude/Codex CLI runtimes | Compatibility | Selected explicitly |
| PostgreSQL/S3 enterprise sessions | Experimental | Tenant CAS and integrity verification |
| Multi-replica run queue | Implemented | PostgreSQL authoritative |
| Helm API deployment | Experimental | Worker is fixture-only until the sandbox Pod provisioner ships |
| Kubernetes candidate sandbox Pods | Planned | Deny policy exists; provisioner incomplete |
| macOS Desktop build | Implemented | No v0.1 signing/notarization/updater promise |
| Release/SBOM/provenance | Release workflow | Produced for published tags |

v0.1.0 does not publish or enable a desktop runtime updater. Signing,
notarization and automatic-update artifacts remain outside this release.

## Five-minute local start

Prerequisites: Node.js `22.19.x`, npm `11.10.1`, and Git.

```bash
git clone https://github.com/muniu-ai/muniu.git
cd muniu
npm ci
npm run build
npm run dev:api
```

In another terminal:

```bash
node apps/cli/dist/index.js init
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js agent run \
  --provider YOUR_PROVIDER_ID \
  --model YOUR_MODEL_ID \
  --prompt "Inspect this repository and improve one focused issue" \
  --cwd .
```

Create the provider first with `mn provider add` or the Desktop settings UI. The builtin Agent fails closed when its provider/model binding is missing or disabled.

## Minimal strategy

New writes use `ExecutionStrategyV2`:

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

Legacy `providers: ["claude", "codex"]` strategies are accepted for one compatibility version and normalized deterministically. Responses and new snapshots emit V2 only.

## Agent CLI

```bash
mn agent run --provider ID --model ID --prompt "..." [--cwd .]
mn agent chat --provider ID --model ID [--prompt "..."] [--cwd .]
mn agent resume SESSION_ID --prompt "..."
mn agent sessions [--limit 100]
```

Commands emit JSON. API failures preserve the HTTP status and structured body; failed commands exit non-zero.

## Profiles and plugins

Configuration resolves in this order:

```text
base bundle → deployment profile → ~/.muniu patch → CLI patch
```

Built-in profiles are `local`, `enterprise-api`, `enterprise-worker` and `desktop`.

```bash
mn profile inspect
mn profile validate --file config/runtime/profiles/local.yml
mn plugin list
mn plugin install ./my-plugin.mjs
mn plugin install @scope/my-plugin@1.2.3
mn plugin reload
mn plugin remove PLUGIN_ID
```

Installation records an exact version and integrity value. Plugins are executable, process-equivalent trusted code. They can access every credential, file and network capability available to the host. Muniu does not claim plugin sandbox isolation.

## State migration

- Local state moved from `~/.mniu` to `~/.muniu`; the old directory is renamed automatically when the new one does not exist.
- API snapshots migrate from V1/V2 to V3 after writing a versioned backup.
- Migration is repeatable; unknown or corrupt snapshots are never overwritten.
- `muniu://` is canonical. `mniu://` remains a one-version compatibility alias.

## Enterprise deployment

The chart at `deploy/helm/muniu` deploys API replicas, a migration Job, Service, optional Ingress, HPA, PDB, ServiceAccount and NetworkPolicies. Its Worker is disabled by default and can only be enabled in explicit mock fixture mode in v0.1.0. Production values reference external PostgreSQL, S3, OIDC/JWKS, OTLP and KMS/Vault services.

```bash
helm upgrade --install muniu deploy/helm/muniu \
  --namespace muniu --create-namespace \
  -f values.production.yaml
```

The chart disables service-account token automount, runs as UID 10001, drops Linux capabilities and uses a read-only root filesystem. Candidate sandbox Pods must have no `hostPath`, Kubernetes API permission or default network access. The Kubernetes sandbox provisioner remains planned in v0.1.0.

## Development checks

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run test:coverage:agent
npm run verify:oss-baseline
npm run verify:enterprise-fixture
npm audit --omit=dev
npm run typecheck:desktop
npm run build:desktop
```

Docker, PostgreSQL and Kind checks are opt-in and document their prerequisites.

## Cordis provenance

Cordis, cosmokit, schemastery, loader, include, group, hmr, timer and logger-console are vendored from DeepSeek Harness commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. Upstream MIT licenses, package names, per-file hashes and provenance are retained under `vendor/` and `docs/upstream-provenance/`. They are private implementation dependencies and are not separately published by Muniu.

## Documentation

- [Quickstart](docs/quickstart.md) · [English](docs/quickstart.en.md)
- [Architecture](docs/architecture.md) · [English](docs/architecture.en.md)
- [Plugin authoring](docs/plugin-authoring.md) · [English](docs/plugin-authoring.en.md)
- [Enterprise operations](docs/enterprise-operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Migration guide](docs/migration-v0.1.md)
- [Security](SECURITY.md) · [中文](SECURITY.zh-CN.md)
- [Contributing](CONTRIBUTING.md) · [中文](CONTRIBUTING.zh-CN.md)
- [Historical plans](docs/plans/)

## License

Muniu is Apache-2.0. Vendored Cordis components retain their upstream MIT licenses. See `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES.md`.
