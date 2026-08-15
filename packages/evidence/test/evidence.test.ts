import assert from "node:assert/strict";
import test from "node:test";
import {
  EvalAssetRegistry,
  LearningProposalRegistry,
  analyzeTraceGraph,
  buildMaturityReport,
  createEvalAssetRevision,
  createTraceGraph,
  type CreateEvalAssetInput,
  type TraceNode
} from "../src/index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

test("Eval Asset Registry persists immutable clause-bound revisions", () => {
  const registry = new EvalAssetRegistry();
  const first = registry.register(asset());
  const second = registry.register({
    ...asset(),
    revision: 2,
    createdAt: "2026-07-12T00:00:00.000Z",
    supersedesDigest: first.digest,
    contentDigest: B
  });
  assert.equal(second.revision, 2);
  assert.equal(registry.get("contract-check")?.digest, second.digest);
  assert.deepEqual(registry.list({ specClauseId: "accept-checkout" }), [second]);
  assert.ok(Object.isFrozen(second));
  assert.throws(
    () =>
      registry.register({
        ...asset(),
        revision: 3,
        createdAt: "2026-07-13T00:00:00.000Z",
        supersedesDigest: A
      }),
    /does not supersede/u
  );
});

test("Eval Asset validation is exact and descriptor safe", () => {
  assert.throws(
    () => createEvalAssetRevision({ ...asset(), execute: "rm" } as never),
    /unsupported/u
  );
  let calls = 0;
  const malicious: Record<string, unknown> = {};
  Object.defineProperty(malicious, "id", {
    enumerable: true,
    get() {
      calls += 1;
      return "bad";
    }
  });
  assert.throws(() => createEvalAssetRevision(malicious as never), /accessor/u);
  assert.equal(calls, 0);
});

test("Trace Graph proves Spec clauses through design, diff, test, and observation", () => {
  const graph = createTraceGraph({
    nodes: [
      node("spec", "spec_clause", "accept-checkout"),
      node("design", "design_contract", "openapi:checkout"),
      node("diff", "diff", "commit:1"),
      node("test", "test_gate", "gate:contract"),
      node("observe", "observation", "probe:checkout")
    ],
    edges: [
      { from: "spec", to: "design", kind: "designs" },
      { from: "design", to: "diff", kind: "implements" },
      { from: "diff", to: "test", kind: "verifies" },
      { from: "test", to: "observe", kind: "observes" }
    ]
  });
  const analysis = analyzeTraceGraph(graph, {
    requiredSpecClauseIds: ["accept-checkout"],
    contracts: [{ ref: "openapi:checkout", expectedDigest: A, actualDigest: A }],
    expectedContextDigest: B,
    actualContextDigest: B
  });
  assert.equal(analysis.complete, true);
  assert.equal(analysis.traceabilityRate, 1);
  assert.deepEqual(analysis.missingSpecClauseIds, []);
  assert.ok(Object.isFrozen(graph));
});

test("Trace analysis reports evidence, contract, and context drift", () => {
  const graph = createTraceGraph({
    nodes: [
      node("spec", "spec_clause", "accept-a"),
      node("orphan-diff", "diff", "commit:orphan"),
      node("orphan-test", "test_gate", "gate:orphan")
    ],
    edges: [{ from: "orphan-diff", to: "orphan-test", kind: "verifies" }]
  });
  const analysis = analyzeTraceGraph(graph, {
    requiredSpecClauseIds: ["accept-a", "accept-b"],
    contracts: [{ ref: "openapi:a", expectedDigest: A, actualDigest: B }],
    expectedContextDigest: B,
    actualContextDigest: C
  });
  assert.equal(analysis.complete, false);
  assert.deepEqual(analysis.missingSpecClauseIds, ["accept-a", "accept-b"]);
  assert.deepEqual(analysis.orphanDiffNodeIds, ["orphan-diff"]);
  assert.deepEqual(analysis.orphanEvidenceNodeIds, ["orphan-test"]);
  assert.deepEqual(analysis.contractDriftRefs, ["openapi:a"]);
  assert.equal(analysis.contextDrift, true);
});

test("Learning Proposal requires review, canary, trusted signature, and rollback", () => {
  const registry = new LearningProposalRegistry({
    verifySignature: ({ signature }) =>
      signature.keyId === "governance-key" && signature.value === "valid-signature"
  });
  const draft = registry.create(proposal());
  assert.equal(draft.status, "draft");
  registry.submit("learn-1", "reviewer", "2026-07-11T01:00:00.000Z");
  registry.review({
    id: "learn-1",
    approved: true,
    actor: "reviewer",
    decidedAt: "2026-07-11T02:00:00.000Z",
    reason: "Safe declarative change"
  });
  registry.recordCanary({
    id: "learn-1",
    passed: true,
    environment: "canary",
    evidenceDigest: B,
    completedAt: "2026-07-11T03:00:00.000Z",
    completedBy: "platform"
  });
  assert.throws(
    () =>
      registry.promote({
        id: "learn-1",
        promotedAt: "2026-07-11T04:00:00.000Z",
        promotedBy: "governance",
        rollbackRef: "pack-lock:previous",
        signature: { algorithm: "ed25519", keyId: "governance-key", value: "forged" }
      }),
    /not trusted/u
  );
  const promoted = registry.promote({
    id: "learn-1",
    promotedAt: "2026-07-11T04:00:00.000Z",
    promotedBy: "governance",
    rollbackRef: "pack-lock:previous",
    signature: {
      algorithm: "ed25519",
      keyId: "governance-key",
      value: "valid-signature"
    }
  });
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.promotion?.rollbackRef, "pack-lock:previous");
  const rolledBack = registry.rollback({
    id: "learn-1",
    actor: "governance",
    at: "2026-07-11T05:00:00.000Z",
    reason: "Canary regression after promotion"
  });
  assert.equal(rolledBack.status, "rolled_back");
});

test("Learning cannot skip approval or propose executable code activation", () => {
  const registry = new LearningProposalRegistry({ verifySignature: () => true });
  registry.create(proposal());
  assert.throws(
    () =>
      registry.recordCanary({
        id: "learn-1",
        passed: true,
        environment: "canary",
        evidenceDigest: A,
        completedAt: "2026-07-11T01:00:00.000Z",
        completedBy: "platform"
      }),
    /must be approved/u
  );
  assert.throws(
    () => registry.create({ ...proposal(), id: "bad", kind: "code" as never }),
    /unsupported/u
  );
  assert.throws(
    () => registry.create({ ...proposal(), id: "bad-2", activate: true } as never),
    /unsupported/u
  );
});

test("Maturity report computes bounded deterministic enterprise metrics", () => {
  const report = buildMaturityReport({
    incrementCycleSeconds: [100, 200],
    totalRuns: 10,
    failedRuns: 2,
    requiredContractClauses: 4,
    coveredContractClauses: 3,
    regressionRuns: 5,
    regressionHits: 2,
    contextComparisons: 8,
    contextDrifts: 1,
    aiChanges: 10,
    aiReworks: 3,
    completedRetrospectives: 4,
    retainedLearnings: 2,
    feedbackClosureSeconds: [300, 500]
  });
  assert.equal(report.verifiableIncrementCycleSeconds, 150);
  assert.equal(report.failureRate, 0.2);
  assert.equal(report.contractCoverageRate, 0.75);
  assert.equal(report.feedbackClosureSeconds, 400);
  assert.match(report.digest, /^[a-f0-9]{64}$/u);
  assert.throws(
    () => buildMaturityReport({
      ...({
        incrementCycleSeconds: [], totalRuns: 1, failedRuns: 2,
        requiredContractClauses: 0, coveredContractClauses: 0,
        regressionRuns: 0, regressionHits: 0, contextComparisons: 0,
        contextDrifts: 0, aiChanges: 0, aiReworks: 0,
        completedRetrospectives: 0, retainedLearnings: 0,
        feedbackClosureSeconds: []
      })
    }),
    /cannot exceed/u
  );
});

function asset(): CreateEvalAssetInput {
  return {
    id: "contract-check",
    revision: 1,
    kind: "contract_test",
    title: "Checkout contract",
    specRef: { specSetId: "checkout", revision: 2, digest: A },
    specClauseIds: ["accept-checkout"],
    serviceIds: ["checkout-api"],
    owner: "payments-team",
    source: { kind: "spec", ref: "specs/checkout/spec.yaml", digest: A },
    contentRef: "tests/contracts/checkout.test.ts",
    contentDigest: A,
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "developer"
  };
}

function node(id: string, kind: TraceNode["kind"], ref: string): TraceNode {
  return { id, kind, ref, digest: A, serviceIds: ["checkout-api"] };
}

function proposal() {
  return {
    id: "learn-1",
    kind: "standard_pack" as const,
    title: "Require checkout regression",
    rationale: "Repeated incident shows a durable gap",
    sourceRunId: "run-1",
    sourceEvidenceIds: ["evidence-1"],
    targetRef: "corp/default@next",
    changeDigest: A,
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "learning-stage"
  };
}
