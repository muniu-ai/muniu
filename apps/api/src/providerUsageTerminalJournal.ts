import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256Canonical } from "@mn/governance";
import {
  providerUsageAttemptLogId,
  type ProviderUsageAttemptLog
} from "@mn/local-proxy";
import type { TrustedProxyUsageAssociation } from "@mn/provider-catalog";
import type { S3CompatibleArtifactStore } from "./artifactRemoteStore.js";

const JOURNAL_KIND = "provider_usage_attempt_log" as const;
const JOURNAL_SCHEMA_VERSION = 1 as const;
const JOURNAL_SIGNATURE_DOMAIN = "mn-provider-usage-terminal-journal-v1\0";
const REVOCATION_CHECKPOINT_KIND =
  "provider_usage_journal_revocation_checkpoint" as const;
const REVOCATION_CHECKPOINT_SCHEMA_VERSION = 1 as const;
const REVOCATION_CHECKPOINT_SIGNATURE_DOMAIN =
  "mn-provider-usage-terminal-journal-revocation-checkpoint-v1\0";
const MAX_IMMUTABLE_WRITE_ATTEMPTS = 3;
const MAX_JOURNAL_OBJECT_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_SCAN_OBJECTS = 50_000;
const MAX_JOURNAL_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_CHECKPOINT_OBJECT_BYTES = 256 * 1024;
const MAX_CHECKPOINT_SCAN_OBJECTS = 50_000;
const MAX_CHECKPOINT_SCAN_BYTES = 64 * 1024 * 1024;

export type ProviderUsageTerminalJournalIntegrityKeyStatus =
  | "active"
  | "retired"
  | "revoked";

export interface ProviderUsageTerminalJournalIntegrityKey {
  readonly id: string;
  readonly secret: string;
  readonly status: ProviderUsageTerminalJournalIntegrityKeyStatus;
}

export interface ProviderUsageTerminalJournalIntegrityProfile {
  readonly activeKeyId: string;
  readonly keys: readonly ProviderUsageTerminalJournalIntegrityKey[];
}

export interface ProviderUsageTerminalJournalRef {
  readonly schemaVersion: 1;
  readonly objectKey: string;
  readonly uri: string;
  readonly digest: string;
  readonly payloadDigest: string;
  readonly byteLength: number;
  readonly integrityKeyId: string;
  readonly revocationCheckpoint?:
    ProviderUsageTerminalJournalRevocationCheckpointAttestation;
}

export interface ProviderUsageTerminalJournalRevocationCheckpointInput {
  readonly journalObjectKey: string;
  readonly reason: string;
  readonly ticket: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalAuditEventId: string;
  readonly approvalAuditDigest: string;
  readonly evidenceDigest: string;
}

export interface ProviderUsageTerminalJournalRevocationCheckpointAttestation {
  readonly schemaVersion: 1;
  readonly checkpointObjectKey: string;
  readonly checkpointUri: string;
  readonly checkpointObjectDigest: string;
  readonly checkpointByteLength: number;
  readonly checkpointDigest: string;
  readonly authorityKeyId: string;
  readonly journalObjectKey: string;
  readonly journalObjectDigest: string;
  readonly journalObjectByteLength: number;
  readonly payloadDigest: string;
  readonly journalIntegrityKeyId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly reservationId: string;
  readonly logicalRequestId: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly reason: string;
  readonly ticket: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalAuditEventId: string;
  readonly approvalAuditDigest: string;
  readonly evidenceDigest: string;
}

export interface ProviderUsageTerminalJournalOptions {
  readonly store: S3CompatibleArtifactStore;
  readonly prefix?: string;
  readonly integrity: ProviderUsageTerminalJournalIntegrityProfile;
}

export interface ProviderUsageTerminalJournalReplayResult {
  readonly scanned: number;
  readonly replayed: number;
}

interface ProviderUsageTerminalJournalEnvelope {
  readonly schemaVersion: 1;
  readonly kind: typeof JOURNAL_KIND;
  readonly tenantId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly reservationId: string;
  readonly logicalRequestId: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly payload: ProviderUsageAttemptLog;
  readonly integrity: Readonly<{
    algorithm: "hmac-sha256";
    keyId: string;
    signature: string;
  }>;
}

type UnsignedProviderUsageTerminalJournalEnvelope = Omit<
  ProviderUsageTerminalJournalEnvelope,
  "integrity"
>;

interface ProviderUsageTerminalJournalAuthentication {
  readonly algorithm: "hmac-sha256";
  readonly keyId: string;
}

interface ProviderUsageTerminalJournalRevocationCheckpointJournalBinding {
  readonly objectKey: string;
  readonly objectDigest: string;
  readonly objectByteLength: number;
  readonly payloadDigest: string;
  readonly integrityKeyId: string;
  readonly integrityKeyStatusAtApproval: "retired";
  readonly tenantId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly reservationId: string;
  readonly logicalRequestId: string;
  readonly attemptIndex: number;
  readonly requestId: string;
}

interface ProviderUsageTerminalJournalRevocationCheckpointApproval {
  readonly reason: string;
  readonly ticket: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalAuditEventId: string;
  readonly approvalAuditDigest: string;
  readonly evidenceDigest: string;
}

interface ProviderUsageTerminalJournalRevocationCheckpointEnvelope {
  readonly schemaVersion: 1;
  readonly kind: typeof REVOCATION_CHECKPOINT_KIND;
  readonly journal: ProviderUsageTerminalJournalRevocationCheckpointJournalBinding;
  readonly approval: ProviderUsageTerminalJournalRevocationCheckpointApproval;
  readonly checkpointDigest: string;
  readonly integrity: Readonly<{
    algorithm: "hmac-sha256";
    keyId: string;
    keyStatusAtSigning: "active";
    signature: string;
  }>;
}

type UnsignedProviderUsageTerminalJournalRevocationCheckpointEnvelope = Omit<
  ProviderUsageTerminalJournalRevocationCheckpointEnvelope,
  "integrity"
>;

interface ProviderUsageTerminalJournalRevocationCheckpointAuthentication {
  readonly algorithm: "hmac-sha256";
  readonly keyId: string;
  readonly keyStatusAtSigning: "active";
}

interface NormalizedIntegrityProfile {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<
    string,
    Readonly<{ secret: Buffer; status: ProviderUsageTerminalJournalIntegrityKeyStatus }>
  >;
}

interface VerifiedJournalEntry {
  readonly envelope: ProviderUsageTerminalJournalEnvelope;
  readonly ref: ProviderUsageTerminalJournalRef;
  readonly integrityKeyStatus: ProviderUsageTerminalJournalIntegrityKeyStatus;
}

interface VerifiedRevocationCheckpointEntry {
  readonly envelope: ProviderUsageTerminalJournalRevocationCheckpointEnvelope;
  readonly attestation: ProviderUsageTerminalJournalRevocationCheckpointAttestation;
  readonly authorityKeyStatus: ProviderUsageTerminalJournalIntegrityKeyStatus;
}

interface ScanBudget {
  objects: number;
  bytes: number;
}

export class ProviderUsageTerminalJournalIntegrityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProviderUsageTerminalJournalIntegrityError";
  }
}

function revocationCheckpointEnvelope(input: {
  readonly journal: VerifiedJournalEntry;
  readonly journalBytes: Buffer;
  readonly approval: ProviderUsageTerminalJournalRevocationCheckpointApproval;
  readonly integrity: NormalizedIntegrityProfile;
}): ProviderUsageTerminalJournalRevocationCheckpointEnvelope {
  const journal = deepFreeze({
    objectKey: input.journal.ref.objectKey,
    objectDigest: sha256(input.journalBytes),
    objectByteLength: input.journalBytes.byteLength,
    payloadDigest: input.journal.envelope.payloadDigest,
    integrityKeyId: input.journal.envelope.integrity.keyId,
    integrityKeyStatusAtApproval: "retired" as const,
    tenantId: input.journal.envelope.tenantId,
    runId: input.journal.envelope.runId,
    candidateId: input.journal.envelope.candidateId,
    reservationId: input.journal.envelope.reservationId,
    logicalRequestId: input.journal.envelope.logicalRequestId,
    attemptIndex: input.journal.envelope.attemptIndex,
    requestId: input.journal.envelope.requestId
  });
  const checkpointDigest = checkpointStatementDigest(
    journal,
    input.approval
  );
  const unsigned = deepFreeze({
    schemaVersion: REVOCATION_CHECKPOINT_SCHEMA_VERSION,
    kind: REVOCATION_CHECKPOINT_KIND,
    journal,
    approval: input.approval,
    checkpointDigest
  });
  const authentication = deepFreeze({
    algorithm: "hmac-sha256" as const,
    keyId: input.integrity.activeKeyId,
    keyStatusAtSigning: "active" as const
  });
  const authority = input.integrity.keys.get(input.integrity.activeKeyId)!;
  return deepFreeze({
    ...unsigned,
    integrity: {
      ...authentication,
      signature: revocationCheckpointSignature(
        unsigned,
        authentication,
        authority.secret
      )
    }
  });
}

function validateRevocationCheckpointEnvelope(
  value: unknown,
  integrityProfile: NormalizedIntegrityProfile
): ProviderUsageTerminalJournalRevocationCheckpointEnvelope {
  if (!isRecord(value)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint must be an object"
    );
  }
  exactFields(
    value,
    [
      "approval",
      "checkpointDigest",
      "integrity",
      "journal",
      "kind",
      "schemaVersion"
    ],
    "provider usage journal revocation checkpoint"
  );
  if (
    value.schemaVersion !== REVOCATION_CHECKPOINT_SCHEMA_VERSION ||
    value.kind !== REVOCATION_CHECKPOINT_KIND
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint version or kind is invalid"
    );
  }
  if (!isRecord(value.journal)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint journal binding is invalid"
    );
  }
  exactFields(
    value.journal,
    [
      "attemptIndex",
      "candidateId",
      "integrityKeyId",
      "integrityKeyStatusAtApproval",
      "logicalRequestId",
      "objectByteLength",
      "objectDigest",
      "objectKey",
      "payloadDigest",
      "requestId",
      "reservationId",
      "runId",
      "tenantId"
    ],
    "provider usage journal revocation checkpoint journal binding"
  );
  const attemptIndex = positiveInteger(
    value.journal.attemptIndex,
    "revocationCheckpoint.journal.attemptIndex"
  );
  if (attemptIndex > 1_000) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint attemptIndex exceeds the supported limit"
    );
  }
  const journal: ProviderUsageTerminalJournalRevocationCheckpointJournalBinding =
    deepFreeze({
      objectKey: checkpointText(
        value.journal.objectKey,
        "revocationCheckpoint.journal.objectKey",
        2_048
      ),
      objectDigest: digest(
        value.journal.objectDigest,
        "revocationCheckpoint.journal.objectDigest"
      ),
      objectByteLength: positiveInteger(
        value.journal.objectByteLength,
        "revocationCheckpoint.journal.objectByteLength"
      ),
      payloadDigest: digest(
        value.journal.payloadDigest,
        "revocationCheckpoint.journal.payloadDigest"
      ),
      integrityKeyId: identifier(
        value.journal.integrityKeyId,
        "revocationCheckpoint.journal.integrityKeyId"
      ),
      integrityKeyStatusAtApproval:
        value.journal.integrityKeyStatusAtApproval === "retired"
          ? "retired"
          : invalidCheckpointStatus("journal integrity key"),
      tenantId: identifier(
        value.journal.tenantId,
        "revocationCheckpoint.journal.tenantId"
      ),
      runId: identifier(
        value.journal.runId,
        "revocationCheckpoint.journal.runId"
      ),
      candidateId: identifier(
        value.journal.candidateId,
        "revocationCheckpoint.journal.candidateId"
      ),
      reservationId: identifier(
        value.journal.reservationId,
        "revocationCheckpoint.journal.reservationId"
      ),
      logicalRequestId: identifier(
        value.journal.logicalRequestId,
        "revocationCheckpoint.journal.logicalRequestId"
      ),
      attemptIndex,
      requestId: identifier(
        value.journal.requestId,
        "revocationCheckpoint.journal.requestId"
      )
    });
  if (
    journal.logicalRequestId !== journal.reservationId ||
    journal.requestId !==
      providerUsageAttemptLogId(journal.logicalRequestId, journal.attemptIndex)
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint stable identity is invalid"
    );
  }
  if (!isRecord(value.approval)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint approval is invalid"
    );
  }
  const approval = normalizeCheckpointApproval(value.approval);
  const checkpointDigestValue = digest(
    value.checkpointDigest,
    "revocationCheckpoint.checkpointDigest"
  );
  if (
    checkpointDigestValue !== checkpointStatementDigest(journal, approval)
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint digest is invalid"
    );
  }
  if (!isRecord(value.integrity)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint integrity is invalid"
    );
  }
  exactFields(
    value.integrity,
    ["algorithm", "keyId", "keyStatusAtSigning", "signature"],
    "provider usage journal revocation checkpoint integrity"
  );
  if (
    value.integrity.algorithm !== "hmac-sha256" ||
    value.integrity.keyStatusAtSigning !== "active"
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint integrity metadata is invalid"
    );
  }
  const authorityKeyId = identifier(
    value.integrity.keyId,
    "revocationCheckpoint.integrity.keyId"
  );
  const authority = integrityProfile.keys.get(authorityKeyId);
  if (!authority) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint authority is not trusted"
    );
  }
  if (authorityKeyId === journal.integrityKeyId) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint cannot self-authorize"
    );
  }
  const signature = canonicalBase64Url(
    value.integrity.signature,
    "revocationCheckpoint.integrity.signature"
  );
  const unsigned = deepFreeze({
    schemaVersion: REVOCATION_CHECKPOINT_SCHEMA_VERSION,
    kind: REVOCATION_CHECKPOINT_KIND,
    journal,
    approval,
    checkpointDigest: checkpointDigestValue
  });
  const authentication = deepFreeze({
    algorithm: "hmac-sha256" as const,
    keyId: authorityKeyId,
    keyStatusAtSigning: "active" as const
  });
  if (
    !constantTimeTextEqual(
      signature,
      revocationCheckpointSignature(
        unsigned,
        authentication,
        authority.secret
      )
    )
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint signature is invalid"
    );
  }
  return deepFreeze({
    ...unsigned,
    integrity: {
      ...authentication,
      signature
    }
  });
}

function normalizeCheckpointApproval(
  value: ProviderUsageTerminalJournalRevocationCheckpointInput | Record<string, any>
): ProviderUsageTerminalJournalRevocationCheckpointApproval {
  const hasJournalObjectKey = Object.prototype.hasOwnProperty.call(
    value,
    "journalObjectKey"
  );
  exactFields(
    value,
    [
      "approvalAuditDigest",
      "approvalAuditEventId",
      "approvedAt",
      "approvedBy",
      "evidenceDigest",
      "reason",
      "ticket",
      ...(hasJournalObjectKey ? ["journalObjectKey"] : [])
    ],
    "provider usage journal revocation checkpoint input"
  );
  return deepFreeze({
    reason: checkpointText(value.reason, "revocationCheckpoint.reason", 2_048),
    ticket: checkpointText(value.ticket, "revocationCheckpoint.ticket", 512),
    approvedBy: checkpointText(
      value.approvedBy,
      "revocationCheckpoint.approvedBy",
      512
    ),
    approvedAt: canonicalTimestampText(
      value.approvedAt,
      "revocationCheckpoint.approvedAt"
    ),
    approvalAuditEventId: checkpointText(
      value.approvalAuditEventId,
      "revocationCheckpoint.approvalAuditEventId",
      512
    ),
    approvalAuditDigest: digest(
      value.approvalAuditDigest,
      "revocationCheckpoint.approvalAuditDigest"
    ),
    evidenceDigest: digest(
      value.evidenceDigest,
      "revocationCheckpoint.evidenceDigest"
    )
  });
}

function checkpointStatementDigest(
  journal: ProviderUsageTerminalJournalRevocationCheckpointJournalBinding,
  approval: ProviderUsageTerminalJournalRevocationCheckpointApproval
): string {
  return sha256Canonical({
    schemaVersion: REVOCATION_CHECKPOINT_SCHEMA_VERSION,
    kind: REVOCATION_CHECKPOINT_KIND,
    journal,
    approval
  });
}

function revocationCheckpointSignature(
  envelope: UnsignedProviderUsageTerminalJournalRevocationCheckpointEnvelope,
  authentication: ProviderUsageTerminalJournalRevocationCheckpointAuthentication,
  secret: Buffer
): string {
  return createHmac("sha256", secret)
    .update(REVOCATION_CHECKPOINT_SIGNATURE_DOMAIN)
    .update(canonicalJson({ authentication, envelope }))
    .digest("base64url");
}

function checkpointAttestation(
  bucket: string,
  objectKey: string,
  bytes: Buffer,
  envelope: ProviderUsageTerminalJournalRevocationCheckpointEnvelope
): ProviderUsageTerminalJournalRevocationCheckpointAttestation {
  return deepFreeze({
    schemaVersion: REVOCATION_CHECKPOINT_SCHEMA_VERSION,
    checkpointObjectKey: objectKey,
    checkpointUri: `s3://${bucket}/${objectKey}`,
    checkpointObjectDigest: sha256(bytes),
    checkpointByteLength: bytes.byteLength,
    checkpointDigest: envelope.checkpointDigest,
    authorityKeyId: envelope.integrity.keyId,
    journalObjectKey: envelope.journal.objectKey,
    journalObjectDigest: envelope.journal.objectDigest,
    journalObjectByteLength: envelope.journal.objectByteLength,
    payloadDigest: envelope.journal.payloadDigest,
    journalIntegrityKeyId: envelope.journal.integrityKeyId,
    tenantId: envelope.journal.tenantId,
    runId: envelope.journal.runId,
    candidateId: envelope.journal.candidateId,
    reservationId: envelope.journal.reservationId,
    logicalRequestId: envelope.journal.logicalRequestId,
    attemptIndex: envelope.journal.attemptIndex,
    requestId: envelope.journal.requestId,
    reason: envelope.approval.reason,
    ticket: envelope.approval.ticket,
    approvedBy: envelope.approval.approvedBy,
    approvedAt: envelope.approval.approvedAt,
    approvalAuditEventId: envelope.approval.approvalAuditEventId,
    approvalAuditDigest: envelope.approval.approvalAuditDigest,
    evidenceDigest: envelope.approval.evidenceDigest
  });
}

function assertCheckpointBindsJournal(
  checkpoint: ProviderUsageTerminalJournalRevocationCheckpointEnvelope,
  journal: VerifiedJournalEntry,
  journalBytes: Buffer
): void {
  const expected = {
    objectKey: journal.ref.objectKey,
    objectDigest: sha256(journalBytes),
    objectByteLength: journalBytes.byteLength,
    payloadDigest: journal.envelope.payloadDigest,
    integrityKeyId: journal.envelope.integrity.keyId,
    tenantId: journal.envelope.tenantId,
    runId: journal.envelope.runId,
    candidateId: journal.envelope.candidateId,
    reservationId: journal.envelope.reservationId,
    logicalRequestId: journal.envelope.logicalRequestId,
    attemptIndex: journal.envelope.attemptIndex,
    requestId: journal.envelope.requestId
  } as const;
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (
      checkpoint.journal[
        field as keyof ProviderUsageTerminalJournalRevocationCheckpointJournalBinding
      ] !== expectedValue
    ) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        `provider usage journal revocation checkpoint ${field} binding is invalid`
      );
    }
  }
  if (
    Date.parse(checkpoint.approval.approvedAt) <
    Date.parse(journal.envelope.payload.createdAt)
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal revocation checkpoint approval predates the journal"
    );
  }
}

function journalAttemptIdentity(
  envelope: ProviderUsageTerminalJournalEnvelope
): string {
  return [
    envelope.tenantId,
    envelope.reservationId,
    envelope.logicalRequestId,
    String(envelope.attemptIndex)
  ].join("\0");
}

function preflightJournalReplay(
  entries: readonly VerifiedJournalEntry[]
): VerifiedJournalEntry[] {
  const reservations = new Map<string, VerifiedJournalEntry[]>();
  for (const entry of entries) {
    const key = [entry.envelope.tenantId, entry.envelope.reservationId].join("\0");
    const group = reservations.get(key) ?? [];
    group.push(entry);
    reservations.set(key, group);
  }
  for (const group of reservations.values()) {
    group.sort((left, right) =>
      left.envelope.attemptIndex - right.envelope.attemptIndex ||
      left.envelope.requestId.localeCompare(right.envelope.requestId)
    );
    const first = group[0]!;
    for (const [offset, entry] of group.entries()) {
      if (
        entry.envelope.runId !== first.envelope.runId ||
        entry.envelope.candidateId !== first.envelope.candidateId ||
        entry.envelope.logicalRequestId !== first.envelope.logicalRequestId
      ) {
        throw new ProviderUsageTerminalJournalIntegrityError(
          "provider usage journal reservation bindings are inconsistent"
        );
      }
      if (entry.envelope.attemptIndex !== offset + 1) {
        throw new ProviderUsageTerminalJournalIntegrityError(
          "provider usage journal reservation attempts are not continuous from index 1"
        );
      }
      if (
        entry.envelope.payload.usageAttempt.terminal &&
        offset !== group.length - 1
      ) {
        throw new ProviderUsageTerminalJournalIntegrityError(
          "provider usage journal terminal attempt has a successor"
        );
      }
    }
  }
  return [...entries].sort((left, right) =>
    left.envelope.tenantId.localeCompare(right.envelope.tenantId) ||
    left.envelope.reservationId.localeCompare(right.envelope.reservationId) ||
    left.envelope.logicalRequestId.localeCompare(right.envelope.logicalRequestId) ||
    left.envelope.attemptIndex - right.envelope.attemptIndex ||
    left.envelope.requestId.localeCompare(right.envelope.requestId)
  );
}

function deduplicateObjectSummaries<T extends { readonly key: string; readonly bytes: number }>(
  objects: readonly T[]
): T[] {
  const unique = new Map<string, T>();
  for (const object of objects) {
    if (!unique.has(object.key)) unique.set(object.key, object);
  }
  return [...unique.values()].sort((left, right) =>
    left.key.localeCompare(right.key)
  );
}

function consumeScanBudget(input: {
  readonly budget: ScanBudget;
  readonly bytes: number;
  readonly maxObjectBytes: number;
  readonly maxObjects: number;
  readonly maxBytes: number;
  readonly label: string;
}): void {
  assertObjectSize(input.bytes, input.maxObjectBytes, `${input.label} listed object`);
  input.budget.objects += 1;
  input.budget.bytes += input.bytes;
  if (
    input.budget.objects > input.maxObjects ||
    !Number.isSafeInteger(input.budget.bytes) ||
    input.budget.bytes > input.maxBytes
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `${input.label} scan limit exceeded`
    );
  }
}

function reconcileActualScanBytes(
  budget: ScanBudget,
  listedBytes: number,
  actualBytes: number,
  maxObjectBytes: number,
  maxBytes: number,
  label: string
): void {
  assertObjectSize(actualBytes, maxObjectBytes, `${label} object`);
  budget.bytes = budget.bytes - listedBytes + actualBytes;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > maxBytes) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `${label} scan byte limit exceeded`
    );
  }
}

function assertObjectSize(bytes: number, maxBytes: number, label: string): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxBytes) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `${label} exceeds the supported size limit`
    );
  }
}

function exactFields(
  value: Record<string, any>,
  expected: readonly string[],
  label: string,
  ignored: ReadonlySet<string> = new Set()
): void {
  const actual = Object.keys(value)
    .filter((field) => !ignored.has(field))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `${label} contains unsupported fields`
    );
  }
}

function invalidCheckpointStatus(label: string): never {
  throw new ProviderUsageTerminalJournalIntegrityError(
    `provider usage journal revocation checkpoint ${label} status is invalid`
  );
}

/**
 * Immutable, S3-backed write-ahead journal for provider usage attempts.
 *
 * A provider result enters this journal before PostgreSQL append. Entries are
 * retained after a successful append, so a process restart or ambiguous PG
 * COMMIT acknowledgement can replay the exact same stable log id without
 * contacting the provider again.
 */
export class ProviderUsageTerminalJournal {
  private readonly store: S3CompatibleArtifactStore;
  private readonly prefix: string;
  private readonly integrity: NormalizedIntegrityProfile;

  constructor(options: ProviderUsageTerminalJournalOptions) {
    this.store = options.store;
    this.prefix = normalizePrefix(options.prefix);
    this.integrity = normalizeIntegrityProfile(options.integrity);
  }

  journalPrefix(): string {
    return joinKey(this.prefix, "provider-usage-journal/v1");
  }

  revocationCheckpointPrefix(): string {
    return joinKey(
      this.prefix,
      "provider-usage-journal-revocation-checkpoints/v1"
    );
  }

  async persist(
    log: ProviderUsageAttemptLog
  ): Promise<ProviderUsageTerminalJournalRef> {
    const envelope = journalEnvelope(log, this.integrity);
    const bytes = Buffer.from(canonicalJson(envelope), "utf8");
    assertObjectSize(
      bytes.byteLength,
      MAX_JOURNAL_OBJECT_BYTES,
      "provider usage journal object"
    );
    const ref = journalRef(this.store.bucket, this.objectKey(envelope), bytes, envelope);
    const existing = await this.putImmutable({
      objectKey: ref.objectKey,
      bytes,
      contentType: "application/vnd.mn.provider-usage-journal+json",
      metadata: {
        "mn-schema-version": String(JOURNAL_SCHEMA_VERSION),
        "mn-sha256": ref.digest,
        "mn-payload-sha256": ref.payloadDigest
      },
      maxBytes: MAX_JOURNAL_OBJECT_BYTES,
      label: "provider usage journal",
      verify: (persisted) =>
        this.readJournalCandidate(ref.objectKey, persisted, false),
      equivalent: (candidate) =>
        candidate.envelope.payloadDigest === envelope.payloadDigest &&
        canonicalJson(candidate.envelope.payload) === canonicalJson(envelope.payload)
    });
    return existing.ref;
  }

  /**
   * Creates an explicit, immutable approval sidecar before a retired journal
   * key is revoked. Replay never calls this method and can therefore never
   * manufacture its own authority to bypass a revocation.
   */
  async createRevocationCheckpoint(
    input: ProviderUsageTerminalJournalRevocationCheckpointInput
  ): Promise<ProviderUsageTerminalJournalRevocationCheckpointAttestation> {
    if (!isRecord(input)) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal revocation checkpoint input is invalid"
      );
    }
    const journalObjectKey = checkpointText(
      input.journalObjectKey,
      "journalObjectKey",
      2_048
    );
    if (!journalObjectKey.startsWith(`${this.journalPrefix()}/`)) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal revocation checkpoint object is outside the journal prefix"
      );
    }
    const journalBytes = await this.store.getObject(journalObjectKey);
    if (!journalBytes) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal revocation checkpoint source object is missing"
      );
    }
    assertObjectSize(
      journalBytes.byteLength,
      MAX_JOURNAL_OBJECT_BYTES,
      "provider usage journal object"
    );
    const journal = this.readJournalCandidate(
      journalObjectKey,
      journalBytes,
      true
    );
    if (journal.integrityKeyStatus !== "retired") {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal revocation checkpoints require a retired journal key"
      );
    }
    const approval = normalizeCheckpointApproval(input);
    if (
      Date.parse(approval.approvedAt) <
      Date.parse(journal.envelope.payload.createdAt)
    ) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal revocation checkpoint approval predates the journal"
      );
    }
    const envelope = revocationCheckpointEnvelope({
      journal,
      journalBytes,
      approval,
      integrity: this.integrity
    });
    const bytes = Buffer.from(canonicalJson(envelope), "utf8");
    assertObjectSize(
      bytes.byteLength,
      MAX_CHECKPOINT_OBJECT_BYTES,
      "provider usage journal revocation checkpoint object"
    );
    const objectKey = this.revocationCheckpointObjectKey(envelope);
    const expected = checkpointAttestation(
      this.store.bucket,
      objectKey,
      bytes,
      envelope
    );
    const existing = await this.putImmutable({
      objectKey,
      bytes,
      contentType:
        "application/vnd.mn.provider-usage-journal-revocation-checkpoint+json",
      metadata: {
        "mn-schema-version": String(REVOCATION_CHECKPOINT_SCHEMA_VERSION),
        "mn-sha256": expected.checkpointObjectDigest,
        "mn-checkpoint-sha256": expected.checkpointDigest,
        "mn-journal-sha256": expected.journalObjectDigest
      },
      maxBytes: MAX_CHECKPOINT_OBJECT_BYTES,
      label: "provider usage journal revocation checkpoint",
      verify: (persisted) =>
        this.readVerifiedRevocationCheckpoint(objectKey, persisted),
      equivalent: (candidate) =>
        candidate.envelope.checkpointDigest === envelope.checkpointDigest &&
        canonicalJson(candidate.envelope) === canonicalJson(envelope)
    });
    return existing.attestation;
  }

  async replayAll(
    append: (
      log: ProviderUsageAttemptLog,
      ref: ProviderUsageTerminalJournalRef
    ) => Promise<void>
  ): Promise<ProviderUsageTerminalJournalReplayResult> {
    const listed = deduplicateObjectSummaries(
      await this.store.listObjects(`${this.journalPrefix()}/`)
    );
    const journalBudget: ScanBudget = { objects: 0, bytes: 0 };
    const checkpointBudget: ScanBudget = { objects: 0, bytes: 0 };
    const entries: VerifiedJournalEntry[] = [];
    const identities = new Map<string, string>();
    for (const object of listed) {
      consumeScanBudget({
        budget: journalBudget,
        bytes: object.bytes,
        maxObjectBytes: MAX_JOURNAL_OBJECT_BYTES,
        maxObjects: MAX_JOURNAL_SCAN_OBJECTS,
        maxBytes: MAX_JOURNAL_SCAN_BYTES,
        label: "provider usage journal"
      });
      const bytes = await this.store.getObject(object.key);
      if (!bytes) {
        throw new ProviderUsageTerminalJournalIntegrityError(
          "provider usage journal object disappeared during recovery"
        );
      }
      reconcileActualScanBytes(
        journalBudget,
        object.bytes,
        bytes.byteLength,
        MAX_JOURNAL_OBJECT_BYTES,
        MAX_JOURNAL_SCAN_BYTES,
        "provider usage journal"
      );
      const candidate = this.readJournalCandidate(object.key, bytes, true);
      const ref = candidate.integrityKeyStatus === "revoked"
        ? deepFreeze({
            ...candidate.ref,
            revocationCheckpoint: await this.loadRevocationCheckpoint(
              candidate,
              bytes,
              checkpointBudget
            )
          })
        : candidate.ref;
      const identity = journalAttemptIdentity(candidate.envelope);
      const previousKey = identities.get(identity);
      if (previousKey !== undefined) {
        throw new ProviderUsageTerminalJournalIntegrityError(
          previousKey === object.key
            ? "provider usage journal contains a duplicate attempt identity"
            : "provider usage journal contains conflicting attempt identities"
        );
      }
      identities.set(identity, object.key);
      entries.push(deepFreeze({ ...candidate, ref }));
    }
    const ordered = preflightJournalReplay(entries);
    let replayed = 0;
    for (const { envelope, ref } of ordered) {
      await append(envelope.payload, ref);
      replayed += 1;
    }
    return deepFreeze({ scanned: listed.length, replayed });
  }

  readVerified(
    objectKey: string,
    bytes: Buffer
  ): Readonly<{
    envelope: ProviderUsageTerminalJournalEnvelope;
    ref: ProviderUsageTerminalJournalRef;
  }> {
    const { envelope, ref } = this.readJournalCandidate(
      objectKey,
      bytes,
      false
    );
    return deepFreeze({ envelope, ref });
  }

  private readJournalCandidate(
    objectKey: string,
    bytes: Buffer,
    allowRevoked: boolean
  ): VerifiedJournalEntry {
    assertObjectSize(
      bytes.byteLength,
      MAX_JOURNAL_OBJECT_BYTES,
      "provider usage journal object"
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal object is not valid JSON",
        error
      );
    }
    const envelope = validateEnvelope(parsed, this.integrity, allowRevoked);
    const canonical = Buffer.from(canonicalJson(envelope), "utf8");
    if (!canonical.equals(bytes)) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal object is not canonically encoded"
      );
    }
    const expectedKey = this.objectKey(envelope);
    if (objectKey !== expectedKey) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal object key does not match its tenant/run bindings"
      );
    }
    const integrityKeyStatus = this.integrity.keys.get(
      envelope.integrity.keyId
    )!.status;
    return deepFreeze({
      envelope,
      ref: journalRef(this.store.bucket, objectKey, bytes, envelope),
      integrityKeyStatus
    });
  }

  private async loadRevocationCheckpoint(
    journal: VerifiedJournalEntry,
    journalBytes: Buffer,
    budget: ScanBudget
  ): Promise<ProviderUsageTerminalJournalRevocationCheckpointAttestation> {
    const prefix = `${this.revocationCheckpointObjectPrefix(
      journal.ref.objectKey
    )}/authorities/`;
    const objects = deduplicateObjectSummaries(
      await this.store.listObjects(prefix)
    );
    if (objects.length === 0) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "revoked provider usage journal key has no revocation checkpoint"
      );
    }
    const eligible: VerifiedRevocationCheckpointEntry[] = [];
    for (const object of objects) {
      consumeScanBudget({
        budget,
        bytes: object.bytes,
        maxObjectBytes: MAX_CHECKPOINT_OBJECT_BYTES,
        maxObjects: MAX_CHECKPOINT_SCAN_OBJECTS,
        maxBytes: MAX_CHECKPOINT_SCAN_BYTES,
        label: "provider usage journal revocation checkpoint"
      });
      const bytes = await this.store.getObject(object.key);
      if (!bytes) {
        throw new ProviderUsageTerminalJournalIntegrityError(
          "provider usage journal revocation checkpoint disappeared during recovery"
        );
      }
      reconcileActualScanBytes(
        budget,
        object.bytes,
        bytes.byteLength,
        MAX_CHECKPOINT_OBJECT_BYTES,
        MAX_CHECKPOINT_SCAN_BYTES,
        "provider usage journal revocation checkpoint"
      );
      const checkpoint = this.readVerifiedRevocationCheckpoint(
        object.key,
        bytes
      );
      assertCheckpointBindsJournal(checkpoint.envelope, journal, journalBytes);
      if (checkpoint.authorityKeyStatus !== "revoked") {
        eligible.push(checkpoint);
      }
    }
    if (eligible.length === 0) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "revoked provider usage journal key has no checkpoint signed by a non-revoked authority"
      );
    }
    eligible.sort((left, right) =>
      left.attestation.checkpointDigest.localeCompare(
        right.attestation.checkpointDigest
      ) ||
      left.attestation.checkpointObjectKey.localeCompare(
        right.attestation.checkpointObjectKey
      )
    );
    return eligible[0]!.attestation;
  }

  private readVerifiedRevocationCheckpoint(
    objectKey: string,
    bytes: Buffer
  ): VerifiedRevocationCheckpointEntry {
    assertObjectSize(
      bytes.byteLength,
      MAX_CHECKPOINT_OBJECT_BYTES,
      "provider usage journal revocation checkpoint object"
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal revocation checkpoint is not valid JSON",
        error
      );
    }
    const envelope = validateRevocationCheckpointEnvelope(
      parsed,
      this.integrity
    );
    if (!Buffer.from(canonicalJson(envelope), "utf8").equals(bytes)) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal revocation checkpoint is not canonically encoded"
      );
    }
    if (objectKey !== this.revocationCheckpointObjectKey(envelope)) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal revocation checkpoint object key is invalid"
      );
    }
    const authorityKeyStatus = this.integrity.keys.get(
      envelope.integrity.keyId
    )!.status;
    return deepFreeze({
      envelope,
      attestation: checkpointAttestation(
        this.store.bucket,
        objectKey,
        bytes,
        envelope
      ),
      authorityKeyStatus
    });
  }

  private objectKey(envelope: ProviderUsageTerminalJournalEnvelope): string {
    const scope = [
      ["tenants", envelope.tenantId],
      ["runs", envelope.runId],
      ["reservations", envelope.reservationId],
      ["requests", envelope.requestId]
    ] as const;
    const segments = scope.flatMap(([label, value]) => [
      label,
      sha256(`${label}\0${value}`)
    ]);
    return joinKey(
      this.journalPrefix(),
      ...segments,
      `attempt-${envelope.attemptIndex}.json`
    );
  }

  private revocationCheckpointObjectPrefix(journalObjectKey: string): string {
    return joinKey(
      this.revocationCheckpointPrefix(),
      "objects",
      sha256(`journal-object-key\0${journalObjectKey}`)
    );
  }

  private revocationCheckpointObjectKey(
    envelope: ProviderUsageTerminalJournalRevocationCheckpointEnvelope
  ): string {
    return joinKey(
      this.revocationCheckpointObjectPrefix(envelope.journal.objectKey),
      "authorities",
      `${sha256(`authority-key\0${envelope.integrity.keyId}`)}.json`
    );
  }

  private async putImmutable<T>(input: {
    readonly objectKey: string;
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly maxBytes: number;
    readonly label: string;
    readonly verify: (bytes: Buffer) => T;
    readonly equivalent: (candidate: T) => boolean;
  }): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_IMMUTABLE_WRITE_ATTEMPTS; attempt += 1) {
      try {
        const stored = await this.store.putObject(input.objectKey, input.bytes, {
          contentType: input.contentType,
          metadata: input.metadata,
          ifNoneMatch: "*"
        });
        if (
          stored.key !== input.objectKey ||
          stored.bytes !== input.bytes.byteLength ||
          stored.sha256 !== sha256(input.bytes)
        ) {
          throw new ProviderUsageTerminalJournalIntegrityError(
            `${input.label} remote write acknowledgement is inconsistent`
          );
        }
      } catch (error) {
        // 409/412, 5xx, and transport resets may all mean the create committed
        // but its acknowledgement was lost. Only an exact GET is authoritative.
        lastError = error;
      }
      let persisted: Buffer | undefined;
      try {
        persisted = await this.store.getObject(input.objectKey);
      } catch (error) {
        lastError = error;
        continue;
      }
      if (!persisted) continue;
      assertObjectSize(persisted.byteLength, input.maxBytes, `${input.label} object`);
      const candidate = input.verify(persisted);
      if (!input.equivalent(candidate)) {
        throw new ProviderUsageTerminalJournalIntegrityError(
          `${input.label} stable key has conflicting immutable content`
        );
      }
      return candidate;
    }
    if (lastError !== undefined) throw lastError;
    throw new ProviderUsageTerminalJournalIntegrityError(
      `${input.label} object is missing after create attempts`
    );
  }
}

function journalEnvelope(
  log: ProviderUsageAttemptLog,
  integrity: NormalizedIntegrityProfile
): ProviderUsageTerminalJournalEnvelope {
  const association = validateLog(log);
  const payload = deepFreeze(
    JSON.parse(canonicalJson(log)) as ProviderUsageAttemptLog
  );
  const unsigned: UnsignedProviderUsageTerminalJournalEnvelope = deepFreeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    kind: JOURNAL_KIND,
    tenantId: association.tenantId,
    runId: association.runId,
    candidateId: association.candidateId,
    reservationId: association.reservationId!,
    logicalRequestId: log.usageAttempt.logicalRequestId,
    attemptIndex: log.usageAttempt.index,
    requestId: log.id,
    payloadDigest: sha256Canonical(payload),
    payload
  });
  const key = integrity.keys.get(integrity.activeKeyId)!;
  const authentication = deepFreeze({
    algorithm: "hmac-sha256" as const,
    keyId: integrity.activeKeyId
  });
  return deepFreeze({
    ...unsigned,
    integrity: deepFreeze({
      ...authentication,
      signature: hmacSignature(unsigned, authentication, key.secret)
    })
  });
}

function validateEnvelope(
  value: unknown,
  integrityProfile: NormalizedIntegrityProfile,
  allowRevoked = false
): ProviderUsageTerminalJournalEnvelope {
  if (!isRecord(value)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal envelope must be an object"
    );
  }
  const expectedFields = [
    "attemptIndex",
    "candidateId",
    "integrity",
    "kind",
    "logicalRequestId",
    "payload",
    "payloadDigest",
    "requestId",
    "reservationId",
    "runId",
    "schemaVersion",
    "tenantId"
  ];
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedFields)
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal envelope contains unsupported fields"
    );
  }
  if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION || value.kind !== JOURNAL_KIND) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal envelope version or kind is invalid"
    );
  }
  if (!isRecord(value.integrity)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal integrity envelope is invalid"
    );
  }
  const integrityFields = Object.keys(value.integrity).sort();
  if (
    JSON.stringify(integrityFields) !==
      JSON.stringify(["algorithm", "keyId", "signature"])
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal integrity envelope contains unsupported fields"
    );
  }
  if (value.integrity.algorithm !== "hmac-sha256") {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal integrity algorithm is invalid"
    );
  }
  const keyId = identifier(value.integrity.keyId, "integrity.keyId");
  const key = integrityProfile.keys.get(keyId);
  if (!key) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal integrity key is not trusted"
    );
  }
  const signature = canonicalBase64Url(
    value.integrity.signature,
    "integrity.signature"
  );
  const { integrity: _integrity, ...unsignedValue } = value;
  const expectedSignature = hmacSignature(
    unsignedValue as UnsignedProviderUsageTerminalJournalEnvelope,
    { algorithm: "hmac-sha256", keyId },
    key.secret
  );
  if (!constantTimeTextEqual(signature, expectedSignature)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal integrity signature is invalid"
    );
  }
  if (key.status === "revoked" && !allowRevoked) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal integrity key is not trusted"
    );
  }
  const log = value.payload as ProviderUsageAttemptLog;
  const association = validateLog(log);
  const attemptIndex = positiveInteger(value.attemptIndex, "attemptIndex");
  for (const [field, actual, expected] of [
    ["tenantId", value.tenantId, association.tenantId],
    ["runId", value.runId, association.runId],
    ["candidateId", value.candidateId, association.candidateId],
    ["reservationId", value.reservationId, association.reservationId],
    ["logicalRequestId", value.logicalRequestId, log.usageAttempt.logicalRequestId],
    ["requestId", value.requestId, log.id]
  ] as const) {
    if (actual !== expected) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        `provider usage journal ${field} binding is invalid`
      );
    }
  }
  if (attemptIndex !== log.usageAttempt.index) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal attemptIndex binding is invalid"
    );
  }
  const payloadDigest = digest(value.payloadDigest, "payloadDigest");
  if (payloadDigest !== sha256Canonical(log)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal payload digest is invalid"
    );
  }
  return deepFreeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    kind: JOURNAL_KIND,
    tenantId: association.tenantId,
    runId: association.runId,
    candidateId: association.candidateId,
    reservationId: association.reservationId!,
    logicalRequestId: log.usageAttempt.logicalRequestId,
    attemptIndex,
    requestId: log.id,
    payloadDigest,
    payload: deepFreeze(log),
    integrity: deepFreeze({
      algorithm: "hmac-sha256" as const,
      keyId,
      signature
    })
  });
}

function validateLog(log: ProviderUsageAttemptLog): TrustedProxyUsageAssociation {
  if (!isRecord(log) || !isRecord(log.usageAttempt)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal payload is not an attempt log"
    );
  }
  const association = log.trustedAssociation;
  if (
    !association ||
    association.schemaVersion !== 1 ||
    association.issuer !== "mn-api" ||
    typeof association.reservationId !== "string" ||
    !association.reservationId ||
    log.runId !== association.runId ||
    log.candidateId !== association.candidateId ||
    log.usageAttempt.schemaVersion !== 1 ||
    log.usageAttempt.logicalRequestId !== association.reservationId
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal payload has invalid trusted bindings"
    );
  }
  const logFields = new Set([
    "app",
    "authoritativeCostUsd",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "cachedInputTokens",
    "candidateId",
    "containsToolCall",
    "createdAt",
    "id",
    "inputTokens",
    "latencyMs",
    "model",
    "outputTokens",
    "providerId",
    "reasoningOutputTokens",
    "replayed",
    "runId",
    "statusCode",
    "toolCalls",
    "trustedAssociation",
    "usageAttempt"
  ]);
  if (Object.keys(log).some((field) => !logFields.has(field))) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal payload contains unsupported fields"
    );
  }
  const attemptFields = [
    "index",
    "logicalRequestId",
    "outcome",
    "retryable",
    "schemaVersion",
    "terminal"
  ];
  if (
    JSON.stringify(Object.keys(log.usageAttempt).sort()) !==
      JSON.stringify(attemptFields)
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal attempt contains unsupported fields"
    );
  }
  const associationFields = [
    "candidateId",
    "claimDigest",
    "expiresAt",
    "issuedAt",
    "issuer",
    ...(association.providerPlan === undefined ? [] : ["providerPlan"]),
    "receiptDigest",
    "reservationId",
    "runId",
    "schemaVersion",
    "tenantId",
    "verifiedAt",
    "workerId"
  ];
  if (
    JSON.stringify(Object.keys(association).sort()) !==
      JSON.stringify(associationFields)
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal association contains unsupported fields"
    );
  }
  if (association.providerPlan !== undefined) {
    if (!isRecord(association.providerPlan)) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal provider plan is invalid"
      );
    }
    exactFields(
      association.providerPlan,
      ["app", "digest", "projectId", "providerIds", "schemaVersion"],
      "provider usage journal provider plan"
    );
    if (
      association.providerPlan.schemaVersion !== 1 ||
      (association.providerPlan.app !== "claude" && association.providerPlan.app !== "codex") ||
      !Array.isArray(association.providerPlan.providerIds) ||
      association.providerPlan.providerIds.length === 0
    ) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal provider plan is invalid"
      );
    }
    identifier(association.providerPlan.projectId, "providerPlan.projectId");
    digest(association.providerPlan.digest, "providerPlan.digest");
    const providerIds = association.providerPlan.providerIds.map((providerId, index) =>
      identifier(providerId, `providerPlan.providerIds[${index}]`)
    );
    if (new Set(providerIds).size !== providerIds.length) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal provider plan contains duplicate providers"
      );
    }
  }
  const attemptIndex = positiveInteger(log.usageAttempt.index, "usageAttempt.index");
  if (attemptIndex > 1_000) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal usageAttempt.index exceeds the supported limit"
    );
  }
  if (log.id !== providerUsageAttemptLogId(association.reservationId, attemptIndex)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal payload has no stable request id"
    );
  }
  for (const [field, value] of [
    ["tenantId", association.tenantId],
    ["runId", association.runId],
    ["candidateId", association.candidateId],
    ["workerId", association.workerId],
    ["reservationId", association.reservationId],
    ["requestId", log.id]
  ] as const) {
    identifier(value, field);
  }
  identifier(log.providerId, "providerId");
  identifier(log.model, "model");
  if (log.app !== "claude" && log.app !== "codex") {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal app is invalid"
    );
  }
  if (log.replayed !== undefined && typeof log.replayed !== "boolean") {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal replayed flag is invalid"
    );
  }
  if (
    log.containsToolCall !== undefined &&
    typeof log.containsToolCall !== "boolean"
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal containsToolCall flag is invalid"
    );
  }
  if (log.toolCalls !== undefined) {
    if (
      !Array.isArray(log.toolCalls) ||
      log.toolCalls.length === 0 ||
      log.toolCalls.length > 256 ||
      log.containsToolCall !== true
    ) {
      throw new ProviderUsageTerminalJournalIntegrityError(
        "provider usage journal toolCalls are inconsistent"
      );
    }
    for (const toolCall of log.toolCalls as unknown[]) {
      if (
        !isRecord(toolCall) ||
        JSON.stringify(Object.keys(toolCall).sort()) !==
          JSON.stringify(["effect", "name", "replaySafe"])
      ) {
        throw new ProviderUsageTerminalJournalIntegrityError(
          "provider usage journal toolCall contains unsupported fields"
        );
      }
      checkpointText(toolCall.name, "toolCall.name", 256);
      if (
        toolCall.effect !== "readonly" &&
        toolCall.effect !== "idempotent" &&
        toolCall.effect !== "side_effect" &&
        toolCall.effect !== "unknown"
      ) {
        throw new ProviderUsageTerminalJournalIntegrityError(
          "provider usage journal toolCall effect is invalid"
        );
      }
      if (typeof toolCall.replaySafe !== "boolean") {
        throw new ProviderUsageTerminalJournalIntegrityError(
          "provider usage journal toolCall replaySafe flag is invalid"
        );
      }
    }
  } else if (log.containsToolCall === true) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal containsToolCall requires toolCalls"
    );
  }
  if (log.containsToolCall === false && log.toolCalls !== undefined) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal containsToolCall conflicts with toolCalls"
    );
  }
  const tokenFields = [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "reasoningOutputTokens"
  ] as const;
  nonNegativeInteger(log.inputTokens, "inputTokens");
  nonNegativeInteger(log.outputTokens, "outputTokens");
  for (const field of tokenFields) {
    const value = log[field];
    if (value !== undefined) nonNegativeInteger(value, field);
  }
  nonNegativeInteger(log.statusCode, "statusCode");
  if (log.statusCode < 100 || log.statusCode > 999) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal statusCode is invalid"
    );
  }
  nonNegativeInteger(log.latencyMs, "latencyMs");
  if (
    log.authoritativeCostUsd !== undefined &&
    (!Number.isFinite(log.authoritativeCostUsd) || log.authoritativeCostUsd < 0)
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal authoritativeCostUsd is invalid"
    );
  }
  canonicalTimestamp(log.createdAt, "createdAt");
  const issuedAt = canonicalTimestamp(association.issuedAt, "association.issuedAt");
  const verifiedAt = canonicalTimestamp(
    association.verifiedAt,
    "association.verifiedAt"
  );
  const expiresAt = canonicalTimestamp(association.expiresAt, "association.expiresAt");
  if (verifiedAt < issuedAt || verifiedAt >= expiresAt) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal association timestamps are inconsistent"
    );
  }
  digest(association.claimDigest, "association.claimDigest");
  digest(association.receiptDigest, "association.receiptDigest");
  if (
    typeof log.usageAttempt.terminal !== "boolean" ||
    typeof log.usageAttempt.retryable !== "boolean" ||
    (log.usageAttempt.outcome !== "succeeded" &&
      log.usageAttempt.outcome !== "failed") ||
    (!log.usageAttempt.terminal &&
      (log.usageAttempt.outcome !== "failed" || !log.usageAttempt.retryable)) ||
    (log.usageAttempt.outcome === "succeeded" &&
      (!log.usageAttempt.terminal ||
        log.usageAttempt.retryable ||
        log.statusCode < 200 ||
        log.statusCode >= 400))
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal attempt state is invalid"
    );
  }
  if (
    log.replayed === true &&
    ([...tokenFields.map((field) => log[field] ?? 0), log.authoritativeCostUsd ?? 0]
      .some((value) => value !== 0))
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      "provider usage journal replay contains supplier usage"
    );
  }
  return association;
}

function journalRef(
  bucket: string,
  objectKey: string,
  bytes: Buffer,
  envelope: ProviderUsageTerminalJournalEnvelope
): ProviderUsageTerminalJournalRef {
  return deepFreeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    objectKey,
    uri: `s3://${bucket}/${objectKey}`,
    digest: sha256(bytes),
    payloadDigest: envelope.payloadDigest,
    byteLength: bytes.byteLength,
    integrityKeyId: envelope.integrity.keyId
  });
}

function normalizeIntegrityProfile(
  value: ProviderUsageTerminalJournalIntegrityProfile
): NormalizedIntegrityProfile {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw new TypeError("provider usage journal integrity profile is required");
  }
  const activeKeyId = plainIdentifier(value.activeKeyId, "activeKeyId");
  const keys = new Map<
    string,
    Readonly<{ secret: Buffer; status: ProviderUsageTerminalJournalIntegrityKeyStatus }>
  >();
  const secretFingerprints = new Set<string>();
  let activeKeyCount = 0;
  for (const raw of value.keys) {
    if (!isRecord(raw)) {
      throw new TypeError("provider usage journal integrity key is invalid");
    }
    if (
      JSON.stringify(Object.keys(raw).sort()) !==
      JSON.stringify(["id", "secret", "status"])
    ) {
      throw new TypeError(
        "provider usage journal integrity key fields and status must be explicit"
      );
    }
    const id = plainIdentifier(raw.id, "key.id");
    if (keys.has(id)) {
      throw new TypeError("provider usage journal integrity key ids must be unique");
    }
    if (typeof raw.secret !== "string" || Buffer.byteLength(raw.secret, "utf8") < 32) {
      throw new TypeError(
        "provider usage journal integrity key must contain at least 32 bytes"
      );
    }
    const status = raw.status;
    if (status !== "active" && status !== "retired" && status !== "revoked") {
      throw new TypeError("provider usage journal integrity key status is invalid");
    }
    if (status === "active") activeKeyCount += 1;
    const secret = Buffer.from(raw.secret, "utf8");
    const fingerprint = sha256(secret);
    if (secretFingerprints.has(fingerprint)) {
      throw new TypeError(
        "provider usage journal integrity keys must not alias the same secret"
      );
    }
    secretFingerprints.add(fingerprint);
    keys.set(id, Object.freeze({
      secret,
      status
    }));
  }
  const active = keys.get(activeKeyId);
  if (!active || active.status !== "active" || activeKeyCount !== 1) {
    throw new TypeError(
      "provider usage journal profile must contain exactly its declared active key"
    );
  }
  return Object.freeze({ activeKeyId, keys });
}

function hmacSignature(
  envelope: UnsignedProviderUsageTerminalJournalEnvelope,
  authentication: ProviderUsageTerminalJournalAuthentication,
  secret: Buffer
): string {
  return createHmac("sha256", secret)
    .update(JOURNAL_SIGNATURE_DOMAIN)
    .update(canonicalJson({ authentication, envelope }))
    .digest("base64url");
}

function canonicalBase64Url(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `provider usage journal ${field} is invalid`
    );
  }
  return value;
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes);
}

function plainIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    throw new TypeError(`provider usage journal integrity ${field} is invalid`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `provider usage journal ${field} is invalid`
    );
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `provider usage journal ${field} is invalid`
    );
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `provider usage journal ${field} is invalid`
    );
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `provider usage journal ${field} is invalid`
    );
  }
  return Number(value);
}

function canonicalTimestamp(value: unknown, field: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `provider usage journal ${field} is invalid`
    );
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `provider usage journal ${field} is invalid`
    );
  }
  return milliseconds;
}

function canonicalTimestampText(value: unknown, field: string): string {
  canonicalTimestamp(value, field);
  return value as string;
}

function checkpointText(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ProviderUsageTerminalJournalIntegrityError(
      `provider usage journal ${field} is invalid`
    );
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (
    value === null ||
    typeof value !== "object" ||
    Buffer.isBuffer(value) ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function normalizePrefix(value: string | undefined): string {
  const prefix = value?.replace(/^\/+|\/+$/gu, "") ?? "";
  if (!prefix) return "";
  if (
    prefix.split("/").some((part) =>
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) ||
      part === "." ||
      part === ".."
    )
  ) {
    throw new TypeError("provider usage journal prefix is unsafe");
  }
  return prefix;
}

function joinKey(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
