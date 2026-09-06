// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { computeEventHmac } from "@mn/storage";

import { PostgresKernelStore } from "../lib/postgres-kernel-store.mjs";
import { PostgresWorkerStore } from "../lib/postgres-worker-store.mjs";

const startedAt = "2025-01-02T03:04:05.000Z";
const hmacKey = Buffer.alloc(32, 7);

function clone(value) {
  return structuredClone(value);
}

class WorkerFixtureClient {
  queries = [];
  events = [];
  outbox = [];
  inbox = new Map();
  reconciliations = new Map();
  position = 3;
  previousDigest = "a".repeat(64);
  streams = new Map([["job:job-a", 1], ["execution:execution-a", 1]]);
  projections = new Map();
  snapshot;
  job;

  constructor({ kind = "agent.execution.run", projected = kind === "agent.execution.run" } = {}) {
    const payload = kind === "coding.sandbox.cleanup"
      ? { reconciliationExecutionId: "execution-a" }
      : kind === "system.noop"
        ? {}
        : { executionId: "execution-a", message: "开始" };
    this.job = {
      job_id: "job-a",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      kind,
      payload_json: payload,
      status: "available",
      attempts: 0,
      available_at: startedAt,
      lease_owner: null,
      lease_expires_at: null,
      fencing_token: 0,
      idempotency_key: "execution-a:generation:1",
      result_json: null,
      failure_json: null,
      created_at: startedAt,
      updated_at: startedAt,
    };
    this.projections.set("execution:execution-a", {
      id: "execution-a",
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
      generation: 1,
      status: "queued",
      streamVersion: 1,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    if (projected) {
      this.projections.set("job:job-a", {
        id: "job-a",
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        kind,
        payload: clone(this.job.payload_json),
        status: "available",
        attempts: 0,
        availableAt: startedAt,
        fencingToken: 0,
        idempotencyKey: this.job.idempotency_key,
        streamVersion: 1,
        createdAt: startedAt,
        updatedAt: startedAt,
      });
    }
  }

  #takeSnapshot() {
    return clone({
      job: this.job,
      events: this.events,
      outbox: this.outbox,
      inbox: [...this.inbox],
      reconciliations: [...this.reconciliations],
      position: this.position,
      previousDigest: this.previousDigest,
      streams: [...this.streams],
      projections: [...this.projections],
    });
  }

  #restoreSnapshot(snapshot) {
    this.job = snapshot.job;
    this.events = snapshot.events;
    this.outbox = snapshot.outbox;
    this.inbox = new Map(snapshot.inbox);
    this.reconciliations = new Map(snapshot.reconciliations);
    this.position = snapshot.position;
    this.previousDigest = snapshot.previousDigest;
    this.streams = new Map(snapshot.streams);
    this.projections = new Map(snapshot.projections);
  }

  async query(sql, parameters = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.queries.push({ sql: normalized, parameters });
    if (normalized === "begin") {
      this.snapshot = this.#takeSnapshot();
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "commit") {
      this.snapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "rollback") {
      if (this.snapshot) this.#restoreSnapshot(this.snapshot);
      this.snapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("select tenant_id from mn_v2.jobs where job_id")) {
      return { rows: this.job.job_id === parameters[0] ? [{ tenant_id: this.job.tenant_id }] : [], rowCount: 1 };
    }
    if (normalized.startsWith("select * from mn_v2.jobs where available_at")) {
      const claimable = Date.parse(this.job.available_at) <= Date.parse(parameters[0])
        && (this.job.status === "available"
          || (this.job.status === "leased"
            && Date.parse(this.job.lease_expires_at) <= Date.parse(parameters[0])));
      return { rows: claimable ? [clone(this.job)] : [], rowCount: claimable ? 1 : 0 };
    }
    if (normalized.startsWith("select * from mn_v2.jobs where job_id")) {
      const owned = this.job.job_id === parameters[0]
        && this.job.status === "leased"
        && this.job.lease_owner === parameters[1]
        && this.job.fencing_token === parameters[2]
        && Date.parse(this.job.lease_expires_at) > Date.parse(parameters[3]);
      return { rows: owned ? [clone(this.job)] : [], rowCount: owned ? 1 : 0 };
    }
    if (normalized.startsWith("update mn_v2.jobs set status = 'leased'")) {
      const matches = this.job.job_id === parameters[4]
        && this.job.status === parameters[5]
        && this.job.fencing_token === parameters[6];
      if (!matches) return { rows: [], rowCount: 0 };
      this.job = {
        ...this.job,
        status: "leased",
        attempts: this.job.attempts + 1,
        lease_owner: parameters[0],
        lease_expires_at: parameters[1],
        fencing_token: parameters[2],
        updated_at: parameters[3],
      };
      return { rows: [clone(this.job)], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.jobs set status = 'completed'")) {
      this.job = {
        ...this.job,
        status: "completed",
        result_json: JSON.parse(parameters[0]),
        failure_json: null,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: parameters[1],
      };
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.jobs set status = 'failed'")) {
      if (normalized.includes("fencing_token = $2")) {
        const matches = this.job.tenant_id === parameters[3]
          && this.job.job_id === parameters[4]
          && this.job.status === parameters[5]
          && this.job.fencing_token === parameters[6];
        if (!matches) return { rows: [], rowCount: 0 };
        this.job = {
          ...this.job,
          status: "failed",
          failure_json: JSON.parse(parameters[0]),
          result_json: null,
          lease_owner: null,
          lease_expires_at: null,
          fencing_token: parameters[1],
          updated_at: parameters[2],
        };
        return { rows: [], rowCount: 1 };
      }
      this.job = {
        ...this.job,
        status: "failed",
        failure_json: JSON.parse(parameters[0]),
        result_json: null,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: parameters[1],
      };
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.jobs set lease_expires_at")) {
      this.job = { ...this.job, lease_expires_at: parameters[0], updated_at: parameters[1] };
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("select next_position, previous_digest from mn_v2.tenant_heads")) {
      return { rows: [{ next_position: this.position, previous_digest: this.previousDigest }], rowCount: 1 };
    }
    if (normalized.startsWith("select aggregate_type, aggregate_id, stream_version from mn_v2.stream_heads")) {
      return {
        rows: [...this.streams].map(([key, stream_version]) => {
          const separator = key.indexOf(":");
          return {
            aggregate_type: key.slice(0, separator),
            aggregate_id: key.slice(separator + 1),
            stream_version,
          };
        }),
        rowCount: this.streams.size,
      };
    }
    if (normalized.startsWith("select namespace, projection_key, value_json from mn_v2.projections")) {
      return {
        rows: [...this.projections].map(([key, value_json]) => {
          const separator = key.indexOf(":");
          return {
            namespace: key.slice(0, separator),
            projection_key: key.slice(separator + 1),
            value_json: clone(value_json),
          };
        }),
        rowCount: this.projections.size,
      };
    }
    if (normalized.startsWith("select idempotency_key, request_hash, response_json, created_at")) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("select job_id, status, lease_owner, lease_expires_at, fencing_token")) {
      const pending = this.job.status === "available" || this.job.status === "leased"
        ? [clone(this.job)]
        : [];
      return { rows: pending, rowCount: pending.length };
    }
    if (normalized.startsWith("select stream_version, value_json from mn_v2.projections")) {
      const value = this.projections.get(`${parameters[1]}:${parameters[2]}`);
      return value
        ? { rows: [{ stream_version: value.streamVersion, value_json: clone(value) }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("select stream_version from mn_v2.stream_heads")) {
      const version = this.streams.get(`${parameters[1]}:${parameters[2]}`) ?? 0;
      return { rows: [{ stream_version: version }], rowCount: 1 };
    }
    if (normalized.startsWith("insert into mn_v2.events")) {
      this.events.push({
        aggregateType: parameters[3],
        aggregateId: parameters[4],
        streamVersion: parameters[5],
        type: parameters[6],
        publicPayload: JSON.parse(parameters.length === 18 ? parameters[13] : parameters[12]),
        digest: parameters.at(-2),
        hmac: parameters.at(-1),
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.stream_heads set stream_version")) {
      const key = `${parameters[1]}:${parameters[2]}`;
      if ((this.streams.get(key) ?? 0) !== parameters[4]) return { rows: [], rowCount: 0 };
      this.streams.set(key, parameters[3]);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.projections set stream_version")) {
      const key = `${parameters[1]}:${parameters[2]}`;
      const prior = this.projections.get(key);
      if (!prior || prior.streamVersion !== parameters[6]) return { rows: [], rowCount: 0 };
      this.projections.set(key, JSON.parse(parameters[4]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.tenant_heads set next_position")) {
      this.position = parameters[1];
      this.previousDigest = parameters[2];
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("insert into mn_v2.reconciliations")) {
      this.reconciliations.set(parameters[0], {
        executionId: parameters[0], jobId: parameters[1], fencingToken: parameters[2],
      });
      return { rows: [{ execution_id: parameters[0] }], rowCount: 1 };
    }
    if (normalized.startsWith("insert into mn_v2.projections") && normalized.includes("'inbox'")) {
      this.inbox.set(parameters[1], JSON.parse(parameters[2]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("insert into mn_v2.projections")) {
      this.projections.set(`${parameters[1]}:${parameters[2]}`, JSON.parse(parameters[4]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("insert into mn_v2.outbox")) {
      this.outbox.push({
        id: parameters[0],
        tenantId: parameters[1],
        topic: normalized.includes("'execution.reconciliation_required'")
          ? "execution.reconciliation_required"
          : parameters[2],
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }

  release() {}
}

function fixtureStore(client) {
  return new PostgresWorkerStore({
    pool: { connect: async () => client },
    hmacKey,
  });
}

function projection(client, namespace, id) {
  return client.projections.get(`${namespace}:${id}`);
}

test("Agent Job 领取与完成原子推进 Job、Execution、HMAC 事件和 outbox", async () => {
  const client = new WorkerFixtureClient();
  const store = fixtureStore(client);
  const job = await store.claimJob("worker-a", startedAt);
  assert.equal(job.status, "leased");
  assert.equal(job.fencingToken, 1);
  assert.equal(projection(client, "job", "job-a").status, "leased");
  assert.equal(projection(client, "job", "job-a").streamVersion, 2);
  assert.equal(projection(client, "execution", "execution-a").status, "running");

  await store.completeJob("job-a", "worker-a", 1, { answer: "done" }, "2025-01-02T03:04:10.000Z");
  assert.equal(client.job.status, "completed");
  assert.equal(projection(client, "job", "job-a").status, "completed");
  assert.deepEqual(projection(client, "job", "job-a").result, { answer: "done" });
  assert.equal(projection(client, "execution", "execution-a").status, "completed");
  assert.deepEqual(client.events.map(({ type }) => type), [
    "job.leased", "execution.running", "job.completed", "execution.completed",
  ]);
  for (const event of client.events) {
    assert.equal(event.publicPayload?.projectionFacts?.version, 1,
      `${event.type} must contain reconstructable projection facts`);
    assert.match(event.digest, /^[a-f0-9]{64}$/u);
    assert.equal(event.hmac, computeEventHmac(event.digest, hmacKey));
  }
  assert.equal(client.outbox.length, 4);
  assert.equal(client.queries.filter(({ sql }) => sql === "commit").length, 2);
});

test("Worker claim and renewal acquire the Kernel tenant lock before locking Jobs", async () => {
  const client = new WorkerFixtureClient();
  const store = fixtureStore(client);
  const claimed = await store.claimJob("worker-a", startedAt);
  const assertOrder = () => {
    const tenantLock = client.queries.findIndex(({ sql }) => sql.includes("pg_advisory_xact_lock"));
    const jobLock = client.queries.findIndex(({ sql }) => sql.includes("from mn_v2.jobs") && sql.includes("for update"));
    assert.ok(tenantLock >= 0 && tenantLock < jobLock, "tenant lock must precede the physical Job lock");
  };
  assertOrder();
  client.queries.length = 0;
  await store.renewJobLease(claimed.id, "worker-a", claimed.fencingToken, "2025-01-02T03:04:10.000Z");
  assertOrder();
});

test("企业 Kernel 业务事务原子终结 Agent Job、Execution 和产品投影", async () => {
  const client = new WorkerFixtureClient();
  const workerStore = fixtureStore(client);
  const claimed = await workerStore.claimJob("worker-a", startedAt);
  const kernelStore = new PostgresKernelStore({
    pool: { connect: async () => client, query: client.query.bind(client) },
    hmacKey,
    now: () => "2025-01-02T03:04:10.000Z",
  });

  await kernelStore.transact("tenant-a", (transaction) => {
    transaction.putProjection("coding.execution", "execution-a", {
      executionId: "execution-a",
      status: "completed",
      streamVersion: 1,
    });
    assert.equal(typeof transaction.settleJob, "function");
    transaction.settleJob({
      jobId: claimed.id,
      workerId: "worker-a",
      fencingToken: claimed.fencingToken,
      outcome: "completed",
      value: { executionId: "execution-a", status: "completed" },
      occurredAt: "2025-01-02T03:04:10.000Z",
    });
  });

  assert.equal(client.job.status, "completed");
  assert.equal(projection(client, "job", "job-a").status, "completed");
  assert.equal(projection(client, "execution", "execution-a").status, "completed");
  assert.equal(projection(client, "coding.execution", "execution-a").status, "completed");
  for (const event of client.events.slice(-2)) {
    assert.deepEqual(event.publicPayload.projectionFacts?.changes[0]?.value,
      projection(client, event.aggregateType, event.aggregateId));
  }
  assert.deepEqual(client.events.slice(-2).map(({ type }) => type), [
    "job.completed",
    "execution.completed",
  ]);
});

test("企业 Kernel 业务事务可使待执行 Job 失效并推进 fencing token", async () => {
  const client = new WorkerFixtureClient({ kind: "coding.reconciliation.verify", projected: true });
  client.job.payload_json = { reconciliationExecutionId: "execution-a" };
  client.projections.set("job:job-a", {
    ...client.projections.get("job:job-a"),
    payload: clone(client.job.payload_json),
  });
  const kernelStore = new PostgresKernelStore({
    pool: { connect: async () => client, query: client.query.bind(client) },
    hmacKey,
    now: () => "2025-01-02T03:04:10.000Z",
  });

  await kernelStore.transact("tenant-a", (transaction) => {
    const current = transaction.getProjection("job", "job-a");
    const invalidated = transaction.invalidateJob({
      jobId: "job-a",
      reason: { code: "EXECUTION_CANCELLED" },
      occurredAt: "2025-01-02T03:04:10.000Z",
    });
    transaction.putProjection("job", "job-a", {
      ...current,
      status: "failed",
      failure: { code: "EXECUTION_CANCELLED" },
      fencingToken: invalidated.fencingToken,
      streamVersion: current.streamVersion + 1,
      updatedAt: "2025-01-02T03:04:10.000Z",
    });
    transaction.appendEvent({
      tenantId: "tenant-a",
      aggregateType: "job",
      aggregateId: "job-a",
      expectedStreamVersion: current.streamVersion,
      type: "job.failed",
      actorId: "owner-a",
      executionId: "execution-a",
      generation: 1,
      correlationId: "cancel-verification",
      publicPayload: {
        workspaceId: "workspace-a",
        jobId: "job-a",
        failureCode: "EXECUTION_CANCELLED",
      },
    });
  });

  assert.equal(client.job.status, "failed");
  assert.equal(client.job.fencing_token, 1);
  assert.deepEqual(client.job.failure_json, { code: "EXECUTION_CANCELLED" });
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.equal(projection(client, "job", "job-a").fencingToken, 1);
  assert.equal(client.events.at(-1).type, "job.failed");
});

test("Agent Job 重领和续租每次推进 Job，但不重复推进 running Execution", async () => {
  const client = new WorkerFixtureClient();
  const store = fixtureStore(client);
  await store.claimJob("worker-a", startedAt);
  const reclaimed = await store.claimJob("worker-b", "2025-01-02T03:04:35.000Z");
  assert.equal(reclaimed.fencingToken, 2);
  assert.equal(projection(client, "job", "job-a").streamVersion, 3);
  assert.equal(projection(client, "execution", "execution-a").streamVersion, 2);
  assert.equal(client.events.filter(({ type }) => type === "job.leased").length, 2);
  assert.equal(client.events.filter(({ type }) => type === "execution.running").length, 1);

  await store.renewJobLease("job-a", "worker-b", 2, "2025-01-02T03:04:36.000Z");
  assert.equal(projection(client, "job", "job-a").streamVersion, 4);
  assert.equal(projection(client, "job", "job-a").leaseExpiresAt, "2025-01-02T03:05:06.000Z");
  assert.equal(client.events.at(-1).type, "job.lease_renewed");
});

test("已取消 Execution 接收 Worker 取消失败时只终结 Agent Job", async () => {
  const client = new WorkerFixtureClient();
  const store = fixtureStore(client);
  await store.claimJob("worker-a", startedAt);
  const cancelledExecution = {
    ...projection(client, "execution", "execution-a"),
    status: "cancelled",
    streamVersion: 3,
    finishedAt: "2025-01-02T03:04:06.000Z",
    updatedAt: "2025-01-02T03:04:06.000Z",
  };
  client.projections.set("execution:execution-a", cancelledExecution);
  client.streams.set("execution:execution-a", 3);
  const eventCount = client.events.length;
  const outboxCount = client.outbox.length;

  await assert.rejects(
    store.failJob(
      "job-a",
      "worker-a",
      1,
      { code: "MODEL_FAILED", message: "模型请求失败" },
      "2025-01-02T03:04:06.500Z",
    ),
    /状态为 cancelled 的 Execution 不能标记为 failed/,
  );
  assert.equal(client.job.status, "leased");

  await store.failJob(
    "job-a",
    "worker-a",
    1,
    { code: "EXECUTION_CANCELLED", message: "执行已取消", retryable: false },
    "2025-01-02T03:04:07.000Z",
  );

  assert.equal(client.job.status, "failed");
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.equal(projection(client, "job", "job-a").failure.code, "EXECUTION_CANCELLED");
  assert.deepEqual(projection(client, "execution", "execution-a"), cancelledExecution);
  assert.equal(client.events.length, eventCount + 1);
  assert.equal(client.events.at(-1).type, "job.failed");
  assert.equal(client.outbox.length, outboxCount + 1);
  assert.equal(client.outbox.at(-1).topic, "job.failed");
  assert.equal(await store.claimJob("worker-b", "2025-01-02T03:04:35.000Z"), undefined);
});

test("已失败 Execution 接收 Worker 失败时只终结 Agent Job", async () => {
  const client = new WorkerFixtureClient();
  const store = fixtureStore(client);
  await store.claimJob("worker-a", startedAt);
  const failedExecution = {
    ...projection(client, "execution", "execution-a"),
    status: "failed",
    failureCode: "TOOL_APPROVAL_DENIED",
    streamVersion: 3,
    finishedAt: "2025-01-02T03:04:06.000Z",
    updatedAt: "2025-01-02T03:04:06.000Z",
  };
  client.projections.set("execution:execution-a", failedExecution);
  client.streams.set("execution:execution-a", 3);
  const eventCount = client.events.length;
  const outboxCount = client.outbox.length;

  await store.failJob(
    "job-a",
    "worker-a",
    1,
    { code: "TOOL_APPROVAL_DENIED", message: "用户拒绝工具调用", retryable: false },
    "2025-01-02T03:04:07.000Z",
  );

  assert.equal(client.job.status, "failed");
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.deepEqual(projection(client, "execution", "execution-a"), failedExecution);
  assert.equal(client.events.length, eventCount + 1);
  assert.equal(client.events.at(-1).type, "job.failed");
  assert.equal(client.outbox.length, outboxCount + 1);
  assert.equal(client.outbox.at(-1).topic, "job.failed");
});

test("claim 原子终结终态 Execution 的 Agent Job 且不再重领", async () => {
  for (const status of ["cancelled", "failed", "completed"]) {
    const client = new WorkerFixtureClient();
    const store = fixtureStore(client);
    const terminalExecution = {
      ...projection(client, "execution", "execution-a"),
      status,
      ...(status === "failed" ? { failureCode: "TOOL_APPROVAL_DENIED" } : {}),
      streamVersion: 2,
      finishedAt: "2025-01-02T03:04:04.000Z",
      updatedAt: "2025-01-02T03:04:04.000Z",
    };
    client.projections.set("execution:execution-a", terminalExecution);
    client.streams.set("execution:execution-a", 2);

    assert.equal(await store.claimJob("worker-a", startedAt), undefined);
    assert.equal(client.job.status, "failed");
    assert.equal(client.job.attempts, 0);
    assert.equal(client.job.fencing_token, 0);
    assert.deepEqual(client.job.failure_json, status === "cancelled" ? {
      code: "EXECUTION_CANCELLED",
      message: "Execution 已在领取 Job 前取消",
      retryable: false,
    } : {
      code: "EXECUTION_ALREADY_TERMINAL",
      message: "Execution 已在领取 Job 前终结",
      retryable: false,
      executionStatus: status,
    });
    assert.equal(projection(client, "job", "job-a").status, "failed");
    assert.equal(projection(client, "job", "job-a").attempts, 0);
    assert.equal(projection(client, "job", "job-a").fencingToken, 0);
    assert.deepEqual(projection(client, "execution", "execution-a"), terminalExecution);
    assert.deepEqual(client.events.map(({ type }) => type), ["job.failed"]);
    assert.deepEqual(client.outbox.map(({ topic }) => topic), ["job.failed"]);

    assert.equal(await store.claimJob("worker-b", "2025-01-02T03:05:00.000Z"), undefined);
    assert.deepEqual(client.events.map(({ type }) => type), ["job.failed"]);
  }
});

test("Agent Job 失败受 fencing 保护并同步 Job 与 Execution", async () => {
  const client = new WorkerFixtureClient();
  const store = fixtureStore(client);
  await store.claimJob("worker-a", startedAt);
  await assert.rejects(
    () => store.failJob("job-a", "worker-a", 0, { code: "STALE" }, "2025-01-02T03:04:06.000Z"),
    (error) => error?.code === "STALE_FENCING_TOKEN",
  );
  assert.equal(client.job.status, "leased");
  await store.failJob(
    "job-a", "worker-a", 1,
    { code: "JOB_EXECUTION_FAILED", message: "boom", retryable: true },
    "2025-01-02T03:04:07.000Z",
  );
  assert.equal(client.job.status, "failed");
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.equal(projection(client, "execution", "execution-a").failureCode, "JOB_EXECUTION_FAILED");
  assert.deepEqual(client.events.slice(-2).map(({ type }) => type), ["job.failed", "execution.failed"]);
});

test("Agent Job 中断原子推进 Job failed 与 Execution interrupted", async () => {
  const client = new WorkerFixtureClient();
  const store = fixtureStore(client);
  await store.claimJob("worker-a", startedAt);
  await store.interruptJob(
    "job-a",
    "worker-a",
    1,
    "Worker 已停止",
    "2025-01-02T03:04:07.000Z",
  );
  assert.equal(client.job.status, "failed");
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.equal(projection(client, "job", "job-a").failure.code, "EXECUTION_INTERRUPTED");
  assert.equal(projection(client, "execution", "execution-a").status, "interrupted");
  assert.deepEqual(client.events.slice(-2).map(({ type }) => type), [
    "job.failed", "execution.interrupted",
  ]);
});

test("未知外部副作用在同一事务终止 Agent Job 并创建人工核对项", async () => {
  const client = new WorkerFixtureClient();
  const store = fixtureStore(client);
  await store.claimJob("worker-a", startedAt);
  await store.renewJobLease("job-a", "worker-a", 1, "2025-01-02T03:04:10.000Z");
  await store.markNeedsReconciliation("execution-a", {
    jobId: "job-a",
    workerId: "worker-a",
    fencingToken: 1,
    occurredAt: "2025-01-02T03:04:11.000Z",
  });
  assert.equal(client.job.status, "failed");
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.equal(projection(client, "job", "job-a").failure.code, "UNKNOWN_EXTERNAL_SIDE_EFFECT");
  assert.equal(projection(client, "execution", "execution-a").status, "needs_reconciliation");
  assert.equal(client.inbox.get("reconciliation:execution-a:job-a").status, "open");
  assert.equal(client.reconciliations.get("execution-a").jobId, "job-a");
  assert.deepEqual(client.events.slice(-3).map(({ type }) => type), [
    "job.lease_renewed", "job.failed", "execution.needs_reconciliation",
  ]);
  assert.ok(client.outbox.some(({ topic }) => topic === "execution.reconciliation_required"));
  const changes = client.events.at(-1).publicPayload.projectionFacts?.changes;
  assert.deepEqual(changes?.find(change => change.namespace === "execution")?.value,
    projection(client, "execution", "execution-a"));
  assert.deepEqual(changes?.find(change => change.namespace === "inbox")?.value,
    client.inbox.get("reconciliation:execution-a:job-a"));
});

test("带投影的 generic Job 在领取、续租与完成时原子推进生命周期", async () => {
  const client = new WorkerFixtureClient({ kind: "coding.sandbox.cleanup", projected: true });
  const store = fixtureStore(client);

  const job = await store.claimJob("worker-a", startedAt);
  assert.equal(job.status, "leased");
  assert.equal(job.fencingToken, 1);
  assert.deepEqual(projection(client, "job", "job-a"), {
    id: "job-a",
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    kind: "coding.sandbox.cleanup",
    payload: { reconciliationExecutionId: "execution-a" },
    status: "leased",
    attempts: 1,
    availableAt: startedAt,
    leaseOwner: "worker-a",
    leaseExpiresAt: "2025-01-02T03:04:35.000Z",
    fencingToken: 1,
    idempotencyKey: "execution-a:generation:1",
    streamVersion: 2,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  assert.equal(projection(client, "execution", "execution-a").status, "queued");
  const kernelStore = new PostgresKernelStore({
    pool: {
      connect: async () => client,
      query: client.query.bind(client),
    },
    hmacKey,
    now: () => startedAt,
  });
  await kernelStore.transact("tenant-a", (transaction) => {
    transaction.assertJobLease({
      jobId: "job-a",
      workerId: "worker-a",
      fencingToken: 1,
      occurredAt: "2025-01-02T03:04:06.000Z",
    });
  });

  await store.renewJobLease("job-a", "worker-a", 1, "2025-01-02T03:04:10.000Z");
  assert.equal(projection(client, "job", "job-a").streamVersion, 3);
  assert.equal(projection(client, "job", "job-a").leaseExpiresAt, "2025-01-02T03:04:40.000Z");

  await store.completeJob(
    "job-a",
    "worker-a",
    1,
    { executionId: "execution-a", status: "cleaned" },
    "2025-01-02T03:04:11.000Z",
  );
  assert.equal(client.job.status, "completed");
  assert.equal(projection(client, "job", "job-a").status, "completed");
  assert.equal(projection(client, "job", "job-a").streamVersion, 4);
  assert.deepEqual(projection(client, "job", "job-a").result, {
    executionId: "execution-a",
    status: "cleaned",
  });
  assert.equal(projection(client, "execution", "execution-a").status, "queued");
  assert.deepEqual(client.events.map(({ type }) => type), [
    "job.leased", "job.lease_renewed", "job.completed",
  ]);
  assert.deepEqual(client.outbox.map(({ topic }) => topic), [
    "job.leased", "job.lease_renewed", "job.completed",
  ]);
});

test("带投影的 generic Job 失败与中断都受 fencing 保护并同步投影", async (context) => {
  await context.test("失败", async () => {
    const client = new WorkerFixtureClient({ kind: "coding.sandbox.cleanup", projected: true });
    const store = fixtureStore(client);
    await store.claimJob("worker-a", startedAt);
    await assert.rejects(
      () => store.failJob(
        "job-a",
        "worker-a",
        0,
        { code: "STALE" },
        "2025-01-02T03:04:06.000Z",
      ),
      (error) => error?.code === "STALE_FENCING_TOKEN",
    );
    await store.failJob(
      "job-a",
      "worker-a",
      1,
      { code: "JOB_EXECUTION_FAILED", message: "cleanup failed", retryable: true },
      "2025-01-02T03:04:07.000Z",
    );
    assert.equal(client.job.status, "failed");
    assert.equal(projection(client, "job", "job-a").status, "failed");
    assert.equal(projection(client, "job", "job-a").failure.code, "JOB_EXECUTION_FAILED");
    assert.equal(projection(client, "execution", "execution-a").status, "queued");
    assert.deepEqual(client.events.map(({ type }) => type), ["job.leased", "job.failed"]);
  });

  await context.test("中断", async () => {
    const client = new WorkerFixtureClient({ kind: "coding.sandbox.cleanup", projected: true });
    const store = fixtureStore(client);
    await store.claimJob("worker-a", startedAt);
    await store.interruptJob(
      "job-a",
      "worker-a",
      1,
      "Worker 已停止",
      "2025-01-02T03:04:07.000Z",
    );
    assert.equal(client.job.status, "failed");
    assert.equal(projection(client, "job", "job-a").status, "failed");
    assert.deepEqual(projection(client, "job", "job-a").failure, {
      code: "EXECUTION_INTERRUPTED",
      message: "Worker 已停止",
      retryable: false,
    });
    assert.equal(projection(client, "execution", "execution-a").status, "queued");
    assert.deepEqual(client.events.map(({ type }) => type), ["job.leased", "job.failed"]);
  });
});

test("无 executionId 的系统 Job 只推进物理状态", async () => {
  const client = new WorkerFixtureClient({ kind: "system.noop" });
  const store = fixtureStore(client);
  const job = await store.claimJob("worker-a", startedAt);
  await store.completeJob(job.id, "worker-a", job.fencingToken, { accepted: true }, "2025-01-02T03:04:10.000Z");
  assert.equal(client.job.status, "completed");
  assert.equal(projection(client, "execution", "execution-a").status, "queued");
  assert.equal(client.events.length, 0);
});
