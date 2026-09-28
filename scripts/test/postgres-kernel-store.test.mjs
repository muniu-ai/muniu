// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { computeEventHmac, DEFAULT_PROJECTION_JOURNAL_NAMESPACES, replayProjectionJournal, readJournalProjection } from "@mn/storage";
import { createProjectionFacts } from "@mn/contracts";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PostgresKernelStore } from "../lib/postgres-kernel-store.mjs";
import { configureKindModelConnection } from "../lib/kind-model-fixture.mjs";

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

test("Kind model fixture commits saved and probed events with a replayable protected model connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-kind-model-fixture-"));
  const client = new FixtureClient();
  const hmacKey = Buffer.alloc(32, 41);
  const projectionJournal = { cas: new FileCas({ rootDir: join(root, "cas") }),
    keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 42)), namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES };
  const store = new PostgresKernelStore({ pool: { query: client.query.bind(client), connect: async () => client },
    hmacKey, projectionJournal });
  try {
    const connection = await store.transact("kind-tenant", tx => configureKindModelConnection(tx, "kind-tenant"));
    const events = client.queries.filter(query => query.sql.startsWith("insert into mn_v2.events")).map(({ parameters: p }) => ({
      schemaVersion: 1, tenantId: p[0], position: p[1], id: p[2], aggregateType: p[3], aggregateId: p[4],
      streamVersion: p[5], type: p[6], occurredAt: p[7], actorId: p[8], ...(p[9] ? { executionId: p[9] } : {}),
      generation: p[10], ...(p[11] ? { causationId: p[11] } : {}), correlationId: p[12], publicPayload: JSON.parse(p[13]),
      ...(p[14] ? { protectedPayloadRef: p[14] } : {}), ...(p[15] ? { previousDigest: p[15] } : {}), digest: p[16], hmac: p[17],
    }));
    assert.deepEqual(events.map(event => event.type), ["model_connection.saved", "model_connection.probed", "projection.fact_committed"]);
    const [saved, probed, fact] = events;
    assert.deepEqual([saved.streamVersion, probed.streamVersion, connection.streamVersion], [1, 2, 2]);
    assert.equal(saved.aggregateId, connection.id);
    assert.equal(probed.aggregateId, connection.id);
    assert.equal(saved.publicPayload.presetId, connection.presetId);
    assert.equal(probed.publicPayload.defaultModel, connection.defaultModel);
    assert.equal(probed.publicPayload.modelCount, connection.discoveredModels.length);
    assert.equal(fact.causationId, probed.id);
    assert.equal(fact.publicPayload.namespace, "modelConnection");
    assert.equal(fact.publicPayload.resourceId, connection.id);
    assert.equal(connection.status, "ready");
    assert.equal(JSON.stringify(client.queries).includes(connection.secretRef), false);
    const facts = await replayProjectionJournal({ ...projectionJournal, tenantId: "kind-tenant", hmacKey, events });
    assert.deepEqual(facts.find(value => value.namespace === "modelConnection" && value.id === connection.id)?.value, connection);
    assert.equal(client.queries.at(-1).sql, "commit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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


test("PostgreSQL core protection startup accepts empty state and rejects plaintext with an actionable code", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-pg-core-startup-"));
  const options = { cas: new FileCas({ rootDir: join(root, "cas") }),
    keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 32)), namespaces: ["thread"] };
  let rows = [];
  const queries = [];
  const pool = { async connect() { throw new Error("startup validation is read only"); }, async query(sql) {
    queries.push(sql);
    assert.match(sql, /^select (?:namespace, projection_key, value_json|response_json)/u);
    return { rows: sql.includes("idempotency") ? [] : rows };
  } };
  const store = new PostgresKernelStore({ pool, hmacKey: Buffer.alloc(32, 33), projectionJournal: options });
  try {
    await store.validateProjectionJournal();
    const privateText = "startup-private-thread-433";
    rows = [{ namespace: "thread", projection_key: "one", value_json: { id: "one", subject: privateText } }];
    await assert.rejects(store.validateProjectionJournal(), error => {
      assert.equal(error.code, "PROTECTED_CORE_STATE_UPGRADE_REQUIRED");
      assert.match(error.remediation, /保留/u);
      assert.equal(String(error).includes(privateText), false);
      return true;
    });
    assert.equal(rows[0].value_json.subject, privateText);
    assert.equal(queries.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PostgreSQL 显式核心加密升级验证旧事件并在单一事务提交新事实", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-pg-core-upgrade-"));
  const hmacKey = Buffer.alloc(32, 77);
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 78));
  const source = new SqliteStorage({ databaseFile: join(root, "source.sqlite"), hmacKey });
  try {
    const value = { tenantId: "a", id: "workspace", name: "protected-old-workspace", streamVersion: 1 };
    await source.transact("a", tx => {
      tx.putProjection("workspace", "workspace", value);
      tx.appendEvent({ tenantId: "a", aggregateType: "workspace", aggregateId: "workspace", expectedStreamVersion: 0,
        type: "workspace.created", actorId: "owner", generation: 0, correlationId: "old",
        publicPayload: { projectionFacts: createProjectionFacts([{ namespace: "workspace", id: "workspace", value }]) } });
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
      if (sql.includes("select next_position")) return { rows: [{ next_position: events.length + 1, previous_digest: events.at(-1).digest }] };
      if (sql.includes("select * from mn_v2.events")) return { rows };
      return { rows: [], rowCount: 1 };
    };
    const projectionJournal = { cas, keyProvider, namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES };
    const store = new PostgresKernelStore({ pool: { query: client.query.bind(client), connect: async () => client }, hmacKey, projectionJournal });
    assert.equal(typeof store.upgradeCoreProjectionProtection, "function");
    const result = await store.upgradeCoreProjectionProtection("a", { actorId: "maintainer", expectedPosition: events.length });
    assert.equal(result.upgradedRecords, 1);
    assert.equal(result.fromPosition, 1);
    assert.equal(result.position, 3);
    assert.equal(client.queries[0].sql, "begin isolation level serializable");
    assert.equal(client.queries.at(-1).sql, "commit");
    const inserts = client.queries.filter(item => item.sql.startsWith("insert into mn_v2.events"));
    assert.equal(inserts.length, 2);
    assert.equal(JSON.stringify(client.queries).includes(value.name), false);
    assert.equal(client.queries.some(item => /update mn_v2\.(?:jobs|reconciliations)/u.test(item.sql)), false);
    const event = p => ({ schemaVersion: 1, tenantId: p[0], position: p[1], id: p[2], aggregateType: p[3], aggregateId: p[4],
      streamVersion: p[5], type: p[6], occurredAt: p[7], actorId: p[8], ...(p[9] ? { executionId: p[9] } : {}),
      generation: p[10], ...(p[11] ? { causationId: p[11] } : {}), correlationId: p[12], publicPayload: JSON.parse(p[13]),
      ...(p[14] ? { protectedPayloadRef: p[14] } : {}), ...(p[15] ? { previousDigest: p[15] } : {}), digest: p[16], hmac: p[17] });
    const facts = await replayProjectionJournal({ ...projectionJournal, tenantId: "a", hmacKey,
      events: [...events, ...inserts.map(item => event(item.parameters))] });
    assert.deepEqual(facts.find(fact => fact.namespace === "workspace").value, value);
    client.queries = [];
    await assert.rejects(store.upgradeCoreProjectionProtection("a", { actorId: "maintainer", expectedPosition: 0 }), /position/iu);
    assert.equal(client.queries.at(-1).sql, "rollback");
    assert.equal(client.queries.some(item => item.sql.startsWith("insert into")), false);
  } finally { await source.close(); rmSync(root, { recursive: true, force: true }); }
});


for (const withEvidence of [false, true]) {
  test(`PostgreSQL 旧明文幂等缓存${withEvidence ? "从认证事实恢复" : "无事实时阻断升级"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mn-pg-idempotency-upgrade-"));
    const hmacKey = Buffer.alloc(32, 80);
    const options = { cas: new FileCas({ rootDir: join(root, "cas") }),
      keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 81)), namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES };
    const source = new SqliteStorage({ databaseFile: join(root, "source.sqlite"), hmacKey,
      projectionJournal: { ...options, namespaces: ["*non-core"] } });
    try {
      const receipt = { tenantId: "tenant", scope: "capture", key: "old", requestDigest: "request",
        response: { private: "authenticated-private-response" }, createdAt: new Date().toISOString() };
      if (withEvidence) await source.transact("tenant", tx => {
        tx.putIdempotency(receipt);
        tx.appendEvent({ tenantId: "tenant", aggregateType: "fixture", aggregateId: "one", expectedStreamVersion: 0,
          type: "fixture.recorded", actorId: "owner", generation: 0, correlationId: "one", publicPayload: {} });
      });
      const events = (await source.readEvents("tenant", 0, 100)).events;
      const rows = events.map(event => ({ tenant_id: event.tenantId, position: event.position, event_id: event.id,
        aggregate_type: event.aggregateType, aggregate_id: event.aggregateId, stream_version: event.streamVersion,
        event_type: event.type, occurred_at: event.occurredAt, actor_id: event.actorId, execution_id: event.executionId ?? null,
        generation: event.generation, causation_id: event.causationId ?? null, correlation_id: event.correlationId,
        public_payload: event.publicPayload, protected_payload_ref: event.protectedPayloadRef ?? null,
        previous_digest: event.previousDigest ?? null, digest: event.digest, hmac: event.hmac }));
      let cache = { idempotency_key: `kernel:${Buffer.from(JSON.stringify([receipt.scope, receipt.key])).toString("base64url")}`,
        request_hash: "untrusted-hash", response_json: { private: "untrusted-plaintext-cache" }, created_at: receipt.createdAt };
      const queries = [];
      const client = { release() {}, async query(sql, parameters = []) {
        const normalized = sql.replace(/\s+/gu, " ").trim(); queries.push({ sql: normalized, parameters });
        if (sql.includes("select next_position")) return { rows: [{ next_position: events.length + 1, previous_digest: events.at(-1)?.digest ?? null }] };
        if (sql.includes("select * from mn_v2.events")) return { rows };
        if (normalized.startsWith("select") && sql.includes("mn_v2.idempotency")) return { rows: [cache] };
        if (normalized.startsWith("insert into mn_v2.idempotency")) cache = { ...cache, request_hash: parameters[2], response_json: JSON.parse(parameters[3]) };
        return { rows: [], rowCount: 1 };
      } };
      const store = new PostgresKernelStore({ pool: { query: client.query, connect: async () => client }, hmacKey, projectionJournal: options });
      await assert.rejects(store.validateProjectionJournal(), { code: "IDEMPOTENCY_PROTECTION_EVIDENCE_REQUIRED" });
      const before = structuredClone(cache);
      const upgrade = store.upgradeCoreProjectionProtection("tenant", { actorId: "operator", expectedPosition: events.length });
      if (withEvidence) {
        assert.equal((await upgrade).alreadyCurrent, true);
        await store.validateProjectionJournal();
        assert.equal(cache.request_hash, receipt.requestDigest);
        assert.deepEqual((await readJournalProjection(options, "tenant", "kernel.protected-idempotency",
          JSON.stringify([receipt.scope, receipt.key]), cache.response_json)).response, receipt.response);
      } else {
        await assert.rejects(upgrade, { code: "IDEMPOTENCY_PROTECTION_EVIDENCE_REQUIRED" });
        assert.deepEqual(cache, before);
        assert.equal(queries.at(-1).sql, "rollback");
        assert.equal(queries.some(query => /^(?:insert|update|delete)/u.test(query.sql)), false);
      }
      assert.equal(queries.some(query => query.sql.startsWith("insert into mn_v2.events")), false);
    } finally { await source.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
