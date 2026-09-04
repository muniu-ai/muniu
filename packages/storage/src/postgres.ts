// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

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
  type NeedsReconciliationInput,
  type StorageCommit,
  type StorageCommitResult,
  type StoragePort,
  type StoredApproval,
  type StoredJob,
  type StoredOutboxMessage
} from "./types.js";

export const postgresStorageSchema = "mn_v2";

export const POSTGRES_SCHEMA_SQL = `
create schema if not exists mn_v2;

create table if not exists mn_v2.tenant_heads (
  tenant_id text primary key,
  next_position bigint not null check (next_position >= 1),
  previous_digest text,
  retention_floor bigint not null default 1 check (retention_floor >= 1)
);

create table if not exists mn_v2.stream_heads (
  tenant_id text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  stream_version bigint not null check (stream_version >= 0),
  primary key (tenant_id, aggregate_type, aggregate_id)
);

create table if not exists mn_v2.events (
  tenant_id text not null,
  position bigint not null,
  event_id uuid not null unique,
  aggregate_type text not null,
  aggregate_id text not null,
  stream_version bigint not null,
  event_type text not null,
  occurred_at timestamptz not null,
  actor_id text not null,
  execution_id text,
  generation integer not null,
  causation_id text,
  correlation_id text not null,
  public_payload jsonb not null,
  protected_payload_ref text,
  previous_digest text,
  digest text not null,
  hmac text not null,
  primary key (tenant_id, position),
  unique (tenant_id, aggregate_type, aggregate_id, stream_version)
);
create index if not exists events_by_stream
  on mn_v2.events (tenant_id, aggregate_type, aggregate_id, stream_version);

create table if not exists mn_v2.projections (
  tenant_id text not null,
  namespace text not null,
  projection_key text not null,
  stream_version bigint not null,
  value_json jsonb not null,
  updated_at timestamptz not null,
  primary key (tenant_id, namespace, projection_key)
);

create table if not exists mn_v2.jobs (
  job_id text primary key,
  tenant_id text not null,
  workspace_id text,
  kind text not null,
  payload_json jsonb not null,
  status text not null check (status in ('available', 'leased', 'completed', 'failed')),
  attempts integer not null default 0,
  available_at timestamptz not null,
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint not null default 0,
  idempotency_key text not null,
  result_json jsonb,
  failure_json jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, idempotency_key)
);
create index if not exists jobs_claimable
  on mn_v2.jobs (status, available_at, lease_expires_at, created_at);

create table if not exists mn_v2.outbox (
  message_id text primary key,
  tenant_id text not null,
  topic text not null,
  payload_json jsonb not null,
  available_at timestamptz not null,
  created_at timestamptz not null
);

create table if not exists mn_v2.approvals (
  tenant_id text not null,
  approval_id text not null,
  execution_id text not null,
  status text not null,
  value_json jsonb not null,
  updated_at timestamptz not null,
  primary key (tenant_id, approval_id)
);

create table if not exists mn_v2.idempotency (
  tenant_id text not null,
  idempotency_key text not null,
  request_hash text not null,
  response_json jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id, idempotency_key)
);
`;

export interface PostgresQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount?: number | null;
}

export interface PostgresClientLike {
  query(
    sql: string,
    parameters?: readonly unknown[]
  ): Promise<PostgresQueryResult>;
  release(): void;
}

export interface PostgresPoolLike {
  query(
    sql: string,
    parameters?: readonly unknown[]
  ): Promise<PostgresQueryResult>;
  connect(): Promise<PostgresClientLike>;
  end?(): Promise<void>;
}

export interface PostgresStorageOptions {
  readonly pool: PostgresPoolLike;
  readonly hmacKey: Uint8Array;
  readonly now?: () => Date;
}

type Row = Record<string, unknown>;

function safeInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} exceeds JavaScript safe integer range`);
  return result;
}

function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function rowToEvent(row: Row): KernelEventV1 {
  return {
    schemaVersion: 1,
    id: String(row.event_id),
    tenantId: String(row.tenant_id),
    position: safeInteger(row.position, "Event position"),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    streamVersion: safeInteger(row.stream_version, "Stream version"),
    type: String(row.event_type),
    occurredAt: iso(row.occurred_at),
    actorId: String(row.actor_id),
    ...(row.execution_id == null ? {} : { executionId: String(row.execution_id) }),
    generation: safeInteger(row.generation, "Generation"),
    ...(row.causation_id == null ? {} : { causationId: String(row.causation_id) }),
    correlationId: String(row.correlation_id),
    publicPayload: json<JsonObject>(row.public_payload),
    ...(row.protected_payload_ref == null ? {} : {
      protectedPayloadRef: String(row.protected_payload_ref)
    }),
    ...(row.previous_digest == null ? {} : { previousDigest: String(row.previous_digest) }),
    digest: String(row.digest),
    hmac: String(row.hmac)
  };
}

function rowToJob(row: Row): StoredJob {
  return {
    id: String(row.job_id),
    tenantId: String(row.tenant_id),
    ...(row.workspace_id == null ? {} : { workspaceId: String(row.workspace_id) }),
    kind: String(row.kind),
    payload: json<JsonObject>(row.payload_json),
    status: String(row.status) as StoredJob["status"],
    attempts: safeInteger(row.attempts, "Job attempts"),
    availableAt: iso(row.available_at),
    ...(row.lease_owner == null ? {} : { leaseOwner: String(row.lease_owner) }),
    ...(row.lease_expires_at == null ? {} : { leaseExpiresAt: iso(row.lease_expires_at) }),
    fencingToken: safeInteger(row.fencing_token, "Fencing token"),
    idempotencyKey: String(row.idempotency_key),
    ...(row.result_json == null ? {} : { result: json<JsonValue>(row.result_json) }),
    ...(row.failure_json == null ? {} : { failure: json<JsonObject>(row.failure_json) }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export class PostgresStorage implements StoragePort {
  readonly #pool: PostgresPoolLike;
  readonly #hmacKey: Uint8Array;
  readonly #now: () => Date;

  constructor(options: PostgresStorageOptions) {
    if (options.hmacKey.byteLength < 32) throw new TypeError("Event HMAC key must contain at least 32 bytes");
    this.#pool = options.pool;
    this.#hmacKey = Buffer.from(options.hmacKey);
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.#pool.query(POSTGRES_SCHEMA_SQL);
  }

  async commit(batch: StorageCommit): Promise<StorageCommitResult> {
    const tenants = new Set([
      ...(batch.event ? [batch.event.tenantId] : []),
      ...(batch.projections ?? []).map((value) => value.tenantId),
      ...(batch.jobs ?? []).map((value) => value.tenantId),
      ...(batch.outbox ?? []).map((value) => value.tenantId),
      ...(batch.approvals ?? []).map((value) => value.tenantId),
      ...(batch.idempotency ? [batch.idempotency.tenantId] : [])
    ]);
    if (tenants.size > 1) throw new Error("A storage commit cannot cross tenants");
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const prior = await this.#readIdempotency(client, batch);
      if (prior) {
        await client.query("commit");
        return { ...prior, replayed: true };
      }
      const occurredAt = this.#now().toISOString();
      const event = batch.event
        ? await this.#appendEvent(client, batch.event, occurredAt)
        : undefined;
      await this.#writeProjections(client, batch, occurredAt);
      await this.#writeJobs(client, batch, occurredAt);
      await this.#writeOutbox(client, batch, occurredAt);
      await this.#writeApprovals(client, batch, occurredAt);
      const result: StorageCommitResult = { ...(event ? { event } : {}), replayed: false };
      if (batch.idempotency) {
        await client.query(`
          insert into mn_v2.idempotency (
            tenant_id, idempotency_key, request_hash, response_json, created_at
          ) values ($1, $2, $3, $4::jsonb, $5::timestamptz)
        `, [
          batch.idempotency.tenantId,
          batch.idempotency.key,
          batch.idempotency.requestHash,
          JSON.stringify(result),
          occurredAt
        ]);
      }
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async #readIdempotency(
    client: PostgresClientLike,
    batch: StorageCommit
  ): Promise<StorageCommitResult | undefined> {
    if (!batch.idempotency) return undefined;
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${batch.idempotency.tenantId}\0${batch.idempotency.key}`
    ]);
    const existing = await client.query(`
      select request_hash, response_json from mn_v2.idempotency
      where tenant_id = $1 and idempotency_key = $2
    `, [batch.idempotency.tenantId, batch.idempotency.key]);
    const row = existing.rows[0];
    if (!row) return undefined;
    if (row.request_hash !== batch.idempotency.requestHash) {
      throw new IdempotencyConflictError(batch.idempotency.tenantId, batch.idempotency.key);
    }
    return json<StorageCommitResult>(row.response_json);
  }

  async #appendEvent(
    client: PostgresClientLike,
    request: EventAppendRequest,
    occurredAt: string
  ): Promise<KernelEventV1> {
    await client.query(`
      insert into mn_v2.tenant_heads (tenant_id, next_position, previous_digest, retention_floor)
      values ($1, 1, null, 1) on conflict (tenant_id) do nothing
    `, [request.tenantId]);
    const tenantResult = await client.query(`
      select next_position, previous_digest from mn_v2.tenant_heads
      where tenant_id = $1 for update
    `, [request.tenantId]);
    const tenant = tenantResult.rows[0];
    if (!tenant) throw new Error("Tenant event head was not created");

    await client.query(`
      insert into mn_v2.stream_heads (
        tenant_id, aggregate_type, aggregate_id, stream_version
      ) values ($1, $2, $3, 0)
      on conflict (tenant_id, aggregate_type, aggregate_id) do nothing
    `, [request.tenantId, request.aggregateType, request.aggregateId]);
    const streamResult = await client.query(`
      select stream_version from mn_v2.stream_heads
      where tenant_id = $1 and aggregate_type = $2 and aggregate_id = $3
      for update
    `, [request.tenantId, request.aggregateType, request.aggregateId]);
    const actual = streamResult.rows[0]
      ? safeInteger(streamResult.rows[0].stream_version, "Stream version")
      : 0;
    if (actual !== request.expectedStreamVersion) {
      throw new StreamVersionConflictError(
        request.tenantId,
        request.aggregateType,
        request.aggregateId,
        request.expectedStreamVersion,
        actual
      );
    }
    const position = safeInteger(tenant.next_position, "Event position");
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
      ...(tenant.previous_digest == null ? {} : { previousDigest: String(tenant.previous_digest) })
    };
    const digest = computeEventDigest(unsigned);
    const event: KernelEventV1 = {
      ...unsigned,
      digest,
      hmac: computeEventHmac(digest, this.#hmacKey)
    };
    await client.query(`
      insert into mn_v2.events (
        tenant_id, position, event_id, aggregate_type, aggregate_id, stream_version,
        event_type, occurred_at, actor_id, execution_id, generation, causation_id,
        correlation_id, public_payload, protected_payload_ref, previous_digest, digest, hmac
      ) values (
        $1, $2, $3::uuid, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, $12,
        $13, $14::jsonb, $15, $16, $17, $18
      )
    `, [
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
    ]);
    await client.query(`
      update mn_v2.tenant_heads set next_position = $1, previous_digest = $2
      where tenant_id = $3
    `, [position + 1, event.digest, request.tenantId]);
    await client.query(`
      update mn_v2.stream_heads set stream_version = $1
      where tenant_id = $2 and aggregate_type = $3 and aggregate_id = $4
    `, [streamVersion, request.tenantId, request.aggregateType, request.aggregateId]);
    return event;
  }

  async #writeProjections(client: PostgresClientLike, batch: StorageCommit, now: string): Promise<void> {
    for (const projection of batch.projections ?? []) {
      await client.query(`
        insert into mn_v2.projections (
          tenant_id, namespace, projection_key, stream_version, value_json, updated_at
        ) values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
        on conflict (tenant_id, namespace, projection_key) do update set
          stream_version = excluded.stream_version,
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
        where excluded.stream_version >= mn_v2.projections.stream_version
      `, [
        projection.tenantId,
        projection.namespace,
        projection.key,
        projection.streamVersion,
        JSON.stringify(projection.value),
        now
      ]);
    }
  }

  async #writeJobs(client: PostgresClientLike, batch: StorageCommit, now: string): Promise<void> {
    for (const job of batch.jobs ?? []) {
      await client.query(`
        insert into mn_v2.jobs (
          job_id, tenant_id, workspace_id, kind, payload_json, status, attempts,
          available_at, fencing_token, idempotency_key, created_at, updated_at
        ) values ($1, $2, $3, $4, $5::jsonb, 'available', 0, $6::timestamptz, 0, $7,
          $8::timestamptz, $8::timestamptz)
      `, [
        job.id,
        job.tenantId,
        job.workspaceId ?? null,
        job.kind,
        JSON.stringify(job.payload),
        job.availableAt,
        job.idempotencyKey,
        now
      ]);
    }
  }

  async #writeOutbox(client: PostgresClientLike, batch: StorageCommit, now: string): Promise<void> {
    for (const message of batch.outbox ?? []) {
      await client.query(`
        insert into mn_v2.outbox (
          message_id, tenant_id, topic, payload_json, available_at, created_at
        ) values ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
      `, [
        message.id,
        message.tenantId,
        message.topic,
        JSON.stringify(message.payload),
        message.availableAt ?? now,
        now
      ]);
    }
  }

  async #writeApprovals(client: PostgresClientLike, batch: StorageCommit, now: string): Promise<void> {
    for (const approval of batch.approvals ?? []) {
      await client.query(`
        insert into mn_v2.approvals (
          tenant_id, approval_id, execution_id, status, value_json, updated_at
        ) values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
        on conflict (tenant_id, approval_id) do update set
          execution_id = excluded.execution_id,
          status = excluded.status,
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `, [
        approval.tenantId,
        approval.id,
        approval.executionId,
        approval.status,
        JSON.stringify(approval.value),
        now
      ]);
    }
  }

  async readEvents(tenantId: string, options: EventReadOptions) {
    if (!Number.isInteger(options.afterPosition) || options.afterPosition < 0) {
      throw new RangeError("afterPosition must be a non-negative integer");
    }
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
      throw new RangeError("Event page limit must be between 1 and 1000");
    }
    const headResult = await this.#pool.query(`
      select next_position, retention_floor from mn_v2.tenant_heads where tenant_id = $1
    `, [tenantId]);
    const retentionFloor = headResult.rows[0]
      ? safeInteger(headResult.rows[0].retention_floor, "Retention floor")
      : 1;
    if (options.afterPosition < retentionFloor - 1) {
      throw new CursorExpiredError(tenantId, retentionFloor);
    }
    const result = await this.#pool.query(`
      select * from mn_v2.events where tenant_id = $1 and position > $2
      order by position asc limit $3
    `, [tenantId, options.afterPosition, options.limit]);
    const events = result.rows.map(rowToEvent);
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
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const head = await client.query(`
        select next_position from mn_v2.tenant_heads where tenant_id = $1 for update
      `, [tenantId]);
      const nextPosition = head.rows[0]
        ? safeInteger(head.rows[0].next_position, "Event position")
        : 1;
      if (floorPosition > nextPosition) {
        throw new RangeError(`Retention floor cannot exceed next position ${nextPosition}`);
      }
      await client.query(`
        insert into mn_v2.tenant_heads (tenant_id, next_position, previous_digest, retention_floor)
        values ($1, 1, null, $2)
        on conflict (tenant_id) do update set
          retention_floor = greatest(mn_v2.tenant_heads.retention_floor, excluded.retention_floor)
      `, [tenantId, floorPosition]);
      await client.query("delete from mn_v2.events where tenant_id = $1 and position < $2", [
        tenantId,
        floorPosition
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getProjection(tenantId: string, namespace: string, key: string): Promise<JsonObject | undefined> {
    const result = await this.#pool.query(`
      select value_json from mn_v2.projections
      where tenant_id = $1 and namespace = $2 and projection_key = $3
    `, [tenantId, namespace, key]);
    return result.rows[0] ? json<JsonObject>(result.rows[0].value_json) : undefined;
  }

  async listOutbox(tenantId: string, limit: number): Promise<readonly StoredOutboxMessage[]> {
    const result = await this.#pool.query(`
      select * from mn_v2.outbox where tenant_id = $1
      order by created_at, message_id limit $2
    `, [tenantId, limit]);
    return result.rows.map((row) => ({
      id: String(row.message_id),
      tenantId: String(row.tenant_id),
      topic: String(row.topic),
      payload: json<JsonObject>(row.payload_json),
      availableAt: iso(row.available_at),
      createdAt: iso(row.created_at)
    }));
  }

  async getApproval(tenantId: string, id: string): Promise<StoredApproval | undefined> {
    const result = await this.#pool.query(`
      select * from mn_v2.approvals where tenant_id = $1 and approval_id = $2
    `, [tenantId, id]);
    const row = result.rows[0];
    return row ? {
      tenantId: String(row.tenant_id),
      id: String(row.approval_id),
      executionId: String(row.execution_id),
      status: String(row.status) as StoredApproval["status"],
      value: json<JsonObject>(row.value_json),
      updatedAt: iso(row.updated_at)
    } : undefined;
  }

  async claimJob(workerId: string, now: string, options: JobClaimOptions = {}): Promise<StoredJob | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const parameters: unknown[] = [now];
      const conditions = [
        "available_at <= $1::timestamptz",
        "(status = 'available' or (status = 'leased' and lease_expires_at <= $1::timestamptz))"
      ];
      if (options.tenantId) {
        parameters.push(options.tenantId);
        conditions.push(`tenant_id = $${parameters.length}`);
      }
      if ((options.kinds?.length ?? 0) > 0) {
        parameters.push(options.kinds);
        conditions.push(`kind = any($${parameters.length}::text[])`);
      }
      const selected = await client.query(`
        select * from mn_v2.jobs where ${conditions.join(" and ")}
        order by available_at, created_at, job_id
        for update skip locked limit 1
      `, parameters);
      const row = selected.rows[0];
      if (!row) {
        await client.query("commit");
        return undefined;
      }
      const leaseExpiresAt = new Date(Date.parse(now) + JOB_LEASE_MILLISECONDS).toISOString();
      const updated = await client.query(`
        update mn_v2.jobs set status = 'leased', attempts = attempts + 1,
          lease_owner = $1, lease_expires_at = $2::timestamptz,
          fencing_token = fencing_token + 1, updated_at = $3::timestamptz
        where job_id = $4 returning *
      `, [workerId, leaseExpiresAt, now, String(row.job_id)]);
      await client.query("commit");
      if (!updated.rows[0]) throw new Error("Claimed job disappeared");
      return rowToJob(updated.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    result: JsonValue,
    now: string
  ): Promise<void> {
    const change = await this.#pool.query(`
      update mn_v2.jobs set status = 'completed', result_json = $1::jsonb,
        lease_owner = null, lease_expires_at = null, updated_at = $2::timestamptz
      where job_id = $3 and status = 'leased' and lease_owner = $4 and fencing_token = $5
        and lease_expires_at > $2::timestamptz
    `, [JSON.stringify(result), now, jobId, workerId, fencingToken]);
    if (change.rowCount !== 1) throw new StaleFencingTokenError(jobId);
  }

  async renewJobLease(
    jobId: string,
    workerId: string,
    fencingToken: number,
    now: string
  ): Promise<void> {
    const leaseExpiresAt = new Date(validTimestamp(now) + JOB_LEASE_MILLISECONDS).toISOString();
    const change = await this.#pool.query(`
      update mn_v2.jobs set lease_expires_at = $1::timestamptz, updated_at = $2::timestamptz
      where job_id = $3 and status = 'leased' and lease_owner = $4 and fencing_token = $5
        and lease_expires_at > $2::timestamptz
    `, [leaseExpiresAt, now, jobId, workerId, fencingToken]);
    if (change.rowCount !== 1) throw new StaleFencingTokenError(jobId);
  }

  async failJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    failure: JsonObject,
    now: string
  ): Promise<void> {
    const change = await this.#pool.query(`
      update mn_v2.jobs set status = 'failed', failure_json = $1::jsonb,
        lease_owner = null, lease_expires_at = null, updated_at = $2::timestamptz
      where job_id = $3 and status = 'leased' and lease_owner = $4 and fencing_token = $5
        and lease_expires_at > $2::timestamptz
    `, [JSON.stringify(failure), now, jobId, workerId, fencingToken]);
    if (change.rowCount !== 1) throw new StaleFencingTokenError(jobId);
  }

  async markNeedsReconciliation(
    executionId: string,
    input: NeedsReconciliationInput
  ): Promise<void> {
    validTimestamp(input.occurredAt);
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const selectedJob = await client.query(`
        select * from mn_v2.jobs
        where job_id = $1 and status = 'leased' and lease_owner = $2 and fencing_token = $3
          and lease_expires_at > $4::timestamptz
        for update
      `, [input.jobId, input.workerId, input.fencingToken, input.occurredAt]);
      const job = selectedJob.rows[0];
      if (!job) throw new StaleFencingTokenError(input.jobId);
      const jobPayload = json<JsonObject>(job.payload_json);
      if (jobPayload.executionId !== executionId) {
        throw new Error("Job 与待核对的 Execution 不一致");
      }
      const tenantId = String(job.tenant_id);
      const selectedExecution = await client.query(`
        select value_json from mn_v2.projections
        where tenant_id = $1 and namespace = 'execution' and projection_key = $2
        for update
      `, [tenantId, executionId]);
      const executionRow = selectedExecution.rows[0];
      if (!executionRow) throw new Error(`Execution ${executionId} 的投影不存在`);
      const execution = json<JsonObject>(executionRow.value_json);
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
      const jobChange = await client.query(`
        update mn_v2.jobs set status = 'failed', result_json = null,
          failure_json = $1::jsonb, lease_owner = null, lease_expires_at = null,
          updated_at = $2::timestamptz
        where job_id = $3 and status = 'leased' and lease_owner = $4 and fencing_token = $5
          and lease_expires_at > $2::timestamptz
      `, [
        JSON.stringify(failure),
        input.occurredAt,
        input.jobId,
        input.workerId,
        input.fencingToken,
      ]);
      if (jobChange.rowCount !== 1) throw new StaleFencingTokenError(input.jobId);
      await this.#appendEvent(client, {
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
      for (const projection of [
        { namespace: "execution", key: executionId, streamVersion: streamVersion + 1, value: updatedExecution },
        { namespace: "inbox", key: inboxId, streamVersion: 0, value: inbox },
      ] as const) {
        await client.query(`
          insert into mn_v2.projections (
            tenant_id, namespace, projection_key, stream_version, value_json, updated_at
          ) values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
          on conflict (tenant_id, namespace, projection_key) do update set
            stream_version = excluded.stream_version,
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `, [
          tenantId,
          projection.namespace,
          projection.key,
          projection.streamVersion,
          JSON.stringify(projection.value),
          input.occurredAt,
        ]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async getJob(jobId: string): Promise<StoredJob | undefined> {
    const result = await this.#pool.query("select * from mn_v2.jobs where job_id = $1", [jobId]);
    return result.rows[0] ? rowToJob(result.rows[0]) : undefined;
  }

  async close(): Promise<void> {
    await this.#pool.end?.();
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
