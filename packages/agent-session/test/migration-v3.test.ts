// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { access, appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EventId,
  MessageId,
  SessionId,
  createAgentEventV3,
  createProtectedJsonViewV1
} from "@mn/agent-protocol";

import {
  JsonlAgentSessionStore,
  appendAgentEventV3Jsonl,
  applyLocalAppServerV3Migration,
  inspectLocalAppServerV3Migration,
  readAgentEventV3Jsonl,
  rollbackLocalAppServerV3Migration
} from "../src/index.js";

async function missing(filePath: string): Promise<boolean> {
  return access(filePath).then(() => false, () => true);
}

async function seedV2(root: string): Promise<string> {
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({
    schemaVersion: 2,
    sessionId: SessionId("session-migrate-v3"),
    cwd: "/workspace/project",
    modelBinding: {
      schemaVersion: 1,
      kind: "agent-model-binding",
      providerId: "openai",
      modelId: "gpt-5"
    }
  });
  await session.append("turn/start", { turn: 1 });
  await session.append("user/message", {
    turn: 1,
    message: {
      id: MessageId("message-one"),
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "migrate me" }]
    }
  });
  await session.append("turn/end", { turn: 1, reason: "completed" });
  await session.flush();
  await store.dispose();
  await writeFile(path.join(root, "projection.db"), "sqlite-projection");
  await writeFile(path.join(root, "mutations.jsonl"), "{\"state\":\"completed\"}\n");
  await mkdir(path.join(root, "attachments"));
  await writeFile(path.join(root, "attachments", "image.bin"), "image-bytes");
  return session.header.sessionId;
}

test("dry-run and apply produce a verified one-to-one V3 chain and read-only archive", async () => {
  const actualRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-v3-"));
  const sessionId = await seedV2(actualRoot);

  const dryRun = await inspectLocalAppServerV3Migration({ root: actualRoot });
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.sessionCount, 1);
  assert.equal(dryRun.eventCount, 4);
  assert.equal(await missing(path.join(actualRoot, "threads")), true);
  assert.equal(await missing(path.join(actualRoot, "archive")), true);

  const applied = await applyLocalAppServerV3Migration({ root: actualRoot });
  assert.equal(applied.mode, "applied");
  assert.equal(applied.oldRootDigest, dryRun.oldRootDigest);
  assert.equal(applied.newRootDigest, dryRun.newRootDigest);
  assert.equal(await missing(path.join(actualRoot, "sessions")), true);
  const eventsPath = path.join(actualRoot, "threads", sessionId, "events.jsonl");
  const events = await readAgentEventV3Jsonl(eventsPath);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((event) => event.source?.schemaVersion), [2, 2, 2, 2]);
  assert.equal(events[0]?.threadId, sessionId);
  assert.equal(events[1]?.turnId, events[2]?.turnId);

  const manifest = JSON.parse(await readFile(path.join(actualRoot, "app-server-v3-migration.json"), "utf8"));
  const oldArchive = path.join(actualRoot, manifest.archivePath);
  assert.equal((await stat(path.join(oldArchive, "sessions"))).mode & 0o777, 0o500);
  assert.equal((await stat(path.join(oldArchive, "projection.db"))).mode & 0o777, 0o400);
  assert.equal((await stat(path.join(oldArchive, "mutations.jsonl"))).mode & 0o777, 0o400);
  assert.equal((await stat(path.join(oldArchive, "attachments", "image.bin"))).mode & 0o777, 0o400);
});

test("rollback restores the complete old state only before the first V3 write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-v3-rollback-"));
  const sessionId = await seedV2(root);
  await applyLocalAppServerV3Migration({ root });
  const rolledBack = await rollbackLocalAppServerV3Migration({ root });
  assert.equal(rolledBack.mode, "rolled-back");
  assert.equal(await missing(path.join(root, "sessions", sessionId, "events.jsonl")), false);
  assert.equal(await missing(path.join(root, "threads")), true);
  assert.equal((await stat(path.join(root, "sessions"))).mode & 0o777, 0o700);

  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-v3-written-"));
  await seedV2(secondRoot);
  await applyLocalAppServerV3Migration({ root: secondRoot });
  const eventsPath = path.join(secondRoot, "threads", sessionId, "events.jsonl");
  const events = await readAgentEventV3Jsonl(eventsPath);
  const previous = events.at(-1)!;
  const appended = createAgentEventV3({
    eventId: EventId("eventv-native"),
    threadId: previous.threadId,
    sequence: previous.sequence + 1,
    occurredAt: "2026-08-23T01:00:00.000Z",
    type: "thread/archived",
    causationId: previous.eventId,
    correlationId: previous.threadId,
    publicControls: {},
    protectedContent: createProtectedJsonViewV1(null),
    previousDigest: previous.digest
  });
  await appendFile(eventsPath, `${JSON.stringify(appended)}\n`);
  await assert.rejects(
    () => rollbackLocalAppServerV3Migration({ root: secondRoot }),
    /V3 write|digest|count/iu
  );
  assert.equal(await missing(path.join(secondRoot, "sessions")), true);
});

test("corrupt legacy input aborts before creating a target or archive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-v3-corrupt-"));
  const sessionId = await seedV2(root);
  const eventsPath = path.join(root, "sessions", sessionId, "events.jsonl");
  const lines = (await readFile(eventsPath, "utf8")).trimEnd().split("\n");
  const event = JSON.parse(lines[1]!);
  event.digest = "0".repeat(64);
  lines[1] = JSON.stringify(event);
  await writeFile(eventsPath, `${lines.join("\n")}\n`);

  await assert.rejects(() => applyLocalAppServerV3Migration({ root }), /invalid|corrupt|digest/iu);
  assert.equal(await missing(path.join(root, "threads")), true);
  assert.equal(await missing(path.join(root, "archive")), true);
  assert.equal(await missing(path.join(root, "sessions")), false);
});

test("rollback rejects a tampered manifest and target collision before moving V3 state", async () => {
  const tamperedRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-v3-tampered-"));
  await seedV2(tamperedRoot);
  await applyLocalAppServerV3Migration({ root: tamperedRoot });
  const manifestPath = path.join(tamperedRoot, "app-server-v3-migration.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.archivePath = "../outside";
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  await assert.rejects(
    () => rollbackLocalAppServerV3Migration({ root: tamperedRoot }),
    /manifest|archive/iu
  );
  assert.equal(await missing(path.join(tamperedRoot, "threads")), false);

  const collisionRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-v3-collision-"));
  await seedV2(collisionRoot);
  await applyLocalAppServerV3Migration({ root: collisionRoot });
  await mkdir(path.join(collisionRoot, "sessions"));

  await assert.rejects(
    () => rollbackLocalAppServerV3Migration({ root: collisionRoot }),
    /target already exists/iu
  );
  assert.equal(await missing(path.join(collisionRoot, "threads")), false);
  assert.equal(await missing(path.join(collisionRoot, "app-server-v3-migration.json")), false);
});

test("the V3 writer serializes concurrent durable appends and rebuilds the verified chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-v3-writer-"));
  const sessionId = await seedV2(root);
  await applyLocalAppServerV3Migration({ root });
  const eventsPath = path.join(root, "threads", sessionId, "events.jsonl");
  const protectedContent = createProtectedJsonViewV1(null);

  const appended = await Promise.all([
    appendAgentEventV3Jsonl(eventsPath, {
      eventId: EventId("eventv-native-one"),
      occurredAt: "2026-08-23T01:00:00.000Z",
      type: "thread/updated",
      correlationId: sessionId,
      publicControls: { name: "one" },
      protectedContent
    }),
    appendAgentEventV3Jsonl(eventsPath, {
      eventId: EventId("eventv-native-two"),
      occurredAt: "2026-08-23T01:00:01.000Z",
      type: "thread/updated",
      correlationId: sessionId,
      publicControls: { name: "two" },
      protectedContent
    })
  ]);

  assert.deepEqual(appended.map((event) => event.sequence).sort((left, right) => left - right), [4, 5]);
  const events = await readAgentEventV3Jsonl(eventsPath);
  assert.equal(events.length, 6);
  assert.equal(events.at(-1)?.digest, appended.find((event) => event.sequence === 5)?.digest);
});
