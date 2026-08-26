// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmod, mkdtemp, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Pool } from "pg";

import {
  MemoryOpcStore,
  OpcIdempotencyConflictError,
  OpcRevisionConflictError,
  POSTGRES_OPC_MIGRATION_V1,
  PostgresOpcStore,
  SqliteOpcStore
} from "../src/index.js";
import type { OpcAppendInput, OpcAppendStore } from "../src/index.js";

const CREATED_AT = "2026-08-26T00:00:00.000Z";

interface FakePostgresRow {
  tenant_id: string;
  aggregate_id: string;
  revision: number;
  request_id: string;
  value_digest: string;
  previous_digest: string | null;
  digest: string;
  payload: unknown;
  created_at: string;
}

class FakePostgresPool {
  readonly rows = new Map<string, FakePostgresRow[]>();
  readonly requests = new Map<string, {
    request_digest: string;
    aggregate_kind: string;
    aggregate_id: string;
    revision: number;
  }>();
  migrations = 0;
  commits = 0;
  rollbacks = 0;
  private rowSnapshot?: Map<string, FakePostgresRow[]>;
  private requestSnapshot?: Map<string, {
    request_digest: string;
    aggregate_kind: string;
    aggregate_id: string;
    revision: number;
  }>;

  async query(_sql: string): Promise<{ rows: never[] }> {
    this.migrations += 1;
    return { rows: [] };
  }

  async connect() {
    return {
      query: async (sql: string, parameters: readonly unknown[] = []) => this.clientQuery(sql, parameters),
      release: () => undefined
    };
  }

  private async clientQuery(sql: string, parameters: readonly unknown[]) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    if (normalized === "BEGIN") {
      this.rowSnapshot = new Map([...this.rows].map(([key, rows]) => [key, rows.map((row) => ({ ...row }))]));
      this.requestSnapshot = new Map([...this.requests].map(([key, value]) => [key, { ...value }]));
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT set_config") || normalized.startsWith("SELECT pg_advisory")) {
      return { rows: [] };
    }
    if (normalized === "COMMIT") {
      this.commits += 1;
      this.rowSnapshot = undefined;
      this.requestSnapshot = undefined;
      return { rows: [] };
    }
    if (normalized === "ROLLBACK") {
      this.rollbacks += 1;
      if (this.rowSnapshot !== undefined && this.requestSnapshot !== undefined) {
        this.rows.clear();
        this.requests.clear();
        for (const [key, rows] of this.rowSnapshot) this.rows.set(key, rows);
        for (const [key, value] of this.requestSnapshot) this.requests.set(key, value);
      }
      this.rowSnapshot = undefined;
      this.requestSnapshot = undefined;
      return { rows: [] };
    }
    if (normalized.includes("FROM opc_idempotency_requests")) {
      const key = JSON.stringify([parameters[0], parameters[1]]);
      const request = this.requests.get(key);
      return { rows: request === undefined ? [] : [request] };
    }
    if (normalized.startsWith("INSERT INTO opc_idempotency_requests")) {
      this.requests.set(JSON.stringify([parameters[0], parameters[1]]), {
        request_digest: String(parameters[2]),
        aggregate_kind: String(parameters[3]),
        aggregate_id: String(parameters[4]),
        revision: Number(parameters[5])
      });
      return { rows: [] };
    }
    const table = /(?:FROM|INSERT INTO) ([a-z_]+)/u.exec(normalized)?.[1];
    if (table === undefined) throw new Error(`unsupported fake PostgreSQL statement: ${normalized}`);
    if (normalized.startsWith("INSERT INTO")) {
      const rows = this.rows.get(table) ?? [];
      rows.push({
        tenant_id: String(parameters[0]),
        aggregate_id: String(parameters[1]),
        revision: Number(parameters[2]),
        request_id: String(parameters[3]),
        value_digest: String(parameters[4]),
        previous_digest: parameters[5] === null ? null : String(parameters[5]),
        digest: String(parameters[6]),
        payload: JSON.parse(String(parameters[7])) as unknown,
        created_at: String(parameters[8])
      });
      this.rows.set(table, rows);
      return { rows: [] };
    }
    const tenantId = String(parameters[0]);
    let rows = (this.rows.get(table) ?? []).filter((row) => row.tenant_id === tenantId);
    if (normalized.includes("aggregate_id = $2")) {
      rows = rows.filter((row) => row.aggregate_id === String(parameters[1]));
    }
    if (normalized.includes("revision = $3")) {
      rows = rows.filter((row) => row.revision === Number(parameters[2]));
    }
    if (normalized.includes("DISTINCT ON")) {
      const latest = new Map<string, FakePostgresRow>();
      for (const row of rows) {
        const current = latest.get(row.aggregate_id);
        if (current === undefined || row.revision > current.revision) latest.set(row.aggregate_id, row);
      }
      rows = [...latest.values()];
    } else if (normalized.includes("ORDER BY revision DESC LIMIT 1")) {
      rows = rows.sort((left, right) => right.revision - left.revision).slice(0, 1);
    } else {
      rows = rows.sort((left, right) => left.revision - right.revision);
    }
    return { rows };
  }
}

async function exerciseAppendOnlyStore(store: OpcAppendStore): Promise<void> {
  const first = await store.append({
    tenantId: "tenant-a",
    kind: "record",
    id: "customer-1",
    expectedRevision: 0,
    requestId: "request-1",
    value: { status: "proposed", name: "Example" },
    createdAt: CREATED_AT
  });
  assert.equal(first.revision, 1);
  assert.equal(first.previousDigest, undefined);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.value), true);

  const replay = await store.append({
    tenantId: "tenant-a",
    kind: "record",
    id: "customer-1",
    expectedRevision: 0,
    requestId: "request-1",
    value: { name: "Example", status: "proposed" },
    createdAt: CREATED_AT
  });
  assert.deepEqual(replay, first);

  await assert.rejects(() => store.append({
    tenantId: "tenant-a",
    kind: "record",
    id: "customer-1",
    expectedRevision: 0,
    requestId: "request-1",
    value: { status: "verified", name: "Changed" },
    createdAt: CREATED_AT
  }), OpcIdempotencyConflictError);

  await assert.rejects(() => store.append({
    tenantId: "tenant-a",
    kind: "record",
    id: "customer-1",
    expectedRevision: 0,
    requestId: "request-2",
    value: { status: "verified" },
    createdAt: "2026-08-26T01:00:00.000Z"
  }), OpcRevisionConflictError);

  const second = await store.append({
    tenantId: "tenant-a",
    kind: "record",
    id: "customer-1",
    expectedRevision: 1,
    requestId: "request-2",
    value: { status: "verified", name: "Example" },
    createdAt: "2026-08-26T01:00:00.000Z"
  });
  assert.equal(second.revision, 2);
  assert.equal(second.previousDigest, first.digest);

  await store.append({
    tenantId: "tenant-b",
    kind: "record",
    id: "customer-1",
    expectedRevision: 0,
    requestId: "request-1",
    value: { status: "proposed", name: "Other tenant" },
    createdAt: CREATED_AT
  });
  assert.equal((await store.read("tenant-a", "record", "customer-1"))?.revision, 2);
  assert.equal((await store.read("tenant-b", "record", "customer-1"))?.revision, 1);
  assert.equal((await store.list("tenant-a", "record")).length, 1);
  assert.equal((await store.history("tenant-a", "record", "customer-1")).length, 2);
  await assert.rejects(
    () => store.read("tenant-a", "unsupported" as never, "customer-1"),
    /supported OPC aggregate/u
  );
}

async function exerciseAtomicBatch(store: OpcAppendStore): Promise<void> {
  const inputs: OpcAppendInput[] = [
    {
      tenantId: "tenant-batch", kind: "record" as const, id: "visit-1", expectedRevision: 0,
      requestId: "batch-record", value: { state: "writeback_pending" }, createdAt: CREATED_AT
    },
    {
      tenantId: "tenant-batch", kind: "action_intent" as const, id: "action-1", expectedRevision: 0,
      requestId: "batch-action", value: { status: "waiting_approval" }, createdAt: CREATED_AT
    },
    {
      tenantId: "tenant-batch", kind: "attention_item" as const, id: "attention-1", expectedRevision: 0,
      requestId: "batch-attention", value: { status: "pending" }, createdAt: CREATED_AT
    }
  ];
  const written = await store.appendBatch(inputs);
  assert.deepEqual(written.map((entry) => entry.kind), ["record", "action_intent", "attention_item"]);
  assert.deepEqual(await store.appendBatch(inputs), written);

  await assert.rejects(() => store.appendBatch([
    {
      tenantId: "tenant-batch", kind: "record", id: "must-not-exist", expectedRevision: 0,
      requestId: "batch-rollback-first", value: { state: "draft" }, createdAt: CREATED_AT
    },
    {
      tenantId: "tenant-batch", kind: "record", id: "visit-1", expectedRevision: 0,
      requestId: "batch-rollback-conflict", value: { state: "invalid" }, createdAt: CREATED_AT
    }
  ]), OpcRevisionConflictError);
  assert.equal(await store.read("tenant-batch", "record", "must-not-exist"), undefined);

  await assert.rejects(() => store.appendBatch([
    inputs[0]!,
    { ...inputs[1]!, tenantId: "another-tenant" }
  ]), /one tenant/u);
}

test("memory OPC store enforces append-only CAS, idempotency, and tenant scope", async () => {
  const store = new MemoryOpcStore();
  await exerciseAppendOnlyStore(store);
  await exerciseAtomicBatch(store);
  await store.close();
});

test("SQLite OPC store survives restart without weakening tenant scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-opc-store-"));
  await chmod(root, 0o755);
  const file = path.join(root, "opc.sqlite");
  const first = new SqliteOpcStore(file);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await exerciseAppendOnlyStore(first);
  await exerciseAtomicBatch(first);
  await first.close();
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const reopened = new SqliteOpcStore(file);
  assert.equal((await reopened.read("tenant-a", "record", "customer-1"))?.revision, 2);
  assert.equal((await reopened.read("tenant-b", "record", "customer-1"))?.revision, 1);
  await reopened.close();

  const linked = path.join(root, "linked.sqlite");
  await symlink(file, linked);
  assert.throws(() => new SqliteOpcStore(linked));
});

test("PostgreSQL migration creates tenant-keyed append tables with forced RLS", () => {
  const tables = [
    "domain_record_revisions",
    "operation_runs",
    "operation_events",
    "attention_items",
    "action_intents",
    "authority_decisions",
    "effect_receipts",
    "settlement_records",
    "publication_outbox",
    "publication_receipts",
    "business_pack_bindings"
  ];
  for (const table of tables) {
    assert.match(POSTGRES_OPC_MIGRATION_V1, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"));
    assert.match(POSTGRES_OPC_MIGRATION_V1, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, "u"));
    assert.match(POSTGRES_OPC_MIGRATION_V1, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, "u"));
    assert.match(POSTGRES_OPC_MIGRATION_V1, new RegExp(`ON ${table} \\(tenant_id, created_at`, "u"));
  }
  assert.match(POSTGRES_OPC_MIGRATION_V1, /PRIMARY KEY \(tenant_id, aggregate_id, revision\)/u);
  assert.match(POSTGRES_OPC_MIGRATION_V1, /current_setting\('mn\.tenant_id', true\)/u);
});

test("PostgreSQL OPC store uses tenant transactions for CAS and idempotent replay", async () => {
  const pool = new FakePostgresPool();
  const store = new PostgresOpcStore(pool as unknown as Pool);
  await store.migrate();
  await exerciseAppendOnlyStore(store);
  await exerciseAtomicBatch(store);
  assert.equal(pool.migrations, 1);
  assert.ok(pool.commits > 0);
  assert.ok(pool.rollbacks >= 2);
  await store.close();
});
