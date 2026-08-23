// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  EventId,
  SessionId,
  createAgentEventV3,
  createAgentSessionEventV2,
  createProtectedJsonViewV1,
  migrateAgentSessionEventToV3,
  protectAgentSessionPayloadV2,
  verifyAgentEventV3Chain,
  type AgentEventV3
} from "../src/index.js";

function oldCreatedEvent() {
  return createAgentSessionEventV2({
    eventId: EventId("evt-created"),
    sessionId: SessionId("session-migration"),
    seq: 0,
    occurredAt: "2026-08-23T00:00:00.000Z",
    type: "session/created",
    payload: protectAgentSessionPayloadV2("session/created", {
      cwd: "/workspace/project",
      modelBinding: {
        schemaVersion: 1,
        kind: "agent-model-binding",
        providerId: "openai",
        modelId: "gpt-5"
      }
    })
  });
}

test("creates a strict V3 event and verifies its digest chain", () => {
  const first = createAgentEventV3({
    eventId: EventId("eventv-first"),
    threadId: SessionId("thread-one"),
    sequence: 0,
    occurredAt: "2026-08-23T00:00:00.000Z",
    type: "thread/created",
    correlationId: "thread-one",
    publicControls: { source: "appServer" },
    protectedContent: createProtectedJsonViewV1({ cwd: "/workspace/project" })
  });
  const second = createAgentEventV3({
    eventId: EventId("eventv-second"),
    threadId: SessionId("thread-one"),
    turnId: "turn-one",
    sequence: 1,
    occurredAt: "2026-08-23T00:00:01.000Z",
    type: "turn/started",
    causationId: first.eventId,
    correlationId: "thread-one",
    publicControls: { ordinal: 1 },
    protectedContent: createProtectedJsonViewV1(null),
    previousDigest: first.digest
  });

  verifyAgentEventV3Chain([first, second]);
  const duplicateId = createAgentEventV3({
    eventId: first.eventId,
    threadId: first.threadId,
    turnId: "turn-one",
    sequence: 1,
    occurredAt: "2026-08-23T00:00:01.000Z",
    type: "turn/started",
    causationId: first.eventId,
    correlationId: first.threadId,
    publicControls: { ordinal: 1 },
    protectedContent: createProtectedJsonViewV1(null),
    previousDigest: first.digest
  });
  assert.throws(() => verifyAgentEventV3Chain([first, duplicateId]), /identifier|duplicate/iu);
  assert.throws(
    () => verifyAgentEventV3Chain([{ ...second, previousDigest: undefined } as unknown as AgentEventV3]),
    /invalid.*schema|previous digest/iu
  );
  assert.throws(() => createAgentEventV3({
    eventId: EventId("eventv-reasoning"),
    threadId: SessionId("thread-one"),
    sequence: 0,
    occurredAt: "2026-08-23T00:00:00.000Z",
    type: "item/recorded",
    correlationId: "thread-one",
    publicControls: { rawReasoning: "must not persist" },
    protectedContent: createProtectedJsonViewV1(null)
  }), /hidden reasoning/iu);
});

test("migrates V2 events one-to-one with stable IDs and source evidence", () => {
  const oldCreated = oldCreatedEvent();
  const oldTurn = createAgentSessionEventV2({
    eventId: EventId("evt-turn"),
    sessionId: oldCreated.sessionId,
    seq: 1,
    occurredAt: "2026-08-23T00:00:01.000Z",
    type: "turn/start",
    payload: protectAgentSessionPayloadV2("turn/start", { turn: 1 }),
    previousDigest: oldCreated.digest
  });
  const first = migrateAgentSessionEventToV3(oldCreated);
  const second = migrateAgentSessionEventToV3(oldTurn, first);
  const replay = migrateAgentSessionEventToV3(oldTurn, first);

  verifyAgentEventV3Chain([first, second]);
  assert.equal(first.threadId, oldCreated.sessionId);
  assert.equal(first.type, "thread/created");
  assert.equal(second.type, "turn/started");
  assert.equal(second.eventId, replay.eventId);
  assert.equal(second.turnId, replay.turnId);
  assert.deepEqual(second.source, {
    schemaVersion: 2,
    sessionId: oldTurn.sessionId,
    eventId: oldTurn.eventId,
    payloadDigest: oldTurn.payloadDigest,
    eventDigest: oldTurn.digest
  });
});
