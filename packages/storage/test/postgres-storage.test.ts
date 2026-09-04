// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  POSTGRES_SCHEMA_SQL,
  PostgresStorage,
  postgresStorageSchema
} from "../src/index.js";

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
