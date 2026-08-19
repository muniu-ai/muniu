# Security policy

## Supported versions

Muniu v0.1.x is a Developer Preview. Only the latest released v0.1 patch is
eligible for security fixes. Source snapshots and unreleased branches receive
no security support commitment.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for
https://github.com/muniu-ai/muniu. If that facility is temporarily
unavailable, contact the maintainers through the private contact method listed
on the Muniu GitHub organization profile. Do not include exploit details,
secrets, or affected user data in a public issue.

Include the affected version and commit, reproduction conditions, impact,
suggested severity, and a minimal proof of concept. Maintainers will
acknowledge a complete report when reasonably possible, coordinate a fix and
disclosure, and credit reporters who request credit. There is no guaranteed
response or remediation SLA for the Developer Preview.

## Security posture

- Telemetry and diagnostic upload are disabled by default.
- Only context selected for a configured model request is sent to that model
  endpoint. Users remain responsible for the endpoint's terms and data policy.
- Secrets must use the encrypted secret store and must not appear in logs,
  fixtures, diagnostics, or release artifacts.
- Business-content redaction is deliberately narrow: only mobile/cellular
  phone numbers and government-issued identity card numbers (including PRC
  resident identity card numbers) are redacted. Names, email addresses,
  postal addresses, filesystem paths, ordinary usernames, and model text are
  not redacted. Credentials remain a separate security class and are always
  hidden; no raw-output option may expose API keys, tokens, passwords, or
  private keys. See `docs/security/redaction-policy.md`.
- Cordis profiles may load arbitrary executable plugins and executable YAML/JS
  configuration. Installed plugins are process-equivalent trusted code: they
  can access the host process, credentials available to it, and its network and
  filesystem permissions. Administrators must pin and audit every plugin; this
  mechanism is not a sandbox. Direct application use of `eval` and `new
  Function` remains prohibited outside the audited vendored configuration
  implementation.
- Side-effecting tools require centralized policy and approval checks.

AgentHost cancellation is cooperative. Disposal refuses new runs, aborts every
active run, and retains model adapters, tools, and session writers until those
runs settle. An adapter or tool that does not observe its supplied AbortSignal
can therefore delay disposal indefinitely; v0.1 does not forcibly terminate
in-process third-party code.

Builtin Agent session headers and JSONL events persist only the fixed protected
DTO profile. Phone numbers, PRC identity numbers, and credentials are replaced
before the durable fsync boundary; ordinary names, email addresses, paths, and
business text are not broadly hidden. Model execution uses a process-local
overlay that always removes credentials while retaining business values needed
by the active run. That overlay is never reconstructed from protected records:
reopened history without an authorized overlay fails with
`RUNTIME_OVERLAY_REQUIRED`. Legacy raw v1 Agent logs fail closed with
`LEGACY_UNPROTECTED_SESSION` and are not rewritten implicitly. If protected
low-entropy creation inputs make an idempotent retry ambiguous, the store also
fails closed instead of treating two different raw values as equal.

Builtin side effects use a process-local HMAC commitment gate. The runtime
binds the protected argument digest, synchronously snapshotted governance and Harness policy
digests, session/run/candidate identifiers, turn/step, tool identity, and call
identifier; the protected `tool/call` record must reach the durable fsync
boundary before that one-shot handle is verified and consumed immediately
before tool dispatch. The HMAC key and executable arguments are never written
to the event log. A durable commitment is an audit correlation record, not a
restart-verifiable capability: recovery marks an incomplete effect
`interrupted`, reports an unknown outcome when it had started, and never
rebinds or automatically replays it. If a normal terminal result exceeds the
protected event boundary, the runtime writes a fixed, bounded unknown-outcome
result instead. If both terminal writes fail, it leaves the turn open so
recovery can append that unknown result; it must not close away the pending
effect. Missing policy bindings or run/candidate metadata fail closed before
the handler is invoked.

In v0.1 the governance and Harness policy digests supplied to this gate are
synchronously snapshotted caller inputs. Their keyed commitment provides an
opaque correlation for the current process; it is not evidence that the
control plane authenticated the policy provenance. Control-plane provenance
binding remains a required integration boundary before governed release use.

Production Agent model calls use the session's durable provider/model binding.
The provider configuration is revalidated before every run and credentials are
resolved only for the individual request; API keys, authorization headers and
raw request bodies are not written to model audit events. Before the HTTP side
effect, the runtime fsyncs a protected request digest, route digest and pricing
snapshot. It then fsyncs a terminal fact with a conservative dispatch state,
bounded usage and fixed-point cost estimate before closing the step. Missing or
partial usage is retained as missing or partial, and an unavailable price is
retained as unpriced rather than being reported as zero. A crash after the start
fact is recovered as an unknown, interrupted outcome and is never replayed
automatically. These records are local audit facts; they are not provider-signed
billing evidence.

Agent model traffic and the local compatibility proxy share one bounded HTTP
dispatch boundary. It validates native Request/Response objects without
invoking caller accessors, snapshots a capped header view, races cancellation
and timeout even when fetch does not cooperate, and normalizes transport and
body-read failures without reflecting upstream exception text. The transport
does not persist headers or response bytes. The local proxy remains responsible
for client protocol conversion, enterprise accounting, and replay policy; the
Agent runtime never performs a post-dispatch automatic provider fallback.

The planned macOS sandbox combines Seatbelt with an isolated canonical Git
worktree. It is defense in depth, not a virtual machine or Docker-equivalent
security boundary. If the required sandbox probe fails, command execution must
return SANDBOX_UNAVAILABLE and must never run without the sandbox.

The local JSONL session store validates canonical containment and directory
identity before and after opening a session's files. Node.js does not expose a
portable `openat(2)` API, so a same-user process that can concurrently rename
store paths can still race the read-only header snapshot. Writer locks use a
UID-private `0700` namespace rooted at `/private/tmp` on macOS and `/tmp` on
Linux, independent of `TMPDIR`; lock files are regular, single-link, user-owned
`0600` files opened without following symlinks. Path leases are acquired by a
fixed, short-lived operating-system command on an inherited descriptor; the
owning process retains the same open-file-description until release. Active
event appends, tail repairs, and fsyncs run in a direct packaged Node.js child
that retains both the event descriptor and the inode-lock descriptor. It sends
the nonce-bound READY handshake only after the inherited descriptor is locked,
and the parent then closes both of its writable/lock descriptor copies. Thus an
inode lock cannot be released while an older helper remains able to write. The
parent accepts an operation only after its bounded request receives a matching
acknowledgement. A lost helper poisons the writer lease, so the old parent cannot
resume writing; reopen accepts a complete unacknowledged final record or repairs
a torn tail before verifying the digest chain. Consequently, the residual
metadata race cannot redirect an active event write, create a second writer for
the same event inode, or turn a path replacement into an out-of-workspace
append. This is a Developer Preview boundary, not protection against a
malicious process already running as the same operating-system user.

Signed and notarized desktop binaries are not published in v0.1.0. The desktop
updater remains disabled until a separately reviewed signed release channel
exists.

## Out of scope

Social engineering, denial of service requiring unreasonable traffic,
reports against unsupported snapshots, and issues that require a user to
deliberately disable documented safeguards may be closed without a security
advisory. This does not waive responsible review of credible impact.
