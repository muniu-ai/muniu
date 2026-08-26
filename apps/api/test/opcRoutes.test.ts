// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { MemoryOpcStore } from "@mn/opc-store";
import type { ActionIntentV1, AttentionItemV1 } from "@mn/operations";

import { registerOpcRoutes } from "../src/opcRoutes.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const NOW = "2026-08-26T00:00:00.000Z";

async function fixture(tenantId = "tenant-a") {
  const app = Fastify({ logger: false });
  const store = new MemoryOpcStore();
  registerOpcRoutes(app, {
    store,
    contextForRequest: () => ({
      tenantId,
      actorId: `${tenantId}-actor`,
      roles: ["org_admin"]
    })
  });
  return { app, store };
}

function commitmentPayload() {
  return {
    schemaVersion: 1,
    accountRef: "customer-1",
    promisedOutcome: "Produce a confirmed visit record.",
    scope: ["One industrial B2B visit."],
    nonGoals: ["No automatic customer message."],
    price: { currency: "CNY", minorUnits: "10000" },
    dueAt: "2026-09-01T00:00:00.000Z",
    dataAuthorizationRefs: ["authorization-1"],
    acceptanceCriteria: ["Every confirmed field references a source fragment."],
    customerResponsibilities: ["Confirm extracted facts."],
    providerResponsibilities: ["Keep the original source."],
    approverRefs: ["customer-manager-1"]
  };
}

test("OPC record routes derive tenant and enforce revision CAS plus idempotency", async () => {
  const { app, store } = await fixture();
  const invalid = await app.inject({
    method: "POST",
    url: "/v1/opc-records",
    payload: {
      requestId: "request-invalid",
      expectedRevision: 0,
      tenantId: "tenant-b",
      id: "customer-1",
      kind: "customer",
      status: "proposed",
      payload: { name: "Example" },
      createdAt: NOW
    }
  });
  assert.equal(invalid.statusCode, 400);

  const body = {
    requestId: "request-1",
    expectedRevision: 0,
    id: "customer-1",
    kind: "customer",
    status: "proposed",
    payload: { name: "Example" },
    createdAt: NOW
  };
  const created = await app.inject({ method: "POST", url: "/v1/opc-records", payload: body });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().value.tenantId, "tenant-a");
  const replay = await app.inject({ method: "POST", url: "/v1/opc-records", payload: body });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), created.json());

  const conflict = await app.inject({
    method: "POST",
    url: "/v1/opc-records/customer-1/revisions",
    payload: {
      requestId: "request-2",
      expectedRevision: 0,
      status: "verified",
      payload: { name: "Example" },
      createdAt: "2026-08-26T01:00:00.000Z"
    }
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "REVISION_CONFLICT");

  const revised = await app.inject({
    method: "POST",
    url: "/v1/opc-records/customer-1/revisions",
    payload: {
      requestId: "request-2",
      expectedRevision: 1,
      status: "verified",
      payload: { name: "Example" },
      createdAt: "2026-08-26T01:00:00.000Z"
    }
  });
  assert.equal(revised.statusCode, 201);
  assert.equal(revised.json().value.revision, 2);
  assert.equal((await store.read("tenant-b", "record", "customer-1")), undefined);
  await app.close();
});

test("approved commitment compiles an immutable domain run and evidence export", async () => {
  const { app } = await fixture();
  const created = await app.inject({
    method: "POST",
    url: "/v1/opc-records",
    payload: {
      requestId: "commitment-create",
      expectedRevision: 0,
      id: "commitment-1",
      kind: "customer_commitment",
      status: "proposed",
      payload: commitmentPayload(),
      createdAt: NOW
    }
  });
  assert.equal(created.statusCode, 201);
  const approved = await app.inject({
    method: "POST",
    url: "/v1/opc-commitments/commitment-1/approve",
    payload: {
      requestId: "commitment-approve",
      expectedRevision: 1,
      approvedAt: "2026-08-26T01:00:00.000Z"
    }
  });
  assert.equal(approved.statusCode, 201);
  assert.equal(approved.json().value.status, "verified");

  const run = await app.inject({
    method: "POST",
    url: "/v1/opc-commitments/commitment-1/runs",
    payload: {
      requestId: "run-create",
      expectedRevision: 0,
      id: "operation-1",
      specRef: { id: "spec-1", version: "2", digest: A },
      governanceDigest: B,
      harnessDigest: C,
      domainModuleRef: { id: "opc", version: "0.3.0", digest: D },
      workflowRef: { id: "opc.visit-assistant", version: "1.0.0", digest: A },
      currentStage: "prepared",
      createdAt: "2026-08-26T02:00:00.000Z"
    }
  });
  assert.equal(run.statusCode, 201);
  assert.equal(run.json().value.tenantId, "tenant-a");
  assert.equal(run.json().value.subjectRefs[0].id, "commitment-1");

  const read = await app.inject({ method: "GET", url: "/v1/domain-runs/operation-1" });
  assert.equal(read.statusCode, 200);
  const events = await app.inject({ method: "GET", url: "/v1/domain-runs/operation-1/events" });
  assert.equal(events.statusCode, 200);
  assert.equal(events.json().events.length, 1);
  const exported = await app.inject({
    method: "GET",
    url: "/v1/domain-runs/operation-1/evidence-export"
  });
  assert.equal(exported.statusCode, 200);
  assert.match(exported.json().digest, /^[a-f0-9]{64}$/u);
  assert.equal(exported.json().run.id, "operation-1");
  await app.close();
});

test("attention and action decisions remain bound to the tenant, generation, and input digest", async () => {
  const { app, store } = await fixture();
  const action: ActionIntentV1 = {
    schemaVersion: 1,
    id: "action-1",
    tenantId: "tenant-a",
    runId: "operation-1",
    generation: 1,
    effectId: "crm.record.write",
    targetRef: "crm:customer-1",
    inputDigest: A,
    governanceDigest: B,
    consequenceTier: "high",
    reversibility: "compensating",
    compensationRef: "crm.record.restore",
    idempotencyKey: "effect-1",
    expiresAt: "2026-08-28T00:00:00.000Z",
    createdAt: NOW
  };
  const urgent: AttentionItemV1 = {
    schemaVersion: 1,
    id: "attention-urgent",
    tenantId: "tenant-a",
    sourceKind: "approval",
    sourceId: action.id,
    consequenceTier: "high",
    dueAt: "2026-08-25T00:00:00.000Z",
    blockedCommitmentIds: ["commitment-1"],
    estimatedHumanMinutes: 3,
    eligibleRoles: ["org_admin"],
    evidenceRefs: ["event-1"],
    inputDigest: A,
    status: "pending",
    createdAt: NOW
  };
  const later = { ...urgent, id: "attention-later", dueAt: "2026-08-29T00:00:00.000Z" };
  await store.append({
    tenantId: "tenant-a", kind: "action_intent", id: action.id,
    expectedRevision: 0, requestId: "seed-action", value: action as never, createdAt: NOW
  });
  await store.append({
    tenantId: "tenant-a", kind: "attention_item", id: urgent.id,
    expectedRevision: 0, requestId: "seed-attention-1", value: urgent as never, createdAt: NOW
  });
  await store.append({
    tenantId: "tenant-a", kind: "attention_item", id: later.id,
    expectedRevision: 0, requestId: "seed-attention-2", value: later as never, createdAt: NOW
  });

  const items = await app.inject({
    method: "GET",
    url: "/v1/attention-items?now=2026-08-26T00%3A00%3A00.000Z"
  });
  assert.equal(items.statusCode, 200);
  assert.deepEqual(items.json().items.map((item: { id: string }) => item.id), [
    "attention-urgent",
    "attention-later"
  ]);

  const unauthorizedApp = Fastify({ logger: false });
  registerOpcRoutes(unauthorizedApp, {
    store,
    contextForRequest: () => ({
      tenantId: "tenant-a",
      actorId: "reviewer-1",
      roles: ["reviewer"]
    })
  });
  const unauthorized = await unauthorizedApp.inject({
    method: "POST",
    url: "/v1/action-intents/action-1/decide",
    payload: {
      requestId: "decision-forged-role",
      expectedRevision: 0,
      decision: "approve",
      actorRole: "org_admin",
      decidedAt: "2026-08-26T00:30:00.000Z"
    }
  });
  assert.equal(unauthorized.statusCode, 403);
  await unauthorizedApp.close();

  const decision = await app.inject({
    method: "POST",
    url: "/v1/action-intents/action-1/decide",
    payload: {
      requestId: "decision-1",
      expectedRevision: 0,
      decision: "approve",
      actorRole: "org_admin",
      decidedAt: "2026-08-26T01:00:00.000Z"
    }
  });
  assert.equal(decision.statusCode, 201);
  assert.equal(decision.json().value.actor, "tenant-a-actor");
  assert.equal(decision.json().value.generation, 1);

  const attentionDecision = await app.inject({
    method: "POST",
    url: "/v1/attention-items/attention-urgent/decide",
    payload: {
      requestId: "attention-decision-1",
      expectedRevision: 0,
      decision: "reject",
      actorRole: "org_admin",
      decidedAt: "2026-08-26T01:05:00.000Z"
    }
  });
  assert.equal(attentionDecision.statusCode, 201);
  assert.equal(attentionDecision.json().value.actionId, "action-1");
  await app.close();
});

test("settlement, publication, business pack, and domain catalogs expose governed records", async () => {
  const { app } = await fixture();
  const domains = await app.inject({ method: "GET", url: "/v1/domains" });
  assert.equal(domains.statusCode, 200);
  assert.deepEqual(domains.json().domains.map((domain: { id: string }) => domain.id), ["coding", "opc"]);

  const source = await app.inject({
    method: "POST",
    url: "/v1/opc-records",
    payload: {
      requestId: "opportunity-create",
      expectedRevision: 0,
      id: "opportunity-2",
      kind: "opportunity",
      status: "verified",
      payload: { customerName: "Example", internalScore: 91 },
      createdAt: NOW
    }
  });
  assert.equal(source.statusCode, 201);

  const publication = await app.inject({
    method: "POST",
    url: "/v1/publications",
    payload: {
      requestId: "publication-create",
      expectedRevision: 0,
      id: "publication-1",
      sourceRecordId: "opportunity-2",
      targetTenantId: "tenant-cloud",
      purpose: "paid-pilot",
      allowedFields: ["customerName"],
      retentionUntil: "2026-12-31T00:00:00.000Z",
      idempotencyKey: "publication-effect-1",
      createdAt: "2026-08-26T01:00:00.000Z"
    }
  });
  assert.equal(publication.statusCode, 201);
  assert.equal(publication.json().value.sourceTenantId, "tenant-a");
  assert.equal("internalScore" in publication.json().value.publishedPayload, false);

  const settlement = await app.inject({
    method: "POST",
    url: "/v1/opc-settlements",
    payload: {
      requestId: "settlement-create",
      expectedRevision: 0,
      id: "settlement-1",
      commitmentRef: "commitment-1",
      contracted: { currency: "CNY", minorUnits: "10000" },
      received: { currency: "CNY", minorUnits: "10000" },
      modelCost: { currency: "CNY", minorUnits: "15" },
      humanMinutes: 30,
      sourceRefs: ["receipt-1"],
      recordedAt: "2026-08-27T00:00:00.000Z"
    }
  });
  assert.equal(settlement.statusCode, 201);
  assert.equal("effectId" in settlement.json().value, false);

  const packs = await app.inject({ method: "GET", url: "/v1/business-packs" });
  assert.equal(packs.statusCode, 200);
  assert.equal(packs.json().businessPacks[0].id, "opc.visit-assistant");
  const enabled = await app.inject({
    method: "POST",
    url: "/v1/business-packs/opc.visit-assistant/enable",
    payload: {
      requestId: "pack-enable",
      expectedRevision: 0,
      version: "1.0.0",
      enabled: true,
      createdAt: "2026-08-26T02:00:00.000Z"
    }
  });
  assert.equal(enabled.statusCode, 201);
  const receipts = await app.inject({ method: "GET", url: "/v1/publication-receipts" });
  assert.equal(receipts.statusCode, 200);
  assert.deepEqual(receipts.json().receipts, []);
  await app.close();
});
