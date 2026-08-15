import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { Project, RequestContext, RunRecord } from "@mn/core";
import {
  analyzeTraceGraph,
  createEvalAssetRevision,
  createTraceGraph,
  type CreateEvalAssetInput,
  type CreateLearningProposalInput
} from "@mn/evidence";
import { createApprovalDecision, type GovernedRunState } from "@mn/loop";
import type { SpecRevision } from "@mn/specs";
import { registerEvidenceRoutes } from "../src/evidenceRoutes.js";
import {
  aggregateEnterpriseMaturity,
  validateEnterpriseEvalAsset,
  validateEnterpriseLearningEvidence,
  validateEnterpriseTraceGraph,
  type EnterpriseEvidenceTruthResolvers
} from "../src/evidenceTruth.js";
import { MemoryStore, scopedEvidenceRecordKey } from "../src/store.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);
const TENANT = "tenant-a";
const PROJECT = "project-a";
const RUN = "run-1";
const ARTIFACT_URI = "s3://evidence/runs/run-1/contract.json";
const APPROVAL = createApprovalDecision({
  runId: RUN,
  stageAttemptId: "approval-1",
  decision: "approve",
  actorId: "reviewer-a",
  decidedAt: "2026-07-12T00:00:08.000Z"
});

test("enterprise Eval and Learning evidence must resolve approved Spec, services, and same-Run artifacts", async () => {
  const fixture = evidenceFixture();
  const valid = assetInput();
  await validateEnterpriseEvalAsset(valid, fixture.context);

  await assert.rejects(
    validateEnterpriseEvalAsset(
      { ...valid, specClauseIds: ["invented-clause"] },
      fixture.context
    ),
    /does not exist/u
  );
  await assert.rejects(
    validateEnterpriseEvalAsset(
      { ...valid, serviceIds: ["shadow-service"] },
      fixture.context
    ),
    /not declared by the project/u
  );
  await assert.rejects(
    validateEnterpriseEvalAsset(
      { ...valid, contentDigest: D },
      fixture.context
    ),
    /do not bind real/u
  );

  const asset = createEvalAssetRevision(valid);
  fixture.store.evalAssets.set(
    scopedEvidenceRecordKey(TENANT, PROJECT, asset.id, asset.revision),
    { tenantId: TENANT, projectId: PROJECT, asset }
  );
  const proposal = proposalInput();
  await validateEnterpriseLearningEvidence({ proposal, context: fixture.context });
  await assert.rejects(
    validateEnterpriseLearningEvidence({
      proposal: { ...proposal, sourceEvidenceIds: ["made-up-evidence"] },
      context: fixture.context
    }),
    /does not exist/u
  );
});

test("enterprise Trace Graph binds every node to one governed Run and derives required clauses", async () => {
  const fixture = evidenceFixture();
  const graph = validTraceGraph();
  const analysis = {
    requiredSpecClauseIds: ["accept-order"],
    contracts: [{ ref: "services/orders/openapi.yaml", expectedDigest: B, actualDigest: B }],
    expectedContextDigest: C,
    actualContextDigest: C
  };
  const resolved = await validateEnterpriseTraceGraph({
    graph,
    analysis,
    context: fixture.context
  });
  assert.equal(resolved.run.id, RUN);
  assert.deepEqual(
    resolved.run.gateResultsV2?.map((gate) => gate.status),
    ["fail", "pass"],
    "a historical failed Gate remains diagnostic while the later final Gate proves completion"
  );

  const forgedGate = createTraceGraph({
    nodes: graph.nodes.map((node) =>
      node.kind === "test_gate" ? { ...node, digest: A } : node
    ),
    edges: graph.edges
  });
  await assert.rejects(
    validateEnterpriseTraceGraph({ graph: forgedGate, analysis, context: fixture.context }),
    /not bound to a required passing GateResultV2/u
  );
  const resolverWithoutAuthoritativeGate: EnterpriseEvidenceTruthResolvers = {
    ...fixture.resolvers,
    resolveEvidenceReference: async (input) =>
      input.ref === "gate-result-1"
        ? undefined
        : fixture.resolvers.resolveEvidenceReference(input)
  };
  await assert.rejects(
    validateEnterpriseTraceGraph({
      graph,
      analysis,
      context: { ...fixture.context, resolvers: resolverWithoutAuthoritativeGate }
    }),
    /authoritative Gate receipt/u
  );

  const run = fixture.store.runs.get(RUN)!;
  fixture.store.runs.set(RUN, {
    ...run,
    gateResultsV2: run.gateResultsV2!.map((gate) => ({ ...gate, status: "fail" as const }))
  });
  await assert.rejects(
    validateEnterpriseTraceGraph({ graph, analysis, context: fixture.context }),
    /required GateResultV2 that did not pass/u
  );
  await assert.rejects(
    validateEnterpriseTraceGraph({
      graph,
      analysis: { ...analysis, requiredSpecClauseIds: [] },
      context: fixture.context
    }),
    /must exactly identify/u
  );
});

test("enterprise completion Trace requires the full hypothesis-to-observation path", async () => {
  const fixture = evidenceFixture();
  const graph = validTraceGraph();
  const analysis = traceAnalysisInput();

  const withoutApproval = createTraceGraph({
    nodes: graph.nodes.filter((node) => node.kind !== "approval"),
    edges: graph.edges.filter(
      (edge) => edge.from !== "approval" && edge.to !== "approval"
    )
  });
  await assert.rejects(
    validateEnterpriseTraceGraph({
      graph: withoutApproval,
      analysis,
      context: fixture.context
    }),
    /exactly one approval node/u
  );

  const brokenObservationEdge = createTraceGraph({
    nodes: graph.nodes,
    edges: graph.edges.filter((edge) => edge.kind !== "observes")
  });
  await assert.rejects(
    validateEnterpriseTraceGraph({
      graph: brokenObservationEdge,
      analysis,
      context: fixture.context
    }),
    /complete hypothesis-to-observation evidence path/u
  );

  const run = fixture.store.runs.get(RUN)!;
  fixture.store.runs.set(RUN, { ...run, status: "running" });
  await assert.rejects(
    validateEnterpriseTraceGraph({ graph, analysis, context: fixture.context }),
    /run\.status to be completed/u
  );
  fixture.store.runs.set(RUN, run);

  const state = governedState();
  const earlyApproval = createApprovalDecision({
    runId: RUN,
    stageAttemptId: "approval-1",
    decision: "approve",
    actorId: "reviewer-a",
    decidedAt: "2026-07-12T00:00:05.000Z"
  });
  fixture.store.governedLoopStates.set(RUN, {
    ...state,
    approval: earlyApproval,
    attempts: state.attempts.map((attempt) =>
      attempt.id === earlyApproval.stageAttemptId
        ? {
            ...attempt,
            startedAt: "2026-07-12T00:00:04.500Z",
            finishedAt: earlyApproval.decidedAt
          }
        : attempt
    )
  });
  await assert.rejects(
    validateEnterpriseTraceGraph({ graph, analysis, context: fixture.context }),
    /server-issued approval after final verification/u
  );

  const { approval: _approval, ...withoutServerApproval } = governedState();
  fixture.store.governedLoopStates.set(
    RUN,
    withoutServerApproval as GovernedRunState
  );
  await assert.rejects(
    validateEnterpriseTraceGraph({ graph, analysis, context: fixture.context }),
    /server-issued approval after final verification/u
  );
});

test("enterprise completion Trace includes every required passing Gate from final verification", async () => {
  const fixture = evidenceFixture();
  const run = fixture.store.runs.get(RUN)!;
  const passing = run.gateResultsV2!.find((gate) => gate.status === "pass")!;
  const secondPassing = {
    ...passing,
    id: "gate-result-2",
    gateId: "security",
    outputDigest: E
  };
  fixture.store.runs.set(RUN, {
    ...run,
    gateResultsV2: [...run.gateResultsV2!, secondPassing],
    verificationEvidence: run.verificationEvidence!.map((binding) =>
      binding.stageAttemptId === "verify-2"
        ? { ...binding, gateResultIds: [...binding.gateResultIds, secondPassing.id] }
        : binding
    )
  });

  await assert.rejects(
    validateEnterpriseTraceGraph({
      graph: validTraceGraph(),
      analysis: traceAnalysisInput(),
      context: fixture.context
    }),
    /include every required passing Gate/u
  );
});

test("enterprise maturity endpoint rejects client measurements and persists server source digests", async (t) => {
  const fixture = evidenceFixture();
  const trace = validTraceGraph();
  const analysis = analyzeTraceGraph(trace, {
    requiredSpecClauseIds: ["accept-order"],
    contracts: [{ ref: "services/orders/openapi.yaml", expectedDigest: B, actualDigest: B }],
    expectedContextDigest: C,
    actualContextDigest: C
  });
  fixture.store.traceGraphs.set(scopedEvidenceRecordKey(TENANT, PROJECT, "trace-1"), {
    tenantId: TENANT,
    projectId: PROJECT,
    id: "trace-1",
    graph: trace,
    analysis,
    createdAt: "2026-07-12T00:00:10.000Z",
    createdBy: "owner-a"
  });
  const aggregate = await aggregateEnterpriseMaturity({
    store: fixture.store,
    tenantId: TENANT,
    projectId: PROJECT,
    resolvers: fixture.resolvers
  });
  assert.equal(aggregate.measurement.totalRuns, 1);
  assert.equal(aggregate.measurement.requiredContractClauses, 1);
  assert.equal(aggregate.measurement.coveredContractClauses, 1);
  assert.equal(aggregate.measurement.aiChanges, 2);
  assert.equal(aggregate.measurement.aiReworks, 1);
  assert.match(aggregate.source.sourceDigest, /^[a-f0-9]{64}$/u);

  const app = Fastify();
  t.after(() => app.close());
  registerEvidenceRoutes(app, {
    store: fixture.store,
    contextForRequest: () => requestContext(),
    strictEnterpriseEvidence: true,
    evidenceTruthResolvers: fixture.resolvers
  });
  const forged = await app.inject({
    method: "POST",
    url: "/v1/maturity-report",
    payload: {
      projectId: PROJECT,
      id: "forged",
      measurement: {
        incrementCycleSeconds: [],
        totalRuns: 0,
        failedRuns: 0,
        requiredContractClauses: 0,
        coveredContractClauses: 0,
        regressionRuns: 0,
        regressionHits: 0,
        contextComparisons: 0,
        contextDrifts: 0,
        aiChanges: 0,
        aiReworks: 0,
        completedRetrospectives: 0,
        retainedLearnings: 0,
        feedbackClosureSeconds: []
      }
    }
  });
  assert.equal(forged.statusCode, 400, forged.body);

  const created = await app.inject({
    method: "POST",
    url: "/v1/maturity-report",
    payload: { projectId: PROJECT, id: "server-derived" }
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().report.samples.runs, 1);
  assert.equal(created.json().report.aiReworkRate, 0.5);
  assert.equal(created.json().source.kind, "server_aggregate-v1");
});

test("enterprise Learning and maturity revalidate persisted Trace Gate authority", async () => {
  const fixture = evidenceFixture();
  const trace = validTraceGraph();
  const analysis = analyzeTraceGraph(trace, {
    requiredSpecClauseIds: ["accept-order"],
    contracts: [{ ref: "services/orders/openapi.yaml", expectedDigest: B, actualDigest: B }],
    expectedContextDigest: C,
    actualContextDigest: C
  });
  fixture.store.traceGraphs.set(scopedEvidenceRecordKey(TENANT, PROJECT, "legacy-trace"), {
    tenantId: TENANT,
    projectId: PROJECT,
    id: "legacy-trace",
    graph: trace,
    analysis,
    createdAt: "2026-07-12T00:00:10.000Z",
    createdBy: "owner-a"
  });
  const resolverWithoutAuthoritativeGate: EnterpriseEvidenceTruthResolvers = {
    ...fixture.resolvers,
    resolveEvidenceReference: async (input) =>
      input.ref === "gate-result-1"
        ? undefined
        : fixture.resolvers.resolveEvidenceReference(input)
  };
  const context = { ...fixture.context, resolvers: resolverWithoutAuthoritativeGate };
  await assert.rejects(
    validateEnterpriseLearningEvidence({
      proposal: { ...proposalInput(), sourceEvidenceIds: ["legacy-trace"] },
      context
    }),
    /does not exist/u
  );

  const untrusted = await aggregateEnterpriseMaturity({
    store: fixture.store,
    tenantId: TENANT,
    projectId: PROJECT,
    resolvers: resolverWithoutAuthoritativeGate
  });
  assert.equal(untrusted.measurement.requiredContractClauses, 0);
  assert.equal(untrusted.measurement.coveredContractClauses, 0);
  assert.deepEqual(untrusted.source.traceGraphDigests, []);

  const trusted = await aggregateEnterpriseMaturity({
    store: fixture.store,
    tenantId: TENANT,
    projectId: PROJECT,
    resolvers: fixture.resolvers
  });
  assert.equal(trusted.measurement.requiredContractClauses, 1);
  assert.equal(trusted.measurement.coveredContractClauses, 1);
  assert.deepEqual(trusted.source.traceGraphDigests, [trace.digest]);
});

test("Trace creation, Learning revalidation, and maturity share completed Run truth", async () => {
  const fixture = evidenceFixture();
  const trace = validTraceGraph();
  const analysisInput = traceAnalysisInput();
  const analysis = analyzeTraceGraph(trace, analysisInput);
  fixture.store.traceGraphs.set(scopedEvidenceRecordKey(TENANT, PROJECT, "completion-trace"), {
    tenantId: TENANT,
    projectId: PROJECT,
    id: "completion-trace",
    graph: trace,
    analysis,
    createdAt: "2026-07-12T00:00:10.000Z",
    createdBy: "owner-a"
  });
  await validateEnterpriseLearningEvidence({
    proposal: { ...proposalInput(), sourceEvidenceIds: ["completion-trace"] },
    context: fixture.context
  });

  const completedRun = fixture.store.runs.get(RUN)!;
  fixture.store.runs.set(RUN, { ...completedRun, status: "running" });
  await assert.rejects(
    validateEnterpriseTraceGraph({
      graph: trace,
      analysis: analysisInput,
      context: fixture.context
    }),
    /run\.status to be completed/u
  );
  await assert.rejects(
    validateEnterpriseLearningEvidence({
      proposal: { ...proposalInput(), sourceEvidenceIds: ["completion-trace"] },
      context: fixture.context
    }),
    /does not exist/u
  );
  const maturity = await aggregateEnterpriseMaturity({
    store: fixture.store,
    tenantId: TENANT,
    projectId: PROJECT,
    resolvers: fixture.resolvers
  });
  assert.equal(maturity.measurement.requiredContractClauses, 0);
  assert.equal(maturity.measurement.coveredContractClauses, 0);
  assert.equal(maturity.measurement.contextComparisons, 0);
  assert.deepEqual(maturity.source.traceGraphDigests, []);
});

test("failed Run assets remain valid Learning input without contributing completion coverage", async () => {
  const fixture = evidenceFixture();
  const asset = createEvalAssetRevision(assetInput());
  fixture.store.evalAssets.set(
    scopedEvidenceRecordKey(TENANT, PROJECT, asset.id, asset.revision),
    { tenantId: TENANT, projectId: PROJECT, asset }
  );
  const completedRun = fixture.store.runs.get(RUN)!;
  fixture.store.runs.set(RUN, { ...completedRun, status: "failed" });

  await validateEnterpriseLearningEvidence({
    proposal: proposalInput(),
    context: fixture.context
  });

  const trace = validTraceGraph();
  fixture.store.traceGraphs.set(scopedEvidenceRecordKey(TENANT, PROJECT, "failed-trace"), {
    tenantId: TENANT,
    projectId: PROJECT,
    id: "failed-trace",
    graph: trace,
    analysis: analyzeTraceGraph(trace, traceAnalysisInput()),
    createdAt: "2026-07-12T00:00:10.000Z",
    createdBy: "owner-a"
  });
  await assert.rejects(
    validateEnterpriseLearningEvidence({
      proposal: { ...proposalInput(), sourceEvidenceIds: ["failed-trace"] },
      context: fixture.context
    }),
    /does not exist/u
  );
  const maturity = await aggregateEnterpriseMaturity({
    store: fixture.store,
    tenantId: TENANT,
    projectId: PROJECT,
    resolvers: fixture.resolvers
  });
  assert.equal(maturity.measurement.failedRuns, 1);
  assert.equal(maturity.measurement.requiredContractClauses, 0);
  assert.equal(maturity.measurement.coveredContractClauses, 0);
  assert.deepEqual(maturity.source.traceGraphDigests, []);
});

function evidenceFixture() {
  const store = new MemoryStore();
  store.projects.set(PROJECT, project());
  const spec = approvedSpec();
  const run = governedRun();
  store.runs.set(RUN, run);
  store.governedLoopStates.set(RUN, governedState());
  const resolvers: EnterpriseEvidenceTruthResolvers = {
    resolveApprovedSpecRevision: async ({ specRef }) =>
      specRef.specSetId === spec.specSetId &&
      specRef.revision === spec.revision &&
      specRef.digest === spec.digest
        ? spec
        : undefined,
    listApprovedSpecRevisions: async () => [spec],
    resolveEvidenceReference: async ({ ref, digest, runId }) => {
      if (runId !== undefined && runId !== RUN) return undefined;
      const known = new Map([
        [ARTIFACT_URI, A],
        ["gate-result-failed", E],
        ["gate-result-1", D],
        ["gate-result-2", E]
      ]);
      const actual = known.get(ref);
      return actual !== undefined && (digest === undefined || digest === actual)
        ? { runId: RUN, kind: ref === ARTIFACT_URI ? "run_artifact" : "gate_result", ref, digest: actual }
        : undefined;
    }
  };
  return {
    store,
    resolvers,
    context: { store, tenantId: TENANT, projectId: PROJECT, resolvers }
  };
}

function project(): Project {
  return {
    id: PROJECT,
    tenantId: TENANT,
    name: "Orders",
    rootPath: "/tmp/project-a",
    defaultBranch: "main",
    policyId: "builtin/default@1",
    services: [
      {
        id: "orders",
        name: "orders",
        path: "services/orders",
        owners: ["commerce"],
        language: "node",
        contracts: []
      }
    ]
  };
}

function approvedSpec(): SpecRevision {
  return {
    specSetId: "order-reservation",
    revision: 2,
    status: "approved",
    source: "native",
    title: "Reserve inventory",
    hypothesis: "A reservation prevents overselling.",
    outcomes: ["Orders reserve inventory"],
    nonGoals: ["Production deployment"],
    targetServices: ["orders"],
    contracts: {
      interface: {},
      data: {},
      state: {},
      permission: {},
      exception: {},
      quality: {},
      observability: {}
    },
    acceptanceCases: [
      {
        id: "accept-order",
        kind: "positive",
        title: "Accept order",
        given: ["stock exists"],
        when: "order is created",
        then: ["stock is reserved"],
        targetService: "orders"
      }
    ],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-12T00:00:00.000Z",
    createdBy: "owner-a",
    approvedAt: "2026-07-12T00:00:01.000Z",
    approvedBy: "reviewer-a",
    digest: A
  };
}

function governedRun(): RunRecord {
  return {
    id: RUN,
    tenantId: TENANT,
    taskId: "task-1",
    projectId: PROJECT,
    status: "completed",
    candidates: [],
    gates: [],
    gateResultsV2: [
      {
        schemaVersion: 2,
        id: "gate-result-failed",
        runId: RUN,
        candidateId: "candidate-1",
        gateId: "contract",
        runnerId: "contract-runner",
        runnerVersion: "1",
        required: true,
        status: "fail",
        summary: "historical contract failure",
        specClauseIds: ["accept-order"],
        workingDirectory: "/tmp/project-a",
        exitCode: 1,
        inputDigest: A,
        outputDigest: E,
        artifacts: [],
        startedAt: "2026-07-12T00:00:02.000Z",
        finishedAt: "2026-07-12T00:00:03.000Z",
        freshUntil: "2026-07-12T01:00:03.000Z"
      },
      {
        schemaVersion: 2,
        id: "gate-result-1",
        runId: RUN,
        candidateId: "candidate-1",
        gateId: "contract",
        runnerId: "contract-runner",
        runnerVersion: "1",
        required: true,
        status: "pass",
        summary: "contract passed",
        specClauseIds: ["accept-order"],
        workingDirectory: "/tmp/project-a",
        exitCode: 0,
        inputDigest: A,
        outputDigest: D,
        artifacts: [],
        startedAt: "2026-07-12T00:00:04.000Z",
        finishedAt: "2026-07-12T00:00:05.000Z",
        freshUntil: "2026-07-12T01:00:05.000Z"
      }
    ],
    verificationEvidence: [
      {
        stageAttemptId: "verify-1",
        gateResultIds: ["gate-result-failed"]
      },
      {
        stageAttemptId: "verify-2",
        gateResultIds: ["gate-result-1"]
      }
    ],
    harnessManifest: {
      specRef: { specSetId: "order-reservation", revision: 2, digest: A },
      context: {
        digest: C,
        fragments: [
          {
            id: "contract:orders",
            source: "services/orders/openapi.yaml",
            contentDigest: B,
            digest: B
          }
        ]
      }
    } as unknown as RunRecord["harnessManifest"],
    stages: [
      { stage: "implementation", status: "completed" },
      { stage: "verification", status: "failed" },
      { stage: "implementation", status: "completed" },
      { stage: "verification", status: "completed" },
      { stage: "learning", status: "completed" }
    ] as RunRecord["stages"],
    budgetUsage: {
      durationSeconds: 10,
      tokens: 100,
      costUsd: 0.1,
      repairAttempts: 1,
      changedFiles: 1,
      changedLines: 1
    },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:10.000Z"
  };
}

function governedState(): GovernedRunState {
  return {
    runId: RUN,
    status: "completed",
    repairHistory: [{ verificationAttemptId: "verify-1", failureSignature: "failure", diffDigest: D }],
    approval: APPROVAL,
    attempts: [
      {
        id: "verify-1",
        stage: "verification",
        status: "failed",
        inputArtifacts: [],
        outputArtifacts: [],
        startedAt: "2026-07-12T00:00:02.000Z",
        finishedAt: "2026-07-12T00:00:03.000Z"
      },
      {
        id: "verify-2",
        stage: "verification",
        status: "completed",
        inputArtifacts: [],
        outputArtifacts: [],
        startedAt: "2026-07-12T00:00:04.000Z",
        finishedAt: "2026-07-12T00:00:06.000Z"
      },
      {
        id: "approval-1",
        stage: "approval_demo",
        status: "completed",
        inputArtifacts: [],
        outputArtifacts: [],
        startedAt: "2026-07-12T00:00:07.000Z",
        finishedAt: APPROVAL.decidedAt
      }
    ]
  } as unknown as GovernedRunState;
}

function assetInput(): CreateEvalAssetInput {
  return {
    id: "contract-asset",
    revision: 1,
    kind: "contract_test",
    title: "Order contract",
    specRef: { specSetId: "order-reservation", revision: 2, digest: A },
    specClauseIds: ["accept-order"],
    serviceIds: ["orders"],
    owner: "commerce",
    source: { kind: "generated", ref: ARTIFACT_URI, digest: A },
    contentRef: ARTIFACT_URI,
    contentDigest: A,
    createdAt: "2026-07-12T00:00:10.000Z",
    createdBy: "owner-a"
  };
}

function proposalInput(): CreateLearningProposalInput {
  return {
    id: "learn-1",
    kind: "standard_pack",
    title: "Retain contract Gate",
    rationale: "The evidence is reusable.",
    sourceRunId: RUN,
    sourceEvidenceIds: ["contract-asset"],
    targetRef: "corp/default@next",
    changeDigest: A,
    createdAt: "2026-07-12T00:00:11.000Z",
    createdBy: "owner-a"
  };
}

function validTraceGraph() {
  return createTraceGraph({
    nodes: [
      {
        id: "hypothesis",
        kind: "business_hypothesis",
        ref: "order-reservation",
        digest: sha256("A reservation prevents overselling."),
        serviceIds: ["orders"]
      },
      {
        id: "clause",
        kind: "spec_clause",
        ref: "accept-order",
        digest: A,
        serviceIds: ["orders"]
      },
      {
        id: "contract",
        kind: "design_contract",
        ref: "services/orders/openapi.yaml",
        digest: B,
        serviceIds: ["orders"]
      },
      {
        id: "diff",
        kind: "diff",
        ref: "services/orders/src/server.ts",
        digest: D,
        serviceIds: ["orders"]
      },
      {
        id: "gate",
        kind: "test_gate",
        ref: "gate-result-1",
        digest: D,
        serviceIds: ["orders"]
      },
      {
        id: "approval",
        kind: "approval",
        ref: "approval-1",
        digest: APPROVAL.digest,
        serviceIds: ["orders"]
      },
      {
        id: "observation",
        kind: "observation",
        ref: ARTIFACT_URI,
        digest: A,
        serviceIds: ["orders"]
      }
    ],
    edges: [
      { from: "hypothesis", to: "clause", kind: "derives" },
      { from: "clause", to: "contract", kind: "designs" },
      { from: "contract", to: "diff", kind: "implements" },
      { from: "diff", to: "gate", kind: "verifies" },
      { from: "gate", to: "approval", kind: "approves" },
      { from: "approval", to: "observation", kind: "observes" }
    ]
  });
}

function traceAnalysisInput() {
  return {
    requiredSpecClauseIds: ["accept-order"],
    contracts: [
      {
        ref: "services/orders/openapi.yaml",
        expectedDigest: B,
        actualDigest: B
      }
    ],
    expectedContextDigest: C,
    actualContextDigest: C
  };
}

function requestContext(): RequestContext {
  return {
    tenantId: TENANT,
    actorId: "owner-a",
    roles: ["project_owner"],
    projectIds: [PROJECT],
    principalType: "human",
    scopes: [],
    authentication: "jwt",
    traceId: "trace-1"
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
