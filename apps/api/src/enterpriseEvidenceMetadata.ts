// SPDX-License-Identifier: Apache-2.0

import { sha256Canonical } from "@mn/governance";
import type { EnterpriseMetadataRecord } from "./enterprisePostgres.js";
import { isGateArtifactHandle } from "./gateArtifactCas.js";
import type {
  AuthoritativeGateReceiptRecord,
  GateArtifactHandleRecord,
  MemoryStore
} from "./store.js";

const EVIDENCE_KINDS = Object.freeze([
  "gate_artifact_handle",
  "authoritative_gate_receipt"
] as const);

export const ENTERPRISE_GATE_EVIDENCE_METADATA_KINDS: readonly string[] = EVIDENCE_KINDS;

/** Merge the PostgreSQL-authoritative Gate evidence projection into one API
 * replica without replacing unrelated in-flight cache state. This is required
 * before a load-balanced checkpoint consumes handles created by another API. */
export function mergeEnterpriseGateEvidenceMetadata(
  store: MemoryStore,
  tenantId: string,
  records: readonly EnterpriseMetadataRecord[]
): void {
  for (const record of records) {
    if (record.tenantId !== tenantId || !EVIDENCE_KINDS.includes(
      record.kind as (typeof EVIDENCE_KINDS)[number]
    )) {
      throw new Error("enterprise Gate evidence metadata scope changed");
    }
    if (sha256Canonical(record.payload) !== record.digest) {
      throw new Error(`enterprise Gate evidence metadata digest changed for ${record.id}`);
    }
    const payload = structuredClone(record.payload);
    if (record.kind === "gate_artifact_handle") {
      const candidate = payload as unknown as GateArtifactHandleRecord;
      assertGateArtifactHandleRecord(candidate, record);
      store.gateArtifactHandles.set(candidate.handle, Object.freeze(candidate));
      continue;
    }
    const candidate = payload as unknown as AuthoritativeGateReceiptRecord;
    assertAuthoritativeGateReceiptRecord(candidate, record);
    store.authoritativeGateReceipts.set(candidate.id, Object.freeze(candidate));
  }
}

function assertGateArtifactHandleRecord(
  value: GateArtifactHandleRecord,
  metadata: EnterpriseMetadataRecord
): void {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.handle !== metadata.id ||
    value.tenantId !== metadata.tenantId ||
    !isGateArtifactHandle(value.handle) ||
    !safeIdentity(value.projectId) ||
    !safeIdentity(value.runId) ||
    !safeIdentity(value.candidateId) ||
    !safeIdentity(value.gateResultId) ||
    !safeIdentity(value.gateId) ||
    !safeIdentity(value.artifactId) ||
    !safeIdentity(value.ownerId) ||
    !digest(value.digest) ||
    !digest(value.claimTokenHash) ||
    !value.cas ||
    value.cas.digest !== value.digest ||
    value.cas.byteLength !== value.byteLength
  ) {
    throw new Error(`enterprise Gate artifact metadata ${metadata.id} is invalid`);
  }
}

function assertAuthoritativeGateReceiptRecord(
  value: AuthoritativeGateReceiptRecord,
  metadata: EnterpriseMetadataRecord
): void {
  const receipt = value?.receipt;
  if (
    !value ||
    value.id !== metadata.id ||
    value.tenantId !== metadata.tenantId ||
    !safeIdentity(value.projectId) ||
    !safeIdentity(value.runId) ||
    !safeIdentity(value.stageAttemptId) ||
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.issuer !== "mn-api" ||
    receipt.tenantId !== value.tenantId ||
    receipt.projectId !== value.projectId ||
    receipt.runId !== value.runId ||
    receipt.stageAttemptId !== value.stageAttemptId ||
    !digest(receipt.digest) ||
    !digest(receipt.signature)
  ) {
    throw new Error(`enterprise authoritative Gate receipt ${metadata.id} is invalid`);
  }
}

function safeIdentity(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value === value.trim() && !/[\0\r\n]/u.test(value);
}

function digest(value: string): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
