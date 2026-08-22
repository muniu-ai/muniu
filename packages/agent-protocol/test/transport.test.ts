import assert from "node:assert/strict";
import test from "node:test";

import {
  EventId,
  SessionId,
  assertAgentSessionCreateRequestV1,
  createAgentSessionEvent,
  inspectAgentApprovalDecisionRequestV1,
  inspectAgentApprovalResponseV1,
  inspectAgentErrorResponseV1,
  inspectAgentMessageRequestV1,
  inspectAgentMessageRequestV2,
  inspectAgentAttachmentUploadRequestV1,
  inspectAgentModelBindingV1,
  inspectAgentSessionControlRequestV1,
  inspectAgentSessionCreateRequestV1,
  inspectAgentSessionCreateRequestV2,
  inspectAgentSessionViewV1,
  protectAgentSessionPayloadV1
} from "../src/index.js";

const binding = {
  schemaVersion: 1,
  kind: "agent-model-binding",
  providerId: "mock",
  modelId: "local-mock"
} as const;

function createdEvent() {
  return createAgentSessionEvent({
    eventId: EventId("transport-created-event"),
    sessionId: SessionId("transport-session"),
    seq: 0,
    occurredAt: "2026-08-17T00:00:00.000Z",
    type: "session/created",
    payload: protectAgentSessionPayloadV1("session/created", {})
  });
}

test("transport v1 request DTOs survive JSON roundtrip and return detached frozen values", () => {
  const source = {
    schemaVersion: 1,
    kind: "agent-session-create-request",
    clientRequestId: "transport-create-request",
    modelBinding: binding,
    cwd: "/Users/Alice/project",
    labels: {
      owner: "Alice",
      email: "alice@example.com",
      address: "上海市浦东新区",
      phone: "13800138000"
    }
  };
  const inspected = inspectAgentSessionCreateRequestV1(JSON.parse(JSON.stringify(source)));
  assert.ok(inspected);
  assert.deepEqual(inspected, source);
  assert.equal(Object.isFrozen(inspected), true);
  assert.equal(Object.isFrozen(inspected.modelBinding), true);
  assert.equal(Object.isFrozen(inspected.labels), true);
  source.labels.owner = "Mallory";
  assert.equal(inspected.labels?.owner, "Alice");
  const asserted = assertAgentSessionCreateRequestV1(source);
  source.cwd = "/changed";
  assert.equal(asserted.cwd, "/Users/Alice/project");

  assert.deepEqual(inspectAgentMessageRequestV1({
    schemaVersion: 1,
    kind: "agent-message-request",
    clientRequestId: "transport-message-request",
    prompt: "姓名 Alice；邮箱 alice@example.com；token=secret"
  }), {
    schemaVersion: 1,
    kind: "agent-message-request",
    clientRequestId: "transport-message-request",
    prompt: "姓名 Alice；邮箱 alice@example.com；token=secret"
  });
  assert.deepEqual(inspectAgentSessionControlRequestV1({
    schemaVersion: 1,
    kind: "agent-session-control-request",
    clientRequestId: "transport-control-request"
  }), {
    schemaVersion: 1,
    kind: "agent-session-control-request",
    clientRequestId: "transport-control-request"
  });
  assert.deepEqual(inspectAgentApprovalDecisionRequestV1({
    schemaVersion: 1,
    kind: "agent-approval-decision-request",
    clientRequestId: "transport-approval-request",
    decision: "approve_session_scope"
  }), {
    schemaVersion: 1,
    kind: "agent-approval-decision-request",
    clientRequestId: "transport-approval-request",
    decision: "approve_session_scope"
  });
});

test("transport v1 inspectors reject missing versions, unknown keys, unsafe controls, and bad enums", () => {
  assert.equal(inspectAgentSessionCreateRequestV1({
    clientRequestId: "missing-version",
    kind: "agent-session-create-request",
    modelBinding: binding
  }), undefined);
  assert.equal(inspectAgentSessionCreateRequestV1({
    schemaVersion: 2,
    kind: "agent-session-create-request",
    clientRequestId: "future-version",
    modelBinding: binding
  }), undefined);
  assert.equal(inspectAgentSessionCreateRequestV1({
    schemaVersion: 1,
    kind: "agent-session-create-request",
    clientRequestId: "unknown-key",
    modelBinding: binding,
    debug: true
  }), undefined);
  assert.equal(inspectAgentSessionCreateRequestV1({
    schemaVersion: 1,
    kind: "agent-session-create-request",
    clientRequestId: "13800138000",
    modelBinding: binding
  }), undefined);
  assert.equal(inspectAgentModelBindingV1({
    schemaVersion: 1,
    kind: "agent-model-binding",
    providerId: "Bearer secret-token",
    modelId: "local-mock"
  }), undefined);
  assert.equal(inspectAgentApprovalDecisionRequestV1({
    schemaVersion: 1,
    kind: "agent-approval-decision-request",
    clientRequestId: "approval-enum",
    decision: "approve_forever"
  }), undefined);
  assert.equal(inspectAgentMessageRequestV1({
    schemaVersion: 1,
    kind: "agent-message-request",
    clientRequestId: "empty-prompt",
    prompt: ""
  }), undefined);
});

test("transport v1 inspectors reject Proxy and accessors without executing caller code", () => {
  let reads = 0;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(accessor, {
    schemaVersion: { value: 1, enumerable: true },
    kind: { value: "agent-session-create-request", enumerable: true },
    clientRequestId: {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("RAW-ACCESSOR-SECRET");
      }
    },
    modelBinding: { value: binding, enumerable: true }
  });
  assert.equal(inspectAgentSessionCreateRequestV1(accessor), undefined);
  assert.equal(reads, 0);

  const { proxy, revoke } = Proxy.revocable({
    schemaVersion: 1,
    kind: "agent-session-create-request",
    clientRequestId: "revoked-request",
    modelBinding: binding
  }, {});
  revoke();
  assert.equal(inspectAgentSessionCreateRequestV1(proxy), undefined);

  let nestedReads = 0;
  const hostileBinding = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(hostileBinding, {
    schemaVersion: { value: 1, enumerable: true },
    kind: { value: "agent-model-binding", enumerable: true },
    providerId: {
      enumerable: true,
      get() {
        nestedReads += 1;
        throw new Error("RAW-NESTED-SECRET");
      }
    },
    modelId: { value: "local-mock", enumerable: true }
  });
  assert.equal(inspectAgentSessionCreateRequestV1({
    schemaVersion: 1,
    kind: "agent-session-create-request",
    clientRequestId: "nested-accessor",
    modelBinding: hostileBinding
  }), undefined);
  assert.equal(nestedReads, 0);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(inspectAgentSessionCreateRequestV1({
    schemaVersion: 1,
    kind: "agent-session-create-request",
    clientRequestId: "cyclic-labels",
    modelBinding: binding,
    labels: cyclic
  }), undefined);

  const oversizedLabels = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`label-${index}`, "x".repeat(16_384)])
  );
  assert.equal(inspectAgentSessionCreateRequestV1({
    schemaVersion: 1,
    kind: "agent-session-create-request",
    clientRequestId: "aggregate-budget",
    modelBinding: binding,
    labels: oversizedLabels
  }), undefined);
});

test("transport v1 response DTOs are exact, versioned, and expose a bounded event cursor", () => {
  const event = createdEvent();
  const view = {
    schemaVersion: 1,
    kind: "agent-session-view",
    sessionId: "transport-session",
    state: "idle",
    modelBinding: binding,
    eventCursor: { lastSeq: event.seq, lastDigest: event.digest }
  };
  assert.deepEqual(inspectAgentSessionViewV1(JSON.parse(JSON.stringify(view))), view);
  const waitingView = { ...view, state: "waiting-approval" };
  assert.deepEqual(
    inspectAgentSessionViewV1(JSON.parse(JSON.stringify(waitingView))),
    waitingView
  );
  assert.equal(inspectAgentSessionViewV1({ ...view, state: "unknown" }), undefined);
  assert.equal(inspectAgentSessionViewV1({
    ...view,
    eventCursor: { lastSeq: 0, lastDigest: "0" }
  }), undefined);
  assert.equal(inspectAgentSessionViewV1({ ...view, internalProjection: {} }), undefined);

  assert.deepEqual(inspectAgentErrorResponseV1({
    schemaVersion: 1,
    kind: "agent-error-response",
    error: "SESSION_NOT_FOUND"
  }), {
    schemaVersion: 1,
    kind: "agent-error-response",
    error: "SESSION_NOT_FOUND"
  });
  assert.deepEqual(inspectAgentApprovalResponseV1({
    schemaVersion: 1,
    kind: "agent-approval-response",
    sessionId: "transport-session",
    approvalId: "transport-approval",
    decision: "deny",
    status: "resolved"
  }), {
    schemaVersion: 1,
    kind: "agent-approval-response",
    sessionId: "transport-session",
    approvalId: "transport-approval",
    decision: "deny",
    status: "resolved"
  });
  assert.equal(inspectAgentApprovalResponseV1({
    schemaVersion: 1,
    kind: "agent-approval-response",
    sessionId: "transport-session",
    approvalId: "transport-approval",
    decision: "deny",
    status: "pending"
  }), undefined);
});

test("transport v2 closes session/image request vocabularies and keeps v1 text-only", () => {
  const create = {
    schemaVersion: 2,
    kind: "agent-session-create-request",
    clientRequestId: "transport-create-v2",
    modelBinding: binding
  } as const;
  assert.deepEqual(inspectAgentSessionCreateRequestV2(create), create);
  assert.equal(inspectAgentSessionCreateRequestV1(create), undefined);

  const message = {
    schemaVersion: 2,
    kind: "agent-message-request",
    clientRequestId: "transport-message-v2",
    prompt: "",
    attachmentIds: ["attachment-one"]
  } as const;
  assert.deepEqual(inspectAgentMessageRequestV2(message), message);
  assert.equal(inspectAgentMessageRequestV1(message), undefined);
  assert.equal(inspectAgentMessageRequestV2({ ...message, attachmentIds: [] }), undefined);
  assert.equal(inspectAgentMessageRequestV2({
    ...message,
    attachmentIds: Array.from({ length: 257 }, (_value, index) => `attachment-${index}`)
  }), undefined);

  const upload = {
    schemaVersion: 1,
    kind: "agent-attachment-upload-request",
    clientRequestId: "transport-upload-v1",
    contentType: "image/png",
    dataBase64: Buffer.from("image").toString("base64"),
    sha256: "a".repeat(64),
    byteLength: 5
  } as const;
  assert.deepEqual(inspectAgentAttachmentUploadRequestV1(upload), upload);
  assert.equal(inspectAgentAttachmentUploadRequestV1({ ...upload, extra: true }), undefined);
  assert.equal(inspectAgentAttachmentUploadRequestV1({ ...upload, dataBase64: "not base64" }), undefined);
});
