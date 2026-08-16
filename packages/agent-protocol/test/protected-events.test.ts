import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  CallId,
  CandidateId,
  Digest,
  EventId,
  PROTECTION_POLICY_DIGEST_V1,
  RunId,
  SessionId,
  createAgentSessionEvent,
  createProtectedTextV1,
  createRuntimeEffectCommitmentBinderV1,
  deriveToolEffectKindV1,
  isAgentSessionEventV1,
  protectAgentSessionPayloadV1
} from "../src/index.js";

const governanceDigest = "1".repeat(64) as Digest;
const harnessDigest = "2".repeat(64) as Digest;

test("durable events accept only protected payloads and bind the protection profile", () => {
  const payload = protectAgentSessionPayloadV1("session/created", {
    cwd: "/work/13800138000/project",
    labels: {
      owner: "alice@example.com",
      credential: "sk-runtime-only-credential-material"
    }
  });
  const event = createAgentSessionEvent({
    eventId: EventId("event-protected-1"),
    sessionId: SessionId("session-protected-1"),
    seq: 0,
    occurredAt: "2026-08-16T00:00:00.000Z",
    type: "session/created",
    payload
  });

  assert.equal(event.protectionProfile, AGENT_SESSION_PROTECTION_PROFILE_V1);
  assert.equal(event.protectionPolicyDigest, PROTECTION_POLICY_DIGEST_V1);
  assert.equal(event.payloadDigest, payload.digest);
  assert.equal(event.payload.eventType, event.type);
  assert.equal(JSON.stringify(event).includes("13800138000"), false);
  assert.equal(JSON.stringify(event).includes("sk-runtime-only-credential-material"), false);
  assert.equal(JSON.stringify(event).includes("alice@example.com"), true);
  assert.equal(isAgentSessionEventV1(event), true);

  assert.throws(() => createAgentSessionEvent({
    eventId: EventId("event-raw-1"),
    sessionId: SessionId("session-protected-1"),
    seq: 0,
    occurredAt: "2026-08-16T00:00:00.000Z",
    type: "session/created",
    payload: { cwd: "/tmp/raw" }
  } as never), /protected session payload/i);
});

test("durable event controls reject protected material and cross-field tampering", () => {
  const payload = protectAgentSessionPayloadV1("turn/start", { turn: 1 });
  assert.throws(() => createAgentSessionEvent({
    eventId: EventId("event-13800138000"),
    sessionId: SessionId("session-protected-2"),
    seq: 0,
    occurredAt: "2026-08-16T00:00:00.000Z",
    type: "turn/start",
    payload
  }), /event identifier/i);

  const event = createAgentSessionEvent({
    eventId: EventId("event-protected-2"),
    sessionId: SessionId("session-protected-2"),
    seq: 0,
    occurredAt: "2026-08-16T00:00:00.000Z",
    type: "turn/start",
    payload
  });
  assert.equal(isAgentSessionEventV1({
    ...event,
    protectionPolicyDigest: "0".repeat(64)
  }), false);
  assert.equal(isAgentSessionEventV1({
    ...event,
    payload: protectAgentSessionPayloadV1("step/start", { turn: 1, step: 1 })
  }), false);
});

test("event creation rejects accessors and proxies without invoking caller code", () => {
  const payload = protectAgentSessionPayloadV1("turn/start", { turn: 1 });
  let getterReads = 0;
  const accessor = {
    sessionId: SessionId("session-accessor"),
    seq: 0,
    occurredAt: "2026-08-16T00:00:00.000Z",
    type: "turn/start",
    payload
  } as Record<string, unknown>;
  Object.defineProperty(accessor, "eventId", {
    enumerable: true,
    get() {
      getterReads += 1;
      return EventId("event-accessor");
    }
  });
  assert.throws(() => createAgentSessionEvent(accessor as never), /event input/i);
  assert.equal(getterReads, 0);

  const { proxy, revoke } = Proxy.revocable({
    eventId: EventId("event-revoked"),
    sessionId: SessionId("session-revoked"),
    seq: 0,
    occurredAt: "2026-08-16T00:00:00.000Z",
    type: "turn/start" as const,
    payload
  }, {});
  revoke();
  assert.throws(() => createAgentSessionEvent(proxy), /event input/i);
});

test("durable tool calls require an effect commitment bound to the full event envelope", () => {
  const sessionId = SessionId("effect-session");
  const runId = RunId("effect-run");
  const candidateId = CandidateId("effect-candidate");
  const callId = CallId("effect-call");
  const argumentsJson = '{"path":"README.md"}';
  const binder = createRuntimeEffectCommitmentBinderV1({ governanceDigest, harnessDigest });
  try {
    const handle = binder.bind({
      effectKind: deriveToolEffectKindV1("read_file"),
      sessionId,
      runId,
      candidateId,
      turn: 1,
      step: 1,
      internalEffectId: callId,
      protectedInput: createProtectedTextV1(argumentsJson),
      raw: { kind: "text", value: argumentsJson }
    });
    const payload = protectAgentSessionPayloadV1("tool/call", {
      turn: 1,
      step: 1,
      callId,
      name: "read_file",
      arguments: argumentsJson,
      commitment: handle.commitment
    });
    const event = createAgentSessionEvent({
      eventId: EventId("effect-event"),
      sessionId,
      seq: 0,
      occurredAt: "2026-08-16T00:00:00.000Z",
      type: "tool/call",
      runId,
      candidateId,
      payload
    });

    assert.deepEqual(event.payload.publicControls.binding, handle.commitment);
    assert.equal(Object.hasOwn(event.payload.publicControls, "arguments"), false);
    assert.equal(JSON.stringify(event).includes(argumentsJson), false);
    assert.equal(isAgentSessionEventV1(event), true);

    assert.throws(() => createAgentSessionEvent({
      eventId: EventId("effect-event-mismatch"),
      sessionId,
      seq: 0,
      occurredAt: "2026-08-16T00:00:00.000Z",
      type: "tool/call",
      runId,
      candidateId: CandidateId("other-candidate"),
      payload
    }), /effect commitment.*envelope|tool call.*binding/i);
    assert.throws(() => protectAgentSessionPayloadV1("tool/call", {
      turn: 1,
      step: 1,
      callId,
      name: "read_file",
      arguments: '{"path":"OTHER"}',
      commitment: handle.commitment
    }), /effect commitment|protected.*input|binding/i);
    const forgedJsonKind = {
      ...handle.commitment,
      rawKind: "json" as const
    };
    assert.throws(() => protectAgentSessionPayloadV1("tool/call", {
      turn: 1,
      step: 1,
      callId,
      name: "read_file",
      arguments: argumentsJson,
      commitment: forgedJsonKind
    }), /effect commitment|raw kind|binding/i);
  } finally {
    binder.dispose();
  }
});
