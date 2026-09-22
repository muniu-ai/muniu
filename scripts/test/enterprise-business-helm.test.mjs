// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const business = { enabled: true, salesEndpoint: "https://sales.example.test/api/v1/os-business",
  existingSecret: "industrial-credentials", salesTokenKey: "sales-token", authorityTokenKey: "authority-token",
  workspaceScopes: [{ tenantId: "tenant-a", workspaceId: "workspace-a" }] };
const kinds = ["system.noop", "agent.execution.run", "coding.reconciliation.verify", "coding.sandbox.cleanup",
  "business.action.execute", "business.candidate.extract"];
function render(values) {
  const dir = mkdtempSync(join(tmpdir(), "mn-business-helm-"));
  try {
    const path = join(dir, "values.json");
    writeFileSync(path, JSON.stringify(values));
    return spawnSync("helm", ["template", "muniu", "deploy/helm/muniu", "-f", "deploy/helm/muniu/values-ci.yaml", "-f", path], { encoding: "utf8" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("Helm mounts trusted scope configuration and separate credential files on Host and Worker", () => {
  const result = render({ business, worker: { supportedKinds: kinds } });
  assert.equal(result.status, 0, result.stderr);
  const docs = parseAllDocuments(result.stdout).map(doc => doc.toJSON());
  const config = docs.find(doc => doc.kind === "ConfigMap" && doc.metadata.name === "muniu");
  assert.equal(config.data.MUNIU_SALES_URL, business.salesEndpoint);
  for (const name of ["muniu-host", "muniu-worker"]) {
    const pod = docs.find(doc => doc.kind === "Deployment" && doc.metadata.name === name).spec.template.spec;
    const secret = pod.volumes.find(volume => volume.name === "business-credentials");
    assert.equal(secret.secret.secretName, "industrial-credentials");
    assert.deepEqual(secret.secret.items, [{ key: "sales-token", path: "sales-token" }, { key: "authority-token", path: "authority-token" }]);
    assert.equal(pod.containers[0].volumeMounts.find(mount => mount.name === "business-credentials").readOnly, true);
  }
  const scopes = docs.find(doc => doc.kind === "ConfigMap" && doc.metadata.name === "muniu-business-scopes");
  assert.deepEqual(JSON.parse(scopes.data["scopes.json"]), business.workspaceScopes);
});

test("Helm refuses incomplete industrial deployment declarations", () => {
  for (const override of [
    { business },
    { business: { ...business, salesEndpoint: "http://sales.example.test" }, worker: { supportedKinds: kinds } },
    { business: { ...business, existingSecret: "" }, worker: { supportedKinds: kinds } },
    { business: { ...business, workspaceScopes: [] }, worker: { supportedKinds: kinds } },
    { business: { ...business, workspaceScopes: [...business.workspaceScopes, { tenantId: "tenant-b", workspaceId: "workspace-a" }] }, worker: { supportedKinds: kinds } },
    { business, worker: { supportedKinds: kinds, fixtureMode: true } },
    { worker: { supportedKinds: kinds } },
  ]) {
    const result = render(override);
    assert.notEqual(result.status, 0, JSON.stringify(override));
    assert.match(result.stderr, /business\./u);
  }
});

test("disabled industrial integration adds no credentials or Sales endpoint", () => {
  const result = render({});
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /MUNIU_SALES_URL|business-credentials|business-scopes/u);
});

test("Worker liveness does not depend on the database and KMS readiness file", () => {
  const result = render({});
  assert.equal(result.status, 0, result.stderr);
  const docs = parseAllDocuments(result.stdout).map(doc => doc.toJSON());
  const worker = docs.find(doc => doc.kind === "Deployment" && doc.metadata.name === "muniu-worker").spec.template.spec.containers[0];
  assert.match(worker.livenessProbe.exec.command.join(" "), /mn-worker-live/u);
  assert.match(worker.readinessProbe.exec.command.join(" "), /mn-worker-ready/u);
  assert.doesNotMatch(worker.livenessProbe.exec.command.join(" "), /mn-worker-ready/u);
});
