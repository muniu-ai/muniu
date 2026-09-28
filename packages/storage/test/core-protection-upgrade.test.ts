// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createProjectionFacts } from "@mn/contracts";
import { acquireLocalStateLock, DEFAULT_PROJECTION_JOURNAL_NAMESPACES, FileCas, InMemoryKeyProvider,
  SqliteStorage, type LocalStateLock } from "../src/index.js";

const tenantId = "upgrade-tenant";
const marker = "old-current-version-private-workspace";
const now = "2026-09-28T00:00:00.000Z";
interface UpgradeStore {
  upgradeCoreProjectionProtection(tenant: string, input: { actorId: string; expectedPosition: number; lock: LocalStateLock }): Promise<{
    tenantId: string; fromPosition: number; position: number; upgradedRecords: number; alreadyCurrent: boolean;
  }>;
}

async function fixture(t: TestContext, deleted = false) {
  const root = mkdtempSync(join(tmpdir(), "mn-core-upgrade-"));
  const databaseFile = join(root, "state.sqlite");
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 72));
  const hmacKey = Buffer.alloc(32, 71);
  const old = new SqliteStorage({ databaseFile, hmacKey, now: () => new Date(now),
    projectionJournal: { cas, keyProvider, namespaces: ["*non-core"] } });
  const workspace = { id: "workspace", tenantId, name: marker, streamVersion: 1 };
  const execution = { id: "execution", tenantId, workspaceId: "workspace", status: "needs_reconciliation", generation: 3, streamVersion: 1 };
  await old.transact(tenantId, tx => {
    tx.putProjection("workspace", "workspace", workspace);
    tx.putProjection("execution", "execution", execution);
    tx.putProjection("fixture.product", "source", { tenantId, original: marker });
    tx.putIdempotency({ tenantId, scope: "capture", key: "old", requestDigest: "request", response: workspace, createdAt: now });
    tx.appendEvent({ tenantId, aggregateType: "workspace", aggregateId: "workspace", expectedStreamVersion: 0,
      type: "workspace.created", actorId: "owner", generation: 0, correlationId: "old",
      publicPayload: { projectionFacts: createProjectionFacts([
        { namespace: "workspace", id: "workspace", value: workspace },
        { namespace: "execution", id: "execution", value: execution },
      ]) } });
  });
  if (deleted) await old.transact(tenantId, tx => {
    tx.deleteProjection("workspace", "workspace");
    tx.appendEvent({ tenantId, aggregateType: "workspace", aggregateId: "workspace", expectedStreamVersion: 1,
      type: "workspace.deleted", actorId: "owner", generation: 0, correlationId: "delete",
      publicPayload: { projectionFacts: createProjectionFacts([{ namespace: "workspace", id: "workspace", value: null }]) } });
  });
  const before = (await old.readEvents(tenantId, 0, 1000)).events;
  await old.close();
  const store = new SqliteStorage({ databaseFile, hmacKey, now: () => new Date(now),
    projectionJournal: { cas, keyProvider, namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES } });
  const lock = await acquireLocalStateLock(root);
  const raw = new DatabaseSync(databaseFile);
  t.after(async () => { raw.close(); await store.close(); lock.release(); rmSync(root, { recursive: true, force: true }); });
  const upgrade = (expectedPosition = before.at(-1)!.position, ownerLock = lock) =>
    (store as unknown as UpgradeStore).upgradeCoreProjectionProtection(tenantId, { actorId: "operator", expectedPosition, lock: ownerLock });
  return { store, raw, cas, keyProvider, before, workspace, execution, lock, upgrade };
}

test("显式升级加密当前核心事实，保留历史与未知执行并可幂等重建", async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.validateProjectionJournal(), { code: "PROTECTED_CORE_STATE_UPGRADE_REQUIRED" });
  const upgraded = await f.upgrade();
  assert.equal(upgraded.upgradedRecords, 1);
  assert.equal(upgraded.alreadyCurrent, false);
  await f.store.validateProjectionJournal();
  const events = (await f.store.readEvents(tenantId, 0, 1000)).events;
  assert.deepEqual(events.slice(0, f.before.length), f.before);
  assert.equal(JSON.stringify(events.slice(f.before.length)).includes(marker), false);
  assert.equal(JSON.stringify(f.raw.prepare("select * from projections").all()).includes(marker), false);
  assert.deepEqual(await f.store.getProjection(tenantId, "workspace", "workspace"), f.workspace);
  assert.deepEqual(await f.store.getProjection(tenantId, "execution", "execution"), f.execution);
  assert.deepEqual(await f.store.transact(tenantId, tx => tx.getIdempotency("capture", "old")!.response), f.workspace);
  f.raw.exec("delete from projections; delete from idempotency");
  await f.store.rebuildProjections(tenantId);
  assert.deepEqual(await f.store.getProjection(tenantId, "workspace", "workspace"), f.workspace);
  assert.deepEqual(await f.store.getProjection(tenantId, "execution", "execution"), f.execution);
  assert.equal(JSON.stringify(f.raw.prepare("select * from projections").all()).includes(marker), false);
  await f.store.rebuildProjections(tenantId);
  assert.deepEqual(await f.upgrade(upgraded.position), { ...upgraded, fromPosition: upgraded.position, upgradedRecords: 0, alreadyCurrent: true });
  assert.equal((await f.store.readEvents(tenantId, 0, 1000)).events.length, events.length);
});

test("升级要求真实独占锁和准确的预期事件位置", async t => {
  const f = await fixture(t);
  await assert.rejects(f.upgrade(f.before.at(-1)!.position, { release() {} }), /LOCAL_STATE_LOCK_REQUIRED/u);
  await assert.rejects(f.upgrade(-1), /position/iu);
  await assert.rejects(f.upgrade(f.before.at(-1)!.position + 1), /position/iu);
  assert.deepEqual((await f.store.readEvents(tenantId, 0, 1000)).events, f.before);
});

test("事件 HMAC 损坏时升级不修改已有行", async t => {
  const f = await fixture(t);
  f.raw.prepare("update events set hmac = ? where tenant_id = ? and position = 1").run("corrupt", tenantId);
  const before = f.raw.prepare("select * from projections").all();
  await assert.rejects(f.upgrade(), /authenticated|integrity/iu);
  assert.deepEqual(f.raw.prepare("select * from projections").all(), before);
  assert.equal(Number((f.raw.prepare("select count(*) as count from events").get() as { count: number }).count), f.before.length);
});

test("既有 CAS 缺失或新密文准备失败时升级整体回滚", async t => {
  const f = await fixture(t);
  const before = f.raw.prepare("select * from projections").all();
  const originalGet = f.cas.get.bind(f.cas);
  f.cas.get = async () => { throw new Error("missing protected object"); };
  await assert.rejects(f.upgrade(), /missing protected object/u);
  f.cas.get = originalGet;
  const originalPut = f.cas.put.bind(f.cas);
  f.cas.put = async () => { throw new Error("ciphertext write unavailable"); };
  await assert.rejects(f.upgrade(), /ciphertext write unavailable/u);
  f.cas.put = originalPut;
  assert.deepEqual(f.raw.prepare("select * from projections").all(), before);
  assert.deepEqual((await f.store.readEvents(tenantId, 0, 1000)).events, f.before);
  assert.equal((await f.upgrade()).upgradedRecords, 1);
});

test("升级读取已认证事实，忽略遭修改的明文查询缓存", async t => {
  const f = await fixture(t);
  f.raw.prepare("update projections set value_json = ? where namespace = 'workspace'")
    .run(JSON.stringify({ ...f.workspace, name: "uncommitted-tampered-cache" }));
  await f.upgrade();
  assert.deepEqual(await f.store.getProjection(tenantId, "workspace", "workspace"), f.workspace);
});

test("追加加密事实失败时源事件和查询替换一起回滚", async t => {
  const f = await fixture(t);
  const before = f.raw.prepare("select * from projections").all();
  f.raw.exec(`create trigger fail_upgrade_fact before insert on events
    when new.event_type = 'projection.fact_committed' begin select raise(abort, 'upgrade fact insert failed'); end`);
  await assert.rejects(f.upgrade(), /upgrade fact insert failed/u);
  assert.deepEqual(f.raw.prepare("select * from projections").all(), before);
  assert.deepEqual((await f.store.readEvents(tenantId, 0, 1000)).events, f.before);
  f.raw.exec("drop trigger fail_upgrade_fact");
  assert.equal((await f.upgrade()).upgradedRecords, 1);
});

test("升级保留删除事实，重建不复活旧核心对象", async t => {
  const f = await fixture(t, true);
  await f.upgrade();
  await f.store.rebuildProjections(tenantId);
  assert.equal(await f.store.getProjection(tenantId, "workspace", "workspace"), undefined);
  assert.deepEqual(await f.store.getProjection(tenantId, "execution", "execution"), f.execution);
});

test("升级后的新写入继续加密，历史明文不覆盖新版本", async t => {
  const f = await fixture(t);
  await f.upgrade();
  const next = { ...f.workspace, name: "new-protected-workspace", streamVersion: 2 };
  await f.store.transact(tenantId, tx => {
    tx.putProjection("workspace", "workspace", next);
    tx.appendEvent({ tenantId, aggregateType: "workspace", aggregateId: "workspace", expectedStreamVersion: 1,
      type: "workspace.renamed", actorId: "owner", generation: 0, correlationId: "new",
      publicPayload: { projectionFacts: createProjectionFacts([{ namespace: "workspace", id: "workspace", value: next }]) } });
  });
  assert.equal(JSON.stringify((await f.store.readEvents(tenantId, 0, 1000)).events).includes(next.name), false);
  f.raw.exec("delete from projections");
  await f.store.rebuildProjections(tenantId);
  assert.deepEqual(await f.store.getProjection(tenantId, "workspace", "workspace"), next);
});


test("没有已认证事实的明文幂等回执阻断升级并保留原承诺", async t => {
  const f = await fixture(t);
  f.raw.prepare("insert into idempotency (tenant_id, idempotency_key, request_hash, response_json, created_at) values (?, ?, ?, ?, ?)")
    .run(tenantId, "unrecorded\0receipt", "original-request", JSON.stringify({ private: marker }), now);
  const before = f.raw.prepare("select * from idempotency").all();
  await assert.rejects(f.upgrade(), { code: "IDEMPOTENCY_PROTECTION_EVIDENCE_REQUIRED" });
  assert.deepEqual(f.raw.prepare("select * from idempotency").all(), before);
  assert.deepEqual((await f.store.readEvents(tenantId, 0, 1000)).events, f.before);
});

test("已认证幂等事实覆盖明文缓存，未认证缓存禁止启动和运行时回退", async t => {
  const f = await fixture(t);
  await f.upgrade();
  f.raw.prepare("update idempotency set response_json = ? where tenant_id = ?")
    .run(JSON.stringify({ private: "untrusted-cache-text" }), tenantId);
  await assert.rejects(f.store.validateProjectionJournal(), { code: "IDEMPOTENCY_PROTECTION_EVIDENCE_REQUIRED" });
  await assert.rejects(f.store.transact(tenantId, tx => tx.getIdempotency("capture", "old")),
    { code: "IDEMPOTENCY_PROTECTION_EVIDENCE_REQUIRED" });
  const current = (await f.store.readEvents(tenantId, 0, 1000)).events.at(-1)!.position;
  await f.upgrade(current);
  await f.store.validateProjectionJournal();
  assert.deepEqual(await f.store.transact(tenantId, tx => tx.getIdempotency("capture", "old")!.response), f.workspace);
  assert.equal(JSON.stringify(f.raw.prepare("select * from idempotency").all()).includes("untrusted-cache-text"), false);
  assert.equal((await f.store.readEvents(tenantId, 0, 1000)).events.at(-1)!.position, current);
});

test("重建不得丢弃缺少事实的幂等承诺", async t => {
  const f = await fixture(t);
  await f.upgrade();
  f.raw.prepare("insert into idempotency (tenant_id, idempotency_key, request_hash, response_json, created_at) values (?, ?, ?, ?, ?)")
    .run(tenantId, "unknown\0request", "request", JSON.stringify({ private: marker }), now);
  const before = f.raw.prepare("select * from idempotency").all();
  await assert.rejects(f.store.rebuildProjections(tenantId), { code: "IDEMPOTENCY_PROTECTION_EVIDENCE_REQUIRED" });
  assert.deepEqual(f.raw.prepare("select * from idempotency").all(), before);
});
