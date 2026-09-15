// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { replayCoreProjections } from "@mn/contracts";
import { collectJournalCasReferences, prepareJournalRebuild } from "@mn/storage";
import { PostgresKernelStore } from "./postgres-kernel-store.mjs";

const lock = "hashtextextended('mn-v2-offline-maintenance', 0)";

/** The operator must stop all processes sharing this database/CAS before entering. */
export async function withOfflineDatabase({ client, adminClient, database, offlineConfirmed }, work) {
  if (offlineConfirmed !== true || !/^[a-z][a-z0-9_]{0,62}$/u.test(database)
    || ["postgres", "template0", "template1"].includes(database)) throw new Error("维护需要确认已停机并指定专用数据库");
  const current = await client.query("select current_database() as database");
  if (current.rows[0]?.database !== database) throw new Error("维护目标与当前数据库不一致");
  const control = await adminClient.query("select current_database() as database");
  if (control.rows[0]?.database === database) throw new Error("维护管理连接必须使用另一个数据库");
  const identityQuery = "select system_identifier, pg_is_in_recovery() as recovering, pg_postmaster_start_time() as started from pg_control_system()";
  const [targetIdentity, controlIdentity] = await Promise.all([client.query(identityQuery), adminClient.query(identityQuery)]);
  const target = targetIdentity.rows[0];
  const management = controlIdentity.rows[0];
  if (!target?.system_identifier || target.recovering !== false || management?.recovering !== false
    || target.system_identifier !== management.system_identifier || String(target.started) !== String(management.started)) {
    throw new Error("维护连接没有指向同一 PostgreSQL 主库");
  }
  const acquired = await client.query(`select pg_try_advisory_lock(${lock}) as acquired`);
  if (acquired.rows[0]?.acquired !== true) throw new Error("已有数据库维护进程");
  const assertExclusive = async () => {
    const sessions = await client.query("select count(*) as count from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()");
    const prepared = await client.query("select count(*) as count from pg_prepared_xacts where database = current_database()");
    if (Number(sessions.rows[0]?.count) !== 0 || Number(prepared.rows[0]?.count) !== 0) {
      throw new Error("数据库仍有其他连接或预备事务；未执行维护");
    }
  };
  let disabled = false;
  let entered = false;
  let completed = false;
  try {
    await assertExclusive();
    await adminClient.query(`alter database "${database}" allow_connections false`);
    disabled = true;
    await assertExclusive();
    entered = true;
    const result = await work();
    completed = true;
    return result;
  } finally {
    try {
      // Once work starts, failure leaves the database offline for explicit recovery.
      if (disabled && (!entered || completed)) await adminClient.query(`alter database "${database}" allow_connections true`);
    } finally { await client.query(`select pg_advisory_unlock(${lock})`).catch(() => undefined); }
  }
}

export async function maintainPostgres({ client, adminClient, database, offlineConfirmed, operation, hmacKey, cas, keyProvider,
  actorId, retentionDays = 7, now = new Date() }) {
  if (!["verify", "rebuild", "gc"].includes(operation) || !actorId?.trim()) throw new Error("维护操作或操作者无效");
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 36500
    || !Number.isFinite(now.getTime())) throw new Error("孤儿对象保留期必须为 1 至 36500 天");
  const journal = { cas, keyProvider, namespaces: ["*non-core"] };
  // Every query uses the already-connected exclusive session; no pool may reconnect during maintenance.
  const pool = { query: client.query.bind(client), connect: async () => ({ query: client.query.bind(client), release() {} }) };
  const store = new PostgresKernelStore({ pool, hmacKey, projectionJournal: journal });
  return withOfflineDatabase({ client, adminClient, database, offlineConfirmed }, async () => {
    const roots = [];
    const referenced = new Set();
    const tenants = await store.listTenantIds();
    if (!tenants.length && operation === "gc") throw new Error("空数据库不能授权清理 CAS；请核对备份与存储范围");
    for (const tenantId of tenants) {
      const head = await client.query("select next_position from mn_v2.tenant_heads where tenant_id = $1", [tenantId]);
      const expectedPosition = Number(head.rows[0]?.next_position) - 1;
      if (!Number.isSafeInteger(expectedPosition) || expectedPosition < 0) throw new Error("租户事件头缺失或无效");
      const events = [];
      for (;;) {
        const page = await store.readEventHistory(tenantId, events.at(-1)?.position ?? 0, 1000);
        events.push(...page.events);
        if (events.length > 1_000_000) throw new Error("单租户事件超过本次维护上限");
        if (page.events.length < 1000) break;
      }
      const input = { ...journal, tenantId, events, expectedPosition, hmacKey };
      replayCoreProjections(events, tenantId, hmacKey);
      await prepareJournalRebuild(input);
      for (const digest of await collectJournalCasReferences(input)) referenced.add(digest);
      roots.push({ tenantId, position: expectedPosition, digest: events.at(-1)?.digest ?? null });
    }
    const runId = randomUUID();
    const rootDigest = createHash("sha256").update(JSON.stringify(roots)).digest("hex");
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const audit = async (type, extra = {}) => {
      for (const tenantId of tenants) await store.transact(tenantId, tx => tx.appendEvent({ tenantId,
        aggregateType: "storageMaintenance", aggregateId: runId, expectedStreamVersion: type.endsWith("requested") ? 0 : 1,
        type, actorId, generation: 0, correlationId: runId,
        publicPayload: { operation, rootDigest, cutoff: cutoff.toISOString(), ...extra } }));
    };
    if (operation !== "verify") await audit("storage.maintenance_requested");
    if (operation === "rebuild") for (const tenantId of tenants) await store.rebuildProjections(tenantId);
    const removed = operation === "gc" ? await cas.gcOrphans(referenced, cutoff) : [];
    if (operation !== "verify") await audit("storage.maintenance_completed", { removedObjects: removed.length });
    return { verified: true, operation, tenants: tenants.length, rootDigest, referencedDigests: referenced.size,
      removedObjects: removed.length, cutoff: cutoff.toISOString() };
  });
}
