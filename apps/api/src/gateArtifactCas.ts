import { randomUUID } from "node:crypto";
import type { GateArtifactV2, GateResultV2, RunRecord } from "@mn/core";
import type { GateArtifactHandleRecord, MemoryStore } from "./store.js";
import {
  RunScopedCas,
  RunScopedCasIntegrityError,
  type RunScopedCasObjectRef
} from "./runScopedCas.js";

const HANDLE_PREFIX = "mn://cas/gate-artifacts/";

export interface GateArtifactRegistrationInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly gateResultId: string;
  readonly gateId: string;
  readonly artifact: Omit<GateArtifactV2, "handle" | "path">;
  readonly cas: RunScopedCasObjectRef;
  readonly claimTokenHash: string;
  readonly ownerId: string;
  readonly registeredAt: string;
}

export function createGateArtifactHandleRecord(
  input: GateArtifactRegistrationInput
): GateArtifactHandleRecord {
  if (
    input.cas.digest !== input.artifact.digest ||
    input.cas.byteLength !== input.artifact.byteLength ||
    input.cas.contentType !== input.artifact.contentType
  ) {
    throw new TypeError("Gate artifact declaration does not match API-managed CAS bytes");
  }
  return Object.freeze({
    schemaVersion: 1,
    handle: `${HANDLE_PREFIX}${randomUUID()}`,
    tenantId: input.tenantId,
    projectId: input.projectId,
    runId: input.runId,
    candidateId: input.candidateId,
    gateResultId: input.gateResultId,
    gateId: input.gateId,
    artifactId: input.artifact.id,
    kind: input.artifact.kind,
    contentType: input.artifact.contentType,
    digest: input.artifact.digest,
    byteLength: input.artifact.byteLength,
    cas: input.cas,
    claimTokenHash: input.claimTokenHash,
    ownerId: input.ownerId,
    registeredAt: input.registeredAt
  });
}

export function gateArtifactFromRecord(
  record: GateArtifactHandleRecord
): GateArtifactV2 {
  return Object.freeze({
    id: record.artifactId,
    kind: record.kind,
    contentType: record.contentType,
    digest: record.digest,
    byteLength: record.byteLength,
    handle: record.handle
  });
}

export async function validateEnterpriseGateArtifactHandles(input: {
  readonly existing: RunRecord | undefined;
  readonly incoming: RunRecord;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly claimTokenHash: string | undefined;
  readonly store: MemoryStore;
  readonly cas: RunScopedCas;
}): Promise<string | undefined> {
  if (!input.claimTokenHash || !/^[a-f0-9]{64}$/u.test(input.claimTokenHash)) {
    return "active enterprise claim is missing its immutable token digest";
  }
  const historical = existingArtifactBindings(input.existing);
  const seen = new Set<string>();
  for (const gate of input.incoming.gateResultsV2 ?? []) {
    for (const artifact of gate.artifacts) {
      if (!artifact.handle || !isGateArtifactHandle(artifact.handle)) {
        return `Gate artifact ${gate.id}/${artifact.id} must reference an API-managed CAS handle`;
      }
      if (artifact.path !== undefined) {
        return `Gate artifact ${gate.id}/${artifact.id} cannot reference a worker filesystem path`;
      }
      if (seen.has(artifact.handle)) {
        return `Gate artifact handle ${artifact.handle} is referenced more than once`;
      }
      seen.add(artifact.handle);
      const record = input.store.gateArtifactHandles.get(artifact.handle);
      const bindingError = recordBindingError({
        record,
        tenantId: input.tenantId,
        projectId: input.incoming.projectId,
        runId: input.incoming.id,
        gate,
        artifact
      });
      if (bindingError) return bindingError;
      const binding = artifactBinding(gate, artifact);
      if (
        historical.get(artifact.handle) !== binding &&
        (record!.claimTokenHash !== input.claimTokenHash ||
          record!.ownerId !== input.ownerId)
      ) {
        return `Gate artifact ${artifact.handle} was not registered by the active claim`;
      }
      const byteError = await verifyRecordBytes(record!, input.cas);
      if (byteError) return byteError;
    }
  }
  return undefined;
}

export async function resolveVerifiedGateArtifact(input: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly gate: GateResultV2;
  readonly artifact: GateArtifactV2;
  readonly store: MemoryStore;
  readonly cas: RunScopedCas;
}): Promise<{ readonly record: GateArtifactHandleRecord; readonly content: Buffer } | undefined> {
  const handle = input.artifact.handle;
  if (!handle || !isGateArtifactHandle(handle)) return undefined;
  const record = input.store.gateArtifactHandles.get(handle);
  if (recordBindingError({ ...input, record })) return undefined;
  try {
    const content = await input.cas.readVerified(record!.cas);
    return content ? { record: record!, content } : undefined;
  } catch (error) {
    if (error instanceof RunScopedCasIntegrityError || error instanceof TypeError) {
      return undefined;
    }
    throw error;
  }
}

export function findIdempotentGateArtifactRecord(input: {
  readonly registration: Omit<GateArtifactRegistrationInput, "cas" | "registeredAt">;
  readonly cas: RunScopedCasObjectRef;
  readonly store: MemoryStore;
}): GateArtifactHandleRecord | undefined {
  return [...input.store.gateArtifactHandles.values()].find((record) =>
    record.tenantId === input.registration.tenantId &&
    record.projectId === input.registration.projectId &&
    record.runId === input.registration.runId &&
    record.candidateId === input.registration.candidateId &&
    record.gateResultId === input.registration.gateResultId &&
    record.gateId === input.registration.gateId &&
    record.artifactId === input.registration.artifact.id &&
    record.kind === input.registration.artifact.kind &&
    record.contentType === input.registration.artifact.contentType &&
    record.digest === input.registration.artifact.digest &&
    record.byteLength === input.registration.artifact.byteLength &&
    record.claimTokenHash === input.registration.claimTokenHash &&
    record.ownerId === input.registration.ownerId &&
    record.cas.objectKey === input.cas.objectKey &&
    record.cas.digest === input.cas.digest &&
    record.cas.byteLength === input.cas.byteLength
  );
}

export function isGateArtifactHandle(value: string): boolean {
  return /^mn:\/\/cas\/gate-artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value
  );
}

function existingArtifactBindings(run: RunRecord | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const gate of run?.gateResultsV2 ?? []) {
    for (const artifact of gate.artifacts) {
      if (artifact.handle) result.set(artifact.handle, artifactBinding(gate, artifact));
    }
  }
  return result;
}

function artifactBinding(gate: GateResultV2, artifact: GateArtifactV2): string {
  return JSON.stringify([
    gate.runId,
    gate.candidateId,
    gate.id,
    gate.gateId,
    artifact.id,
    artifact.kind,
    artifact.contentType,
    artifact.digest,
    artifact.byteLength
  ]);
}

function recordBindingError(input: {
  readonly record: GateArtifactHandleRecord | undefined;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly gate: GateResultV2;
  readonly artifact: GateArtifactV2;
}): string | undefined {
  const { record, gate, artifact } = input;
  if (!record) return `Gate artifact handle ${artifact.handle ?? "<missing>"} is not registered`;
  if (
    record.schemaVersion !== 1 ||
    record.handle !== artifact.handle ||
    record.tenantId !== input.tenantId ||
    record.projectId !== input.projectId ||
    record.runId !== input.runId ||
    record.runId !== gate.runId ||
    record.candidateId !== gate.candidateId ||
    record.gateResultId !== gate.id ||
    record.gateId !== gate.gateId ||
    record.artifactId !== artifact.id ||
    record.kind !== artifact.kind ||
    record.contentType !== artifact.contentType ||
    record.digest !== artifact.digest ||
    record.byteLength !== artifact.byteLength ||
    record.cas.digest !== artifact.digest ||
    record.cas.byteLength !== artifact.byteLength ||
    record.cas.contentType !== artifact.contentType
  ) {
    return `Gate artifact handle ${record.handle} does not match its tenant/run/result metadata`;
  }
  return undefined;
}

async function verifyRecordBytes(
  record: GateArtifactHandleRecord,
  cas: RunScopedCas
): Promise<string | undefined> {
  try {
    const content = await cas.readVerified(record.cas);
    return content
      ? undefined
      : `Gate artifact CAS object for ${record.handle} is missing`;
  } catch (error) {
    if (error instanceof RunScopedCasIntegrityError || error instanceof TypeError) {
      return `Gate artifact CAS object for ${record.handle} failed byte verification: ${error.message}`;
    }
    throw error;
  }
}
