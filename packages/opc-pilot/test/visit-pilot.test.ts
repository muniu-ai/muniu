// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryOpcStore } from "@mn/opc-store";
import {
  appendOperationEvent,
  createAuthorityDecision,
  type ActionIntentV1,
  type OperationRunV1
} from "@mn/operations";

import {
  ControlledEffectDispatcher,
  ControlledPublicationDispatcher,
  DingTalkTodoConnector,
  EncryptedTenantContentStore,
  KeychainTenantKeyProvider,
  TenantEnvelopeContentStore,
  addVisitExtraction,
  addVisitSource,
  compileVisitWriteback,
  confirmVisitFindings,
  createDingTalkHttpSignature,
  createVisitRecord,
  decryptDingTalkHttpCallback,
  encryptDingTalkHttpResponse,
  persistCompiledVisitWriteback,
  transitionVisitRecord,
  type EffectConnectorV1,
  type PublicationTransportV1
} from "../src/index.js";
import {
  digest as requireDigest,
  exactRecord,
  identifier as requireIdentifier,
  identifiers as requireIdentifiers,
  jsonValue,
  safeInteger,
  text as requireText,
  timestamp as requireTimestamp
} from "../src/shared.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const NOW = "2026-08-26T00:00:00.000Z";

function run(): OperationRunV1 {
  return {
    schemaVersion: 1,
    id: "operation-visit-1",
    tenantId: "tenant-a",
    domainId: "opc",
    subjectRefs: [{ kind: "customer_commitment", id: "commitment-1", digest: A }],
    specRef: { id: "spec-1", version: "2", digest: A },
    governanceDigest: B,
    harnessDigest: C,
    domainModuleRef: { id: "opc", version: "0.3.0", digest: D },
    workflowRef: { id: "opc.visit-assistant", version: "1.0.0", digest: A },
    generation: 1,
    status: "running",
    currentStage: "confirmed",
    budgetUsage: {},
    createdAt: NOW,
    updatedAt: NOW
  };
}

function confirmedVisit() {
  let record = createVisitRecord({
    tenantId: "tenant-a",
    id: "visit-1",
    accountRef: "customer-1",
    createdAt: NOW,
    createdBy: "founder-1"
  });
  record = transitionVisitRecord(record, "prepared", {
    createdAt: "2026-08-26T00:10:00.000Z", actor: "founder-1"
  });
  record = transitionVisitRecord(record, "in_progress", {
    createdAt: "2026-08-26T01:00:00.000Z", actor: "founder-1"
  });
  record = addVisitSource(record, {
    source: {
      schemaVersion: 1,
      tenantId: "tenant-a",
      objectId: "audio-1",
      digest: A,
      mediaType: "audio/mp4",
      bytes: 4_096,
      storage: "tenant_cas",
      encryption: "aes-256-gcm"
    },
    fragments: [{
      id: "fragment-1",
      sourceObjectId: "audio-1",
      locator: { startMs: 1_000, endMs: 5_000 },
      contentDigest: B
    }],
    createdAt: "2026-08-26T02:00:00.000Z",
    actor: "recorder-1"
  });
  record = transitionVisitRecord(record, "processing", {
    createdAt: "2026-08-26T02:01:00.000Z", actor: "worker-1"
  });
  record = addVisitExtraction(record, {
    findings: [{
      id: "finding-1",
      category: "fact",
      field: "customer.need",
      value: "Reduce visit follow-up delay.",
      sourceFragmentRefs: ["fragment-1"],
      proposedBy: { kind: "model", id: "model-attempt-1" },
      proposedAt: "2026-08-26T02:02:00.000Z"
    }],
    createdAt: "2026-08-26T02:02:00.000Z",
    actor: "model-attempt-1"
  });
  record = transitionVisitRecord(record, "review_required", {
    createdAt: "2026-08-26T02:03:00.000Z", actor: "worker-1"
  });
  record = confirmVisitFindings(record, {
    decisions: [{ findingId: "finding-1", decision: "verify" }],
    authority: { kind: "human", id: "founder-1", evidenceRef: "review-1" },
    createdAt: "2026-08-26T03:00:00.000Z"
  });
  return transitionVisitRecord(record, "confirmed", {
    createdAt: "2026-08-26T03:01:00.000Z", actor: "founder-1"
  });
}

function compiledWriteback(actionId = "action-persist") {
  return compileVisitWriteback(confirmedVisit(), run(), {
    effects: [{
      id: actionId,
      effectId: "crm.record.write",
      targetRef: "crm:customer-1",
      protectedInputDigest: D,
      consequenceTier: "high",
      reversibility: "compensating",
      compensationRef: "crm.record.restore",
      idempotencyKey: `idempotency-${actionId}`,
      expiresAt: "2026-08-27T00:00:00.000Z",
      eligibleRoles: ["org_admin"],
      dueAt: "2026-08-26T07:00:00.000Z",
      estimatedHumanMinutes: 3
    }],
    createdAt: "2026-08-26T04:00:00.000Z"
  });
}

test("visit workflow stores only tenant object references and keeps findings proposed until review", () => {
  const confirmed = confirmedVisit();
  assert.equal(confirmed.payload.state, "confirmed");
  assert.equal(confirmed.payload.findings[0]?.status, "verified");
  assert.equal(confirmed.payload.findings[0]?.verifiedBy?.kind, "human");
  assert.deepEqual(confirmed.payload.findings[0]?.sourceFragmentRefs, ["fragment-1"]);
  assert.equal("raw" in confirmed.payload.sourceObjects[0]!, false);
  assert.equal("text" in confirmed.payload.fragments[0]!, false);

  const draft = createVisitRecord({
    tenantId: "tenant-a", id: "visit-cross-tenant", accountRef: "customer-1",
    createdAt: NOW, createdBy: "founder-1"
  });
  const prepared = transitionVisitRecord(draft, "prepared", {
    createdAt: "2026-08-26T00:10:00.000Z", actor: "founder-1"
  });
  const active = transitionVisitRecord(prepared, "in_progress", {
    createdAt: "2026-08-26T00:20:00.000Z", actor: "founder-1"
  });
  assert.throws(() => addVisitSource(active, {
    source: {
      schemaVersion: 1, tenantId: "tenant-b", objectId: "audio-2", digest: A,
      mediaType: "audio/mp4", bytes: 1, storage: "tenant_cas", encryption: "aes-256-gcm"
    },
    fragments: [{
      id: "fragment-2", sourceObjectId: "audio-2",
      locator: { startMs: 0, endMs: 1 }, contentDigest: B
    }],
    createdAt: "2026-08-26T00:30:00.000Z", actor: "founder-1"
  }), /tenant/u);
});

test("confirmed visit compiles every external write into an approval attention item", () => {
  const compiled = compileVisitWriteback(confirmedVisit(), run(), {
    effects: [
      {
        id: "action-todo-1",
        effectId: "dingtalk.todo.create",
        targetRef: "dingtalk:user-1",
        protectedInputDigest: C,
        consequenceTier: "medium",
        reversibility: "compensating",
        compensationRef: "dingtalk.todo.delete",
        idempotencyKey: "todo-visit-1",
        expiresAt: "2026-08-27T00:00:00.000Z",
        eligibleRoles: ["org_admin"],
        dueAt: "2026-08-26T08:00:00.000Z",
        estimatedHumanMinutes: 2
      },
      {
        id: "action-crm-1",
        effectId: "crm.record.write",
        targetRef: "crm:customer-1",
        protectedInputDigest: D,
        consequenceTier: "high",
        reversibility: "compensating",
        compensationRef: "crm.record.restore",
        idempotencyKey: "crm-visit-1",
        expiresAt: "2026-08-27T00:00:00.000Z",
        eligibleRoles: ["org_admin"],
        dueAt: "2026-08-26T07:00:00.000Z",
        estimatedHumanMinutes: 3
      }
    ],
    createdAt: "2026-08-26T04:00:00.000Z"
  });
  assert.equal(compiled.visit.payload.state, "writeback_pending");
  assert.equal(compiled.actions.length, 2);
  assert.equal(compiled.attentionItems.length, 2);
  assert.ok(compiled.actions.every((action) => action.generation === 1));
  assert.ok(compiled.attentionItems.every((item) => item.sourceKind === "approval"));
});

test("compiled visit, actions, attention, and evidence append atomically", async () => {
  const store = new MemoryOpcStore();
  const confirmed = confirmedVisit();
  await store.append({
    tenantId: confirmed.tenantId,
    kind: "record",
    id: confirmed.id,
    expectedRevision: 0,
    requestId: "seed-confirmed-visit",
    value: confirmed as never,
    createdAt: confirmed.createdAt
  });
  const initialEvent = appendOperationEvent(undefined, {
    id: "operation-event-initial",
    tenantId: "tenant-a",
    runId: run().id,
    kind: "source_captured",
    actor: "operation.compiler",
    sourceRefs: [confirmed.digest],
    payloadRef: `visit:${confirmed.id}`,
    createdAt: NOW
  });
  await store.append({
    tenantId: "tenant-a",
    kind: "operation_event",
    id: run().id,
    expectedRevision: 0,
    requestId: "seed-operation-event",
    value: initialEvent as never,
    createdAt: NOW
  });
  const compiled = compiledWriteback("action-atomic");
  const persisted = await persistCompiledVisitWriteback(store, compiled, {
    requestId: "persist-visit-1",
    expectedVisitRevision: 1,
    expectedOperationEventRevision: 1,
    createdAt: "2026-08-26T04:00:00.000Z"
  });
  assert.equal(persisted.record.value.payload.state, "writeback_pending");
  assert.equal(persisted.actions.length, 1);
  assert.equal(persisted.attentionItems.length, 1);
  assert.equal(persisted.event.value.sequence, 2);
  assert.equal((await store.read("tenant-a", "action_intent", "action-atomic"))?.revision, 1);
  assert.deepEqual(await persistCompiledVisitWriteback(store, compiled, {
    requestId: "persist-visit-1",
    expectedVisitRevision: 1,
    expectedOperationEventRevision: 1,
    createdAt: "2026-08-26T04:00:00.000Z"
  }), persisted);
});

test("writeback persistence rejects stale history and fabricated compiler output", async () => {
  const store = new MemoryOpcStore();
  const compiled = compiledWriteback("action-validation");
  const input = {
    requestId: "persist-validation",
    expectedVisitRevision: 0,
    expectedOperationEventRevision: 0,
    createdAt: "2026-08-26T04:00:00.000Z"
  };
  await assert.rejects(() => persistCompiledVisitWriteback(store, {
    ...compiled,
    actions: []
  }, input), /incomplete/u);
  await assert.rejects(() => persistCompiledVisitWriteback(store, {
    ...compiled,
    actions: [{ ...compiled.actions[0]!, tenantId: "tenant-b" }]
  }, input), /not bound/u);
  await assert.rejects(() => persistCompiledVisitWriteback(store, {
    ...compiled,
    attentionItems: [{ ...compiled.attentionItems[0]!, sourceId: "another-action" }]
  }, input), /not bound/u);
  await assert.rejects(() => persistCompiledVisitWriteback(store, compiled, {
    ...input,
    createdAt: "2026-08-26T04:01:00.000Z"
  }), /time must match/u);
  await assert.rejects(() => persistCompiledVisitWriteback(store, compiled, {
    ...input,
    expectedOperationEventRevision: 1
  }), /shorter/u);
});

async function seedAction(store: MemoryOpcStore, id: string, decision: "approve" | "reject" = "approve") {
  const action: ActionIntentV1 = {
    schemaVersion: 1,
    id,
    tenantId: "tenant-a",
    runId: "operation-visit-1",
    generation: 1,
    effectId: "crm.record.write",
    targetRef: "crm:customer-1",
    inputDigest: A,
    governanceDigest: B,
    consequenceTier: "high",
    reversibility: "compensating",
    compensationRef: "crm.record.restore",
    idempotencyKey: `idempotency-${id}`,
    expiresAt: "2026-08-27T00:00:00.000Z",
    createdAt: NOW
  };
  const authority = createAuthorityDecision(action, {
    id: `decision-${id}`,
    decision,
    actor: "founder-1",
    actorRole: "org_admin",
    decidedAt: "2026-08-26T01:00:00.000Z"
  });
  await store.append({
    tenantId: "tenant-a", kind: "action_intent", id, expectedRevision: 0,
    requestId: `seed-${id}`, value: action as never, createdAt: NOW
  });
  await store.append({
    tenantId: "tenant-a", kind: "authority_decision", id, expectedRevision: 0,
    requestId: `seed-decision-${id}`, value: authority as never,
    createdAt: "2026-08-26T01:00:00.000Z"
  });
}

test("effect dispatcher executes approved intent once and never retries an unknown result", async () => {
  const store = new MemoryOpcStore();
  await seedAction(store, "action-success");
  await seedAction(store, "action-unknown");
  let successCalls = 0;
  const connector: EffectConnectorV1 = {
    id: "crm",
    idempotency: "strong",
    effectIds: ["crm.record.write"],
    async execute(intent) {
      successCalls += 1;
      return { status: "succeeded", externalRef: `crm:${intent.id}`, responseDigest: C };
    }
  };
  const dispatcher = new ControlledEffectDispatcher(store);
  const first = await dispatcher.dispatch({
    tenantId: "tenant-a", actionId: "action-success", dispatchId: "dispatch-success-1",
    connector, now: "2026-08-26T02:00:00.000Z"
  });
  const replay = await dispatcher.dispatch({
    tenantId: "tenant-a", actionId: "action-success", dispatchId: "dispatch-success-2",
    connector, now: "2026-08-26T02:01:00.000Z"
  });
  assert.equal(first.status, "succeeded");
  assert.deepEqual(replay, first);
  assert.equal(successCalls, 1);

  let unknownCalls = 0;
  const ambiguous: EffectConnectorV1 = {
    id: "crm",
    idempotency: "strong",
    effectIds: ["crm.record.write"],
    async execute() {
      unknownCalls += 1;
      throw new Error("connection closed before response");
    }
  };
  const unknown = await dispatcher.dispatch({
    tenantId: "tenant-a", actionId: "action-unknown", dispatchId: "dispatch-unknown-1",
    connector: ambiguous, now: "2026-08-26T02:00:00.000Z"
  });
  const unknownReplay = await dispatcher.dispatch({
    tenantId: "tenant-a", actionId: "action-unknown", dispatchId: "dispatch-unknown-2",
    connector: ambiguous, now: "2026-08-26T02:01:00.000Z"
  });
  assert.equal(unknown.status, "unknown");
  assert.deepEqual(unknownReplay, unknown);
  assert.equal(unknownCalls, 1);

  await seedAction(store, "action-rejected", "reject");
  await assert.rejects(() => dispatcher.dispatch({
    tenantId: "tenant-a", actionId: "action-rejected", dispatchId: "dispatch-rejected-1",
    connector, now: "2026-08-26T02:00:00.000Z"
  }), /approval/u);
  assert.equal(successCalls, 1);
});

test("publication dispatcher records an immutable receipt and does not retry ambiguity", async () => {
  const store = new MemoryOpcStore();
  await store.append({
    tenantId: "tenant-a",
    kind: "publication_outbox",
    id: "publication-1",
    expectedRevision: 0,
    requestId: "seed-publication",
    value: {
      schemaVersion: 1,
      id: "publication-1",
      sourceTenantId: "tenant-a",
      targetTenantId: "tenant-cloud",
      sourceRecordRef: "opportunity:opportunity-1:1",
      sourceDigest: A,
      purpose: "paid-pilot",
      allowedFields: ["customerName"],
      publishedPayload: { customerName: "Example" },
      retentionUntil: "2026-12-31T00:00:00.000Z",
      idempotencyKey: "publish-1",
      createdAt: NOW,
      createdBy: "founder-1"
    },
    createdAt: NOW
  });
  let calls = 0;
  const transport: PublicationTransportV1 = {
    id: "cloud-sync",
    idempotency: "strong",
    async publish() {
      calls += 1;
      throw new Error("ACK not observed");
    }
  };
  const dispatcher = new ControlledPublicationDispatcher(store);
  const first = await dispatcher.publish({
    tenantId: "tenant-a", publicationId: "publication-1", dispatchId: "publish-attempt-1",
    transport, now: "2026-08-26T01:00:00.000Z"
  });
  const replay = await dispatcher.publish({
    tenantId: "tenant-a", publicationId: "publication-1", dispatchId: "publish-attempt-2",
    transport, now: "2026-08-26T01:01:00.000Z"
  });
  assert.equal(first.status, "unknown");
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
});

test("DingTalk HTTP callback verifies SHA-1 envelope, AES owner binding, freshness, and idempotency", () => {
  const token = "token123";
  const ownerKey = "ding-corp-1";
  const encodingAesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const timestamp = "1787731200";
  const encrypted = encryptDingTalkHttpResponse({
    token,
    encodingAesKey,
    ownerKey,
    plaintext: JSON.stringify({ EventType: "visit_text_ready", eventId: "event-1" }),
    timestamp,
    nonce: "nonce-1",
    random: Buffer.from("0123456789abcdef", "utf8")
  });
  const callback = decryptDingTalkHttpCallback({
    token,
    encodingAesKey,
    ownerKey,
    signature: encrypted.msgSignature,
    timestamp,
    nonce: encrypted.nonce,
    encrypt: encrypted.encrypt,
    nowMs: 1_787_731_200_000,
    maxClockSkewMs: 300_000
  });
  assert.equal(callback.payload.EventType, "visit_text_ready");
  assert.match(callback.idempotencyKey, /^[a-f0-9]{64}$/u);
  assert.equal(callback.idempotencyKey, decryptDingTalkHttpCallback({
    token,
    encodingAesKey,
    ownerKey,
    signature: encrypted.msgSignature,
    timestamp,
    nonce: encrypted.nonce,
    encrypt: encrypted.encrypt,
    nowMs: 1_787_731_200_000,
    maxClockSkewMs: 300_000
  }).idempotencyKey);
  assert.throws(() => decryptDingTalkHttpCallback({
    token,
    encodingAesKey,
    ownerKey,
    signature: `0${encrypted.msgSignature.slice(1)}`,
    timestamp,
    nonce: encrypted.nonce,
    encrypt: encrypted.encrypt,
    nowMs: 1_787_731_200_000,
    maxClockSkewMs: 300_000
  }), /signature/u);
  assert.throws(() => decryptDingTalkHttpCallback({
    token,
    encodingAesKey,
    ownerKey,
    signature: encrypted.msgSignature,
    timestamp,
    nonce: encrypted.nonce,
    encrypt: encrypted.encrypt,
    nowMs: 1_787_732_000_000,
    maxClockSkewMs: 300_000
  }), /timestamp/u);
});

test("DingTalk Todo connector binds protected input and uses ActionIntent idempotency as sourceId", async () => {
  const intent: ActionIntentV1 = {
    schemaVersion: 1,
    id: "action-dingtalk-1",
    tenantId: "tenant-a",
    runId: "operation-visit-1",
    generation: 1,
    effectId: "dingtalk.todo.create",
    targetRef: "dingtalk:user-1",
    inputDigest: A,
    governanceDigest: B,
    consequenceTier: "medium",
    reversibility: "compensating",
    compensationRef: "dingtalk.todo.delete",
    idempotencyKey: "todo-visit-1",
    expiresAt: "2026-08-27T00:00:00.000Z",
    createdAt: NOW
  };
  let request: { sourceId: string; executorIds: readonly string[] } | undefined;
  const connector = new DingTalkTodoConnector({
    id: "dingtalk-todo",
    inputLoader: {
      async load(tenantId, inputDigest) {
        assert.equal(tenantId, "tenant-a");
        return {
          inputDigest,
          payload: {
            operatorId: "manager-1",
            creatorId: "manager-1",
            executorIds: ["user-1"],
            subject: "Follow up security review",
            description: "Confirm the review date.",
            dueAt: "2026-08-27T08:00:00.000Z",
            detailUrl: "https://example.test/visits/visit-1"
          }
        };
      }
    },
    api: {
      idempotency: "sourceId",
      async createTodo(value) {
        request = value;
        return { status: "succeeded", taskId: "task-1", response: { requestId: "ding-1" } };
      }
    }
  });
  const result = await connector.execute(intent);
  assert.equal(connector.idempotency, "strong");
  assert.deepEqual(connector.effectIds, ["dingtalk.todo.create"]);
  assert.equal(result.status, "succeeded");
  assert.equal(result.externalRef, "dingtalk.todo:task-1");
  assert.equal(request?.sourceId, intent.idempotencyKey);
  assert.deepEqual(request?.executorIds, ["user-1"]);

  const invalid = new DingTalkTodoConnector({
    id: "dingtalk-invalid-input",
    inputLoader: { async load() { return { inputDigest: B, payload: {} }; } },
    api: { idempotency: "sourceId", async createTodo() { throw new Error("must not execute"); } }
  });
  assert.equal((await invalid.execute(intent)).status, "failed");
  assert.throws(() => new DingTalkTodoConnector({
    id: "dingtalk-weak",
    inputLoader: { async load() { return undefined; } },
    api: { idempotency: "none" as never, async createTodo() { return { status: "failed", errorCode: "x" }; } }
  }), /sourceId idempotency/u);
});

test("visit review and writeback gates reject unresolved, untraced, and unauthorized state", () => {
  const confirmed = confirmedVisit();
  assert.throws(() => compileVisitWriteback(confirmed, { ...run(), tenantId: "tenant-b" }, {
    effects: [], createdAt: "2026-08-26T04:00:00.000Z"
  }), /bound/u);
  assert.throws(() => compileVisitWriteback(confirmed, run(), {
    effects: [{
      id: "payment-1",
      effectId: "finance.payment.execute" as never,
      targetRef: "bank:account-1",
      protectedInputDigest: A,
      consequenceTier: "critical",
      reversibility: "irreversible",
      idempotencyKey: "payment-1",
      expiresAt: "2026-08-27T00:00:00.000Z",
      eligibleRoles: ["org_admin"],
      dueAt: "2026-08-26T07:00:00.000Z",
      estimatedHumanMinutes: 5
    }],
    createdAt: "2026-08-26T04:00:00.000Z"
  }), /not allowed/u);
  assert.throws(() => compileVisitWriteback(confirmed, run(), {
    effects: [{
      id: "crm-expired",
      effectId: "crm.record.write",
      targetRef: "crm:customer-1",
      protectedInputDigest: A,
      consequenceTier: "high",
      reversibility: "compensating",
      compensationRef: "crm.record.restore",
      idempotencyKey: "crm-expired",
      expiresAt: "2026-08-26T03:59:00.000Z",
      eligibleRoles: ["org_admin"],
      dueAt: "2026-08-26T07:00:00.000Z",
      estimatedHumanMinutes: 5
    }],
    createdAt: "2026-08-26T04:00:00.000Z"
  }), /expiry/u);
});

test("dispatchers fail closed for missing authority, mismatched connectors, pending recovery, and expired publication", async () => {
  const store = new MemoryOpcStore();
  const dispatcher = new ControlledEffectDispatcher(store);
  const connector: EffectConnectorV1 = {
    id: "crm",
    idempotency: "strong",
    effectIds: ["crm.record.write"],
    async execute() {
      return { status: "failed", errorDigest: C };
    }
  };
  await assert.rejects(() => dispatcher.dispatch({
    tenantId: "tenant-a", actionId: "missing", dispatchId: "missing-dispatch",
    connector, now: "2026-08-26T02:00:00.000Z"
  }), /approval/u);

  await seedAction(store, "action-wrong-connector");
  await assert.rejects(() => dispatcher.dispatch({
    tenantId: "tenant-a", actionId: "action-wrong-connector", dispatchId: "wrong-connector",
    connector: { ...connector, effectIds: ["dingtalk.todo.create"] },
    now: "2026-08-26T02:00:00.000Z"
  }), /cannot execute/u);

  await seedAction(store, "action-failed");
  const failed = await dispatcher.dispatch({
    tenantId: "tenant-a", actionId: "action-failed", dispatchId: "failed-dispatch",
    connector, now: "2026-08-26T02:00:00.000Z"
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorDigest, C);

  await seedAction(store, "action-pending");
  await store.append({
    tenantId: "tenant-a", kind: "effect_receipt", id: "action-pending",
    expectedRevision: 0, requestId: "seed-pending-receipt",
    value: {
      schemaVersion: 1,
      id: "receipt-pending",
      tenantId: "tenant-a",
      runId: "operation-visit-1",
      actionId: "action-pending",
      generation: 1,
      effectId: "crm.record.write",
      connectorId: "crm",
      idempotencyKey: "idempotency-action-pending",
      dispatchId: "lost-dispatch",
      status: "dispatching",
      attemptedAt: "2026-08-26T01:00:00.000Z",
      observedAt: "2026-08-26T01:00:00.000Z"
    },
    createdAt: "2026-08-26T01:00:00.000Z"
  });
  const recovered = await dispatcher.dispatch({
    tenantId: "tenant-a", actionId: "action-pending", dispatchId: "recover-dispatch",
    connector, now: "2026-08-26T02:00:00.000Z"
  });
  assert.equal(recovered.status, "unknown");

  const publicationStore = new MemoryOpcStore();
  await publicationStore.append({
    tenantId: "tenant-a", kind: "publication_outbox", id: "publication-expired",
    expectedRevision: 0, requestId: "seed-expired-publication",
    value: {
      schemaVersion: 1,
      id: "publication-expired",
      sourceTenantId: "tenant-a",
      targetTenantId: "tenant-cloud",
      sourceRecordRef: "opportunity:opportunity-1:1",
      sourceDigest: A,
      purpose: "pilot",
      allowedFields: ["name"],
      publishedPayload: { name: "Example" },
      retentionUntil: "2026-08-26T01:00:00.000Z",
      idempotencyKey: "expired-publication",
      createdAt: NOW,
      createdBy: "founder-1"
    },
    createdAt: NOW
  });
  const publication = new ControlledPublicationDispatcher(publicationStore);
  await assert.rejects(() => publication.publish({
    tenantId: "tenant-a", publicationId: "publication-expired", dispatchId: "expired-dispatch",
    transport: { id: "cloud", idempotency: "strong", async publish() { return { status: "succeeded" }; } },
    now: "2026-08-26T02:00:00.000Z"
  }), /expired/u);
});

test("publication success preserves only bounded receipt references", async () => {
  const store = new MemoryOpcStore();
  await store.append({
    tenantId: "tenant-a", kind: "publication_outbox", id: "publication-success",
    expectedRevision: 0, requestId: "seed-publication-success",
    value: {
      schemaVersion: 1,
      id: "publication-success",
      sourceTenantId: "tenant-a",
      targetTenantId: "tenant-cloud",
      sourceRecordRef: "opportunity:opportunity-1:1",
      sourceDigest: A,
      purpose: "pilot",
      allowedFields: ["name"],
      publishedPayload: { name: "Example" },
      retentionUntil: "2026-12-31T00:00:00.000Z",
      idempotencyKey: "publication-success",
      createdAt: NOW,
      createdBy: "founder-1"
    },
    createdAt: NOW
  });
  let calls = 0;
  const transport: PublicationTransportV1 = {
    id: "cloud",
    idempotency: "strong",
    async publish() {
      calls += 1;
      return { status: "succeeded", remoteRef: "cloud:receipt-1", responseDigest: B };
    }
  };
  const dispatcher = new ControlledPublicationDispatcher(store);
  const receipt = await dispatcher.publish({
    tenantId: "tenant-a", publicationId: "publication-success", dispatchId: "success-dispatch",
    transport, now: "2026-08-26T01:00:00.000Z"
  });
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.remoteRef, "cloud:receipt-1");
  assert.equal(receipt.responseDigest, B);
  assert.equal(calls, 1);
});

test("DingTalk callback crypto rejects wrong owner, malformed body, key, token, and ciphertext", () => {
  const token = "token123";
  const ownerKey = "ding-corp-1";
  const encodingAesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const timestamp = "1787731200";
  const nowMs = 1_787_731_200_000;
  const envelope = encryptDingTalkHttpResponse({
    token, encodingAesKey, ownerKey, plaintext: JSON.stringify({ EventType: "visit" }),
    timestamp, nonce: "nonce-2", random: Buffer.from("fedcba9876543210", "utf8")
  });
  const base = {
    token, encodingAesKey, ownerKey, signature: envelope.msgSignature,
    timestamp, nonce: envelope.nonce, encrypt: envelope.encrypt,
    nowMs, maxClockSkewMs: 300_000
  };
  assert.throws(() => decryptDingTalkHttpCallback({ ...base, ownerKey: "another-corp" }), /owner binding/u);
  assert.throws(() => decryptDingTalkHttpCallback({
    ...base,
    encodingAesKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  }), /padding|payload|message length/iu);
  assert.throws(() => decryptDingTalkHttpCallback({ ...base, token: "!" }), /token/u);
  assert.throws(() => decryptDingTalkHttpCallback({ ...base, encodingAesKey: "short" }), /encodingAesKey/u);

  const invalidEncrypt = "%%%";
  assert.throws(() => decryptDingTalkHttpCallback({
    ...base,
    encrypt: invalidEncrypt,
    signature: createDingTalkHttpSignature(token, timestamp, envelope.nonce, invalidEncrypt)
  }), /base64/u);

  const nonJson = encryptDingTalkHttpResponse({
    token, encodingAesKey, ownerKey, plaintext: "not-json", timestamp,
    nonce: "nonce-3", random: Buffer.from("0123456789abcdef", "utf8")
  });
  assert.throws(() => decryptDingTalkHttpCallback({
    ...base,
    signature: nonJson.msgSignature,
    nonce: nonJson.nonce,
    encrypt: nonJson.encrypt
  }), /not JSON/u);
});

test("pilot validators reject ambiguous, accessor-backed, duplicate, and oversized input", () => {
  assert.equal(requireIdentifier("safe-id", "id"), "safe-id");
  assert.throws(() => requireIdentifier(null, "id"), /identifier/u);
  assert.throws(() => requireIdentifier("bad id", "id"), /identifier/u);
  assert.equal(requireDigest(A, "digest"), A);
  assert.throws(() => requireDigest("A".repeat(64), "digest"), /digest/u);
  assert.equal(requireTimestamp(NOW, "time"), NOW);
  assert.throws(() => requireTimestamp("yesterday", "time"), /RFC3339/u);
  assert.equal(requireText("value", "text"), "value");
  assert.throws(() => requireText(" ", "text"), /non-empty/u);
  assert.throws(() => requireText("toolong", "text", 3), /bounded/u);
  assert.equal(safeInteger(1, "number", 1), 1);
  assert.throws(() => safeInteger(-1, "number"), /safe integer/u);
  assert.deepEqual(requireIdentifiers(["a", "b"], "ids", 1), ["a", "b"]);
  assert.throws(() => requireIdentifiers("a", "ids"), /contain/u);
  assert.throws(() => requireIdentifiers([], "ids", 1), /at least/u);
  assert.throws(() => requireIdentifiers(["a", "a"], "ids"), /duplicates/u);
  assert.deepEqual(exactRecord({ id: "a" }, "record", ["id"]), { id: "a" });
  assert.throws(() => exactRecord(null, "record", []), /plain object/u);
  assert.throws(() => exactRecord([], "record", []), /plain object/u);
  assert.throws(() => exactRecord({}, "record", ["id"]), /missing/u);
  assert.throws(() => exactRecord({ id: "a", extra: true }, "record", ["id"]), /unsupported/u);
  assert.throws(() => exactRecord({ [Symbol("hidden")]: true }, "record", []), /unsupported/u);
  const accessor = {} as { id?: string };
  Object.defineProperty(accessor, "id", { enumerable: true, get: () => "a" });
  assert.throws(() => exactRecord(accessor, "record", ["id"]), /unsupported/u);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => jsonValue(circular, "value"), /canonical JSON/u);
  assert.throws(() => jsonValue("x".repeat(65_537), "value"), /canonical JSON/u);
});

test("tenant content is encrypted with a Keychain-managed key and survives restart", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-opc-content-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));

  const saved = new Map<string, string>();
  let keySequence = 0;
  const vault = {
    async saveSecret(secret: string) {
      const ref = `keychain:test-${++keySequence}`;
      saved.set(ref, secret);
      return { type: "keychain", ref };
    },
    async readSecret(ref: string) {
      return saved.get(ref);
    },
    async deleteSecret(ref: string) {
      saved.delete(ref);
    }
  };
  const keyProvider = new KeychainTenantKeyProvider(join(rootDir, "key-refs"), vault);
  const store = new EncryptedTenantContentStore(join(rootDir, "content"), keyProvider);
  await assert.rejects(() => store.put({
    tenantId: "tenant-a", mediaType: "text/plain", plaintext: Buffer.alloc(0)
  }), /plaintext.bytes/u);
  const plaintext = Buffer.from("customer said: renew after security review", "utf8");
  const ref = await store.put({ tenantId: "tenant-a", mediaType: "text/plain", plaintext });

  assert.equal(ref.tenantId, "tenant-a");
  assert.equal(ref.storage, "tenant_cas");
  assert.equal(ref.encryption, "aes-256-gcm");
  assert.deepEqual(await store.read(ref), plaintext);
  const restarted = new EncryptedTenantContentStore(
    join(rootDir, "content"),
    new KeychainTenantKeyProvider(join(rootDir, "key-refs"), vault)
  );
  assert.deepEqual(await restarted.read(ref), plaintext);

  const files = await encryptedContentFiles(join(rootDir, "content"));
  assert.equal(files.length, 1);
  const encrypted = await readFile(files[0]!, "utf8");
  assert.equal(encrypted.includes(plaintext.toString("utf8")), false);
  assert.equal((await lstat(join(rootDir, "content"))).mode & 0o777, 0o700);
  assert.equal((await lstat(files[0]!)).mode & 0o777, 0o600);
});

test("tenant content fails closed on cross-tenant access, tampering, missing keys, and symlinked roots", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-opc-content-security-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const keys = new Map<string, Buffer>();
  const provider = {
    async keyForTenant(tenantId: string) {
      let key = keys.get(tenantId);
      if (key === undefined) {
        key = Buffer.alloc(32, tenantId === "tenant-a" ? 1 : 2);
        keys.set(tenantId, key);
      }
      return { key, keyRef: `test-key:${tenantId}` };
    }
  };
  const contentRoot = join(rootDir, "content");
  const store = new EncryptedTenantContentStore(contentRoot, provider);
  const ref = await store.put({
    tenantId: "tenant-a", mediaType: "audio/mp4", plaintext: Buffer.from("audio", "utf8")
  });
  await assert.rejects(() => store.read({ ...ref, tenantId: "tenant-b" }), /tenant/u);

  const [objectPath] = await encryptedContentFiles(contentRoot);
  assert.ok(objectPath);
  const envelope = JSON.parse(await readFile(objectPath, "utf8")) as { ciphertext: string };
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  await assert.rejects(() => store.read(ref), /authenticate|integrity/u);

  const missingProvider = { async keyForTenant() { throw new Error("tenant key is unavailable"); } };
  await assert.rejects(
    () => new EncryptedTenantContentStore(contentRoot, missingProvider).read(ref),
    /key is unavailable/u
  );

  const symlinkTarget = join(rootDir, "symlink-target");
  await writeFile(symlinkTarget, "do not overwrite", "utf8");
  const symlinkRoot = join(rootDir, "symlink-root");
  await symlink(symlinkTarget, symlinkRoot);
  await assert.rejects(
    () => new EncryptedTenantContentStore(symlinkRoot, provider).put({
      tenantId: "tenant-a", mediaType: "text/plain", plaintext: Buffer.from("secret")
    }),
    /symbolic link|directory/u
  );
  assert.equal(await readFile(symlinkTarget, "utf8"), "do not overwrite");
});

test("cloud tenant content uses per-object data keys wrapped by the tenant envelope provider", async () => {
  const blobs = new Map<string, Buffer>();
  const wrappedKeys = new Map<string, { tenantId: string; key: Buffer }>();
  let sequence = 0;
  const backend = {
    async putIfAbsent(input: { tenantId: string; objectId: string; content: Uint8Array }) {
      const key = `${input.tenantId}\0${input.objectId}`;
      if (blobs.has(key)) return "exists" as const;
      blobs.set(key, Buffer.from(input.content));
      return "created" as const;
    },
    async get(tenantId: string, objectId: string) {
      return blobs.get(`${tenantId}\0${objectId}`);
    }
  };
  const keys = {
    async generateDataKey(tenantId: string) {
      const key = Buffer.alloc(32, ++sequence);
      const wrappedKey = `wrapped-key-${sequence}`;
      wrappedKeys.set(wrappedKey, { tenantId, key });
      return { plaintextKey: key, wrappedKey, keyRef: `kms-key:${tenantId}` };
    },
    async decryptDataKey(tenantId: string, wrappedKey: string, keyRef: string) {
      const stored = wrappedKeys.get(wrappedKey);
      if (stored?.tenantId !== tenantId || keyRef !== `kms-key:${tenantId}`) {
        throw new Error("KMS tenant binding rejected");
      }
      return stored.key;
    }
  };
  const store = new TenantEnvelopeContentStore(backend, keys);
  await assert.rejects(() => store.put({
    tenantId: "tenant-cloud", mediaType: "text/plain", plaintext: Buffer.alloc(0)
  }), /must not be empty/u);
  const plaintext = Buffer.from("private SaaS transcript", "utf8");
  const ref = await store.put({ tenantId: "tenant-cloud", mediaType: "text/plain", plaintext });
  assert.equal(ref.storage, "tenant_s3");
  assert.equal(ref.encryption, "tenant-envelope");
  assert.deepEqual(await store.read(ref), plaintext);
  assert.equal([...blobs.values()][0]!.includes(plaintext), false);

  const replay = await store.put({ tenantId: "tenant-cloud", mediaType: "text/plain", plaintext });
  assert.deepEqual(replay, ref);
  assert.equal(blobs.size, 1);
  await assert.rejects(() => store.read({ ...ref, tenantId: "tenant-other" }), /tenant content/u);

  const blobKey = [...blobs.keys()][0]!;
  const originalEnvelope = blobs.get(blobKey)!;
  const envelope = JSON.parse(originalEnvelope.toString("utf8")) as { tag: string };
  envelope.tag = "AAAAAAAAAAAAAAAAAAAAAA==";
  blobs.set(blobKey, Buffer.from(JSON.stringify(envelope), "utf8"));
  await assert.rejects(() => store.read(ref), /authentication|integrity/u);

  blobs.set(blobKey, originalEnvelope);
  await assert.rejects(() => new TenantEnvelopeContentStore(backend, {
    ...keys,
    async decryptDataKey() { throw new Error("KMS rejected wrapped key"); }
  }).read(ref), /key authentication/u);
  await assert.rejects(() => store.read({
    ...ref, storage: "tenant_cas", encryption: "aes-256-gcm"
  }), /reference contract/u);
  assert.throws(() => new TenantEnvelopeContentStore(backend, keys, 0), /maximumBytes/u);
  await assert.rejects(() => new TenantEnvelopeContentStore(backend, keys, 1).put({
    tenantId: "tenant-cloud", mediaType: "text/plain", plaintext: Buffer.from("too large")
  }), /size limit/u);
  await assert.rejects(() => new TenantEnvelopeContentStore({
    ...backend,
    async putIfAbsent() { return "invalid" as never; }
  }, keys).put({
    tenantId: "tenant-cloud", mediaType: "text/plain", plaintext: Buffer.from("another")
  }), /invalid outcome/u);
  await assert.rejects(() => new TenantEnvelopeContentStore({
    async putIfAbsent() { return "created" as const; },
    async get() { return Buffer.from("not-json", "utf8"); }
  }, keys).read(ref), /valid JSON/u);
  await assert.rejects(() => new TenantEnvelopeContentStore({
    async putIfAbsent() { return "created" as const; },
    async get() { return Buffer.alloc(70_000); }
  }, keys).read(ref), /integrity bound/u);
});

test("dispatch refuses connectors without strong idempotency", async () => {
  const store = new MemoryOpcStore();
  await seedAction(store, "action-weak-idempotency");
  const dispatcher = new ControlledEffectDispatcher(store);
  await assert.rejects(() => dispatcher.dispatch({
    tenantId: "tenant-a",
    actionId: "action-weak-idempotency",
    dispatchId: "weak-dispatch",
    connector: {
      id: "crm",
      idempotency: "none" as never,
      effectIds: ["crm.record.write"],
      async execute() { return { status: "succeeded" }; }
    },
    now: "2026-08-26T02:00:00.000Z"
  }), /strong idempotency/u);
});

async function encryptedContentFiles(rootDir: string): Promise<string[]> {
  const tenantDirectories = await readdir(join(rootDir, "objects"));
  const result: string[] = [];
  for (const tenantDirectory of tenantDirectories) {
    const directory = join(rootDir, "objects", tenantDirectory);
    for (const file of await readdir(directory)) {
      if (file.endsWith(".json")) result.push(join(directory, file));
    }
  }
  return result;
}
