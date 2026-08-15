import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Canonical } from "@mn/governance";
import { FileSpecRepository } from "@mn/specs";
import { restoreEnterpriseSnapshot } from "../src/enterpriseState.js";
import { MemoryStore, type GateArtifactHandleRecord } from "../src/store.js";

test("enterprise snapshot restores durable Gate artifact handle bindings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-enterprise-gate-handle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record: GateArtifactHandleRecord = {
    schemaVersion: 1,
    handle: "mn://cas/gate-artifacts/00000000-0000-4000-8000-000000000001",
    tenantId: "tenant-a",
    projectId: "project-a",
    runId: "run-a",
    candidateId: "candidate-a",
    gateResultId: "gate-result-a",
    gateId: "unit_test",
    artifactId: "unit-test-log",
    kind: "log",
    contentType: "text/plain",
    digest: "1".repeat(64),
    byteLength: 10,
    cas: {
      schemaVersion: 1,
      objectKey: `cas/v1/${"2".repeat(24)}/${"3".repeat(24)}/${"4".repeat(24)}/11/${"1".repeat(64)}`,
      digest: "1".repeat(64),
      byteLength: 10,
      contentType: "text/plain"
    },
    claimTokenHash: "5".repeat(64),
    ownerId: "worker-a",
    registeredAt: "2026-07-12T00:00:00.000Z"
  };
  const store = new MemoryStore();
  await restoreEnterpriseSnapshot({
    store,
    specRepository: new FileSpecRepository(join(root, "specs")),
    snapshot: {
      metadata: [{
        tenantId: record.tenantId,
        kind: "gate_artifact_handle",
        id: record.handle,
        version: 1,
        digest: sha256Canonical(record),
        payload: record as unknown as Readonly<Record<string, unknown>>,
        createdAt: record.registeredAt,
        updatedAt: record.registeredAt
      }],
      runJobs: [],
      auditEvents: []
    }
  });
  assert.deepEqual(store.gateArtifactHandles.get(record.handle), record);
});
