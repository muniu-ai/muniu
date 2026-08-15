# ADR-0009: Conservative Microservice Impact Model

## Status

Accepted

## Context

Enterprise increments can change contracts, data ownership, state transitions, permissions, operational behavior, or release topology across independently deployed services. File-level diffs alone cannot determine the regression surface, and an incomplete service catalog creates false confidence. The analysis must remain deterministic across workstations, must not execute repository code, and must fail closed when ownership or target services are unknown.

## Decision

Use `.mn/project.yaml` as the authoritative service catalog when present and deterministic repository discovery as a fallback. The architecture index records repository-relative contract, migration, CI, dependency, data-resource, consistency, deployment, owner, and observability facts; absolute local paths are excluded from its semantic digest.

Classify Spec impact conservatively:

- L0: no semantic change in a dimension;
- L1: business-scope-only change without contract or acceptance impact;
- L2: bounded single-service implementation or quality change;
- L3: cross-service, permission, or compatibility-sensitive change requiring owner review;
- L4: unbounded/unknown service, breaking contract, shared data ownership, unsafe migration/release, or missing consistency boundary.

Architecture risks expand the affected service set through dependencies, shared resources, and declared consistency boundaries. Required Gates and approvals are derived from the resulting matrix rather than chosen by a client UI.

## Consequences

### Positive

- Contract, data, state, permission, regression, and release impact use one auditable model.
- Unknown ownership and incomplete service references cannot silently lower risk.
- Relative semantic digests make the same repository index reproducible on different machines.
- Platform teams can override heuristic discovery with enterprise-owned declarations.

### Negative

- Conservative dependency expansion can overestimate the regression surface.
- Teams must maintain data-resource, rollback, observability, and consistency declarations to reduce L4 findings.
- CODEOWNERS and package dependency discovery cannot replace domain ownership review.

### Neutral

- L0-L4 is an mn risk vocabulary, not a deployment approval by itself.
- The analysis produces Gate requirements; Gate runner implementation and enforcement remain separate capabilities.

## Alternatives Considered

**File-path-only impact analysis**

- Rejected because it cannot model API consumers, shared data, asynchronous topics, or deployment rollback.

**Always trust automatic discovery**

- Rejected because build files and naming conventions do not encode authoritative ownership or consistency decisions.

**Allow unknown services as warnings**

- Rejected because an unbounded service target makes a verified enterprise increment impossible.

## References

- [ADR-0006: Immutable Spec, Governance, and Harness](./0006-immutable-spec-governance-harness.md)
- [ADR-0008: Capability-registered Gates and sandboxes](./0008-capability-registered-gates-and-sandboxes.md)
