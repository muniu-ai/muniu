// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");
const legacyControlPlane = /apps\/api|mn-api|["'`]\/v1(?:\/|["'`])/u;

test("enterprise compose runs two v2 Hosts and two 30-second-lease Workers", () => {
  const compose = read("docker-compose.enterprise.yml");
  for (const service of ["host-a:", "host-b:", "worker-a:", "worker-b:"]) {
    assert.match(compose, new RegExp(`\\n  ${service.replace(":", "")}:`));
  }
  assert.match(compose, /MN_POSTGRES_SCHEMA:\s*mn_v2/);
  assert.match(compose, /MN_S3_PREFIX:\s*v2\//);
  assert.match(compose, /MN_JOB_LEASE_MS:\s*["']?30000/);
  assert.match(compose, /MN_ENGINE_LOCK_DIGEST:/);
  assert.match(compose, /MN_PLUGIN_LOCK_DIGEST:/);
  assert.doesNotMatch(compose, legacyControlPlane);
});

test("Helm chart deploys matching Host and Worker replicas with fail-closed readiness", () => {
  const values = read("deploy/helm/muniu/values.yaml");
  const host = read("deploy/helm/muniu/templates/deployment-host.yaml");
  const worker = read("deploy/helm/muniu/templates/deployment-worker.yaml");
  const config = read("deploy/helm/muniu/templates/configmap.yaml");
  assert.match(values, /host:\n\s+replicas:\s+2/);
  assert.match(values, /worker:\n\s+enabled:\s+true\n\s+replicas:\s+2/);
  assert.match(values, /leaseMs:\s+30000/);
  assert.match(values, /prefix:\s+v2\//);
  assert.match(host, /scripts\/enterprise-host\.mjs/);
  assert.match(host, /path:\s+\/v2\/readiness/);
  assert.match(worker, /scripts\/enterprise-worker\.mjs/);
  assert.match(config, /MN_POSTGRES_SCHEMA:\s+mn_v2/);
  assert.match(config, /MN_TELEMETRY_ENABLED:\s+"false"/);
  assert.match(config, /MN_EXPECTED_ENGINE_LOCK_DIGEST/);
  assert.match(config, /MN_EXPECTED_PLUGIN_LOCK_DIGEST/);
  assert.doesNotMatch(`${values}\n${host}\n${worker}\n${config}`, legacyControlPlane);
});

test("container and sidecar entrypoints are v2-only", () => {
  const dockerfile = read("Dockerfile");
  const sidecar = read("scripts/build-host-sidecar.mjs");
  assert.match(dockerfile, /scripts\/enterprise-host\.mjs/);
  assert.match(sidecar, /apps\/host\/src\/main\.ts/);
  assert.match(sidecar, /mn-host-aarch64-apple-darwin/);
  assert.match(sidecar, /mn-host-x86_64-apple-darwin/);
  assert.doesNotMatch(`${dockerfile}\n${sidecar}`, /apps\/api|mn-api|descriptor-lock|["'`]\/v1(?:\/|["'`])/u);
  assert.equal(existsSync(join(root, "scripts/build-descriptor-lock-helper.mjs")), false);
});

test("enterprise verification targets committed-event recovery and stale fencing", () => {
  const fixture = read("scripts/enterprise-e2e.mjs");
  const kind = read("scripts/kind-enterprise-failover.mjs");
  for (const source of [fixture, kind]) {
    assert.match(source, /mn_v2/);
    assert.match(source, /30000/);
    assert.match(source, /fencing/i);
    assert.match(source, /RPO\s*0/i);
    assert.doesNotMatch(source, legacyControlPlane);
  }
});

test("Kind keeps candidate evidence separate from the authoritative Coding Gate", () => {
  const probe = read("scripts/kind-sandbox-probe.mjs");
  const gate = read("scripts/kind-authoritative-gate.mjs");
  const verifier = read("scripts/verify-kind-sandbox.sh");
  assert.match(probe, /issuer:\s*"candidate-runtime"/u);
  assert.doesNotMatch(probe, /authoritativeGate|coding-control-plane/u);
  assert.match(gate, /CodingExecutionEngine/u);
  assert.match(gate, /authoritative:\s*true/u);
  assert.match(gate, /issuer:\s*"coding-control-plane"/u);
  assert.match(verifier, /--read-only --network none/u);
  assert.match(verifier, /kind-authoritative-gate\.mjs/u);
});

test("PostgreSQL Host transaction commits Job and outbox with the event", () => {
  const adapter = read("scripts/lib/postgres-kernel-store.mjs");
  assert.match(adapter, /putJob:\s*\(job\)/u);
  assert.match(adapter, /putOutbox:\s*\(message\)/u);
  assert.match(adapter, /insert into mn_v2\.jobs/u);
  assert.match(adapter, /insert into mn_v2\.outbox/u);
  assert.match(adapter, /begin isolation level serializable/u);
  assert.match(adapter, /commit/u);
});

test("unknown external effects become a durable event, inbox item, and non-replayable Job", () => {
  const worker = read("scripts/enterprise-worker.mjs");
  assert.match(worker, /execution\.needs_reconciliation/u);
  assert.match(worker, /UNKNOWN_EXTERNAL_SIDE_EFFECT/u);
  assert.match(worker, /insert into mn_v2\.events/u);
  assert.match(worker, /insert into mn_v2\.reconciliations/u);
  assert.match(worker, /insert into mn_v2\.outbox/u);
  assert.match(worker, /'inbox'/u);
  assert.match(worker, /status = 'failed'/u);
});

test("enterprise Worker refuses an unconfigured agent execution bootstrap", () => {
  const worker = read("scripts/enterprise-worker.mjs");
  const builtin = read("scripts/enterprise-worker-handlers.mjs");
  assert.match(worker, /createHandlers/u);
  assert.match(worker, /AGENT_EXECUTION_BOOTSTRAP_MISSING/u);
  assert.match(worker, /handlers\["agent\.execution\.run"\]/u);
  assert.match(builtin, /configured:\s*false/u);
  assert.doesNotMatch(builtin, /"agent\.execution\.run"\s*:/u);
});
