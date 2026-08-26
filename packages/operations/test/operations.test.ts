// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  appendOperationEvent,
  assertAuthorityDecisionCurrent,
  createAuthorityDecision,
  createOperationRun,
  resumeOperationRun,
  sortAttentionItems,
  verifyOperationEventChain
} from "../src/index.js";
import type {
  ActionIntentV1,
  AttentionItemV1,
  OperationRunV1
} from "../src/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);

function makeRun(): OperationRunV1 {
  return createOperationRun({
    id: "run-1",
    tenantId: "tenant-1",
    domainId: "opc",
    subjectRefs: [{ kind: "customer_commitment", id: "commitment-1", digest: DIGEST_A }],
    specRef: { id: "spec-1", version: "2", digest: DIGEST_A },
    governanceDigest: DIGEST_B,
    harnessDigest: DIGEST_C,
    domainModuleRef: { id: "opc", version: "0.3.0", digest: DIGEST_D },
    workflowRef: { id: "visit", version: "1.0.0", digest: DIGEST_A },
    currentStage: "qualification",
    createdAt: "2026-08-26T00:00:00.000Z"
  });
}

test("operation run freezes immutable bindings and resumes with a new generation", () => {
  const run = makeRun();
  assert.equal(run.schemaVersion, 1);
  assert.equal(run.generation, 1);
  assert.equal(run.status, "queued");
  assert.equal(Object.isFrozen(run), true);
  assert.equal(Object.isFrozen(run.subjectRefs), true);

  const resumed = resumeOperationRun(run, {
    updatedAt: "2026-08-26T01:00:00.000Z",
    expected: {
      specDigest: DIGEST_A,
      governanceDigest: DIGEST_B,
      harnessDigest: DIGEST_C,
      domainModuleDigest: DIGEST_D,
      workflowDigest: DIGEST_A
    }
  });
  assert.equal(resumed.generation, 2);
  assert.equal(resumed.status, "queued");
  assert.deepEqual(resumed.specRef, run.specRef);

  assert.throws(() => resumeOperationRun(run, {
    updatedAt: "2026-08-26T01:00:00.000Z",
    expected: {
      specDigest: DIGEST_B,
      governanceDigest: DIGEST_B,
      harnessDigest: DIGEST_C,
      domainModuleDigest: DIGEST_D,
      workflowDigest: DIGEST_A
    }
  }), /immutable operation binding changed/u);
});

test("operation events form a tenant-bound digest chain", () => {
  const first = appendOperationEvent(undefined, {
    id: "event-1",
    tenantId: "tenant-1",
    runId: "run-1",
    kind: "source_captured",
    actor: "user-1",
    sourceRefs: ["artifact:source-1"],
    payloadRef: "artifact:payload-1",
    createdAt: "2026-08-26T00:01:00.000Z"
  });
  const second = appendOperationEvent(first, {
    id: "event-2",
    tenantId: "tenant-1",
    runId: "run-1",
    kind: "approval",
    actor: "user-2",
    sourceRefs: [first.digest],
    payloadRef: "decision:1",
    createdAt: "2026-08-26T00:02:00.000Z"
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.previousDigest, first.digest);
  assert.equal(verifyOperationEventChain([first, second]), true);
  assert.throws(() => appendOperationEvent(first, {
    id: "event-x",
    tenantId: "tenant-2",
    runId: "run-1",
    kind: "approval",
    actor: "user-2",
    sourceRefs: [],
    payloadRef: "decision:x",
    createdAt: "2026-08-26T00:02:00.000Z"
  }), /tenant and run/u);
  assert.equal(verifyOperationEventChain([{ ...second, digest: DIGEST_A }]), false);
});

function attention(overrides: Partial<AttentionItemV1>): AttentionItemV1 {
  return {
    schemaVersion: 1,
    id: "attention-1",
    tenantId: "tenant-1",
    sourceKind: "approval",
    sourceId: "action-1",
    consequenceTier: "medium",
    dueAt: "2026-08-27T00:00:00.000Z",
    blockedCommitmentIds: [],
    estimatedHumanMinutes: 5,
    eligibleRoles: ["founder"],
    evidenceRefs: [],
    inputDigest: DIGEST_A,
    status: "pending",
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides
  };
}

test("attention scheduling is deterministic and ignores caller order", () => {
  const items = [
    attention({ id: "later", consequenceTier: "critical", dueAt: "2026-08-29T00:00:00.000Z" }),
    attention({ id: "overdue-low", consequenceTier: "low", dueAt: "2026-08-25T00:00:00.000Z" }),
    attention({ id: "overdue-high", consequenceTier: "high", dueAt: "2026-08-25T00:00:00.000Z" }),
    attention({ id: "blocked-two", blockedCommitmentIds: ["c1", "c2"] }),
    attention({ id: "blocked-one", blockedCommitmentIds: ["c1"] })
  ];
  const sorted = sortAttentionItems(items, "2026-08-26T12:00:00.000Z");
  assert.deepEqual(sorted.map((item) => item.id), [
    "overdue-high",
    "overdue-low",
    "later",
    "blocked-two",
    "blocked-one"
  ]);
  assert.equal(Object.isFrozen(sorted), true);
});

test("attention scheduling uses commitment deadlines before blocked counts", () => {
  const sorted = sortAttentionItems([
    attention({
      id: "two-blocked",
      blockedCommitmentIds: ["c1", "c2"],
      earliestCommitmentDueAt: "2026-08-29T00:00:00.000Z"
    }),
    attention({
      id: "one-blocked-earlier",
      blockedCommitmentIds: ["c1"],
      earliestCommitmentDueAt: "2026-08-28T00:00:00.000Z"
    })
  ], "2026-08-26T12:00:00.000Z");
  assert.deepEqual(sorted.map((item) => item.id), ["one-blocked-earlier", "two-blocked"]);
  assert.throws(
    () => sortAttentionItems([attention({ estimatedHumanMinutes: -1 })], "2026-08-26T12:00:00.000Z"),
    /estimatedHumanMinutes/u
  );
});

function action(overrides: Partial<ActionIntentV1> = {}): ActionIntentV1 {
  return {
    schemaVersion: 1,
    id: "action-1",
    tenantId: "tenant-1",
    runId: "run-1",
    generation: 1,
    effectId: "dingtalk.todo.create",
    targetRef: "dingtalk:user-1",
    inputDigest: DIGEST_A,
    governanceDigest: DIGEST_B,
    consequenceTier: "high",
    reversibility: "compensating",
    compensationRef: "dingtalk.todo.delete",
    idempotencyKey: "request-1",
    expiresAt: "2026-08-27T00:00:00.000Z",
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides
  };
}

test("authority decisions grant only the exact unexpired action generation", () => {
  const intent = action();
  const decision = createAuthorityDecision(intent, {
    id: "decision-1",
    decision: "approve",
    actor: "founder-1",
    actorRole: "founder",
    decidedAt: "2026-08-26T01:00:00.000Z"
  });
  assert.equal(assertAuthorityDecisionCurrent(decision, intent, "2026-08-26T02:00:00.000Z"), true);
  assert.throws(
    () => assertAuthorityDecisionCurrent(decision, action({ generation: 2 }), "2026-08-26T02:00:00.000Z"),
    /stale authority decision/u
  );
  assert.throws(
    () => assertAuthorityDecisionCurrent(decision, intent, "2026-08-28T00:00:00.000Z"),
    /expired/u
  );
  assert.throws(
    () => assertAuthorityDecisionCurrent(decision, intent, intent.expiresAt),
    /expired/u
  );
  assert.throws(
    () => assertAuthorityDecisionCurrent(decision, intent, "2026-08-26T00:30:00.000Z"),
    /not yet effective/u
  );
  assert.throws(() => createAuthorityDecision(intent, {
    id: "decision-late",
    decision: "approve",
    actor: "founder-1",
    actorRole: "founder",
    decidedAt: intent.expiresAt
  }), /expired action intent/u);
  const rejected = createAuthorityDecision(intent, {
    id: "decision-2",
    decision: "reject",
    actor: "founder-1",
    actorRole: "founder",
    decidedAt: "2026-08-26T01:00:00.000Z"
  });
  assert.equal(assertAuthorityDecisionCurrent(rejected, intent, "2026-08-26T02:00:00.000Z"), false);
});

test("deferred decisions require a future deadline and terminal runs cannot resume", () => {
  const intent = action();
  assert.throws(() => createAuthorityDecision(intent, {
    id: "decision-defer",
    decision: "defer",
    actor: "founder-1",
    actorRole: "founder",
    decidedAt: "2026-08-26T01:00:00.000Z"
  }), /deferUntil/u);
  const deferred = createAuthorityDecision(intent, {
    id: "decision-defer",
    decision: "defer",
    actor: "founder-1",
    actorRole: "founder",
    decidedAt: "2026-08-26T01:00:00.000Z",
    deferUntil: "2026-08-26T03:00:00.000Z"
  });
  assert.equal(assertAuthorityDecisionCurrent(deferred, intent, "2026-08-26T02:00:00.000Z"), false);

  const completed = { ...makeRun(), status: "completed" as const };
  assert.throws(() => resumeOperationRun(completed, {
    updatedAt: "2026-08-26T01:00:00.000Z",
    expected: {
      specDigest: DIGEST_A,
      governanceDigest: DIGEST_B,
      harnessDigest: DIGEST_C,
      domainModuleDigest: DIGEST_D,
      workflowDigest: DIGEST_A
    }
  }), /terminal operation run/u);
  assert.equal(verifyOperationEventChain([]), true);
});
