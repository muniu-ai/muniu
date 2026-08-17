import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";

import { JsonlAgentSessionStore } from "@mn/agent-session";
import {
  CallId,
  CandidateId,
  Digest,
  MessageId,
  RunId,
  SessionId,
  createAssistantMessage,
  createProtectedTextV1,
  createRuntimeEffectCommitmentBinderV1,
  deriveToolEffectKindV1,
  inspectAgentErrorResponseV1,
  inspectAgentSessionViewV1
} from "@mn/agent-protocol";

import { registerAgentSessionRoutes } from "../src/agentSessionRoutes.js";
import { buildServer } from "../src/server.js";
import { LocalMockAgentSessionService } from "../src/agentSessionService.js";

function appAt(root: string) {
  return buildServer({
    mniuRoot: root,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
}

const MOCK_MODEL_BINDING_V1 = Object.freeze({
  schemaVersion: 1 as const,
  kind: "agent-model-binding" as const,
  providerId: "mock",
  modelId: "local-mock"
});

function createRequestV1(
  clientRequestId: string,
  options: { cwd?: string; labels?: Record<string, string> } = {}
) {
  return {
    schemaVersion: 1 as const,
    kind: "agent-session-create-request" as const,
    clientRequestId,
    modelBinding: MOCK_MODEL_BINDING_V1,
    ...options
  };
}

function messageRequestV1(clientRequestId: string, prompt: string) {
  return {
    schemaVersion: 1 as const,
    kind: "agent-message-request" as const,
    clientRequestId,
    prompt
  };
}

function controlRequestV1(clientRequestId: string) {
  return {
    schemaVersion: 1 as const,
    kind: "agent-session-control-request" as const,
    clientRequestId
  };
}

function approvalRequestV1(
  clientRequestId: string,
  decision: "approve_once" | "approve_session_scope" | "deny"
) {
  return {
    schemaVersion: 1 as const,
    kind: "agent-approval-decision-request" as const,
    clientRequestId,
    decision
  };
}

test("agent routes require exact V1 DTOs and return bounded authoritative views", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-v1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));

  const legacy = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { clientRequestId: "legacy-create" }
  });
  assert.equal(legacy.statusCode, 400, legacy.body);
  assert.deepEqual(inspectAgentErrorResponseV1(legacy.json()), legacy.json());

  const malformed = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    headers: { "content-type": "application/json" },
    payload: "{"
  });
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.deepEqual(inspectAgentErrorResponseV1(malformed.json()), malformed.json());

  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: {
      schemaVersion: 1,
      kind: "agent-session-create-request",
      clientRequestId: "v1-create",
      modelBinding: MOCK_MODEL_BINDING_V1
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  const createdView = inspectAgentSessionViewV1(created.json());
  assert.ok(createdView);
  assert.deepEqual(createdView.modelBinding, MOCK_MODEL_BINDING_V1);
  assert.equal(Object.hasOwn(created.json(), "events"), false);
  assert.equal(Object.hasOwn(created.json(), "projection"), false);
  assert.equal(Object.hasOwn(created.json(), "header"), false);
  const header = JSON.parse(await readFile(
    join(root, "agent-service", "sessions", createdView.sessionId, "header.json"),
    "utf8"
  )) as { modelBinding?: unknown };
  assert.deepEqual(header.modelBinding, MOCK_MODEL_BINDING_V1);

  const legacyMessage = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${createdView.sessionId}/messages`,
    payload: { clientRequestId: "legacy-message", prompt: "legacy" }
  });
  assert.equal(legacyMessage.statusCode, 400, legacyMessage.body);
  assert.deepEqual(inspectAgentErrorResponseV1(legacyMessage.json()), legacyMessage.json());

  const message = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${createdView.sessionId}/messages`,
    payload: {
      schemaVersion: 1,
      kind: "agent-message-request",
      clientRequestId: "v1-message",
      prompt: "hello"
    }
  });
  assert.equal(message.statusCode, 200, message.body);
  assert.ok(inspectAgentSessionViewV1(message.json()));
  const inspected = await app.inject({
    method: "GET",
    url: `/v1/agent-sessions/${createdView.sessionId}`
  });
  assert.deepEqual(inspectAgentSessionViewV1(inspected.json()), inspected.json());

  const missing = await app.inject({
    method: "GET",
    url: "/v1/agent-sessions/missing-v1-session"
  });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.deepEqual(inspectAgentErrorResponseV1(missing.json()), missing.json());

  const unknownApproval = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${createdView.sessionId}/approvals/unknown-approval`,
    payload: {
      schemaVersion: 1,
      kind: "agent-approval-decision-request",
      clientRequestId: "unknown-approval-decision",
      decision: "deny"
    }
  });
  assert.equal(unknownApproval.statusCode, 404, unknownApproval.body);
  assert.deepEqual(inspectAgentErrorResponseV1(unknownApproval.json()), unknownApproval.json());
  assert.doesNotMatch(unknownApproval.body, /unknown-approval/u);
});

test("an existing pending approval is a fixed versioned 409 until B4b2", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-pending-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  t.after(() => service.dispose().catch(() => undefined));
  await service.create(createRequestV1("initialize-pending-approval-service"));

  const store = (service as unknown as { store: JsonlAgentSessionStore }).store;
  const sessionId = SessionId("pending-approval-api-session");
  const session = await store.create({ sessionId, modelBinding: MOCK_MODEL_BINDING_V1 });
  const runId = RunId("pending-approval-api-run");
  const candidateId = CandidateId("pending-approval-api-candidate");
  const callId = CallId("pending-approval-api-call");
  const assistant = createAssistantMessage({
    id: MessageId("pending-approval-api-message"),
    content: [{ type: "tool-call", id: callId, name: "write", arguments: "{}" }],
    source: { kind: "model", provider: "mock", model: "local-mock" }
  });
  const binder = createRuntimeEffectCommitmentBinderV1({
    governanceDigest: Digest("a".repeat(64)),
    harnessDigest: Digest("b".repeat(64))
  });
  const handle = binder.bind({
    effectKind: deriveToolEffectKindV1("write"),
    sessionId,
    runId,
    candidateId,
    turn: 1,
    step: 1,
    internalEffectId: callId,
    protectedInput: createProtectedTextV1("{}"),
    raw: { kind: "text", value: "{}" }
  });
  await session.append("turn/start", { turn: 1 }, { runId, candidateId });
  await session.append("step/start", { turn: 1, step: 1 }, { runId, candidateId });
  await session.append(
    "assistant/message",
    { turn: 1, step: 1, message: assistant },
    { runId, candidateId }
  );
  await session.append("approval/requested", {
    binding: {
      schemaVersion: 1,
      approvalId: "pending-approval-api",
      scope: handle.commitment.effectKind,
      risk: "side-effecting",
      callId,
      name: "write",
      commitment: handle.commitment
    }
  }, { runId, candidateId });
  binder.dispose();

  const app = Fastify({ logger: false });
  registerAgentSessionRoutes(app, { getService: async () => service });
  t.after(() => app.close().catch(() => undefined));
  const response = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/pending-approval-api`,
    payload: approvalRequestV1("pending-approval-api-decision", "deny")
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, "APPROVAL_DECISION_UNAVAILABLE");
  assert.deepEqual(inspectAgentErrorResponseV1(response.json()), response.json());
});

test("agent session routes run multiple protected mock turns and resume SSE by cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));

  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("create-request-1", {
      cwd: "/Users/alice/project",
      labels: { owner: "Alice", email: "alice@example.com" }
    })
  });
  assert.equal(created.statusCode, 201, created.body);
  const sessionId = (created.json() as { sessionId: string }).sessionId;

  const first = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1(
      "message-request-1",
      "Alice alice@example.com /Users/alice/project 手机：13800138000 身份证：11010519491231002X token=top-secret"
    )
  });
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = first.body;
  assert.doesNotMatch(firstBody, /13800138000|11010519491231002X|top-secret/u);
  const mutationFacts = await readFile(join(root, "agent-service", "mutations.jsonl"), "utf8");
  assert.doesNotMatch(mutationFacts, /13800138000|11010519491231002X|top-secret/u);
  const eventFacts = await readFile(
    join(root, "agent-service", "sessions", sessionId, "events.jsonl"),
    "utf8"
  );
  assert.doesNotMatch(eventFacts, /13800138000|11010519491231002X|top-secret/u);
  assert.match(eventFacts, /Alice/u);
  assert.match(eventFacts, /alice@example\.com/u);
  assert.match(eventFacts, /\/Users\/alice\/project/u);

  const duplicate = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1("message-request-1", "different input must never execute")
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.body, first.body);

  const second = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1("message-request-2", "second turn")
  });
  assert.equal(second.statusCode, 200, second.body);

  const inspected = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(inspected.statusCode, 200, inspected.body);
  assert.ok(inspectAgentSessionViewV1(inspected.json()));
  const events = eventFacts.trimEnd().split("\n").map((line) => JSON.parse(line) as { seq: number });
  assert.ok(events.length > 1);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index));

});

test("agent mutation DTOs are exact and approvals use the closed decision enum", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-exact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));

  const invalidCreate = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: { ...createRequestV1("create-exact"), unexpected: true }
  });
  assert.equal(invalidCreate.statusCode, 400, invalidCreate.body);
  const unsafeControl = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("13800138000")
  });
  assert.equal(unsafeControl.statusCode, 400, unsafeControl.body);
  assert.doesNotMatch(unsafeControl.body, /13800138000/u);

  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("create-exact-2")
  });
  const sessionId = (created.json() as { sessionId: string }).sessionId;
  const invalidApproval = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/approval-1`,
    payload: {
      ...approvalRequestV1("approval-request-1", "deny"),
      decision: "approve_forever"
    }
  });
  assert.equal(invalidApproval.statusCode, 400, invalidApproval.body);
  for (const [index, decision] of ["approve_once", "approve_session_scope", "deny"].entries()) {
    const approval = await app.inject({
      method: "POST",
      url: `/v1/agent-sessions/${sessionId}/approvals/approval-${index}`,
      payload: approvalRequestV1(
        `approval-request-${index + 2}`,
        decision as "approve_once" | "approve_session_scope" | "deny"
      )
    });
    assert.equal(approval.statusCode, 404, approval.body);
    assert.deepEqual(inspectAgentErrorResponseV1(approval.json()), approval.json());
  }
});

test("agent sessions recover interrupted JSONL facts after restart without replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const durableRoot = join(root, "agent-service");
  const sessionId = SessionId("restart-recovery-session");
  const seed = new JsonlAgentSessionStore(durableRoot);
  const session = await seed.create({ sessionId, modelBinding: MOCK_MODEL_BINDING_V1 });
  await session.append("turn/start", { turn: 1 });
  await session.flush();
  await seed.dispose();

  const app = appAt(root);
  t.after(() => app.close());
  const inspected = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(inspected.statusCode, 200, inspected.body);
  const body = inspected.json() as { state: string };
  assert.equal(body.state, "interrupted");
  const afterFirstRead = await readFile(join(durableRoot, "sessions", sessionId, "events.jsonl"), "utf8");
  const recoveredEvents = afterFirstRead.trimEnd().split("\n").map((line) => JSON.parse(line) as {
    type: string;
    payload: { publicControls?: { reason?: string } };
  });
  assert.equal(recoveredEvents.at(-1)?.type, "turn/end");
  assert.equal(recoveredEvents.at(-1)?.payload.publicControls?.reason, "interrupted");
  assert.equal(recoveredEvents.some((event) => event.type === "assistant/message"), false);
  const secondRead = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(secondRead.statusCode, 200, secondRead.body);
  assert.equal(
    await readFile(join(durableRoot, "sessions", sessionId, "events.jsonl"), "utf8"),
    afterFirstRead,
    "ordinary GET must not append recovery facts"
  );
});

test("a legacy session without a model binding cannot poison service startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-legacy-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const durableRoot = join(root, "agent-service");
  const legacySessionId = SessionId("legacy-session-without-model-binding");
  const seed = new JsonlAgentSessionStore(durableRoot);
  await seed.create({ sessionId: legacySessionId });
  await seed.dispose();

  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("create-beside-legacy-session")
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.ok(inspectAgentSessionViewV1(created.json()));

  const legacyGet = await app.inject({
    method: "GET",
    url: `/v1/agent-sessions/${legacySessionId}`
  });
  assert.equal(legacyGet.statusCode, 503, legacyGet.body);
  assert.equal(legacyGet.json().error, "MODEL_BINDING_UNAVAILABLE");
  assert.deepEqual(inspectAgentErrorResponseV1(legacyGet.json()), legacyGet.json());

  const legacyMessage = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${legacySessionId}/messages`,
    payload: messageRequestV1("legacy-session-message", "must fail closed")
  });
  assert.equal(legacyMessage.statusCode, 409, legacyMessage.body);
  assert.equal(legacyMessage.json().error, "MODEL_BINDING_UNAVAILABLE");
  assert.deepEqual(inspectAgentErrorResponseV1(legacyMessage.json()), legacyMessage.json());
});

test("agent session close and cancel mutations are idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("create-controls")
  });
  const sessionId = created.json().sessionId as string;

  for (const operation of ["cancel", "close"] as const) {
    const payload = controlRequestV1(`${operation}-request`);
    const first = await app.inject({
      method: "POST",
      url: `/v1/agent-sessions/${sessionId}/${operation}`,
      payload
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/agent-sessions/${sessionId}/${operation}`,
      payload
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.body, first.body);
  }
  const blocked = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1("closed-message", "must not run")
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
});

test("concurrent messages serialize monotonic turns and an active run can be cancelled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("create-concurrent")
  });
  const sessionId = created.json().sessionId as string;
  const concurrent = await Promise.all(["a", "b"].map((prompt, index) => app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1(`concurrent-${index}`, prompt)
  })));
  assert.deepEqual(concurrent.map((response) => response.statusCode), [200, 200]);
  const afterConcurrent = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.ok(inspectAgentSessionViewV1(afterConcurrent.json()));
  const concurrentFacts = await readFile(
    join(root, "agent-service", "sessions", sessionId, "events.jsonl"),
    "utf8"
  );
  const turnStarts = concurrentFacts.trimEnd().split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload: { publicControls: { turn?: number } } })
    .filter((event) => event.type === "turn/start")
    .map((event) => event.payload.publicControls.turn);
  assert.deepEqual(turnStarts, [1, 2]);

  const running = app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1("cancelled-message", "cancel me")
  });
  await new Promise<void>((resolve) => { setTimeout(resolve, 8); });
  const cancelled = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/cancel`,
    payload: controlRequestV1("cancel-active")
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().cancelled, true);
  const runResult = await running;
  assert.equal(runResult.statusCode, 200, runResult.body);
  assert.equal(runResult.json().state, "cancelled");
});

test("completed mutation receipts survive restart and never execute twice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-idempotent-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstApp = appAt(root);
  const first = await firstApp.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("restart-create")
  });
  assert.equal(first.statusCode, 201, first.body);
  await firstApp.close();
  const journal = (await readFile(join(root, "agent-service", "mutations.jsonl"), "utf8"))
    .trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const completed = journal.find((record) => record.state === "completed") as {
    receipt: Record<string, unknown>;
  } | undefined;
  assert.ok(completed);
  assert.deepEqual(Object.keys(completed.receipt).sort(), [
    "committedEventDigest",
    "committedSeq",
    "kind",
    "modelBinding",
    "sessionId",
    "state",
    "statusCode"
  ]);
  assert.deepEqual(completed.receipt.modelBinding, MOCK_MODEL_BINDING_V1);

  const restarted = appAt(root);
  t.after(() => restarted.close());
  const duplicate = await restarted.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("restart-create")
  });
  assert.equal(duplicate.statusCode, 201, duplicate.body);
  assert.equal(duplicate.body, first.body);
});

test("a recomputed receipt digest cannot detach the authoritative model binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-binding-receipt-tamper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  const request = createRequestV1("binding-receipt-create");
  const created = await app.inject({ method: "POST", url: "/v1/agent-sessions", payload: request });
  assert.equal(created.statusCode, 201, created.body);
  await app.close();

  const journalPath = join(root, "agent-service", "mutations.jsonl");
  const records = (await readFile(journalPath, "utf8")).trimEnd().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const completedIndex = records.findIndex((record) => record.state === "completed"
    && record.clientRequestId === request.clientRequestId);
  assert.notEqual(completedIndex, -1);
  const completed = records[completedIndex]!;
  const receipt = completed.receipt as Record<string, unknown>;
  const tampered: Record<string, unknown> = {
    ...completed,
    receipt: {
      ...receipt,
      modelBinding: { ...MOCK_MODEL_BINDING_V1, modelId: "forged-model" }
    }
  };
  delete tampered.digest;
  records[completedIndex] = {
    ...tampered,
    digest: createHash("sha256").update(JSON.stringify(tampered)).digest("hex")
  };
  await writeFile(journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const restarted = appAt(root);
  t.after(() => restarted.close().catch(() => undefined));
  const duplicate = await restarted.inject({ method: "POST", url: "/v1/agent-sessions", payload: request });
  assert.equal(duplicate.statusCode, 503, duplicate.body);
  assert.deepEqual(inspectAgentErrorResponseV1(duplicate.json()), duplicate.json());
  assert.equal(duplicate.json().error, "RECEIPT_UNAVAILABLE");
  assert.doesNotMatch(duplicate.body, /forged-model/u);
});

test("a message receipt stays byte-exact across a concurrent close and restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-close-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstApp = appAt(root);
  const created = await firstApp.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("close-race-create")
  });
  const sessionId = (created.json() as { sessionId: string }).sessionId;
  const messageRequest = {
    method: "POST" as const,
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1("close-race-message", "close while active")
  };
  const firstPromise = firstApp.inject(messageRequest);
  await new Promise<void>((resolve) => { setTimeout(resolve, 8); });
  const close = await firstApp.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/close`,
    payload: controlRequestV1("close-race-close")
  });
  assert.equal(close.statusCode, 200, close.body);
  const first = await firstPromise;
  assert.equal(first.statusCode, 200, first.body);
  const immediateDuplicate = await firstApp.inject(messageRequest);
  assert.equal(immediateDuplicate.body, first.body);
  await firstApp.close();

  const restarted = appAt(root);
  t.after(() => restarted.close().catch(() => undefined));
  const restartedDuplicate = await restarted.inject(messageRequest);
  assert.equal(restartedDuplicate.statusCode, first.statusCode);
  assert.equal(restartedDuplicate.body, first.body);
});

test("in-memory idempotency responses are detached frozen values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-frozen-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  t.after(() => service.dispose());
  const created = await service.create(createRequestV1("frozen-receipt-create"));
  const body = created.body as { state: string; eventCursor: { lastSeq: number } };
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(body), true);
  assert.equal(Object.isFrozen(body.eventCursor), true);
  assert.throws(() => { body.state = "forged"; }, TypeError);
  assert.throws(() => { body.eventCursor.lastSeq = 999; }, TypeError);
  const duplicate = await service.create(createRequestV1("frozen-receipt-create"));
  assert.equal((duplicate.body as { state: string }).state, "idle");
});

test("bounded receipts survive maximum legal messages and reconstruct the exact response", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-max-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("max-receipt-create")
  });
  const sessionId = created.json().sessionId as string;
  const prompt = "x".repeat(1_000_000);
  let terminalBody = "";
  for (let index = 0; index < 3; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/agent-sessions/${sessionId}/messages`,
      payload: messageRequestV1(`max-receipt-message-${index}`, prompt)
    });
    assert.equal(response.statusCode, 200, response.body.slice(0, 200));
    terminalBody = response.body;
  }
  await app.close();
  const journal = await readFile(join(root, "agent-service", "mutations.jsonl"), "utf8");
  assert.ok(Buffer.byteLength(journal, "utf8") < 32_768);

  const restarted = appAt(root);
  t.after(() => restarted.close());
  const duplicate = await restarted.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1("max-receipt-message-2", "different")
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body.slice(0, 200));
  assert.equal(duplicate.body, terminalBody);
});

test("many legal messages keep the mutation journal bounded across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-total-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("total-receipt-create")
  });
  const sessionId = created.json().sessionId as string;
  const prompt = "y".repeat(100_000);
  for (let index = 0; index < 20; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/agent-sessions/${sessionId}/messages`,
      payload: messageRequestV1(`total-receipt-message-${index}`, prompt)
    });
    assert.equal(response.statusCode, 200, response.body.slice(0, 200));
  }
  await app.close();
  const journalPath = join(root, "agent-service", "mutations.jsonl");
  assert.ok(Buffer.byteLength(await readFile(journalPath), "utf8") < 128_000);
  const restarted = appAt(root);
  t.after(() => restarted.close());
  const inspected = await restarted.inject({
    method: "GET",
    url: `/v1/agent-sessions/${sessionId}`
  });
  assert.equal(inspected.statusCode, 200, inspected.body.slice(0, 200));
});

test("restart never guesses protected history into a runtime overlay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-overlay-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstApp = appAt(root);
  const created = await firstApp.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("overlay-create")
  });
  const sessionId = created.json().sessionId as string;
  const firstMessage = await firstApp.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1("overlay-first", "first")
  });
  assert.equal(firstMessage.statusCode, 200, firstMessage.body);
  const lastSeq = firstMessage.json().eventCursor.lastSeq as number;
  await firstApp.close();

  const restarted = appAt(root);
  t.after(() => restarted.close());
  const resumed = await restarted.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1("overlay-second", "must fail closed")
  });
  assert.equal(resumed.statusCode, 409, resumed.body);
  assert.equal(resumed.json().error, "RUNTIME_OVERLAY_REQUIRED");
  const inspected = await restarted.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(inspected.json().eventCursor.lastSeq, lastSeq);
  await restarted.close();

  const restartedAgain = appAt(root);
  t.after(() => restartedAgain.close().catch(() => undefined));
  const duplicate = await restartedAgain.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1("overlay-second", "different input must not execute")
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(duplicate.body, resumed.body);
});

test("SQLite remains a rebuildable protected projection of JSONL facts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("projection-create")
  });
  const sessionId = created.json().sessionId as string;
  const message = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/messages`,
    payload: messageRequestV1("projection-message", "Alice 手机：13800138000")
  });
  const lastSeq = message.json().eventCursor.lastSeq as number;
  await app.close();

  const databasePath = join(root, "agent-service", "projection.db");
  const projection = new DatabaseSync(databasePath);
  projection.prepare(`
    update agent_session_projection
    set last_seq = 999, state = 'forged', projection_json = '{"raw":"13800138000"}'
    where session_id = ?
  `).run(sessionId);
  projection.close();

  const restarted = appAt(root);
  t.after(() => restarted.close());
  const inspected = await restarted.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(inspected.statusCode, 200, inspected.body);
  const rebuilt = new DatabaseSync(databasePath, { readOnly: true });
  const row = rebuilt.prepare(`
    select last_seq as lastSeq, state, projection_json as projectionJson
    from agent_session_projection where session_id = ?
  `).get(sessionId) as { lastSeq: number; state: string; projectionJson: string };
  rebuilt.close();
  assert.equal(row.lastSeq, lastSeq);
  assert.equal(row.state, "completed");
  assert.doesNotMatch(row.projectionJson, /13800138000/u);
  assert.match(row.projectionJson, /Alice/u);
});

test("ordinary GET leaves the derived SQLite projection unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-readonly-get-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = appAt(root);
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("readonly-get-create")
  });
  const sessionId = created.json().sessionId as string;
  const databasePath = join(root, "agent-service", "projection.db");
  const projection = new DatabaseSync(databasePath);
  projection.prepare(`
    update agent_session_projection
    set last_seq = 777, state = 'sentinel', projection_json = '{"sentinel":true}'
    where session_id = ?
  `).run(sessionId);
  projection.close();

  const inspected = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.equal(inspected.statusCode, 200, inspected.body);
  const after = new DatabaseSync(databasePath, { readOnly: true });
  const row = after.prepare(`
    select last_seq as lastSeq, state, projection_json as projectionJson
    from agent_session_projection where session_id = ?
  `).get(sessionId) as { lastSeq: number; state: string; projectionJson: string };
  after.close();
  assert.equal(row.lastSeq, 777);
  assert.equal(row.state, "sentinel");
  assert.equal(row.projectionJson, '{"sentinel":true}');
});

test("missing sessions are 404 while corrupt durable sessions fail closed as 5xx", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cleanApp = appAt(root);
  const missing = await cleanApp.inject({ method: "GET", url: "/v1/agent-sessions/missing-session" });
  assert.equal(missing.statusCode, 404, missing.body);
  await cleanApp.close();
  const durableRoot = join(root, "agent-service");
  const sessionId = SessionId("corrupt-session");
  const seed = new JsonlAgentSessionStore(durableRoot);
  await seed.create({ sessionId });
  await seed.dispose();
  await writeFile(join(durableRoot, "sessions", sessionId, "header.json"), "{invalid", "utf8");

  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));
  const corrupt = await app.inject({ method: "GET", url: `/v1/agent-sessions/${sessionId}` });
  assert.ok(corrupt.statusCode >= 500, corrupt.body);
});

test("oversized mutation journals fail closed without parsing an unbounded line", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-journal-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serviceRoot = join(root, "agent-service");
  await mkdir(serviceRoot, { recursive: true });
  await writeFile(join(serviceRoot, "mutations.jsonl"), "x".repeat(16 * 1024 * 1024), "utf8");
  const app = appAt(root);
  t.after(() => app.close().catch(() => undefined));
  const response = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("bounded-journal-request")
  });
  assert.ok(response.statusCode >= 500, response.body);
});

test("a root directory sync failure rejects acceptance before any session effect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-journal-dir-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serviceRoot = join(root, "agent-service");
  class FailingDirectorySyncService extends LocalMockAgentSessionService {
    protected override beforeJournalDirectorySync(): void {
      throw new Error("injected directory sync failure");
    }
  }
  const service = new FailingDirectorySyncService(serviceRoot);
  const app = buildServer({
    mniuRoot: root,
    agentSessionService: service,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("directory-sync-create")
  });
  assert.ok(response.statusCode >= 500, response.body);
  assert.equal((await readdir(serviceRoot)).includes("sessions"), false);
  await app.close().catch(() => undefined);
});

test("agent service refuses journal and projection symlinks without modifying their targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const journalServiceRoot = join(root, "journal-service");
  await mkdir(journalServiceRoot, { recursive: true });
  const journalTarget = join(root, "outside-journal.txt");
  await writeFile(journalTarget, "outside-journal-sentinel", "utf8");
  await symlink(journalTarget, join(journalServiceRoot, "mutations.jsonl"));
  const journalService = new LocalMockAgentSessionService(journalServiceRoot);
  const journalApp = buildServer({
    mniuRoot: root,
    agentSessionService: journalService,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  const journalResponse = await journalApp.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("symlink-journal-create")
  });
  assert.ok(journalResponse.statusCode >= 500, journalResponse.body);
  assert.equal(await readFile(journalTarget, "utf8"), "outside-journal-sentinel");
  await journalApp.close().catch(() => undefined);

  const projectionServiceRoot = join(root, "projection-service");
  await mkdir(projectionServiceRoot, { recursive: true });
  const projectionTarget = join(root, "outside-projection.db");
  await writeFile(projectionTarget, new Uint8Array());
  await symlink(projectionTarget, join(projectionServiceRoot, "projection.db"));
  const projectionService = new LocalMockAgentSessionService(projectionServiceRoot);
  const projectionApp = buildServer({
    mniuRoot: root,
    agentSessionService: projectionService,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  const projectionResponse = await projectionApp.inject({
    method: "POST",
    url: "/v1/agent-sessions",
    payload: createRequestV1("symlink-projection-create")
  });
  assert.ok(projectionResponse.statusCode >= 500, projectionResponse.body);
  assert.equal((await readFile(projectionTarget)).byteLength, 0);
  await projectionApp.close().catch(() => undefined);
});

test("SSE sends cursor backlog then live events and releases the subscription on disconnect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-live-sse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  const app = buildServer({
    mniuRoot: root,
    agentSessionService: service,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/v1/agent-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createRequestV1("live-create"))
  });
  const sessionId = ((await created.json()) as { sessionId: string }).sessionId;
  const controller = new AbortController();
  const stream = await fetch(`${base}/v1/agent-sessions/${sessionId}/events?after=-1`, {
    signal: controller.signal
  });
  assert.equal(stream.status, 200);
  assert.ok(stream.body);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const readUntil = async (pattern: RegExp): Promise<void> => {
    const deadline = Date.now() + 3_000;
    while (!pattern.test(received) && Date.now() < deadline) {
      const part = await reader.read();
      if (part.done) break;
      received += decoder.decode(part.value, { stream: true });
    }
    assert.match(received, pattern);
  };
  await readUntil(/event: session\/created/u);
  assert.equal(service.activeSubscriptionCount, 1);
  const message = await fetch(`${base}/v1/agent-sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messageRequestV1("live-message", "live"))
  });
  assert.equal(message.status, 200);
  await readUntil(/event: assistant\/message/u);
  controller.abort();
  await assert.rejects(() => reader.read(), /abort/i);
  await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  assert.equal(service.activeSubscriptionCount, 0);
});

test("event subscriptions pause backlog delivery on backpressure and resume from the exact cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-sse-pressure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  t.after(() => service.dispose());
  const created = await service.create(createRequestV1("pressure-create"));
  const sessionId = (created.body as { sessionId: string }).sessionId;
  await service.message(sessionId, messageRequestV1("pressure-message", "backlog"));
  const received: number[] = [];
  const subscription = await service.subscribeEvents(sessionId, -1, (event) => {
    received.push(event.seq);
    return received.length !== 1;
  });
  assert.deepEqual(received, [0]);
  await new Promise<void>((resolve) => { setTimeout(resolve, 30); });
  assert.deepEqual(received, [0]);
  subscription.resume();
  assert.ok(received.length > 1);
  assert.deepEqual(received, received.map((_, index) => index));
  subscription.unsubscribe();
  assert.equal(service.activeSubscriptionCount, 0);
});

test("service disposal permanently invalidates every subscription handle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-sse-dispose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  const created = await service.create(createRequestV1("dispose-subscription-create"));
  const sessionId = (created.body as { sessionId: string }).sessionId;
  await service.message(
    sessionId,
    messageRequestV1("dispose-subscription-message", "backlog before dispose")
  );
  let calls = 0;
  const subscription = await service.subscribeEvents(sessionId, -1, () => {
    calls += 1;
    return false;
  });
  assert.equal(calls, 1);

  await service.dispose();
  subscription.resume();
  subscription.pause();
  subscription.unsubscribe();
  subscription.resume();
  assert.equal(calls, 1);
  assert.equal(service.activeSubscriptionCount, 0);
});

test("SSE disconnect before session lookup completes never creates a subscription", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-sse-early-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseLookup: (() => void) | undefined;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  class DelayedLookupService extends LocalMockAgentSessionService {
    subscribeCalls = 0;

    override async get(sessionId: string) {
      await lookupGate;
      return super.get(sessionId);
    }

    override async subscribeEvents(
      ...input: Parameters<LocalMockAgentSessionService["subscribeEvents"]>
    ) {
      this.subscribeCalls += 1;
      return super.subscribeEvents(...input);
    }
  }
  const service = new DelayedLookupService(join(root, "agent-service"));
  const app = buildServer({
    mniuRoot: root,
    agentSessionService: service,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address() as AddressInfo;
  const created = await service.create(createRequestV1("early-close-create"));
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const request = httpRequest({
    host: "127.0.0.1",
    port: address.port,
    path: `/v1/agent-sessions/${sessionId}/events?after=-1`,
    method: "GET"
  });
  request.on("error", () => undefined);
  request.end();
  await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  request.destroy();
  await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  releaseLookup?.();
  await new Promise<void>((resolve) => { setTimeout(resolve, 100); });

  assert.equal(service.subscribeCalls, 0);
  assert.equal(service.activeSubscriptionCount, 0);
});

test("server shutdown cancels an SSE handler still waiting for session lookup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-sse-pending-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseLookup: (() => void) | undefined;
  let markLookupStarted: (() => void) | undefined;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
  class DelayedLookupService extends LocalMockAgentSessionService {
    subscribeCalls = 0;

    override async get(sessionId: string) {
      markLookupStarted?.();
      await lookupGate;
      return super.get(sessionId);
    }

    override async subscribeEvents(
      ...input: Parameters<LocalMockAgentSessionService["subscribeEvents"]>
    ) {
      this.subscribeCalls += 1;
      return super.subscribeEvents(...input);
    }
  }
  const service = new DelayedLookupService(join(root, "agent-service"));
  const app = buildServer({
    mniuRoot: root,
    agentSessionService: service,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const created = await service.create(createRequestV1("pending-shutdown-create"));
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const request = httpRequest({
    host: "127.0.0.1",
    port: address.port,
    path: `/v1/agent-sessions/${sessionId}/events?after=-1`,
    method: "GET"
  });
  request.on("error", () => undefined);
  request.end();
  await lookupStarted;
  const closing = app.close();
  await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  releaseLookup?.();
  await Promise.race([
    closing,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("server shutdown waited for pending SSE lookup")), 500);
    })
  ]);
  request.destroy();

  assert.equal(service.subscribeCalls, 0);
  assert.equal(service.activeSubscriptionCount, 0);
});

test("server shutdown closes active SSE connections without waiting for the client", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-sse-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new LocalMockAgentSessionService(join(root, "agent-service"));
  const app = buildServer({
    mniuRoot: root,
    agentSessionService: service,
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/v1/agent-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createRequestV1("shutdown-create"))
  });
  const sessionId = ((await created.json()) as { sessionId: string }).sessionId;
  const stream = await fetch(`${base}/v1/agent-sessions/${sessionId}/events?after=-1`);
  assert.ok(stream.body);
  const reader = stream.body!.getReader();
  await reader.read();
  assert.equal(service.activeSubscriptionCount, 1);

  await Promise.race([
    app.close(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("server shutdown waited for the SSE client")), 500);
    })
  ]);
  assert.equal(service.activeSubscriptionCount, 0);
  const terminal = await reader.read();
  assert.equal(terminal.done, true);
});
