# Security policy

## Supported version

Security fixes target the latest released Agent OS 0.2 patch. Source snapshots, development branches, and locally modified builds do not carry a response or remediation commitment.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/muniu-ai/muniu/security/advisories/new). If that facility is unavailable, use the private contact method on the Muniu GitHub organization profile. Do not put exploit details, secrets, customer data, model context, or attachments in a public issue.

Include the affected version and commit, reproduction conditions, impact, suggested severity, and the smallest safe proof of concept. Maintainers will acknowledge complete reports when reasonably possible and coordinate remediation and disclosure. There is no guaranteed response-time SLA.

## Trust boundaries

- Official and third-party production plugins run in the Host process. Signatures, hashes, permissions, and `ExecutionAuthority` protect installation and kernel-mediated actions; they do not sandbox malicious process-equivalent code.
- The Coding sandbox isolates candidate work. If the required sandbox cannot be proved available, execution fails closed rather than running on the Host.
- Desktop and CLI are shells over the same Host contract. A view mode changes presentation only and cannot weaken policy, approval, or audit behavior.
- Telemetry and diagnostic upload are disabled by default. BYOK is the only model connection mode.

## Secrets and protected data

Local model credentials and data-wrapping keys belong in the dedicated Agent OS 0.2 Keychain service. Enterprise credentials belong in Vault/KMS. Secrets must never enter events, projections, logs, fixtures, diagnostics, search indexes, crash reports, or release artifacts.

Sensitive event payloads and CAS objects use AES-256-GCM with wrapped data keys. Deleting protected content destroys the corresponding data key and appends a tombstone; immutable audit data retains only the actor, time, object digest, and reason. Event HMAC detects database changes made without the key, but does not claim protection after Host or KMS administrator compromise.

Redaction is a secondary safeguard, not a substitute for access control. See [redaction policy](docs/security/redaction-policy.md) and [secret scanning](docs/security/secret-scanning.md).

## Tools, approvals, and recovery

Every tool call records the normalized arguments, resources, tool version, execution generation, and authority commitment before dispatch. Paths and resource digests are normalized again immediately before execution. Any change invalidates the approval.

Read-only actions and recoverable local writes may run automatically only when authority and policy allow them. Irreversible writes, external side effects, financial actions, privileged actions, and unknown effects accept only `approve_once` or `deny`. Prompt text never grants authority.

Model request context is persisted before the request. Jobs use leases and fencing tokens, and stale workers cannot commit. An external side effect with an unknown result enters `needs_reconciliation`; it is never replayed automatically.

## Network and attachments

The OPC public-web reader accepts only HTTP and HTTPS, rejects credentials in URLs, localhost, private and link-local addresses, IPv4-mapped bypasses, DNS rebinding, and cross-protocol redirects. Redirect count, response size, duration, and MIME type are bounded.

Attachments are limited to UTF-8 text, Markdown, JSON, CSV, PDF, PNG, JPEG, and WebP. The Host rejects archives, executables, path traversal, MIME masquerading, more than 20 files, files over 20 MiB, or requests over 100 MiB.

## Enterprise operation

Production readiness requires retention policies for business data, executions, deliverables, and audit records. Tenant scope applies to events, projections, jobs, CAS references, plugins, memories, and share grants. Host and Worker engine/plugin lock digests must match.

Enterprise upgrades use blue-green replacement rather than mixed-version rolling updates. PostgreSQL, S3, and Vault/KMS recovery must preserve committed events with RPO 0 and reject missing or tampered content. See [enterprise operations](docs/enterprise-operations.md).

## Desktop distribution

Public macOS artifacts require Developer ID signing, Apple notarization, stapling, Gatekeeper assessment, digest verification, and a clean-device installation test. The runtime updater remains disabled. Unsigned local builds must not be presented as public releases.

## Out of scope

Reports that require deliberately disabling documented safeguards, denial of service requiring unreasonable traffic, social engineering without a product flaw, or unsupported modified snapshots may be closed without an advisory. Credible impact is still reviewed responsibly.
