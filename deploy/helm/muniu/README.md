# Muniu Helm Chart

This chart deploys production API replicas, a pre-install migration Job,
Service/Ingress, HPA, PDB, default-deny NetworkPolicies, and non-root,
read-only containers. PostgreSQL, S3, OIDC, OTLP and Vault/KMS are external
standard adapters configured through values and existing Secrets.

This chart deliberately supports only `sandbox.driver=kubernetes`. Running a
Docker daemon through an in-cluster `hostPath` would break the isolation model,
so such values fail during rendering.

When `networkPolicy.enabled=true`, production values must provide narrowly
scoped `networkPolicy.apiEgress` rules for PostgreSQL, S3, OIDC/JWKS and OTLP,
plus the Kubernetes API ClusterIP in `networkPolicy.kubernetesApiEgress`.
Kubernetes NetworkPolicy cannot portably allow DNS names, so the chart does not
guess external CIDRs.

The Worker is disabled by default. With `worker.enabled=true`, each claim is
executed in an independent candidate Pod from an S3-backed content-addressed
source snapshot. `worker.fixtureMode=true` selects the deterministic acceptance
executor. Non-fixture mode requires compatible CLI binaries already present in
the candidate image and does not receive hosted-provider network access.

Candidate and API authority Pods use the
`muniu.ai/component=candidate-sandbox` label, no `hostPath`, no service-account
token, and the chart's default-deny policy. Worker RBAC can create/read/delete
candidate Pods and exec into them. API RBAC independently verifies candidate
Pods and creates a second immutable Gate Pod. The candidate ServiceAccount has
no RBAC at all.

`sandbox.runtimeClassName` is required. The selected RuntimeClass is the
administrator-controlled trust anchor for seccomp and runtime-specific PID
enforcement. The chart never silently falls back to the cluster default.

Run `npm run verify:helm` for static rendering checks. `npm run verify:kind`
uses an ephemeral Kind + Calico cluster to execute the real Pod backend and
verify token absence, network denial, source integrity and cleanup.
