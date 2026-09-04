// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  computeEventDigest,
  computeEventHmac,
  JOB_LEASE_MILLISECONDS,
  StaleFencingTokenError,
} from "@mn/storage";

const AGENT_JOB_KIND = "agent.execution.run";
const RECONCILIATION_FAILURE = Object.freeze({
  code: "UNKNOWN_EXTERNAL_SIDE_EFFECT",
  message: "外部操作可能已经发生。请人工核对后选择终止、标记已完成或创建新调用",
  retryable: false,
});

function json(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function safeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${label} 无效`);
  return parsed;
}

function iso(value) {
  const timestamp = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("时间戳无效");
  return timestamp.toISOString();
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} 无效`);
  return value;
}

function terminalExecutionClaimFailure(status) {
  if (status === "cancelled") {
    return {
      code: "EXECUTION_CANCELLED",
      message: "Execution 已在领取 Job 前取消",
      retryable: false,
    };
  }
  if (status === "completed" || status === "failed") {
    return {
      code: "EXECUTION_ALREADY_TERMINAL",
      message: "Execution 已在领取 Job 前终结",
      retryable: false,
      executionStatus: status,
    };
  }
  return undefined;
}

function rowToJob(row) {
  return {
    id: String(row.job_id),
    tenantId: String(row.tenant_id),
    ...(row.workspace_id == null ? {} : { workspaceId: String(row.workspace_id) }),
    kind: String(row.kind),
    payload: json(row.payload_json),
    status: String(row.status),
    attempts: safeInteger(row.attempts, "Job attempts"),
    availableAt: iso(row.available_at),
    ...(row.lease_owner == null ? {} : { leaseOwner: String(row.lease_owner) }),
    ...(row.lease_expires_at == null ? {} : { leaseExpiresAt: iso(row.lease_expires_at) }),
    fencingToken: safeInteger(row.fencing_token, "Job fencing token"),
    idempotencyKey: String(row.idempotency_key),
    ...(row.result_json == null ? {} : { result: json(row.result_json) }),
    ...(row.failure_json == null ? {} : { failure: json(row.failure_json) }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function executionIdFromPayload(row, required = false) {
  const executionId = json(row.payload_json)?.executionId;
  if (executionId == null && !required) return undefined;
  return requiredString(executionId, "Job payload.executionId");
}

async function lockTenantHead(client, tenantId) {
  await client.query(`
    insert into mn_v2.tenant_heads (tenant_id, next_position, previous_digest, retention_floor)
    values ($1, 1, null, 1) on conflict (tenant_id) do nothing
  `, [tenantId]);
  const row = (await client.query(`
    select next_position, previous_digest from mn_v2.tenant_heads
    where tenant_id = $1 for update
  `, [tenantId])).rows[0];
  if (!row) throw new Error(`Tenant ${tenantId} 的事件头不存在`);
  return {
    tenantId,
    nextPosition: safeInteger(row.next_position, "tenant event position"),
    previousDigest: row.previous_digest == null ? undefined : String(row.previous_digest),
  };
}

async function loadOptionalProjection(client, tenantId, namespace, key, label) {
  const row = (await client.query(`
    select stream_version, value_json from mn_v2.projections
    where tenant_id = $1 and namespace = $2 and projection_key = $3
    for update
  `, [tenantId, namespace, key])).rows[0];
  if (!row) return undefined;
  const value = json(row.value_json);
  const streamVersion = safeInteger(row.stream_version, `${label} projection streamVersion`);
  if (safeInteger(value.streamVersion, `${label} streamVersion`) !== streamVersion) {
    throw new Error(`${label} ${key} 的投影版本不一致`);
  }
  return { value, streamVersion };
}

async function loadProjection(client, tenantId, namespace, key, label) {
  const projection = await loadOptionalProjection(client, tenantId, namespace, key, label);
  if (!projection) throw new Error(`${label} ${key} 的投影不存在`);
  return projection;
}

async function loadGenericJobContext(client, row) {
  if (String(row.kind) === AGENT_JOB_KIND) return undefined;
  const tenantId = String(row.tenant_id);
  const jobId = String(row.job_id);
  const head = await lockTenantHead(client, tenantId);
  const projection = await loadOptionalProjection(client, tenantId, "job", jobId, "Job");
  if (!projection) return undefined;
  const job = projection.value;
  if (job.tenantId !== tenantId
    || job.kind !== String(row.kind)
    || requiredString(job.id, "Job id") !== jobId) {
    throw new Error("Job 物理记录与查询投影不一致");
  }
  const physicalWorkspaceId = row.workspace_id == null ? undefined : String(row.workspace_id);
  const projectedWorkspaceId = typeof job.workspaceId === "string" ? job.workspaceId : undefined;
  if (projectedWorkspaceId !== physicalWorkspaceId) {
    throw new Error("Job 工作区与查询投影不一致");
  }
  const payload = json(row.payload_json);
  const executionId = typeof payload.executionId === "string"
    ? payload.executionId
    : typeof payload.reconciliationExecutionId === "string"
      ? payload.reconciliationExecutionId
      : undefined;
  const generation = Number.isSafeInteger(payload.generation) && payload.generation >= 1
    ? payload.generation
    : 1;
  return {
    tenantId,
    jobId,
    ...(physicalWorkspaceId ? { workspaceId: physicalWorkspaceId } : {}),
    ...(executionId ? { executionId } : {}),
    generation,
    head,
    job,
    jobStreamVersion: projection.streamVersion,
  };
}

async function loadExecutionContext(client, row, { requireAgentJob = true } = {}) {
  const isAgentJob = String(row.kind) === AGENT_JOB_KIND;
  if (requireAgentJob && !isAgentJob) return undefined;
  const executionId = executionIdFromPayload(row, true);
  const tenantId = String(row.tenant_id);
  const head = await lockTenantHead(client, tenantId);
  const executionProjection = await loadProjection(
    client, tenantId, "execution", executionId, "Execution",
  );
  const execution = executionProjection.value;
  if (execution.tenantId !== tenantId) throw new Error("Job 与 Execution 所属租户不一致");
  const workspaceId = requiredString(execution.workspaceId, "Execution workspaceId");
  const generation = safeInteger(execution.generation, "Execution generation");
  let jobProjection;
  if (isAgentJob) {
    jobProjection = await loadProjection(client, tenantId, "job", String(row.job_id), "Job");
    const projected = jobProjection.value;
    if (projected.tenantId !== tenantId
      || projected.kind !== AGENT_JOB_KIND
      || requiredString(projected.id, "Job id") !== String(row.job_id)) {
      throw new Error("Agent Job 物理记录与查询投影不一致");
    }
  }
  return {
    tenantId,
    executionId,
    workspaceId,
    generation,
    head,
    execution,
    executionStreamVersion: executionProjection.streamVersion,
    ...(jobProjection ? {
      job: jobProjection.value,
      jobStreamVersion: jobProjection.streamVersion,
    } : {}),
  };
}

function assertJobProjectionMatchesPhysical(context, row, mode, workerId, fencingToken) {
  if (!context?.job) return;
  const job = context.job;
  if (job.status !== String(row.status)
    || safeInteger(job.fencingToken, "Job fencingToken") !== safeInteger(row.fencing_token, "Job fencingToken")
    || safeInteger(job.attempts, "Job attempts") !== safeInteger(row.attempts, "Job attempts")) {
    throw new Error("Agent Job 物理状态与查询投影不一致");
  }
  if (row.status === "leased"
    && (job.leaseOwner !== row.lease_owner
      || job.leaseExpiresAt !== iso(row.lease_expires_at))) {
    throw new Error("Agent Job 租约与查询投影不一致");
  }
  if (mode === "owned" && (job.status !== "leased"
    || job.leaseOwner !== workerId
    || safeInteger(job.fencingToken, "Job fencingToken") !== fencingToken)) {
    throw new Error("Agent Job 租约与查询投影不一致");
  }
}

async function appendEvent(client, hmacKey, context, request, occurredAt) {
  const expected = safeInteger(request.expectedStreamVersion, "expected streamVersion");
  await client.query(`
    insert into mn_v2.stream_heads (tenant_id, aggregate_type, aggregate_id, stream_version)
    values ($1, $2, $3, 0) on conflict do nothing
  `, [context.tenantId, request.aggregateType, request.aggregateId]);
  const row = (await client.query(`
    select stream_version from mn_v2.stream_heads
    where tenant_id = $1 and aggregate_type = $2 and aggregate_id = $3
    for update
  `, [context.tenantId, request.aggregateType, request.aggregateId])).rows[0];
  const actual = safeInteger(row?.stream_version ?? 0, "event streamVersion");
  if (actual !== expected) {
    const error = new Error(
      `${request.aggregateType} ${request.aggregateId} 事件流版本冲突：预期 ${expected}，实际 ${actual}`,
    );
    error.code = "STREAM_VERSION_CONFLICT";
    throw error;
  }
  const body = {
    schemaVersion: 1,
    id: randomUUID(),
    tenantId: context.tenantId,
    position: context.head.nextPosition,
    aggregateType: request.aggregateType,
    aggregateId: request.aggregateId,
    streamVersion: expected + 1,
    type: request.type,
    occurredAt,
    actorId: request.actorId,
    ...(context.executionId ? { executionId: context.executionId } : {}),
    generation: context.generation,
    correlationId: request.correlationId,
    publicPayload: request.publicPayload,
    ...(context.head.previousDigest ? { previousDigest: context.head.previousDigest } : {}),
  };
  const digest = computeEventDigest(body);
  const event = { ...body, digest, hmac: computeEventHmac(digest, hmacKey) };
  await client.query(`
    insert into mn_v2.events (
      tenant_id, position, event_id, aggregate_type, aggregate_id, stream_version,
      event_type, occurred_at, actor_id, execution_id, generation, causation_id,
      correlation_id, public_payload, protected_payload_ref, previous_digest, digest, hmac
    ) values (
      $1, $2, $3::uuid, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, null,
      $12, $13::jsonb, null, $14, $15, $16
    )
  `, [
    event.tenantId, event.position, event.id, event.aggregateType, event.aggregateId,
    event.streamVersion, event.type, event.occurredAt, event.actorId, event.executionId ?? null,
    event.generation, event.correlationId, JSON.stringify(event.publicPayload),
    event.previousDigest ?? null, event.digest, event.hmac,
  ]);
  const stream = await client.query(`
    update mn_v2.stream_heads set stream_version = $4
    where tenant_id = $1 and aggregate_type = $2 and aggregate_id = $3
      and stream_version = $5
  `, [context.tenantId, request.aggregateType, request.aggregateId, event.streamVersion, expected]);
  if (stream.rowCount !== 1) throw new Error(`${request.aggregateType} 事件流并发更新失败`);
  await client.query(`
    insert into mn_v2.outbox (
      message_id, tenant_id, topic, payload_json, available_at, created_at
    ) values ($1, $2, $3, $4::jsonb, $5::timestamptz, $5::timestamptz)
  `, [
    `${event.aggregateType}:${event.aggregateId}:${event.streamVersion}:${event.type}`,
    event.tenantId,
    event.type,
    JSON.stringify(event.publicPayload),
    occurredAt,
  ]);
  context.head.nextPosition += 1;
  context.head.previousDigest = digest;
  return event;
}

async function flushTenantHead(client, context) {
  const result = await client.query(`
    update mn_v2.tenant_heads set next_position = $2, previous_digest = $3
    where tenant_id = $1
  `, [context.tenantId, context.head.nextPosition, context.head.previousDigest ?? null]);
  if (result.rowCount !== 1) throw new Error(`Tenant ${context.tenantId} 的事件头并发更新失败`);
}

async function putProjection(client, context, namespace, key, previousVersion, value, occurredAt) {
  const nextVersion = safeInteger(value.streamVersion, `${namespace} streamVersion`);
  const result = await client.query(`
    update mn_v2.projections set stream_version = $4, value_json = $5::jsonb,
      updated_at = $6::timestamptz
    where tenant_id = $1 and namespace = $2 and projection_key = $3
      and stream_version = $7
  `, [context.tenantId, namespace, key, nextVersion, JSON.stringify(value), occurredAt, previousVersion]);
  if (result.rowCount !== 1) throw new Error(`${namespace} ${key} 的投影并发更新失败`);
}

async function settleTerminalJobBeforeClaim(client, hmacKey, context, row, workerId, now) {
  if (!context?.job || !context.execution) return false;
  const executionStatus = String(context.execution.status);
  const failure = terminalExecutionClaimFailure(executionStatus);
  if (!failure) return false;
  assertJobProjectionMatchesPhysical(context, row, "claim", workerId, 0);
  const jobId = String(row.job_id);
  const previousFencingToken = safeInteger(row.fencing_token, "Job fencing token");
  const changed = await client.query(`
    update mn_v2.jobs set status = 'failed', result_json = null,
      failure_json = $1::jsonb, lease_owner = null, lease_expires_at = null,
      updated_at = $2::timestamptz
    where job_id = $3 and status = $4 and fencing_token = $5
  `, [JSON.stringify(failure), now, jobId, String(row.status), previousFencingToken]);
  if (changed.rowCount !== 1) throw new StaleFencingTokenError(jobId);
  const {
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    result: _priorResult,
    failure: _priorFailure,
    ...jobWithoutLease
  } = context.job;
  const nextJob = {
    ...jobWithoutLease,
    status: "failed",
    failure,
    streamVersion: context.jobStreamVersion + 1,
    updatedAt: now,
  };
  await appendEvent(client, hmacKey, context, {
    aggregateType: "job", aggregateId: jobId, expectedStreamVersion: context.jobStreamVersion,
    type: "job.failed", actorId: `worker:${workerId}`,
    correlationId: `job:${jobId}:terminal-before-claim`,
    publicPayload: {
      workspaceId: context.workspaceId, executionId: context.executionId, status: "failed",
      failureCode: failure.code, executionStatus, fencingToken: previousFencingToken,
    },
  }, now);
  await putProjection(client, context, "job", jobId, context.jobStreamVersion, nextJob, now);
  return true;
}

async function recordClaim(client, hmacKey, context, row, workerId, leaseExpiresAt, fencingToken, now) {
  if (!context) return;
  assertJobProjectionMatchesPhysical(context, row, "claim", workerId, fencingToken);
  const jobId = String(row.job_id);
  const correlationId = `job:${jobId}:fence:${fencingToken}`;
  const nextJob = {
    ...context.job,
    status: "leased",
    attempts: safeInteger(row.attempts, "Job attempts") + 1,
    leaseOwner: workerId,
    leaseExpiresAt,
    fencingToken,
    streamVersion: context.jobStreamVersion + 1,
    updatedAt: now,
  };
  await appendEvent(client, hmacKey, context, {
    aggregateType: "job", aggregateId: jobId, expectedStreamVersion: context.jobStreamVersion,
    type: "job.leased", actorId: `worker:${workerId}`, correlationId,
    publicPayload: {
      ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
      ...(context.executionId ? { executionId: context.executionId } : {}),
      ...(!context.execution ? { jobId, kind: String(row.kind) } : {}),
      workerId, fencingToken, leaseExpiresAt,
    },
  }, now);
  await putProjection(client, context, "job", jobId, context.jobStreamVersion, nextJob, now);
  if (!context.execution) return;
  if (context.execution.status === "running" || context.execution.status === "waiting_approval") return;
  if (context.execution.status !== "queued") {
    throw new Error(`状态为 ${String(context.execution.status)} 的 Execution 不能领取 Agent Job`);
  }
  const nextExecution = {
    ...context.execution,
    status: "running",
    startedAt: context.execution.startedAt ?? now,
    streamVersion: context.executionStreamVersion + 1,
    updatedAt: now,
  };
  await appendEvent(client, hmacKey, context, {
    aggregateType: "execution", aggregateId: context.executionId,
    expectedStreamVersion: context.executionStreamVersion, type: "execution.running",
    actorId: `worker:${workerId}`, correlationId,
    publicPayload: {
      workspaceId: context.workspaceId, jobId, status: "running", workerId, fencingToken,
    },
  }, now);
  await putProjection(
    client, context, "execution", context.executionId,
    context.executionStreamVersion, nextExecution, now,
  );
}

async function recordRenewal(client, hmacKey, context, row, workerId, leaseExpiresAt, fencingToken, now) {
  if (!context) return;
  assertJobProjectionMatchesPhysical(context, row, "owned", workerId, fencingToken);
  const jobId = String(row.job_id);
  const nextJob = {
    ...context.job,
    leaseExpiresAt,
    streamVersion: context.jobStreamVersion + 1,
    updatedAt: now,
  };
  await appendEvent(client, hmacKey, context, {
    aggregateType: "job", aggregateId: jobId, expectedStreamVersion: context.jobStreamVersion,
    type: "job.lease_renewed", actorId: `worker:${workerId}`,
    correlationId: `job:${jobId}:fence:${fencingToken}`,
    publicPayload: {
      ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
      ...(context.executionId ? { executionId: context.executionId } : {}),
      ...(!context.execution ? { jobId, kind: String(row.kind) } : {}),
      workerId, fencingToken, leaseExpiresAt,
    },
  }, now);
  await putProjection(client, context, "job", jobId, context.jobStreamVersion, nextJob, now);
}

async function recordTerminal(client, hmacKey, context, row, workerId, fencingToken, status, value, now) {
  if (!context) return;
  assertJobProjectionMatchesPhysical(context, row, "owned", workerId, fencingToken);
  const jobId = String(row.job_id);
  const correlationId = `job:${jobId}:fence:${fencingToken}`;
  const {
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    result: _priorResult,
    failure: _priorFailure,
    ...jobWithoutLease
  } = context.job;
  const nextJob = {
    ...jobWithoutLease,
    status,
    ...(status === "completed" ? { result: value } : { failure: value }),
    streamVersion: context.jobStreamVersion + 1,
    updatedAt: now,
  };
  await appendEvent(client, hmacKey, context, {
    aggregateType: "job", aggregateId: jobId, expectedStreamVersion: context.jobStreamVersion,
    type: `job.${status}`, actorId: `worker:${workerId}`, correlationId,
    publicPayload: {
      ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
      ...(context.executionId ? { executionId: context.executionId } : {}),
      ...(!context.execution ? { jobId, kind: String(row.kind) } : {}),
      status,
      fencingToken,
    },
  }, now);
  await putProjection(client, context, "job", jobId, context.jobStreamVersion, nextJob, now);
  if (!context.execution) return;
  const failureCode = status === "failed"
    ? requiredString(value?.code ?? "WORKER_FAILED", "failure code")
    : undefined;
  const executionStatus = String(context.execution.status);
  if (status === "failed" && (executionStatus === "failed"
    || executionStatus === "completed"
    || (executionStatus === "cancelled" && failureCode === "EXECUTION_CANCELLED"))) {
    return;
  }
  const accepted = status === "completed" ? ["running"] : ["running", "waiting_approval"];
  if (!accepted.includes(context.execution.status)) {
    throw new Error(`状态为 ${String(context.execution.status)} 的 Execution 不能标记为 ${status}`);
  }
  const nextExecution = {
    ...context.execution,
    status,
    ...(failureCode ? { failureCode } : {}),
    finishedAt: now,
    streamVersion: context.executionStreamVersion + 1,
    updatedAt: now,
  };
  await appendEvent(client, hmacKey, context, {
    aggregateType: "execution", aggregateId: context.executionId,
    expectedStreamVersion: context.executionStreamVersion, type: `execution.${status}`,
    actorId: `worker:${workerId}`, correlationId,
    publicPayload: {
      workspaceId: context.workspaceId, jobId, status, ...(failureCode ? { failureCode } : {}),
    },
  }, now);
  await putProjection(
    client, context, "execution", context.executionId,
    context.executionStreamVersion, nextExecution, now,
  );
}

async function recordInterrupted(client, hmacKey, context, row, workerId, fencingToken, failure, now) {
  if (!context?.job || !context.execution) return;
  assertJobProjectionMatchesPhysical(context, row, "owned", workerId, fencingToken);
  const jobId = String(row.job_id);
  const correlationId = `job:${jobId}:fence:${fencingToken}`;
  const {
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    result: _priorResult,
    failure: _priorFailure,
    ...jobWithoutLease
  } = context.job;
  const nextJob = {
    ...jobWithoutLease,
    status: "failed",
    failure,
    streamVersion: context.jobStreamVersion + 1,
    updatedAt: now,
  };
  await appendEvent(client, hmacKey, context, {
    aggregateType: "job", aggregateId: jobId, expectedStreamVersion: context.jobStreamVersion,
    type: "job.failed", actorId: `worker:${workerId}`, correlationId,
    publicPayload: {
      workspaceId: context.workspaceId,
      executionId: context.executionId,
      status: "failed",
      failureCode: "EXECUTION_INTERRUPTED",
      fencingToken,
    },
  }, now);
  await putProjection(client, context, "job", jobId, context.jobStreamVersion, nextJob, now);
  if (context.execution.status !== "running" && context.execution.status !== "waiting_approval") {
    throw new Error(`状态为 ${String(context.execution.status)} 的 Execution 不能中断`);
  }
  const {
    finishedAt: _finishedAt,
    failureCode: _failureCode,
    ...executionWithoutTerminalState
  } = context.execution;
  const nextExecution = {
    ...executionWithoutTerminalState,
    status: "interrupted",
    streamVersion: context.executionStreamVersion + 1,
    updatedAt: now,
  };
  await appendEvent(client, hmacKey, context, {
    aggregateType: "execution", aggregateId: context.executionId,
    expectedStreamVersion: context.executionStreamVersion, type: "execution.interrupted",
    actorId: `worker:${workerId}`, correlationId,
    publicPayload: {
      workspaceId: context.workspaceId,
      jobId,
      status: "interrupted",
      reason: failure.message,
      fencingToken,
    },
  }, now);
  await putProjection(
    client, context, "execution", context.executionId,
    context.executionStreamVersion, nextExecution, now,
  );
}

async function recordJobReconciliation(client, hmacKey, context, row, workerId, fencingToken, failure, now) {
  if (!context.job) return;
  assertJobProjectionMatchesPhysical(context, row, "owned", workerId, fencingToken);
  const jobId = String(row.job_id);
  const {
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    result: _priorResult,
    failure: _priorFailure,
    ...jobWithoutLease
  } = context.job;
  const nextJob = {
    ...jobWithoutLease,
    status: "failed",
    failure,
    streamVersion: context.jobStreamVersion + 1,
    updatedAt: now,
  };
  await appendEvent(client, hmacKey, context, {
    aggregateType: "job", aggregateId: jobId, expectedStreamVersion: context.jobStreamVersion,
    type: "job.failed", actorId: `worker:${workerId}`,
    correlationId: `reconciliation:${jobId}:${fencingToken}`,
    publicPayload: {
      workspaceId: context.workspaceId, executionId: context.executionId, status: "failed",
      failureCode: RECONCILIATION_FAILURE.code, needsReconciliation: true, fencingToken,
    },
  }, now);
  await putProjection(client, context, "job", jobId, context.jobStreamVersion, nextJob, now);
}

export class PostgresWorkerStore {
  #pool;
  #hmacKey;

  constructor({ pool, hmacKey }) {
    if (!pool?.connect) throw new TypeError("PostgreSQL pool 无效");
    if (!(hmacKey instanceof Uint8Array) || hmacKey.byteLength < 32) {
      throw new TypeError("事件 HMAC 密钥至少需要 32 字节");
    }
    this.#pool = pool;
    this.#hmacKey = Buffer.from(hmacKey);
  }

  async claimJob(workerId, now, options = {}) {
    const occurredAt = iso(now);
    const client = await this.#pool.connect();
    const parameters = [occurredAt];
    const conditions = [
      "available_at <= $1::timestamptz",
      "(status = 'available' or (status = 'leased' and lease_expires_at <= $1::timestamptz))",
    ];
    if (options.tenantId) {
      parameters.push(options.tenantId);
      conditions.push(`tenant_id = $${parameters.length}`);
    }
    if ((options.kinds?.length ?? 0) > 0) {
      parameters.push(options.kinds);
      conditions.push(`kind = any($${parameters.length}::text[])`);
    }
    try {
      while (true) {
        await client.query("begin");
        try {
          const prior = (await client.query(`
            select * from mn_v2.jobs where ${conditions.join(" and ")}
            order by available_at, created_at, job_id
            for update skip locked limit 1
          `, parameters)).rows[0];
          if (!prior) {
            await client.query("commit");
            return undefined;
          }
          const context = await loadExecutionContext(client, prior);
          const genericContext = await loadGenericJobContext(client, prior);
          if (await settleTerminalJobBeforeClaim(
            client,
            this.#hmacKey,
            context,
            prior,
            workerId,
            occurredAt,
          )) {
            await flushTenantHead(client, context);
            await client.query("commit");
            continue;
          }
          const leaseExpiresAt = new Date(Date.parse(occurredAt) + JOB_LEASE_MILLISECONDS).toISOString();
          const previousFencing = safeInteger(prior.fencing_token, "Job fencing token");
          const fencingToken = previousFencing + 1;
          const row = (await client.query(`
            update mn_v2.jobs set status = 'leased', attempts = attempts + 1,
              lease_owner = $1, lease_expires_at = $2::timestamptz,
              fencing_token = $3, updated_at = $4::timestamptz
            where job_id = $5 and status = $6 and fencing_token = $7
            returning *
          `, [
            workerId, leaseExpiresAt, fencingToken, occurredAt, String(prior.job_id),
            String(prior.status), previousFencing,
          ])).rows[0];
          if (!row) throw new StaleFencingTokenError(String(prior.job_id));
          await recordClaim(
            client,
            this.#hmacKey,
            context,
            prior,
            workerId,
            leaseExpiresAt,
            fencingToken,
            occurredAt,
          );
          await recordClaim(
            client,
            this.#hmacKey,
            genericContext,
            prior,
            workerId,
            leaseExpiresAt,
            fencingToken,
            occurredAt,
          );
          if (context) await flushTenantHead(client, context);
          if (genericContext) await flushTenantHead(client, genericContext);
          await client.query("commit");
          return rowToJob(row);
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }
    } finally {
      client.release();
    }
  }

  async #ownedLeasedJob(client, jobId, workerId, fencingToken, occurredAt) {
    const row = (await client.query(`
      select * from mn_v2.jobs
      where job_id = $1 and status = 'leased' and lease_owner = $2 and fencing_token = $3
        and lease_expires_at > $4::timestamptz
      for update
    `, [jobId, workerId, fencingToken, occurredAt])).rows[0];
    if (!row) throw new StaleFencingTokenError(jobId);
    return row;
  }

  async #settleJob(jobId, workerId, fencingToken, value, now, status) {
    const occurredAt = iso(now);
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const row = await this.#ownedLeasedJob(client, jobId, workerId, fencingToken, occurredAt);
      const context = await loadExecutionContext(client, row);
      const genericContext = await loadGenericJobContext(client, row);
      const changed = await client.query(status === "completed" ? `
        update mn_v2.jobs set status = 'completed', result_json = $1::jsonb,
          failure_json = null, lease_owner = null, lease_expires_at = null,
          updated_at = $2::timestamptz
        where job_id = $3 and status = 'leased' and lease_owner = $4 and fencing_token = $5
          and lease_expires_at > $2::timestamptz
      ` : `
        update mn_v2.jobs set status = 'failed', failure_json = $1::jsonb,
          result_json = null, lease_owner = null, lease_expires_at = null,
          updated_at = $2::timestamptz
        where job_id = $3 and status = 'leased' and lease_owner = $4 and fencing_token = $5
          and lease_expires_at > $2::timestamptz
      `, [JSON.stringify(value), occurredAt, jobId, workerId, fencingToken]);
      if (changed.rowCount !== 1) throw new StaleFencingTokenError(jobId);
      await recordTerminal(client, this.#hmacKey, context, row, workerId, fencingToken, status, value, occurredAt);
      await recordTerminal(
        client,
        this.#hmacKey,
        genericContext,
        row,
        workerId,
        fencingToken,
        status,
        value,
        occurredAt,
      );
      if (context) await flushTenantHead(client, context);
      if (genericContext) await flushTenantHead(client, genericContext);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeJob(jobId, workerId, fencingToken, result, now) {
    await this.#settleJob(jobId, workerId, fencingToken, result, now, "completed");
  }

  async failJob(jobId, workerId, fencingToken, failure, now) {
    await this.#settleJob(jobId, workerId, fencingToken, failure, now, "failed");
  }

  async renewJobLease(jobId, workerId, fencingToken, now) {
    const occurredAt = iso(now);
    const leaseExpiresAt = new Date(Date.parse(occurredAt) + JOB_LEASE_MILLISECONDS).toISOString();
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const row = await this.#ownedLeasedJob(client, jobId, workerId, fencingToken, occurredAt);
      const context = await loadExecutionContext(client, row);
      const genericContext = await loadGenericJobContext(client, row);
      const changed = await client.query(`
        update mn_v2.jobs set lease_expires_at = $1::timestamptz, updated_at = $2::timestamptz
        where job_id = $3 and status = 'leased' and lease_owner = $4 and fencing_token = $5
          and lease_expires_at > $2::timestamptz
      `, [leaseExpiresAt, occurredAt, jobId, workerId, fencingToken]);
      if (changed.rowCount !== 1) throw new StaleFencingTokenError(jobId);
      await recordRenewal(client, this.#hmacKey, context, row, workerId, leaseExpiresAt, fencingToken, occurredAt);
      await recordRenewal(
        client,
        this.#hmacKey,
        genericContext,
        row,
        workerId,
        leaseExpiresAt,
        fencingToken,
        occurredAt,
      );
      if (context) await flushTenantHead(client, context);
      if (genericContext) await flushTenantHead(client, genericContext);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async interruptJob(jobId, workerId, fencingToken, reason, now) {
    const occurredAt = iso(now);
    if (typeof reason !== "string" || !reason.trim()) throw new TypeError("中断原因不能为空");
    const failure = {
      code: "EXECUTION_INTERRUPTED",
      message: reason,
      retryable: false,
    };
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const row = await this.#ownedLeasedJob(client, jobId, workerId, fencingToken, occurredAt);
      const context = await loadExecutionContext(client, row);
      const genericContext = await loadGenericJobContext(client, row);
      const changed = await client.query(`
        update mn_v2.jobs set status = 'failed', failure_json = $1::jsonb,
          result_json = null, lease_owner = null, lease_expires_at = null,
          updated_at = $2::timestamptz
        where job_id = $3 and status = 'leased' and lease_owner = $4 and fencing_token = $5
          and lease_expires_at > $2::timestamptz
      `, [JSON.stringify(failure), occurredAt, jobId, workerId, fencingToken]);
      if (changed.rowCount !== 1) throw new StaleFencingTokenError(jobId);
      await recordInterrupted(
        client,
        this.#hmacKey,
        context,
        row,
        workerId,
        fencingToken,
        failure,
        occurredAt,
      );
      await recordTerminal(
        client,
        this.#hmacKey,
        genericContext,
        row,
        workerId,
        fencingToken,
        "failed",
        failure,
        occurredAt,
      );
      if (context) await flushTenantHead(client, context);
      if (genericContext) await flushTenantHead(client, genericContext);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markNeedsReconciliation(executionId, input) {
    const occurredAt = iso(input.occurredAt);
    const workerId = requiredString(input.workerId, "workerId");
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const row = await this.#ownedLeasedJob(
        client, input.jobId, workerId, input.fencingToken, occurredAt,
      );
      if (executionIdFromPayload(row, true) !== executionId) {
        throw new Error("Job 与待核对的 Execution 不一致");
      }
      const context = await loadExecutionContext(client, row, { requireAgentJob: false });
      if (!["running", "waiting_approval"].includes(context.execution.status)) {
        throw new Error(`Execution ${executionId} 不是可核对状态`);
      }
      const failure = { ...RECONCILIATION_FAILURE, executionId };
      const changed = await client.query(`
        update mn_v2.jobs set status = 'failed', result_json = null, failure_json = $1::jsonb,
          lease_owner = null, lease_expires_at = null, updated_at = $2::timestamptz
        where job_id = $3 and status = 'leased' and lease_owner = $4 and fencing_token = $5
          and lease_expires_at > $2::timestamptz
      `, [JSON.stringify(failure), occurredAt, input.jobId, workerId, input.fencingToken]);
      if (changed.rowCount !== 1) throw new StaleFencingTokenError(input.jobId);
      await recordJobReconciliation(
        client, this.#hmacKey, context, row, workerId, input.fencingToken, failure, occurredAt,
      );
      const nextExecution = {
        ...context.execution,
        status: "needs_reconciliation",
        failureCode: RECONCILIATION_FAILURE.code,
        streamVersion: context.executionStreamVersion + 1,
        updatedAt: occurredAt,
      };
      await appendEvent(client, this.#hmacKey, context, {
        aggregateType: "execution", aggregateId: executionId,
        expectedStreamVersion: context.executionStreamVersion,
        type: "execution.needs_reconciliation", actorId: `worker:${workerId}`,
        correlationId: `reconciliation:${input.jobId}:${input.fencingToken}`,
        publicPayload: {
          workspaceId: context.workspaceId, jobId: input.jobId,
          status: "needs_reconciliation", reason: RECONCILIATION_FAILURE.code,
        },
      }, occurredAt);
      await putProjection(
        client, context, "execution", executionId,
        context.executionStreamVersion, nextExecution, occurredAt,
      );
      const reconciliation = await client.query(`
        insert into mn_v2.reconciliations (
          execution_id, job_id, fencing_token, status, occurred_at
        ) values ($1, $2, $3, 'needs_reconciliation', $4::timestamptz)
        on conflict (execution_id) do update set execution_id = excluded.execution_id
        where mn_v2.reconciliations.job_id = excluded.job_id
          and mn_v2.reconciliations.fencing_token = excluded.fencing_token
        returning execution_id
      `, [executionId, input.jobId, input.fencingToken, occurredAt]);
      if (reconciliation.rowCount !== 1) throw new Error("Execution 已由其他 Job 标记为需要人工核对");
      const inboxId = `reconciliation:${executionId}:${input.jobId}`;
      const inbox = {
        id: inboxId, tenantId: context.tenantId, workspaceId: context.workspaceId, executionId,
        kind: "reconciliation", title: "外部操作结果需要人工核对",
        summary: RECONCILIATION_FAILURE.message, risk: "unknown",
        resourceSummary: input.jobId, createdAt: occurredAt, status: "open",
      };
      await client.query(`
        insert into mn_v2.projections (
          tenant_id, namespace, projection_key, stream_version, value_json, updated_at
        ) values ($1, 'inbox', $2, 0, $3::jsonb, $4::timestamptz)
        on conflict (tenant_id, namespace, projection_key) do update set
          value_json = excluded.value_json, updated_at = excluded.updated_at
      `, [context.tenantId, inboxId, JSON.stringify(inbox), occurredAt]);
      await client.query(`
        insert into mn_v2.outbox (
          message_id, tenant_id, topic, payload_json, available_at, created_at
        ) values ($1, $2, 'execution.reconciliation_required', $3::jsonb, $4::timestamptz, $4::timestamptz)
        on conflict (message_id) do nothing
      `, [
        `reconciliation:${executionId}:${input.jobId}`, context.tenantId,
        JSON.stringify({ executionId, jobId: input.jobId, workspaceId: context.workspaceId }),
        occurredAt,
      ]);
      await flushTenantHead(client, context);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
