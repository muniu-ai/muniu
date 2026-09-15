// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { createPostgresPool } from "./lib/postgres-pool.mjs";

export async function verifyIdleTransactionExpiry(pool) {
  const tenantId = `idle-proof-${randomUUID()}`;
  const client = await pool.connect();
  // Server-side checks remain authoritative when disconnect delivery is delayed.
  client.on("error", () => {});
  const lockAvailable = async () => (await pool.query(
    "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as available", [tenantId],
  )).rows[0].available;
  try {
    const timeout = await client.query("show idle_in_transaction_session_timeout");
    assert.equal(timeout.rows[0].idle_in_transaction_session_timeout, "20s");
    const backendPid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [tenantId]);
    await client.query(`insert into mn_v2.projections (tenant_id,namespace,projection_key,stream_version,value_json,updated_at)
      values ($1,'fixture.idle-rollback','uncommitted',0,'{}'::jsonb,now())`, [tenantId]);
    assert.equal(await lockAvailable(), false);
    const deadline = Date.now() + 25_000;
    let released = false;
    while (Date.now() < deadline && !released) {
      await setTimeout(250);
      released = await lockAvailable();
    }
    assert.equal(released, true, "失联事务必须在 Job 租约到期前释放租户锁");
    const sessions = await pool.query("select 1 from pg_stat_activity where pid=$1", [backendPid]);
    assert.equal(sessions.rowCount, 0, "数据库必须终止失联事务对应的会话");
    const rows = await pool.query("select 1 from mn_v2.projections where tenant_id=$1", [tenantId]);
    assert.equal(rows.rowCount, 0, "超时事务中的未提交写入必须回滚");
    process.stdout.write("PostgreSQL 空闲事务在 20 秒后回滚并释放租户锁\n");
  } finally {
    client.release(true);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.MN_POSTGRES_URL) throw new Error("MN_POSTGRES_URL 未配置");
  const pool = createPostgresPool({ connectionString: process.env.MN_POSTGRES_URL });
  try { await verifyIdleTransactionExpiry(pool); } finally { await pool.end(); }
}
