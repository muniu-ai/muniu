#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { hmacSha256, sha256 } from "@mn/kernel";
import { AgentOsWorker, WORKER_LEASE_MILLISECONDS } from "@mn/worker";
import { PostgresStorage, StaleFencingTokenError } from "@mn/storage";
import pg from "pg";

const { Pool } = pg;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function lockDigest(name) {
  const value = required(name);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} 必须是 64 位小写 SHA-256`);
  return value;
}

function hmacKey() {
  const value = Buffer.from(required("MN_EVENT_HMAC_KEY"), "base64");
  if (value.byteLength < 32) throw new Error("MN_EVENT_HMAC_KEY 解码后至少需要 32 字节");
  return value;
}

if ((process.env.MN_POSTGRES_SCHEMA ?? "mn_v2") !== "mn_v2") {
  throw new Error("0.2 企业 Worker 只允许 PostgreSQL schema mn_v2");
}
if (Number(process.env.MN_JOB_LEASE_MS ?? "30000") !== WORKER_LEASE_MILLISECONDS) {
  throw new Error("Worker 租约固定为 30000 毫秒");
}
if ((process.env.MN_TELEMETRY_ENABLED ?? "false") !== "false") {
  throw new Error("0.2 默认禁止遥测；请将 MN_TELEMETRY_ENABLED 设为 false");
}

const workerId = required("MN_WORKER_INSTANCE_ID");
const pool = new Pool({
  connectionString: required("MN_POSTGRES_URL"),
  application_name: workerId,
  max: Number(process.env.MN_POSTGRES_POOL_SIZE ?? "4"),
});
const eventHmacKey = hmacKey();
const storage = new PostgresStorage({ pool, hmacKey: eventHmacKey });
await storage.initialize();

const reconciliationFailure = {
  code: "UNKNOWN_EXTERNAL_SIDE_EFFECT",
  message: "外部操作可能已经发生。请人工核对后选择终止、标记已完成或创建新调用",
  retryable: false,
};

const store = {
  claimJob: storage.claimJob.bind(storage),
  completeJob: storage.completeJob.bind(storage),
  async failJob(jobId, workerId, fencingToken, failure, now) {
    try {
      await storage.failJob(jobId, workerId, fencingToken, failure, now);
    } catch (error) {
      if (!(error instanceof StaleFencingTokenError) || failure?.code !== reconciliationFailure.code) throw error;
      const result = await pool.query(`
        select 1 from mn_v2.jobs
        where job_id = $1 and status = 'failed' and fencing_token = $2
          and failure_json->>'code' = 'UNKNOWN_EXTERNAL_SIDE_EFFECT'
      `, [jobId, fencingToken]);
      if (result.rowCount !== 1) throw error;
    }
  },
  async renewJobLease(jobId, workerId, fencingToken, now) {
    const result = await pool.query(`
      update mn_v2.jobs set
        lease_expires_at = $1::timestamptz + interval '30 seconds',
        updated_at = $1::timestamptz
      where job_id = $2 and status = 'leased' and lease_owner = $3
        and fencing_token = $4 and lease_expires_at > $1::timestamptz
    `, [now, jobId, workerId, fencingToken]);
    if (result.rowCount !== 1) throw new StaleFencingTokenError(jobId);
  },
  async markNeedsReconciliation(executionId, input) {
    const claimingWorker = input.workerId ?? workerId;
    if (claimingWorker !== workerId) throw new StaleFencingTokenError(input.jobId);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const owned = await client.query(`
        select tenant_id, workspace_id, payload_json from mn_v2.jobs
        where job_id = $1 and status = 'leased' and lease_owner = $2
          and fencing_token = $3 and lease_expires_at > $4::timestamptz
        for update
      `, [input.jobId, claimingWorker, input.fencingToken, input.occurredAt]);
      if (owned.rowCount !== 1) {
        await client.query("rollback");
        return;
      }
      const tenantId = String(owned.rows[0].tenant_id);
      const jobPayload = typeof owned.rows[0].payload_json === "string"
        ? JSON.parse(owned.rows[0].payload_json) : owned.rows[0].payload_json;
      if (jobPayload?.executionId !== executionId) {
        throw new Error("Job 与待核对的 Execution 不一致");
      }
      let workspaceId = owned.rows[0].workspace_id == null ? undefined : String(owned.rows[0].workspace_id);
      await client.query(`
        insert into mn_v2.tenant_heads (tenant_id, next_position, previous_digest, retention_floor)
        values ($1, 1, null, 1) on conflict (tenant_id) do nothing
      `, [tenantId]);
      const head = (await client.query(`
        select next_position, previous_digest from mn_v2.tenant_heads
        where tenant_id = $1 for update
      `, [tenantId])).rows[0];
      await client.query(`
        insert into mn_v2.stream_heads (tenant_id, aggregate_type, aggregate_id, stream_version)
        values ($1, 'execution', $2, 0) on conflict do nothing
      `, [tenantId, executionId]);
      const stream = (await client.query(`
        select stream_version from mn_v2.stream_heads
        where tenant_id = $1 and aggregate_type = 'execution' and aggregate_id = $2
        for update
      `, [tenantId, executionId])).rows[0];
      const projection = (await client.query(`
        select value_json from mn_v2.projections
        where tenant_id = $1 and namespace = 'execution' and projection_key = $2
        for update
      `, [tenantId, executionId])).rows[0];
      const currentProjection = typeof projection?.value_json === "string"
        ? JSON.parse(projection.value_json) : projection?.value_json;
      if (!workspaceId && typeof currentProjection?.workspaceId === "string") {
        workspaceId = currentProjection.workspaceId;
      }
      const position = Number(head.next_position);
      const streamVersion = Number(stream.stream_version) + 1;
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(streamVersion)) {
        throw new Error("事件位置或 execution streamVersion 超出安全整数范围");
      }
      const unsignedEvent = {
        schemaVersion: 1,
        id: randomUUID(),
        tenantId,
        position,
        aggregateType: "execution",
        aggregateId: executionId,
        streamVersion,
        type: "execution.needs_reconciliation",
        occurredAt: input.occurredAt,
        actorId: `worker:${claimingWorker}`,
        executionId,
        generation: Number.isSafeInteger(currentProjection?.generation) ? currentProjection.generation : 0,
        correlationId: randomUUID(),
        publicPayload: {
          ...(workspaceId ? { workspaceId } : {}),
          jobId: input.jobId,
          status: "needs_reconciliation",
          reason: reconciliationFailure.code,
        },
        ...(head.previous_digest == null ? {} : { previousDigest: String(head.previous_digest) }),
      };
      const eventDigest = sha256(unsignedEvent);
      const event = { ...unsignedEvent, digest: eventDigest, hmac: hmacSha256(eventHmacKey, eventDigest) };
      await client.query(`
        insert into mn_v2.events (
          tenant_id, position, event_id, aggregate_type, aggregate_id, stream_version,
          event_type, occurred_at, actor_id, execution_id, generation, causation_id,
          correlation_id, public_payload, protected_payload_ref, previous_digest, digest, hmac
        ) values (
          $1, $2, $3::uuid, 'execution', $4, $5, $6, $7::timestamptz, $8, $4, $9, null,
          $10, $11::jsonb, null, $12, $13, $14
        )
      `, [
        tenantId, event.position, event.id, executionId, event.streamVersion, event.type,
        event.occurredAt, event.actorId, event.generation, event.correlationId,
        JSON.stringify(event.publicPayload), event.previousDigest ?? null, event.digest, event.hmac,
      ]);
      await client.query(`
        update mn_v2.stream_heads set stream_version = $3
        where tenant_id = $1 and aggregate_type = 'execution' and aggregate_id = $2
      `, [tenantId, executionId, streamVersion]);
      await client.query(`
        update mn_v2.tenant_heads set next_position = $2, previous_digest = $3
        where tenant_id = $1
      `, [tenantId, position + 1, event.digest]);
      const reconciliation = await client.query(`
        insert into mn_v2.reconciliations (
          execution_id, job_id, fencing_token, status, occurred_at
        ) values ($1, $2, $3, 'needs_reconciliation', $4::timestamptz)
        on conflict (execution_id) do update set execution_id = excluded.execution_id
        where mn_v2.reconciliations.job_id = excluded.job_id
          and mn_v2.reconciliations.fencing_token = excluded.fencing_token
        returning execution_id
      `, [executionId, input.jobId, input.fencingToken, input.occurredAt]);
      if (reconciliation.rowCount !== 1) throw new Error("execution 已由其他 Job 标记为需要人工核对");
      const failed = await client.query(`
        update mn_v2.jobs set
          status = 'failed', failure_json = $1::jsonb,
          lease_owner = null, lease_expires_at = null, updated_at = $2::timestamptz
        where job_id = $3 and status = 'leased' and lease_owner = $4
          and fencing_token = $5 and lease_expires_at > $2::timestamptz
      `, [
        JSON.stringify(reconciliationFailure), input.occurredAt, input.jobId,
        claimingWorker, input.fencingToken,
      ]);
      if (failed.rowCount !== 1) throw new StaleFencingTokenError(input.jobId);
      await client.query(`
        update mn_v2.projections set
          stream_version = $4,
          updated_at = $3::timestamptz,
          value_json = jsonb_set(
            jsonb_set(
              jsonb_set(value_json, '{status}', '"needs_reconciliation"'::jsonb),
              '{failureCode}', '"UNKNOWN_EXTERNAL_SIDE_EFFECT"'::jsonb
            ),
            '{streamVersion}', to_jsonb($4::integer)
          )
        where tenant_id = (select tenant_id from mn_v2.jobs where job_id = $1)
          and namespace = 'execution' and projection_key = $2
      `, [input.jobId, executionId, input.occurredAt, streamVersion]);
      if (workspaceId) {
        const inboxId = `reconciliation:${executionId}:${input.jobId}`;
        const inbox = {
          id: inboxId,
          tenantId,
          workspaceId,
          executionId,
          kind: "reconciliation",
          title: "外部操作结果需要人工核对",
          summary: reconciliationFailure.message,
          risk: "unknown",
          resourceSummary: input.jobId,
          createdAt: input.occurredAt,
          status: "open",
        };
        await client.query(`
          insert into mn_v2.projections (
            tenant_id, namespace, projection_key, stream_version, value_json, updated_at
          ) values ($1, 'inbox', $2, 0, $3::jsonb, $4::timestamptz)
          on conflict (tenant_id, namespace, projection_key) do update set
            value_json = excluded.value_json, updated_at = excluded.updated_at
        `, [tenantId, inboxId, JSON.stringify(inbox), input.occurredAt]);
      }
      await client.query(`
        insert into mn_v2.outbox (
          message_id, tenant_id, topic, payload_json, available_at, created_at
        ) values ($1, $2, 'execution.reconciliation_required', $3::jsonb, $4::timestamptz, $4::timestamptz)
        on conflict (message_id) do nothing
      `, [
        `reconciliation:${executionId}:${input.jobId}`, tenantId,
        JSON.stringify({ executionId, jobId: input.jobId, workspaceId }), input.occurredAt,
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },
};

const localEngineLock = lockDigest("MN_ENGINE_LOCK_DIGEST");
const localPluginLock = lockDigest("MN_PLUGIN_LOCK_DIGEST");
const databaseLockResult = await pool.query(
  "select engine_digest, plugin_digest from mn_v2.runtime_locks where singleton = true",
);
const databaseLocks = databaseLockResult.rows[0];
if (!databaseLocks) throw new Error("数据库 runtime lock 缺失，Worker 拒绝 claim");
const expectedEngineLock = lockDigest("MN_EXPECTED_ENGINE_LOCK_DIGEST");
const expectedPluginLock = lockDigest("MN_EXPECTED_PLUGIN_LOCK_DIGEST");
const lock = {
  engineLockDigest: localEngineLock,
  expectedEngineLockDigest: databaseLocks ? String(databaseLocks.engine_digest) : expectedEngineLock,
  pluginLockDigest: localPluginLock,
  expectedPluginLockDigest: databaseLocks ? String(databaseLocks.plugin_digest) : expectedPluginLock,
};
if (lock.expectedEngineLockDigest !== expectedEngineLock || lock.expectedPluginLockDigest !== expectedPluginLock) {
  throw new Error("数据库 lock 与部署声明不一致，Worker 拒绝 claim");
}

const handlerModule = process.env.MN_WORKER_HANDLER_MODULE
  ?? new URL("./enterprise-worker-handlers.mjs", import.meta.url).pathname;
if (!handlerModule.startsWith("/")) throw new Error("MN_WORKER_HANDLER_MODULE 必须是绝对路径");
const loaded = await import(pathToFileURL(handlerModule).href);
const handlers = typeof loaded.createHandlers === "function"
  ? await loaded.createHandlers(Object.freeze({ pool, storage, workerId }))
  : loaded.handlers;
if (!handlers || typeof handlers !== "object") {
  throw new Error("Worker bootstrap 模块必须导出 handlers 对象或 createHandlers(context)");
}
if (process.env.MN_WORKER_FIXTURE_MODE !== "true"
  && typeof handlers["agent.execution.run"] !== "function") {
  throw new Error(
    "AGENT_EXECUTION_BOOTSTRAP_MISSING：企业 Worker 未配置 agent.execution.run 的 LLM、Scope 与审批组合",
  );
}

const worker = new AgentOsWorker({ id: workerId, store, lock, handlers });
const readiness = worker.readiness();
if (!readiness.ready) throw new Error(readiness.issues.map((issue) => issue.message).join("；"));

const readyFile = process.env.MN_WORKER_READY_FILE ?? "/tmp/mn-worker-ready";
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { stopped = true; });
}

process.stdout.write(`mn-worker ${workerId} 已就绪，lease=30000ms\n`);
const touchReadiness = () => writeFile(readyFile, new Date().toISOString(), { mode: 0o600 })
  .catch((error) => process.stderr.write(`Worker readiness 写入失败：${error.message}\n`));
await touchReadiness();
const readinessTimer = setInterval(() => { void touchReadiness(); }, 1_000);
readinessTimer.unref();
while (!stopped) {
  try {
    const result = await worker.pollOnce();
    if (result.status !== "idle") process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Worker 轮询失败"}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

clearInterval(readinessTimer);
await unlink(readyFile).catch(() => undefined);
await storage.close();
