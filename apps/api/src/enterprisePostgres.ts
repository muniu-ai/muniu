import {
  createHash,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { sha256Canonical } from "@mn/governance";
import type {
  PreparedProviderUsageIntent,
  ProviderUsageAttemptLog,
  ProviderUsageDispatchIntent,
  ProviderUsageReservationDecision,
  ProviderUsageReservationResult,
  ProviderUsageUnknownIntent
} from "@mn/local-proxy";
import {
  providerUsageAttemptLogId,
  providerUsageResolutionLogId
} from "@mn/local-proxy";
import type {
  ProxyRequestLog,
  TrustedProxyUsageAssociation
} from "@mn/provider-catalog";
import {
  normalizeWorkerCapabilities,
  normalizeWorkerRequirements,
  workerCapabilityDigest,
  workerRequirementsDigest,
  workerSatisfiesRequirements,
  type PartialWorkerCapabilitySet,
  type PartialWorkerRequirements,
  type RunJobQueueItem,
  type RunJobQueueStatus,
  type WorkerRequirements
} from "./runJobQueue.js";
import type { AuditEvent } from "./store.js";
import type { ProviderUsageTerminalJournalRef } from "./providerUsageTerminalJournal.js";

export interface EnterprisePostgresOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly applicationName?: string;
  readonly maxConnections?: number;
}

export interface EnterpriseRunJobInput {
  readonly runId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly priority?: number;
  readonly requirements?: PartialWorkerRequirements;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadataRecords?: readonly EnterpriseMetadataWrite[];
  readonly auditEvent?: AuditEvent;
  readonly now?: string;
}

export interface EnterpriseClaimInput {
  readonly ownerId: string;
  readonly capabilities: PartialWorkerCapabilitySet;
  readonly ttlMs?: number;
  readonly now?: string;
}

export interface EnterpriseClaim {
  readonly item: RunJobQueueItem;
  readonly claimToken: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly checkpointDigest: string | null;
}

export interface EnterpriseClaimSnapshot {
  readonly item: RunJobQueueItem;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly checkpointDigest: string | null;
}

export interface EnterpriseStateSnapshot {
  readonly metadata: EnterpriseMetadataRecord[];
  readonly runJobs: Array<{
    readonly item: RunJobQueueItem;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly checkpointDigest: string | null;
  }>;
  readonly auditEvents: AuditEvent[];
}

/** Append-only reservation that has not yet acquired a terminal usage attempt.
 * Expiry or claim reclaim never turns this state into zero usage. */
export interface PendingProviderUsageReservation {
  readonly schemaVersion: 1;
  readonly status: "pending";
  readonly tenantId: string;
  readonly reservationId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly workerId: string;
  readonly claimDigest: string;
  readonly receiptDigest: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

/** Append-only reservation whose terminal attempt is durably recorded. */
export interface FinalizedProviderUsageReservation {
  readonly schemaVersion: 1;
  readonly status: "finalized";
  readonly tenantId: string;
  readonly reservationId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly workerId: string;
  readonly claimDigest: string;
  readonly receiptDigest: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

export interface ProviderUsageAccountingSnapshot {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly runId: string;
  readonly usageLogs: readonly ProxyRequestLog[];
  readonly pendingReservations: readonly PendingProviderUsageReservation[];
  readonly finalizedReservations: readonly FinalizedProviderUsageReservation[];
}

export interface ProviderUsageAccountingQuerySnapshot {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly usageLogs: readonly ProxyRequestLog[];
  readonly pendingReservations: readonly PendingProviderUsageReservation[];
  readonly pendingReservationCount: number;
}

export type ProviderUsageLifecycleEventType =
  | "prepared"
  | "attempt_dispatch_started"
  | "attempt_unknown"
  | "attempt_terminal"
  | "request_terminal"
  | "pre_dispatch_recovered"
  | "reconciled";

export interface ProviderUsageLifecycleEvent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly tenantId: string;
  readonly reservationId: string;
  readonly logicalRequestId: string;
  readonly index: number;
  readonly type: ProviderUsageLifecycleEventType;
  readonly attemptIndex?: number;
  readonly idempotencyKeyDigest?: string;
  readonly digest: string;
  readonly createdAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ProviderUsageRequestSnapshot {
  readonly schemaVersion: 1;
  readonly legacy: boolean;
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalRequestId: string;
  readonly reservationId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly status: "pending" | "finalized";
  readonly prepared?: PreparedProviderUsageIntent;
  readonly lifecycle: readonly ProviderUsageLifecycleEvent[];
  readonly usageLogs: readonly ProxyRequestLog[];
  readonly recoveryDigest: string;
}

export interface ProviderUsageReconciliationEvidence {
  readonly uri: string;
  readonly sha256: string;
  readonly kind: "provider" | "invoice";
  readonly verification: Readonly<{
    objectKey: string;
    byteLength: number;
    verifiedAt: string;
    verificationDigest: string;
    envelopeDigest?: string;
    sourceReference?: string;
    issuedAt?: string;
    issuer?: string;
    keyId?: string;
    signatureDigest?: string;
    providerAccountId?: string;
    providerRequestId?: string;
    dispatchRequestDigest?: string;
    outboundRequestKeyDigest?: string;
  }>;
}

export type ProviderUsageReconciliationDecision =
  | Readonly<{
      kind: "exact";
      app: "claude" | "codex";
      providerId: string;
      model: string;
      statusCode: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      reasoningOutputTokens?: number;
      authoritativeCostUsd: number;
    }>
  | Readonly<{ kind: "conservative" }>;

export interface ReconcileProviderUsageRequestInput {
  readonly tenantId: string;
  readonly logicalRequestId: string;
  readonly projectIds?: readonly string[];
  readonly expectedRecoveryDigest: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly traceId: string;
  readonly reason: string;
  readonly ticket: string;
  readonly evidence: ProviderUsageReconciliationEvidence;
  readonly decision: ProviderUsageReconciliationDecision;
  readonly now?: string;
}

export interface ProviderUsageReconciliationResult {
  readonly request: ProviderUsageRequestSnapshot;
  readonly auditEvent: AuditEvent;
}

export type ProviderUsageReconciliationConflictCode =
  | "cas_conflict"
  | "idempotency_conflict"
  | "already_terminal"
  | "machine_recovery_required"
  | "no_unresolved_dispatch"
  | "provider_mismatch";

export class ProviderUsageReconciliationConflictError extends Error {
  constructor(
    readonly code: ProviderUsageReconciliationConflictCode,
    readonly safeMessage: string
  ) {
    super(safeMessage);
    this.name = "ProviderUsageReconciliationConflictError";
  }
}

export class PendingProviderUsageReservationsError extends Error {
  readonly tenantId: string;
  readonly runId: string;
  readonly reservationIds: readonly string[];

  constructor(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly reservationIds: readonly string[];
  }) {
    const reservationIds = Object.freeze([...input.reservationIds].sort());
    super(
      `provider usage accounting has ${reservationIds.length} pending reservation(s) for tenant ${input.tenantId} run ${input.runId}`
    );
    this.name = "PendingProviderUsageReservationsError";
    this.tenantId = input.tenantId;
    this.runId = input.runId;
    this.reservationIds = reservationIds;
  }
}

export function assertProviderUsageAccountingFinalized(
  snapshot: ProviderUsageAccountingSnapshot
): void {
  if (snapshot.pendingReservations.length === 0) return;
  throw new PendingProviderUsageReservationsError({
    tenantId: snapshot.tenantId,
    runId: snapshot.runId,
    reservationIds: snapshot.pendingReservations.map(
      (reservation) => reservation.reservationId
    )
  });
}

async function assertNoPendingProviderUsageReservations(
  client: PoolClient,
  tenantId: string,
  runId: string
): Promise<void> {
  const pending = await pendingProviderUsageReservations(client, tenantId, runId);
  if (pending.length === 0) return;
  throw new PendingProviderUsageReservationsError({
    tenantId,
    runId,
    reservationIds: pending.map((reservation) => reservation.reservationId)
  });
}

async function pendingProviderUsageReservations(
  client: PoolClient,
  tenantId: string,
  runId: string
): Promise<PendingProviderUsageReservation[]> {
  const rows = await client.query<PendingProviderUsageReservationRow>(`
    SELECT
      r.reservation_id,r.tenant_id,r.run_id,r.candidate_id,r.worker_id,
      r.claim_token_hash,r.receipt_digest,r.verified_at,r.expires_at
    FROM mn_provider_usage_reservations r
    WHERE r.tenant_id=$1 AND r.run_id=$2
      AND NOT EXISTS (
        SELECT 1 FROM mn_provider_usage u
        WHERE u.tenant_id=r.tenant_id
          AND u.run_id=r.run_id
          AND u.reservation_id=r.reservation_id
          AND u.reservation_finalized
      )
    ORDER BY r.verified_at,r.reservation_id
  `, [identifier(tenantId, "usage.tenantId"), identifier(runId, "usage.runId")]);
  return rows.rows.map((row) => Object.freeze({
    schemaVersion: 1 as const,
    status: "pending" as const,
    tenantId: row.tenant_id,
    reservationId: row.reservation_id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    workerId: row.worker_id,
    claimDigest: row.claim_token_hash,
    receiptDigest: row.receipt_digest,
    verifiedAt: row.verified_at.toISOString(),
    expiresAt: row.expires_at.toISOString()
  }));
}

async function finalizedProviderUsageReservations(
  client: PoolClient,
  tenantId: string,
  runId: string
): Promise<FinalizedProviderUsageReservation[]> {
  const rows = await client.query<FinalizedProviderUsageReservationRow>(`
    SELECT
      r.reservation_id,r.tenant_id,r.run_id,r.candidate_id,r.worker_id,
      r.claim_token_hash,r.receipt_digest,r.verified_at,r.expires_at,
      u.request_id
    FROM mn_provider_usage_reservations r
    INNER JOIN mn_provider_usage u
      ON u.tenant_id=r.tenant_id
      AND u.run_id=r.run_id
      AND u.reservation_id=r.reservation_id
      AND u.reservation_finalized
    WHERE r.tenant_id=$1 AND r.run_id=$2
    ORDER BY r.verified_at,r.reservation_id
  `, [identifier(tenantId, "usage.tenantId"), identifier(runId, "usage.runId")]);
  return rows.rows.map((row) => Object.freeze({
    schemaVersion: 1 as const,
    status: "finalized" as const,
    tenantId: row.tenant_id,
    reservationId: row.reservation_id,
    requestId: row.request_id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    workerId: row.worker_id,
    claimDigest: row.claim_token_hash,
    receiptDigest: row.receipt_digest,
    verifiedAt: row.verified_at.toISOString(),
    expiresAt: row.expires_at.toISOString()
  }));
}

export type EnterpriseRunJobListStatus = RunJobQueueStatus | "claimable";

export interface EnterpriseMetadataRecord {
  readonly tenantId: string;
  readonly kind: string;
  readonly id: string;
  readonly version: number;
  readonly digest: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnterpriseMetadataWrite {
  readonly tenantId: string;
  readonly kind: string;
  readonly id: string;
  readonly digest: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface RunJobRow {
  run_id: string;
  tenant_id: string;
  project_id: string;
  task_id: string;
  status: RunJobQueueStatus;
  priority: number;
  attempt: number;
  requirements: WorkerRequirements;
  requirements_digest: string;
  payload: Record<string, unknown>;
  checkpoint_digest: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  owner_id: string | null;
  claim_token_hash: string | null;
  claim_binding_digest: string | null;
  worker_capability_digest: string | null;
  claimed_at: Date | null;
  claim_expires_at: Date | null;
  heartbeat_at: Date | null;
}

interface PendingProviderUsageReservationRow {
  reservation_id: string;
  tenant_id: string;
  run_id: string;
  candidate_id: string;
  worker_id: string;
  claim_token_hash: string;
  receipt_digest: string;
  verified_at: Date;
  expires_at: Date;
  logical_request_id: string | null;
  request_digest: string | null;
  provider_plan_digest: string | null;
  caller_idempotency_key_digest: string | null;
  provider_idempotency_strength: "none" | "strong" | null;
  first_outbound_header_name: string | null;
  first_outbound_key_digest: string | null;
  prepared_at: Date | null;
  conservative_hold: PreparedProviderUsageIntent["conservativeHold"] | null;
  payload: TrustedProxyUsageAssociation;
}

interface FinalizedProviderUsageReservationRow
  extends PendingProviderUsageReservationRow {
  request_id: string;
}

interface ProviderUsageAttemptRow {
  request_id: string;
  logical_request_id: string;
  attempt_index: number;
  reservation_finalized: boolean;
  payload: ProxyRequestLog;
  terminal_journal: ProviderUsageTerminalJournalRef | null;
}

interface PendingProviderUsageReservationQueryRow
  extends PendingProviderUsageReservationRow {
  pending_count: string;
}

interface ProviderUsageLifecycleRow {
  event_id: string;
  tenant_id: string;
  reservation_id: string;
  logical_request_id: string;
  event_index: number;
  event_type: ProviderUsageLifecycleEventType;
  attempt_index: number | null;
  idempotency_key_digest: string | null;
  event_digest: string;
  created_at: Date;
  payload: Record<string, unknown>;
}

interface ProviderUsageRequestRow extends PendingProviderUsageReservationRow {
  project_id: string;
}

const TERMINAL = new Set<RunJobQueueStatus>(["completed", "failed", "cancelled"]);

function timestamp(value: string | undefined, field: string): string {
  const candidate = value ?? new Date().toISOString();
  const date = new Date(candidate);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== candidate) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return candidate;
}

function identifier(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function managedAgentApp(value: unknown, field: string): "claude" | "codex" {
  if (value !== "claude" && value !== "codex") {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function usageQueryLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("usage.limit must be an integer between 1 and 500");
  }
  return limit;
}

function normalizeProviderUsageAttempt(
  log: ProxyRequestLog | ProviderUsageAttemptLog
): ProviderUsageAttemptLog["usageAttempt"] {
  const attempt = (log as Partial<ProviderUsageAttemptLog>).usageAttempt;
  if (attempt === undefined) {
    // v1 callers emitted one log per reservation. Preserve that behavior as a
    // single terminal attempt while all new proxy traffic uses explicit v2
    // attempt metadata.
    return Object.freeze({
      schemaVersion: 1 as const,
      logicalRequestId: identifier(log.id, "usage.logicalRequestId"),
      index: 1,
      terminal: true,
      outcome: log.statusCode >= 200 && log.statusCode < 400
        ? "succeeded" as const
        : "failed" as const,
      retryable: false
    });
  }
  const logicalRequestId = identifier(
    attempt.logicalRequestId,
    "usage.logicalRequestId"
  );
  if (
    attempt.schemaVersion !== 1 ||
    !Number.isSafeInteger(attempt.index) ||
    attempt.index < 1 ||
    attempt.index > 1_000 ||
    typeof attempt.terminal !== "boolean" ||
    (attempt.outcome !== "succeeded" && attempt.outcome !== "failed") ||
    typeof attempt.retryable !== "boolean" ||
    (!attempt.terminal && !attempt.retryable) ||
    (!attempt.terminal && attempt.outcome === "succeeded")
  ) {
    throw new TypeError("enterprise provider usage attempt is inconsistent");
  }
  return Object.freeze({ ...attempt, logicalRequestId });
}

function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

function optionalDigest(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : digest(value, field);
}

function nonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function preparedProviderUsageIntent(
  value: PreparedProviderUsageIntent
): PreparedProviderUsageIntent {
  const preparedAt = timestamp(value.preparedAt, "usage.preparedAt");
  const logicalRequestId = identifier(
    value.logicalRequestId,
    "usage.logicalRequestId"
  );
  if (
    value.schemaVersion !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      logicalRequestId
    ) ||
    (value.app !== "claude" && value.app !== "codex")
  ) {
    throw new TypeError("provider usage preparation identity is invalid");
  }
  const hold = Object.freeze({
    maxTokens: nonNegativeInteger(
      value.conservativeHold.maxTokens,
      "usage.conservativeHold.maxTokens"
    ),
    maxCostUsd: nonNegativeFinite(
      value.conservativeHold.maxCostUsd,
      "usage.conservativeHold.maxCostUsd"
    ),
    basisDigest: digest(
      value.conservativeHold.basisDigest,
      "usage.conservativeHold.basisDigest"
    )
  });
  const providerIdempotencyStrength = value.providerIdempotencyStrength;
  if (
    providerIdempotencyStrength !== undefined &&
    providerIdempotencyStrength !== "none" &&
    providerIdempotencyStrength !== "strong"
  ) {
    throw new TypeError("provider usage idempotency strength is invalid");
  }
  const firstOutboundIdempotencyHeaderName =
    value.firstOutboundIdempotencyHeaderName === undefined
      ? undefined
      : identifier(
          value.firstOutboundIdempotencyHeaderName,
          "usage.firstOutboundIdempotencyHeaderName"
        );
  const firstOutboundIdempotencyKeyDigest = optionalDigest(
    value.firstOutboundIdempotencyKeyDigest,
    "usage.firstOutboundIdempotencyKeyDigest"
  );
  if (
    (firstOutboundIdempotencyHeaderName !== undefined &&
      firstOutboundIdempotencyKeyDigest === undefined) ||
    (providerIdempotencyStrength === "strong" &&
      (firstOutboundIdempotencyHeaderName === undefined ||
        firstOutboundIdempotencyKeyDigest === undefined))
  ) {
    throw new TypeError("provider usage outbound idempotency evidence is inconsistent");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    logicalRequestId,
    app: value.app,
    model: identifier(value.model, "usage.model"),
    requestDigest: digest(value.requestDigest, "usage.requestDigest"),
    providerPlanDigest: digest(
      value.providerPlanDigest,
      "usage.providerPlanDigest"
    ),
    ...(value.callerIdempotencyKeyDigest
      ? {
          callerIdempotencyKeyDigest: digest(
            value.callerIdempotencyKeyDigest,
            "usage.callerIdempotencyKeyDigest"
          )
        }
      : {}),
    ...(providerIdempotencyStrength ? { providerIdempotencyStrength } : {}),
    ...(firstOutboundIdempotencyHeaderName
      ? { firstOutboundIdempotencyHeaderName }
      : {}),
    ...(firstOutboundIdempotencyKeyDigest
      ? { firstOutboundIdempotencyKeyDigest }
      : {}),
    preparedAt,
    conservativeHold: hold
  });
}

function providerUsageDispatchIntent(
  value: ProviderUsageDispatchIntent
): ProviderUsageDispatchIntent {
  const providerId = identifier(value.providerId, "usage.providerId");
  const providerAccountId = identifier(
    value.providerAccountId ?? providerId,
    "usage.providerAccountId"
  );
  const providerIdempotencyStrength = value.providerIdempotencyStrength;
  if (
    providerIdempotencyStrength !== undefined &&
    providerIdempotencyStrength !== "none" &&
    providerIdempotencyStrength !== "strong"
  ) {
    throw new TypeError("provider dispatch idempotency strength is invalid");
  }
  const outboundIdempotencyHeaderName =
    value.outboundIdempotencyHeaderName === undefined
      ? undefined
      : identifier(
          value.outboundIdempotencyHeaderName,
          "usage.outboundIdempotencyHeaderName"
        );
  const outboundIdempotencyKeyDigest = optionalDigest(
    value.outboundRequestKeyDigest ?? value.outboundIdempotencyKeyDigest,
    "usage.outboundRequestKeyDigest"
  );
  if (
    value.outboundRequestKeyDigest !== undefined &&
    value.outboundIdempotencyKeyDigest !== undefined &&
    value.outboundRequestKeyDigest !== value.outboundIdempotencyKeyDigest
  ) {
    throw new TypeError("provider dispatch outbound key digest aliases conflict");
  }
  if (
    (outboundIdempotencyHeaderName !== undefined &&
      outboundIdempotencyKeyDigest === undefined) ||
    (providerIdempotencyStrength === "strong" &&
      (outboundIdempotencyHeaderName === undefined ||
        outboundIdempotencyKeyDigest === undefined))
  ) {
    throw new TypeError("provider dispatch outbound idempotency evidence is inconsistent");
  }
  const intent = Object.freeze({
    schemaVersion: value.schemaVersion,
    logicalRequestId: identifier(value.logicalRequestId, "usage.logicalRequestId"),
    attemptIndex: value.attemptIndex,
    providerId,
    providerAccountId,
    model: identifier(value.model, "usage.model"),
    requestDigest: digest(value.requestDigest, "usage.requestDigest"),
    ...(providerIdempotencyStrength ? { providerIdempotencyStrength } : {}),
    ...(outboundIdempotencyHeaderName ? { outboundIdempotencyHeaderName } : {}),
    ...(outboundIdempotencyKeyDigest
      ? {
          outboundRequestKeyDigest: outboundIdempotencyKeyDigest,
          outboundIdempotencyKeyDigest
        }
      : {}),
    startedAt: timestamp(value.startedAt, "usage.dispatch.startedAt")
  });
  if (
    intent.schemaVersion !== 1 ||
    !Number.isSafeInteger(intent.attemptIndex) ||
    intent.attemptIndex < 1 ||
    intent.attemptIndex > 1_000
  ) {
    throw new TypeError("enterprise provider dispatch intent is inconsistent");
  }
  return intent;
}

function providerUsageLifecycleEvent(row: ProviderUsageLifecycleRow): ProviderUsageLifecycleEvent {
  return Object.freeze({
    schemaVersion: 1 as const,
    id: row.event_id,
    tenantId: row.tenant_id,
    reservationId: row.reservation_id,
    logicalRequestId: row.logical_request_id,
    index: row.event_index,
    type: row.event_type,
    ...(row.attempt_index === null ? {} : { attemptIndex: row.attempt_index }),
    ...(row.idempotency_key_digest === null
      ? {}
      : { idempotencyKeyDigest: row.idempotency_key_digest }),
    digest: row.event_digest,
    createdAt: row.created_at.toISOString(),
    payload: row.payload
  });
}

function providerUsageLifecycleId(
  logicalRequestId: string,
  type: ProviderUsageLifecycleEventType,
  suffix: string
): string {
  return `mn-usage-event-${sha256(`${logicalRequestId}\0${type}\0${suffix}`)}`;
}

function deterministicUuid(value: string): string {
  const hash = sha256(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function claimTtl(value: number | undefined): number {
  const ttlMs = value ?? 30_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) {
    throw new TypeError("ttlMs must be between 1000 and 86400000");
  }
  return ttlMs;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeTokenEqual(actual: string, expectedHash: string): boolean {
  const actualHash = Buffer.from(sha256(actual), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actualHash.length === expected.length && timingSafeEqual(actualHash, expected);
}

function itemFromRow(row: RunJobRow): RunJobQueueItem {
  return {
    version: 2,
    runId: row.run_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    taskId: row.task_id,
    status: row.status,
    priority: row.priority,
    attempt: row.attempt,
    recovered: row.attempt > 1,
    requirements: row.requirements,
    requirementsDigest: row.requirements_digest,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    ...(row.claim_token_hash ? { claimTokenHash: row.claim_token_hash } : {}),
    ...(row.claim_binding_digest
      ? { claimBindingDigest: row.claim_binding_digest }
      : {}),
    ...(row.worker_capability_digest
      ? { workerCapabilityDigest: row.worker_capability_digest }
      : {}),
    ...(row.claimed_at ? { claimedAt: row.claimed_at.toISOString() } : {}),
    ...(row.claim_expires_at
      ? { claimExpiresAt: row.claim_expires_at.toISOString() }
      : {}),
    ...(row.heartbeat_at ? { heartbeatAt: row.heartbeat_at.toISOString() } : {})
  };
}

function metadataFromRow(row: {
  tenant_id: string;
  kind: string;
  id: string;
  version: string;
  digest: string;
  payload: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}): EnterpriseMetadataRecord {
  if (sha256Canonical(row.payload) !== row.digest) {
    throw new Error(`Enterprise metadata digest mismatch for ${row.kind}/${row.id}`);
  }
  return {
    tenantId: row.tenant_id,
    kind: row.kind,
    id: row.id,
    version: Number(row.version),
    digest: row.digest,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function assertCheckpointIntegrity(row: RunJobRow): void {
  if (
    row.checkpoint_digest !== null &&
    sha256Canonical(row.payload) !== row.checkpoint_digest
  ) {
    throw new Error(`Enterprise run checkpoint digest mismatch for ${row.run_id}`);
  }
}

export class EnterprisePostgresRuntime {
  readonly pool: Pool;
  readonly #ownsPool: boolean;

  constructor(options: EnterprisePostgresOptions) {
    if (!options.pool && !options.connectionString) {
      throw new TypeError("Enterprise PostgreSQL requires a pool or connectionString");
    }
    this.#ownsPool = options.pool === undefined;
    const config: PoolConfig = {
      connectionString: options.connectionString,
      application_name: options.applicationName ?? "mn-enterprise",
      max: options.maxConnections ?? 10
    };
    this.pool = options.pool ?? new Pool(config);
  }

  async migrate(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS mn_metadata (
          tenant_id text NOT NULL,
          kind text NOT NULL,
          id text NOT NULL,
          version bigint NOT NULL CHECK (version > 0),
          digest char(64) NOT NULL,
          payload jsonb NOT NULL,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          PRIMARY KEY (tenant_id, kind, id)
        );
        CREATE TABLE IF NOT EXISTS mn_health_probe (
          id smallint PRIMARY KEY CHECK (id = 1),
          checked_at timestamptz NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mn_run_jobs (
          run_id text PRIMARY KEY,
          tenant_id text NOT NULL,
          project_id text NOT NULL,
          task_id text NOT NULL,
          status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
          priority integer NOT NULL DEFAULT 0,
          attempt integer NOT NULL CHECK (attempt > 0),
          requirements jsonb NOT NULL,
          requirements_digest char(64) NOT NULL,
          payload jsonb NOT NULL,
          checkpoint_digest char(64),
          owner_id text,
          claim_token_hash char(64),
          claim_binding_digest char(64),
          worker_capability_digest char(64),
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          started_at timestamptz,
          finished_at timestamptz,
          claimed_at timestamptz,
          claim_expires_at timestamptz,
          heartbeat_at timestamptz
        );
        ALTER TABLE mn_run_jobs
          ADD COLUMN IF NOT EXISTS checkpoint_digest char(64);
        CREATE INDEX IF NOT EXISTS mn_run_jobs_claim_idx
          ON mn_run_jobs (status, priority DESC, created_at, run_id);
        CREATE TABLE IF NOT EXISTS mn_outbox (
          sequence bigserial PRIMARY KEY,
          id uuid NOT NULL UNIQUE,
          tenant_id text NOT NULL,
          aggregate_type text NOT NULL,
          aggregate_id text NOT NULL,
          event_type text NOT NULL,
          payload jsonb NOT NULL,
          created_at timestamptz NOT NULL,
          published_at timestamptz
        );
        CREATE TABLE IF NOT EXISTS mn_audit_events (
          id uuid PRIMARY KEY,
          tenant_id text NOT NULL,
          actor_id text NOT NULL,
          action text NOT NULL,
          resource_type text NOT NULL,
          resource_id text,
          project_id text,
          policy_decision text NOT NULL CHECK (policy_decision IN ('allow','deny')),
          before_digest char(64),
          after_digest char(64),
          pack_digest char(64),
          trace_id text NOT NULL,
          result text NOT NULL CHECK (result IN ('success','failure')),
          status_code integer NOT NULL,
          occurred_at timestamptz NOT NULL,
          payload jsonb NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mn_provider_usage_reservations (
          tenant_id text NOT NULL,
          reservation_id uuid NOT NULL,
          run_id text NOT NULL,
          candidate_id text NOT NULL,
          worker_id text NOT NULL,
          claim_token_hash char(64) NOT NULL,
          receipt_digest char(64) NOT NULL,
          verified_at timestamptz NOT NULL,
          expires_at timestamptz NOT NULL,
          payload jsonb NOT NULL,
          PRIMARY KEY (tenant_id, reservation_id)
        );
        ALTER TABLE mn_provider_usage_reservations
          ADD COLUMN IF NOT EXISTS logical_request_id text,
          ADD COLUMN IF NOT EXISTS request_digest char(64),
          ADD COLUMN IF NOT EXISTS provider_plan_digest char(64),
          ADD COLUMN IF NOT EXISTS caller_idempotency_key_digest char(64),
          ADD COLUMN IF NOT EXISTS provider_idempotency_strength text,
          ADD COLUMN IF NOT EXISTS first_outbound_header_name text,
          ADD COLUMN IF NOT EXISTS first_outbound_key_digest char(64),
          ADD COLUMN IF NOT EXISTS prepared_at timestamptz,
          ADD COLUMN IF NOT EXISTS conservative_hold jsonb;
        CREATE TABLE IF NOT EXISTS mn_provider_usage (
          tenant_id text NOT NULL,
          request_id text NOT NULL,
          run_id text NOT NULL,
          candidate_id text NOT NULL,
          worker_id text NOT NULL,
          claim_token_hash char(64) NOT NULL,
          receipt_digest char(64) NOT NULL,
          reservation_id uuid NOT NULL,
          logical_request_id text NOT NULL,
          attempt_index integer NOT NULL,
          reservation_finalized boolean NOT NULL,
          verified_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL,
          payload jsonb NOT NULL,
          PRIMARY KEY (tenant_id, request_id)
        );
        DROP TRIGGER IF EXISTS mn_provider_usage_no_update ON mn_provider_usage;
        ALTER TABLE mn_provider_usage
          ADD COLUMN IF NOT EXISTS reservation_id uuid,
          ADD COLUMN IF NOT EXISTS logical_request_id text,
          ADD COLUMN IF NOT EXISTS attempt_index integer,
          ADD COLUMN IF NOT EXISTS reservation_finalized boolean,
          ADD COLUMN IF NOT EXISTS terminal_journal jsonb;
        UPDATE mn_provider_usage SET
          logical_request_id=COALESCE(logical_request_id,request_id),
          attempt_index=COALESCE(attempt_index,1),
          reservation_finalized=COALESCE(reservation_finalized,TRUE)
        WHERE logical_request_id IS NULL
           OR attempt_index IS NULL
           OR reservation_finalized IS NULL;
        ALTER TABLE mn_provider_usage
          ALTER COLUMN logical_request_id SET NOT NULL,
          ALTER COLUMN attempt_index SET NOT NULL,
          ALTER COLUMN reservation_finalized SET NOT NULL;
        CREATE INDEX IF NOT EXISTS mn_provider_usage_run_idx
          ON mn_provider_usage (tenant_id, run_id, created_at, request_id);
        DROP INDEX IF EXISTS mn_provider_usage_reservation_idx;
        CREATE UNIQUE INDEX IF NOT EXISTS mn_provider_usage_attempt_idx
          ON mn_provider_usage
          (tenant_id,reservation_id,logical_request_id,attempt_index);
        CREATE UNIQUE INDEX IF NOT EXISTS mn_provider_usage_final_idx
          ON mn_provider_usage (tenant_id,reservation_id)
          WHERE reservation_finalized;
        CREATE INDEX IF NOT EXISTS mn_provider_usage_reservations_run_idx
          ON mn_provider_usage_reservations
          (tenant_id, run_id, verified_at, reservation_id);
        CREATE UNIQUE INDEX IF NOT EXISTS mn_provider_usage_logical_request_idx
          ON mn_provider_usage_reservations (tenant_id, logical_request_id)
          WHERE logical_request_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS mn_provider_usage_caller_key_idx
          ON mn_provider_usage_reservations (tenant_id, caller_idempotency_key_digest)
          WHERE caller_idempotency_key_digest IS NOT NULL;
        CREATE TABLE IF NOT EXISTS mn_provider_usage_lifecycle_events (
          tenant_id text NOT NULL,
          event_id text NOT NULL,
          reservation_id uuid NOT NULL,
          logical_request_id text NOT NULL,
          event_index integer NOT NULL CHECK (event_index > 0),
          event_type text NOT NULL CHECK (event_type IN (
            'prepared','attempt_dispatch_started','attempt_unknown','attempt_terminal',
            'request_terminal','pre_dispatch_recovered','reconciled'
          )),
          attempt_index integer,
          idempotency_key_digest char(64),
          event_digest char(64) NOT NULL,
          created_at timestamptz NOT NULL,
          payload jsonb NOT NULL,
          PRIMARY KEY (tenant_id,event_id),
          UNIQUE (tenant_id,reservation_id,event_index)
        );
        ALTER TABLE mn_provider_usage_lifecycle_events
          DROP CONSTRAINT IF EXISTS mn_provider_usage_lifecycle_events_event_type_check;
        ALTER TABLE mn_provider_usage_lifecycle_events
          ADD CONSTRAINT mn_provider_usage_lifecycle_events_event_type_check
          CHECK (event_type IN (
            'prepared','attempt_dispatch_started','attempt_unknown','attempt_terminal',
            'request_terminal','pre_dispatch_recovered','reconciled'
          ));
        CREATE INDEX IF NOT EXISTS mn_provider_usage_lifecycle_request_idx
          ON mn_provider_usage_lifecycle_events
          (tenant_id,logical_request_id,event_index,event_id);
        CREATE UNIQUE INDEX IF NOT EXISTS mn_provider_usage_reconcile_key_idx
          ON mn_provider_usage_lifecycle_events
          (tenant_id,reservation_id,idempotency_key_digest)
          WHERE idempotency_key_digest IS NOT NULL;
        CREATE OR REPLACE FUNCTION mn_reject_provider_usage_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'mn_provider_usage is append-only';
        END $$;
        DROP TRIGGER IF EXISTS mn_provider_usage_reservations_no_update
          ON mn_provider_usage_reservations;
        CREATE TRIGGER mn_provider_usage_reservations_no_update
          BEFORE UPDATE OR DELETE ON mn_provider_usage_reservations
          FOR EACH ROW EXECUTE FUNCTION mn_reject_provider_usage_mutation();
        DROP TRIGGER IF EXISTS mn_provider_usage_no_update ON mn_provider_usage;
        CREATE TRIGGER mn_provider_usage_no_update
          BEFORE UPDATE OR DELETE ON mn_provider_usage
          FOR EACH ROW EXECUTE FUNCTION mn_reject_provider_usage_mutation();
        DROP TRIGGER IF EXISTS mn_provider_usage_lifecycle_no_update
          ON mn_provider_usage_lifecycle_events;
        CREATE TRIGGER mn_provider_usage_lifecycle_no_update
          BEFORE UPDATE OR DELETE ON mn_provider_usage_lifecycle_events
          FOR EACH ROW EXECUTE FUNCTION mn_reject_provider_usage_mutation();
        CREATE OR REPLACE FUNCTION mn_reject_audit_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'mn_audit_events is append-only';
        END $$;
        DROP TRIGGER IF EXISTS mn_audit_events_no_update ON mn_audit_events;
        CREATE TRIGGER mn_audit_events_no_update
          BEFORE UPDATE OR DELETE ON mn_audit_events
          FOR EACH ROW EXECUTE FUNCTION mn_reject_audit_mutation();
      `);
    });
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.pool.end();
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertMetadata(input: {
    tenantId: string;
    kind: string;
    id: string;
    digest: string;
    payload: Readonly<Record<string, unknown>>;
    now?: string;
  }): Promise<EnterpriseMetadataRecord> {
    const tenantId = identifier(input.tenantId, "tenantId");
    const kind = identifier(input.kind, "kind");
    const id = identifier(input.id, "id");
    if (!/^[a-f0-9]{64}$/u.test(input.digest)) throw new TypeError("digest is invalid");
    if (sha256Canonical(input.payload) !== input.digest) {
      throw new TypeError("digest does not match metadata payload");
    }
    const now = timestamp(input.now, "now");
    return this.transaction(async (client) => {
      const result = await client.query<{
        tenant_id: string;
        kind: string;
        id: string;
        version: string;
        digest: string;
        payload: Record<string, unknown>;
        created_at: Date;
        updated_at: Date;
      }>(`
        INSERT INTO mn_metadata
          (tenant_id, kind, id, version, digest, payload, created_at, updated_at)
        VALUES ($1,$2,$3,1,$4,$5::jsonb,$6,$6)
        ON CONFLICT (tenant_id, kind, id) DO UPDATE SET
          version = mn_metadata.version +
            CASE WHEN mn_metadata.digest <> EXCLUDED.digest THEN 1 ELSE 0 END,
          digest = EXCLUDED.digest,
          payload = EXCLUDED.payload,
          updated_at = CASE
            WHEN mn_metadata.digest <> EXCLUDED.digest THEN EXCLUDED.updated_at
            ELSE mn_metadata.updated_at
          END
        RETURNING *
      `, [tenantId, kind, id, input.digest, JSON.stringify(input.payload), now]);
      const row = result.rows[0]!;
      await this.appendOutbox(client, {
        tenantId,
        aggregateType: kind,
        aggregateId: id,
        eventType: "metadata.upserted",
        payload: { version: Number(row.version), digest: row.digest },
        now
      });
      return metadataFromRow(row);
    });
  }

  async listMetadata(input: {
    tenantId?: string;
    kinds?: readonly string[];
  } = {}): Promise<EnterpriseMetadataRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.tenantId !== undefined) {
      values.push(identifier(input.tenantId, "tenantId"));
      clauses.push(`tenant_id=$${values.length}`);
    }
    if (input.kinds !== undefined) {
      const kinds = [...new Set(input.kinds.map((kind) => identifier(kind, "kind")))];
      if (kinds.length === 0) return [];
      values.push(kinds);
      clauses.push(`kind = ANY($${values.length}::text[])`);
    }
    const result = await this.pool.query<{
      tenant_id: string;
      kind: string;
      id: string;
      version: string;
      digest: string;
      payload: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
    }>(`
      SELECT tenant_id,kind,id,version,digest,payload,created_at,updated_at
      FROM mn_metadata
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY tenant_id,kind,id
    `, values);
    return result.rows.map(metadataFromRow);
  }

  /** Atomically mirrors the complete API metadata cache and prunes stale rows. */
  async reconcileMetadata(input: {
    records: readonly EnterpriseMetadataWrite[];
    managedKinds: readonly string[];
    /**
     * Domain audit evidence committed with the metadata image and its outbox.
     * Generic HTTP access logs intentionally use appendAuditEvent instead.
     */
    auditEvents?: readonly AuditEvent[];
    now?: string;
  }): Promise<void> {
    const now = timestamp(input.now, "now");
    const managedKinds = [...new Set(
      input.managedKinds.map((kind) => identifier(kind, "managedKinds"))
    )];
    if (managedKinds.length === 0) {
      throw new TypeError("managedKinds must contain at least one kind");
    }
    const records = input.records.map((record) => {
      const normalized = {
        tenantId: identifier(record.tenantId, "tenantId"),
        kind: identifier(record.kind, "kind"),
        id: identifier(record.id, "id"),
        digest: record.digest,
        payload: record.payload
      };
      if (!managedKinds.includes(normalized.kind)) {
        throw new TypeError(`metadata kind ${normalized.kind} is not managed`);
      }
      if (
        !/^[a-f0-9]{64}$/u.test(normalized.digest) ||
        sha256Canonical(normalized.payload) !== normalized.digest
      ) {
        throw new TypeError("metadata digest does not match payload");
      }
      return normalized;
    });
    const unique = new Set<string>();
    for (const record of records) {
      const key = `${record.tenantId}\0${record.kind}\0${record.id}`;
      if (unique.has(key)) throw new TypeError(`duplicate metadata record ${key}`);
      unique.add(key);
    }

    await this.transaction(async (client) => {
      const existing = await client.query<{
        tenant_id: string;
        kind: string;
        id: string;
        digest: string;
      }>(`
        SELECT tenant_id,kind,id,digest FROM mn_metadata
        WHERE kind = ANY($1::text[])
      `, [managedKinds]);
      const existingDigests = new Map(
        existing.rows.map((row) => [
          `${row.tenant_id}\0${row.kind}\0${row.id}`,
          row.digest
        ])
      );
      for (const record of records) {
        const key = `${record.tenantId}\0${record.kind}\0${record.id}`;
        if (existingDigests.get(key) === record.digest) continue;
        const result = await client.query<{ version: string; digest: string }>(`
          INSERT INTO mn_metadata
            (tenant_id,kind,id,version,digest,payload,created_at,updated_at)
          VALUES ($1,$2,$3,1,$4,$5::jsonb,$6,$6)
          ON CONFLICT (tenant_id,kind,id) DO UPDATE SET
            version=mn_metadata.version+1,
            digest=EXCLUDED.digest,
            payload=EXCLUDED.payload,
            updated_at=EXCLUDED.updated_at
          RETURNING version,digest
        `, [
          record.tenantId,
          record.kind,
          record.id,
          record.digest,
          JSON.stringify(record.payload),
          now
        ]);
        await this.appendOutbox(client, {
          tenantId: record.tenantId,
          aggregateType: record.kind,
          aggregateId: record.id,
          eventType: "metadata.upserted",
          payload: {
            version: Number(result.rows[0]!.version),
            digest: result.rows[0]!.digest
          },
          now
        });
      }
      const deleted = await client.query<{
        tenant_id: string;
        kind: string;
        id: string;
        digest: string;
      }>(`
        DELETE FROM mn_metadata AS metadata
        WHERE metadata.kind = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1
            FROM unnest($2::text[],$3::text[],$4::text[])
              AS retained(tenant_id,kind,id)
            WHERE retained.tenant_id=metadata.tenant_id
              AND retained.kind=metadata.kind
              AND retained.id=metadata.id
          )
        RETURNING tenant_id,kind,id,digest
      `, [
        managedKinds,
        records.map((record) => record.tenantId),
        records.map((record) => record.kind),
        records.map((record) => record.id)
      ]);
      for (const row of deleted.rows) {
        await this.appendOutbox(client, {
          tenantId: row.tenant_id,
          aggregateType: row.kind,
          aggregateId: row.id,
          eventType: "metadata.deleted",
          payload: { digest: row.digest },
          now
        });
      }
      for (const event of input.auditEvents ?? []) {
        await this.insertAuditEvent(client, event, true);
      }
    });
  }

  /**
   * Executes both a read and a committed write. Callers must not advertise a
   * PostgreSQL backend as healthy unless this probe succeeds.
   */
  async checkReadWrite(now = new Date().toISOString()): Promise<void> {
    const checkedAt = timestamp(now, "now");
    await this.transaction(async (client) => {
      await client.query("SELECT count(*) FROM mn_metadata");
      await client.query(`
        INSERT INTO mn_health_probe (id,checked_at) VALUES (1,$1)
        ON CONFLICT (id) DO UPDATE SET checked_at=EXCLUDED.checked_at
      `, [checkedAt]);
      const result = await client.query<{ checked_at: Date }>(
        "SELECT checked_at FROM mn_health_probe WHERE id=1"
      );
      if (result.rows[0]?.checked_at.toISOString() !== checkedAt) {
        throw new Error("PostgreSQL read/write health probe did not round-trip");
      }
    });
  }

  async enqueueRunJob(input: EnterpriseRunJobInput): Promise<RunJobQueueItem> {
    const now = timestamp(input.now, "now");
    const runId = identifier(input.runId, "runId");
    const tenantId = identifier(input.tenantId, "tenantId");
    const projectId = identifier(input.projectId, "projectId");
    const taskId = identifier(input.taskId, "taskId");
    const requirements = normalizeWorkerRequirements(input.requirements);
    const requirementsDigest = workerRequirementsDigest(requirements);
    return this.transaction(async (client) => {
      const previous = await client.query<RunJobRow>(
        "SELECT * FROM mn_run_jobs WHERE run_id=$1 FOR UPDATE",
        [runId]
      );
      const row = previous.rows[0];
      if (
        row &&
        (row.tenant_id !== tenantId ||
          row.project_id !== projectId ||
          row.task_id !== taskId)
      ) {
        throw new Error("runId cannot be rebound to another tenant, project, or task");
      }
      if (row?.status === "running" && row.claim_expires_at &&
        row.claim_expires_at.getTime() > Date.parse(now)) {
        throw new Error("cannot enqueue over an active enterprise claim");
      }
      if (row && row.requirements_digest !== requirementsDigest) {
        throw new Error("worker requirements are immutable for an enterprise runId");
      }
      const result = await client.query<RunJobRow>(`
        INSERT INTO mn_run_jobs
          (run_id,tenant_id,project_id,task_id,status,priority,attempt,
           requirements,requirements_digest,payload,checkpoint_digest,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'queued',$5,$6,$7::jsonb,$8,$9::jsonb,NULL,$10,$10)
        ON CONFLICT (run_id) DO UPDATE SET
          status='queued', priority=EXCLUDED.priority,
          attempt=mn_run_jobs.attempt+1,
          requirements=EXCLUDED.requirements,
          requirements_digest=EXCLUDED.requirements_digest,
          payload=EXCLUDED.payload,
          checkpoint_digest=NULL,
          owner_id=NULL, claim_token_hash=NULL, claim_binding_digest=NULL,
          worker_capability_digest=NULL, claimed_at=NULL, claim_expires_at=NULL,
          heartbeat_at=NULL, finished_at=NULL, updated_at=EXCLUDED.updated_at
        RETURNING *
      `, [
        runId,
        tenantId,
        projectId,
        taskId,
        input.priority ?? 0,
        row ? row.attempt + 1 : 1,
        JSON.stringify(requirements),
        requirementsDigest,
        JSON.stringify(input.payload),
        now
      ]);
      await this.appendOutbox(client, {
        tenantId,
        aggregateType: "run_job",
        aggregateId: runId,
        eventType: "run_job.queued",
        payload: { requirementsDigest },
        now
      });
      await this.upsertMetadataRecords(
        client,
        input.metadataRecords ?? [],
        tenantId,
        now
      );
      if (input.auditEvent) {
        if (input.auditEvent.tenantId !== tenantId) {
          throw new TypeError("run audit tenant does not match queued job");
        }
        await this.insertAuditEvent(client, input.auditEvent, true);
      }
      return itemFromRow(result.rows[0]!);
    });
  }

  async readRunJob(runId: string): Promise<RunJobQueueItem | undefined> {
    const result = await this.pool.query<RunJobRow>(
      "SELECT * FROM mn_run_jobs WHERE run_id=$1",
      [identifier(runId, "runId")]
    );
    const row = result.rows[0];
    return row ? itemFromRow(row) : undefined;
  }

  async listRunJobs(input: {
    status?: EnterpriseRunJobListStatus;
    tenantId?: string;
    now?: string;
  } = {}): Promise<RunJobQueueItem[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.tenantId !== undefined) {
      values.push(identifier(input.tenantId, "tenantId"));
      clauses.push(`tenant_id=$${values.length}`);
    }
    if (input.status === "claimable") {
      values.push(timestamp(input.now, "now"));
      clauses.push(`(status='queued' OR (status='running' AND claim_expires_at <= $${values.length}))`);
    } else if (input.status !== undefined) {
      values.push(input.status);
      clauses.push(`status=$${values.length}`);
    }
    const result = await this.pool.query<RunJobRow>(`
      SELECT * FROM mn_run_jobs
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY priority DESC, created_at, run_id
    `, values);
    return result.rows.map(itemFromRow);
  }

  async claimRunJob(input: EnterpriseClaimInput): Promise<EnterpriseClaim | undefined> {
    const ownerId = identifier(input.ownerId, "ownerId");
    const capabilities = normalizeWorkerCapabilities(input.capabilities);
    const capabilityDigest = workerCapabilityDigest(capabilities);
    const now = timestamp(input.now, "now");
    const ttlMs = claimTtl(input.ttlMs);
    return this.transaction(async (client) => {
      await this.recoverPreDispatchProviderUsageInTransaction(client, { now });
      await client.query(`
        UPDATE mn_run_jobs SET status='queued', owner_id=NULL,
          claim_token_hash=NULL, claim_binding_digest=NULL,
          worker_capability_digest=NULL, claimed_at=NULL,
          claim_expires_at=NULL, heartbeat_at=NULL, started_at=NULL, updated_at=$1
        WHERE status='running' AND claim_expires_at <= $1
      `, [now]);
      const candidates = await client.query<RunJobRow>(`
        SELECT * FROM mn_run_jobs
        WHERE status='queued' AND tenant_id = ANY($1::text[])
        ORDER BY priority DESC, created_at, run_id
        FOR UPDATE SKIP LOCKED
        LIMIT 100
      `, [capabilities.tenantIds]);
      const row = candidates.rows.find((candidate) =>
        workerSatisfiesRequirements(
          capabilities,
          candidate.requirements,
          candidate.tenant_id
        )
      );
      if (!row) return undefined;
      assertCheckpointIntegrity(row);
      const claimToken = randomUUID();
      const tokenHash = sha256(claimToken);
      const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
      const bindingDigest = sha256(
        `${row.tenant_id}\0${row.run_id}\0${ownerId}\0${capabilityDigest}\0${row.requirements_digest}\0${expiresAt}`
      );
      const claimed = await client.query<RunJobRow>(`
        UPDATE mn_run_jobs SET
          status='running', owner_id=$2, claim_token_hash=$3,
          claim_binding_digest=$4, worker_capability_digest=$5,
          claimed_at=$6, claim_expires_at=$7, heartbeat_at=$6,
          started_at=COALESCE(started_at,$6), updated_at=$6
        WHERE run_id=$1 RETURNING *
      `, [row.run_id, ownerId, tokenHash, bindingDigest, capabilityDigest, now, expiresAt]);
      await this.appendOutbox(client, {
        tenantId: row.tenant_id,
        aggregateType: "run_job",
        aggregateId: row.run_id,
        eventType: "run_job.claimed",
        payload: { ownerId, capabilityDigest, expiresAt },
        now
      });
      return {
        item: itemFromRow(claimed.rows[0]!),
        claimToken,
        payload: row.payload,
        checkpointDigest: row.checkpoint_digest
      };
    });
  }

  /** Reads and authenticates an active claim without extending its lease. */
  async inspectClaim(input: {
    runId: string;
    ownerId: string;
    claimToken: string;
    now?: string;
  }): Promise<EnterpriseClaimSnapshot | undefined> {
    const now = timestamp(input.now, "now");
    const result = await this.pool.query<RunJobRow>(
      "SELECT * FROM mn_run_jobs WHERE run_id=$1",
      [identifier(input.runId, "runId")]
    );
    const row = result.rows[0];
    if (
      !row ||
      row.status !== "running" ||
      row.owner_id !== input.ownerId ||
      !row.claim_token_hash ||
      !safeTokenEqual(input.claimToken, row.claim_token_hash) ||
      !row.claim_expires_at ||
      row.claim_expires_at.getTime() <= Date.parse(now)
    ) {
      return undefined;
    }
    assertCheckpointIntegrity(row);
    return {
      item: itemFromRow(row),
      payload: row.payload,
      checkpointDigest: row.checkpoint_digest
    };
  }

  async heartbeatClaim(input: {
    runId: string;
    ownerId: string;
    claimToken: string;
    ttlMs?: number;
    now?: string;
  }): Promise<RunJobQueueItem | undefined> {
    const now = timestamp(input.now, "now");
    const ttlMs = claimTtl(input.ttlMs);
    return this.transaction(async (client) => {
      const result = await client.query<RunJobRow>(
        "SELECT * FROM mn_run_jobs WHERE run_id=$1 FOR UPDATE",
        [identifier(input.runId, "runId")]
      );
      const row = result.rows[0];
      if (
        !row ||
        row.status !== "running" ||
        row.owner_id !== input.ownerId ||
        !row.claim_token_hash ||
        !safeTokenEqual(input.claimToken, row.claim_token_hash) ||
        !row.claim_expires_at ||
        row.claim_expires_at.getTime() <= Date.parse(now)
      ) {
        return undefined;
      }
      await this.recoverPreDispatchProviderUsageInTransaction(client, {
        tenantId: row.tenant_id,
        runId: row.run_id,
        now
      });
      await assertNoPendingProviderUsageReservations(
        client,
        row.tenant_id,
        row.run_id
      );
      const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
      if (!row.worker_capability_digest) return undefined;
      const bindingDigest = sha256(
        `${row.tenant_id}\0${row.run_id}\0${row.owner_id}\0${row.worker_capability_digest}\0${row.requirements_digest}\0${expiresAt}`
      );
      const updated = await client.query<RunJobRow>(`
        UPDATE mn_run_jobs SET heartbeat_at=$2, claim_expires_at=$3,
          claim_binding_digest=$4, updated_at=$2
        WHERE run_id=$1 RETURNING *
      `, [row.run_id, now, expiresAt, bindingDigest]);
      return itemFromRow(updated.rows[0]!);
    });
  }

  /**
   * Persists a validated worker checkpoint while atomically renewing its
   * active claim. A reclaimed worker therefore receives the latest durable
   * payload instead of the original enqueue payload.
   */
  async checkpointClaim(input: {
    runId: string;
    ownerId: string;
    claimToken: string;
    payload: Readonly<Record<string, unknown>>;
    checkpointDigest: string;
    expectedCheckpointDigest: string | null;
    metadataRecords?: readonly EnterpriseMetadataWrite[];
    auditEvent?: AuditEvent;
    ttlMs?: number;
    renewLease?: boolean;
    now?: string;
  }): Promise<RunJobQueueItem | undefined> {
    const now = timestamp(input.now, "now");
    const ttlMs = claimTtl(input.ttlMs);
    if (!/^[a-f0-9]{64}$/u.test(input.checkpointDigest)) {
      throw new TypeError("checkpointDigest is invalid");
    }
    if (sha256Canonical(input.payload) !== input.checkpointDigest) {
      throw new TypeError("checkpointDigest does not match payload");
    }
    if (
      input.expectedCheckpointDigest !== null &&
      !/^[a-f0-9]{64}$/u.test(input.expectedCheckpointDigest)
    ) {
      throw new TypeError("expectedCheckpointDigest is invalid");
    }
    return this.transaction(async (client) => {
      const selected = await client.query<RunJobRow>(
        "SELECT * FROM mn_run_jobs WHERE run_id=$1 FOR UPDATE",
        [identifier(input.runId, "runId")]
      );
      const row = selected.rows[0];
      if (
        !row ||
        row.status !== "running" ||
        row.owner_id !== input.ownerId ||
        !row.claim_token_hash ||
        !safeTokenEqual(input.claimToken, row.claim_token_hash) ||
        !row.claim_expires_at ||
        row.claim_expires_at.getTime() <= Date.parse(now) ||
        !row.worker_capability_digest ||
        row.checkpoint_digest !== input.expectedCheckpointDigest
      ) {
        return undefined;
      }
      await this.recoverPreDispatchProviderUsageInTransaction(client, {
        tenantId: row.tenant_id,
        runId: row.run_id,
        now
      });
      await assertNoPendingProviderUsageReservations(
        client,
        row.tenant_id,
        row.run_id
      );
      const expiresAt = input.renewLease === false
        ? row.claim_expires_at.toISOString()
        : new Date(Date.parse(now) + ttlMs).toISOString();
      const bindingDigest = sha256(
        `${row.tenant_id}\0${row.run_id}\0${row.owner_id}\0${row.worker_capability_digest}\0${row.requirements_digest}\0${expiresAt}`
      );
      const updated = await client.query<RunJobRow>(`
        UPDATE mn_run_jobs SET
          payload=$2::jsonb, checkpoint_digest=$3,
          heartbeat_at=$4, claim_expires_at=$5,
          claim_binding_digest=$6, updated_at=$4
        WHERE run_id=$1 RETURNING *
      `, [
        row.run_id,
        JSON.stringify(input.payload),
        input.checkpointDigest,
        now,
        expiresAt,
        bindingDigest
      ]);
      await this.appendOutbox(client, {
        tenantId: row.tenant_id,
        aggregateType: "run_job",
        aggregateId: row.run_id,
        eventType: "run_job.checkpointed",
        payload: {
          ownerId: row.owner_id,
          previousCheckpointDigest: row.checkpoint_digest,
          checkpointDigest: input.checkpointDigest,
          expiresAt
        },
        now
      });
      await this.upsertMetadataRecords(
        client,
        input.metadataRecords ?? [],
        row.tenant_id,
        now
      );
      if (input.auditEvent) {
        if (input.auditEvent.tenantId !== row.tenant_id) {
          throw new TypeError("run audit tenant does not match claimed job");
        }
        await this.insertAuditEvent(client, input.auditEvent, true);
      }
      return itemFromRow(updated.rows[0]!);
    });
  }

  async releaseClaim(input: {
    runId: string;
    ownerId: string;
    claimToken: string;
    now?: string;
  }): Promise<RunJobQueueItem | undefined> {
    const now = timestamp(input.now, "now");
    return this.transaction(async (client) => {
      const selected = await client.query<RunJobRow>(
        "SELECT * FROM mn_run_jobs WHERE run_id=$1 FOR UPDATE",
        [identifier(input.runId, "runId")]
      );
      const row = selected.rows[0];
      if (
        !row ||
        row.status !== "running" ||
        row.owner_id !== input.ownerId ||
        !row.claim_token_hash ||
        !safeTokenEqual(input.claimToken, row.claim_token_hash) ||
        !row.claim_expires_at ||
        row.claim_expires_at.getTime() <= Date.parse(now)
      ) return undefined;
      const result = await client.query<RunJobRow>(`
        UPDATE mn_run_jobs SET status='queued', owner_id=NULL,
          claim_token_hash=NULL, claim_binding_digest=NULL,
          worker_capability_digest=NULL, claimed_at=NULL,
          claim_expires_at=NULL, heartbeat_at=NULL, started_at=NULL,
          updated_at=$2
        WHERE run_id=$1 RETURNING *
      `, [row.run_id, now]);
      await this.appendOutbox(client, {
        tenantId: row.tenant_id,
        aggregateType: "run_job",
        aggregateId: row.run_id,
        eventType: "run_job.released",
        payload: { ownerId: input.ownerId },
        now
      });
      return itemFromRow(result.rows[0]!);
    });
  }

  async finishRunJob(input: {
    runId: string;
    ownerId: string;
    claimToken: string;
    status: "completed" | "failed" | "cancelled";
    payload?: Readonly<Record<string, unknown>>;
    checkpointDigest?: string;
    expectedCheckpointDigest?: string | null;
    metadataRecords?: readonly EnterpriseMetadataWrite[];
    auditEvent?: AuditEvent;
    now?: string;
  }): Promise<RunJobQueueItem | undefined> {
    if (!TERMINAL.has(input.status)) throw new TypeError("terminal status is invalid");
    const hasCheckpoint = input.payload !== undefined ||
      input.checkpointDigest !== undefined ||
      input.expectedCheckpointDigest !== undefined;
    if (
      hasCheckpoint &&
      (input.payload === undefined ||
        input.checkpointDigest === undefined ||
        input.expectedCheckpointDigest === undefined)
    ) {
      throw new TypeError("terminal checkpoint fields must be supplied together");
    }
    if (
      input.payload !== undefined &&
      (sha256Canonical(input.payload) !== input.checkpointDigest ||
        !/^[a-f0-9]{64}$/u.test(input.checkpointDigest ?? ""))
    ) {
      throw new TypeError("checkpointDigest does not match payload");
    }
    if (
      input.expectedCheckpointDigest !== undefined &&
      input.expectedCheckpointDigest !== null &&
      !/^[a-f0-9]{64}$/u.test(input.expectedCheckpointDigest)
    ) {
      throw new TypeError("expectedCheckpointDigest is invalid");
    }
    const now = timestamp(input.now, "now");
    return this.transaction(async (client) => {
      const selected = await client.query<RunJobRow>(
        "SELECT * FROM mn_run_jobs WHERE run_id=$1 FOR UPDATE",
        [input.runId]
      );
      const row = selected.rows[0];
      if (
        !row ||
        row.status !== "running" ||
        row.owner_id !== input.ownerId ||
        !row.claim_token_hash ||
        !safeTokenEqual(input.claimToken, row.claim_token_hash) ||
        !row.claim_expires_at ||
        row.claim_expires_at.getTime() <= Date.parse(now) ||
        (hasCheckpoint && row.checkpoint_digest !== input.expectedCheckpointDigest)
      ) return undefined;
      await this.recoverPreDispatchProviderUsageInTransaction(client, {
        tenantId: row.tenant_id,
        runId: row.run_id,
        now
      });
      await assertNoPendingProviderUsageReservations(
        client,
        row.tenant_id,
        row.run_id
      );
      const result = hasCheckpoint
        ? await client.query<RunJobRow>(`
            UPDATE mn_run_jobs SET status=$2, finished_at=$3, updated_at=$3,
              payload=$4::jsonb, checkpoint_digest=$5,
              claim_token_hash=NULL, claim_binding_digest=NULL,
              claim_expires_at=NULL, heartbeat_at=NULL
            WHERE run_id=$1 RETURNING *
          `, [
            input.runId,
            input.status,
            now,
            JSON.stringify(input.payload),
            input.checkpointDigest
          ])
        : await client.query<RunJobRow>(`
            UPDATE mn_run_jobs SET status=$2, finished_at=$3, updated_at=$3,
              claim_token_hash=NULL, claim_binding_digest=NULL,
              claim_expires_at=NULL, heartbeat_at=NULL
            WHERE run_id=$1 RETURNING *
          `, [input.runId, input.status, now]);
      await this.appendOutbox(client, {
        tenantId: row.tenant_id,
        aggregateType: "run_job",
        aggregateId: row.run_id,
        eventType: `run_job.${input.status}`,
        payload: {
          ownerId: input.ownerId,
          ...(input.checkpointDigest
            ? { checkpointDigest: input.checkpointDigest }
            : {})
        },
        now
      });
      await this.upsertMetadataRecords(
        client,
        input.metadataRecords ?? [],
        row.tenant_id,
        now
      );
      if (input.auditEvent) {
        if (input.auditEvent.tenantId !== row.tenant_id) {
          throw new TypeError("run audit tenant does not match claimed job");
        }
        await this.insertAuditEvent(client, input.auditEvent, true);
      }
      return itemFromRow(result.rows[0]!);
    });
  }

  async cancelRunJob(input: {
    runId: string;
    tenantId: string;
    metadataRecords?: readonly EnterpriseMetadataWrite[];
    auditEvent?: AuditEvent;
    now?: string;
  }): Promise<RunJobQueueItem | undefined> {
    const now = timestamp(input.now, "now");
    return this.transaction(async (client) => {
      const selected = await client.query<RunJobRow>(
        "SELECT * FROM mn_run_jobs WHERE run_id=$1 FOR UPDATE",
        [identifier(input.runId, "runId")]
      );
      const row = selected.rows[0];
      if (!row || row.tenant_id !== input.tenantId) return undefined;
      if (TERMINAL.has(row.status)) return itemFromRow(row);
      const result = await client.query<RunJobRow>(`
        UPDATE mn_run_jobs SET status='cancelled', finished_at=$2,
          updated_at=$2, claim_token_hash=NULL, claim_binding_digest=NULL,
          claim_expires_at=NULL, heartbeat_at=NULL
        WHERE run_id=$1 RETURNING *
      `, [row.run_id, now]);
      await this.appendOutbox(client, {
        tenantId: row.tenant_id,
        aggregateType: "run_job",
        aggregateId: row.run_id,
        eventType: "run_job.cancelled",
        payload: { requestedByTenant: input.tenantId },
        now
      });
      await this.upsertMetadataRecords(
        client,
        input.metadataRecords ?? [],
        row.tenant_id,
        now
      );
      if (input.auditEvent) {
        if (input.auditEvent.tenantId !== row.tenant_id) {
          throw new TypeError("run audit tenant does not match cancelled job");
        }
        await this.insertAuditEvent(client, input.auditEvent, true);
      }
      return itemFromRow(result.rows[0]!);
    });
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    await this.transaction(async (client) => {
      await this.insertAuditEvent(client, event, false);
    });
  }

  private async upsertMetadataRecords(
    client: PoolClient,
    records: readonly EnterpriseMetadataWrite[],
    expectedTenantId: string,
    now: string
  ): Promise<void> {
    const seen = new Set<string>();
    for (const input of records) {
      const tenantId = identifier(input.tenantId, "tenantId");
      const kind = identifier(input.kind, "kind");
      const id = identifier(input.id, "id");
      if (tenantId !== expectedTenantId) {
        throw new TypeError("run metadata tenant does not match job tenant");
      }
      if (
        !/^[a-f0-9]{64}$/u.test(input.digest) ||
        sha256Canonical(input.payload) !== input.digest
      ) {
        throw new TypeError("metadata digest does not match payload");
      }
      const key = `${tenantId}\0${kind}\0${id}`;
      if (seen.has(key)) throw new TypeError(`duplicate metadata record ${key}`);
      seen.add(key);
      const existing = await client.query<{ digest: string }>(`
        SELECT digest FROM mn_metadata
        WHERE tenant_id=$1 AND kind=$2 AND id=$3
      `, [tenantId, kind, id]);
      if (existing.rows[0]?.digest === input.digest) continue;
      const result = await client.query<{ version: string; digest: string }>(`
        INSERT INTO mn_metadata
          (tenant_id,kind,id,version,digest,payload,created_at,updated_at)
        VALUES ($1,$2,$3,1,$4,$5::jsonb,$6,$6)
        ON CONFLICT (tenant_id,kind,id) DO UPDATE SET
          version=mn_metadata.version+1,
          digest=EXCLUDED.digest,
          payload=EXCLUDED.payload,
          updated_at=EXCLUDED.updated_at
        RETURNING version,digest
      `, [tenantId, kind, id, input.digest, JSON.stringify(input.payload), now]);
      await this.appendOutbox(client, {
        tenantId,
        aggregateType: kind,
        aggregateId: id,
        eventType: "metadata.upserted",
        payload: {
          version: Number(result.rows[0]!.version),
          digest: result.rows[0]!.digest
        },
        now
      });
    }
  }

  private async insertAuditEvent(
    client: PoolClient,
    event: AuditEvent,
    emitDomainOutbox: boolean
  ): Promise<void> {
    const inserted = await client.query<{ payload: AuditEvent }>(`
      INSERT INTO mn_audit_events
        (id,tenant_id,actor_id,action,resource_type,resource_id,project_id,
         policy_decision,before_digest,after_digest,pack_digest,trace_id,
         result,status_code,occurred_at,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
      ON CONFLICT (id) DO NOTHING
      RETURNING payload
    `, [
      event.id,
      event.tenantId,
      event.actorId,
      event.action,
      event.resourceType,
      event.resourceId ?? null,
      event.projectId ?? null,
      event.policyDecision,
      event.beforeDigest ?? null,
      event.afterDigest ?? null,
      event.packDigest ?? null,
      event.traceId,
      event.result,
      event.statusCode,
      event.timestamp,
      JSON.stringify(event)
    ]);
    if (inserted.rowCount === 0) {
      const existing = await client.query<{ payload: AuditEvent }>(
        "SELECT payload FROM mn_audit_events WHERE id=$1",
        [event.id]
      );
      if (
        !existing.rows[0] ||
        sha256Canonical(existing.rows[0].payload) !== sha256Canonical(event)
      ) {
        throw new Error(`Audit event ${event.id} idempotency conflict`);
      }
      return;
    }
    if (emitDomainOutbox) {
      await this.appendOutbox(client, {
        tenantId: event.tenantId,
        aggregateType: event.resourceType,
        aggregateId: event.resourceId ?? event.id,
        eventType: "audit.domain.recorded",
        payload: {
          auditEventId: event.id,
          action: event.action,
          traceId: event.traceId,
          result: event.result,
          statusCode: event.statusCode
        },
        now: event.timestamp
      });
    }
  }

  private async insertProviderUsageLifecycleEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      reservationId: string;
      logicalRequestId: string;
      id: string;
      type: ProviderUsageLifecycleEventType;
      attemptIndex?: number;
      idempotencyKeyDigest?: string;
      payload: Readonly<Record<string, unknown>>;
      now: string;
    }
  ): Promise<ProviderUsageLifecycleEvent> {
    const eventDigest = sha256Canonical(input.payload);
    const existing = await client.query<ProviderUsageLifecycleRow>(`
      SELECT * FROM mn_provider_usage_lifecycle_events
      WHERE tenant_id=$1 AND event_id=$2
    `, [input.tenantId, input.id]);
    if (existing.rows[0]) {
      const event = providerUsageLifecycleEvent(existing.rows[0]);
      if (
        event.reservationId !== input.reservationId ||
        event.logicalRequestId !== input.logicalRequestId ||
        event.type !== input.type ||
        event.attemptIndex !== input.attemptIndex ||
        event.idempotencyKeyDigest !== input.idempotencyKeyDigest ||
        event.digest !== eventDigest
      ) {
        throw new Error(`Provider usage lifecycle event ${input.id} idempotency conflict`);
      }
      return event;
    }
    const ordinal = await client.query<{ next_index: string }>(`
      SELECT (COALESCE(MAX(event_index),0)+1)::text AS next_index
      FROM mn_provider_usage_lifecycle_events
      WHERE tenant_id=$1 AND reservation_id=$2
    `, [input.tenantId, input.reservationId]);
    const eventIndex = Number(ordinal.rows[0]?.next_index ?? "1");
    const inserted = await client.query<ProviderUsageLifecycleRow>(`
      INSERT INTO mn_provider_usage_lifecycle_events
        (tenant_id,event_id,reservation_id,logical_request_id,event_index,
         event_type,attempt_index,idempotency_key_digest,event_digest,created_at,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      RETURNING *
    `, [
      input.tenantId,
      input.id,
      input.reservationId,
      input.logicalRequestId,
      eventIndex,
      input.type,
      input.attemptIndex ?? null,
      input.idempotencyKeyDigest ?? null,
      eventDigest,
      input.now,
      JSON.stringify(input.payload)
    ]);
    return providerUsageLifecycleEvent(inserted.rows[0]!);
  }

  private async providerUsageRequestSnapshot(
    client: PoolClient,
    input: {
      tenantId: string;
      logicalRequestId: string;
      projectIds?: readonly string[];
      lock?: boolean;
    }
  ): Promise<ProviderUsageRequestSnapshot | undefined> {
    const reservation = await client.query<ProviderUsageRequestRow>(`
      SELECT r.*,j.project_id
      FROM mn_provider_usage_reservations r
      INNER JOIN mn_run_jobs j
        ON j.tenant_id=r.tenant_id AND j.run_id=r.run_id
      WHERE r.tenant_id=$1
        AND COALESCE(r.logical_request_id,r.reservation_id::text)=$2
      ${input.lock ? "FOR UPDATE OF r" : ""}
    `, [input.tenantId, input.logicalRequestId]);
    const row = reservation.rows[0];
    if (!row) return undefined;
    if (
      input.projectIds &&
      input.projectIds.length > 0 &&
      !input.projectIds.includes(row.project_id)
    ) {
      return undefined;
    }
    const [lifecycleRows, usageRows] = await Promise.all([
      client.query<ProviderUsageLifecycleRow>(`
        SELECT * FROM mn_provider_usage_lifecycle_events
        WHERE tenant_id=$1 AND reservation_id=$2
        ORDER BY event_index,event_id
      `, [input.tenantId, row.reservation_id]),
      client.query<{ payload: ProxyRequestLog }>(`
        SELECT payload FROM mn_provider_usage
        WHERE tenant_id=$1 AND reservation_id=$2
        ORDER BY attempt_index,request_id
      `, [input.tenantId, row.reservation_id])
    ]);
    const lifecycle = lifecycleRows.rows.map(providerUsageLifecycleEvent);
    const usageLogs = usageRows.rows.map(({ payload }) => payload);
    const preparedEvent = lifecycle.find((event) => event.type === "prepared");
    const prepared = preparedEvent?.payload.intent as PreparedProviderUsageIntent | undefined;
    const recoveryDigest = sha256Canonical({
      schemaVersion: 1,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      reservationId: row.reservation_id,
      logicalRequestId: row.logical_request_id ?? row.reservation_id,
      runId: row.run_id,
      candidateId: row.candidate_id,
      lifecycle: lifecycle.map((event) => ({ id: event.id, digest: event.digest })),
      usage: usageLogs.map((log) => ({ id: log.id, digest: sha256Canonical(log) }))
    });
    return Object.freeze({
      schemaVersion: 1 as const,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      legacy: row.logical_request_id === null,
      logicalRequestId: row.logical_request_id ?? row.reservation_id,
      reservationId: row.reservation_id,
      runId: row.run_id,
      candidateId: row.candidate_id,
      status: usageLogs.some((log) =>
        (log as Partial<ProviderUsageAttemptLog>).usageAttempt?.terminal !== false
      ) ? "finalized" as const : "pending" as const,
      ...(prepared ? { prepared } : {}),
      lifecycle: Object.freeze(lifecycle),
      usageLogs: Object.freeze(usageLogs),
      recoveryDigest
    });
  }

  private async recoverPreDispatchProviderUsageInTransaction(
    client: PoolClient,
    input: { tenantId?: string; runId?: string; now: string }
  ): Promise<number> {
    const rows = await client.query<ProviderUsageRequestRow>(`
      SELECT r.*,j.project_id
      FROM mn_provider_usage_reservations r
      INNER JOIN mn_run_jobs j
        ON j.tenant_id=r.tenant_id AND j.run_id=r.run_id
      WHERE r.logical_request_id IS NOT NULL
        AND ($1::text IS NULL OR r.tenant_id=$1)
        AND ($2::text IS NULL OR r.run_id=$2)
        AND EXISTS (
          SELECT 1 FROM mn_provider_usage_lifecycle_events e
          WHERE e.tenant_id=r.tenant_id AND e.reservation_id=r.reservation_id
            AND e.event_type='prepared'
        )
        AND NOT EXISTS (
          SELECT 1 FROM mn_provider_usage u
          WHERE u.tenant_id=r.tenant_id AND u.reservation_id=r.reservation_id
            AND u.reservation_finalized
        )
      ORDER BY r.tenant_id,r.reservation_id
    `, [input.tenantId ?? null, input.runId ?? null]);
    let recovered = 0;
    for (const candidate of rows.rows) {
      // Lock order is run -> reservation everywhere dispatch/recovery can
      // compete. The state decision happens in statements *after* both waits,
      // so READ COMMITTED cannot use a pre-wait lifecycle snapshot.
      const runState = await client.query<{
        status: RunJobQueueStatus;
        claim_token_hash: string | null;
        claim_expires_at: Date | null;
        recovery_now: Date;
      }>(`
        SELECT status,claim_token_hash,claim_expires_at,
          clock_timestamp() AS recovery_now
        FROM mn_run_jobs
        WHERE tenant_id=$1 AND run_id=$2
        FOR UPDATE
      `, [candidate.tenant_id, candidate.run_id]);
      const run = runState.rows[0];
      if (
        !run ||
        (run.status === "running" &&
          run.claim_token_hash === candidate.claim_token_hash &&
          run.claim_expires_at !== null &&
          run.claim_expires_at.getTime() > run.recovery_now.getTime())
      ) {
        continue;
      }
      const locked = await client.query<ProviderUsageRequestRow>(`
        SELECT r.*,j.project_id
        FROM mn_provider_usage_reservations r
        INNER JOIN mn_run_jobs j
          ON j.tenant_id=r.tenant_id AND j.run_id=r.run_id
        WHERE r.tenant_id=$1 AND r.reservation_id=$2
        FOR UPDATE OF r
      `, [candidate.tenant_id, candidate.reservation_id]);
      const row = locked.rows[0];
      if (!row || row.logical_request_id === null) continue;
      const preparedRows = await client.query<ProviderUsageLifecycleRow>(`
        SELECT * FROM mn_provider_usage_lifecycle_events
        WHERE tenant_id=$1 AND reservation_id=$2 AND event_type='prepared'
        ORDER BY event_index LIMIT 1
      `, [row.tenant_id, row.reservation_id]);
      const intent = preparedRows.rows[0]?.payload.intent as
        | PreparedProviderUsageIntent
        | undefined;
      if (!intent) continue;
      const [dispatchRows, attemptRows] = await Promise.all([
        client.query<ProviderUsageLifecycleRow>(`
          SELECT * FROM mn_provider_usage_lifecycle_events
          WHERE tenant_id=$1 AND reservation_id=$2
            AND event_type='attempt_dispatch_started'
          ORDER BY attempt_index,event_index
        `, [row.tenant_id, row.reservation_id]),
        client.query<ProviderUsageAttemptRow>(`
          SELECT request_id,logical_request_id,attempt_index,
                 reservation_finalized,payload
          FROM mn_provider_usage
          WHERE tenant_id=$1 AND reservation_id=$2
          ORDER BY attempt_index,request_id
        `, [row.tenant_id, row.reservation_id])
      ]);
      const attempts = attemptRows.rows;
      if (attempts.some((attempt) => attempt.reservation_finalized)) continue;
      const dispatchIndexes = new Set(
        dispatchRows.rows.map((event) => event.attempt_index).filter(
          (index): index is number => index !== null
        )
      );
      const continuousNonTerminal = attempts.every((attempt, index) =>
        attempt.logical_request_id === intent.logicalRequestId &&
        attempt.attempt_index === index + 1 &&
        attempt.reservation_finalized === false &&
        dispatchIndexes.has(index + 1)
      );
      const nextAttemptIndex = attempts.length + 1;
      // A dispatch without a matching usage row is an unknown provider side
      // effect and can never be auto-cleared. We only synthesize zero when no
      // dispatch exists for the next attempt and every preceding attempt is a
      // durable, contiguous non-terminal record.
      if (
        !continuousNonTerminal ||
        dispatchIndexes.has(nextAttemptIndex) ||
        dispatchIndexes.size !== attempts.length
      ) {
        continue;
      }
      const association = row.payload;
      const recoveryBasisDigest = sha256Canonical({
        preparedEventDigest: preparedRows.rows[0]!.event_digest,
        providerPlanDigest: intent.providerPlanDigest,
        precedingAttempts: attempts.map((attempt) => ({
          index: attempt.attempt_index,
          requestId: attempt.request_id,
          digest: sha256Canonical(attempt.payload)
        }))
      });
      const usage: ProviderUsageAttemptLog = {
        id: providerUsageResolutionLogId(
          intent.logicalRequestId,
          "pre-dispatch-zero"
        ),
        app: intent.app,
        providerId: "mn-pre-dispatch-recovery",
        model: intent.model,
        inputTokens: 0,
        outputTokens: 0,
        authoritativeCostUsd: 0,
        statusCode: 499,
        latencyMs: 0,
        runId: row.run_id,
        candidateId: row.candidate_id,
        trustedAssociation: association,
        usageResolution: {
          kind: "pre_dispatch_zero",
          evidenceKind: "machine",
          basisDigest: recoveryBasisDigest
        },
        usageAttempt: {
          schemaVersion: 1,
          logicalRequestId: intent.logicalRequestId,
          index: nextAttemptIndex,
          terminal: true,
          outcome: "failed",
          retryable: false
        },
        createdAt: input.now
      };
      await client.query(`
        INSERT INTO mn_provider_usage
          (tenant_id,request_id,run_id,candidate_id,worker_id,
           claim_token_hash,receipt_digest,reservation_id,logical_request_id,
           attempt_index,reservation_finalized,verified_at,created_at,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$12,$13::jsonb)
      `, [
        row.tenant_id,
        usage.id,
        row.run_id,
        row.candidate_id,
        row.worker_id,
        row.claim_token_hash,
        row.receipt_digest,
        row.reservation_id,
        intent.logicalRequestId,
        nextAttemptIndex,
        row.verified_at,
        input.now,
        JSON.stringify(usage)
      ]);
      await this.insertProviderUsageLifecycleEvent(client, {
        tenantId: row.tenant_id,
        reservationId: row.reservation_id,
        logicalRequestId: intent.logicalRequestId,
        id: providerUsageLifecycleId(
          intent.logicalRequestId,
          "pre_dispatch_recovered",
          `machine-${nextAttemptIndex}`
        ),
        type: "pre_dispatch_recovered",
        attemptIndex: nextAttemptIndex,
        payload: {
          schemaVersion: 1,
          usageRequestId: usage.id,
          preparedEventDigest: preparedRows.rows[0]!.event_digest,
          precedingAttemptCount: attempts.length,
          basisDigest: recoveryBasisDigest,
          decision: attempts.length === 0
            ? "machine_pre_dispatch_zero"
            : "machine_fallback_pre_dispatch_zero"
        },
        now: input.now
      });
      await this.insertProviderUsageLifecycleEvent(client, {
        tenantId: row.tenant_id,
        reservationId: row.reservation_id,
        logicalRequestId: intent.logicalRequestId,
        id: providerUsageLifecycleId(intent.logicalRequestId, "request_terminal", "machine"),
        type: "request_terminal",
        attemptIndex: nextAttemptIndex,
        payload: { schemaVersion: 1, usageRequestId: usage.id, outcome: "failed" },
        now: input.now
      });
      await this.appendOutbox(client, {
        tenantId: row.tenant_id,
        aggregateType: "provider_usage_request",
        aggregateId: intent.logicalRequestId,
        eventType: "provider_usage.pre_dispatch_recovered",
        payload: {
          runId: row.run_id,
          usageRequestId: usage.id,
          attemptIndex: nextAttemptIndex,
          precedingAttemptCount: attempts.length,
          basisDigest: recoveryBasisDigest
        },
        now: input.now
      });
      recovered += 1;
    }
    return recovered;
  }

  async recoverPreDispatchProviderUsage(input: {
    tenantId?: string;
    runId?: string;
    now?: string;
  } = {}): Promise<number> {
    const now = timestamp(input.now, "usage.recovery.now");
    return this.transaction((client) => this.recoverPreDispatchProviderUsageInTransaction(
      client,
      {
        ...(input.tenantId ? { tenantId: identifier(input.tenantId, "usage.tenantId") } : {}),
        ...(input.runId ? { runId: identifier(input.runId, "usage.runId") } : {}),
        now
      }
    ));
  }

  /** Reserve accounting before the upstream side effect. Terminal accounting
   * remains valid if the claim is released while the request is in flight. */
  async reserveProviderUsageAssociation(
    association: TrustedProxyUsageAssociation
  ): Promise<TrustedProxyUsageAssociation>;
  async reserveProviderUsageAssociation(
    association: TrustedProxyUsageAssociation,
    preparation: PreparedProviderUsageIntent
  ): Promise<ProviderUsageReservationResult>;
  async reserveProviderUsageAssociation(
    association: TrustedProxyUsageAssociation,
    preparation?: PreparedProviderUsageIntent
  ): Promise<ProviderUsageReservationResult> {
    if (association.reservationId) {
      throw new TypeError("provider usage association is already reserved");
    }
    const tenantId = identifier(association.tenantId, "usage.tenantId");
    const runId = identifier(association.runId, "usage.runId");
    const candidateId = identifier(association.candidateId, "usage.candidateId");
    const workerId = identifier(association.workerId, "usage.workerId");
    const verifiedAt = timestamp(association.verifiedAt, "usage.verifiedAt");
    const issuedAt = timestamp(association.issuedAt, "usage.issuedAt");
    const expiresAt = timestamp(association.expiresAt, "usage.expiresAt");
    if (
      association.schemaVersion !== 1 ||
      association.issuer !== "mn-api" ||
      !/^[a-f0-9]{64}$/u.test(association.claimDigest) ||
      !/^[a-f0-9]{64}$/u.test(association.receiptDigest) ||
      verifiedAt < issuedAt ||
      verifiedAt >= expiresAt
    ) {
      throw new TypeError("enterprise provider usage association is inconsistent");
    }
    const prepared = preparation
      ? preparedProviderUsageIntent(preparation)
      : undefined;
    const reservationId = prepared?.logicalRequestId ?? randomUUID();
    const reserved = Object.freeze({ ...association, reservationId });
    return this.transaction(async (client): Promise<ProviderUsageReservationResult> => {
      const claim = await client.query<{
        tenant_id: string;
        status: RunJobQueueStatus;
        owner_id: string | null;
        claim_token_hash: string | null;
        claimed_at: Date | null;
        claim_expires_at: Date | null;
        reservation_now: Date;
      }>(`
        SELECT tenant_id,status,owner_id,claim_token_hash,claimed_at,claim_expires_at,
          clock_timestamp() AS reservation_now
        FROM mn_run_jobs WHERE run_id=$1 FOR SHARE
      `, [runId]);
      const current = claim.rows[0];
      if (
        !current ||
        current.tenant_id !== tenantId ||
        current.status !== "running" ||
        current.owner_id !== workerId ||
        current.claim_token_hash !== association.claimDigest ||
        !current.claimed_at ||
        !current.claim_expires_at ||
        current.claimed_at.toISOString() > verifiedAt ||
        current.claim_expires_at.toISOString() <= verifiedAt ||
        current.reservation_now.getTime() >= Date.parse(expiresAt) ||
        current.reservation_now.getTime() >= current.claim_expires_at.getTime()
      ) {
        throw new Error("provider usage receipt is not bound to the current active claim");
      }
      const inserted = await client.query<{ reservation_id: string }>(`
        INSERT INTO mn_provider_usage_reservations
          (tenant_id,reservation_id,run_id,candidate_id,worker_id,
           claim_token_hash,receipt_digest,verified_at,expires_at,payload,
           logical_request_id,request_digest,provider_plan_digest,
           caller_idempotency_key_digest,provider_idempotency_strength,
           first_outbound_header_name,
           first_outbound_key_digest,prepared_at,conservative_hold)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,
                $11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
        ${prepared?.callerIdempotencyKeyDigest ? "ON CONFLICT DO NOTHING" : ""}
        RETURNING reservation_id
      `, [
        tenantId,
        reservationId,
        runId,
        candidateId,
        workerId,
        association.claimDigest,
        association.receiptDigest,
        verifiedAt,
        expiresAt,
        JSON.stringify(reserved),
        prepared?.logicalRequestId ?? null,
        prepared?.requestDigest ?? null,
        prepared?.providerPlanDigest ?? null,
        prepared?.callerIdempotencyKeyDigest ?? null,
        prepared?.providerIdempotencyStrength ?? "none",
        prepared?.firstOutboundIdempotencyHeaderName ?? null,
        prepared?.firstOutboundIdempotencyKeyDigest ?? null,
        prepared?.preparedAt ?? null,
        prepared ? JSON.stringify(prepared.conservativeHold) : null
      ]);
      if (inserted.rowCount === 0) {
        if (!prepared?.callerIdempotencyKeyDigest) {
          throw new Error("provider usage reservation identity conflict");
        }
        const duplicate = await client.query<
          PendingProviderUsageReservationRow & { finalized: boolean }
        >(`
          SELECT r.*,EXISTS (
            SELECT 1 FROM mn_provider_usage u
            WHERE u.tenant_id=r.tenant_id
              AND u.reservation_id=r.reservation_id
              AND u.reservation_finalized
          ) AS finalized
          FROM mn_provider_usage_reservations r
          WHERE r.tenant_id=$1 AND r.caller_idempotency_key_digest=$2
          FOR UPDATE
        `, [tenantId, prepared.callerIdempotencyKeyDigest]);
        const existing = duplicate.rows[0];
        if (!existing || !existing.logical_request_id) {
          throw new Error("provider usage caller idempotency state is unavailable");
        }
        const kind: ProviderUsageReservationDecision["kind"] =
          existing.run_id !== runId ||
          existing.candidate_id !== candidateId ||
          existing.request_digest !== prepared.requestDigest ||
          existing.provider_plan_digest !== prepared.providerPlanDigest ||
          (existing.provider_idempotency_strength ?? "none") !==
            (prepared.providerIdempotencyStrength ?? "none") ||
          existing.first_outbound_header_name !==
            (prepared.firstOutboundIdempotencyHeaderName ?? null)
            ? "conflict"
            : existing.finalized
              ? "duplicate_finalized"
              : "duplicate_pending";
        return Object.freeze({
          kind,
          logicalRequestId: existing.logical_request_id
        });
      }
      if (prepared) {
        const event = await this.insertProviderUsageLifecycleEvent(client, {
          tenantId,
          reservationId,
          logicalRequestId: prepared.logicalRequestId,
          id: providerUsageLifecycleId(prepared.logicalRequestId, "prepared", "1"),
          type: "prepared",
          payload: {
            schemaVersion: 1,
            intent: prepared,
            runId,
            candidateId,
            workerId,
            claimDigest: association.claimDigest,
            receiptDigest: association.receiptDigest
          },
          now: prepared.preparedAt
        });
        await this.appendOutbox(client, {
          tenantId,
          aggregateType: "provider_usage_request",
          aggregateId: prepared.logicalRequestId,
          eventType: "provider_usage.prepared",
          payload: {
            runId,
            candidateId,
            reservationId,
            preparedEventDigest: event.digest,
            recoveryRequired: true
          },
          now: prepared.preparedAt
        });
      }
      return reserved;
    });
  }

  /** The transaction commit is the authority boundary immediately preceding
   * a provider fetch. A replay/cache delivery deliberately never calls this. */
  async markProviderUsageAttemptDispatchStarted(
    association: TrustedProxyUsageAssociation,
    value: ProviderUsageDispatchIntent
  ): Promise<void> {
    if (!association.reservationId) {
      throw new TypeError("enterprise provider dispatch has no reservation");
    }
    const tenantId = identifier(association.tenantId, "usage.tenantId");
    const reservationId = identifier(
      association.reservationId,
      "usage.reservationId"
    );
    const intent = providerUsageDispatchIntent(value);
    if (intent.logicalRequestId !== reservationId) {
      throw new TypeError("enterprise provider dispatch intent is inconsistent");
    }
    await this.transaction(async (client) => {
      // Global lock order is run -> reservation. Holding the run share lock
      // prevents reclaim while dispatch truth is committed.
      const activeClaim = await client.query<{
        status: RunJobQueueStatus;
        owner_id: string | null;
        claim_token_hash: string | null;
        claim_expires_at: Date | null;
        dispatch_now: Date;
      }>(`
        SELECT status,owner_id,claim_token_hash,claim_expires_at,
          clock_timestamp() AS dispatch_now
        FROM mn_run_jobs WHERE tenant_id=$1 AND run_id=$2 FOR SHARE
      `, [tenantId, association.runId]);
      const claim = activeClaim.rows[0];
      if (
        !claim ||
        claim.status !== "running" ||
        claim.owner_id !== association.workerId ||
        claim.claim_token_hash !== association.claimDigest ||
        !claim.claim_expires_at ||
        claim.claim_expires_at.getTime() <= claim.dispatch_now.getTime() ||
        Date.parse(association.expiresAt) <= claim.dispatch_now.getTime()
      ) {
        throw new Error("provider dispatch is not bound to the current active claim");
      }
      const reservation = await client.query<PendingProviderUsageReservationRow>(`
        SELECT r.* FROM mn_provider_usage_reservations r
        WHERE tenant_id=$1 AND reservation_id=$2
        FOR UPDATE
      `, [tenantId, reservationId]);
      // The reservation lock may have blocked beyond the claim or receipt
      // expiry even though the earlier run-row snapshot was valid. Use a fresh
      // database clock only after both locks are held; a stale worker must
      // never commit dispatch truth and proceed upstream.
      const freshClock = await client.query<{ dispatch_now: Date }>(`
        SELECT clock_timestamp() AS dispatch_now
      `);
      const dispatchNow = freshClock.rows[0]!.dispatch_now;
      if (
        !claim.claim_expires_at ||
        claim.claim_expires_at.getTime() <= dispatchNow.getTime() ||
        Date.parse(association.expiresAt) <= dispatchNow.getTime()
      ) {
        throw new Error("provider dispatch is not bound to the current active claim");
      }
      const row = reservation.rows[0];
      if (
        !row ||
        row.logical_request_id !== intent.logicalRequestId ||
        row.request_digest !== intent.requestDigest ||
        sha256Canonical(row.payload) !== sha256Canonical(association) ||
        (intent.attemptIndex === 1 &&
          (row.first_outbound_header_name !==
            (intent.outboundIdempotencyHeaderName ?? null) ||
            row.first_outbound_key_digest !==
              (intent.outboundIdempotencyKeyDigest ?? null)))
      ) {
        throw new Error("provider dispatch has no matching prepared request");
      }
      const terminal = await client.query<{ present: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM mn_provider_usage
          WHERE tenant_id=$1 AND reservation_id=$2 AND reservation_finalized
        ) AS present
      `, [tenantId, reservationId]);
      if (terminal.rows[0]?.present) {
        throw new Error("provider dispatch cannot follow request terminal evidence");
      }
      const unknown = await client.query<{ present: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM mn_provider_usage_lifecycle_events
          WHERE tenant_id=$1 AND reservation_id=$2
            AND event_type='attempt_unknown' AND attempt_index=$3
        ) AS present
      `, [tenantId, reservationId, intent.attemptIndex]);
      if (unknown.rows[0]?.present) {
        throw new Error(
          "provider dispatch cannot retry an unknown attempt without recovery authority"
        );
      }
      const attempts = await client.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM mn_provider_usage
        WHERE tenant_id=$1 AND reservation_id=$2
      `, [tenantId, reservationId]);
      if (Number(attempts.rows[0]?.count ?? "0") !== intent.attemptIndex - 1) {
        throw new Error("provider dispatch attempt order is inconsistent");
      }
      const event = await this.insertProviderUsageLifecycleEvent(client, {
        tenantId,
        reservationId,
        logicalRequestId: intent.logicalRequestId,
        id: providerUsageLifecycleId(
          intent.logicalRequestId,
          "attempt_dispatch_started",
          String(intent.attemptIndex)
        ),
        type: "attempt_dispatch_started",
        attemptIndex: intent.attemptIndex,
        payload: { ...intent },
        now: intent.startedAt
      });
      await this.appendOutbox(client, {
        tenantId,
        aggregateType: "provider_usage_request",
        aggregateId: intent.logicalRequestId,
        eventType: "provider_usage.attempt_dispatch_started",
        payload: {
          runId: association.runId,
          attemptIndex: intent.attemptIndex,
          providerId: intent.providerId,
          providerAccountId: intent.providerAccountId,
          ...(intent.outboundIdempotencyKeyDigest
            ? {
                outboundRequestKeyDigest: intent.outboundIdempotencyKeyDigest,
                outboundIdempotencyKeyDigest: intent.outboundIdempotencyKeyDigest
              }
            : {}),
          dispatchEventDigest: event.digest
        },
        now: intent.startedAt
      });
    });
  }

  /** Persist an ambiguous post-dispatch result without manufacturing zero usage. */
  async markProviderUsageAttemptUnknown(
    association: TrustedProxyUsageAssociation,
    value: ProviderUsageUnknownIntent
  ): Promise<void> {
    if (!association.reservationId) {
      throw new TypeError("enterprise provider unknown attempt has no reservation");
    }
    const tenantId = identifier(association.tenantId, "usage.tenantId");
    const reservationId = identifier(
      association.reservationId,
      "usage.reservationId"
    );
    const dispatch = providerUsageDispatchIntent(value);
    const reasons = new Set<ProviderUsageUnknownIntent["reason"]>([
      "timeout",
      "connection_error",
      "response_read_error",
      "response_conversion_error",
      "stream_interrupted",
      "unverified_failure_response",
      "unverified_success_response",
      "partial_usage"
    ]);
    if (!reasons.has(value.reason) || dispatch.logicalRequestId !== reservationId) {
      throw new TypeError("enterprise provider unknown intent is inconsistent");
    }
    const intent: ProviderUsageUnknownIntent = Object.freeze({
      ...dispatch,
      reason: value.reason,
      observedAt: timestamp(value.observedAt, "usage.unknown.observedAt"),
      ...(value.statusCode === undefined
        ? {}
        : {
            statusCode: nonNegativeInteger(
              value.statusCode,
              "usage.unknown.statusCode"
            )
          })
    });
    if ((intent.statusCode ?? 0) > 999) {
      throw new TypeError("usage.unknown.statusCode must not exceed 999");
    }
    await this.transaction(async (client) => {
      const reservation = await client.query<PendingProviderUsageReservationRow>(`
        SELECT r.* FROM mn_provider_usage_reservations r
        WHERE tenant_id=$1 AND reservation_id=$2
        FOR UPDATE
      `, [tenantId, reservationId]);
      const row = reservation.rows[0];
      if (
        !row ||
        row.logical_request_id !== intent.logicalRequestId ||
        row.request_digest !== intent.requestDigest ||
        sha256Canonical(row.payload) !== sha256Canonical(association)
      ) {
        throw new Error("provider unknown attempt has no matching prepared request");
      }
      const terminal = await client.query<{ present: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM mn_provider_usage
          WHERE tenant_id=$1 AND reservation_id=$2 AND reservation_finalized
        ) AS present
      `, [tenantId, reservationId]);
      if (terminal.rows[0]?.present) {
        throw new Error("provider unknown attempt cannot follow terminal evidence");
      }
      const dispatchRows = await client.query<ProviderUsageLifecycleRow>(`
        SELECT * FROM mn_provider_usage_lifecycle_events
        WHERE tenant_id=$1 AND reservation_id=$2
          AND event_type='attempt_dispatch_started' AND attempt_index=$3
        ORDER BY event_index LIMIT 1
      `, [tenantId, reservationId, intent.attemptIndex]);
      const dispatchPayload = dispatchRows.rows[0]?.payload;
      if (
        !dispatchPayload ||
        dispatchPayload.providerId !== intent.providerId ||
        dispatchPayload.providerAccountId !== intent.providerAccountId ||
        dispatchPayload.model !== intent.model ||
        dispatchPayload.requestDigest !== intent.requestDigest ||
        dispatchPayload.outboundIdempotencyHeaderName !==
          intent.outboundIdempotencyHeaderName ||
        dispatchPayload.outboundIdempotencyKeyDigest !==
          intent.outboundIdempotencyKeyDigest ||
        dispatchPayload.outboundRequestKeyDigest !==
          intent.outboundRequestKeyDigest
      ) {
        throw new Error("provider unknown attempt has no matching dispatch evidence");
      }
      const eventId = providerUsageLifecycleId(
        intent.logicalRequestId,
        "attempt_unknown",
        String(intent.attemptIndex)
      );
      const existing = await client.query<ProviderUsageLifecycleRow>(`
        SELECT * FROM mn_provider_usage_lifecycle_events
        WHERE tenant_id=$1 AND event_id=$2
      `, [tenantId, eventId]);
      const event = await this.insertProviderUsageLifecycleEvent(client, {
        tenantId,
        reservationId,
        logicalRequestId: intent.logicalRequestId,
        id: eventId,
        type: "attempt_unknown",
        attemptIndex: intent.attemptIndex,
        payload: { ...intent },
        now: intent.observedAt
      });
      if (existing.rows.length > 0) return;
      await this.appendOutbox(client, {
        tenantId,
        aggregateType: "provider_usage_request",
        aggregateId: intent.logicalRequestId,
        eventType: "provider_usage.attempt_unknown",
        payload: {
          runId: association.runId,
          attemptIndex: intent.attemptIndex,
          providerId: intent.providerId,
          providerAccountId: intent.providerAccountId,
          reason: intent.reason,
          ...(intent.statusCode === undefined ? {} : { statusCode: intent.statusCode }),
          unknownEventDigest: event.digest
        },
        now: intent.observedAt
      });
    });
  }

  /** PostgreSQL is the append-only enterprise source of truth, avoiding
   * FileLocalStore read-modify-write races and pagination loss. */
  async appendProviderUsageLog(
    log: ProxyRequestLog | ProviderUsageAttemptLog,
    journalRef?: ProviderUsageTerminalJournalRef
  ): Promise<void> {
    const association = log.trustedAssociation;
    if (!association || association.schemaVersion !== 1 || association.issuer !== "mn-api") {
      throw new TypeError("enterprise provider usage requires a trusted association");
    }
    const tenantId = identifier(association.tenantId, "usage.tenantId");
    const runId = identifier(association.runId, "usage.runId");
    const candidateId = identifier(association.candidateId, "usage.candidateId");
    const workerId = identifier(association.workerId, "usage.workerId");
    const requestId = identifier(log.id, "usage.requestId");
    const createdAt = timestamp(log.createdAt, "usage.createdAt");
    const verifiedAt = timestamp(association.verifiedAt, "usage.verifiedAt");
    const issuedAt = timestamp(association.issuedAt, "usage.issuedAt");
    const expiresAt = timestamp(association.expiresAt, "usage.expiresAt");
    if (!association.reservationId) {
      throw new TypeError("enterprise provider usage has no reservation");
    }
    const reservationId = identifier(association.reservationId, "usage.reservationId");
    const hasExplicitAttempt =
      (log as Partial<ProviderUsageAttemptLog>).usageAttempt !== undefined;
    const attempt = normalizeProviderUsageAttempt(log);
    if (
      !/^[a-f0-9]{64}$/u.test(association.claimDigest) ||
      !/^[a-f0-9]{64}$/u.test(association.receiptDigest) ||
      log.runId !== runId ||
      log.candidateId !== candidateId ||
      (hasExplicitAttempt && attempt.logicalRequestId !== reservationId) ||
      verifiedAt < issuedAt ||
      verifiedAt >= expiresAt
    ) {
      throw new TypeError("enterprise provider usage association is inconsistent");
    }
    const payload = JSON.parse(JSON.stringify(log)) as ProxyRequestLog;
    if (journalRef && journalRef.payloadDigest !== sha256Canonical(payload)) {
      throw new TypeError("provider usage terminal journal does not bind the exact payload");
    }
    await this.transaction(async (client) => {
      const checkpoint = journalRef?.revocationCheckpoint;
      if (checkpoint) {
        if (
          checkpoint.tenantId !== tenantId ||
          checkpoint.runId !== runId ||
          checkpoint.candidateId !== candidateId ||
          checkpoint.reservationId !== reservationId ||
          checkpoint.logicalRequestId !== attempt.logicalRequestId ||
          checkpoint.attemptIndex !== attempt.index ||
          checkpoint.requestId !== requestId ||
          checkpoint.journalObjectKey !== journalRef.objectKey ||
          checkpoint.journalObjectDigest !== journalRef.digest ||
          checkpoint.payloadDigest !== journalRef.payloadDigest
        ) {
          throw new Error("provider usage journal revocation checkpoint binding is invalid");
        }
        const approval = await client.query<{
          payload: AuditEvent;
          actor_id: string;
          policy_decision: string;
          result: string;
          occurred_at: Date;
          after_digest: string | null;
        }>(`
          SELECT payload,actor_id,policy_decision,result,occurred_at,after_digest
          FROM mn_audit_events
          WHERE tenant_id=$1 AND id=$2
        `, [tenantId, checkpoint.approvalAuditEventId]);
        const audit = approval.rows[0];
        if (
          !audit ||
          audit.actor_id !== checkpoint.approvedBy ||
          audit.policy_decision !== "allow" ||
          audit.result !== "success" ||
          audit.occurred_at.toISOString() !== checkpoint.approvedAt ||
          sha256Canonical(audit.payload) !== checkpoint.approvalAuditDigest ||
          audit.after_digest !== checkpoint.evidenceDigest
        ) {
          throw new Error("provider usage journal revocation checkpoint has no matching approval audit");
        }
      }
      const reservation = await client.query<PendingProviderUsageReservationRow>(`
        SELECT * FROM mn_provider_usage_reservations
        WHERE tenant_id=$1 AND reservation_id=$2
        FOR UPDATE
      `, [tenantId, reservationId]);
      const reservationRow = reservation.rows[0];
      const authorized = reservationRow?.payload;
      if (
        !authorized ||
        sha256Canonical(authorized) !== sha256Canonical(association)
      ) {
        throw new Error("provider usage has no matching preauthorized reservation");
      }
      if (reservationRow.logical_request_id !== null) {
        if (
          attempt.logicalRequestId !== reservationRow.logical_request_id ||
          requestId !== providerUsageAttemptLogId(
            attempt.logicalRequestId,
            attempt.index
          )
        ) {
          throw new Error("provider usage attempt has no stable prepared identity");
        }
        const dispatch = await client.query<ProviderUsageLifecycleRow>(`
          SELECT * FROM mn_provider_usage_lifecycle_events
          WHERE tenant_id=$1 AND reservation_id=$2
            AND event_type='attempt_dispatch_started' AND attempt_index=$3
          ORDER BY event_index LIMIT 1
        `, [tenantId, reservationId, attempt.index]);
        if (log.replayed === true) {
          if (
            dispatch.rows.length > 0 ||
            log.inputTokens !== 0 ||
            log.outputTokens !== 0 ||
            (log.authoritativeCostUsd ?? 0) !== 0
          ) {
            throw new Error("provider replay usage is inconsistent with dispatch truth");
          }
        } else {
          const dispatchPayload = dispatch.rows[0]?.payload;
          if (
            !dispatchPayload ||
            dispatchPayload.providerId !== log.providerId ||
            dispatchPayload.model !== log.model
          ) {
            throw new Error("provider usage attempt has no matching dispatch evidence");
          }
        }
      }
      const existing = await client.query<ProviderUsageAttemptRow>(`
        SELECT request_id,logical_request_id,attempt_index,
               reservation_finalized,payload,terminal_journal
        FROM mn_provider_usage
        WHERE tenant_id=$1 AND reservation_id=$2
        ORDER BY attempt_index,request_id
      `, [tenantId, reservationId]);
      const duplicate = existing.rows.find((row) => row.request_id === requestId);
      if (duplicate) {
        if (
          duplicate.logical_request_id === attempt.logicalRequestId &&
          duplicate.attempt_index === attempt.index &&
          duplicate.reservation_finalized === attempt.terminal &&
          sha256Canonical(duplicate.payload) === sha256Canonical(payload) &&
          (journalRef === undefined ||
            sha256Canonical(duplicate.terminal_journal) === sha256Canonical(journalRef))
        ) {
          return;
        }
        throw new Error(
          `Provider usage ${requestId} reservation ${reservationId} idempotency conflict`
        );
      }
      if (
        existing.rows.some((row) => row.reservation_finalized) ||
        existing.rows.some((row) => row.logical_request_id !== attempt.logicalRequestId) ||
        existing.rows.some((row) => row.attempt_index === attempt.index) ||
        attempt.index !== existing.rows.length + 1
      ) {
        throw new Error(
          `Provider usage ${requestId} reservation ${reservationId} idempotency conflict: invalid attempt lifecycle`
        );
      }
      const inserted = await client.query(`
        INSERT INTO mn_provider_usage
          (tenant_id,request_id,run_id,candidate_id,worker_id,
           claim_token_hash,receipt_digest,reservation_id,logical_request_id,
           attempt_index,reservation_finalized,verified_at,created_at,payload,
           terminal_journal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
        ON CONFLICT DO NOTHING
      `, [
        tenantId,
        requestId,
        runId,
        candidateId,
        workerId,
        association.claimDigest,
        association.receiptDigest,
        reservationId,
        attempt.logicalRequestId,
        attempt.index,
        attempt.terminal,
        verifiedAt,
        createdAt,
        JSON.stringify(payload),
        journalRef ? JSON.stringify(journalRef) : null
      ]);
      if (inserted.rowCount === 0) {
        throw new Error(
          `Provider usage ${requestId} reservation ${reservationId} idempotency conflict`
        );
      }
      if (reservationRow.logical_request_id !== null) {
        const attemptEvent = await this.insertProviderUsageLifecycleEvent(client, {
          tenantId,
          reservationId,
          logicalRequestId: attempt.logicalRequestId,
          id: providerUsageLifecycleId(
            attempt.logicalRequestId,
            "attempt_terminal",
            String(attempt.index)
          ),
          type: "attempt_terminal",
          attemptIndex: attempt.index,
          payload: {
            schemaVersion: 1,
            usageRequestId: requestId,
            outcome: attempt.outcome,
            retryable: attempt.retryable,
            terminal: attempt.terminal,
            replayed: log.replayed === true,
            usageDigest: sha256Canonical(payload),
            ...(journalRef ? { terminalJournal: journalRef } : {})
          },
          now: createdAt
        });
        if (attempt.terminal) {
          await this.insertProviderUsageLifecycleEvent(client, {
            tenantId,
            reservationId,
            logicalRequestId: attempt.logicalRequestId,
            id: providerUsageLifecycleId(
              attempt.logicalRequestId,
              "request_terminal",
              "provider"
            ),
            type: "request_terminal",
            attemptIndex: attempt.index,
            payload: {
              schemaVersion: 1,
              usageRequestId: requestId,
              outcome: attempt.outcome,
              terminalAttemptEventDigest: attemptEvent.digest,
              ...(journalRef ? { terminalJournal: journalRef } : {})
            },
            now: createdAt
          });
        }
        await this.appendOutbox(client, {
          tenantId,
          aggregateType: "provider_usage_request",
          aggregateId: attempt.logicalRequestId,
          eventType: attempt.terminal
            ? "provider_usage.request_terminal"
            : "provider_usage.attempt_terminal",
          payload: {
            runId,
            usageRequestId: requestId,
            attemptIndex: attempt.index,
            terminal: attempt.terminal,
            attemptEventDigest: attemptEvent.digest,
            ...(journalRef ? { terminalJournal: journalRef } : {})
          },
          now: createdAt
        });
      }
    });
  }

  async readProviderUsageRequest(input: {
    tenantId: string;
    logicalRequestId: string;
    projectIds?: readonly string[];
  }): Promise<ProviderUsageRequestSnapshot | undefined> {
    const tenantId = identifier(input.tenantId, "usage.tenantId");
    const logicalRequestId = identifier(
      input.logicalRequestId,
      "usage.logicalRequestId"
    );
    return this.transaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return this.providerUsageRequestSnapshot(client, {
        tenantId,
        logicalRequestId,
        projectIds: input.projectIds
      });
    });
  }

  /** Human reconciliation is append-only. It can settle only an unknown
   * request with durable dispatch evidence; no-dispatch zero is machine-only. */
  async reconcileProviderUsageRequest(
    input: ReconcileProviderUsageRequestInput
  ): Promise<ProviderUsageReconciliationResult | undefined> {
    const tenantId = identifier(input.tenantId, "usage.tenantId");
    const logicalRequestId = identifier(
      input.logicalRequestId,
      "usage.logicalRequestId"
    );
    const expectedRecoveryDigest = digest(
      input.expectedRecoveryDigest,
      "usage.expectedRecoveryDigest"
    );
    const idempotencyKey = identifier(input.idempotencyKey, "usage.idempotencyKey");
    if (idempotencyKey.length > 512) {
      throw new TypeError("usage.idempotencyKey is too long");
    }
    const actorId = identifier(input.actorId, "usage.actorId");
    const traceId = identifier(input.traceId, "usage.traceId");
    const reason = identifier(input.reason, "usage.reason");
    const ticket = identifier(input.ticket, "usage.ticket");
    const evidenceUri = identifier(input.evidence.uri, "usage.evidence.uri");
    let parsedEvidenceUri: URL;
    try {
      parsedEvidenceUri = new URL(evidenceUri);
    } catch (error) {
      throw new TypeError("usage.evidence.uri must be an absolute URL", { cause: error });
    }
    if (parsedEvidenceUri.protocol !== "s3:") {
      throw new TypeError("usage.evidence.uri must use the configured s3 store");
    }
    const evidence = Object.freeze({
      uri: evidenceUri,
      sha256: digest(input.evidence.sha256, "usage.evidence.sha256"),
      kind: input.evidence.kind,
      verification: Object.freeze({
        objectKey: identifier(
          input.evidence.verification.objectKey,
          "usage.evidence.verification.objectKey"
        ),
        byteLength: nonNegativeInteger(
          input.evidence.verification.byteLength,
          "usage.evidence.verification.byteLength"
        ),
        verifiedAt: timestamp(
          input.evidence.verification.verifiedAt,
          "usage.evidence.verification.verifiedAt"
        ),
        verificationDigest: digest(
          input.evidence.verification.verificationDigest,
          "usage.evidence.verification.verificationDigest"
        ),
        ...(input.evidence.verification.envelopeDigest
          ? {
              envelopeDigest: digest(
                input.evidence.verification.envelopeDigest,
                "usage.evidence.verification.envelopeDigest"
              )
            }
          : {}),
        ...(input.evidence.verification.sourceReference
          ? {
              sourceReference: identifier(
                input.evidence.verification.sourceReference,
                "usage.evidence.verification.sourceReference"
              )
            }
          : {}),
        ...(input.evidence.verification.issuedAt
          ? {
              issuedAt: timestamp(
                input.evidence.verification.issuedAt,
                "usage.evidence.verification.issuedAt"
              )
            }
          : {}),
        ...(input.evidence.verification.issuer
          ? {
              issuer: identifier(
                input.evidence.verification.issuer,
                "usage.evidence.verification.issuer"
              )
            }
          : {}),
        ...(input.evidence.verification.keyId
          ? {
              keyId: identifier(
                input.evidence.verification.keyId,
                "usage.evidence.verification.keyId"
              )
            }
          : {}),
        ...(input.evidence.verification.signatureDigest
          ? {
              signatureDigest: digest(
                input.evidence.verification.signatureDigest,
                "usage.evidence.verification.signatureDigest"
              )
            }
          : {}),
        ...(input.evidence.verification.providerAccountId
          ? {
              providerAccountId: identifier(
                input.evidence.verification.providerAccountId,
                "usage.evidence.verification.providerAccountId"
              )
            }
          : {}),
        ...(input.evidence.verification.providerRequestId
          ? {
              providerRequestId: identifier(
                input.evidence.verification.providerRequestId,
                "usage.evidence.verification.providerRequestId"
              )
            }
          : {}),
        ...(input.evidence.verification.dispatchRequestDigest
          ? {
              dispatchRequestDigest: digest(
                input.evidence.verification.dispatchRequestDigest,
                "usage.evidence.verification.dispatchRequestDigest"
              )
            }
          : {}),
        ...(input.evidence.verification.outboundRequestKeyDigest
          ? {
              outboundRequestKeyDigest: digest(
                input.evidence.verification.outboundRequestKeyDigest,
                "usage.evidence.verification.outboundRequestKeyDigest"
              )
            }
          : {})
      })
    });
    if (evidence.kind !== "provider" && evidence.kind !== "invoice") {
      throw new TypeError("usage.evidence.kind must be provider or invoice");
    }
    const decision = input.decision.kind === "exact"
      ? Object.freeze({
          kind: "exact" as const,
          app: managedAgentApp(input.decision.app, "usage.app"),
          providerId: identifier(input.decision.providerId, "usage.providerId"),
          model: identifier(input.decision.model, "usage.model"),
          statusCode: nonNegativeInteger(input.decision.statusCode, "usage.statusCode"),
          inputTokens: nonNegativeInteger(input.decision.inputTokens, "usage.inputTokens"),
          outputTokens: nonNegativeInteger(input.decision.outputTokens, "usage.outputTokens"),
          cachedInputTokens: nonNegativeInteger(
            input.decision.cachedInputTokens ?? 0,
            "usage.cachedInputTokens"
          ),
          cacheCreationInputTokens: nonNegativeInteger(
            input.decision.cacheCreationInputTokens ?? 0,
            "usage.cacheCreationInputTokens"
          ),
          cacheReadInputTokens: nonNegativeInteger(
            input.decision.cacheReadInputTokens ?? 0,
            "usage.cacheReadInputTokens"
          ),
          reasoningOutputTokens: nonNegativeInteger(
            input.decision.reasoningOutputTokens ?? 0,
            "usage.reasoningOutputTokens"
          ),
          authoritativeCostUsd: nonNegativeFinite(
            input.decision.authoritativeCostUsd,
            "usage.authoritativeCostUsd"
          )
        })
      : Object.freeze({ kind: "conservative" as const });
    if (
      decision.kind === "exact" &&
      (!evidence.verification.envelopeDigest ||
        !evidence.verification.issuer ||
        !evidence.verification.keyId ||
        !evidence.verification.signatureDigest ||
        !evidence.verification.providerAccountId ||
        !evidence.verification.providerRequestId ||
        !evidence.verification.dispatchRequestDigest)
    ) {
      throw new TypeError(
        "exact provider usage reconciliation requires trusted signed evidence"
      );
    }
    const now = timestamp(input.now, "usage.reconciliation.now");
    const idempotencyKeyDigest = sha256(idempotencyKey);
    const {
      verifiedAt: _evidenceVerifiedAt,
      ...semanticEvidenceVerification
    } = evidence.verification;
    const reconciliationDigest = sha256Canonical({
      schemaVersion: 1,
      tenantId,
      logicalRequestId,
      expectedRecoveryDigest,
      actorId,
      reason,
      ticket,
      evidence: {
        uri: evidence.uri,
        sha256: evidence.sha256,
        kind: evidence.kind,
        verification: semanticEvidenceVerification
      },
      decision
    });
    const auditId = deterministicUuid(
      `provider-usage-reconcile\0${tenantId}\0${logicalRequestId}\0${idempotencyKeyDigest}`
    );
    return this.transaction(async (client) => {
      let current = await this.providerUsageRequestSnapshot(client, {
        tenantId,
        logicalRequestId,
        projectIds: input.projectIds,
        lock: true
      });
      if (!current) return undefined;
      const duplicate = current.lifecycle.find(
        (event) => event.idempotencyKeyDigest === idempotencyKeyDigest
      );
      if (duplicate) {
        if (duplicate.payload.reconciliationDigest !== reconciliationDigest) {
          throw new ProviderUsageReconciliationConflictError(
            "idempotency_conflict",
            "provider usage reconciliation idempotency conflict"
          );
        }
        const audit = await client.query<{ payload: AuditEvent }>(`
          SELECT payload FROM mn_audit_events WHERE id=$1
        `, [auditId]);
        if (!audit.rows[0]) {
          throw new Error("provider usage reconciliation audit evidence is unavailable");
        }
        return Object.freeze({ request: current, auditEvent: audit.rows[0].payload });
      }
      if (current.recoveryDigest !== expectedRecoveryDigest) {
        throw new ProviderUsageReconciliationConflictError(
          "cas_conflict",
          "provider usage recovery state changed"
        );
      }
      if (current.status !== "pending") {
        throw new ProviderUsageReconciliationConflictError(
          "already_terminal",
          "provider usage request is already terminal"
        );
      }
      const dispatches = current.lifecycle.filter(
        (event) => event.type === "attempt_dispatch_started"
      );
      const accountedAttemptIndexes = new Set(
        current.usageLogs.map((log) =>
          (log as Partial<ProviderUsageAttemptLog>).usageAttempt?.index
        ).filter((index): index is number => index !== undefined)
      );
      const dispatch = dispatches.filter((event) =>
        event.attemptIndex !== undefined &&
        !accountedAttemptIndexes.has(event.attemptIndex)
      ).at(-1);
      const legacyExact =
        current.legacy &&
        !current.prepared &&
        dispatches.length === 0 &&
        current.usageLogs.length === 0 &&
        decision.kind === "exact";
      if (!dispatch?.attemptIndex && !legacyExact) {
        throw new ProviderUsageReconciliationConflictError(
          dispatches.length === 0
            ? "machine_recovery_required"
            : "no_unresolved_dispatch",
          dispatches.length === 0
            ? "provider usage request requires machine pre-dispatch recovery"
            : "provider usage request has no unresolved dispatched attempt"
        );
      }
      if (!current.prepared && !legacyExact) {
        throw new Error("provider usage request has no durable preparation intent");
      }
      if (
        decision.kind === "exact" &&
        dispatch &&
        dispatch.payload.providerId !== decision.providerId
      ) {
        throw new ProviderUsageReconciliationConflictError(
          "provider_mismatch",
          "exact reconciliation provider does not match dispatch evidence"
        );
      }
      if (
        decision.kind === "exact" &&
        current.prepared &&
        decision.app !== current.prepared.app
      ) {
        throw new ProviderUsageReconciliationConflictError(
          "provider_mismatch",
          "exact reconciliation app does not match prepared evidence"
        );
      }
      if (
        legacyExact &&
        evidence.verification.dispatchRequestDigest !== expectedRecoveryDigest
      ) {
        throw new ProviderUsageReconciliationConflictError(
          "provider_mismatch",
          "legacy exact reconciliation does not match recovery evidence"
        );
      }
      if (
        decision.kind === "exact" &&
        dispatch &&
        (evidence.verification.providerAccountId !==
          dispatch.payload.providerAccountId ||
          evidence.verification.dispatchRequestDigest !==
            dispatch.payload.requestDigest ||
          (evidence.verification.outboundRequestKeyDigest ?? null) !==
            (dispatch.payload.outboundIdempotencyKeyDigest ?? null))
      ) {
        throw new ProviderUsageReconciliationConflictError(
          "provider_mismatch",
          "exact reconciliation authority does not match dispatch evidence"
        );
      }
      const associationRow = await client.query<PendingProviderUsageReservationRow>(`
        SELECT * FROM mn_provider_usage_reservations
        WHERE tenant_id=$1 AND reservation_id=$2
      `, [tenantId, current.reservationId]);
      const associationRowValue = associationRow.rows[0];
      if (!associationRowValue) {
        throw new Error("provider usage reservation disappeared during reconciliation");
      }
      const association = Object.freeze({
        ...associationRowValue.payload,
        reservationId: current.reservationId
      });
      const hold = current.prepared?.conservativeHold;
      const providerId = decision.kind === "exact"
        ? decision.providerId
        : String(dispatch!.payload.providerId);
      const model = decision.kind === "exact"
        ? decision.model
        : String(dispatch!.payload.model ?? current.prepared!.model);
      const inputTokens = decision.kind === "exact"
        ? decision.inputTokens
        : hold!.maxTokens;
      const outputTokens = decision.kind === "exact" ? decision.outputTokens : 0;
      const authoritativeCostUsd = decision.kind === "exact"
        ? decision.authoritativeCostUsd
        : hold!.maxCostUsd;
      const attemptIndex = dispatch?.attemptIndex ?? 1;
      const requestId = providerUsageResolutionLogId(
        logicalRequestId,
        "reconciliation"
      );
      const usage: ProviderUsageAttemptLog = {
        id: requestId,
        app: decision.kind === "exact" ? decision.app : current.prepared!.app,
        providerId,
        model,
        inputTokens,
        outputTokens,
        ...(decision.kind === "exact"
          ? {
              cachedInputTokens: decision.cachedInputTokens,
              cacheCreationInputTokens: decision.cacheCreationInputTokens,
              cacheReadInputTokens: decision.cacheReadInputTokens,
              reasoningOutputTokens: decision.reasoningOutputTokens
            }
          : {}),
        authoritativeCostUsd,
        statusCode: decision.kind === "exact" ? decision.statusCode : 599,
        latencyMs: 0,
        runId: current.runId,
        candidateId: current.candidateId,
        trustedAssociation: association,
        usageResolution: {
          kind: decision.kind,
          evidenceUri: evidence.uri,
          evidenceSha256: evidence.sha256,
          evidenceKind: evidence.kind,
          reason,
          ticket,
          basisDigest: decision.kind === "conservative"
            ? hold!.basisDigest
            : evidence.sha256,
          ...(decision.kind === "conservative" ? { requiresBudgetStop: true } : {})
        },
        usageAttempt: {
          schemaVersion: 1,
          logicalRequestId,
          index: attemptIndex,
          terminal: true,
          outcome:
            decision.kind === "exact" &&
            decision.statusCode >= 200 &&
            decision.statusCode < 400
              ? "succeeded"
              : "failed",
          retryable: false
        },
        createdAt: now
      };
      await client.query(`
        INSERT INTO mn_provider_usage
          (tenant_id,request_id,run_id,candidate_id,worker_id,
           claim_token_hash,receipt_digest,reservation_id,logical_request_id,
           attempt_index,reservation_finalized,verified_at,created_at,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$12,$13::jsonb)
      `, [
        tenantId,
        requestId,
        current.runId,
        current.candidateId,
        association.workerId,
        association.claimDigest,
        association.receiptDigest,
        current.reservationId,
        logicalRequestId,
        attemptIndex,
        association.verifiedAt,
        now,
        JSON.stringify(usage)
      ]);
      const reconcileEvent = await this.insertProviderUsageLifecycleEvent(client, {
        tenantId,
        reservationId: current.reservationId,
        logicalRequestId,
        id: providerUsageLifecycleId(
          logicalRequestId,
          "reconciled",
          idempotencyKeyDigest
        ),
        type: "reconciled",
        attemptIndex,
        idempotencyKeyDigest,
        payload: {
          schemaVersion: 1,
          reconciliationDigest,
          decision,
          reason,
          ticket,
          evidence,
          usageRequestId: requestId,
          beforeDigest: current.recoveryDigest,
          basisDigest: usage.usageResolution!.basisDigest
        },
        now
      });
      await this.insertProviderUsageLifecycleEvent(client, {
        tenantId,
        reservationId: current.reservationId,
        logicalRequestId,
        id: providerUsageLifecycleId(
          logicalRequestId,
          "request_terminal",
          "reconciliation"
        ),
        type: "request_terminal",
        attemptIndex,
        payload: {
          schemaVersion: 1,
          usageRequestId: requestId,
          reconciliationEventDigest: reconcileEvent.digest,
          outcome: usage.usageAttempt.outcome
        },
        now
      });
      current = (await this.providerUsageRequestSnapshot(client, {
        tenantId,
        logicalRequestId,
        projectIds: input.projectIds
      }))!;
      const audit: AuditEvent = {
        id: auditId,
        tenantId,
        actorId,
        action: "provider_usage.reconcile",
        resourceType: "provider_usage_request",
        resourceId: logicalRequestId,
        projectId: current.projectId,
        policyDecision: "allow",
        beforeDigest: expectedRecoveryDigest,
        afterDigest: current.recoveryDigest,
        traceId,
        result: "success",
        timestamp: now,
        statusCode: 200,
        evidence,
        basisDigest: usage.usageResolution!.basisDigest,
        reason,
        ticket
      };
      await this.insertAuditEvent(client, audit, false);
      await this.appendOutbox(client, {
        tenantId,
        aggregateType: "provider_usage_request",
        aggregateId: logicalRequestId,
        eventType: "provider_usage.reconciled",
        payload: {
          runId: current.runId,
          projectId: current.projectId,
          decision: decision.kind,
          usageRequestId: requestId,
          beforeDigest: expectedRecoveryDigest,
          afterDigest: current.recoveryDigest,
          evidenceSha256: evidence.sha256,
          basisDigest: usage.usageResolution!.basisDigest,
          auditEventId: audit.id
        },
        now
      });
      return Object.freeze({ request: current, auditEvent: audit });
    });
  }

  /** One repeatable-read snapshot for every authoritative budget decision.
   * Reservations remain pending across retry attempts until a terminal row
   * exists; claim release, expiry, or reclaim does not filter them out. */
  async readProviderUsageAccounting(input: {
    tenantId: string;
    runId: string;
  }): Promise<ProviderUsageAccountingSnapshot> {
    const tenantId = identifier(input.tenantId, "usage.tenantId");
    const runId = identifier(input.runId, "usage.runId");
    return this.transaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const usage = await client.query<{ payload: ProxyRequestLog }>(`
        SELECT payload FROM mn_provider_usage
        WHERE tenant_id=$1 AND run_id=$2
        ORDER BY created_at,request_id
      `, [tenantId, runId]);
      const pendingReservations = await pendingProviderUsageReservations(
        client,
        tenantId,
        runId
      );
      const finalizedReservations = await finalizedProviderUsageReservations(
        client,
        tenantId,
        runId
      );
      return Object.freeze({
        schemaVersion: 1 as const,
        tenantId,
        runId,
        usageLogs: Object.freeze(usage.rows.map(({ payload }) => payload)),
        pendingReservations: Object.freeze(pendingReservations),
        finalizedReservations: Object.freeze(finalizedReservations)
      });
    });
  }

  /** Tenant-scoped enterprise read model for usage/audit surfaces. Pending
   * reservations cannot be attributed to app/provider until finalization, so
   * those filters apply only to finalized logs and never hide unresolved cost. */
  async queryProviderUsageAccounting(input: {
    tenantId: string;
    app?: string;
    providerId?: string;
    runId?: string;
    candidateId?: string;
    projectIds?: readonly string[];
    limit?: number;
  }): Promise<ProviderUsageAccountingQuerySnapshot> {
    const tenantId = identifier(input.tenantId, "usage.tenantId");
    const app = input.app === undefined ? null : identifier(input.app, "usage.app");
    const providerId = input.providerId === undefined
      ? null
      : identifier(input.providerId, "usage.providerId");
    const runId = input.runId === undefined
      ? null
      : identifier(input.runId, "usage.runId");
    const candidateId = input.candidateId === undefined
      ? null
      : identifier(input.candidateId, "usage.candidateId");
    const projectIds = input.projectIds === undefined || input.projectIds.length === 0
      ? null
      : [...new Set(input.projectIds.map((projectId) =>
          identifier(projectId, "usage.projectId")
        ))];
    const limit = usageQueryLimit(input.limit);
    return this.transaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const usage = await client.query<{ payload: ProxyRequestLog }>(`
        SELECT u.payload FROM mn_provider_usage u
        INNER JOIN mn_run_jobs j
          ON j.tenant_id=u.tenant_id AND j.run_id=u.run_id
        WHERE u.tenant_id=$1
          AND ($2::text IS NULL OR u.run_id=$2)
          AND ($3::text IS NULL OR u.candidate_id=$3)
          AND ($4::text IS NULL OR u.payload->>'app'=$4)
          AND ($5::text IS NULL OR u.payload->>'providerId'=$5)
          AND ($7::text[] IS NULL OR j.project_id=ANY($7::text[]))
        ORDER BY u.created_at DESC,u.request_id DESC
        LIMIT $6
      `, [tenantId, runId, candidateId, app, providerId, limit, projectIds]);
      const pending = await client.query<PendingProviderUsageReservationQueryRow>(`
        SELECT
          r.reservation_id,r.tenant_id,r.run_id,r.candidate_id,r.worker_id,
          r.claim_token_hash,r.receipt_digest,r.verified_at,r.expires_at,
          count(*) OVER()::text AS pending_count
        FROM mn_provider_usage_reservations r
        INNER JOIN mn_run_jobs j
          ON j.tenant_id=r.tenant_id AND j.run_id=r.run_id
        WHERE r.tenant_id=$1
          AND ($2::text IS NULL OR r.run_id=$2)
          AND ($3::text IS NULL OR r.candidate_id=$3)
          AND ($5::text[] IS NULL OR j.project_id=ANY($5::text[]))
          AND NOT EXISTS (
            SELECT 1 FROM mn_provider_usage u
            WHERE u.tenant_id=r.tenant_id
              AND u.run_id=r.run_id
              AND u.reservation_id=r.reservation_id
              AND u.reservation_finalized
          )
        ORDER BY r.verified_at DESC,r.reservation_id DESC
        LIMIT $4
      `, [tenantId, runId, candidateId, limit, projectIds]);
      const pendingReservations = pending.rows.map((row) => Object.freeze({
        schemaVersion: 1 as const,
        status: "pending" as const,
        tenantId: row.tenant_id,
        reservationId: row.reservation_id,
        runId: row.run_id,
        candidateId: row.candidate_id,
        workerId: row.worker_id,
        claimDigest: row.claim_token_hash,
        receiptDigest: row.receipt_digest,
        verifiedAt: row.verified_at.toISOString(),
        expiresAt: row.expires_at.toISOString()
      }));
      const pendingReservationCount = pending.rows[0]
        ? Number(pending.rows[0].pending_count)
        : 0;
      if (!Number.isSafeInteger(pendingReservationCount) || pendingReservationCount < 0) {
        throw new Error("provider usage pending reservation count is invalid");
      }
      return Object.freeze({
        schemaVersion: 1 as const,
        tenantId,
        usageLogs: Object.freeze(usage.rows.map(({ payload }) => payload)),
        pendingReservations: Object.freeze(pendingReservations),
        pendingReservationCount
      });
    });
  }

  /** Unpaginated authoritative read used only for budget accounting. */
  async listProviderUsageLogs(input: {
    tenantId: string;
    runId: string;
  }): Promise<ProxyRequestLog[]> {
    const tenantId = identifier(input.tenantId, "usage.tenantId");
    const runId = identifier(input.runId, "usage.runId");
    const result = await this.pool.query<{ payload: ProxyRequestLog }>(`
      SELECT payload FROM mn_provider_usage
      WHERE tenant_id=$1 AND run_id=$2
      ORDER BY created_at,request_id
    `, [tenantId, runId]);
    return result.rows.map(({ payload }) => payload);
  }

  async readStateSnapshot(): Promise<EnterpriseStateSnapshot> {
    return this.transaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const metadata = await client.query<{
          tenant_id: string;
          kind: string;
          id: string;
          version: string;
          digest: string;
          payload: Record<string, unknown>;
          created_at: Date;
          updated_at: Date;
        }>(`
          SELECT tenant_id,kind,id,version,digest,payload,created_at,updated_at
          FROM mn_metadata ORDER BY tenant_id,kind,id
        `);
      const runJobs = await client.query<RunJobRow>(
        "SELECT * FROM mn_run_jobs ORDER BY created_at,run_id"
      );
      const audits = await client.query<{ payload: AuditEvent }>(`
        SELECT payload FROM mn_audit_events ORDER BY occurred_at,id
      `);
      return {
        metadata: metadata.rows.map(metadataFromRow),
        runJobs: runJobs.rows.map((row) => {
          assertCheckpointIntegrity(row);
          return {
            item: itemFromRow(row),
            payload: row.payload,
            checkpointDigest: row.checkpoint_digest
          };
        }),
        auditEvents: audits.rows.map((row) => row.payload)
      };
    });
  }

  private async appendOutbox(
    client: PoolClient,
    input: {
      tenantId: string;
      aggregateType: string;
      aggregateId: string;
      eventType: string;
      payload: Readonly<Record<string, unknown>>;
      now: string;
    }
  ): Promise<void> {
    await client.query(`
      INSERT INTO mn_outbox
        (id,tenant_id,aggregate_type,aggregate_id,event_type,payload,created_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
    `, [
      randomUUID(),
      input.tenantId,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      JSON.stringify(input.payload),
      input.now
    ]);
  }
}
