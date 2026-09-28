// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { CORE_PROJECTION_NAMESPACES, PROTECTED_CORE_PROJECTION_NAMESPACES, verifyEventIntegrity, type JsonObject, type JsonValue, type KernelEventV1 } from "@mn/contracts";
import type { ContentAddressedStorage } from "./cas.js";
import { EnvelopeCipher, type EncryptedEnvelopeV1, type KeyProvider } from "./encryption.js";
import { canonicalJson } from "./integrity.js";
import type { KernelIdempotencyRecordLike, KernelTransactionLike } from "./types.js";
import { StaleFencingTokenError } from "./types.js";

export interface ProjectionJournalOptions {
  readonly cas: ContentAddressedStorage;
  readonly keyProvider: KeyProvider;
  /** Exact namespaces, prefixes ending in a dot, or Host's *non-core policy. */
  readonly namespaces: readonly string[];
  readonly ioTimeoutMs?: number;
}

export interface ProjectionJournalFact {
  readonly namespace: string;
  readonly id: string;
  readonly value: JsonValue | null;
}

export interface ProjectionJournalEntry {
  readonly namespace: string;
  readonly id: string;
  readonly value: unknown;
}

export interface ProtectedProjectionReference {
  readonly format: "muniu.projection.reference";
  readonly protectedPayloadRef: string;
  readonly streamVersion: number;
}

export class ProtectedCoreStateUpgradeRequiredError extends Error {
  readonly code = "PROTECTED_CORE_STATE_UPGRADE_REQUIRED";
  readonly remediation = "保留现有数据目录、备份与密钥；完成经审核的当前版本数据升级后重试";
  constructor() {
    super("现有核心事实包含未加密内容，当前保护策略已阻止启动或重建；原数据未修改");
    this.name = "ProtectedCoreStateUpgradeRequiredError";
  }
}

export function assertProtectedCoreProjectionState(options: ProjectionJournalOptions,
  entries: readonly ProjectionJournalEntry[]): void {
  for (const entry of entries) {
    if (!(PROTECTED_CORE_PROJECTION_NAMESPACES as readonly string[]).includes(entry.namespace)
      || !isJournalNamespace(entry.namespace, options)) continue;
    const value = entry.value as Partial<ProtectedProjectionReference> | null;
    if (value?.format !== "muniu.projection.reference" || typeof value.protectedPayloadRef !== "string") {
      throw new ProtectedCoreStateUpgradeRequiredError();
    }
  }
}

export class IdempotencyProtectionEvidenceRequiredError extends Error {
  readonly code = "IDEMPOTENCY_PROTECTION_EVIDENCE_REQUIRED";
  readonly remediation = "保留原库、备份和幂等记录；仅凭已认证的加密回执事实离线重建，缺少事实时先核对原操作";
  constructor() {
    super("幂等回执缺少可验证的受保护状态，已阻止启动、升级或重建");
    this.name = "IdempotencyProtectionEvidenceRequiredError";
  }
}

function protectsCoreRecords(options: ProjectionJournalOptions): boolean {
  return PROTECTED_CORE_PROJECTION_NAMESPACES.some(namespace => isJournalNamespace(namespace, options));
}

export function assertProtectedIdempotencyState(options: ProjectionJournalOptions,
  records: readonly Pick<KernelIdempotencyRecordLike, "response">[]): void {
  if (!protectsCoreRecords(options)) return;
  for (const record of records) {
    const reference = record.response as Partial<ProtectedProjectionReference> | null;
    if (reference?.format !== "muniu.projection.reference" || typeof reference.protectedPayloadRef !== "string") {
      throw new IdempotencyProtectionEvidenceRequiredError();
    }
  }
}

/** A cache is never evidence for accepting or discarding an idempotency commitment. */
export function assertIdempotencyReplayCoverage(options: ProjectionJournalOptions,
  records: readonly KernelIdempotencyRecordLike[], receipts: readonly KernelIdempotencyRecordLike[]): void {
  if (!protectsCoreRecords(options)) return;
  const proven = new Set(receipts.map(receipt => JSON.stringify([receipt.tenantId, receipt.scope, receipt.key])));
  for (const record of records) if (!proven.has(JSON.stringify([record.tenantId, record.scope, record.key]))) {
    throw new IdempotencyProtectionEvidenceRequiredError();
  }
}

export function protectedIdempotencyReceipts(tenantId: string, events: readonly KernelEventV1[],
  authenticatedFacts: readonly ProjectionJournalFact[]): readonly KernelIdempotencyRecordLike[] {
  const references = new Map<string, string>();
  for (const event of events) if (event.type === "projection.fact_committed"
    && event.publicPayload.namespace === "kernel.protected-idempotency" && event.protectedPayloadRef) {
    references.set(String(event.publicPayload.resourceId), event.protectedPayloadRef);
  }
  return authenticatedFacts.filter(fact => fact.namespace === "kernel.protected-idempotency" && fact.value !== null).map(fact => {
    const receipt = fact.value as unknown as KernelIdempotencyRecordLike;
    const protectedPayloadRef = references.get(fact.id);
    if (receipt.tenantId !== tenantId || typeof receipt.scope !== "string" || typeof receipt.key !== "string"
      || fact.id !== factKey(receipt.scope, receipt.key) || typeof receipt.requestDigest !== "string"
      || typeof receipt.createdAt !== "string" || !protectedPayloadRef) throw new Error("Invalid idempotency replay fact");
    return { ...receipt, response: { format: "muniu.projection.reference", protectedPayloadRef, streamVersion: 0 } };
  });
}

export const DEFAULT_PROJECTION_JOURNAL_NAMESPACES = Object.freeze([
  "*non-core", ...PROTECTED_CORE_PROJECTION_NAMESPACES,
]);

/** Remove only facts whose complete values are owned by the protected journal. */
export function publicProjectionPayload(payload: JsonObject, options: ProjectionJournalOptions): JsonObject {
  const facts = payload.projectionFacts;
  if (facts === undefined) return payload;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)
    || (facts as JsonObject).version !== 1 || !Array.isArray((facts as JsonObject).changes)) throw new Error("Invalid projection facts");
  return { ...payload, projectionFacts: { version: 1, changes: ((facts as JsonObject).changes as JsonValue[]).filter(fact => {
    if (!fact || typeof fact !== "object" || Array.isArray(fact) || typeof (fact as JsonObject).namespace !== "string") {
      throw new Error("Invalid projection fact");
    }
    return !isJournalNamespace(String((fact as JsonObject).namespace), options);
  }) } };
}

export async function prepareProtectedProjection(options: ProjectionJournalOptions, tenantId: string,
  change: ProjectionJournalFact): Promise<{ readonly reference: ProtectedProjectionReference }> {
  const payload: JsonObject = { version: 1, tenantId, namespace: change.namespace, id: change.id, value: change.value };
  const plaintext = Buffer.from(canonicalJson(payload));
  let envelope: EncryptedEnvelopeV1;
  try {
    envelope = await boundedIo(new EnvelopeCipher(options.keyProvider).encrypt(plaintext, {
      tenantId, purpose: `projection:${factKey(change.namespace, change.id)}`,
    }), options);
  } finally { plaintext.fill(0); }
  const bytes = Buffer.from(canonicalJson(envelope as unknown as JsonObject));
  const object = await boundedIo(options.cas.put(bytes), options);
  if (object.digest !== sha256(bytes) || object.byteLength !== bytes.byteLength) {
    throw new Error("Projection journal CAS descriptor mismatch");
  }
  return { reference: {
    format: "muniu.projection.reference", protectedPayloadRef: object.digest,
    streamVersion: change.value !== null && typeof change.value === "object" && !Array.isArray(change.value)
      && typeof (change.value as JsonObject).streamVersion === "number" ? Number((change.value as JsonObject).streamVersion) : 0,
  } };
}

export function isJournalNamespace(namespace: string, options: ProjectionJournalOptions): boolean {
  return namespace === "kernel.protected-idempotency" || namespace === "kernel.key-revocation"
    || options.namespaces.some(value => value === "*non-core"
      ? !(CORE_PROJECTION_NAMESPACES as readonly string[]).includes(namespace)
      : value.endsWith(".") ? namespace.startsWith(value) : namespace === value);
}
const selected = isJournalNamespace;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const factKey = (namespace: string, id: string) => JSON.stringify([namespace, id]);

async function boundedIo<T>(work: Promise<T>, options: ProjectionJournalOptions): Promise<T> {
  const timeoutMs = options.ioTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("Invalid journal IO timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Projection journal IO timed out")), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** The ciphertext object is durable before the enclosing database transaction commits. */
export function captureProjectionJournal(transaction: KernelTransactionLike, tenantId: string, options: ProjectionJournalOptions,
  entries: readonly ProjectionJournalEntry[] = [], idempotencyEntries: readonly KernelIdempotencyRecordLike[] = []) {
  const changes = new Map<string, ProjectionJournalFact>();
  const readable = new Map<string, ProjectionJournalFact>();
  const idempotency = new Map<string, KernelIdempotencyRecordLike>();
  const pendingIdempotency = new Map<string, KernelIdempotencyRecordLike>();
  const unreadable = new Map<string, { namespace: string; error: unknown }>();
  const unreadableIdempotency = new Map<string, unknown>();
  const leases = new Map<string, string>();
  const revocations = new Map<string, JsonObject>();
  let cause: KernelEventV1 | undefined;
  const wrapped: KernelTransactionLike = {
    ...transaction,
    ...(transaction.assertJobLease ? {
      assertJobLease(input: { jobId: string; workerId: string; fencingToken: number; occurredAt: string }) {
        transaction.assertJobLease!(input);
        const job = transaction.getProjection<{ leaseExpiresAt?: string }>("job", input.jobId);
        if (!job?.leaseExpiresAt) throw new StaleFencingTokenError(input.jobId);
        leases.set(input.jobId, job.leaseExpiresAt);
      },
    } : {}),
    getIdempotency(scope, key) {
      if (unreadableIdempotency.has(factKey(scope, key))) throw unreadableIdempotency.get(factKey(scope, key));
      return pendingIdempotency.get(factKey(scope, key)) ?? idempotency.get(factKey(scope, key)) ?? transaction.getIdempotency(scope, key);
    },
    putIdempotency(record) {
      if (record.tenantId !== tenantId) throw new Error("Idempotency cannot cross tenants");
      pendingIdempotency.set(factKey(record.scope, record.key), structuredClone(record));
    },
    getProjection<T>(namespace: string, id: string): T | undefined {
      if (!selected(namespace, options)) return transaction.getProjection<T>(namespace, id);
      if (unreadable.has(factKey(namespace, id))) throw unreadable.get(factKey(namespace, id))!.error;
      const value = readable.get(factKey(namespace, id))?.value;
      return value === undefined || value === null ? undefined : structuredClone(value) as T;
    },
    listProjections<T>(namespace: string): readonly T[] {
      if (!selected(namespace, options)) return transaction.listProjections<T>(namespace);
      for (const failure of unreadable.values()) if (failure.namespace === namespace) throw failure.error;
      return [...readable.values()].filter(fact => fact.namespace === namespace && fact.value !== null)
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(fact => structuredClone(fact.value) as T);
    },
    appendEvent(request) {
      const event = transaction.appendEvent({ ...request, publicPayload: publicProjectionPayload(request.publicPayload, options) });
      cause = event;
      return event;
    },
    putProjection(namespace, id, value) {
      if (!selected(namespace, options)) { transaction.putProjection(namespace, id, value); return; }
      const fact = { namespace, id, value: JSON.parse(JSON.stringify(value)) as JsonValue };
      changes.set(factKey(namespace, id), fact);
      readable.set(factKey(namespace, id), fact);
    },
    deleteProjection(namespace, id) {
      if (namespace === "protectedPayloadKey") {
        const record = wrapped.getProjection<JsonObject>(namespace, id);
        if (record) {
          if (typeof record.wrappedKey !== "object" || record.wrappedKey === null || Array.isArray(record.wrappedKey)) {
            throw new Error("Protected payload has no revocable wrapping-key descriptor");
          }
          revocations.set(id, { id, tenantId, workspaceId: record.workspaceId ?? "", wrappedKey: record.wrappedKey,
            status: "pending", streamVersion: 1 });
        }
      }
      if (!selected(namespace, options)) { transaction.deleteProjection(namespace, id); return; }
      const fact = { namespace, id, value: null };
      changes.set(factKey(namespace, id), fact);
      readable.delete(factKey(namespace, id));
    },
  };
  return {
    transaction: wrapped,
    async prepare(): Promise<void> {
      const selectedEntries = entries.filter(entry => selected(entry.namespace, options));
      for (const entry of idempotencyEntries) {
        try { assertProtectedIdempotencyState(options, [entry]); }
        catch (error) { unreadableIdempotency.set(factKey(entry.scope, entry.key), error); }
      }
      const protectedReceipts = idempotencyEntries.filter(entry =>
        (entry.response as ProtectedProjectionReference | null)?.format === "muniu.projection.reference");
      try {
        const results = await boundedIo(Promise.all([
          ...selectedEntries.map(async entry => {
            try {
              const value = await readJournalProjection(options, tenantId, entry.namespace, entry.id, entry.value);
              return { namespace: entry.namespace, id: entry.id, value: value as JsonValue };
            } catch (error) { return { namespace: entry.namespace, id: entry.id, error }; }
          }),
          ...protectedReceipts.map(async entry => {
            const id = factKey(entry.scope, entry.key);
            try {
              const value = await readJournalProjection(options, tenantId, "kernel.protected-idempotency", id, entry.response) as unknown as KernelIdempotencyRecordLike;
              if (value.tenantId !== tenantId || value.scope !== entry.scope || value.key !== entry.key
                || value.requestDigest !== entry.requestDigest) throw new Error("Protected idempotency identity mismatch");
              return { namespace: "kernel.protected-idempotency", id, value: value as unknown as JsonValue };
            } catch (error) { return { namespace: "kernel.protected-idempotency", id, error }; }
          }),
        ]), options);
        for (const result of results) {
          if (result.namespace === "kernel.protected-idempotency") {
            if ("error" in result) unreadableIdempotency.set(result.id, result.error);
            else idempotency.set(result.id, result.value as unknown as KernelIdempotencyRecordLike);
          } else if ("error" in result) unreadable.set(factKey(result.namespace, result.id), { namespace: result.namespace, error: result.error });
          else readable.set(factKey(result.namespace, result.id), result);
        }
      } catch (error) {
        // Product storage failure is reported only when that product is read; core metadata remains usable.
        for (const entry of selectedEntries) unreadable.set(factKey(entry.namespace, entry.id), { namespace: entry.namespace, error });
        for (const entry of protectedReceipts) unreadableIdempotency.set(factKey(entry.scope, entry.key), error);
      }
    },
    async flush(now: () => string = () => new Date().toISOString()): Promise<void> {
      if (revocations.size && !cause) throw new Error("Payload key revocation requires an originating event");
      for (const [id, record] of revocations) {
        const value = { ...record, actorId: cause!.actorId, requestedAt: cause!.occurredAt, sourceEventId: cause!.id };
        changes.set(factKey("kernel.key-revocation", id), { namespace: "kernel.key-revocation", id, value });
      }
      if (changes.size || cause) {
        for (const [id, record] of pendingIdempotency) changes.set(factKey("kernel.protected-idempotency", id), {
          namespace: "kernel.protected-idempotency", id, value: JSON.parse(JSON.stringify(record)) as JsonValue,
        });
      } else {
        if (pendingIdempotency.size && protectsCoreRecords(options)) {
          throw new Error("Protected idempotency writes require an originating event");
        }
        for (const record of pendingIdempotency.values()) transaction.putIdempotency(record);
      }
      if (changes.size && !cause) throw new Error("Product projection changes require an originating event");
      const prepared = await boundedIo(Promise.all([...changes.values()].map(async change => {
        const prepared = await prepareProtectedProjection(options, tenantId, change);
        return { change, reference: prepared.reference };
      })), options);
      for (const [jobId, expiresAt] of leases) {
        if (Date.parse(expiresAt) <= Date.parse(now())) throw new StaleFencingTokenError(jobId);
      }
      for (const [id, record] of revocations) {
        const event = transaction.appendEvent({ tenantId, aggregateType: "keyRevocation", aggregateId: id,
          expectedStreamVersion: 0, type: "key.revocation_requested", actorId: cause!.actorId, generation: cause!.generation,
          causationId: cause!.id, correlationId: cause!.correlationId,
          publicPayload: { workspaceId: record.workspaceId!, keyDigest: sha256(Buffer.from(canonicalJson(record.wrappedKey!))) } });
        transaction.putOutbox({ id: `key-revocation:${id}`, tenantId, topic: event.type,
          payload: { eventId: event.id, revocationId: id }, availableAt: event.occurredAt });
      }
      // Preparation has no transaction access, so late CAS completion after a timeout only leaves an orphan.
      for (const { change, reference } of prepared) {
        if (change.namespace === "kernel.protected-idempotency") {
          transaction.putIdempotency({ ...pendingIdempotency.get(change.id)!, response: reference });
        } else if (change.value === null) transaction.deleteProjection(change.namespace, change.id);
        else transaction.putProjection(change.namespace, change.id, reference);
        const id = randomUUID();
        const event = transaction.appendEvent({
          tenantId, aggregateType: "projectionFact", aggregateId: id, expectedStreamVersion: 0,
          type: "projection.fact_committed", actorId: cause!.actorId, generation: cause!.generation,
          ...(cause!.executionId ? { executionId: cause!.executionId } : {}),
          correlationId: cause!.correlationId, causationId: cause!.id, protectedPayloadRef: reference.protectedPayloadRef,
          publicPayload: { namespace: change.namespace, resourceId: change.id, deleted: change.value === null,
            ...(typeof cause!.publicPayload.workspaceId === "string" ? { workspaceId: cause!.publicPayload.workspaceId } : {}) },
        });
        transaction.putOutbox({ id: `projection-fact:${id}`, tenantId, topic: event.type,
          payload: { eventId: event.id, position: event.position }, availableAt: event.occurredAt });
      }
    },
  };
}

export async function readJournalProjection(options: ProjectionJournalOptions, tenantId: string,
  namespace: string, id: string, stored: unknown): Promise<unknown> {
  if (stored === undefined || !selected(namespace, options)) return stored;
  const reference = stored as ProtectedProjectionReference;
  if (reference?.format !== "muniu.projection.reference" || typeof reference.protectedPayloadRef !== "string") {
    if ((PROTECTED_CORE_PROJECTION_NAMESPACES as readonly string[]).includes(namespace)) {
      throw new ProtectedCoreStateUpgradeRequiredError();
    }
    throw new Error("Product projection has no protected authoritative fact");
  }
  return readFactValue(options, tenantId, namespace, id, reference.protectedPayloadRef);
}

async function readFactValue(options: ProjectionJournalOptions, tenantId: string, namespace: string,
  id: string, digest: string): Promise<JsonValue> {
  const bytes = await options.cas.get(digest);
  if (sha256(bytes) !== digest) throw new Error("Projection ciphertext digest mismatch");
  const envelope = JSON.parse(bytes.toString("utf8")) as EncryptedEnvelopeV1;
  if (envelope.context.tenantId !== tenantId || envelope.context.purpose !== `projection:${factKey(namespace, id)}`) {
    throw new Error("Projection ciphertext belongs to a different resource");
  }
  const plaintext = await new EnvelopeCipher(options.keyProvider).decrypt(envelope);
  try {
    const payload = JSON.parse(plaintext.toString("utf8")) as JsonObject;
    if (payload.version !== 1 || payload.tenantId !== tenantId || payload.namespace !== namespace
      || payload.id !== id || payload.value === undefined) throw new Error("Invalid protected projection fact");
    return payload.value;
  } finally { plaintext.fill(0); }
}

/** Rebuild offline into an empty namespace. Physical Jobs and deleted keys are not replayed. */
export async function replayProjectionJournal(options: ProjectionJournalOptions & {
  readonly events: readonly KernelEventV1[];
  readonly tenantId: string;
  readonly hmacKey: Uint8Array;
}): Promise<readonly ProjectionJournalFact[]> {
  const latest = new Map<string, KernelEventV1>();
  let position = 0;
  let previousDigest: string | undefined;
  for (const event of options.events) {
    if (event.tenantId !== options.tenantId || event.position !== ++position
      || event.previousDigest !== previousDigest || !verifyEventIntegrity(event, options.hmacKey)) {
      throw new Error("Projection replay requires complete authenticated tenant events");
    }
    previousDigest = event.digest;
    if (event.type !== "projection.fact_committed") continue;
    const { namespace, resourceId } = event.publicPayload;
    if (typeof namespace !== "string" || typeof resourceId !== "string"
      || !event.protectedPayloadRef) throw new Error("Invalid projection fact reference");
    if (!selected(namespace, options)) continue;
    latest.set(factKey(namespace, resourceId), event);
  }
  const facts: ProjectionJournalFact[] = [];
  for (const event of latest.values()) {
    const namespace = String(event.publicPayload.namespace);
    const id = String(event.publicPayload.resourceId);
    if (event.publicPayload.deleted === true) {
      facts.push({ namespace, id, value: null });
      continue;
    }
    facts.push({ namespace, id, value: await readFactValue(options, options.tenantId, namespace, id, event.protectedPayloadRef!) });
  }
  return facts;
}

export interface JournalRebuildPlan {
  readonly projections: readonly ProjectionJournalEntry[];
  readonly idempotency: readonly KernelIdempotencyRecordLike[];
}

export function verifyProjectionJournalHistory(options: ProjectionJournalOptions & {
  readonly events: readonly KernelEventV1[]; readonly tenantId: string; readonly hmacKey: Uint8Array;
}): Promise<readonly ProjectionJournalFact[]> {
  return boundedIo(replayProjectionJournal(options), options);
}

/** Only a later authenticated protected fact supersedes an earlier plaintext core fact. */
export function unprotectedCoreProjectionFacts(options: ProjectionJournalOptions,
  events: readonly KernelEventV1[]): readonly ProjectionJournalFact[] {
  const pending = new Map<string, ProjectionJournalFact>();
  for (const event of events) {
    const envelope = event.publicPayload.projectionFacts as JsonObject | undefined;
    if (envelope && Array.isArray(envelope.changes)) for (const raw of envelope.changes) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const fact = raw as unknown as ProjectionJournalFact;
      if (PROTECTED_CORE_PROJECTION_NAMESPACES.includes(fact.namespace as typeof PROTECTED_CORE_PROJECTION_NAMESPACES[number])
        && selected(fact.namespace, options)) pending.set(factKey(fact.namespace, fact.id), fact);
    }
    if (event.type === "projection.fact_committed" && typeof event.publicPayload.namespace === "string"
      && typeof event.publicPayload.resourceId === "string" && event.protectedPayloadRef) {
      pending.delete(factKey(event.publicPayload.namespace, event.publicPayload.resourceId));
    }
  }
  return [...pending.values()];
}

/** Validate every latest ciphertext before exposing any records to the database switch. */
export async function prepareJournalRebuild(options: ProjectionJournalOptions & {
  readonly events: readonly KernelEventV1[]; readonly tenantId: string; readonly hmacKey: Uint8Array;
  readonly expectedPosition: number;
}): Promise<JournalRebuildPlan> {
  if ((options.events.at(-1)?.position ?? 0) !== options.expectedPosition) throw new Error("Projection replay is missing committed events");
  const facts = await verifyProjectionJournalHistory(options);
  if (unprotectedCoreProjectionFacts(options, options.events).length) throw new ProtectedCoreStateUpgradeRequiredError();
  const references = new Map<string, string>();
  for (const event of options.events) if (event.type === "projection.fact_committed") {
    references.set(factKey(String(event.publicPayload.namespace), String(event.publicPayload.resourceId)), event.protectedPayloadRef!);
  }
  const projections: ProjectionJournalEntry[] = [];
  const idempotency: KernelIdempotencyRecordLike[] = [];
  for (const fact of facts) {
    if (fact.value === null) continue;
    const value = fact.value as JsonObject;
    const reference: ProtectedProjectionReference = { format: "muniu.projection.reference",
      protectedPayloadRef: references.get(factKey(fact.namespace, fact.id))!,
      streamVersion: Number.isSafeInteger(value.streamVersion) ? Number(value.streamVersion) : 0 };
    if (fact.namespace === "kernel.protected-idempotency") {
      const receipt = fact.value as unknown as KernelIdempotencyRecordLike;
      if (receipt.tenantId !== options.tenantId || typeof receipt.scope !== "string" || typeof receipt.key !== "string"
        || fact.id !== factKey(receipt.scope, receipt.key) || typeof receipt.requestDigest !== "string"
        || typeof receipt.createdAt !== "string") throw new Error("Invalid idempotency replay fact");
      idempotency.push({ ...receipt, response: reference });
    } else projections.push({ namespace: fact.namespace, id: fact.id, value: reference });
  }
  return { projections, idempotency };
}

/** Offline mark phase: historical facts remain roots even when the current projection is deleted. */
export async function collectJournalCasReferences(options: ProjectionJournalOptions & {
  readonly events: readonly KernelEventV1[]; readonly tenantId: string; readonly hmacKey: Uint8Array;
  readonly expectedPosition: number;
  readonly deadlineMilliseconds?: number;
}): Promise<ReadonlySet<string>> {
  if (!Number.isSafeInteger(options.expectedPosition) || options.expectedPosition < 0
    || (options.events.at(-1)?.position ?? 0) !== options.expectedPosition) throw new Error("CAS verification is missing committed events");
  const digests = new Set<string>();
  const required = new Set<string>();
  const verified = new Set<string>();
  const ioOptions = () => {
    const remaining = (options.deadlineMilliseconds ?? Number.POSITIVE_INFINITY) - Date.now();
    if (remaining <= 0) throw new Error("CAS verification exceeded its time budget");
    return { ...options, ioTimeoutMs: Math.min(options.ioTimeoutMs ?? 10_000, remaining) };
  };
  const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  function requireDigest(value: unknown): void {
    if (!isDigest(value)) throw new Error("Invalid committed CAS reference");
    required.add(value);
    digests.add(value);
  }
  function scan(value: unknown, depth = 0): void {
    if (depth > 128) throw new Error("CAS reference nesting exceeds limit");
    if (isDigest(value)) digests.add(value);
    else if (Array.isArray(value)) for (const child of value) scan(child, depth + 1);
    else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (object.ciphertextDigest !== undefined) requireDigest(object.ciphertextDigest);
      if (object.namespace === "asset" && object.value) requireDigest((object.value as JsonObject).digest);
      for (const child of Object.values(object)) scan(child, depth + 1);
    }
  }
  let position = 0;
  let previousDigest: string | undefined;
  for (const event of options.events) {
    ioOptions();
    if (event.tenantId !== options.tenantId || event.position !== ++position
      || event.previousDigest !== previousDigest || !verifyEventIntegrity(event, options.hmacKey)) {
      throw new Error("CAS verification requires complete authenticated tenant events");
    }
    previousDigest = event.digest;
  }
  for (const event of options.events) {
    const bounded = ioOptions();
    scan(event.publicPayload);
    if (isDigest(event.protectedPayloadRef)) requireDigest(event.protectedPayloadRef);
    if (event.type === "projection.fact_committed") {
      const { namespace, resourceId } = event.publicPayload;
      if (typeof namespace !== "string" || typeof resourceId !== "string") throw new Error("Invalid projection fact reference");
      requireDigest(event.protectedPayloadRef);
      // Read the journal envelope, never unwrap a deleted business payload's DEK.
      scan(await boundedIo(readFactValue(options, options.tenantId, namespace, resourceId, event.protectedPayloadRef!), bounded));
      verified.add(event.protectedPayloadRef!);
    }
  }
  for (const digest of required) {
    if (verified.has(digest)) continue;
    const bounded = ioOptions();
    const bytes = await boundedIo(options.cas.get(digest), bounded);
    if (sha256(bytes) !== digest) throw new Error("Committed CAS object digest mismatch");
  }
  return digests;
}
