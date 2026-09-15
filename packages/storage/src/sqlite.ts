// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EventAppendRequest, JsonObject, JsonValue, KernelEventV1 } from "@mn/contracts";
import { createProjectionFacts, CORE_PROJECTION_NAMESPACES, replayCoreProjections } from "@mn/contracts";

import { computeEventDigest, computeEventHmac, assertEventPageIntegrity } from "./integrity.js";
import { captureProjectionJournal, readJournalProjection, prepareJournalRebuild, collectJournalCasReferences, isJournalNamespace, type ProjectionJournalOptions } from "./projection-journal.js";
import { FileCas } from "./cas.js";
import type { KeyProvider } from "./encryption.js";
import { assertLocalStateLock, type LocalStateLock } from "./local-state-lock.js";
import { serializeAsyncMethods } from "./serial-methods.js";
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
  readonly projectionJournal?: ProjectionJournalOptions;
}

type RecordRow = Record<string, unknown>;

interface JobLifecycleContext {
  readonly tenantId: string;
  readonly jobId: string;
  readonly workspaceId?: string;
  readonly executionId?: string;
  readonly generation: number;
  readonly jobProjection: JsonObject;
  readonly execution?: JsonObject;
}

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
  readonly #stateRoot: string;
  #projectionJournal?: ProjectionJournalOptions;
  #closed = false;

  constructor(options: SqliteStorageOptions) {
    if (options.hmacKey.byteLength < 32) throw new TypeError("Event HMAC key must contain at least 32 bytes");
    mkdirSync(dirname(options.databaseFile), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(options.databaseFile);
    this.#stateRoot = resolve(dirname(options.databaseFile));
    chmodSync(options.databaseFile, 0o600);
    this.#hmacKey = Buffer.from(options.hmacKey);
    this.#now = options.now ?? (() => new Date());
    this.#projectionJournal = options.projectionJournal;
    this.#database.exec("pragma journal_mode = WAL");
    this.#database.exec("pragma synchronous = FULL");
    this.#database.exec("pragma foreign_keys = ON");
    this.#database.exec("pragma busy_timeout = 5000");
    this.#database.exec(SQLITE_SCHEMA);
    this.#database.prepare(`
      insert into storage_meta (key, value) values ('schema_version', '1')
      on conflict(key) do nothing
    `).run();
    serializeAsyncMethods(this, ["initialize", "listTenantIds", "transact", "commit", "readEvents", "readEventHistory", "rebuildJournalProjections", "rebuildProjections",
      "advanceRetentionFloor", "getProjection", "listOutbox", "getApproval", "claimJob", "completeJob",
      "renewJobLease", "failJob", "interruptJob", "markNeedsReconciliation", "getJob", "gcLocalOrphans", "close"]);
  }

  configureProjectionJournal(options: ProjectionJournalOptions): void {
    if (this.#projectionJournal) throw new Error("Projection journal is already configured");
    this.#projectionJournal = options;
  }

  async initialize(): Promise<void> {}

  /** Called only during cold start, before the state owner exposes HTTP or starts its Worker. */
  async gcLocalOrphans(options: { readonly lock: LocalStateLock; readonly keyProvider: KeyProvider }): Promise<{
    readonly status: "completed" | "not_due" | "empty"; readonly removedObjects: number;
  }> {
    this.#assertOpen();
    assertLocalStateLock(options.lock, this.#stateRoot);
    const now = this.#now();
    const last = this.#database.prepare("select value from storage_meta where key = 'cas_gc_last_success'").get() as RecordRow | undefined;
    if (last && Date.parse(String(last.value)) <= now.getTime() && now.getTime() - Date.parse(String(last.value)) < 86_400_000) {
      return { status: "not_due", removedObjects: 0 };
    }
    this.#database.exec("begin immediate");
    try {
      const tenants = (this.#database.prepare("select tenant_id from tenant_heads union select tenant_id from events order by tenant_id").all() as RecordRow[])
        .map(row => String(row.tenant_id));
      if (!tenants.length) { this.#database.exec("commit"); return { status: "empty", removedObjects: 0 }; }
      const cas = new FileCas({ rootDir: join(this.#stateRoot, "cas") });
      const referenced = new Set<string>();
      const deadlineMilliseconds = Date.now() + 10_000;
      for (const tenantId of tenants) {
        const head = this.#database.prepare("select next_position from tenant_heads where tenant_id = ?").get(tenantId) as RecordRow | undefined;
        if (!head) throw new Error("Local CAS verification is missing the tenant event head");
        const expectedPosition = safePosition(head.next_position) - 1;
        if (expectedPosition > 1_000_000) throw new Error("Local CAS verification exceeds the event limit");
        const events = (this.#database.prepare("select * from events where tenant_id = ? order by position").all(tenantId) as RecordRow[]).map(rowToEvent);
        replayCoreProjections(events, tenantId, this.#hmacKey);
        for (const digest of await collectJournalCasReferences({ cas, keyProvider: options.keyProvider, namespaces: ["*non-core"],
          events, tenantId, expectedPosition, hmacKey: this.#hmacKey, deadlineMilliseconds })) referenced.add(digest);
      }
      assertLocalStateLock(options.lock, this.#stateRoot);
      const cutoff = new Date(now.getTime() - 7 * 86_400_000);
      const removed = await cas.gcOrphans(referenced, cutoff);
      const runId = randomUUID();
      for (const tenantId of tenants) {
        const event = this.#appendEvent({ tenantId, aggregateType: "storageMaintenance", aggregateId: runId,
          expectedStreamVersion: 0, type: "storage.local_gc_completed", actorId: "local-owner", generation: 0,
          correlationId: runId, publicPayload: { cutoff: cutoff.toISOString(), removedObjects: removed.length } }, now.toISOString());
        this.#writeOutbox({ outbox: [{ id: `local-gc:${tenantId}:${runId}`, tenantId, topic: event.type,
          payload: { eventId: event.id }, availableAt: event.occurredAt }] }, event.occurredAt);
      }
      this.#database.prepare("insert into storage_meta (key, value) values ('cas_gc_last_success', ?) on conflict(key) do update set value = excluded.value")
        .run(now.toISOString());
      this.#database.exec("commit");
      return { status: "completed", removedObjects: removed.length };
    } catch (error) { this.#database.exec("rollback"); throw error; }
  }

  async listTenantIds(): Promise<readonly string[]> {
    this.#assertOpen();
    const rows = this.#database.prepare(
      "select tenant_id from tenant_heads union select tenant_id from events order by tenant_id asc",
    ).all() as RecordRow[];
    return rows.map((row) => String(row.tenant_id));
  }

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
        },
        assertJobLease: (input) => {
          const row = this.#database.prepare(`
            select status, lease_owner, lease_expires_at, fencing_token
            from jobs where tenant_id = ? and job_id = ?
          `).get(tenantId, input.jobId) as RecordRow | undefined;
          const projectionRow = this.#database.prepare(`
            select value_json from projections
            where tenant_id = ? and namespace = 'job' and projection_key = ?
          `).get(tenantId, input.jobId) as RecordRow | undefined;
          const projection = projectionRow
            ? parseJson<Record<string, unknown>>(projectionRow.value_json)
            : undefined;
          if (!row
            || row.status !== "leased"
            || row.lease_owner !== input.workerId
            || Number(row.fencing_token) !== input.fencingToken
            || typeof row.lease_expires_at !== "string"
            || Date.parse(row.lease_expires_at) <= Date.parse(input.occurredAt)
            || !projection
            || projection.status !== "leased"
            || projection.leaseOwner !== input.workerId
            || projection.fencingToken !== input.fencingToken
            || typeof projection.leaseExpiresAt !== "string"
            || Date.parse(projection.leaseExpiresAt) <= Date.parse(input.occurredAt)) {
            throw new StaleFencingTokenError(input.jobId);
          }
        },
        settleJob: (input) => {
          validTimestamp(input.occurredAt);
          this.#settleLeasedJob(
            input.jobId,
            input.workerId,
            input.fencingToken,
            input.outcome,
            input.value,
            input.occurredAt
          );
          return { ...input, settled: true as const };
        },
        invalidateJob: (input) => {
          validTimestamp(input.occurredAt);
          const row = this.#database.prepare(`
            select status, fencing_token from jobs
            where tenant_id = ? and job_id = ?
          `).get(tenantId, input.jobId) as RecordRow | undefined;
          const projectionRow = this.#database.prepare(`
            select value_json from projections
            where tenant_id = ? and namespace = 'job' and projection_key = ?
          `).get(tenantId, input.jobId) as RecordRow | undefined;
          const projection = projectionRow
            ? parseJson<Record<string, unknown>>(projectionRow.value_json)
            : undefined;
          if (!row
            || (row.status !== "available" && row.status !== "leased")
            || !projection
            || projection.status !== row.status
            || Number(projection.fencingToken) !== Number(row.fencing_token)) {
            throw new Error(`Job ${input.jobId} 不是可失效的待执行 Job`);
          }
          const fencingToken = Number(row.fencing_token) + 1;
          const changed = this.#database.prepare(`
            update jobs set status = 'failed', failure_json = ?, result_json = null,
              lease_owner = null, lease_expires_at = null, fencing_token = ?, updated_at = ?
            where tenant_id = ? and job_id = ? and status = ? and fencing_token = ?
          `).run(
            JSON.stringify(input.reason),
            fencingToken,
            input.occurredAt,
            tenantId,
            input.jobId,
            row.status,
            Number(row.fencing_token),
          );
          if (Number(changed.changes) !== 1) {
            throw new Error(`Job ${input.jobId} 在失效时状态已变化`);
          }
          return {
            ...input,
            invalidated: true as const,
            previousStatus: row.status,
            fencingToken,
          };
        }
      };
      const journal = this.#projectionJournal ? captureProjectionJournal(transaction, tenantId, this.#projectionJournal,
        (this.#database.prepare("select namespace, projection_key, value_json from projections where tenant_id = ?")
          .all(tenantId) as RecordRow[]).map(row => ({ namespace: String(row.namespace), id: String(row.projection_key), value: parseJson(row.value_json) })),
        (this.#database.prepare("select hex(idempotency_key) as encoded_key, request_hash, response_json, created_at from idempotency where tenant_id = ?")
          .all(tenantId) as RecordRow[]).flatMap(row => {
            const key = Buffer.from(String(row.encoded_key), "hex").toString("utf8"); const separator = key.indexOf("\0");
            return separator < 0 ? [] : [{ tenantId, scope: key.slice(0, separator), key: key.slice(separator + 1),
              requestDigest: String(row.request_hash), response: parseJson(row.response_json), createdAt: String(row.created_at) }];
          })) : undefined;
      await journal?.prepare();
      const result = work(journal?.transaction ?? transaction);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new TypeError("Storage transaction callbacks must be synchronous");
      }
      await journal?.flush(() => this.#now().toISOString());
      this.#database.exec("commit");
      return result;
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  async commit(batch: StorageCommit): Promise<StorageCommitResult> {
    this.#assertOpen();
    if (this.#projectionJournal && batch.projections?.some(row => isJournalNamespace(row.namespace, this.#projectionJournal!))) {
      throw new Error("Protected projection writes require a journaled Kernel transaction");
    }
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
    return this.#eventPage(tenantId, options, true);
  }

  async readEventHistory(tenantId: string, afterPosition: number, limit: number): Promise<import("@mn/contracts").EventPage> {
    return this.#eventPage(tenantId, { afterPosition, limit }, false);
  }

  #eventPage(tenantId: string, options: EventReadOptions, enforceRetention: boolean): import("@mn/contracts").EventPage {
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
    if (enforceRetention && options.afterPosition < retentionFloor - 1) {
      throw new CursorExpiredError(tenantId, retentionFloor);
    }
    const rows = this.#database.prepare(`
      select * from events
      where tenant_id = ? and position > ?
      order by position asc
      limit ?
    `).all(tenantId, options.afterPosition, options.limit) as RecordRow[];
    const events = rows.map(rowToEvent);
    assertEventPageIntegrity(events, tenantId, options.afterPosition, options.limit, head ? safePosition(head.next_position) - 1 : 0, this.#hmacKey);
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
      // The SSE cursor floor does not destroy authoritative facts required for rebuilding projections.
      this.#database.exec("commit");
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  async rebuildJournalProjections(tenantId: string): Promise<{ readonly position: number; readonly count: number }> {
    return this.#rebuildProjections(tenantId, false);
  }

  async rebuildProjections(tenantId: string): Promise<{ readonly position: number; readonly count: number }> {
    return this.#rebuildProjections(tenantId, true);
  }

  async #rebuildProjections(tenantId: string, includeCore: boolean): Promise<{ readonly position: number; readonly count: number }> {
    this.#assertOpen();
    if (!this.#projectionJournal) throw new Error("Projection journal is not configured");
    this.#database.exec("begin immediate");
    try {
      const head = this.#database.prepare("select next_position from tenant_heads where tenant_id = ?").get(tenantId) as RecordRow | undefined;
      const position = head ? safePosition(head.next_position) - 1 : 0;
      const events = (this.#database.prepare("select * from events where tenant_id = ? order by position").all(tenantId) as RecordRow[]).map(rowToEvent);
      const plan = await prepareJournalRebuild({ ...this.#projectionJournal, tenantId, events, expectedPosition: position, hmacKey: this.#hmacKey });
      const core = includeCore ? replayCoreProjections(events, tenantId, this.#hmacKey).records : [];
      const namespaces = this.#database.prepare("select distinct namespace from projections where tenant_id = ?").all(tenantId) as RecordRow[];
      for (const row of namespaces) if (isJournalNamespace(String(row.namespace), this.#projectionJournal)
        || (includeCore && (CORE_PROJECTION_NAMESPACES as readonly string[]).includes(String(row.namespace)))) {
        this.#database.prepare("delete from projections where tenant_id = ? and namespace = ?").run(tenantId, String(row.namespace));
      }
      const timestamp = this.#now().toISOString();
      this.#writeProjections({ projections: [...plan.projections, ...core].map(row => ({ tenantId, namespace: row.namespace, key: row.id,
        streamVersion: Number((row.value as JsonObject).streamVersion ?? 0), value: row.value as JsonObject })) }, timestamp);
      this.#database.prepare("delete from idempotency where tenant_id = ? and json_extract(response_json, '$.format') = 'muniu.projection.reference'").run(tenantId);
      for (const receipt of plan.idempotency) this.#database.prepare(`
        insert into idempotency (tenant_id, idempotency_key, request_hash, response_json, created_at) values (?, ?, ?, ?, ?)
        on conflict(tenant_id, idempotency_key) do update set request_hash = excluded.request_hash,
        response_json = excluded.response_json, created_at = excluded.created_at
      `).run(tenantId, `${receipt.scope}\0${receipt.key}`, receipt.requestDigest, JSON.stringify(receipt.response), receipt.createdAt);
      this.#database.exec("commit");
      return { position, count: plan.projections.length + core.length };
    } catch (error) { this.#database.exec("rollback"); throw error; }
  }

  async getProjection(tenantId: string, namespace: string, key: string): Promise<JsonObject | undefined> {
    const row = this.#database.prepare(`
      select value_json from projections
      where tenant_id = ? and namespace = ? and projection_key = ?
    `).get(tenantId, namespace, key) as RecordRow | undefined;
    const value = row ? parseJson<JsonObject>(row.value_json) : undefined;
    return this.#projectionJournal
      ? await readJournalProjection(this.#projectionJournal, tenantId, namespace, key, value) as JsonObject | undefined
      : value;
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
    this.#assertOpen();
    validTimestamp(now);
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
    while (true) {
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
        if (this.#settleTerminalAgentJobBeforeClaim(row, workerId, now)) {
          this.#database.exec("commit");
          continue;
        }
        const leaseExpiresAt = new Date(Date.parse(now) + JOB_LEASE_MILLISECONDS).toISOString();
        const fencingToken = Number(row.fencing_token) + 1;
        this.#database.prepare(`
          update jobs set status = 'leased', attempts = attempts + 1, lease_owner = ?,
            lease_expires_at = ?, fencing_token = ?, updated_at = ? where job_id = ?
        `).run(workerId, leaseExpiresAt, fencingToken, now, String(row.job_id));
        this.#recordJobClaim(row, workerId, leaseExpiresAt, fencingToken, now);
        const claimed = this.#database.prepare("select * from jobs where job_id = ?")
          .get(String(row.job_id)) as RecordRow;
        this.#database.exec("commit");
        return rowToJob(claimed);
      } catch (error) {
        this.#database.exec("rollback");
        throw error;
      }
    }
  }

  async completeJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    result: JsonValue,
    now: string
  ): Promise<void> {
    this.#assertOpen();
    validTimestamp(now);
    this.#database.exec("begin immediate");
    try {
      this.#settleLeasedJob(jobId, workerId, fencingToken, "completed", result, now);
      this.#database.exec("commit");
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  async renewJobLease(
    jobId: string,
    workerId: string,
    fencingToken: number,
    now: string
  ): Promise<void> {
    this.#assertOpen();
    const leaseExpiresAt = new Date(validTimestamp(now) + JOB_LEASE_MILLISECONDS).toISOString();
    this.#database.exec("begin immediate");
    try {
      const job = this.#ownedLeasedJob(jobId, workerId, fencingToken, now);
      const change = this.#database.prepare(`
        update jobs set lease_expires_at = ?, updated_at = ?
        where job_id = ? and status = 'leased' and lease_owner = ? and fencing_token = ?
          and lease_expires_at > ?
      `).run(leaseExpiresAt, now, jobId, workerId, fencingToken, now);
      if (Number(change.changes) !== 1) throw new StaleFencingTokenError(jobId);
      this.#recordJobLeaseRenewal(job, workerId, leaseExpiresAt, fencingToken, now);
      this.#database.exec("commit");
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  async failJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    failure: JsonObject,
    now: string
  ): Promise<void> {
    this.#assertOpen();
    validTimestamp(now);
    this.#database.exec("begin immediate");
    try {
      this.#settleLeasedJob(jobId, workerId, fencingToken, "failed", failure, now);
      this.#database.exec("commit");
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  async interruptJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    reason: string,
    now: string
  ): Promise<void> {
    this.#assertOpen();
    validTimestamp(now);
    if (!reason.trim()) throw new TypeError("中断原因不能为空");
    this.#database.exec("begin immediate");
    try {
      const job = this.#ownedLeasedJob(jobId, workerId, fencingToken, now);
      const failure: JsonObject = {
        code: "EXECUTION_INTERRUPTED",
        message: reason,
        retryable: false
      };
      const change = this.#database.prepare(`
        update jobs set status = 'failed', failure_json = ?, result_json = null,
          lease_owner = null, lease_expires_at = null, updated_at = ?
        where job_id = ? and status = 'leased' and lease_owner = ? and fencing_token = ?
          and lease_expires_at > ?
      `).run(JSON.stringify(failure), now, jobId, workerId, fencingToken, now);
      if (Number(change.changes) !== 1) throw new StaleFencingTokenError(jobId);
      this.#recordJobInterrupted(job, workerId, fencingToken, failure, now);
      this.#database.exec("commit");
    } catch (error) {
      this.#database.exec("rollback");
      throw error;
    }
  }

  #ownedLeasedJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    now: string
  ): RecordRow {
    const job = this.#database.prepare(`
      select * from jobs
      where job_id = ? and status = 'leased' and lease_owner = ? and fencing_token = ?
        and lease_expires_at > ?
    `).get(jobId, workerId, fencingToken, now) as RecordRow | undefined;
    if (!job) throw new StaleFencingTokenError(jobId);
    return job;
  }

  #settleLeasedJob(
    jobId: string,
    workerId: string,
    fencingToken: number,
    outcome: "completed" | "failed",
    value: JsonValue,
    now: string
  ): void {
    const job = this.#ownedLeasedJob(jobId, workerId, fencingToken, now);
    const change = this.#database.prepare(outcome === "completed" ? `
      update jobs set status = 'completed', result_json = ?, failure_json = null,
        lease_owner = null, lease_expires_at = null, updated_at = ?
      where job_id = ? and status = 'leased' and lease_owner = ? and fencing_token = ?
        and lease_expires_at > ?
    ` : `
      update jobs set status = 'failed', failure_json = ?, result_json = null,
        lease_owner = null, lease_expires_at = null, updated_at = ?
      where job_id = ? and status = 'leased' and lease_owner = ? and fencing_token = ?
        and lease_expires_at > ?
    `).run(JSON.stringify(value), now, jobId, workerId, fencingToken, now);
    if (Number(change.changes) !== 1) throw new StaleFencingTokenError(jobId);
    this.#recordJobTerminal(job, workerId, fencingToken, outcome, value, now);
  }

  #jobContext(job: RecordRow): JobLifecycleContext | undefined {
    const tenantId = String(job.tenant_id);
    const jobId = String(job.job_id);
    const payload = parseJson<JsonObject>(job.payload_json);
    const isAgentJob = String(job.kind) === "agent.execution.run";
    const projectionRow = this.#database.prepare(`
      select value_json from projections
      where tenant_id = ? and namespace = 'job' and projection_key = ?
    `).get(tenantId, jobId) as RecordRow | undefined;
    if (!projectionRow) {
      if (isAgentJob) throw new Error(`Job ${jobId} 的投影不存在`);
      return undefined;
    }
    const jobProjection = parseJson<JsonObject>(projectionRow.value_json);
    if (jobProjection.tenantId !== tenantId
      || jobProjection.kind !== String(job.kind)
      || requiredString(jobProjection.id, "Job id") !== jobId) {
      throw new Error("Job 物理记录与查询投影不一致");
    }
    const projectedWorkspaceId = typeof jobProjection.workspaceId === "string"
      ? jobProjection.workspaceId
      : undefined;
    const physicalWorkspaceId = job.workspace_id === null ? undefined : String(job.workspace_id);
    if (projectedWorkspaceId !== physicalWorkspaceId) {
      throw new Error("Job 工作区与查询投影不一致");
    }
    if (!isAgentJob) {
      const correlatedExecutionId = typeof payload.executionId === "string"
        ? payload.executionId
        : typeof payload.reconciliationExecutionId === "string"
          ? payload.reconciliationExecutionId
          : undefined;
      const payloadGeneration = payload.generation;
      const generation = typeof payloadGeneration === "number"
        && Number.isSafeInteger(payloadGeneration)
        && payloadGeneration >= 1
        ? payloadGeneration
        : 1;
      return {
        tenantId,
        jobId,
        ...(physicalWorkspaceId ? { workspaceId: physicalWorkspaceId } : {}),
        ...(correlatedExecutionId ? { executionId: correlatedExecutionId } : {}),
        generation,
        jobProjection
      };
    }
    const executionId = requiredString(payload.executionId, "Job executionId");
    const execution = this.#requiredProjection(tenantId, "execution", executionId, "Execution");
    if (execution.tenantId !== tenantId) throw new Error("Job 与 Execution 所属租户不一致");
    const executionWorkspaceId = requiredString(execution.workspaceId, "Execution workspaceId");
    if (executionWorkspaceId !== physicalWorkspaceId) {
      throw new Error("Job 与 Execution 所属工作区不一致");
    }
    return {
      tenantId,
      jobId,
      executionId,
      workspaceId: executionWorkspaceId,
      generation: requiredSafeInteger(execution.generation, "Execution generation"),
      execution,
      jobProjection
    };
  }

  #requiredProjection(
    tenantId: string,
    namespace: string,
    key: string,
    label: string
  ): JsonObject {
    const row = this.#database.prepare(`
      select value_json from projections
      where tenant_id = ? and namespace = ? and projection_key = ?
    `).get(tenantId, namespace, key) as RecordRow | undefined;
    if (!row) throw new Error(`${label} ${key} 的投影不存在`);
    return parseJson<JsonObject>(row.value_json);
  }

  #putProjectionValue(
    tenantId: string,
    namespace: string,
    key: string,
    streamVersion: number,
    value: JsonObject,
    updatedAt: string
  ): void {
    this.#database.prepare(`
      insert into projections (
        tenant_id, namespace, projection_key, stream_version, value_json, updated_at
      ) values (?, ?, ?, ?, ?, ?)
      on conflict(tenant_id, namespace, projection_key) do update set
        stream_version = excluded.stream_version,
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(tenantId, namespace, key, streamVersion, JSON.stringify(value), updatedAt);
  }

  #settleTerminalAgentJobBeforeClaim(
    job: RecordRow,
    workerId: string,
    now: string
  ): boolean {
    const context = this.#jobContext(job);
    if (!context?.execution || !context.executionId || !context.workspaceId) return false;
    const executionStatus = String(context.execution.status);
    const failure = terminalExecutionClaimFailure(executionStatus);
    if (!failure) return false;
    const jobStreamVersion = requiredSafeInteger(
      context.jobProjection.streamVersion,
      "Job streamVersion"
    );
    const projectedAttempts = requiredSafeInteger(context.jobProjection.attempts, "Job attempts");
    const projectedFencingToken = requiredSafeInteger(
      context.jobProjection.fencingToken,
      "Job fencingToken"
    );
    if (context.jobProjection.status !== String(job.status)
      || projectedAttempts !== Number(job.attempts)
      || projectedFencingToken !== Number(job.fencing_token)
      || (job.status === "leased"
        && (context.jobProjection.leaseOwner !== job.lease_owner
          || context.jobProjection.leaseExpiresAt !== String(job.lease_expires_at)))) {
      throw new Error("Job 物理状态与查询投影不一致");
    }
    const changed = this.#database.prepare(`
      update jobs set status = 'failed', result_json = null, failure_json = ?,
        lease_owner = null, lease_expires_at = null, updated_at = ?
      where job_id = ? and status = ? and fencing_token = ?
    `).run(
      JSON.stringify(failure),
      now,
      String(job.job_id),
      String(job.status),
      Number(job.fencing_token)
    );
    if (Number(changed.changes) !== 1) throw new StaleFencingTokenError(String(job.job_id));
    const {
      leaseOwner: _leaseOwner,
      leaseExpiresAt: _leaseExpiresAt,
      result: _priorResult,
      failure: _priorFailure,
      ...jobWithoutLease
    } = context.jobProjection;
    const updatedJob: JsonObject = {
      ...jobWithoutLease,
      status: "failed",
      failure,
      streamVersion: jobStreamVersion + 1,
      updatedAt: now
    };
    this.#appendEvent({
      tenantId: context.tenantId,
      aggregateType: "job",
      aggregateId: String(job.job_id),
      expectedStreamVersion: jobStreamVersion,
      type: "job.failed",
      actorId: `worker:${workerId}`,
      executionId: context.executionId,
      generation: context.generation,
      correlationId: `job:${String(job.job_id)}:terminal-before-claim`,
      publicPayload: {
        projectionFacts: createProjectionFacts([{ namespace: "job", id: String(updatedJob.id), value: updatedJob }]),

        workspaceId: context.workspaceId,
        executionId: context.executionId,
        status: "failed",
        failureCode: String(failure.code),
        executionStatus,
        fencingToken: Number(job.fencing_token)
      }
    }, now);
    this.#putProjectionValue(
      context.tenantId,
      "job",
      String(job.job_id),
      jobStreamVersion + 1,
      updatedJob,
      now
    );
    return true;
  }

  #recordJobClaim(
    job: RecordRow,
    workerId: string,
    leaseExpiresAt: string,
    fencingToken: number,
    now: string
  ): void {
    const context = this.#jobContext(job);
    if (!context) return;
    const jobStreamVersion = requiredSafeInteger(
      context.jobProjection.streamVersion,
      "Job streamVersion"
    );
    const priorFencingToken = requiredSafeInteger(
      context.jobProjection.fencingToken,
      "Job fencingToken"
    );
    const projectedAttempts = requiredSafeInteger(context.jobProjection.attempts, "Job attempts");
    if (context.jobProjection.status !== String(job.status)
      || projectedAttempts !== Number(job.attempts)
      || priorFencingToken !== Number(job.fencing_token)
      || (job.status === "leased"
        && (context.jobProjection.leaseOwner !== job.lease_owner
          || context.jobProjection.leaseExpiresAt !== String(job.lease_expires_at)))) {
      throw new Error("Job 物理状态与查询投影不一致");
    }
    const updatedJob: JsonObject = {
      ...context.jobProjection,
      status: "leased",
      attempts: Number(job.attempts) + 1,
      leaseOwner: workerId,
      leaseExpiresAt,
      fencingToken,
      streamVersion: jobStreamVersion + 1,
      updatedAt: now
    };
    this.#appendEvent({
      tenantId: context.tenantId,
      aggregateType: "job",
      aggregateId: String(job.job_id),
      expectedStreamVersion: jobStreamVersion,
      type: "job.leased",
      actorId: `worker:${workerId}`,
      ...(context.executionId ? { executionId: context.executionId } : {}),
      generation: context.generation,
      correlationId: `job:${String(job.job_id)}:fence:${fencingToken}`,
      publicPayload: {
        projectionFacts: createProjectionFacts([{ namespace: "job", id: String(updatedJob.id), value: updatedJob }]),

        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(context.executionId ? { executionId: context.executionId } : {}),
        jobId: context.jobId,
        kind: String(job.kind),
        workerId,
        fencingToken,
        leaseExpiresAt
      }
    }, now);
    this.#putProjectionValue(
      context.tenantId,
      "job",
      String(job.job_id),
      jobStreamVersion + 1,
      updatedJob,
      now
    );

    if (!context.execution || !context.executionId || !context.workspaceId) return;
    if (context.execution.status === "running" || context.execution.status === "waiting_approval") {
      return;
    }
    if (context.execution.status !== "queued") {
      throw new Error(`状态为 ${String(context.execution.status)} 的 Execution 不能领取 Agent Job`);
    }
    const executionStreamVersion = requiredSafeInteger(
      context.execution.streamVersion,
      "Execution streamVersion"
    );
    const updatedExecution: JsonObject = {
      ...context.execution,
      status: "running",
      startedAt: context.execution.startedAt ?? now,
      streamVersion: executionStreamVersion + 1,
      updatedAt: now
    };
    this.#appendEvent({
      tenantId: context.tenantId,
      aggregateType: "execution",
      aggregateId: context.executionId,
      expectedStreamVersion: executionStreamVersion,
      type: "execution.running",
      actorId: `worker:${workerId}`,
      executionId: context.executionId,
      generation: context.generation,
      correlationId: `job:${String(job.job_id)}:fence:${fencingToken}`,
      publicPayload: {
        projectionFacts: createProjectionFacts([{ namespace: "execution", id: String(updatedExecution.id), value: updatedExecution }]),

        workspaceId: context.workspaceId,
        jobId: String(job.job_id),
        status: "running",
        workerId,
        fencingToken
      }
    }, now);
    this.#putProjectionValue(
      context.tenantId,
      "execution",
      context.executionId,
      executionStreamVersion + 1,
      updatedExecution,
      now
    );
  }

  #recordJobLeaseRenewal(
    job: RecordRow,
    workerId: string,
    leaseExpiresAt: string,
    fencingToken: number,
    now: string
  ): void {
    const context = this.#jobContext(job);
    if (!context) return;
    const jobStreamVersion = requiredSafeInteger(
      context.jobProjection.streamVersion,
      "Job streamVersion"
    );
    if (context.jobProjection.status !== "leased"
      || context.jobProjection.leaseOwner !== workerId
      || context.jobProjection.fencingToken !== fencingToken
      || context.jobProjection.leaseExpiresAt !== String(job.lease_expires_at)) {
      throw new Error("Job 租约与查询投影不一致");
    }
    const updatedJob: JsonObject = {
      ...context.jobProjection,
      leaseExpiresAt,
      streamVersion: jobStreamVersion + 1,
      updatedAt: now
    };
    this.#appendEvent({
      tenantId: context.tenantId,
      aggregateType: "job",
      aggregateId: String(job.job_id),
      expectedStreamVersion: jobStreamVersion,
      type: "job.lease_renewed",
      actorId: `worker:${workerId}`,
      ...(context.executionId ? { executionId: context.executionId } : {}),
      generation: context.generation,
      correlationId: `job:${String(job.job_id)}:fence:${fencingToken}`,
      publicPayload: {
        projectionFacts: createProjectionFacts([{ namespace: "job", id: String(updatedJob.id), value: updatedJob }]),

        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(context.executionId ? { executionId: context.executionId } : {}),
        jobId: context.jobId,
        kind: String(job.kind),
        workerId,
        fencingToken,
        leaseExpiresAt
      }
    }, now);
    this.#putProjectionValue(
      context.tenantId,
      "job",
      String(job.job_id),
      jobStreamVersion + 1,
      updatedJob,
      now
    );
  }

  #recordJobTerminal(
    job: RecordRow,
    workerId: string,
    fencingToken: number,
    outcome: "completed" | "failed",
    value: JsonValue,
    now: string
  ): void {
    const context = this.#jobContext(job);
    if (!context) return;
    const jobStreamVersion = requiredSafeInteger(
      context.jobProjection.streamVersion,
      "Job streamVersion"
    );
    if (context.jobProjection.status !== "leased"
      || context.jobProjection.leaseOwner !== workerId
      || context.jobProjection.fencingToken !== fencingToken
      || context.jobProjection.leaseExpiresAt !== String(job.lease_expires_at)) {
      throw new Error("Job 租约与查询投影不一致");
    }
    const {
      leaseOwner: _leaseOwner,
      leaseExpiresAt: _leaseExpiresAt,
      result: _priorResult,
      failure: _priorFailure,
      ...jobWithoutLease
    } = context.jobProjection;
    const updatedJob: JsonObject = {
      ...jobWithoutLease,
      status: outcome,
      ...(outcome === "completed" ? { result: value } : { failure: value }),
      streamVersion: jobStreamVersion + 1,
      updatedAt: now
    };
    this.#appendEvent({
      tenantId: context.tenantId,
      aggregateType: "job",
      aggregateId: String(job.job_id),
      expectedStreamVersion: jobStreamVersion,
      type: `job.${outcome}`,
      actorId: `worker:${workerId}`,
      ...(context.executionId ? { executionId: context.executionId } : {}),
      generation: context.generation,
      correlationId: `job:${String(job.job_id)}:fence:${fencingToken}`,
      publicPayload: {
        projectionFacts: createProjectionFacts([{ namespace: "job", id: String(updatedJob.id), value: updatedJob }]),

        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(context.executionId ? { executionId: context.executionId } : {}),
        jobId: context.jobId,
        kind: String(job.kind),
        status: outcome,
        fencingToken
      }
    }, now);
    this.#putProjectionValue(
      context.tenantId,
      "job",
      String(job.job_id),
      jobStreamVersion + 1,
      updatedJob,
      now
    );

    if (!context.execution || !context.executionId || !context.workspaceId) return;
    const failureObject = outcome === "failed"
      && typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      ? value as JsonObject
      : undefined;
    const failureCode = typeof failureObject?.code === "string" && failureObject.code
      ? failureObject.code
      : "WORKER_FAILED";
    const executionStatus = String(context.execution.status);
    const nextStatus = outcome === "completed" && value && typeof value === "object" && !Array.isArray(value)
      && "status" in value && value.status === "paused" ? "paused" : outcome;
    if (outcome === "failed" && (executionStatus === "failed"
      || executionStatus === "completed"
      || (executionStatus === "cancelled" && failureCode === "EXECUTION_CANCELLED"))) {
      return;
    }
    const acceptedStatuses = outcome === "completed"
      ? ["running"]
      : ["running", "waiting_approval"];
    if (!acceptedStatuses.includes(String(context.execution.status))) {
      throw new Error(`状态为 ${String(context.execution.status)} 的 Execution 不能标记为 ${outcome}`);
    }
    const executionStreamVersion = requiredSafeInteger(
      context.execution.streamVersion,
      "Execution streamVersion"
    );
    const updatedExecution: JsonObject = {
      ...context.execution,
      status: nextStatus,
      ...(outcome === "failed" ? { failureCode } : {}),
      ...(nextStatus === "paused" ? {} : { finishedAt: now }),
      streamVersion: executionStreamVersion + 1,
      updatedAt: now
    };
    this.#appendEvent({
      tenantId: context.tenantId,
      aggregateType: "execution",
      aggregateId: context.executionId,
      expectedStreamVersion: executionStreamVersion,
      type: `execution.${nextStatus}`,
      actorId: `worker:${workerId}`,
      executionId: context.executionId,
      generation: context.generation,
      correlationId: `job:${String(job.job_id)}:fence:${fencingToken}`,
      publicPayload: {
        projectionFacts: createProjectionFacts([{ namespace: "execution", id: String(updatedExecution.id), value: updatedExecution }]),

        workspaceId: context.workspaceId,
        jobId: String(job.job_id),
        status: nextStatus,
        ...(outcome === "failed" ? { failureCode } : {})
      }
    }, now);
    this.#putProjectionValue(
      context.tenantId,
      "execution",
      context.executionId,
      executionStreamVersion + 1,
      updatedExecution,
      now
    );
  }

  #recordJobInterrupted(
    job: RecordRow,
    workerId: string,
    fencingToken: number,
    failure: JsonObject,
    now: string
  ): void {
    const context = this.#jobContext(job);
    if (!context) return;
    const jobStreamVersion = requiredSafeInteger(
      context.jobProjection.streamVersion,
      "Job streamVersion"
    );
    if (context.jobProjection.status !== "leased"
      || context.jobProjection.leaseOwner !== workerId
      || context.jobProjection.fencingToken !== fencingToken
      || context.jobProjection.leaseExpiresAt !== String(job.lease_expires_at)) {
      throw new Error("Job 租约与查询投影不一致");
    }
    const {
      leaseOwner: _leaseOwner,
      leaseExpiresAt: _leaseExpiresAt,
      result: _priorResult,
      failure: _priorFailure,
      ...jobWithoutLease
    } = context.jobProjection;
    const updatedJob: JsonObject = {
      ...jobWithoutLease,
      status: "failed",
      failure,
      streamVersion: jobStreamVersion + 1,
      updatedAt: now
    };
    this.#appendEvent({
      tenantId: context.tenantId,
      aggregateType: "job",
      aggregateId: String(job.job_id),
      expectedStreamVersion: jobStreamVersion,
      type: "job.failed",
      actorId: `worker:${workerId}`,
      ...(context.executionId ? { executionId: context.executionId } : {}),
      generation: context.generation,
      correlationId: `job:${String(job.job_id)}:fence:${fencingToken}`,
      publicPayload: {
        projectionFacts: createProjectionFacts([{ namespace: "job", id: String(updatedJob.id), value: updatedJob }]),

        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(context.executionId ? { executionId: context.executionId } : {}),
        jobId: context.jobId,
        kind: String(job.kind),
        status: "failed",
        failureCode: "EXECUTION_INTERRUPTED",
        fencingToken
      }
    }, now);
    this.#putProjectionValue(
      context.tenantId,
      "job",
      String(job.job_id),
      jobStreamVersion + 1,
      updatedJob,
      now
    );

    if (!context.execution || !context.executionId || !context.workspaceId) return;
    if (context.execution.status !== "running"
      && context.execution.status !== "waiting_approval") {
      throw new Error(`状态为 ${String(context.execution.status)} 的 Execution 不能中断`);
    }
    const executionStreamVersion = requiredSafeInteger(
      context.execution.streamVersion,
      "Execution streamVersion"
    );
    const { finishedAt: _finishedAt, failureCode: _failureCode, ...executionBase } = context.execution;
    const updatedExecution: JsonObject = {
      ...executionBase,
      status: "interrupted",
      streamVersion: executionStreamVersion + 1,
      updatedAt: now
    };
    this.#appendEvent({
      tenantId: context.tenantId,
      aggregateType: "execution",
      aggregateId: context.executionId,
      expectedStreamVersion: executionStreamVersion,
      type: "execution.interrupted",
      actorId: `worker:${workerId}`,
      executionId: context.executionId,
      generation: context.generation,
      correlationId: `job:${String(job.job_id)}:fence:${fencingToken}`,
      publicPayload: {
        projectionFacts: createProjectionFacts([{ namespace: "execution", id: String(updatedExecution.id), value: updatedExecution }]),

        workspaceId: context.workspaceId,
        jobId: String(job.job_id),
        status: "interrupted",
        reason: requiredString(failure.message, "中断原因"),
        fencingToken
      }
    }, now);
    this.#putProjectionValue(
      context.tenantId,
      "execution",
      context.executionId,
      executionStreamVersion + 1,
      updatedExecution,
      now
    );
  }

  #recordAgentJobNeedsReconciliation(
    job: RecordRow,
    workerId: string,
    fencingToken: number,
    failure: JsonObject,
    now: string
  ): void {
    const context = this.#jobContext(job);
    if (!context?.execution || !context.executionId || !context.workspaceId) return;
    const jobStreamVersion = requiredSafeInteger(
      context.jobProjection.streamVersion,
      "Job streamVersion"
    );
    if (context.jobProjection.status !== "leased"
      || context.jobProjection.leaseOwner !== workerId
      || context.jobProjection.fencingToken !== fencingToken
      || context.jobProjection.leaseExpiresAt !== String(job.lease_expires_at)) {
      throw new Error("Job 租约与查询投影不一致");
    }
    const {
      leaseOwner: _leaseOwner,
      leaseExpiresAt: _leaseExpiresAt,
      result: _priorResult,
      failure: _priorFailure,
      ...jobWithoutLease
    } = context.jobProjection;
    const updatedJob: JsonObject = {
      ...jobWithoutLease,
      status: "failed",
      failure,
      streamVersion: jobStreamVersion + 1,
      updatedAt: now
    };
    this.#appendEvent({
      tenantId: context.tenantId,
      aggregateType: "job",
      aggregateId: String(job.job_id),
      expectedStreamVersion: jobStreamVersion,
      type: "job.failed",
      actorId: `worker:${workerId}`,
      executionId: context.executionId,
      generation: context.generation,
      correlationId: `reconciliation:${String(job.job_id)}:${fencingToken}`,
      publicPayload: {
        projectionFacts: createProjectionFacts([{ namespace: "job", id: String(updatedJob.id), value: updatedJob }]),

        workspaceId: context.workspaceId,
        executionId: context.executionId,
        status: "failed",
        failureCode: "UNKNOWN_EXTERNAL_SIDE_EFFECT",
        needsReconciliation: true,
        fencingToken
      }
    }, now);
    this.#putProjectionValue(
      context.tenantId,
      "job",
      String(job.job_id),
      jobStreamVersion + 1,
      updatedJob,
      now
    );
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
      this.#recordAgentJobNeedsReconciliation(
        job,
        input.workerId,
        input.fencingToken,
        failure,
        input.occurredAt
      );
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
        publicPayload: {
          projectionFacts: createProjectionFacts([
            { namespace: "execution", id: String(updatedExecution.id), value: updatedExecution },
            { namespace: "inbox", id: inboxId, value: inbox },
          ]),
          workspaceId, jobId: input.jobId, status: "needs_reconciliation",
        },
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

function terminalExecutionClaimFailure(status: string): JsonObject | undefined {
  if (status === "cancelled") {
    return {
      code: "EXECUTION_CANCELLED",
      message: "Execution 已在领取 Job 前取消",
      retryable: false
    };
  }
  if (status === "completed" || status === "failed") {
    return {
      code: "EXECUTION_ALREADY_TERMINAL",
      message: "Execution 已在领取 Job 前终结",
      retryable: false,
      executionStatus: status
    };
  }
  return undefined;
}
