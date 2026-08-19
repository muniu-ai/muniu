# Muniu Helm Chart

This chart deploys production API replicas, a pre-install migration Job,
Service/Ingress, HPA, PDB, default-deny NetworkPolicies, and non-root,
read-only containers. PostgreSQL, S3, OIDC, OTLP and Vault/KMS are external
standard adapters configured through values and existing Secrets.

When `networkPolicy.enabled=true`, production values must provide narrowly
scoped `networkPolicy.apiEgress` rules for PostgreSQL, S3, OIDC/JWKS and OTLP.
Kubernetes NetworkPolicy cannot portably allow DNS names, so the chart does not
guess external CIDRs.

The Worker is disabled by default. In v0.1.0, `worker.enabled=true` is accepted
only together with `worker.fixtureMode=true`; this starts the mock acceptance
worker and must not be used for production execution. The chart deliberately
fails rendering if a production Worker is requested because the Kubernetes
candidate-Pod provisioner is not delivered yet.

Future candidate sandbox Pods must use the
`muniu.ai/component=candidate-sandbox` label, no `hostPath`, no service-account
token, and the chart's default-deny policy. The application service account
intentionally receives no Kubernetes RBAC permissions.
