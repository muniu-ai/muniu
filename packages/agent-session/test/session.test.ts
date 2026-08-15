import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CallId,
  EventId,
  MessageId,
  SessionId,
  createAgentSessionEvent,
  createAssistantMessage,
  createUserMessage,
  verifyAgentSessionEventChain
} from "@mn/agent-protocol";
import {
  InMemoryAgentSessionStore,
  JsonlAgentSessionStore,
  DurableAgentSession,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  projectSession,
  recoverInterruptedSession
} from "../src/index.js";

test("session is poisoned after an uncertain persistence failure and never retries", async () => {
  const sessionId = SessionId("poisoned-session");
  let appendAttempts = 0;
  let flushAttempts = 0;
  const session = new DurableAgentSession({
    schemaVersion: 1,
    sessionId,
    createdAt: "2026-08-15T00:00:00.000Z"
  }, [], {
    append: async () => {
      appendAttempts += 1;
      throw new Error("write outcome unknown");
    },
    flush: async () => { flushAttempts += 1; }
  });

  const first = session.append("session/created", {});
  const queued = session.append("turn/start", { turn: 1 });
  await assert.rejects(() => first, /write outcome unknown/i);
  await assert.rejects(() => queued, /poisoned|persistence failure/i);
  await assert.rejects(() => session.append("turn/start", { turn: 1 }), /poisoned|persistence failure/i);
  await assert.rejects(() => session.flush(), /poisoned|persistence failure/i);
  assert.equal(appendAttempts, 1);
  assert.equal(flushAttempts, 0);
  assert.equal(session.events.length, 0);
});

test("append snapshots payload synchronously before queued persistence", async () => {
  const session = new DurableAgentSession({
    schemaVersion: 1,
    sessionId: SessionId("snapshot-session"),
    createdAt: "2026-08-15T00:00:00.000Z"
  }, [], {
    append: async () => {},
    flush: async () => {}
  });
  const payload = { turn: 1 };
  const pending = session.append("turn/start", payload);
  payload.turn = 99;
  const event = await pending;
  assert.equal(event.payload.turn, 1);
  assert.equal(Object.isFrozen(event.payload), true);
});

test("in-memory store serializes concurrent appends into a verified chain", async () => {
  const store = new InMemoryAgentSessionStore();
  const session = await store.create({ sessionId: SessionId("memory-session") });
  await Promise.all(Array.from({ length: 20 }, (_, index) => session.append("turn/start", { turn: index + 1 })));

  assert.deepEqual(session.events.map((event) => event.seq), Array.from({ length: 21 }, (_, index) => index));
  assert.doesNotThrow(() => verifyAgentSessionEventChain(session.events));
  assert.equal(session.events[0]?.type, "session/created");
});

test("JSONL store persists mode 0700/0600 and reopens a verified session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-"));
  await chmod(root, 0o777);
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("disk-session"), cwd: "/tmp/project" });
  await session.append("turn/start", { turn: 1 });
  await session.flush();

  const sessionDir = path.join(root, "sessions", "disk-session");
  assert.equal((await stat(path.join(root, "sessions"))).mode & 0o777, 0o700);
  assert.equal((await stat(sessionDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(sessionDir, "header.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(sessionDir, "events.jsonl"))).mode & 0o777, 0o600);

  await store.dispose();
  const reopenStore = new JsonlAgentSessionStore(root);
  const reopened = await reopenStore.open(SessionId("disk-session"));
  assert.equal(reopened.header.cwd, "/tmp/project");
  assert.deepEqual(reopened.events.map((event) => event.type), ["session/created", "turn/start"]);
  await reopenStore.dispose();
});

test("JSONL load truncates a torn final line but fails closed on middle corruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-tail-"));
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("tail-session") });
  await session.append("turn/start", { turn: 1 });
  const eventsPath = path.join(root, "sessions", "tail-session", "events.jsonl");
  const committed = await readFile(eventsPath);
  await writeFile(eventsPath, Buffer.concat([committed, Buffer.from('{"schemaVersion":1')]));

  await store.dispose();
  const reopenStore = new JsonlAgentSessionStore(root);
  const reopened = await reopenStore.open(SessionId("tail-session"));
  assert.equal(reopened.events.length, 2);
  assert.deepEqual(await readFile(eventsPath), committed);
  await reopenStore.dispose();

  const lines = committed.toString("utf8").trimEnd().split("\n");
  await writeFile(eventsPath, `${lines[0]}\nnot-json\n${lines[1]}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("tail-session")), /corrupt.*line 2/i);
});

test("JSONL load rejects empty logs, a non-creation first event, and header/event id mismatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-binding-"));
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("bound-session") });
  const eventsPath = path.join(root, "sessions", "bound-session", "events.jsonl");
  const headerPath = path.join(root, "sessions", "bound-session", "header.json");
  const originalHeader = JSON.parse(await readFile(headerPath, "utf8")) as Record<string, unknown>;
  const originalEvents = await readFile(eventsPath, "utf8");
  await store.dispose();

  await writeFile(headerPath, `${JSON.stringify({ ...originalHeader, unexpected: true })}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /invalid session header/i);
  await writeFile(headerPath, `${JSON.stringify({ ...originalHeader, createdAt: "2026-08-15" })}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /invalid session header/i);
  await writeFile(headerPath, `${JSON.stringify({ ...originalHeader, cwd: "/tampered" })}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /cwd.*creation event/i);
  await writeFile(headerPath, `${JSON.stringify(originalHeader)}\n`);
  await writeFile(eventsPath, originalEvents);

  await writeFile(eventsPath, "");
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /empty event log/i);

  const notCreated = createAgentSessionEvent({
    eventId: EventId("not-created"),
    sessionId: SessionId("bound-session"),
    seq: 0,
    occurredAt: "2026-08-15T00:00:00.000Z",
    type: "turn/start",
    payload: { turn: 1 }
  });
  await writeFile(eventsPath, `${JSON.stringify(notCreated)}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /first event.*session\/created/i);

  const mismatched = createAgentSessionEvent({
    eventId: EventId("wrong-session"),
    sessionId: SessionId("another-session"),
    seq: 0,
    occurredAt: "2026-08-15T00:00:00.000Z",
    type: "session/created",
    payload: {}
  });
  await writeFile(eventsPath, `${JSON.stringify(mismatched)}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("bound-session")), /event session id.*header/i);
  assert.equal(session.events.length, 1);
});

test("JSONL stores enforce one canonical in-process writer and coalesce concurrent opens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-lease-"));
  const sessionId = SessionId("leased-session");
  const creator = new JsonlAgentSessionStore(root);
  await creator.create({ sessionId });
  const contender = new JsonlAgentSessionStore(root);
  await assert.rejects(() => contender.open(sessionId), /lease|writer/i);

  await creator.dispose();
  const reader = new JsonlAgentSessionStore(root);
  const [first, second] = await Promise.all([reader.open(sessionId), reader.open(sessionId)]);
  assert.equal(first, second);
  await assert.rejects(() => contender.open(sessionId), /lease|writer/i);
  await reader.dispose();
  const transferred = await contender.open(sessionId);
  assert.equal(transferred.header.sessionId, sessionId);
  await contender.dispose();

  const createRoot = await mkdtemp(path.join(os.tmpdir(), "muniu-session-create-"));
  const creating = new JsonlAgentSessionStore(createRoot);
  const results = await Promise.allSettled([
    creating.create({ sessionId: SessionId("concurrent-create") }),
    creating.create({ sessionId: SessionId("concurrent-create") })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await creating.dispose();
});

test("JSONL dispose holds its lease until an active durable append settles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-dispose-"));
  let enterAppend!: () => void;
  const appendEntered = new Promise<void>((resolve) => { enterAppend = resolve; });
  let releaseAppend!: () => void;
  const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
  const sessionId = SessionId("dispose-race");
  const store = new JsonlAgentSessionStore(root, {
    beforeAppend: async (event) => {
      if (event.type !== "turn/start") return;
      enterAppend();
      await appendGate;
    }
  });
  const session = await store.create({ sessionId });
  const append = session.append("turn/start", { turn: 1 });
  await appendEntered;
  let disposeSettled = false;
  const disposing = store.dispose().then(() => { disposeSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposeSettled, false);

  const contender = new JsonlAgentSessionStore(root);
  await assert.rejects(() => contender.open(sessionId), /lease|writer/i);
  releaseAppend();
  await append;
  await disposing;
  assert.equal(disposeSettled, true);
  const transferred = await contender.open(sessionId);
  assert.deepEqual(transferred.events.map((event) => event.type), ["session/created", "turn/start"]);
  await contender.dispose();
});

test("recovery closes started and unstarted tool effects without replaying either", async () => {
  const store = new InMemoryAgentSessionStore();
  const session = await store.create({ sessionId: SessionId("recover-session") });
  const user = createUserMessage({
    id: MessageId("user-1"),
    content: [{ type: "text", text: "run tools" }],
    source: { kind: "user" }
  });
  const started = CallId("call-started");
  const unstarted = CallId("call-unstarted");
  const assistant = createAssistantMessage({
    id: MessageId("assistant-1"),
    content: [
      { type: "tool-call", id: started, name: "write", arguments: "{}" },
      { type: "tool-call", id: unstarted, name: "read", arguments: "{}" }
    ],
    source: { kind: "model", provider: "mock", model: "scripted" }
  });
  await session.append("turn/start", { turn: 1 });
  await session.append("user/message", { turn: 1, message: user });
  await session.append("step/start", { turn: 1, step: 1 });
  await session.append("assistant/message", { turn: 1, step: 1, message: assistant });
  await session.append("tool/call", { turn: 1, step: 1, callId: started, name: "write", arguments: "{}" });

  const firstRecovery = recoverInterruptedSession(session);
  const concurrentRecovery = recoverInterruptedSession(session);
  const [recovered, duplicate] = await Promise.all([firstRecovery, concurrentRecovery]);
  assert.deepEqual(duplicate, []);
  assert.deepEqual(
    recovered.filter((event) => event.type === "tool/result").map((event) => event.type === "tool/result" ? event.payload.error?.code : undefined),
    [TOOL_OUTCOME_UNKNOWN, TOOL_NOT_STARTED]
  );
  assert.deepEqual(recovered.slice(-2).map((event) => event.type), ["step/end", "turn/end"]);
  const last = recovered.at(-1);
  assert.equal(last?.type === "turn/end" ? last.payload.reason : undefined, "interrupted");
  assert.equal((await recoverInterruptedSession(session)).length, 0);

  const projection = projectSession(session.events);
  assert.equal(projection.status, "interrupted");
  assert.equal(projection.pendingToolCalls.length, 0);
  assert.deepEqual(projection.messages.map((message) => message.id), ["user-1", "assistant-1", "recovery-call-started", "recovery-call-unstarted"]);
});
