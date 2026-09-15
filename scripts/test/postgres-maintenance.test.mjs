// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { withOfflineDatabase } from "../lib/postgres-maintenance.mjs";

function fixture({ connections = [0, 0], prepared = 0, database = "mn_fixture" } = {}) {
  const commands = [];
  const client = { query: async sql => {
    commands.push(sql);
    if (sql.includes("current_database() as database")) return { rows: [{ database }] };
    if (sql.includes("pg_stat_activity")) return { rows: [{ count: connections.shift() ?? 0 }] };
    if (sql.includes("pg_prepared_xacts")) return { rows: [{ count: prepared }] };
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    if (sql.includes("system_identifier")) return { rows: [{ system_identifier: "123", recovering: false, started: "fixture" }] };
    return { rows: [] };
  } };
  return { commands, client, adminClient: { query: async sql => sql.includes("current_database() as database")
    ? { rows: [{ database: "postgres" }] } : client.query(sql) } };
}

test("offline maintenance verifies the exact database and excludes sessions before and after disabling connections", async () => {
  const { client, adminClient, commands } = fixture();
  assert.equal(await withOfflineDatabase({ client, adminClient, database: "mn_fixture", offlineConfirmed: true }, async () => {
    assert.ok(commands.includes('alter database "mn_fixture" allow_connections false'));
    assert.equal(commands.filter(sql => sql.includes("pg_stat_activity")).length, 2);
    return "verified";
  }), "verified");
  assert.ok(commands.includes('alter database "mn_fixture" allow_connections true'));
});

test("offline maintenance refuses live sessions, prepared transactions, wrong targets, or missing confirmation", async () => {
  for (const options of [{ connections: [1] }, { connections: [0, 1] }, { prepared: 1 }, { database: "wrong" }, {}]) {
    const { client, adminClient, commands } = fixture(options);
    await assert.rejects(withOfflineDatabase({ client, adminClient, database: "mn_fixture", offlineConfirmed: Object.keys(options).length > 0 },
      async () => assert.fail("must not run maintenance")));
    if (commands.includes('alter database "mn_fixture" allow_connections false')) {
      assert.ok(commands.includes('alter database "mn_fixture" allow_connections true'), "a raced session is rejected before maintenance changes");
    }
  }
});

test("failed or interrupted maintenance never reopens an unverified database", async () => {
  const { client, adminClient, commands } = fixture();
  await assert.rejects(withOfflineDatabase({ client, adminClient, database: "mn_fixture", offlineConfirmed: true },
    async () => { throw new Error("validation failed"); }), /validation failed/);
  assert.ok(!commands.includes('alter database "mn_fixture" allow_connections true'));
  assert.ok(commands.some(sql => sql.includes("pg_advisory_unlock")));
});

test("offline maintenance rejects another cluster or a replica before disabling the target", async () => {
  for (const identity of [{ system_identifier: "other", recovering: false, started: "fixture" },
    { system_identifier: "123", recovering: true, started: "fixture" },
    { system_identifier: "123", recovering: false, started: "other-primary" }]) {
    const { client, commands } = fixture();
    const adminClient = { query: async sql => sql.includes("current_database()")
      ? { rows: [{ database: "postgres" }] } : { rows: [identity] } };
    await assert.rejects(withOfflineDatabase({ client, adminClient, database: "mn_fixture", offlineConfirmed: true },
      async () => assert.fail("must not run")), /同一 PostgreSQL 主库/);
    assert.ok(!commands.some(sql => sql.startsWith("alter database")));
  }
});
