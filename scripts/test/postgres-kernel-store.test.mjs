// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { computeEventHmac } from "@mn/storage";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PostgresKernelStore } from "../lib/postgres-kernel-store.mjs";

class FixtureClient {
  queries = [];

  async query(sql, parameters = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.queries.push({ sql: normalized, parameters });
    if (normalized.includes("select next_position, previous_digest from mn_v2.tenant_heads")) {
      return { rows: [{ next_position: 1, previous_digest: null }], rowCount: 1 };
    }
    if (normalized.includes("select aggregate_type, aggregate_id, stream_version from mn_v2.stream_heads")) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes("select namespace, projection_key, value_json from mn_v2.projections")) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes("select idempotency_key, request_hash, response_json, created_at")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  }

  release() {}
}

for (const kind of ["business.action.execute", "business.candidate.extract", "agent.execution.run"]) {
  test(`PostgreSQL 原子结算只为 agent job 管理执行终态：${kind}`, async () => {
    const client = new FixtureClient();
    const original = client.query.bind(client);
    const time = "2026-09-18T00:00:00.000Z";
    const execution = { id: "execution", tenantId: "tenant", workspaceId: "workspace", generation: 1,
      status: kind === "agent.execution.run" ? "running" : "completed", streamVersion: 2 };
    const job = { id: "job", tenantId: "tenant", workspaceId: "workspace", kind, status: "leased", payload: { executionId: "execution" },
      leaseOwner: "worker", leaseExpiresAt: "2026-09-18T00:01:00.000Z", fencingToken: 1, streamVersion: 1 };
    client.query = async (sql, args) => {
      const result = await original(sql, args);
      if (sql.includes("select aggregate_type, aggregate_id")) return { rows: [
        { aggregate_type: "job", aggregate_id: "job", stream_version: 1 }, { aggregate_type: "execution", aggregate_id: "execution", stream_version: 2 }] };
      if (sql.includes("select namespace, projection_key")) return { rows: [
        { namespace: "execution", projection_key: "execution", value_json: execution }, { namespace: "job", projection_key: "job", value_json: job }] };
      if (sql.includes("select job_id, status, lease_owner")) return { rows: [
        { job_id: "job", status: "leased", lease_owner: "worker", lease_expires_at: job.leaseExpiresAt, fencing_token: 1 }] };
      return result;
    };
    const store = new PostgresKernelStore({ pool: { query: client.query.bind(client), connect: async () => client }, hmacKey: Buffer.alloc(32, 7), now: () => time });
    await store.transact("tenant", tx => {
      assert.equal(tx.settleJob({ jobId: "job", workerId: "worker", fencingToken: 1, occurredAt: time, outcome: "completed", value: {} }).settled, true);
      assert.equal(tx.getProjection("execution", "execution").status, "completed");
      assert.equal(tx.getProjection("execution", "execution").streamVersion, kind === "agent.execution.run" ? 3 : 2);
    });
    assert.equal(client.queries.at(-1).sql, "commit");
  });
}

test("PostgreSQL rebuild authenticates ciphertext and atomically replaces encrypted references", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-pg-rebuild-"));
  const hmacKey = Buffer.alloc(32, 21);
  const projectionJournal = { cas: new FileCas({ rootDir: join(root, "cas") }),
    keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 20)), namespaces: ["fixture"] };
  const source = new SqliteStorage({ databaseFile: join(root, "source.sqlite"), hmacKey, projectionJournal });
  try {
    await source.transact("a", tx => {
      tx.putProjection("fixture", "one", { content: "private replay", streamVersion: 1 });
      tx.putIdempotency({ tenantId: "a", scope: "fixture", key: "one", requestDigest: "request",
        response: { content: "private replay" }, createdAt: new Date().toISOString() });
      tx.appendEvent({ tenantId: "a", aggregateType: "fixture", aggregateId: "one", expectedStreamVersion: 0,
        type: "fixture.created", actorId: "owner", generation: 0, correlationId: "create", publicPayload: {} });
    });
    const events = (await source.readEvents("a", 0, 100)).events;
    const rows = events.map(event => ({ tenant_id: event.tenantId, position: event.position, event_id: event.id,
      aggregate_type: event.aggregateType, aggregate_id: event.aggregateId, stream_version: event.streamVersion,
      event_type: event.type, occurred_at: event.occurredAt, actor_id: event.actorId, execution_id: event.executionId ?? null,
      generation: event.generation, causation_id: event.causationId ?? null, correlation_id: event.correlationId,
      public_payload: event.publicPayload, protected_payload_ref: event.protectedPayloadRef ?? null,
      previous_digest: event.previousDigest ?? null, digest: event.digest, hmac: event.hmac }));
    const client = new FixtureClient();
    const query = client.query.bind(client);
    client.query = async (sql, args) => {
      await query(sql, args);
      if (sql.includes("select next_position")) return { rows: [{ next_position: events.length + 1, retention_floor: 2 }] };
      if (sql.includes("select * from mn_v2.events")) return { rows };
      if (sql.includes("select distinct namespace")) return { rows: [{ namespace: "fixture" }] };
      return { rows: [] };
    };
    const store = new PostgresKernelStore({ pool: { query: client.query, connect: async () => client }, hmacKey, projectionJournal });
    assert.equal(typeof store.rebuildJournalProjections, "function");
    assert.equal(typeof store.readEventHistory, "function");
    await assert.rejects(store.readEvents("a", 0, 100), error => error.code === "EVENT_CURSOR_EXPIRED");
    assert.deepEqual((await store.readEventHistory("a", 0, 100)).events.map(event => event.id), events.map(event => event.id));
    assert.equal((await store.rebuildJournalProjections("a")).count, 1);
    assert.equal(client.queries.at(-1).sql, "commit");
    assert.equal(JSON.stringify(client.queries).includes("private replay"), false);
    const receiptInsert = client.queries.find(query => query.sql.startsWith("insert into mn_v2.idempotency"));
    assert.equal(receiptInsert.parameters[1], `kernel:${Buffer.from(JSON.stringify(["fixture", "one"])).toString("base64url")}`);
    client.queries = [];
    projectionJournal.cas.get = async () => { throw new Error("fixture corrupt ciphertext"); };
    await assert.rejects(store.rebuildJournalProjections("a"), /corrupt ciphertext/);
    assert.equal(client.queries.some(query => query.sql.startsWith("delete from")), false);
    assert.equal(client.queries.at(-1).sql, "rollback");
  } finally { await source.close(); rmSync(root, { recursive: true, force: true }); }
});

test("PostgreSQL commits protected product facts in the same transaction as projections", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-postgres-journal-"));
  const client = new FixtureClient();
  const store = new PostgresKernelStore({ pool: { query: client.query.bind(client), connect: async () => client },
    hmacKey: Buffer.alloc(32, 18), projectionJournal: {
      cas: new FileCas({ rootDir: join(root, "cas") }), keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 19)), namespaces: ["fixture"],
    } });
  try {
    await store.transact("tenant-a", tx => {
      tx.putProjection("fixture", "one", { content: "private original" });
      tx.appendEvent({ tenantId: "tenant-a", aggregateType: "fixture", aggregateId: "one", expectedStreamVersion: 0,
        type: "fixture.captured", actorId: "human", generation: 0, correlationId: "capture", publicPayload: {} });
    });
    const inserts = client.queries.filter(query => query.sql.includes("insert into mn_v2.events"));
    assert.equal(inserts.length, 2, "product write must include a durable protected fact");
    assert.equal(JSON.stringify(inserts).includes("private original"), false);
    assert.equal(client.queries.at(-1).sql, "commit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("read-only Kernel queries do not rewrite tenant or unchanged aggregate heads", async () => {
  const client = new FixtureClient();
  const original = client.query.bind(client);
  client.query = async (sql, parameters) => {
    const response = await original(sql, parameters);
    if (sql.includes("select aggregate_type, aggregate_id, stream_version")) {
      return { rows: [{ aggregate_type: "workspace", aggregate_id: "workspace-a", stream_version: 8 }], rowCount: 1 };
    }
    return response;
  };
  const store = new PostgresKernelStore({
    pool: { query: client.query, connect: async () => client }, hmacKey: Buffer.alloc(32, 7),
  });
  await store.transact("tenant-a", tx => tx.listProjections("approval"));
  assert.equal(client.queries.some(query => /^(?:insert into mn_v2\.stream_heads|update mn_v2\.tenant_heads)/u.test(query.sql)), false);
});

test("PostgreSQL Kernel transaction stages event, projection, Job, outbox, and idempotency atomically", async () => {
  const client = new FixtureClient();
  const pool = { query: client.query.bind(client), connect: async () => client, end: async () => {} };
  const store = new PostgresKernelStore({
    pool,
    hmacKey: Buffer.alloc(32, 7),
    now: () => "2025-01-02T03:04:05.000Z",
  });
  await store.initialize();
  let event;
  const result = await store.transact("tenant-a", async (transaction) => {
    await new Promise((resolve) => setImmediate(resolve));
    event = transaction.appendEvent({
      tenantId: "tenant-a",
      aggregateType: "thread",
      aggregateId: "thread-a",
      expectedStreamVersion: 0,
      type: "thread.turn_submitted",
      actorId: "owner-a",
      executionId: "execution-a",
      generation: 1,
      correlationId: "correlation-a",
      publicPayload: { workspaceId: "workspace-a" },
    });
    transaction.putProjection("execution", "execution-a", { id: "execution-a", streamVersion: 1 });
    transaction.putJob({
      id: "job-a", tenantId: "tenant-a", workspaceId: "workspace-a",
      kind: "agent.execution.run", payload: { executionId: "execution-a" },
      availableAt: "2025-01-02T03:04:05.000Z", idempotencyKey: "turn-a",
    });
    transaction.putOutbox({
      id: "outbox-a", tenantId: "tenant-a", topic: "job.available",
      payload: { jobId: "job-a" },
    });
    transaction.putIdempotency({
      tenantId: "tenant-a", scope: "thread.turn", key: "turn-a",
      requestDigest: "request", response: { executionId: "execution-a" },
      createdAt: "2025-01-02T03:04:05.000Z",
    });
    return "committed";
  });
  assert.equal(result, "committed");
  assert.equal(event.position, 1);
  assert.equal(event.streamVersion, 1);
  assert.match(event.digest, /^[a-f0-9]{64}$/u);
  assert.match(event.hmac, /^[a-f0-9]{64}$/u);
  assert.equal(event.hmac, computeEventHmac(event.digest, Buffer.alloc(32, 7)));

  const statements = client.queries.map((query) => query.sql);
  for (const table of ["events", "projections", "jobs", "outbox", "idempotency"]) {
    assert.ok(statements.some((sql) => sql.includes(`insert into mn_v2.${table}`)), `${table} must be inserted`);
  }
  assert.equal(statements.at(-1), "commit");
});

test("PostgreSQL Kernel transaction rolls back cross-tenant Job writes", async () => {
  const client = new FixtureClient();
  const pool = { query: client.query.bind(client), connect: async () => client };
  const store = new PostgresKernelStore({ pool, hmacKey: Buffer.alloc(32, 9) });
  await assert.rejects(() => store.transact("tenant-a", (transaction) => {
    transaction.putJob({
      id: "job-a", tenantId: "tenant-b", kind: "system.noop", payload: {},
      availableAt: "2025-01-02T03:04:05.000Z", idempotencyKey: "job-a",
    });
  }), /不能跨租户/u);
  assert.equal(client.queries.at(-1).sql, "rollback");
});

test("PostgreSQL Kernel store lists tenants for plugin lock readiness", async () => {
  const queries = [];
  const pool = {
    async connect() { throw new Error("本测试不应打开事务连接"); },
    async query(sql) {
      queries.push(sql.replace(/\s+/gu, " ").trim());
      return { rows: [{ tenant_id: "tenant-a" }, { tenant_id: "tenant-b" }] };
    },
  };
  const store = new PostgresKernelStore({ pool, hmacKey: Buffer.alloc(32, 11) });
  assert.deepEqual(await store.listTenantIds(), ["tenant-a", "tenant-b"]);
  assert.match(queries[0], /from mn_v2\.tenant_heads union select tenant_id from mn_v2\.events order by tenant_id asc/u);
});

test("PostgreSQL retries only confirmed transaction aborts, never an unknown commit outcome", async () => {
  for (const code of ["40001", "40P01", "ECONNRESET"]) {
    const client = new FixtureClient();
    const original = client.query.bind(client);
    let commits = 0;
    let calls = 0;
    client.query = async (sql, parameters) => {
      if (sql === "commit" && ++commits === 1) throw Object.assign(new Error("fixture database abort"), { code });
      return original(sql, parameters);
    };
    const store = new PostgresKernelStore({ pool: { query: client.query, connect: async () => client }, hmacKey: Buffer.alloc(32, 11) });
    const pending = store.transact("tenant-a", () => { calls++; return "done"; });
    if (code === "ECONNRESET") {
      await assert.rejects(pending, error => error.code === code);
      assert.equal(calls, 1);
    } else {
      assert.equal(await pending, "done");
      assert.equal(calls, 2);
    }
  }
});
