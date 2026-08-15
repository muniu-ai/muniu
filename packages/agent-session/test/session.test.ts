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
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  projectSession,
  recoverInterruptedSession
} from "../src/index.js";

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

  const reopened = await new JsonlAgentSessionStore(root).open(SessionId("disk-session"));
  assert.equal(reopened.header.cwd, "/tmp/project");
  assert.deepEqual(reopened.events.map((event) => event.type), ["session/created", "turn/start"]);
});

test("JSONL load truncates a torn final line but fails closed on middle corruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-tail-"));
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("tail-session") });
  await session.append("turn/start", { turn: 1 });
  const eventsPath = path.join(root, "sessions", "tail-session", "events.jsonl");
  const committed = await readFile(eventsPath);
  await writeFile(eventsPath, Buffer.concat([committed, Buffer.from('{"schemaVersion":1')]));

  const reopened = await new JsonlAgentSessionStore(root).open(SessionId("tail-session"));
  assert.equal(reopened.events.length, 2);
  assert.deepEqual(await readFile(eventsPath), committed);

  const lines = committed.toString("utf8").trimEnd().split("\n");
  await writeFile(eventsPath, `${lines[0]}\nnot-json\n${lines[1]}\n`);
  await assert.rejects(() => new JsonlAgentSessionStore(root).open(SessionId("tail-session")), /corrupt.*line 2/i);
});

test("JSONL load rejects empty logs, a non-creation first event, and header/event id mismatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "muniu-session-binding-"));
  const store = new JsonlAgentSessionStore(root);
  const session = await store.create({ sessionId: SessionId("bound-session") });
  const eventsPath = path.join(root, "sessions", "bound-session", "events.jsonl");

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

  const recovered = await recoverInterruptedSession(session);
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
