// SPDX-License-Identifier: Apache-2.0

import type {
  EventAppendRequest,
  EventPage,
  JsonObject,
  JsonValue,
  KernelEventV1
} from "@mn/contracts";

export interface ProjectionWrite {
  readonly tenantId: string;
  readonly namespace: string;
  readonly key: string;
  readonly value: JsonObject;
  readonly streamVersion: number;
}

export interface JobWrite {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId?: string;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly availableAt: string;
  readonly idempotencyKey: string;
}

export interface StoredJob extends JobWrite {
  readonly status: "available" | "leased" | "completed" | "failed";
  readonly attempts: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly fencingToken: number;
  readonly result?: JsonValue;
  readonly failure?: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OutboxWrite {
  readonly id: string;
  readonly tenantId: string;
  readonly topic: string;
  readonly payload: JsonObject;
  readonly availableAt?: string;
}

export interface StoredOutboxMessage extends OutboxWrite {
  readonly availableAt: string;
  readonly createdAt: string;
}

export interface ApprovalWrite {
  readonly tenantId: string;
  readonly id: string;
  readonly executionId: string;
  readonly status: "pending" | "approved_once" | "denied" | "expired";
  readonly value: JsonObject;
}

export interface StoredApproval extends ApprovalWrite {
  readonly updatedAt: string;
}

export interface IdempotencyWrite {
  readonly tenantId: string;
  readonly key: string;
  readonly requestHash: string;
}

export interface StorageCommit {
  readonly event?: EventAppendRequest;
  readonly projections?: readonly ProjectionWrite[];
  readonly jobs?: readonly JobWrite[];
  readonly outbox?: readonly OutboxWrite[];
  readonly approvals?: readonly ApprovalWrite[];
  readonly idempotency?: IdempotencyWrite;
}

export interface StorageCommitResult {
  readonly event?: KernelEventV1;
  readonly replayed: boolean;
}

export interface EventReadOptions {
  readonly afterPosition: number;
  readonly limit: number;
}

export interface JobClaimOptions {
  readonly tenantId?: string;
  readonly kinds?: readonly string[];
}

export interface NeedsReconciliationInput {
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly occurredAt: string;
}

export interface StoragePort {
  initialize(): Promise<void>;
  commit(batch: StorageCommit): Promise<StorageCommitResult>;
  readEvents(tenantId: string, options: EventReadOptions): Promise<EventPage>;
  advanceRetentionFloor(tenantId: string, floorPosition: number): Promise<void>;
  getProjection(tenantId: string, namespace: string, key: string): Promise<JsonObject | undefined>;
  listOutbox(tenantId: string, limit: number): Promise<readonly StoredOutboxMessage[]>;
  getApproval(tenantId: string, id: string): Promise<StoredApproval | undefined>;
  claimJob(workerId: string, now: string, options?: JobClaimOptions): Promise<StoredJob | undefined>;
  renewJobLease(jobId: string, workerId: string, fencingToken: number, now: string): Promise<void>;
  completeJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    result: JsonValue,
    now: string
  ): Promise<void>;
  failJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    failure: JsonObject,
    now: string
  ): Promise<void>;
  interruptJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    reason: string,
    now: string
  ): Promise<void>;
  markNeedsReconciliation(executionId: string, input: NeedsReconciliationInput): Promise<void>;
  getJob(jobId: string): Promise<StoredJob | undefined>;
  close(): Promise<void>;
}

/**
 * Structural bridge used by packages/kernel. It is declared here instead of
 * importing the kernel package, so the storage layer remains below the kernel.
 */
export interface KernelIdempotencyRecordLike {
  readonly tenantId: string;
  readonly scope: string;
  readonly key: string;
  readonly requestDigest: string;
  readonly response: unknown;
  readonly createdAt: string;
}

export interface KernelTransactionLike {
  appendEvent(request: EventAppendRequest): KernelEventV1;
  getProjection<T>(namespace: string, id: string): T | undefined;
  listProjections<T>(namespace: string): readonly T[];
  putProjection<T>(namespace: string, id: string, value: T): void;
  deleteProjection(namespace: string, id: string): void;
  getIdempotency(scope: string, key: string): KernelIdempotencyRecordLike | undefined;
  putIdempotency(record: KernelIdempotencyRecordLike): void;
  putJob(job: JobWrite): void;
  putOutbox(message: OutboxWrite): void;
  assertJobLease?(input: {
    readonly jobId: string;
    readonly workerId: string;
    readonly fencingToken: number;
    readonly occurredAt: string;
  }): void;
}

export interface KernelStoreCompatible {
  transact<T>(tenantId: string, work: (transaction: KernelTransactionLike) => T): Promise<T>;
  readEvents(tenantId: string, afterPosition: number, limit: number): Promise<EventPage>;
  listTenantIds?(): Promise<readonly string[]>;
}

export class StreamVersionConflictError extends Error {
  readonly code = "STREAM_VERSION_CONFLICT";

  constructor(
    readonly tenantId: string,
    readonly aggregateType: string,
    readonly aggregateId: string,
    readonly expected: number,
    readonly actual: number
  ) {
    super(`Expected stream version ${expected}, but found ${actual}`);
    this.name = "StreamVersionConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(readonly tenantId: string, readonly key: string) {
    super(`Idempotency key ${key} was already used with a different request`);
    this.name = "IdempotencyConflictError";
  }
}

export class CursorExpiredError extends Error {
  readonly code = "EVENT_CURSOR_EXPIRED";

  constructor(readonly tenantId: string, readonly retentionFloor: number) {
    super(`Event cursor is older than retention floor ${retentionFloor}`);
    this.name = "CursorExpiredError";
  }
}

export class StaleFencingTokenError extends Error {
  readonly code = "STALE_FENCING_TOKEN";

  constructor(readonly jobId: string) {
    super(`Worker no longer owns job ${jobId}`);
    this.name = "StaleFencingTokenError";
  }
}

export const JOB_LEASE_MILLISECONDS = 30_000;
