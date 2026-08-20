// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "@mn/governance";
import {
  ENTERPRISE_GATE_EVIDENCE_METADATA_KINDS,
  mergeEnterpriseGateEvidenceMetadata
} from "../src/enterpriseEvidenceMetadata.js";
import type { EnterpriseMetadataRecord } from "../src/enterprisePostgres.js";
import type { GateArtifactHandleRecord } from "../src/store.js";
import { MemoryStore } from "../src/store.js";

test("a second API replica imports PostgreSQL-authoritative Gate artifact handles", () => {
  const record: GateArtifactHandleRecord = {
    schemaVersion: 1,
    handle: "mn://cas/gate-artifacts/00000000-0000-4000-8000-000000000001",
    tenantId: "tenant-a",
    projectId: "project-a",
    runId: "run-a",
    candidateId: "candidate-a",
    gateResultId: "result-a",
    gateId: "unit_test",
    artifactId: "unit-log",
    kind: "log",
    contentType: "text/plain",
    digest: "1".repeat(64),
    byteLength: 5,
    cas: {
      schemaVersion: 1,
      objectKey: "tenant-a/project-a/run-a/1",
      digest: "1".repeat(64),
      byteLength: 5,
      contentType: "text/plain"
    },
    claimTokenHash: "2".repeat(64),
    ownerId: "worker-a",
    registeredAt: "2026-08-20T00:00:00.000Z"
  };
  const metadata = enterpriseMetadata(record);
  const secondReplica = new MemoryStore();

  mergeEnterpriseGateEvidenceMetadata(secondReplica, "tenant-a", [metadata]);

  assert.deepEqual(secondReplica.gateArtifactHandles.get(record.handle), record);
  assert.deepEqual(ENTERPRISE_GATE_EVIDENCE_METADATA_KINDS, [
    "gate_artifact_handle",
    "authoritative_gate_receipt"
  ]);
});

test("Gate evidence metadata merge fails closed on tenant and digest drift", () => {
  const payload = {
    schemaVersion: 1,
    handle: "mn://cas/gate-artifacts/00000000-0000-4000-8000-000000000001",
    tenantId: "tenant-a"
  } as unknown as GateArtifactHandleRecord;
  const metadata = enterpriseMetadata(payload);
  assert.throws(
    () => mergeEnterpriseGateEvidenceMetadata(new MemoryStore(), "tenant-b", [metadata]),
    /scope changed/u
  );
  assert.throws(
    () => mergeEnterpriseGateEvidenceMetadata(new MemoryStore(), "tenant-a", [{
      ...metadata,
      digest: "f".repeat(64)
    }]),
    /digest changed/u
  );
});

function enterpriseMetadata(
  payload: GateArtifactHandleRecord
): EnterpriseMetadataRecord {
  return {
    tenantId: payload.tenantId,
    kind: "gate_artifact_handle",
    id: payload.handle,
    version: 1,
    digest: sha256Canonical(payload),
    payload: payload as unknown as Readonly<Record<string, unknown>>,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z"
  };
}
