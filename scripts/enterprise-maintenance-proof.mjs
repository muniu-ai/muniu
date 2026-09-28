// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_PROJECTION_JOURNAL_NAMESPACES } from "@mn/storage";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { S3Cas } from "@mn/storage";
import { appendKernelEvent } from "@mn/kernel";
import { SigV4S3Client } from "./lib/s3-client.mjs";
import { VaultTransitKeyProvider } from "./lib/enterprise-secrets.mjs";
import { PostgresKernelStore } from "./lib/postgres-kernel-store.mjs";
import { maintainPostgres, withOfflineDatabase } from "./lib/postgres-maintenance.mjs";

export async function verifyEnterpriseMaintenance() {
  const database = `mn_maintenance_${randomUUID().replaceAll("-", "")}`;
  const connectionString = "postgresql://mn:mn-e2e-only@127.0.0.1:55432/mn_enterprise";
  const admin = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const prefix = `v2/${database}/`;
  const bucket = "mn-v2-artifacts";
  const s3 = new SigV4S3Client({ endpoint: "http://127.0.0.1:59000", region: "us-east-1",
    accessKeyId: "mn-e2e", secretAccessKey: "mn-e2e-secret-only" });
  const cas = new S3Cas({ bucket, prefix, client: s3 });
  const keyProvider = new VaultTransitKeyProvider({ address: "http://127.0.0.1:58200",
    token: "mn-v2-vault-fixture-only", individuallyRevocable: true });
  const hmacKey = Buffer.alloc(32, 81);
  let created = false;
  await admin.connect();
  try {
    await admin.query(`create database "${database}"`);
    created = true;
    await client.connect();
    const store = new PostgresKernelStore({ hmacKey,
      projectionJournal: { cas, keyProvider, namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES },
      pool: { query: client.query.bind(client), connect: async () => ({ query: client.query.bind(client), release() {} }) } });
    await store.initialize();
    const retained = await cas.put(Buffer.from("historical fixture ciphertext"));
    const orphan = await cas.put(Buffer.from("uncommitted maintenance fixture orphan"));
    for (const tenantId of ["tenant-a", "tenant-b"]) await store.transact(tenantId, tx => {
      tx.putProjection("fixture.product", "one", { ciphertextDigest: retained.digest, original: "fixture record" });
      tx.appendEvent({ tenantId, aggregateType: "fixture", aggregateId: "one", expectedStreamVersion: 0,
        type: "fixture.created", actorId: "fixture-owner", generation: 1, correlationId: "create", publicPayload: {} });
    });
    const input = { client, adminClient: admin, database, offlineConfirmed: true, hmacKey, cas, keyProvider, actorId: "fixture-operator" };
    const other = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    await other.connect();
    try { await assert.rejects(maintainPostgres({ ...input, operation: "verify" }), /其他连接/); }
    finally { await other.end(); }
    await withOfflineDatabase(input, async () => {
      const contender = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
      try { await assert.rejects(contender.connect(), error => error.code === "55000"); }
      finally { await contender.end(); }
    });
    const legacyStore = new PostgresKernelStore({ hmacKey,
      projectionJournal: { cas, keyProvider, namespaces: ["*non-core"] },
      pool: { query: client.query.bind(client), connect: async () => ({ query: client.query.bind(client), release() {} }) } });
    const legacyHistory = new Map();
    const legacyThreads = new Map();
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      const createdAt = new Date().toISOString();
      const thread = { id: "legacy-thread", tenantId, workspaceId: "fixture-workspace",
        subject: `fixture-private-thread-${tenantId}`, pluginId: "fixture", streamVersion: 1, createdAt, updatedAt: createdAt };
      legacyThreads.set(tenantId, thread);
      await legacyStore.transact(tenantId, tx => {
        tx.putProjection("thread", thread.id, thread);
        appendKernelEvent(tx, { tenantId, aggregateType: "thread", aggregateId: thread.id, expectedStreamVersion: 0,
          type: "thread.created", actorId: "fixture-owner", generation: 1, correlationId: "legacy-thread",
          publicPayload: { workspaceId: thread.workspaceId, pluginId: thread.pluginId } });
      });
      const raw = await client.query(`select value_json from mn_v2.projections
        where tenant_id = $1 and namespace = 'thread' and projection_key = 'legacy-thread'`, [tenantId]);
      assert.equal(raw.rows[0].value_json.subject, thread.subject, "旧 0.2 fixture 必须实际含明文核心投影");
      legacyHistory.set(tenantId, (await legacyStore.readEventHistory(tenantId, 0, 1000)).events);
    }
    const upgraded = await maintainPostgres({ ...input, operation: "upgrade-core-protection" });
    assert.equal(upgraded.tenants, 2);
    assert.equal(upgraded.upgradedRecords, 2);
    for (const [tenantId, before] of legacyHistory) {
      const after = (await store.readEventHistory(tenantId, 0, 1000)).events;
      assert.deepEqual(after.slice(0, before.length), before, "升级不能改写任何既有认证事件");
      assert.deepEqual(after.filter(event => event.type === "storage.core_protection_upgraded")
        .map(event => event.publicPayload.protectedRecords), [1], "每个租户仅转换一条旧核心事实");
      const raw = await client.query(`select value_json from mn_v2.projections
        where tenant_id = $1 and namespace = 'thread' and projection_key = 'legacy-thread'`, [tenantId]);
      assert.equal(raw.rows[0].value_json.format, "muniu.projection.reference");
      assert.match(raw.rows[0].value_json.protectedPayloadRef, /^[a-f0-9]{64}$/u);
      assert.equal(raw.rows[0].value_json.subject, undefined);
      assert.deepEqual(await store.transact(tenantId, tx => tx.getProjection("thread", "legacy-thread")), legacyThreads.get(tenantId));
    }
    const repeatedUpgrade = await maintainPostgres({ ...input, operation: "upgrade-core-protection" });
    assert.equal(repeatedUpgrade.tenants, 2);
    assert.equal(repeatedUpgrade.upgradedRecords, 0, "重复维护不能重复转换已经加密的核心事实");
    await client.query("delete from mn_v2.projections");
    assert.equal((await maintainPostgres({ ...input, operation: "verify" })).tenants, 2);
    assert.equal((await client.query("select count(*) from mn_v2.projections")).rows[0].count, "0");
    await maintainPostgres({ ...input, operation: "rebuild" });
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      assert.equal((await store.transact(tenantId, tx => tx.getProjection("fixture.product", "one"))).original, "fixture record");
      assert.deepEqual(await store.transact(tenantId, tx => tx.getProjection("thread", "legacy-thread")), legacyThreads.get(tenantId));
    }
    const gc = await maintainPostgres({ ...input, operation: "gc", retentionDays: 1,
      now: new Date(Date.now() + 3 * 86_400_000) });
    assert.equal(gc.removedObjects, 1);
    assert.equal(await cas.has(orphan.digest), false);
    assert.equal(await cas.has(retained.digest), true);
    await client.query("update mn_v2.events set hmac = 'tampered' where tenant_id = 'tenant-a' and position = 1");
    await assert.rejects(maintainPostgres({ ...input, operation: "gc" }));
    const state = await admin.query("select datallowconn from pg_database where datname = $1", [database]);
    assert.equal(state.rows[0].datallowconn, false, "failed validation must keep the database offline");
    assert.equal(await cas.has(retained.digest), true);
    process.stdout.write("企业离线维护：连接排他、双租户旧核心加密升级与幂等重建、S3 孤儿清理和校验失败保持离线均通过\n");
  } finally {
    await client.end().catch(() => undefined);
    if (created) await admin.query(`drop database "${database}"`);
    await admin.end();
    const objects = await s3.listObjects({ bucket, prefix });
    await s3.deleteObjects({ bucket, keys: objects.map(object => object.key) });
  }
}
