// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createProjectionFacts, type ProjectionFactV1 } from "@mn/contracts";
import { ProtectedCoreStateUpgradeRequiredError, FileCas, InMemoryKeyProvider, SqliteStorage, replayProjectionJournal } from "../src/index.js";

test("product projection facts commit with encrypted CAS references and no public business content", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-projection-journal-"));
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 18));
  const journalOptions = { projectionJournal: { cas, keyProvider, namespaces: ["fixture.product"] } };
  const store = new SqliteStorage({ databaseFile: join(root, "kernel.sqlite"), hmacKey: Buffer.alloc(32, 19), ...journalOptions });
  try {
    await store.transact("tenant-a", tx => {
      tx.putProjection("fixture.product", "resource-a", { workspaceId: "workspace-a", original: "confidential-original-record" });
      tx.putIdempotency({ tenantId: "tenant-a", scope: "fixture.capture", key: "capture-a", requestDigest: "request",
        response: { original: "confidential-original-record" }, createdAt: new Date().toISOString() });
      tx.appendEvent({ tenantId: "tenant-a", aggregateType: "fixture.product", aggregateId: "resource-a",
        expectedStreamVersion: 0, type: "fixture.recorded", actorId: "owner-a", generation: 1,
        correlationId: "capture-a", publicPayload: { workspaceId: "workspace-a" } });
    });
    const events = (await store.readEvents("tenant-a", 0, 100)).events;
    const fact = events.find(event => event.type === "projection.fact_committed");
    assert.ok(fact, "product contents require a durable event fact, not only a query row");
    assert.ok(fact.protectedPayloadRef);
    assert.equal(JSON.stringify(events).includes("confidential-original-record"), false);
    assert.equal(fact.causationId, events[0]!.id);
    assert.equal(fact.actorId, "owner-a");
    assert.equal(await cas.has(fact.protectedPayloadRef), true);
    const raw = new DatabaseSync(join(root, "kernel.sqlite"));
    try {
      assert.equal(JSON.stringify(raw.prepare("select value_json from projections").all()).includes("confidential-original-record"), false,
        "query projections must not retain a plaintext copy of protected facts");
      assert.equal(JSON.stringify(raw.prepare("select response_json from idempotency").all()).includes("confidential-original-record"), false,
        "idempotency replay must not retain a plaintext product response");
    } finally { raw.close(); }
    assert.deepEqual(await store.transact("tenant-a", tx => tx.getProjection("fixture.product", "resource-a")),
      { workspaceId: "workspace-a", original: "confidential-original-record" });
    assert.deepEqual((await store.transact("tenant-a", tx => tx.getIdempotency("fixture.capture", "capture-a")))?.response,
      { original: "confidential-original-record" });
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Host-wide journal covers newly installed namespaces and wrapped key descriptors", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-journal-namespaces-"));
  const options = { cas: new FileCas({ rootDir: join(root, "cas") }), keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 16)),
    namespaces: ["*non-core"] };
  const hmacKey = Buffer.alloc(32, 17);
  const store = new SqliteStorage({ databaseFile: join(root, "kernel.sqlite"), hmacKey, projectionJournal: options });
  try {
    const wrappedKey = await options.keyProvider.wrapKey(Buffer.alloc(32, 18), { tenantId: "a", purpose: "memory:one" });
    await store.transact("a", tx => {
      tx.putProjection("future-plugin.records", "one", { content: "new namespace" });
      tx.putProjection("protectedPayloadKey", "payload", { id: "payload", workspaceId: "w", wrappedKey });
      tx.appendEvent({ tenantId: "a", aggregateType: "fixture", aggregateId: "one", expectedStreamVersion: 0,
        type: "fixture.created", actorId: "owner", generation: 0, correlationId: "create", publicPayload: {} });
    });
    const facts = await replayProjectionJournal({ ...options, tenantId: "a", hmacKey, events: (await store.readEvents("a", 0, 100)).events });
    assert.equal(facts.length, 2, "new product namespaces and key descriptors cannot remain query-only state");
    await store.transact("a", tx => {
      tx.deleteProjection("protectedPayloadKey", "payload");
      tx.appendEvent({ tenantId: "a", aggregateType: "fixture", aggregateId: "one", expectedStreamVersion: 1,
        type: "fixture.deleted", actorId: "owner", generation: 0, correlationId: "delete", publicPayload: {} });
    });
    assert.equal((await store.transact("a", tx => tx.listProjections("kernel.key-revocation"))).length, 1);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("production replay validates ciphertext before an atomic encrypted projection switch", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-journal-rebuild-"));
  const databaseFile = join(root, "kernel.sqlite");
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const store = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 17),
    projectionJournal: { cas, keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 16)), namespaces: ["fixture"] } });
  const rebuild = () => (store as SqliteStorage & { rebuildJournalProjections(tenantId: string): Promise<unknown> }).rebuildJournalProjections("a");
  try {
    await store.transact("a", tx => {
      tx.putProjection("fixture", "one", { content: "rebuild me", streamVersion: 1 });
      tx.putIdempotency({ tenantId: "a", scope: "fixture", key: "one", requestDigest: "request",
        response: { content: "rebuild me" }, createdAt: new Date().toISOString() });
      tx.appendEvent({ tenantId: "a", aggregateType: "fixture", aggregateId: "one", expectedStreamVersion: 0,
        type: "fixture.created", actorId: "owner", generation: 0, correlationId: "create", publicPayload: {} });
    });
    await store.advanceRetentionFloor("a", 2);
    const raw = new DatabaseSync(databaseFile);
    try {
      raw.exec("delete from projections; delete from idempotency");
      await rebuild();
      assert.deepEqual(await store.getProjection("a", "fixture", "one"), { content: "rebuild me", streamVersion: 1 });
      assert.deepEqual((await store.transact("a", tx => tx.getIdempotency("fixture", "one")))?.response, { content: "rebuild me" });
      assert.equal(JSON.stringify(raw.prepare("select value_json from projections").all()).includes("rebuild me"), false);
      assert.equal(JSON.stringify(raw.prepare("select response_json from idempotency").all()).includes("rebuild me"), false);
      const before = raw.prepare("select * from projections").all();
      cas.get = async () => { throw new Error("fixture corrupted ciphertext"); };
      await assert.rejects(rebuild(), /corrupted ciphertext/);
      assert.deepEqual(raw.prepare("select * from projections").all(), before, "failed validation must not replace live projections");
    } finally { raw.close(); }
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("replay restores complete product objects and event arrays into an empty database", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-projection-replay-"));
  const options = { cas: new FileCas({ rootDir: join(root, "cas") }),
    keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 18)), namespaces: ["fixture."] };
  const hmacKey = Buffer.alloc(32, 19);
  const store = new SqliteStorage({ databaseFile: join(root, "source.sqlite"), hmacKey, projectionJournal: options });
  const target = new SqliteStorage({ databaseFile: join(root, "target.sqlite"), hmacKey });
  const values = [{ namespace: "fixture.events", id: "opportunity", value: [{ raw: "original evidence" }] },
    { namespace: "fixture.deliverable", id: "report", value: { content: "counterevidence", streamVersion: 2 } }];
  try {
    await store.transact("tenant-a", tx => {
      for (const fact of values) tx.putProjection(fact.namespace, fact.id, fact.value);
      tx.appendEvent({ tenantId: "tenant-a", aggregateType: "fixture", aggregateId: "opportunity",
        expectedStreamVersion: 0, type: "fixture.captured", actorId: "human", generation: 0,
        correlationId: "capture", publicPayload: {} });
    });
    const events = (await store.readEvents("tenant-a", 0, 100)).events;
    const facts = await replayProjectionJournal({ ...options, events, tenantId: "tenant-a", hmacKey });
    assert.deepEqual(facts, values);
    await target.transact("tenant-a", tx => {
      for (const fact of facts) tx.putProjection(fact.namespace, fact.id, fact.value);
    });
    for (const fact of facts) assert.deepEqual(await target.transact("tenant-a", tx => tx.getProjection(fact.namespace, fact.id)), fact.value);
    await assert.rejects(replayProjectionJournal({ ...options, events: events.slice(1), tenantId: "tenant-a", hmacKey }), /authenticated/);
    await assert.rejects(replayProjectionJournal({ ...options, events, tenantId: "tenant-b", hmacKey }), /authenticated/);
    await assert.rejects(replayProjectionJournal({ ...options, events, tenantId: "tenant-a", hmacKey: Buffer.alloc(32, 20) }), /authenticated/);
    await store.transact("tenant-a", tx => {
      tx.deleteProjection("fixture.events", "opportunity");
      tx.appendEvent({ tenantId: "tenant-a", aggregateType: "fixture", aggregateId: "opportunity",
        expectedStreamVersion: 1, type: "fixture.deleted", actorId: "human", generation: 0,
        correlationId: "delete", publicPayload: {} });
    });
    const deleted = await replayProjectionJournal({ ...options,
      events: (await store.readEvents("tenant-a", 0, 100)).events, tenantId: "tenant-a", hmacKey });
    assert.deepEqual(deleted.find(fact => fact.namespace === "fixture.events"), { namespace: "fixture.events", id: "opportunity", value: null });
  } finally {
    await Promise.all([store.close(), target.close()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CAS failure rolls back events, product state, outbox, and idempotency; concurrent reads never see uncommitted content", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-journal-atomic-"));
  const cas = new FileCas({ rootDir: join(root, "cas") });
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  cas.put = async () => { entered(); await pending; throw new Error("fixture CAS failure"); };
  const store = new SqliteStorage({ databaseFile: join(root, "kernel.sqlite"), hmacKey: Buffer.alloc(32, 19),
    projectionJournal: { cas, keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 18)), namespaces: ["fixture"] } });
  try {
    const write = store.transact("tenant-a", tx => {
      tx.putProjection("fixture", "one", { content: "must not be visible" });
      tx.putIdempotency({ tenantId: "tenant-a", scope: "fixture", key: "one", requestDigest: "digest", response: {}, createdAt: new Date().toISOString() });
      tx.appendEvent({ tenantId: "tenant-a", aggregateType: "fixture", aggregateId: "one",
        expectedStreamVersion: 0, type: "fixture.captured", actorId: "human", generation: 0,
        correlationId: "capture", publicPayload: {} });
    });
    const failure = assert.rejects(write, /fixture CAS failure/);
    await ready;
    let readFinished = false;
    const read = store.transact("tenant-a", tx => {
      readFinished = true;
      assert.equal(tx.getProjection("fixture", "one"), undefined);
      assert.equal(tx.getIdempotency("fixture", "one"), undefined);
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readFinished, false);
    release();
    await Promise.all([failure, read]);
    assert.equal((await store.readEvents("tenant-a", 0, 100)).events.length, 0);
    assert.equal((await store.listOutbox("tenant-a", 100)).length, 0);
  } finally {
    release();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal IO timeout rolls back without late writes leaking into a subsequent transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-journal-timeout-"));
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const put = cas.put.bind(cas);
  cas.put = async bytes => { await new Promise(resolve => setTimeout(resolve, 30)); return put(bytes); };
  const projectionJournal = { cas, keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 18)), namespaces: ["fixture"], ioTimeoutMs: 5 };
  const store = new SqliteStorage({ databaseFile: join(root, "kernel.sqlite"), hmacKey: Buffer.alloc(32, 19), projectionJournal });
  try {
    await assert.rejects(store.transact("tenant-a", tx => {
      tx.putProjection("fixture", "one", { content: "must be rolled back" });
      tx.appendEvent({ tenantId: "tenant-a", aggregateType: "fixture", aggregateId: "one", expectedStreamVersion: 0,
        type: "fixture.captured", actorId: "human", generation: 0, correlationId: "capture", publicPayload: {} });
    }), /timed out/);
    await store.transact("tenant-a", tx => tx.putProjection("metadata", "safe", { id: "safe" }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await store.readEvents("tenant-a", 0, 100)).events.length, 0);
    assert.equal(await store.getProjection("tenant-a", "fixture", "one"), undefined);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable product payload does not disable core metadata or another namespace", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-journal-isolation-"));
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const store = new SqliteStorage({ databaseFile: join(root, "kernel.sqlite"), hmacKey: Buffer.alloc(32, 19),
    projectionJournal: { cas, keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 18)), namespaces: ["fixture"] } });
  try {
    await store.transact("tenant-a", tx => {
      tx.putProjection("fixture", "one", { content: "private" });
      tx.putProjection("workspace", "workspace-a", { id: "workspace-a" });
      tx.appendEvent({ tenantId: "tenant-a", aggregateType: "fixture", aggregateId: "one", expectedStreamVersion: 0,
        type: "fixture.captured", actorId: "human", generation: 0, correlationId: "capture", publicPayload: {} });
    });
    cas.get = async () => { throw new Error("fixture corrupt CAS object"); };
    assert.deepEqual(await store.transact("tenant-a", tx => tx.getProjection("workspace", "workspace-a")), { id: "workspace-a" });
    await assert.rejects(store.transact("tenant-a", tx => tx.getProjection("fixture", "one")), /corrupt CAS/);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("protected core facts never persist plaintext and rebuild preserves their complete values", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-core-confidentiality-"));
  const databaseFile = join(root, "kernel.sqlite");
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 22));
  const options = { cas: new FileCas({ rootDir: join(root, "cas") }), keyProvider,
    namespaces: ["*non-core", "thread", "approval", "inbox", "toolIntent"] };
  const store = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 23), projectionJournal: options });
  const marker = "confidential-core-sample-731";
  const records: ProjectionFactV1[] = [
    { namespace: "thread" as const, id: "thread", value: { id: "thread", tenantId: "tenant", subject: marker, streamVersion: 1 } },
    { namespace: "approval" as const, id: "approval", value: { id: "approval", tenantId: "tenant", intent: marker, streamVersion: 1 } },
    { namespace: "inbox" as const, id: "inbox", value: { id: "inbox", tenantId: "tenant", summary: marker, streamVersion: 1 } },
    { namespace: "toolIntent" as const, id: "intent", value: { id: "intent", tenantId: "tenant", intent: marker, streamVersion: 1 } },
  ];
  try {
    await store.transact("tenant", tx => {
      for (const record of records) tx.putProjection(record.namespace, record.id, record.value);
      tx.appendEvent({ tenantId: "tenant", aggregateType: "thread", aggregateId: "thread", expectedStreamVersion: 0,
        type: "thread.created", actorId: "owner", generation: 0, correlationId: "create",
        publicPayload: { projectionFacts: createProjectionFacts(records) } });
      tx.putIdempotency({ tenantId: "tenant", scope: "create", key: "one", requestDigest: "digest",
        response: records[0]!.value, createdAt: new Date().toISOString() });
    });
    const raw = new DatabaseSync(databaseFile);
    try {
      for (const table of ["events", "projections", "idempotency", "outbox"]) {
        assert.equal(JSON.stringify(raw.prepare(`select * from ${table}`).all()).includes(marker), false, table);
      }
      raw.exec("delete from projections; delete from idempotency");
      await store.rebuildProjections("tenant");
      for (const record of records) assert.deepEqual(await store.getProjection("tenant", record.namespace, record.id), record.value);
      assert.deepEqual((await store.transact("tenant", tx => tx.getIdempotency("create", "one")))?.response, records[0]!.value);
      assert.equal(JSON.stringify(raw.prepare("select * from projections").all()).includes(marker), false);
      options.cas.get = async () => { throw new Error("protected core evidence unavailable"); };
      await assert.rejects(store.transact("tenant", tx => tx.getProjection("approval", "approval")), /unavailable/);
      await assert.rejects(store.rebuildProjections("tenant"), /unavailable/);
    } finally { raw.close(); }
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});


test("existing plaintext core state blocks configuration and rebuild without changing records", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-core-upgrade-required-"));
  const databaseFile = join(root, "kernel.sqlite");
  const store = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 28) });
  const options = { cas: new FileCas({ rootDir: join(root, "cas") }),
    keyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 29)), namespaces: ["thread"] };
  const legacy = { id: "thread", tenantId: "tenant", subject: "old-private-title", streamVersion: 1 };
  try {
    await store.transact("tenant", tx => {
      tx.putProjection("thread", "thread", legacy);
      tx.appendEvent({ tenantId: "tenant", aggregateType: "thread", aggregateId: "thread", expectedStreamVersion: 0,
        type: "thread.created", actorId: "owner", generation: 0, correlationId: "create",
        publicPayload: { projectionFacts: createProjectionFacts([{ namespace: "thread", id: "thread", value: legacy }]) } });
    });
    assert.throws(() => store.configureProjectionJournal(options), ProtectedCoreStateUpgradeRequiredError);
    assert.deepEqual(await store.getProjection("tenant", "thread", "thread"), legacy);
    const raw = new DatabaseSync(databaseFile);
    try {
      raw.exec("delete from projections");
      store.configureProjectionJournal(options);
      await assert.rejects(store.rebuildProjections("tenant"), ProtectedCoreStateUpgradeRequiredError);
      assert.equal((await store.readEvents("tenant", 0, 100)).events.length, 1);
      assert.equal(raw.prepare("select count(*) as count from projections").get()!.count, 0);
    } finally { raw.close(); }
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});
