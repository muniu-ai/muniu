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
- Arbitrary executable plugins, executable YAML/JS configuration, eval, and
  new Function are outside the v0.1 threat model and are disabled.
- Side-effecting tools require centralized policy and approval checks.

AgentHost cancellation is cooperative. Disposal refuses new runs, aborts every
active run, and retains model adapters, tools, and session writers until those
runs settle. An adapter or tool that does not observe its supplied AbortSignal
can therefore delay disposal indefinitely; v0.1 does not forcibly terminate
in-process third-party code.

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
`0600` files opened without following symlinks. Active event appends, tail
repairs, and fsyncs run in the packaged Node.js helper that simultaneously holds
the event inode advisory lock. The parent closes its writable event descriptor
after the nonce-bound READY handshake and accepts an operation only after its
bounded request receives a matching acknowledgement. A lost helper poisons the
writer lease, so the old parent cannot resume writing; reopen accepts a complete
unacknowledged final record or repairs a torn tail before verifying the digest
chain. Consequently, the residual metadata race cannot redirect an active event
write, create a second writer for the same event inode, or turn a path
replacement into an out-of-workspace append. This is a Developer Preview
boundary, not protection against a malicious process already running as the
same operating-system user.

Signed and notarized desktop binaries are not published in v0.1.0. The desktop
updater remains disabled until a separately reviewed signed release channel
exists.

## Out of scope

Social engineering, denial of service requiring unreasonable traffic,
reports against unsupported snapshots, and issues that require a user to
deliberately disable documented safeguards may be closed without a security
advisory. This does not waive responsible review of credible impact.
