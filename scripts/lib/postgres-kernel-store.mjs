// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { computeEventDigest, computeEventHmac, POSTGRES_SCHEMA_SQL } from "@mn/storage";

const ENTERPRISE_SCHEMA_SQL = `
${POSTGRES_SCHEMA_SQL}

create table if not exists mn_v2.runtime_locks (
  singleton boolean primary key default true check (singleton),
  engine_digest text not null,
  plugin_digest text not null,
  updated_at timestamptz not null
);

create table if not exists mn_v2.reconciliations (
  execution_id text primary key,
  job_id text not null,
  fencing_token bigint not null,
  status text not null check (status in ('needs_reconciliation', 'terminated', 'completed', 'replaced')),
  occurred_at timestamptz not null,
  resolved_at timestamptz
);
`;

function safeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} 超出安全整数范围`);
  return parsed;
}

function json(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function projectionKey(namespace, id) {
  return JSON.stringify([namespace, id]);
}

function idempotencyKey(scope, key) {
  return JSON.stringify([scope, key]);
}

function idempotencyStorageKey(scope, key) {
  return `kernel:${Buffer.from(idempotencyKey(scope, key)).toString("base64url")}`;
}

function parseIdempotencyStorageKey(value) {
  if (!value.startsWith("kernel:")) throw new Error("幂等键不属于 Kernel namespace");
  return splitPair(Buffer.from(value.slice("kernel:".length), "base64url").toString("utf8"), "幂等");
}

function splitPair(value, label) {
  const pair = JSON.parse(value);
  if (!Array.isArray(pair) || pair.length !== 2 || pair.some((item) => typeof item !== "string")) {
    throw new Error(`${label} 键格式无效`);
  }
  return pair;
}

function rowToEvent(row) {
  return {
    schemaVersion: 1,
    id: String(row.event_id),
    tenantId: String(row.tenant_id),
    position: safeInteger(row.position, "事件位置"),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    streamVersion: safeInteger(row.stream_version, "事件流版本"),
    type: String(row.event_type),
    occurredAt: iso(row.occurred_at),
    actorId: String(row.actor_id),
    ...(row.execution_id == null ? {} : { executionId: String(row.execution_id) }),
    generation: safeInteger(row.generation, "generation"),
    ...(row.causation_id == null ? {} : { causationId: String(row.causation_id) }),
    correlationId: String(row.correlation_id),
    publicPayload: json(row.public_payload),
    ...(row.protected_payload_ref == null ? {} : { protectedPayloadRef: String(row.protected_payload_ref) }),
    ...(row.previous_digest == null ? {} : { previousDigest: String(row.previous_digest) }),
    digest: String(row.digest),
    hmac: String(row.hmac),
  };
}

export class PostgresKernelStore {
  #pool;
  #hmacKey;
  #now;

  constructor({ pool, hmacKey, now = () => new Date().toISOString() }) {
    if (!pool?.connect || !pool?.query) throw new TypeError("PostgreSQL pool 无效");
    if (!(hmacKey instanceof Uint8Array) || hmacKey.byteLength < 32) {
      throw new TypeError("事件 HMAC 密钥至少需要 32 字节");
    }
    this.#pool = pool;
    this.#hmacKey = Buffer.from(hmacKey);
    this.#now = now;
  }

  async initialize() {
    await this.#pool.query(ENTERPRISE_SCHEMA_SQL);
  }

  async setRuntimeLocks(engineDigest, pluginDigest) {
    await this.#pool.query(`
      insert into mn_v2.runtime_locks (singleton, engine_digest, plugin_digest, updated_at)
      values (true, $1, $2, now())
      on conflict (singleton) do nothing
    `, [engineDigest, pluginDigest]);
  }

  async runtimeLocks() {
    const result = await this.#pool.query(
      "select engine_digest, plugin_digest from mn_v2.runtime_locks where singleton = true",
    );
    const row = result.rows[0];
    return row ? {
      engineLockDigest: String(row.engine_digest),
      pluginLockDigest: String(row.plugin_digest),
    } : undefined;
  }

  async listTenantIds() {
    const result = await this.#pool.query(
      "select tenant_id from mn_v2.tenant_heads order by tenant_id asc",
    );
    return result.rows.map((row) => String(row.tenant_id));
  }

  async transact(tenantId, work) {
    if (typeof tenantId !== "string" || !tenantId.trim()) throw new TypeError("tenantId 不能为空");
    const client = await this.#pool.connect();
    try {
      await client.query("begin isolation level serializable");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [tenantId]);
      await client.query(`
        insert into mn_v2.tenant_heads (tenant_id, next_position, previous_digest, retention_floor)
        values ($1, 1, null, 1) on conflict (tenant_id) do nothing
      `, [tenantId]);
      const headResult = await client.query(`
        select next_position, previous_digest from mn_v2.tenant_heads
        where tenant_id = $1 for update
      `, [tenantId]);
      const streamResult = await client.query(`
        select aggregate_type, aggregate_id, stream_version from mn_v2.stream_heads
        where tenant_id = $1
      `, [tenantId]);
      const projectionResult = await client.query(`
        select namespace, projection_key, value_json from mn_v2.projections
        where tenant_id = $1
      `, [tenantId]);
      const idempotencyResult = await client.query(`
        select idempotency_key, request_hash, response_json, created_at from mn_v2.idempotency
        where tenant_id = $1 and idempotency_key like 'kernel:%'
      `, [tenantId]);

      const head = headResult.rows[0];
      let nextPosition = safeInteger(head?.next_position ?? 1, "事件位置");
      let previousDigest = head?.previous_digest == null ? undefined : String(head.previous_digest);
      const streams = new Map(streamResult.rows.map((row) => [
        `${row.aggregate_type}\0${row.aggregate_id}`,
        safeInteger(row.stream_version, "事件流版本"),
      ]));
      const projections = new Map(projectionResult.rows.map((row) => [
        projectionKey(String(row.namespace), String(row.projection_key)),
        json(row.value_json),
      ]));
      const idempotency = new Map(idempotencyResult.rows.map((row) => {
        const [scope, key] = parseIdempotencyStorageKey(String(row.idempotency_key));
        return [idempotencyKey(scope, key), {
          tenantId,
          scope,
          key,
          requestDigest: String(row.request_hash),
          response: json(row.response_json),
          createdAt: iso(row.created_at),
        }];
      }));
      const changedProjections = new Map();
      const deletedProjections = new Set();
      const changedIdempotency = new Map();
      const events = [];
      const jobs = [];
      const outbox = [];

      const transaction = {
        appendEvent: (request) => {
          if (request.tenantId !== tenantId) throw new Error("事务不能跨租户写入");
          const streamKey = `${request.aggregateType}\0${request.aggregateId}`;
          const actual = streams.get(streamKey) ?? 0;
          if (actual !== request.expectedStreamVersion) {
            const error = new Error(`对象版本冲突：预期 ${request.expectedStreamVersion}，实际 ${actual}`);
            error.code = "STREAM_VERSION_CONFLICT";
            error.expected = request.expectedStreamVersion;
            error.actual = actual;
            throw error;
          }
          const body = {
            schemaVersion: 1,
            id: randomUUID(),
            tenantId,
            position: nextPosition++,
            aggregateType: request.aggregateType,
            aggregateId: request.aggregateId,
            streamVersion: actual + 1,
            type: request.type,
            occurredAt: this.#now(),
            actorId: request.actorId,
            ...(request.executionId ? { executionId: request.executionId } : {}),
            generation: request.generation,
            ...(request.causationId ? { causationId: request.causationId } : {}),
            correlationId: request.correlationId,
            publicPayload: request.publicPayload,
            ...(request.protectedPayloadRef ? { protectedPayloadRef: request.protectedPayloadRef } : {}),
            ...(previousDigest ? { previousDigest } : {}),
          };
          const eventDigest = computeEventDigest(body);
          const event = { ...body, digest: eventDigest, hmac: computeEventHmac(eventDigest, this.#hmacKey) };
          previousDigest = eventDigest;
          streams.set(streamKey, actual + 1);
          events.push(event);
          return event;
        },
        getProjection: (namespace, id) => projections.get(projectionKey(namespace, id)),
        listProjections: (namespace) => {
          const values = [];
          for (const [key, value] of projections) {
            if (splitPair(key, "投影")[0] === namespace) values.push(value);
          }
          return values;
        },
        putProjection: (namespace, id, value) => {
          const key = projectionKey(namespace, id);
          projections.set(key, value);
          changedProjections.set(key, value);
          deletedProjections.delete(key);
        },
        deleteProjection: (namespace, id) => {
          const key = projectionKey(namespace, id);
          projections.delete(key);
          changedProjections.delete(key);
          deletedProjections.add(key);
        },
        getIdempotency: (scope, key) => idempotency.get(idempotencyKey(scope, key)),
        putIdempotency: (record) => {
          if (record.tenantId !== tenantId) throw new Error("事务不能跨租户写入幂等记录");
          const mapKey = idempotencyKey(record.scope, record.key);
          idempotency.set(mapKey, record);
          changedIdempotency.set(mapKey, record);
        },
        putJob: (job) => {
          if (job.tenantId !== tenantId) throw new Error("事务不能跨租户写入 Job");
          if (!job.id?.trim() || !job.kind?.trim() || !job.idempotencyKey?.trim()) {
            throw new Error("Job 的 id、kind 和 idempotencyKey 不能为空");
          }
          jobs.push(job);
        },
        putOutbox: (message) => {
          if (message.tenantId !== tenantId) throw new Error("事务不能跨租户写入 outbox");
          if (!message.id?.trim() || !message.topic?.trim()) {
            throw new Error("outbox 的 id 和 topic 不能为空");
          }
          outbox.push(message);
        },
      };

      const result = await work(transaction);

      for (const key of deletedProjections) {
        const [namespace, id] = splitPair(key, "投影");
        await client.query(`
          delete from mn_v2.projections
          where tenant_id = $1 and namespace = $2 and projection_key = $3
        `, [tenantId, namespace, id]);
      }
      for (const [key, value] of changedProjections) {
        const [namespace, id] = splitPair(key, "投影");
        const version = Number.isSafeInteger(value?.streamVersion) ? value.streamVersion : 0;
        await client.query(`
          insert into mn_v2.projections (
            tenant_id, namespace, projection_key, stream_version, value_json, updated_at
          ) values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
          on conflict (tenant_id, namespace, projection_key) do update set
            stream_version = excluded.stream_version,
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `, [tenantId, namespace, id, version, JSON.stringify(value), this.#now()]);
      }
      for (const event of events) {
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
          event.tenantId, event.position, event.id, event.aggregateType, event.aggregateId,
          event.streamVersion, event.type, event.occurredAt, event.actorId,
          event.executionId ?? null, event.generation, event.causationId ?? null,
          event.correlationId, JSON.stringify(event.publicPayload),
          event.protectedPayloadRef ?? null, event.previousDigest ?? null, event.digest, event.hmac,
        ]);
      }
      for (const [streamKey, streamVersion] of streams) {
        const [aggregateType, aggregateId] = streamKey.split("\0");
        await client.query(`
          insert into mn_v2.stream_heads (tenant_id, aggregate_type, aggregate_id, stream_version)
          values ($1, $2, $3, $4)
          on conflict (tenant_id, aggregate_type, aggregate_id) do update set
            stream_version = excluded.stream_version
        `, [tenantId, aggregateType, aggregateId, streamVersion]);
      }
      await client.query(`
        update mn_v2.tenant_heads set next_position = $2, previous_digest = $3
        where tenant_id = $1
      `, [tenantId, nextPosition, previousDigest ?? null]);
      for (const job of jobs) {
        const createdAt = this.#now();
        await client.query(`
          insert into mn_v2.jobs (
            job_id, tenant_id, workspace_id, kind, payload_json, status, attempts,
            available_at, fencing_token, idempotency_key, created_at, updated_at
          ) values (
            $1, $2, $3, $4, $5::jsonb, 'available', 0,
            $6::timestamptz, 0, $7, $8::timestamptz, $8::timestamptz
          )
        `, [
          job.id, tenantId, job.workspaceId ?? null, job.kind, JSON.stringify(job.payload),
          job.availableAt, job.idempotencyKey, createdAt,
        ]);
      }
      for (const message of outbox) {
        const createdAt = this.#now();
        await client.query(`
          insert into mn_v2.outbox (
            message_id, tenant_id, topic, payload_json, available_at, created_at
          ) values ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
        `, [
          message.id, tenantId, message.topic, JSON.stringify(message.payload),
          message.availableAt ?? createdAt, createdAt,
        ]);
      }
      for (const [, record] of changedIdempotency) {
        await client.query(`
          insert into mn_v2.idempotency (
            tenant_id, idempotency_key, request_hash, response_json, created_at
          ) values ($1, $2, $3, $4::jsonb, $5::timestamptz)
          on conflict (tenant_id, idempotency_key) do nothing
        `, [
          tenantId,
          idempotencyStorageKey(record.scope, record.key),
          record.requestDigest,
          JSON.stringify(record.response),
          record.createdAt,
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

  async readEvents(tenantId, afterPosition, limit) {
    if (!Number.isSafeInteger(afterPosition) || afterPosition < 0) throw new RangeError("事件游标无效");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("事件页大小无效");
    const head = await this.#pool.query(`
      select retention_floor from mn_v2.tenant_heads where tenant_id = $1
    `, [tenantId]);
    const retentionFloor = safeInteger(head.rows[0]?.retention_floor ?? 1, "保留期游标");
    if (afterPosition < retentionFloor - 1) {
      const error = new Error(`事件游标早于保留位置 ${retentionFloor}`);
      error.code = "EVENT_CURSOR_EXPIRED";
      error.retentionFloor = retentionFloor;
      throw error;
    }
    const page = await this.#pool.query(`
      select * from mn_v2.events where tenant_id = $1 and position > $2
      order by position asc limit $3
    `, [tenantId, afterPosition, limit]);
    const events = page.rows.map(rowToEvent);
    return {
      events,
      nextPosition: events.at(-1)?.position ?? afterPosition,
      retentionFloor,
    };
  }

  async close() {
    await this.#pool.end?.();
  }
}

export async function probePostgres(pool) {
  try {
    const result = await pool.query("select current_schema() as schema, 1 as ok");
    return Number(result.rows[0]?.ok) === 1;
  } catch {
    return false;
  }
}
