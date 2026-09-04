// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EventAppendRequest, JsonObject, JsonValue, KernelEventV1 } from "@mn/contracts";

import { computeEventDigest, computeEventHmac } from "./integrity.js";
import {
  CursorExpiredError,
  IdempotencyConflictError,
  JOB_LEASE_MILLISECONDS,
  StaleFencingTokenError,
  StreamVersionConflictError,
  type EventReadOptions,
  type JobClaimOptions,
  type KernelIdempotencyRecordLike,
  type KernelTransactionLike,
  type NeedsReconciliationInput,
  type StorageCommit,
  type StorageCommitResult,
  type StoragePort,
  type StoredApproval,
  type StoredJob,
  type StoredOutboxMessage
} from "./types.js";

export interface SqliteStorageOptions {
  readonly databaseFile: string;
  readonly hmacKey: Uint8Array;
  readonly now?: () => Date;
}

type RecordRow = Record<string, unknown>;

const SQLITE_SCHEMA = `
  create table if not exists storage_meta (
    key text primary key,
    value text not null
  ) strict, without rowid;

  create table if not exists tenant_heads (
    tenant_id text primary key,
    next_position integer not null check (next_position >= 1),
    previous_digest text,
    retention_floor integer not null default 1 check (retention_floor >= 1)
  ) strict, without rowid;

  create table if not exists stream_heads (
    tenant_id text not null,
    aggregate_type text not null,
    aggregate_id text not null,
    stream_version integer not null check (stream_version >= 0),
    primary key (tenant_id, aggregate_type, aggregate_id)
  ) strict, without rowid;

  create table if not exists events (
    tenant_id text not null,
    position integer not null,
    event_id text not null unique,
    aggregate_type text not null,
    aggregate_id text not null,
    stream_version integer not null,
    event_type text not null,
    occurred_at text not null,
    actor_id text not null,
    execution_id text,
    generation integer not null,
    causation_id text,
    correlation_id text not null,
    public_payload text not null check (json_valid(public_payload)),
    protected_payload_ref text,
    previous_digest text,
    digest text not null,
    hmac text not null,
    primary key (tenant_id, position),
    unique (tenant_id, aggregate_type, aggregate_id, stream_version)
  ) strict, without rowid;
  create index if not exists events_by_stream
    on events (tenant_id, aggregate_type, aggregate_id, stream_version);

  create table if not exists projections (
    tenant_id text not null,
    namespace text not null,
    projection_key text not null,
    stream_version integer not null,
    value_json text not null check (json_valid(value_json)),
    updated_at text not null,
    primary key (tenant_id, namespace, projection_key)
  ) strict, without rowid;

  create table if not exists jobs (
    job_id text primary key,
    tenant_id text not null,
    workspace_id text,
    kind text not null,
    payload_json text not null check (json_valid(payload_json)),
    status text not null check (status in ('available', 'leased', 'completed', 'failed')),
    attempts integer not null default 0,
    available_at text not null,
    lease_owner text,
    lease_expires_at text,
    fencing_token integer not null default 0,
    idempotency_key text not null,
    result_json text check (result_json is null or json_valid(result_json)),
    failure_json text check (failure_json is null or json_valid(failure_json)),
    created_at text not null,
    updated_at text not null,
    unique (tenant_id, idempotency_key)
  ) strict;
  create index if not exists jobs_claimable
    on jobs (status, available_at, lease_expires_at, created_at);

  create table if not exists outbox (
    message_id text primary key,
    tenant_id text not null,
    topic text not null,
    payload_json text not null check (json_valid(payload_json)),
    available_at text not null,
    created_at text not null
  ) strict, without rowid;

  create table if not exists approvals (
    tenant_id text not null,
    approval_id text not null,
    execution_id text not null,
    status text not null,
    value_json text not null check (json_valid(value_json)),
    updated_at text not null,
    primary key (tenant_id, approval_id)
  ) strict, without rowid;

  create table if not exists idempotency (
    tenant_id text not null,
    idempotency_key text not null,
    request_hash text not null,
    response_json text not null check (json_valid(response_json)),
    created_at text not null,
    primary key (tenant_id, idempotency_key)
  ) strict, without rowid;
`;

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function safePosition(value: unknown): number {
  const position = Number(value);
  if (!Number.isSafeInteger(position)) throw new RangeError("Event position exceeds JavaScript safe integer range");
  return position;
}

function rowToEvent(row: RecordRow): KernelEventV1 {
  return {
    schemaVersion: 1,
    id: String(row.event_id),
    tenantId: String(row.tenant_id),
    position: safePosition(row.position),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    streamVersion: safePosition(row.stream_version),
    type: String(row.event_type),
    occurredAt: String(row.occurred_at),
    actorId: String(row.actor_id),
    ...(row.execution_id === null ? {} : { executionId: String(row.execution_id) }),
    generation: safePosition(row.generation),
    ...(row.causation_id === null ? {} : { causationId: String(row.causation_id) }),
    correlationId: String(row.correlation_id),
    publicPayload: parseJson<JsonObject>(row.public_payload),
    ...(row.protected_payload_ref === null ? {} : {
      protectedPayloadRef: String(row.protected_payload_ref)
    }),
    ...(row.previous_digest === null ? {} : { previousDigest: String(row.previous_digest) }),
    digest: String(row.digest),
    hmac: String(row.hmac)
  };
}

function rowToJob(row: RecordRow): StoredJob {
  return {
    id: String(row.job_id),
    tenantId: String(row.tenant_id),
    ...(row.workspace_id === null ? {} : { workspaceId: String(row.workspace_id) }),
    kind: String(row.kind),
    payload: parseJson<JsonObject>(row.payload_json),
    status: String(row.status) as StoredJob["status"],
    attempts: Number(row.attempts),
    availableAt: String(row.available_at),
    ...(row.lease_owner === null ? {} : { leaseOwner: String(row.lease_owner) }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: String(row.lease_expires_at) }),
    fencingToken: Number(row.fencing_token),
    idempotencyKey: String(row.idempotency_key),
    ...(row.result_json === null ? {} : { result: parseJson<JsonValue>(row.result_json) }),
    ...(row.failure_json === null ? {} : { failure: parseJson<JsonObject>(row.failure_json) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class SqliteStorage implements StoragePort {
  readonly #database: DatabaseSync;
  readonly #hmacKey: Uint8Array;
  readonly #now: () => Date;
  #closed = false;

  constructor(options: SqliteStorageOptions) {
    if (options.hmacKey.byteLength < 32) throw new TypeError("Event HMAC key must contain at least 32 bytes");
    mkdirSync(dirname(options.databaseFile), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(options.databaseFile);
    chmodSync(options.databaseFile, 0o600);
    this.#hmacKey = Buffer.from(options.hmacKey);
    this.#now = options.now ?? (() => new Date());
    this.#database.exec("pragma journal_mode = WAL");
    this.#database.exec("pragma synchronous = FULL");
    this.#database.exec("pragma foreign_keys = ON");
    this.#database.exec("pragma busy_timeout = 5000");
    this.#database.exec(SQLITE_SCHEMA);
    this.#database.prepare(`
      insert into storage_meta (key, value) values ('schema_version', '1')
      on conflict(key) do nothing
    `).run();
  }

  async initialize(): Promise<void> {}

  /**
   * Synchronous transaction callback compatible with packages/kernel's
   * KernelStore. Callers must not return a Promise from the callback.
   */
  async transact<T>(tenantId: string, work: (transaction: KernelTransactionLike) => T): Promise<T> {
    this.#assertOpen();
    this.#database.exec("begin immediate");
    try {
      const transaction: KernelTransactionLike = {
        appendEvent: (request) => {
          if (request.tenantId !== tenantId) throw new Error("A storage transaction cannot cross tenants");
          return this.#appendEvent(request, this.#now().toISOString());
        },
        getProjection: <Value>(namespace: string, id: string) => {
          const row = this.#database.prepare(`
            select value_json from projections
            where tenant_id = ? and namespace = ? and projection_key = ?
          `).get(tenantId, namespace, id) as RecordRow | undefined;
          return row ? parseJson<Value>(row.value_json) : undefined;
        },
        listProjections: <Value>(namespace: string) => {
          const rows = this.#database.prepare(`
            select value_json from projections
            where tenant_id = ? and namespace = ? order by projection_key
          `).all(tenantId, namespace) as RecordRow[];
          return rows.map((row) => parseJson<Value>(row.value_json));
        },
        putProjection: <Value>(namespace: string, id: string, value: Value) => {
          const streamVersion = typeof value === "object" && value !== null
            && typeof (value as Record<string, unknown>).streamVersion === "number"
            ? Number((value as Record<string, unknown>).streamVersion)
            : 0;
          this.#database.prepare(`
            insert into projections (
              tenant_id, namespace, projection_key, stream_version, value_json, updated_at
            ) values (?, ?, ?, ?, ?, ?)
            on conflict(tenant_id, namespace, projection_key) do update set
              stream_version = excluded.stream_version,
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
          `).run(tenantId, namespace, id, streamVersion, JSON.stringify(value), this.#now().toISOString());
        },
        deleteProjection: (namespace, id) => {
          this.#database.prepare(`
            delete from projections where tenant_id = ? and namespace = ? and projection_key = ?
          `).run(tenantId, namespace, id);
        },
        getIdempotency: (scope, key) => {
          const row = this.#database.prepare(`
            select request_hash, response_json, created_at from idempotency
            where tenant_id = ? and idempotency_key = ?
          `).get(tenantId, `${scope}\0${key}`) as RecordRow | undefined;
          return row ? {
            tenantId,
            scope,
            key,
            requestDigest: String(row.request_hash),
            response: parseJson<unknown>(row.response_json),
            createdAt: String(row.created_at)
          } : undefined;
        },
        putIdempotency: (record: KernelIdempotencyRecordLike) => {
          if (record.tenantId !== tenantId) throw new Error("A storage transaction cannot cross tenants");
          this.#database.prepare(`
            insert into idempotency (
              tenant_id, idempotency_key, request_hash, response_json, created_at
            ) values (?, ?, ?, ?, ?)
          `).run(
            tenantId,
            `${record.scope}\0${record.key}`,
            record.requestDigest,
            JSON.stringify(record.response),
            record.createdAt
          );
        },
        putJob: (job) => {
          if (job.tenantId !== tenantId) throw new Error("A storage transaction cannot cross tenants");
          const writtenAt = this.#now().toISOString();
          this.#database.prepare(`
            insert into jobs (
              job_id, tenant_id, workspace_id, kind, payload_json, status, attempts,
              available_at, fencing_token, idempotency_key, created_at, updated_at
            ) values (?, ?, ?, ?, ?, 'available', 0, ?, 0, ?, ?, ?)
          `).run(
            job.id,
            job.tenantId,
            job.workspaceId ?? null,
            job.kind,
            JSON.stringify(job.payload),
            job.availableAt,
            job.idempotencyKey,
            writtenAt,
            writtenAt
          );
        },
        putOutbox: (message) => {
          if (message.tenantId !== tenantId) throw new Error("A storage transaction cannot cross tenants");
          const writtenAt = this.#now().toISOString();
          this.#database.prepare(`
            insert into outbox (
              message_id, tenant_id, topic, payload_json, available_at, created_at
            ) values (?, ?, ?, ?, ?, ?)
          `).run(
            message.id,
            message.tenantId,
            message.topic,
            JSON.stringify(message.payload),
            message.availableAt ?? writtenAt,
            writtenAt
          );
        }
      };
      const result = work(transaction);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new TypeError("Storage transaction callbacks must be synchronous");
      }
      this.#database.exec("commit");
      return result;
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  async commit(batch: StorageCommit): Promise<StorageCommitResult> {
    this.#assertOpen();
    const tenants = new Set([
      ...(batch.event ? [batch.event.tenantId] : []),
      ...(batch.projections ?? []).map((value) => value.tenantId),
      ...(batch.jobs ?? []).map((value) => value.tenantId),
      ...(batch.outbox ?? []).map((value) => value.tenantId),
      ...(batch.approvals ?? []).map((value) => value.tenantId),
      ...(batch.idempotency ? [batch.idempotency.tenantId] : [])
    ]);
    if (tenants.size > 1) throw new Error("A storage commit cannot cross tenants");
    this.#database.exec("begin immediate");
    try {
      const prior = this.#readIdempotency(batch);
      if (prior) {
        this.#database.exec("commit");
        return { ...prior, replayed: true };
      }

      const occurredAt = this.#now().toISOString();
      const event = batch.event ? this.#appendEvent(batch.event, occurredAt) : undefined;
      this.#writeProjections(batch, occurredAt);
      this.#writeJobs(batch, occurredAt);
      this.#writeOutbox(batch, occurredAt);
      this.#writeApprovals(batch, occurredAt);
      const result: StorageCommitResult = { ...(event ? { event } : {}), replayed: false };
      if (batch.idempotency) {
        this.#database.prepare(`
          insert into idempotency (
            tenant_id, idempotency_key, request_hash, response_json, created_at
          ) values (?, ?, ?, ?, ?)
        `).run(
          batch.idempotency.tenantId,
          batch.idempotency.key,
          batch.idempotency.requestHash,
          JSON.stringify(result),
          occurredAt
        );
      }
      this.#database.exec("commit");
      return result;
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  #readIdempotency(batch: StorageCommit): StorageCommitResult | undefined {
    if (!batch.idempotency) return undefined;
    const row = this.#database.prepare(`
      select request_hash, response_json
      from idempotency
      where tenant_id = ? and idempotency_key = ?
    `).get(batch.idempotency.tenantId, batch.idempotency.key) as RecordRow | undefined;
    if (!row) return undefined;
    if (row.request_hash !== batch.idempotency.requestHash) {
      throw new IdempotencyConflictError(batch.idempotency.tenantId, batch.idempotency.key);
    }
    return parseJson<StorageCommitResult>(row.response_json);
  }

  #appendEvent(request: EventAppendRequest, occurredAt: string): KernelEventV1 {
    this.#database.prepare(`
      insert into tenant_heads (tenant_id, next_position, previous_digest, retention_floor)
      values (?, 1, null, 1)
      on conflict(tenant_id) do nothing
    `).run(request.tenantId);
    this.#database.prepare(`
      insert into stream_heads (tenant_id, aggregate_type, aggregate_id, stream_version)
      values (?, ?, ?, 0)
      on conflict(tenant_id, aggregate_type, aggregate_id) do nothing
    `).run(request.tenantId, request.aggregateType, request.aggregateId);

    const stream = this.#database.prepare(`
      select stream_version from stream_heads
      where tenant_id = ? and aggregate_type = ? and aggregate_id = ?
    `).get(request.tenantId, request.aggregateType, request.aggregateId) as RecordRow;
    const actual = safePosition(stream.stream_version);
    if (actual !== request.expectedStreamVersion) {
      throw new StreamVersionConflictError(
        request.tenantId,
        request.aggregateType,
        request.aggregateId,
        request.expectedStreamVersion,
        actual
      );
    }
    const tenant = this.#database.prepare(`
      select next_position, previous_digest from tenant_heads where tenant_id = ?
    `).get(request.tenantId) as RecordRow;
    const position = safePosition(tenant.next_position);
    const streamVersion = actual + 1;
    const unsigned = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      tenantId: request.tenantId,
      position,
      aggregateType: request.aggregateType,
      aggregateId: request.aggregateId,
      streamVersion,
      type: request.type,
      occurredAt,
      actorId: request.actorId,
      ...(request.executionId ? { executionId: request.executionId } : {}),
      generation: request.generation,
      ...(request.causationId ? { causationId: request.causationId } : {}),
      correlationId: request.correlationId,
      publicPayload: request.publicPayload,
      ...(request.protectedPayloadRef ? { protectedPayloadRef: request.protectedPayloadRef } : {}),
      ...(tenant.previous_digest === null ? {} : { previousDigest: String(tenant.previous_digest) })
    };
    const digest = computeEventDigest(unsigned);
    const event: KernelEventV1 = {
      ...unsigned,
      digest,
      hmac: computeEventHmac(digest, this.#hmacKey)
    };
    this.#database.prepare(`
      insert into events (
        tenant_id, position, event_id, aggregate_type, aggregate_id, stream_version,
        event_type, occurred_at, actor_id, execution_id, generation, causation_id,
        correlation_id, public_payload, protected_payload_ref, previous_digest, digest, hmac
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.tenantId,
      event.position,
      event.id,
      event.aggregateType,
      event.aggregateId,
      event.streamVersion,
      event.type,
      event.occurredAt,
      event.actorId,
      event.executionId ?? null,
      event.generation,
      event.causationId ?? null,
      event.correlationId,
      JSON.stringify(event.publicPayload),
      event.protectedPayloadRef ?? null,
      event.previousDigest ?? null,
      event.digest,
      event.hmac
    );
    this.#database.prepare(`
      update stream_heads set stream_version = ?
      where tenant_id = ? and aggregate_type = ? and aggregate_id = ?
    `).run(streamVersion, request.tenantId, request.aggregateType, request.aggregateId);
    this.#database.prepare(`
      update tenant_heads set next_position = ?, previous_digest = ? where tenant_id = ?
    `).run(position + 1, digest, request.tenantId);
    return event;
  }

  #writeProjections(batch: StorageCommit, now: string): void {
    const statement = this.#database.prepare(`
      insert into projections (
        tenant_id, namespace, projection_key, stream_version, value_json, updated_at
      ) values (?, ?, ?, ?, ?, ?)
      on conflict(tenant_id, namespace, projection_key) do update set
        stream_version = excluded.stream_version,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
      where excluded.stream_version >= projections.stream_version
    `);
    for (const projection of batch.projections ?? []) {
      statement.run(
        projection.tenantId,
        projection.namespace,
        projection.key,
        projection.streamVersion,
        JSON.stringify(projection.value),
        now
      );
    }
  }

  #writeJobs(batch: StorageCommit, now: string): void {
    const statement = this.#database.prepare(`
      insert into jobs (
        job_id, tenant_id, workspace_id, kind, payload_json, status, attempts,
        available_at, fencing_token, idempotency_key, created_at, updated_at
      ) values (?, ?, ?, ?, ?, 'available', 0, ?, 0, ?, ?, ?)
    `);
    for (const job of batch.jobs ?? []) {
      statement.run(
        job.id,
        job.tenantId,
        job.workspaceId ?? null,
        job.kind,
        JSON.stringify(job.payload),
        job.availableAt,
        job.idempotencyKey,
        now,
        now
      );
    }
  }

  #writeOutbox(batch: StorageCommit, now: string): void {
    const statement = this.#database.prepare(`
      insert into outbox (
        message_id, tenant_id, topic, payload_json, available_at, created_at
      ) values (?, ?, ?, ?, ?, ?)
    `);
    for (const message of batch.outbox ?? []) {
      statement.run(
        message.id,
        message.tenantId,
        message.topic,
        JSON.stringify(message.payload),
        message.availableAt ?? now,
        now
      );
    }
  }

  #writeApprovals(batch: StorageCommit, now: string): void {
    const statement = this.#database.prepare(`
      insert into approvals (
        tenant_id, approval_id, execution_id, status, value_json, updated_at
      ) values (?, ?, ?, ?, ?, ?)
      on conflict(tenant_id, approval_id) do update set
        execution_id = excluded.execution_id,
        status = excluded.status,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    for (const approval of batch.approvals ?? []) {
      statement.run(
        approval.tenantId,
        approval.id,
        approval.executionId,
        approval.status,
        JSON.stringify(approval.value),
        now
      );
    }
  }

  async readEvents(tenantId: string, afterPosition: number, limit: number): Promise<import("@mn/contracts").EventPage>;
  async readEvents(tenantId: string, options: EventReadOptions): Promise<import("@mn/contracts").EventPage>;
  async readEvents(
    tenantId: string,
    optionsOrAfterPosition: EventReadOptions | number,
    compatibilityLimit?: number
  ): Promise<import("@mn/contracts").EventPage> {
    const options: EventReadOptions = typeof optionsOrAfterPosition === "number"
      ? { afterPosition: optionsOrAfterPosition, limit: compatibilityLimit ?? 100 }
      : optionsOrAfterPosition;
    if (!Number.isInteger(options.afterPosition) || options.afterPosition < 0) {
      throw new RangeError("afterPosition must be a non-negative integer");
    }
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
      throw new RangeError("Event page limit must be between 1 and 1000");
    }
    const head = this.#database.prepare(`
      select next_position, retention_floor from tenant_heads where tenant_id = ?
    `).get(tenantId) as RecordRow | undefined;
    const retentionFloor = head ? safePosition(head.retention_floor) : 1;
    if (options.afterPosition < retentionFloor - 1) {
      throw new CursorExpiredError(tenantId, retentionFloor);
    }
    const rows = this.#database.prepare(`
      select * from events
      where tenant_id = ? and position > ?
      order by position asc
      limit ?
    `).all(tenantId, options.afterPosition, options.limit) as RecordRow[];
    const events = rows.map(rowToEvent);
    return {
      events,
      nextPosition: events.at(-1)?.position ?? options.afterPosition,
      retentionFloor
    };
  }

  async advanceRetentionFloor(tenantId: string, floorPosition: number): Promise<void> {
    if (!Number.isSafeInteger(floorPosition) || floorPosition < 1) {
      throw new RangeError("Retention floor must be a positive safe integer");
    }
    this.#database.exec("begin immediate");
    try {
      const head = this.#database.prepare(`
        select next_position from tenant_heads where tenant_id = ?
      `).get(tenantId) as RecordRow | undefined;
      const nextPosition = head ? safePosition(head.next_position) : 1;
      if (floorPosition > nextPosition) {
        throw new RangeError(`Retention floor cannot exceed next position ${nextPosition}`);
      }
      this.#database.prepare(`
        insert into tenant_heads (tenant_id, next_position, previous_digest, retention_floor)
        values (?, 1, null, ?)
        on conflict(tenant_id) do update set
          retention_floor = max(retention_floor, excluded.retention_floor)
      `).run(tenantId, floorPosition);
      this.#database.prepare("delete from events where tenant_id = ? and position < ?")
        .run(tenantId, floorPosition);
      this.#database.exec("commit");
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  async getProjection(tenantId: string, namespace: string, key: string): Promise<JsonObject | undefined> {
    const row = this.#database.prepare(`
      select value_json from projections
      where tenant_id = ? and namespace = ? and projection_key = ?
    `).get(tenantId, namespace, key) as RecordRow | undefined;
    return row ? parseJson<JsonObject>(row.value_json) : undefined;
  }

  async listOutbox(tenantId: string, limit: number): Promise<readonly StoredOutboxMessage[]> {
    const rows = this.#database.prepare(`
      select * from outbox where tenant_id = ? order by created_at, message_id limit ?
    `).all(tenantId, limit) as RecordRow[];
    return rows.map((row) => ({
      id: String(row.message_id),
      tenantId: String(row.tenant_id),
      topic: String(row.topic),
      payload: parseJson<JsonObject>(row.payload_json),
      availableAt: String(row.available_at),
      createdAt: String(row.created_at)
    }));
  }

  async getApproval(tenantId: string, id: string): Promise<StoredApproval | undefined> {
    const row = this.#database.prepare(`
      select * from approvals where tenant_id = ? and approval_id = ?
    `).get(tenantId, id) as RecordRow | undefined;
    return row ? {
      tenantId: String(row.tenant_id),
      id: String(row.approval_id),
      executionId: String(row.execution_id),
      status: String(row.status) as StoredApproval["status"],
      value: parseJson<JsonObject>(row.value_json),
      updatedAt: String(row.updated_at)
    } : undefined;
  }

  async claimJob(workerId: string, now: string, options: JobClaimOptions = {}): Promise<StoredJob | undefined> {
    const kinds = options.kinds ?? [];
    const conditions = [
      "available_at <= ?",
      "(status = 'available' or (status = 'leased' and lease_expires_at <= ?))"
    ];
    const parameters: Array<string | number> = [now, now];
    if (options.tenantId) {
      conditions.push("tenant_id = ?");
      parameters.push(options.tenantId);
    }
    if (kinds.length > 0) {
      conditions.push(`kind in (${kinds.map(() => "?").join(", ")})`);
      parameters.push(...kinds);
    }
    this.#database.exec("begin immediate");
    try {
      const row = this.#database.prepare(`
        select * from jobs where ${conditions.join(" and ")}
        order by available_at, created_at, job_id limit 1
      `).get(...parameters) as RecordRow | undefined;
      if (!row) {
        this.#database.exec("commit");
        return undefined;
      }
      const leaseExpiresAt = new Date(Date.parse(now) + JOB_LEASE_MILLISECONDS).toISOString();
      const fencingToken = Number(row.fencing_token) + 1;
      this.#database.prepare(`
        update jobs set status = 'leased', attempts = attempts + 1, lease_owner = ?,
          lease_expires_at = ?, fencing_token = ?, updated_at = ? where job_id = ?
      `).run(workerId, leaseExpiresAt, fencingToken, now, String(row.job_id));
      const claimed = this.#database.prepare("select * from jobs where job_id = ?")
        .get(String(row.job_id)) as RecordRow;
      this.#database.exec("commit");
      return rowToJob(claimed);
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  async completeJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    result: JsonValue,
    now: string
  ): Promise<void> {
    const change = this.#database.prepare(`
      update jobs set status = 'completed', result_json = ?, lease_owner = null,
        lease_expires_at = null, updated_at = ?
      where job_id = ? and status = 'leased' and lease_owner = ? and fencing_token = ?
        and lease_expires_at > ?
    `).run(JSON.stringify(result), now, jobId, workerId, fencingToken, now);
    if (Number(change.changes) !== 1) throw new StaleFencingTokenError(jobId);
  }

  async renewJobLease(
    jobId: string,
    workerId: string,
    fencingToken: number,
    now: string
  ): Promise<void> {
    this.#assertOpen();
    const leaseExpiresAt = new Date(validTimestamp(now) + JOB_LEASE_MILLISECONDS).toISOString();
    const change = this.#database.prepare(`
      update jobs set lease_expires_at = ?, updated_at = ?
      where job_id = ? and status = 'leased' and lease_owner = ? and fencing_token = ?
        and lease_expires_at > ?
    `).run(leaseExpiresAt, now, jobId, workerId, fencingToken, now);
    if (Number(change.changes) !== 1) throw new StaleFencingTokenError(jobId);
  }

  async failJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    failure: JsonObject,
    now: string
  ): Promise<void> {
    const change = this.#database.prepare(`
      update jobs set status = 'failed', failure_json = ?, lease_owner = null,
        lease_expires_at = null, updated_at = ?
      where job_id = ? and status = 'leased' and lease_owner = ? and fencing_token = ?
        and lease_expires_at > ?
    `).run(JSON.stringify(failure), now, jobId, workerId, fencingToken, now);
    if (Number(change.changes) !== 1) throw new StaleFencingTokenError(jobId);
  }

  async markNeedsReconciliation(
    executionId: string,
    input: NeedsReconciliationInput
  ): Promise<void> {
    this.#assertOpen();
    validTimestamp(input.occurredAt);
    this.#database.exec("begin immediate");
    try {
      const job = this.#database.prepare(`
        select * from jobs
        where job_id = ? and status = 'leased' and lease_owner = ? and fencing_token = ?
          and lease_expires_at > ?
      `).get(
        input.jobId,
        input.workerId,
        input.fencingToken,
        input.occurredAt
      ) as RecordRow | undefined;
      if (!job) throw new StaleFencingTokenError(input.jobId);
      const jobPayload = parseJson<JsonObject>(job.payload_json);
      if (jobPayload.executionId !== executionId) {
        throw new Error("Job 与待核对的 Execution 不一致");
      }
      const tenantId = String(job.tenant_id);
      const projectionRow = this.#database.prepare(`
        select value_json from projections
        where tenant_id = ? and namespace = 'execution' and projection_key = ?
      `).get(tenantId, executionId) as RecordRow | undefined;
      if (!projectionRow) throw new Error(`Execution ${executionId} 的投影不存在`);
      const execution = parseJson<JsonObject>(projectionRow.value_json);
      const streamVersion = requiredSafeInteger(execution.streamVersion, "execution streamVersion");
      const generation = requiredSafeInteger(execution.generation, "execution generation");
      const workspaceId = requiredString(execution.workspaceId, "execution workspaceId");
      const updatedExecution: JsonObject = {
        ...execution,
        status: "needs_reconciliation",
        failureCode: "UNKNOWN_EXTERNAL_SIDE_EFFECT",
        streamVersion: streamVersion + 1,
        updatedAt: input.occurredAt,
      };
      const inboxId = `reconciliation:${executionId}:${input.jobId}`;
      const inbox: JsonObject = {
        id: inboxId,
        tenantId,
        workspaceId,
        executionId,
        kind: "reconciliation",
        title: "外部操作结果需要人工核对",
        summary: "外部操作可能已经发生。请核对后选择终止、标记已完成或创建新调用",
        risk: "unknown",
        resourceSummary: input.jobId,
        createdAt: input.occurredAt,
        status: "open",
      };
      const failure: JsonObject = {
        code: "UNKNOWN_EXTERNAL_SIDE_EFFECT",
        message: "外部操作结果未知，需要人工核对",
        retryable: false,
        executionId,
      };
      const jobChange = this.#database.prepare(`
        update jobs set status = 'failed', result_json = null, failure_json = ?,
          lease_owner = null, lease_expires_at = null, updated_at = ?
        where job_id = ? and status = 'leased' and lease_owner = ? and fencing_token = ?
          and lease_expires_at > ?
      `).run(
        JSON.stringify(failure),
        input.occurredAt,
        input.jobId,
        input.workerId,
        input.fencingToken,
        input.occurredAt
      );
      if (Number(jobChange.changes) !== 1) throw new StaleFencingTokenError(input.jobId);
      this.#appendEvent({
        tenantId,
        aggregateType: "execution",
        aggregateId: executionId,
        expectedStreamVersion: streamVersion,
        type: "execution.needs_reconciliation",
        actorId: `worker:${input.workerId}`,
        executionId,
        generation,
        correlationId: `reconciliation:${input.jobId}:${input.fencingToken}`,
        publicPayload: { workspaceId, jobId: input.jobId, status: "needs_reconciliation" },
      }, input.occurredAt);
      const writeProjection = this.#database.prepare(`
        insert into projections (
          tenant_id, namespace, projection_key, stream_version, value_json, updated_at
        ) values (?, ?, ?, ?, ?, ?)
        on conflict(tenant_id, namespace, projection_key) do update set
          stream_version = excluded.stream_version,
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `);
      writeProjection.run(
        tenantId,
        "execution",
        executionId,
        streamVersion + 1,
        JSON.stringify(updatedExecution),
        input.occurredAt
      );
      writeProjection.run(
        tenantId,
        "inbox",
        inboxId,
        0,
        JSON.stringify(inbox),
        input.occurredAt
      );
      this.#database.exec("commit");
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  async getJob(jobId: string): Promise<StoredJob | undefined> {
    const row = this.#database.prepare("select * from jobs where job_id = ?").get(jobId) as
      | RecordRow
      | undefined;
    return row ? rowToJob(row) : undefined;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Storage is closed");
  }
}

function validTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("时间戳无效");
  return timestamp;
}

function requiredSafeInteger(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} 无效`);
  }
  return value;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} 无效`);
  return value;
}
