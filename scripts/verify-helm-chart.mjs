#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

const chart = "deploy/helm/muniu";
const ciValues = `${chart}/values-ci.yaml`;
const kindValues = `${chart}/values-kind.yaml`;

function helm(args, success = true) {
  const result = spawnSync("helm", args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
  if (success !== (result.status === 0)) {
    throw new Error(`helm ${args.join(" ")} ${success ? "失败" : "意外成功"}\n${output}`);
  }
  return output;
}

helm(["lint", chart, "--values", ciValues]);
const rendered = helm(["template", "muniu", chart, "--values", ciValues]);
for (const required of [
  "name: muniu-host",
  "name: muniu-worker",
  "replicas: 2",
  "scripts/enterprise-host.mjs",
  "scripts/enterprise-worker.mjs",
  "scripts/migrate-v2.mjs",
  "path: /v2/readiness",
  "path: /v2/health",
  "MN_POSTGRES_SCHEMA: mn_v2",
  "MN_JOB_LEASE_MS: \"30000\"",
  "MN_S3_PREFIX: \"v2/\"",
  "MN_EXPECTED_ENGINE_LOCK_DIGEST",
  "MN_EXPECTED_PLUGIN_LOCK_DIGEST",
  "MN_TELEMETRY_ENABLED: \"false\"",
  "app.kubernetes.io/component: host",
  "name: muniu-worker-sandbox-controller",
  "name: muniu-sandbox-default-deny",
]) {
  if (!rendered.includes(required)) throw new Error(`Helm 输出缺少：${required}`);
}
for (const forbidden of ["apps/api", "mn-api", "app.kubernetes.io/component: api"]) {
  if (rendered.includes(forbidden)) throw new Error(`Helm 输出仍包含旧控制面：${forbidden}`);
}
if ((rendered.match(/strategy:\s*(?:\n\s+type:\s*Recreate|\{\s*type:\s*Recreate\s*\})/gu) ?? []).length < 2) {
  throw new Error("Host 和 Worker 必须拒绝混合版本滚动升级");
}
if (/\bhostPath\s*:/u.test(rendered)) throw new Error("生产 chart 不得挂载 hostPath");

for (const [setting, expected] of [
  ["postgres.schema=public", "postgres.schema must be mn_v2"],
  ["s3.prefix=legacy/", "s3.prefix must remain under v2/"],
  ["worker.leaseMs=29999", "worker.leaseMs must be 30000"],
  ["telemetry.enabled=true", "telemetry must remain disabled"],
  ["retention.auditDays=0", "all retention policies must be configured"],
  ["runtimeLocks.engineDigest=latest", "runtimeLocks.engineDigest must be a SHA-256 digest"],
]) {
  const output = helm(["template", "muniu", chart, "--values", ciValues, "--set", setting], false);
  if (!output.includes(expected)) throw new Error(`${setting} 未按预期 fail closed`);
}

const kind = helm(["template", "muniu", chart, "--namespace", "muniu-kind", "--values", kindValues]);
for (const required of [
  "secretKeyRef: { name: muniu-postgres-v2, key: url }",
  "name: muniu-event-integrity-v2",
  "http://muniu-kind-minio:9000",
  "http://muniu-kind-fixture:8080/jwks.json",
  "MN_S3_PREFIX: \"v2/kind-failover/\"",
  "claimName: muniu-kind-sandboxes",
  "cidr: 172.18.0.2/32",
  "port: 6443",
]) {
  if (!kind.includes(required)) throw new Error(`Kind values 缺少：${required}`);
}

process.stdout.write("Helm v2 部署契约通过\n");
