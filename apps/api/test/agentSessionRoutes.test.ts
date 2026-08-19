import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, truncateSync } from "node:fs";
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
  inspectAgentApprovalResponseV1,
  inspectAgentErrorResponseV1,
  inspectAgentSessionViewV1
} from "@mn/agent-protocol";

import { registerAgentSessionRoutes } from "../src/agentSessionRoutes.js";
import { AgentApprovalCoordinator } from "../src/agentApprovalCoordinator.js";
import { buildServer } from "../src/server.js";
import { LocalMockAgentSessionService } from "../src/agentSessionService.js";

function appAt(root: string) {
  return buildServer({
    mniuRoot: root,
    agentSessionService: new LocalMockAgentSessionService(join(root, "agent-service")),
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

type RequestedApprovalEvent = Extract<
  Awaited<ReturnType<LocalMockAgentSessionService["eventsAfter"]>>[number],
  { type: "approval/requested" }
>;

async function waitForRequestedApproval(
  service: LocalMockAgentSessionService,
  sessionId: string,
  after = -1
): Promise<RequestedApprovalEvent> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const requested = (await service.eventsAfter(sessionId, after)).find(
      (event): event is RequestedApprovalEvent => event.type === "approval/requested"
    );
    if (requested !== undefined) return requested;
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error("timed out waiting for a durable approval request");
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

test("a durable pending approval without its process-local waiter is a fixed versioned 409", async (t) => {
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

test("a durable API approval resumes one production-shaped tool run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-functional-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const durableRoot = join(root, "agent-service");
  let modelTurns = 0;
  let toolEffects = 0;
  const coordinator = new AgentApprovalCoordinator();
  const service = new LocalMockAgentSessionService(durableRoot, {
    adapters: [{
      id: "mock",
      async *stream() {
        modelTurns += 1;
        if (modelTurns === 1) {
          yield {
            type: "tool-call-delta" as const,
            index: 0,
            id: CallId("functional-approval-call"),
            name: "write",
            argumentsDelta: '{"value":"safe"}'
          };
          yield { type: "finish" as const, reason: "tool-calls" as const };
          return;
        }
        yield { type: "text-delta" as const, index: 0, text: "done" };
        yield { type: "finish" as const, reason: "stop" as const };
      }
    }],
    tools: [{
      name: "write",
      description: "Write one safe test value",
      risk: "side-effecting",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false
      },
      execute: async () => {
        const journal = readFileSync(join(durableRoot, "mutations.jsonl"), "utf8")
          .trimEnd().split("\n").map((line) => JSON.parse(line) as {
            state: string;
            clientRequestId: string;
          });
        assert.ok(journal.some((record) => record.state === "completed"
          && record.clientRequestId === "functional-approval-decision"));
        toolEffects += 1;
        return { ok: true };
      }
    }],
    effectPolicyBinding: {
      governanceDigest: Digest("a".repeat(64)),
      harnessDigest: Digest("b".repeat(64))
    },
    approvalCoordinator: coordinator
  });
  t.after(() => service.dispose().catch(() => undefined));
  const app = Fastify({ logger: false });
  registerAgentSessionRoutes(app, { getService: async () => service });
  t.after(() => app.close().catch(() => undefined));

  const created = await service.create(createRequestV1("functional-approval-create"));
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const running = service.message(
    sessionId,
    messageRequestV1("functional-approval-message", "run the tool")
  );
  let requested: Extract<Awaited<ReturnType<typeof service.eventsAfter>>[number], {
    type: "approval/requested";
  }> | undefined;
  for (let attempt = 0; attempt < 100 && requested === undefined; attempt += 1) {
    requested = (await service.eventsAfter(sessionId, -1)).find(
      (event): event is typeof requested & object => event.type === "approval/requested"
    );
    if (requested === undefined) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    }
  }
  assert.ok(requested, "the host must durably request approval before waiting");
  assert.equal(toolEffects, 0);

  const approvalId = requested.payload.publicControls.binding.approvalId;
  const approved = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/${approvalId}`,
    payload: approvalRequestV1("functional-approval-decision", "approve_once")
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.deepEqual(inspectAgentApprovalResponseV1(approved.json()), approved.json());
  const duplicate = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/${approvalId}`,
    payload: approvalRequestV1("functional-approval-decision", "approve_once")
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.body, approved.body);
  const conflict = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/${approvalId}`,
    payload: approvalRequestV1("functional-approval-decision", "deny")
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().error, "IDEMPOTENCY_INPUT_CONFLICT");
  assert.equal((await running).statusCode, 200);
  assert.equal(toolEffects, 1);
  const types = (await service.eventsAfter(sessionId, requested.seq - 1)).map((event) => event.type);
  assert.deepEqual(types.slice(0, 3), ["approval/requested", "approval/resolved", "tool/call"]);
  const stale = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/${approvalId}`,
    payload: approvalRequestV1("functional-stale-approval-decision", "approve_once")
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error, "APPROVAL_DECISION_UNAVAILABLE");

  await app.close();
  await service.dispose();
  const restartedService = new LocalMockAgentSessionService(join(root, "agent-service"));
  t.after(() => restartedService.dispose().catch(() => undefined));
  const restartedApp = Fastify({ logger: false });
  registerAgentSessionRoutes(restartedApp, { getService: async () => restartedService });
  t.after(() => restartedApp.close().catch(() => undefined));
  const restartedDuplicate = await restartedApp.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/${approvalId}`,
    payload: approvalRequestV1("functional-approval-decision", "approve_once")
  });
  assert.equal(restartedDuplicate.statusCode, 200, restartedDuplicate.body);
  assert.equal(restartedDuplicate.body, approved.body);
  const restartedConflict = await restartedApp.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/${approvalId}`,
    payload: approvalRequestV1("functional-approval-decision", "deny")
  });
  assert.equal(restartedConflict.statusCode, 409, restartedConflict.body);
  assert.equal(restartedConflict.json().error, "IDEMPOTENCY_INPUT_CONFLICT");

  await restartedApp.close();
  await restartedService.dispose();
  const journalPath = join(durableRoot, "mutations.jsonl");
  const records = (await readFile(journalPath, "utf8")).trimEnd().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const completedIndex = records.findIndex((record) => record.state === "completed"
    && record.clientRequestId === "functional-approval-decision");
  assert.notEqual(completedIndex, -1);
  const completed = records[completedIndex]!;
  const receipt = completed.receipt as Record<string, unknown>;
  const body = receipt.body as Record<string, unknown>;
  const tampered: Record<string, unknown> = {
    ...completed,
    receipt: { ...receipt, body: { ...body, decision: "deny" } }
  };
  delete tampered.digest;
  records[completedIndex] = {
    ...tampered,
    digest: createHash("sha256").update(JSON.stringify(tampered)).digest("hex")
  };
  await writeFile(journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const tamperedApp = appAt(root);
  t.after(() => tamperedApp.close().catch(() => undefined));
  const tamperedDuplicate = await tamperedApp.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/${approvalId}`,
    payload: approvalRequestV1("functional-approval-decision", "approve_once")
  });
  assert.equal(tamperedDuplicate.statusCode, 500, tamperedDuplicate.body);
  assert.deepEqual(inspectAgentErrorResponseV1(tamperedDuplicate.json()), tamperedDuplicate.json());
  assert.doesNotMatch(tamperedDuplicate.body, /deny/u);
});

test("session-scope approval authorizes only its current call and a denial never dispatches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-approval-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let modelTurns = 0;
  const handledValues: string[] = [];
  const coordinator = new AgentApprovalCoordinator();
  const durableRoot = join(root, "agent-service");
  const protectedValue = "Alice alice@example.com /Users/alice/project 13800138000 11010519491231002X token=top-secret";
  const service = new LocalMockAgentSessionService(durableRoot, {
    adapters: [{
      id: "mock",
      async *stream() {
        modelTurns += 1;
        if (modelTurns <= 2) {
          yield {
            type: "tool-call-delta" as const,
            index: 0,
            id: CallId(`scope-approval-call-${modelTurns}`),
            name: "write",
            argumentsDelta: JSON.stringify({ value: protectedValue })
          };
          yield { type: "finish" as const, reason: "tool-calls" as const };
          return;
        }
        yield { type: "finish" as const, reason: "stop" as const };
      }
    }],
    tools: [{
      name: "write",
      description: "Write one explicitly approved value",
      risk: "side-effecting",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false
      },
      execute: async (args) => {
        handledValues.push((args as { value: string }).value);
        return null;
      }
    }],
    effectPolicyBinding: {
      governanceDigest: Digest("1".repeat(64)),
      harnessDigest: Digest("2".repeat(64))
    },
    approvalCoordinator: coordinator
  });
  t.after(() => service.dispose().catch(() => undefined));

  const created = await service.create(createRequestV1("scope-approval-create"));
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const running = service.message(
    sessionId,
    messageRequestV1("scope-approval-message", "run two independently approved tools")
  );
  const first = await waitForRequestedApproval(service, sessionId);
  const firstApproved = await service.approve(
    sessionId,
    first.payload.publicControls.binding.approvalId,
    approvalRequestV1("scope-approval-first-decision", "approve_session_scope")
  );
  assert.equal(firstApproved.statusCode, 200);

  const second = await waitForRequestedApproval(service, sessionId, first.seq);
  assert.equal(handledValues.length, 1);
  assert.equal(coordinator.activeApprovalCount, 1, "session-scope must not auto-authorize a future call");
  const denied = await service.approve(
    sessionId,
    second.payload.publicControls.binding.approvalId,
    approvalRequestV1("scope-approval-second-decision", "deny")
  );
  assert.equal(denied.statusCode, 200);
  assert.equal((await running).statusCode, 200);
  assert.deepEqual(handledValues, [protectedValue]);

  const events = await service.eventsAfter(sessionId, -1);
  assert.equal(events.filter((event) => event.type === "approval/requested").length, 2);
  assert.deepEqual(
    events.filter((event) => event.type === "approval/resolved")
      .map((event) => event.payload.publicControls.decision),
    ["approve_session_scope", "deny"]
  );
  assert.equal(events.filter((event) => event.type === "tool/call").length, 1);
  assert.equal(coordinator.activeApprovalCount, 0);

  const durable = await readFile(join(durableRoot, "sessions", sessionId, "events.jsonl"), "utf8");
  assert.match(durable, /Alice/u);
  assert.match(durable, /alice@example\.com/u);
  assert.match(durable, /\/Users\/alice\/project/u);
  assert.doesNotMatch(durable, /13800138000/u);
  assert.doesNotMatch(durable, /11010519491231002X/u);
  assert.doesNotMatch(durable, /top-secret/u);
});

test("one session waiting for approval never blocks an independent session decision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-independent-approvals-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let modelTurns = 0;
  let toolEffects = 0;
  const service = new LocalMockAgentSessionService(join(root, "agent-service"), {
    adapters: [{
      id: "mock",
      async *stream() {
        modelTurns += 1;
        if (modelTurns <= 2) {
          yield {
            type: "tool-call-delta" as const,
            index: 0,
            id: CallId(`independent-approval-call-${modelTurns}`),
            name: "write",
            argumentsDelta: "{}"
          };
          yield { type: "finish" as const, reason: "tool-calls" as const };
          return;
        }
        yield { type: "finish" as const, reason: "stop" as const };
      }
    }],
    tools: [{
      name: "write",
      description: "Execute independently by session",
      risk: "side-effecting",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        toolEffects += 1;
        return null;
      }
    }],
    effectPolicyBinding: {
      governanceDigest: Digest("7".repeat(64)),
      harnessDigest: Digest("8".repeat(64))
    }
  });
  t.after(() => service.dispose().catch(() => undefined));
  const firstCreated = await service.create(createRequestV1("independent-first-create"));
  const firstSessionId = (firstCreated.body as { sessionId: string }).sessionId;
  const secondCreated = await service.create(createRequestV1("independent-second-create"));
  const secondSessionId = (secondCreated.body as { sessionId: string }).sessionId;
  const firstRunning = service.message(
    firstSessionId,
    messageRequestV1("independent-first-message", "wait")
  );
  const firstRequested = await waitForRequestedApproval(service, firstSessionId);
  const secondRunning = service.message(
    secondSessionId,
    messageRequestV1("independent-second-message", "continue independently")
  );
  const secondRequested = await waitForRequestedApproval(service, secondSessionId);

  assert.equal((await service.approve(
    secondSessionId,
    secondRequested.payload.publicControls.binding.approvalId,
    approvalRequestV1("independent-second-decision", "approve_once")
  )).statusCode, 200);
  assert.equal((await secondRunning).statusCode, 200);
  assert.equal(toolEffects, 1);
  assert.equal((await service.approve(
    firstSessionId,
    firstRequested.payload.publicControls.binding.approvalId,
    approvalRequestV1("independent-first-decision", "deny")
  )).statusCode, 200);
  assert.equal((await firstRunning).statusCode, 200);
  assert.equal(toolEffects, 1);
});

test("durable approval bridge wakes a tool run without a process-local waiter", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-durable-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let modelTurns = 0;
  let toolEffects = 0;
  let settle: ((result: {
    decision: "approve";
    approvalDecision: "approve_once";
    resolution: "decided";
  }) => void) | undefined;
  const coordinator = new AgentApprovalCoordinator({
    durable: {
      authorize: async () => new Promise((resolve) => { settle = resolve; }),
      decide: async ({ request, binding, clientRequestId, decision }) => {
        assert.equal(request.payload.publicControls.binding.approvalId, binding.approvalId);
        assert.ok([
          "durable-approval-decision",
          "durable-approval-replay-after-resolution"
        ].includes(clientRequestId));
        assert.equal(decision, "approve_once");
        if (!settle) throw new Error("durable approval waiter was not registered");
        settle({
          decision: "approve",
          approvalDecision: "approve_once",
          resolution: "decided"
        });
        return true;
      }
    }
  });
  const service = new LocalMockAgentSessionService(join(root, "agent-service"), {
    adapters: [{
      id: "mock",
      async *stream() {
        modelTurns += 1;
        if (modelTurns === 1) {
          yield {
            type: "tool-call-delta" as const,
            index: 0,
            id: CallId("durable-approval-call"),
            name: "write",
            argumentsDelta: "{}"
          };
          yield { type: "finish" as const, reason: "tool-calls" as const };
          return;
        }
        yield { type: "finish" as const, reason: "stop" as const };
      }
    }],
    tools: [{
      name: "write",
      description: "durable approval test tool",
      risk: "side-effecting",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        toolEffects += 1;
        return null;
      }
    }],
    effectPolicyBinding: {
      governanceDigest: Digest("a".repeat(64)),
      harnessDigest: Digest("b".repeat(64))
    },
    approvalCoordinator: coordinator
  });
  t.after(() => service.dispose().catch(() => undefined));
  const created = await service.create(createRequestV1("durable-approval-create"));
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const running = service.message(
    sessionId,
    messageRequestV1("durable-approval-message", "run the durable approval tool")
  );
  const requested = await waitForRequestedApproval(service, sessionId);
  const approved = await service.approve(
    sessionId,
    requested.payload.publicControls.binding.approvalId,
    approvalRequestV1("durable-approval-decision", "approve_once")
  );
  assert.equal(approved.statusCode, 200);
  assert.equal((await running).statusCode, 200);
  assert.equal((await service.approve(
    sessionId,
    requested.payload.publicControls.binding.approvalId,
    approvalRequestV1("durable-approval-replay-after-resolution", "approve_once")
  )).statusCode, 200);
  assert.equal(toolEffects, 1);
  const events = await service.eventsAfter(sessionId, requested.seq - 1);
  assert.deepEqual(
    events.slice(0, 3).map((event) => event.type),
    ["approval/requested", "approval/resolved", "tool/call"]
  );
  assert.equal(coordinator.activeApprovalCount, 0);
});

test("an unhandled durable approval bridge falls back to the process-local waiter", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-local-approval-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let modelTurns = 0;
  let toolEffects = 0;
  let durableAuthorizations = 0;
  let durableDecisions = 0;
  const coordinator = new AgentApprovalCoordinator({
    durable: {
      authorize: async () => {
        durableAuthorizations += 1;
        return undefined;
      },
      decide: async () => {
        durableDecisions += 1;
        return false;
      }
    }
  });
  const service = new LocalMockAgentSessionService(join(root, "agent-service"), {
    adapters: [{
      id: "mock",
      async *stream() {
        modelTurns += 1;
        if (modelTurns === 1) {
          yield {
            type: "tool-call-delta" as const,
            index: 0,
            id: CallId("local-approval-fallback-call"),
            name: "write",
            argumentsDelta: "{}"
          };
          yield { type: "finish" as const, reason: "tool-calls" as const };
          return;
        }
        yield { type: "finish" as const, reason: "stop" as const };
      }
    }],
    tools: [{
      name: "write",
      description: "process-local approval fallback test tool",
      risk: "side-effecting",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        toolEffects += 1;
        return null;
      }
    }],
    effectPolicyBinding: {
      governanceDigest: Digest("e".repeat(64)),
      harnessDigest: Digest("f".repeat(64))
    },
    approvalCoordinator: coordinator
  });
  t.after(() => service.dispose().catch(() => undefined));
  const created = await service.create(createRequestV1("local-approval-fallback-create"));
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const running = service.message(
    sessionId,
    messageRequestV1("local-approval-fallback-message", "run the fallback approval tool")
  );
  const requested = await waitForRequestedApproval(service, sessionId);
  assert.equal(coordinator.activeApprovalCount, 1);
  assert.equal((await service.approve(
    sessionId,
    requested.payload.publicControls.binding.approvalId,
    approvalRequestV1("local-approval-fallback-decision", "approve_once")
  )).statusCode, 200);
  assert.equal((await running).statusCode, 200);
  assert.equal(durableAuthorizations, 1);
  assert.equal(durableDecisions, 1);
  assert.equal(toolEffects, 1);
  assert.equal(coordinator.activeApprovalCount, 0);
});

test("durable cancel and close resolve waiting approvals without dispatching tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-cancel-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let toolEffects = 0;
  let modelTurns = 0;
  const coordinator = new AgentApprovalCoordinator();
  const service = new LocalMockAgentSessionService(join(root, "agent-service"), {
    adapters: [{
      id: "mock",
      async *stream() {
        modelTurns += 1;
        if (modelTurns % 2 === 1) {
          yield {
            type: "tool-call-delta" as const,
            index: 0,
            id: CallId(`control-approval-call-${modelTurns}`),
            name: "write",
            argumentsDelta: "{}"
          };
          yield { type: "finish" as const, reason: "tool-calls" as const };
          return;
        }
        yield { type: "finish" as const, reason: "stop" as const };
      }
    }],
    tools: [{
      name: "write",
      description: "Must remain uncalled after cancellation",
      risk: "side-effecting",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        toolEffects += 1;
        return null;
      }
    }],
    effectPolicyBinding: {
      governanceDigest: Digest("c".repeat(64)),
      harnessDigest: Digest("d".repeat(64))
    },
    approvalCoordinator: coordinator
  });
  t.after(() => service.dispose().catch(() => undefined));
  const created = await service.create(createRequestV1("cancel-approval-create"));
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const running = service.message(
    sessionId,
    messageRequestV1("cancel-approval-message", "wait for approval")
  );
  let requested: Extract<Awaited<ReturnType<typeof service.eventsAfter>>[number], {
    type: "approval/requested";
  }> | undefined;
  for (let attempt = 0; attempt < 100 && requested === undefined; attempt += 1) {
    requested = (await service.eventsAfter(sessionId, -1)).find(
      (event): event is typeof requested & object => event.type === "approval/requested"
    );
    if (requested === undefined) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    }
  }
  assert.ok(requested);
  assert.equal(coordinator.activeApprovalCount, 1);

  const failedConcurrentDecision = coordinator.reserve(requested, "approve_once");
  assert.ok(failedConcurrentDecision, "the concurrent approval must hold the waiter reservation");
  const cancelled = await service.cancel(sessionId, controlRequestV1("cancel-waiting-approval"));
  assert.equal(cancelled.statusCode, 200);
  failedConcurrentDecision.rollback();
  let settled = await Promise.race([
    running.then((response) => ({ kind: "response" as const, response })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      setTimeout(() => { resolve({ kind: "timeout" }); }, 250);
    })
  ]);
  const timedOut = settled.kind === "timeout";
  if (timedOut) {
    coordinator.reserve(requested, "deny", "cancelled")?.commit();
    settled = { kind: "response", response: await running };
  }
  assert.equal(timedOut, false, "cancel must settle the approval waiter");
  assert.equal(toolEffects, 0);
  const events = await service.eventsAfter(sessionId, requested.seq - 1);
  const resolution = events.find((event) => event.type === "approval/resolved");
  assert.ok(resolution?.type === "approval/resolved");
  assert.equal(resolution.payload.publicControls.decision, "deny");
  assert.equal(resolution.payload.publicControls.resolution, "cancelled");
  assert.equal(events.some((event) => event.type === "tool/call"), false);
  assert.equal(coordinator.activeApprovalCount, 0);
  assert.equal(coordinator.reserve(requested, "approve_once"), undefined);

  modelTurns = 0;
  const secondCreated = await service.create(createRequestV1("close-approval-create"));
  const secondSessionId = (secondCreated.body as { sessionId: string }).sessionId;
  const secondRunning = service.message(
    secondSessionId,
    messageRequestV1("close-approval-message", "wait for close")
  );
  const secondRequested = await waitForRequestedApproval(service, secondSessionId);
  const closed = await service.close(secondSessionId, controlRequestV1("close-waiting-approval"));
  assert.equal(closed.statusCode, 200);
  assert.equal((await secondRunning).statusCode, 200);
  const secondEvents = await service.eventsAfter(secondSessionId, secondRequested.seq - 1);
  const closedResolution = secondEvents.find((event) => event.type === "approval/resolved");
  assert.ok(closedResolution?.type === "approval/resolved");
  assert.equal(closedResolution.payload.publicControls.decision, "deny");
  assert.equal(closedResolution.payload.publicControls.resolution, "closed");
  assert.equal(secondEvents.some((event) => event.type === "tool/call"), false);
  assert.equal(toolEffects, 0);
  assert.equal(coordinator.activeApprovalCount, 0);

  modelTurns = 0;
  const thirdCreated = await service.create(createRequestV1("dispose-approval-create"));
  const thirdSessionId = (thirdCreated.body as { sessionId: string }).sessionId;
  const thirdRunning = service.message(
    thirdSessionId,
    messageRequestV1("dispose-approval-message", "wait for disposal")
  );
  await waitForRequestedApproval(service, thirdSessionId);
  const disposed = await Promise.race([
    service.dispose().then(() => true),
    new Promise<false>((resolve) => { setTimeout(() => { resolve(false); }, 500); })
  ]);
  assert.equal(disposed, true, "service disposal must release every approval waiter");
  assert.equal((await thirdRunning).statusCode, 200);
  assert.equal(coordinator.activeApprovalCount, 0);
  assert.equal(toolEffects, 0);
  const disposedDurable = await readFile(
    join(root, "agent-service", "sessions", thirdSessionId, "events.jsonl"),
    "utf8"
  );
  assert.match(disposedDurable, /approval\/resolved/u);
  assert.match(disposedDurable, /cancelled/u);
  assert.doesNotMatch(disposedDurable, /tool\/call/u);
});

test("a failed completed journal write rolls approval back without dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-approval-journal-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const durableRoot = join(root, "agent-service");
  class FailingApprovalCoordinator extends AgentApprovalCoordinator {
    private armed = true;

    override reserve(
      ...args: Parameters<AgentApprovalCoordinator["reserve"]>
    ): ReturnType<AgentApprovalCoordinator["reserve"]> {
      const reservation = super.reserve(...args);
      if (reservation !== undefined && this.armed) {
        this.armed = false;
        truncateSync(join(durableRoot, "mutations.jsonl"), 0);
      }
      return reservation;
    }
  }
  const coordinator = new FailingApprovalCoordinator();
  let modelTurns = 0;
  let toolEffects = 0;
  const service = new LocalMockAgentSessionService(durableRoot, {
    adapters: [{
      id: "mock",
      async *stream() {
        modelTurns += 1;
        if (modelTurns === 1) {
          yield {
            type: "tool-call-delta" as const,
            index: 0,
            id: CallId("journal-failure-approval-call"),
            name: "write",
            argumentsDelta: "{}"
          };
          yield { type: "finish" as const, reason: "tool-calls" as const };
          return;
        }
        yield { type: "finish" as const, reason: "stop" as const };
      }
    }],
    tools: [{
      name: "write",
      description: "Must not run without a completed decision receipt",
      risk: "side-effecting",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        toolEffects += 1;
        return null;
      }
    }],
    effectPolicyBinding: {
      governanceDigest: Digest("e".repeat(64)),
      harnessDigest: Digest("f".repeat(64))
    },
    approvalCoordinator: coordinator
  });
  t.after(() => service.dispose().catch(() => undefined));
  const app = Fastify({ logger: false });
  registerAgentSessionRoutes(app, { getService: async () => service });
  t.after(() => app.close().catch(() => undefined));
  const created = await service.create(createRequestV1("journal-failure-approval-create"));
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const running = service.message(
    sessionId,
    messageRequestV1("journal-failure-approval-message", "wait for approval")
  );
  let requested: Extract<Awaited<ReturnType<typeof service.eventsAfter>>[number], {
    type: "approval/requested";
  }> | undefined;
  for (let attempt = 0; attempt < 100 && requested === undefined; attempt += 1) {
    requested = (await service.eventsAfter(sessionId, -1)).find(
      (event): event is typeof requested & object => event.type === "approval/requested"
    );
    if (requested === undefined) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    }
  }
  assert.ok(requested);
  const approvalId = requested.payload.publicControls.binding.approvalId;
  const decision = approvalRequestV1("journal-failure-approval-decision", "approve_once");
  const failed = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/${approvalId}`,
    payload: decision
  });
  assert.equal(failed.statusCode, 500, failed.body);
  await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  const beforeCleanup = await service.eventsAfter(sessionId, requested.seq - 1);
  assert.deepEqual(beforeCleanup.map((event) => event.type), ["approval/requested"]);
  assert.equal(toolEffects, 0);
  const retry = await app.inject({
    method: "POST",
    url: `/v1/agent-sessions/${sessionId}/approvals/${approvalId}`,
    payload: decision
  });
  assert.equal(retry.statusCode, 409, retry.body);
  assert.equal(retry.json().error, "IDEMPOTENT_OPERATION_INTERRUPTED");

  coordinator.reserve(requested, "deny", "interrupted")?.commit();
  await running.catch(() => undefined);
  assert.equal(toolEffects, 0);
  assert.equal(
    (await service.eventsAfter(sessionId, requested.seq - 1)).some((event) => event.type === "tool/call"),
    false
  );
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

test("restart denies a pending approval as interrupted and never starts its tool", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-agent-api-approval-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const durableRoot = join(root, "agent-service");
  const sessionId = SessionId("restart-pending-approval-session");
  const runId = RunId("restart-pending-approval-run");
  const candidateId = CandidateId("restart-pending-approval-candidate");
  const callId = CallId("restart-pending-approval-call");
  const seed = new JsonlAgentSessionStore(durableRoot);
  const session = await seed.create({ sessionId, modelBinding: MOCK_MODEL_BINDING_V1 });
  const assistant = createAssistantMessage({
    id: MessageId("restart-pending-approval-message"),
    content: [{ type: "tool-call", id: callId, name: "write", arguments: "{}" }],
    source: { kind: "model", provider: "mock", model: "local-mock" }
  });
  const binder = createRuntimeEffectCommitmentBinderV1({
    governanceDigest: Digest("3".repeat(64)),
    harnessDigest: Digest("4".repeat(64))
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
  await session.append("assistant/message", { turn: 1, step: 1, message: assistant }, { runId, candidateId });
  await session.append("approval/requested", {
    binding: {
      schemaVersion: 1,
      approvalId: "restart-pending-approval",
      scope: handle.commitment.effectKind,
      risk: "side-effecting",
      callId,
      name: "write",
      commitment: handle.commitment
    }
  }, { runId, candidateId });
  await session.flush();
  binder.dispose();
  await seed.dispose();

  const first = new LocalMockAgentSessionService(durableRoot);
  assert.equal((await first.get(sessionId)).state, "interrupted");
  const recovered = await first.eventsAfter(sessionId, -1);
  const resolved = recovered.find((event) => event.type === "approval/resolved");
  assert.ok(resolved?.type === "approval/resolved");
  assert.equal(resolved.payload.publicControls.decision, "deny");
  assert.equal(resolved.payload.publicControls.resolution, "interrupted");
  const notStarted = recovered.find((event) => event.type === "tool/result");
  assert.ok(notStarted?.type === "tool/result");
  assert.equal(notStarted.payload.publicControls.error?.code, "TOOL_NOT_STARTED");
  assert.equal(recovered.some((event) => event.type === "tool/call"), false);
  await first.dispose();
  const afterFirstRecovery = await readFile(
    join(durableRoot, "sessions", sessionId, "events.jsonl"),
    "utf8"
  );

  const second = new LocalMockAgentSessionService(durableRoot);
  t.after(() => second.dispose().catch(() => undefined));
  assert.equal((await second.get(sessionId)).state, "interrupted");
  assert.equal(
    await readFile(join(durableRoot, "sessions", sessionId, "events.jsonl"), "utf8"),
    afterFirstRecovery,
    "recovery must be idempotent and must not replay the proposed tool"
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
  let modelTurns = 0;
  let toolEffects = 0;
  const service = new LocalMockAgentSessionService(join(root, "agent-service"), {
    adapters: [{
      id: "mock",
      async *stream() {
        modelTurns += 1;
        if (modelTurns === 1) {
          yield {
            type: "tool-call-delta" as const,
            index: 0,
            id: CallId("live-sse-approval-call"),
            name: "write",
            argumentsDelta: "{}"
          };
          yield { type: "finish" as const, reason: "tool-calls" as const };
          return;
        }
        yield { type: "finish" as const, reason: "stop" as const };
      }
    }],
    tools: [{
      name: "write",
      description: "Observe one SSE-visible approval",
      risk: "side-effecting",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        toolEffects += 1;
        return null;
      }
    }],
    effectPolicyBinding: {
      governanceDigest: Digest("5".repeat(64)),
      harnessDigest: Digest("6".repeat(64))
    }
  });
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
  const message = fetch(`${base}/v1/agent-sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messageRequestV1("live-message", "live"))
  });
  await readUntil(/event: approval\/requested/u);
  const requested = await waitForRequestedApproval(service, sessionId);
  const approved = await fetch(
    `${base}/v1/agent-sessions/${sessionId}/approvals/${requested.payload.publicControls.binding.approvalId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(approvalRequestV1("live-approval-decision", "approve_once"))
    }
  );
  assert.equal(approved.status, 200);
  await readUntil(/event: approval\/resolved/u);
  assert.equal((await message).status, 200);
  assert.equal(toolEffects, 1);
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
