# ADR-0010: Provider Usage Recovery and Conservative Reconciliation

## Status

Accepted

## Context

Enterprise provider accounting must authorize cost before an external request and must not under-count when a provider result is uncertain. A receipt authorizes a candidate session and can be reused for many provider calls, so neither the receipt digest nor a request body hash uniquely identifies one logical request. After dispatch, a database outage or process crash can leave a safe fail-closed reservation pending; without durable request evidence and a reconciliation path, that pending state becomes permanently unrecoverable.

Local replay is a separate concern: serving a stored response is observable delivery work, but it does not create new supplier usage or cost.

## Decision

Use an append-only provider request lifecycle:

1. Each inbound provider call receives a fresh stable logical request ID. Identical payloads remain distinct unless the caller supplies an explicit idempotency key.
2. Before provider side effects, PostgreSQL atomically persists the immutable request/provider-plan digests, conservative token/cost hold, outbound idempotency key, prepared state, first dispatch authorization, and recovery outbox evidence.
3. Every provider dispatch has a stable attempt ID and is durably marked before network execution. Terminal usage uses a stable log ID and idempotent append semantics.
4. Providers are considered strongly idempotent only when their enterprise configuration says so explicitly. Unknown non-idempotent results are never resent or cleared automatically.
5. A human `org_admin` may append an audited reconciliation after tenant/project/CAS checks. Exact reconciliation requires provider or invoice evidence. Otherwise the pre-authorized conservative hold is charged. Human assertions alone cannot settle an unknown request at zero.
6. Prepared requests with machine proof that no dispatch occurred may be append-only finalized at zero by recovery logic.
7. Local replay records a replay delivery and request count, but all supplier token and cost fields are zero. Governed budgets aggregate supplier usage and conservative charges only.

The current reservation and usage tables remain backward readable. Recovery metadata is additive, and a versioned append-only lifecycle event relation plus the existing outbox records prepared, dispatch, terminal, unknown, and reconciled facts. Legacy pending reservations are not silently migrated to settled.

## Consequences

### Positive

- Crash/restart/reclaim no longer requires deleting or timing out unknown cost.
- A conservative reconciliation can unblock a Run without understating enterprise spend.
- Same-content legitimate calls are not accidentally collapsed.
- Replay remains observable without double-charging provider usage.

### Negative

- Non-idempotent providers may require human evidence and conservative over-accounting.
- Provider request lifecycle and audit storage grow append-only.
- Strong automatic retry requires an explicit provider contract and recoverable request material.

## Rejected Alternatives

- Receipt digest or body hash as the request key: a receipt is session-scoped and identical payloads can be legitimate separate calls.
- TTL or claim-expiry cleanup: it can erase real supplier cost.
- Human no-charge assertions without evidence: they are not authoritative.
- Best-effort accounting after returning a provider response: it permits unmeasured external side effects.
- Treating any configured idempotency header as strong provider idempotency: a header name alone proves no semantics.

## References

- [ADR-0006: Immutable Spec, Governance, and Harness](./0006-immutable-spec-governance-harness.md)
- [ADR-0008: Capability-registered Gates and sandboxes](./0008-capability-registered-gates-and-sandboxes.md)
