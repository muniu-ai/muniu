import assert from "node:assert/strict";
import test from "node:test";

import {
  CallId,
  EventId,
  MessageId,
  SessionId,
  canonicalJson,
  createAgentSessionEvent,
  createAssistantMessage,
  createUserMessage,
  isAgentSessionEventV1,
  isJsonValue,
  snapshotJsonValue,
  verifyAgentSessionEventChain
} from "../src/index.js";

test("lossless JSON snapshots detach plain values and reject values JSON would change", () => {
  const source = { nested: [{ ok: true }], count: 3 };
  const snapshot = snapshotJsonValue(source);
  assert.deepEqual(snapshot, source);
  assert.notEqual(snapshot, source);
  assert.notEqual(snapshot?.nested, source.nested);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = new Array(2);
  sparse[1] = "present";
  assert.equal(isJsonValue(cyclic), false);
  assert.equal(isJsonValue(sparse), false);
  assert.equal(isJsonValue(-0), false);
  assert.equal(isJsonValue(Number.POSITIVE_INFINITY), false);
  assert.equal(isJsonValue(new Date()), false);
});

test("canonical JSON and event digests are stable across object key order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), canonicalJson({ a: { x: null, y: true }, z: 1 }));

  const common = {
    eventId: EventId("event-1"),
    sessionId: SessionId("session-1"),
    seq: 0,
    occurredAt: "2026-08-15T00:00:00.000Z",
    type: "session/created" as const
  };
  const first = createAgentSessionEvent({ ...common, payload: { cwd: "/tmp/project", labels: { b: "2", a: "1" } } });
  const second = createAgentSessionEvent({ ...common, payload: { labels: { a: "1", b: "2" }, cwd: "/tmp/project" } });
  assert.equal(first.payloadDigest, second.payloadDigest);
  assert.equal(first.digest, second.digest);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.payload), true);
  assert.throws(() => {
    (first.payload as { cwd?: string }).cwd = "changed";
  }, TypeError);
});

test("event chain verifies monotonic sequence and detects payload tampering", () => {
  const sessionId = SessionId("session-chain");
  const first = createAgentSessionEvent({
    eventId: EventId("event-1"),
    sessionId,
    seq: 0,
    occurredAt: "2026-08-15T00:00:00.000Z",
    type: "session/created",
    payload: {}
  });
  const user = createUserMessage({
    id: MessageId("message-1"),
    content: [{ type: "text", text: "hello" }],
    source: { kind: "user" }
  });
  const second = createAgentSessionEvent({
    eventId: EventId("event-2"),
    sessionId,
    seq: 1,
    occurredAt: "2026-08-15T00:00:01.000Z",
    type: "user/message",
    previousDigest: first.digest,
    payload: { turn: 1, message: user }
  });
  assert.doesNotThrow(() => verifyAgentSessionEventChain([first, second]));

  const tampered = structuredClone(second) as typeof second;
  (tampered.payload.message.content[0] as { type: "text"; text: string }).text = "changed";
  assert.throws(() => verifyAgentSessionEventChain([first, tampered]), /payload digest/i);

  assert.equal(isAgentSessionEventV1({ ...first, type: "plugin/arbitrary" }), false);
});

test("message helpers close the model vocabulary and freeze tool-call content", () => {
  const message = createAssistantMessage({
    id: MessageId("assistant-1"),
    content: [{ type: "tool-call", id: CallId("call-1"), name: "read", arguments: "{}" }],
    source: { kind: "model", provider: "mock", model: "scripted" }
  });
  assert.equal(message.role, "assistant");
  assert.equal(message.content[0]?.type, "tool-call");
  assert.equal(Object.isFrozen(message.content), true);
});
