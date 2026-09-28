// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  POSTGRES_SCHEMA_SQL,
  PostgresStorage,
  StaleFencingTokenError,
  computeEventHmac,
  postgresStorageSchema
} from "../src/index.js";
import type { PostgresQueryResult } from "../src/index.js";

const startedAt = "2025-01-02T03:04:05.000Z";
const hmacKey = Buffer.alloc(32, 7);

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

interface PhysicalJobRow extends Record<string, unknown> {
  job_id: string;
  tenant_id: string;
  workspace_id: string;
  kind: string;
  payload_json: Record<string, unknown>;
  status: string;
  attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  idempotency_key: string;
  result_json: unknown;
  failure_json: unknown;
  created_at: string;
  updated_at: string;
}

interface RecordedEvent {
  publicPayload: Record<string, unknown>;
  aggregateType: string;
  aggregateId: string;
  streamVersion: number;
  type: string;
  digest: string;
  hmac: string;
}

interface RecordedOutbox {
  id: string;
  tenantId: string;
  topic: string;
}

interface FixtureSnapshot {
  job: PhysicalJobRow;
  events: RecordedEvent[];
  outbox: RecordedOutbox[];
  projections: Array<[string, Record<string, unknown>]>;
  position: number;
  previousDigest: string;
  streams: Array<[string, number]>;
}

class PostgresLifecycleFixture {
  readonly queries: Array<{ readonly sql: string; readonly parameters: readonly unknown[] }> = [];
  events: RecordedEvent[] = [];
  outbox: RecordedOutbox[] = [];
  projections = new Map<string, Record<string, unknown>>();
  position = 3;
  previousDigest = "a".repeat(64);
  streams = new Map<string, number>([["job:job-a", 1], ["execution:execution-a", 1]]);
  job: PhysicalJobRow;
  snapshot?: FixtureSnapshot;

  constructor(options: {
    readonly kind?: string;
    readonly projectJob?: boolean;
    readonly projectedJobStreamVersion?: number;
    readonly projectedExecutionStreamVersion?: number;
  } = {}) {
    const kind = options.kind ?? "agent.execution.run";
    this.job = {
      job_id: "job-a",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      kind,
      payload_json: kind === "system.noop"
        ? {}
        : { executionId: "execution-a", message: "开始" },
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
      updated_at: startedAt
    };
    this.projections.set("execution:execution-a", {
      id: "execution-a",
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
      generation: 1,
      status: "queued",
      streamVersion: options.projectedExecutionStreamVersion ?? 1,
      createdAt: startedAt,
      updatedAt: startedAt
    });
    if (kind === "agent.execution.run" || options.projectJob) {
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
        streamVersion: options.projectedJobStreamVersion ?? 1,
        createdAt: startedAt,
        updatedAt: startedAt
      });
    }
  }

  #takeSnapshot(): FixtureSnapshot {
    return clone({
      job: this.job,
      events: this.events,
      outbox: this.outbox,
      projections: [...this.projections],
      position: this.position,
      previousDigest: this.previousDigest,
      streams: [...this.streams]
    });
  }

  #restoreSnapshot(snapshot: FixtureSnapshot): void {
    this.job = snapshot.job;
    this.events = snapshot.events;
    this.outbox = snapshot.outbox;
    this.projections = new Map(snapshot.projections);
    this.position = snapshot.position;
    this.previousDigest = snapshot.previousDigest;
    this.streams = new Map(snapshot.streams);
  }

  async query(sql: string, parameters: readonly unknown[] = []): Promise<PostgresQueryResult> {
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
    if (normalized.startsWith("select * from mn_v2.jobs where available_at")) {
      const now = Date.parse(String(parameters[0]));
      const claimable = Date.parse(this.job.available_at) <= now
        && (this.job.status === "available"
          || (this.job.status === "leased"
            && Date.parse(String(this.job.lease_expires_at)) <= now));
      return { rows: claimable ? [clone(this.job)] : [], rowCount: claimable ? 1 : 0 };
    }
    if (normalized.startsWith("select * from mn_v2.jobs where job_id")) {
      const owned = this.job.job_id === parameters[0]
        && this.job.status === "leased"
        && this.job.lease_owner === parameters[1]
        && this.job.fencing_token === parameters[2]
        && Date.parse(String(this.job.lease_expires_at)) > Date.parse(String(parameters[3]));
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
        lease_owner: String(parameters[0]),
        lease_expires_at: String(parameters[1]),
        fencing_token: Number(parameters[2]),
        updated_at: String(parameters[3])
      };
      return { rows: [clone(this.job)], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.jobs set status = 'completed'")) {
      this.job = {
        ...this.job,
        status: "completed",
        result_json: JSON.parse(String(parameters[0])),
        failure_json: null,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: String(parameters[1])
      };
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.jobs set status = 'failed'")) {
      this.job = {
        ...this.job,
        status: "failed",
        failure_json: JSON.parse(String(parameters[0])),
        result_json: null,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: String(parameters[1])
      };
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.jobs set lease_expires_at")) {
      this.job = {
        ...this.job,
        lease_expires_at: String(parameters[0]),
        updated_at: String(parameters[1])
      };
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("select next_position, previous_digest from mn_v2.tenant_heads")) {
      return {
        rows: [{ next_position: this.position, previous_digest: this.previousDigest }],
        rowCount: 1
      };
    }
    if (normalized.startsWith("select stream_version, value_json from mn_v2.projections")) {
      const value = this.projections.get(`${String(parameters[1])}:${String(parameters[2])}`);
      return value
        ? { rows: [{ stream_version: value.streamVersion, value_json: clone(value) }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith("select stream_version from mn_v2.stream_heads")) {
      const version = this.streams.get(`${String(parameters[1])}:${String(parameters[2])}`) ?? 0;
      return { rows: [{ stream_version: version }], rowCount: 1 };
    }
    if (normalized.startsWith("insert into mn_v2.events")) {
      this.events.push({
        publicPayload: JSON.parse(String(parameters[13])),
        aggregateType: String(parameters[3]),
        aggregateId: String(parameters[4]),
        streamVersion: Number(parameters[5]),
        type: String(parameters[6]),
        digest: String(parameters[16]),
        hmac: String(parameters[17])
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.stream_heads set stream_version")) {
      this.streams.set(`${String(parameters[2])}:${String(parameters[3])}`, Number(parameters[0]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.projections set stream_version")) {
      const key = `${String(parameters[1])}:${String(parameters[2])}`;
      const prior = this.projections.get(key);
      if (!prior || prior.streamVersion !== parameters[6]) return { rows: [], rowCount: 0 };
      this.projections.set(key, JSON.parse(String(parameters[4])) as Record<string, unknown>);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("insert into mn_v2.projections")) {
      this.projections.set(
        `${String(parameters[1])}:${String(parameters[2])}`,
        JSON.parse(String(parameters[4])) as Record<string, unknown>
      );
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update mn_v2.tenant_heads set next_position")) {
      this.position = Number(parameters[0]);
      this.previousDigest = String(parameters[1]);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("insert into mn_v2.outbox")) {
      this.outbox.push({
        id: String(parameters[0]),
        tenantId: String(parameters[1]),
        topic: String(parameters[2])
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("insert into mn_v2.tenant_heads")
      || normalized.startsWith("insert into mn_v2.stream_heads")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }

  async connect() {
    return this;
  }

  release(): void {}
}

function fixtureStorage(client: PostgresLifecycleFixture): PostgresStorage {
  return new PostgresStorage({ pool: client, hmacKey });
}

function projection(
  client: PostgresLifecycleFixture,
  namespace: string,
  id: string
): Record<string, unknown> {
  const value = client.projections.get(`${namespace}:${id}`);
  assert.ok(value);
  return value;
}

test("PostgreSQL schema is isolated in mn_v2 and includes transactional control-plane tables", () => {
  assert.equal(postgresStorageSchema, "mn_v2");
  assert.match(POSTGRES_SCHEMA_SQL, /create schema if not exists mn_v2/i);
  for (const table of [
    "events",
    "tenant_heads",
    "stream_heads",
    "projections",
    "jobs",
    "outbox",
    "approvals",
    "idempotency"
  ]) {
    assert.match(POSTGRES_SCHEMA_SQL, new RegExp(`create table if not exists mn_v2\\.${table}`, "i"));
  }
});

test("PostgreSQL initialization and commit use an explicit transaction and row locks", async () => {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (/select response_json/i.test(sql)) return { rows: [] };
      if (/select stream_version/i.test(sql)) return { rows: [] };
      if (/select next_position/i.test(sql)) return { rows: [{ next_position: "1", previous_digest: null }] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const storage = new PostgresStorage({
    hmacKey: Buffer.alloc(32, 7),
    pool: {
      async query(sql: string) { statements.push(sql); return { rows: [] }; },
      async connect() { return client; }
    },
    now: () => new Date("2026-09-04T00:00:00.000Z")
  });
  await storage.initialize();
  await storage.commit({
    event: {
      tenantId: "tenant-a",
      aggregateType: "workspace",
      aggregateId: "workspace-1",
      expectedStreamVersion: 0,
      type: "workspace.created",
      actorId: "local-owner",
      generation: 1,
      correlationId: "correlation-1",
      publicPayload: {}
    }
  });

  assert.ok(statements.some((sql) => /^begin$/i.test(sql.trim())));
  assert.ok(statements.some((sql) => /for update/i.test(sql)));
  assert.ok(statements.some((sql) => /^commit$/i.test(sql.trim())));
});

test("PostgreSQL Agent Job 领取、续租与完成原子推进投影、HMAC 事件和 outbox", async () => {
  const client = new PostgresLifecycleFixture();
  const storage = fixtureStorage(client);

  const claimed = await storage.claimJob("worker-a", startedAt);
  assert.equal(claimed?.status, "leased");
  assert.equal(claimed?.fencingToken, 1);
  assert.equal(projection(client, "job", "job-a").status, "leased");
  assert.equal(projection(client, "job", "job-a").streamVersion, 2);
  assert.equal(projection(client, "execution", "execution-a").status, "running");

  await storage.renewJobLease("job-a", "worker-a", 1, "2025-01-02T03:04:10.000Z");
  assert.equal(
    projection(client, "job", "job-a").leaseExpiresAt,
    "2025-01-02T03:04:40.000Z"
  );

  await storage.completeJob(
    "job-a",
    "worker-a",
    1,
    { answer: "done" },
    "2025-01-02T03:04:11.000Z"
  );
  assert.equal(client.job.status, "completed");
  assert.equal(projection(client, "job", "job-a").status, "completed");
  assert.deepEqual(projection(client, "job", "job-a").result, { answer: "done" });
  assert.equal(projection(client, "execution", "execution-a").status, "completed");
  assert.deepEqual(client.events.map((event) => event.type), [
    "job.leased",
    "execution.running",
    "job.lease_renewed",
    "job.completed",
    "execution.completed"
  ]);
  for (const event of client.events) {
    assert.match(event.digest, /^[a-f0-9]{64}$/u);
    assert.equal(event.hmac, computeEventHmac(event.digest, hmacKey));
    assert.ok(event.publicPayload.projectionFacts, `${event.type} must record reconstructable state`);
  }
  assert.deepEqual(client.outbox.map((message) => message.topic), client.events.map((event) => event.type));
  assert.equal(client.queries.filter(({ sql }) => sql === "commit").length, 3);
});

test("PostgreSQL Agent Job 重领不重复 running，陈旧 fencing token 不能落盘", async () => {
  const client = new PostgresLifecycleFixture();
  const storage = fixtureStorage(client);

  await storage.claimJob("worker-a", startedAt);
  const reclaimed = await storage.claimJob("worker-b", "2025-01-02T03:04:35.000Z");
  assert.equal(reclaimed?.fencingToken, 2);
  assert.equal(projection(client, "job", "job-a").streamVersion, 3);
  assert.equal(projection(client, "execution", "execution-a").streamVersion, 2);
  assert.equal(client.events.filter((event) => event.type === "job.leased").length, 2);
  assert.equal(client.events.filter((event) => event.type === "execution.running").length, 1);

  const before = clone({
    job: client.job,
    events: client.events,
    outbox: client.outbox,
    projections: [...client.projections]
  });
  await assert.rejects(
    storage.failJob(
      "job-a",
      "worker-a",
      1,
      { code: "STALE_WORKER" },
      "2025-01-02T03:04:36.000Z"
    ),
    StaleFencingTokenError
  );
  assert.deepEqual({
    job: client.job,
    events: client.events,
    outbox: client.outbox,
    projections: [...client.projections]
  }, before);

  await storage.failJob(
    "job-a",
    "worker-b",
    2,
    { code: "MODEL_FAILED", message: "模型请求失败" },
    "2025-01-02T03:04:36.000Z"
  );
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.equal(projection(client, "execution", "execution-a").failureCode, "MODEL_FAILED");
  assert.deepEqual(client.events.slice(-2).map((event) => event.type), [
    "job.failed",
    "execution.failed"
  ]);
});

test("PostgreSQL 已取消 Execution 接收 Worker 取消失败时只终结 Agent Job", async () => {
  const client = new PostgresLifecycleFixture();
  const storage = fixtureStorage(client);
  await storage.claimJob("worker-a", startedAt);
  const cancelledExecution = {
    ...projection(client, "execution", "execution-a"),
    status: "cancelled",
    streamVersion: 3,
    finishedAt: "2025-01-02T03:04:06.000Z",
    updatedAt: "2025-01-02T03:04:06.000Z"
  };
  client.projections.set("execution:execution-a", cancelledExecution);
  client.streams.set("execution:execution-a", 3);
  const eventCount = client.events.length;
  const outboxCount = client.outbox.length;

  await assert.rejects(
    storage.failJob(
      "job-a",
      "worker-a",
      1,
      { code: "MODEL_FAILED", message: "模型请求失败" },
      "2025-01-02T03:04:06.500Z"
    ),
    /状态为 cancelled 的 Execution 不能标记为 failed/
  );
  assert.equal(client.job.status, "leased");

  await storage.failJob(
    "job-a",
    "worker-a",
    1,
    { code: "EXECUTION_CANCELLED", message: "执行已取消", retryable: false },
    "2025-01-02T03:04:07.000Z"
  );

  assert.equal(client.job.status, "failed");
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.equal(
    (projection(client, "job", "job-a").failure as { code?: string }).code,
    "EXECUTION_CANCELLED"
  );
  assert.deepEqual(projection(client, "execution", "execution-a"), cancelledExecution);
  assert.equal(client.events.length, eventCount + 1);
  assert.equal(client.events.at(-1)?.type, "job.failed");
  assert.equal(client.outbox.length, outboxCount + 1);
  assert.equal(client.outbox.at(-1)?.topic, "job.failed");
  assert.equal(
    await storage.claimJob("worker-b", "2025-01-02T03:04:35.000Z"),
    undefined
  );
});

test("PostgreSQL 已失败 Execution 接收 Worker 失败时只终结 Agent Job", async () => {
  const client = new PostgresLifecycleFixture();
  const storage = fixtureStorage(client);
  await storage.claimJob("worker-a", startedAt);
  const failedExecution = {
    ...projection(client, "execution", "execution-a"),
    status: "failed",
    failureCode: "TOOL_APPROVAL_DENIED",
    streamVersion: 3,
    finishedAt: "2025-01-02T03:04:06.000Z",
    updatedAt: "2025-01-02T03:04:06.000Z"
  };
  client.projections.set("execution:execution-a", failedExecution);
  client.streams.set("execution:execution-a", 3);
  const eventCount = client.events.length;
  const outboxCount = client.outbox.length;

  await storage.failJob(
    "job-a",
    "worker-a",
    1,
    { code: "TOOL_APPROVAL_DENIED", message: "用户拒绝工具调用", retryable: false },
    "2025-01-02T03:04:07.000Z"
  );

  assert.equal(client.job.status, "failed");
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.deepEqual(projection(client, "execution", "execution-a"), failedExecution);
  assert.equal(client.events.length, eventCount + 1);
  assert.equal(client.events.at(-1)?.type, "job.failed");
  assert.equal(client.outbox.length, outboxCount + 1);
  assert.equal(client.outbox.at(-1)?.topic, "job.failed");
});

test("PostgreSQL claim 原子终结终态 Execution 的 Agent Job 且不再重领", async () => {
  for (const status of ["cancelled", "failed", "completed"] as const) {
    const client = new PostgresLifecycleFixture();
    const storage = fixtureStorage(client);
    const terminalExecution = {
      ...projection(client, "execution", "execution-a"),
      status,
      ...(status === "failed" ? { failureCode: "TOOL_APPROVAL_DENIED" } : {}),
      streamVersion: 2,
      finishedAt: "2025-01-02T03:04:04.000Z",
      updatedAt: "2025-01-02T03:04:04.000Z"
    };
    client.projections.set("execution:execution-a", terminalExecution);
    client.streams.set("execution:execution-a", 2);

    assert.equal(await storage.claimJob("worker-a", startedAt), undefined);
    assert.equal(client.job.status, "failed");
    assert.equal(client.job.attempts, 0);
    assert.equal(client.job.fencing_token, 0);
    assert.deepEqual(client.job.failure_json, status === "cancelled" ? {
      code: "EXECUTION_CANCELLED",
      message: "Execution 已在领取 Job 前取消",
      retryable: false
    } : {
      code: "EXECUTION_ALREADY_TERMINAL",
      message: "Execution 已在领取 Job 前终结",
      retryable: false,
      executionStatus: status
    });
    assert.equal(projection(client, "job", "job-a").status, "failed");
    assert.equal(projection(client, "job", "job-a").attempts, 0);
    assert.equal(projection(client, "job", "job-a").fencingToken, 0);
    assert.deepEqual(projection(client, "execution", "execution-a"), terminalExecution);
    assert.deepEqual(client.events.map((event) => event.type), ["job.failed"]);
    assert.deepEqual(client.outbox.map((message) => message.topic), ["job.failed"]);

    assert.equal(
      await storage.claimJob("worker-b", "2025-01-02T03:05:00.000Z"),
      undefined
    );
    assert.deepEqual(client.events.map((event) => event.type), ["job.failed"]);
  }
});

test("PostgreSQL Agent Job 中断原子推进 failed Job 与 interrupted Execution", async () => {
  const client = new PostgresLifecycleFixture();
  const storage = fixtureStorage(client);
  await storage.claimJob("worker-a", startedAt);

  await assert.rejects(
    storage.interruptJob(
      "job-a",
      "worker-a",
      0,
      "陈旧 Worker 请求中断",
      "2025-01-02T03:04:06.000Z"
    ),
    StaleFencingTokenError
  );
  assert.equal(client.job.status, "leased");

  await storage.interruptJob(
    "job-a",
    "worker-a",
    1,
    "用户取消执行",
    "2025-01-02T03:04:06.000Z"
  );
  assert.equal(client.job.status, "failed");
  assert.deepEqual(client.job.failure_json, {
    code: "EXECUTION_INTERRUPTED",
    message: "用户取消执行",
    retryable: false
  });
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.equal(projection(client, "execution", "execution-a").status, "interrupted");
  assert.deepEqual(client.events.slice(-2).map((event) => event.type), [
    "job.failed",
    "execution.interrupted"
  ]);
  assert.deepEqual(client.outbox.slice(-2).map((message) => message.topic), [
    "job.failed",
    "execution.interrupted"
  ]);
});

test("PostgreSQL 未知副作用原子写入 Job、Execution、Inbox 和核对 outbox", async () => {
  const client = new PostgresLifecycleFixture();
  const storage = fixtureStorage(client);
  await storage.claimJob("worker-a", startedAt);

  await storage.markNeedsReconciliation("execution-a", {
    jobId: "job-a",
    workerId: "worker-a",
    fencingToken: 1,
    occurredAt: "2025-01-02T03:04:06.000Z"
  });
  assert.equal(client.job.status, "failed");
  assert.equal(projection(client, "job", "job-a").status, "failed");
  assert.equal(
    (projection(client, "job", "job-a").failure as { code?: string }).code,
    "UNKNOWN_EXTERNAL_SIDE_EFFECT"
  );
  assert.equal(projection(client, "execution", "execution-a").status, "needs_reconciliation");
  assert.equal(
    projection(client, "inbox", "reconciliation:execution-a:job-a").status,
    "open"
  );
  assert.deepEqual(client.events.slice(-2).map((event) => event.type), [
    "job.failed",
    "execution.needs_reconciliation"
  ]);
  assert.ok(client.outbox.some((message) => message.topic === "execution.reconciliation_required"));
});

for (const kind of ["knowledge.publish", "procurement.submit"]) {
  test(`PostgreSQL ${kind} 未知效果同步终止任务投影`, async () => {
    const client = new PostgresLifecycleFixture({ kind, projectJob: true });
    const storage = fixtureStorage(client);
    const claimed = await storage.claimJob("worker-a", startedAt);
    assert.ok(claimed);
    projection(client, "execution", "execution-a").status = "running";
    await storage.markNeedsReconciliation("execution-a", {
      jobId: claimed.id, workerId: "worker-a", fencingToken: claimed.fencingToken,
      occurredAt: "2025-01-02T03:04:06.000Z",
    });
    assert.equal(client.job.status, "failed");
    assert.equal(projection(client, "job", claimed.id).status, "failed");
    assert.equal(projection(client, "job", claimed.id).leaseOwner, undefined);
    assert.equal(projection(client, "execution", "execution-a").status, "needs_reconciliation");
    assert.ok(client.events.some(event => event.type === "job.failed"));
  });
}

test("PostgreSQL 生命周期版本冲突回滚物理 Job、投影、事件与 outbox", async () => {
  const client = new PostgresLifecycleFixture({ projectedExecutionStreamVersion: 2 });
  const storage = fixtureStorage(client);

  await assert.rejects(storage.claimJob("worker-a", startedAt));
  assert.equal(client.job.status, "available");
  assert.equal(projection(client, "job", "job-a").status, "available");
  assert.equal(projection(client, "execution", "execution-a").status, "queued");
  assert.equal(client.events.length, 0);
  assert.equal(client.outbox.length, 0);
  assert.equal(client.queries.at(-1)?.sql, "rollback");
});

test("PostgreSQL 无 Execution 上下文的系统 Job 只推进受 fencing 保护的物理状态", async () => {
  const client = new PostgresLifecycleFixture({ kind: "system.noop" });
  const storage = fixtureStorage(client);

  const claimed = await storage.claimJob("worker-a", startedAt);
  assert.equal(claimed?.fencingToken, 1);
  await storage.completeJob(
    "job-a",
    "worker-a",
    1,
    { accepted: true },
    "2025-01-02T03:04:06.000Z"
  );
  assert.equal(client.job.status, "completed");
  assert.equal(projection(client, "execution", "execution-a").status, "queued");
  assert.equal(client.events.length, 0);
  assert.equal(client.outbox.length, 0);
});

test("PostgreSQL generic Job 在无 Execution 时同步投影、事件和 fencing", async () => {
  const completedClient = new PostgresLifecycleFixture({
    kind: "coding.sandbox.cleanup",
    projectJob: true
  });
  completedClient.projections.delete("execution:execution-a");
  const completedStorage = fixtureStorage(completedClient);

  const claimed = await completedStorage.claimJob("worker-a", startedAt);
  assert.equal(claimed?.fencingToken, 1);
  assert.equal(projection(completedClient, "job", "job-a").status, "leased");
  assert.equal(projection(completedClient, "job", "job-a").streamVersion, 2);
  await completedStorage.renewJobLease(
    "job-a",
    "worker-a",
    1,
    "2025-01-02T03:04:10.000Z"
  );
  assert.equal(
    projection(completedClient, "job", "job-a").leaseExpiresAt,
    "2025-01-02T03:04:40.000Z"
  );
  await completedStorage.completeJob(
    "job-a",
    "worker-a",
    1,
    { cleaned: true },
    "2025-01-02T03:04:11.000Z"
  );
  assert.equal(projection(completedClient, "job", "job-a").status, "completed");
  assert.deepEqual(projection(completedClient, "job", "job-a").result, { cleaned: true });
  assert.deepEqual(completedClient.events.map((event) => event.type), [
    "job.leased",
    "job.lease_renewed",
    "job.completed"
  ]);
  assert.deepEqual(
    completedClient.outbox.map((message) => message.topic),
    completedClient.events.map((event) => event.type)
  );

  const failedClient = new PostgresLifecycleFixture({
    kind: "coding.sandbox.cleanup",
    projectJob: true
  });
  failedClient.projections.delete("execution:execution-a");
  const failedStorage = fixtureStorage(failedClient);
  await failedStorage.claimJob("worker-b", startedAt);
  await failedStorage.failJob(
    "job-a",
    "worker-b",
    1,
    { code: "CLEANUP_FAILED", message: "清理失败" },
    "2025-01-02T03:04:06.000Z"
  );
  assert.equal(projection(failedClient, "job", "job-a").status, "failed");
  assert.deepEqual(projection(failedClient, "job", "job-a").failure, {
    code: "CLEANUP_FAILED",
    message: "清理失败"
  });
  assert.deepEqual(failedClient.events.map((event) => event.type), [
    "job.leased",
    "job.failed"
  ]);
});

test("PostgreSQL generic Job 投影版本冲突时回滚物理租约和事件", async () => {
  const client = new PostgresLifecycleFixture({
    kind: "coding.sandbox.cleanup",
    projectJob: true,
    projectedJobStreamVersion: 2
  });
  client.projections.delete("execution:execution-a");
  const storage = fixtureStorage(client);

  await assert.rejects(storage.claimJob("worker-a", startedAt));
  assert.equal(client.job.status, "available");
  assert.equal(projection(client, "job", "job-a").status, "available");
  assert.equal(projection(client, "job", "job-a").streamVersion, 2);
  assert.equal(client.events.length, 0);
  assert.equal(client.outbox.length, 0);
  assert.equal(client.queries.at(-1)?.sql, "rollback");
});
