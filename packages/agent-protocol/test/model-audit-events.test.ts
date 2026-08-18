// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  CandidateId,
  Digest,
  EventId,
  RunId,
  SessionId,
  createAgentSessionEvent,
  createModelAttemptStartedV1,
  createModelAttemptTerminalV1,
  createModelPricingSnapshotV1,
  isAgentSessionEventV1,
  protectAgentSessionPayloadV1
} from "../src/index.js";

const digest = (character: string): string => character.repeat(64);

test("model attempt events durably bind a terminal audit to its started event", () => {
  const started = createModelAttemptStartedV1({
    providerId: "provider-safe",
    modelId: "model-safe",
    apiFormat: "openai_responses",
    attempt: 1,
    protectedRequestDigest: digest("a"),
    routeDigest: digest("b"),
    pricing: createModelPricingSnapshotV1({
      inputUsdPerMillion: "1.25",
      outputUsdPerMillion: "2.5"
    })
  });
  const common = {
    sessionId: SessionId("session-model-audit"),
    runId: RunId("run-model-audit"),
    candidateId: CandidateId("candidate-model-audit")
  };
  const startedEvent = createAgentSessionEvent({
    ...common,
    eventId: EventId("event-model-started"),
    seq: 4,
    occurredAt: "2026-08-18T00:00:00.000Z",
    type: "model/attempt-started",
    payload: protectAgentSessionPayloadV1("model/attempt-started", {
      turn: 1,
      step: 1,
      attempt: started
    }),
    previousDigest: Digest(digest("c"))
  });
  const terminal = createModelAttemptTerminalV1({
    started,
    dispatchState: "dispatched",
    outcome: "completed",
    statusCode: 200,
    retryable: false,
    fallbackAllowed: false,
    usageState: "complete",
    usage: { inputTokens: 3, outputTokens: 2 }
  });
  const auditEvent = createAgentSessionEvent({
    ...common,
    eventId: EventId("event-model-audit"),
    seq: 5,
    occurredAt: "2026-08-18T00:00:01.000Z",
    type: "model/audit",
    payload: protectAgentSessionPayloadV1("model/audit", {
      turn: 1,
      step: 1,
      startedEventId: startedEvent.eventId,
      startedDigest: startedEvent.digest,
      terminal
    }),
    previousDigest: startedEvent.digest
  });

  assert.equal(startedEvent.payload.publicControls.attempt.kind, "model-attempt-started");
  assert.equal(auditEvent.payload.publicControls.startedEventId, startedEvent.eventId);
  assert.equal(auditEvent.payload.publicControls.startedDigest, startedEvent.digest);
  assert.equal(auditEvent.payload.publicControls.terminal.cost.status, "estimated");
  assert.equal(isAgentSessionEventV1(JSON.parse(JSON.stringify(startedEvent))), true);
  assert.equal(isAgentSessionEventV1(JSON.parse(JSON.stringify(auditEvent))), true);
  assert.equal(JSON.stringify(auditEvent).includes("Authorization"), false);
});

test("model attempt events require run/candidate bindings and exact protected audit DTOs", () => {
  const started = createModelAttemptStartedV1({
    providerId: "provider-safe",
    modelId: "model-safe",
    apiFormat: "anthropic_messages",
    attempt: 1,
    protectedRequestDigest: digest("a"),
    routeDigest: digest("b"),
    pricing: createModelPricingSnapshotV1({})
  });
  const payload = protectAgentSessionPayloadV1("model/attempt-started", {
    turn: 1,
    step: 1,
    attempt: started
  });
  assert.throws(() => createAgentSessionEvent({
    eventId: EventId("event-model-started"),
    sessionId: SessionId("session-model-audit"),
    seq: 1,
    occurredAt: "2026-08-18T00:00:00.000Z",
    type: "model/attempt-started",
    payload,
    previousDigest: Digest(digest("c"))
  }), /run|candidate|model attempt/iu);
  assert.throws(() => protectAgentSessionPayloadV1("model/audit", {
    turn: 1,
    step: 1,
    startedEventId: EventId("event-model-started"),
    startedDigest: digest("c"),
    terminal: { ...started, kind: "model-attempt-terminal" }
  } as never), /audit|terminal|payload/iu);
});
