// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCas, InMemoryKeyProvider, SqliteStorage, collectJournalCasReferences, acquireLocalStateLock } from "../src/index.js";

test("maintenance authenticates historical CAS references after projection deletion across tenants", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-maintenance-"));
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const hmacKey = Buffer.alloc(32, 73);
  const journal = { cas, keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 74)), namespaces: ["*non-core"] };
  const store = new SqliteStorage({ databaseFile: join(root, "state.sqlite3"), hmacKey, projectionJournal: journal });
  try {
    const referenced = new Set<string>();
    for (const tenantId of ["a", "b"]) {
      const object = await cas.put(Buffer.from(`historical ciphertext ${tenantId}`));
      utimesSync(object.path!, new Date(0), new Date(0));
      await store.transact(tenantId, tx => {
        tx.putProjection("fixture", "record", { ciphertextDigest: object.digest });
        tx.appendEvent({ tenantId, aggregateType: "fixture", aggregateId: "record", expectedStreamVersion: 0,
          type: "fixture.created", actorId: "human", generation: 1, correlationId: "create", publicPayload: {} });
      });
      await store.transact(tenantId, tx => {
        tx.deleteProjection("fixture", "record");
        tx.appendEvent({ tenantId, aggregateType: "fixture", aggregateId: "record", expectedStreamVersion: 1,
          type: "fixture.deleted", actorId: "human", generation: 1, correlationId: "delete", publicPayload: {} });
      });
      const events = (await store.readEventHistory(tenantId, 0, 1000)).events;
      const options = { ...journal, hmacKey, tenantId, events, expectedPosition: events.length };
      const digests = await collectJournalCasReferences(options);
      assert.ok(digests.has(object.digest));
      for (const digest of digests) referenced.add(digest);
      await assert.rejects(collectJournalCasReferences({ ...options, expectedPosition: events.length + 1 }));
      await assert.rejects(collectJournalCasReferences({ ...options, events: events.map((e, i) => i ? e : { ...e, hmac: "invalid" }) }));
      await assert.rejects(collectJournalCasReferences({ ...options, keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 75)) }));
    }
    const orphan = await cas.put(Buffer.from("uncommitted orphan"));
    const recent = await cas.put(Buffer.from("recent orphan"));
    utimesSync(orphan.path!, new Date(0), new Date(0));
    assert.deepEqual(await cas.gcOrphans(referenced, new Date(Date.now() - 86_400_000)), [orphan.digest]);
    assert.ok(await cas.has(recent.digest));
    for (const digest of referenced) { assert.ok(await cas.has(digest)); await cas.get(digest); }
    const events = (await store.readEventHistory("a", 0, 1000)).events;
    const originalGet = cas.get.bind(cas);
    cas.get = async digest => { if (!events.some(event => event.protectedPayloadRef === digest)) throw new Error("missing ciphertext"); return originalGet(digest); };
    await assert.rejects(collectJournalCasReferences({ ...journal, hmacKey, tenantId: "a", events, expectedPosition: events.length }), /missing ciphertext/);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("CAS GC rejects invalid cutoff and refuses foreign prefixes or invalid object times", async () => {
  const { S3Cas } = await import("../src/index.js");
  let deletes = 0;
  const digest = "a".repeat(64);
  const cas = new S3Cas({ bucket: "fixture", client: {
    putObject: async () => true, getObject: async () => new Uint8Array(), headObject: async () => undefined,
    listObjects: async () => [{ key: `v1/sha256/${digest}`, lastModified: new Date(0) },
      { key: `v2/sha256/${digest}`, lastModified: new Date("invalid") }],
    deleteObjects: async () => { deletes++; },
  } });
  await assert.rejects(cas.gcOrphans(new Set(), new Date("invalid")));
  assert.deepEqual(await cas.gcOrphans(new Set(), new Date()), []);
  assert.equal(deletes, 0);
});

test("local cold-start GC requires state ownership, verifies history, retains recent objects, and runs at most daily", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-local-gc-"));
  const lock = await acquireLocalStateLock(root);
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 74));
  const store = new SqliteStorage({ databaseFile: join(root, "state.sqlite3"), hmacKey: Buffer.alloc(32, 73),
    projectionJournal: { cas, keyProvider, namespaces: ["*non-core"] } });
  try {
    const retained = await cas.put(Buffer.from("retained ciphertext"));
    const orphan = await cas.put(Buffer.from("uncommitted"));
    const recent = await cas.put(Buffer.from("recent"));
    for (const object of [retained, orphan]) utimesSync(object.path!, new Date(0), new Date(0));
    await store.transact("local", tx => {
      tx.putProjection("fixture", "one", { ciphertextDigest: retained.digest });
      tx.appendEvent({ tenantId: "local", aggregateType: "fixture", aggregateId: "one", expectedStreamVersion: 0,
        type: "fixture.created", actorId: "owner", generation: 0, correlationId: "create", publicPayload: {} });
    });
    await assert.rejects(store.gcLocalOrphans({ lock: { release() {} }, keyProvider }), /LOCK_REQUIRED/);
    await assert.rejects(store.gcLocalOrphans({ lock, keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 75)) }));
    assert.ok(await cas.has(orphan.digest));
    const result = await store.gcLocalOrphans({ lock, keyProvider });
    assert.deepEqual(result, { status: "completed", removedObjects: 1 });
    assert.ok(await cas.has(retained.digest));
    assert.ok(await cas.has(recent.digest));
    assert.equal(await cas.has(orphan.digest), false);
    assert.equal((await store.gcLocalOrphans({ lock, keyProvider })).status, "not_due");
    lock.release();
    await assert.rejects(store.gcLocalOrphans({ lock, keyProvider }), /LOCK_REQUIRED/);
  } finally { await store.close(); lock.release(); rmSync(root, { recursive: true, force: true }); }
});
