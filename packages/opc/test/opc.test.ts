// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  VISIT_ASSISTANT_PACK_V1,
  createBusinessRecord,
  createCustomerCommitment,
  createMoney,
  createPublicationEnvelope,
  createSettlementRecord,
  parseBusinessPackManifest,
  reviseBusinessRecord,
  transitionVisitState
} from "../src/index.js";

const DIGEST = "a".repeat(64);

test("money uses canonical ISO currency and integer minor units", () => {
  assert.deepEqual(createMoney("CNY", "10000"), { currency: "CNY", minorUnits: "10000" });
  assert.deepEqual(createMoney("USD", "-25"), { currency: "USD", minorUnits: "-25" });
  assert.throws(() => createMoney("cny", "100"), /currency/u);
  assert.throws(() => createMoney("CNY", "01"), /minorUnits/u);
  assert.throws(() => createMoney("CNY", "1.5"), /minorUnits/u);
});

test("business records are append-only tenant-bound digest revisions", () => {
  const first = createBusinessRecord({
    tenantId: "tenant-1",
    kind: "customer",
    id: "customer-1",
    status: "proposed",
    payload: { name: "Example Industrial" },
    createdAt: "2026-08-26T00:00:00.000Z",
    createdBy: "founder-1"
  });
  const second = reviseBusinessRecord(first, {
    status: "verified",
    payload: { name: "Example Industrial", verifiedBy: "customer" },
    createdAt: "2026-08-26T01:00:00.000Z",
    createdBy: "founder-1"
  });
  assert.equal(second.revision, 2);
  assert.equal(second.previousDigest, first.digest);
  assert.notEqual(second.payloadDigest, first.payloadDigest);
  assert.equal(Object.isFrozen(second.payload), true);
  assert.throws(() => reviseBusinessRecord({ ...first, tenantId: "tenant-2" }, {
    status: "verified",
    payload: {},
    createdAt: "2026-08-26T01:00:00.000Z",
    createdBy: "founder-1"
  }), /digest/u);
});

test("customer commitment captures acceptance, authority, price and data authorization", () => {
  const commitment = createCustomerCommitment({
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
    approverRefs: ["founder-1", "customer-manager-1"]
  });
  assert.equal(commitment.price.minorUnits, "10000");
  assert.equal(Object.isFrozen(commitment.acceptanceCriteria), true);
  assert.throws(() => createCustomerCommitment({ ...commitment, approverRefs: [] }), /approverRefs/u);
});

test("settlement is an evidence record and exposes no payment effect", () => {
  const settlement = createSettlementRecord({
    id: "settlement-1",
    commitmentRef: "commitment-1",
    contracted: { currency: "CNY", minorUnits: "10000" },
    invoiced: { currency: "CNY", minorUnits: "10000" },
    received: { currency: "CNY", minorUnits: "10000" },
    modelCost: { currency: "CNY", minorUnits: "15" },
    externalCost: { currency: "CNY", minorUnits: "20" },
    humanMinutes: 45,
    sourceRefs: ["invoice-1", "receipt-1"],
    recordedAt: "2026-09-02T00:00:00.000Z",
    recordedBy: "founder-1"
  });
  assert.equal("effectId" in settlement, false);
  assert.equal(settlement.received?.minorUnits, "10000");
});

test("publication uses an explicit field allowlist and cannot mutate its source", () => {
  const source = createBusinessRecord({
    tenantId: "founder-local",
    kind: "opportunity",
    id: "opportunity-1",
    status: "verified",
    payload: { customerName: "Example Industrial", internalScore: 91, nextStep: "paid-pilot" },
    createdAt: "2026-08-26T00:00:00.000Z",
    createdBy: "founder-1"
  });
  const publication = createPublicationEnvelope(source, {
    id: "publication-1",
    targetTenantId: "tenant-1",
    purpose: "paid-pilot-onboarding",
    allowedFields: ["customerName", "nextStep"],
    retentionUntil: "2026-12-31T00:00:00.000Z",
    idempotencyKey: "publish-1",
    createdAt: "2026-08-26T01:00:00.000Z",
    createdBy: "founder-1"
  });
  assert.deepEqual(publication.publishedPayload, {
    customerName: "Example Industrial",
    nextStep: "paid-pilot"
  });
  assert.equal("internalScore" in publication.publishedPayload, false);
  assert.throws(() => createPublicationEnvelope(source, {
    id: "publication-2",
    targetTenantId: "tenant-1",
    purpose: "paid-pilot-onboarding",
    allowedFields: [],
    retentionUntil: "2026-12-31T00:00:00.000Z",
    idempotencyKey: "publish-2",
    createdAt: "2026-08-26T01:00:00.000Z",
    createdBy: "founder-1"
  }), /allowedFields/u);
});

test("visit assistant pack is declarative and rejects unregistered capabilities", () => {
  const registry = {
    recordSchemas: VISIT_ASSISTANT_PACK_V1.recordSchemas,
    workflows: VISIT_ASSISTANT_PACK_V1.workflows,
    gates: VISIT_ASSISTANT_PACK_V1.gates,
    connectors: VISIT_ASSISTANT_PACK_V1.connectors,
    renderers: VISIT_ASSISTANT_PACK_V1.renderers,
    externalEffects: VISIT_ASSISTANT_PACK_V1.externalEffects
  };
  const parsed = parseBusinessPackManifest(VISIT_ASSISTANT_PACK_V1, registry);
  assert.equal(parsed.id, "opc.visit-assistant");
  assert.equal(Object.isFrozen(parsed), true);
  assert.throws(
    () => parseBusinessPackManifest({ ...VISIT_ASSISTANT_PACK_V1, entry: "plugin.mjs" }, registry),
    /unsupported/u
  );
  assert.throws(
    () => parseBusinessPackManifest({
      ...VISIT_ASSISTANT_PACK_V1,
      externalEffects: ["payment.execute"]
    }, registry),
    /not registered/u
  );
});

test("visit state machine permits review repair and blocks terminal replay", () => {
  assert.equal(transitionVisitState("processing", "review_required"), "review_required");
  assert.equal(transitionVisitState("review_required", "processing"), "processing");
  assert.equal(transitionVisitState("confirmed", "completed"), "completed");
  assert.throws(() => transitionVisitState("completed", "processing"), /invalid visit transition/u);
  assert.throws(() => transitionVisitState("draft", "completed"), /invalid visit transition/u);
});
