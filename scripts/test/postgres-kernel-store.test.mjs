// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

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
