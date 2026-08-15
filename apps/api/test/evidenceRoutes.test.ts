import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Project, RunRecord } from "@mn/core";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

test("evidence APIs persist project-scoped Eval, Trace, and maturity records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-evidence-api-"));
  const statePath = join(root, "api-state.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MemoryStore({ statePath });
  store.projects.set("project-a", project("project-a", "local"));
  store.projects.set("project-other-tenant", project("project-other-tenant", "tenant-b"));
  const app = buildServer({
    store,
    mniuRoot: join(root, "mniu"),
    workspaceRoot: join(root, "worktrees"),
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  t.after(() => app.close());

  const firstAsset = await app.inject({
    method: "POST",
    url: "/v1/eval-assets",
    payload: {
      projectId: "project-a",
      asset: assetInput()
    }
  });
  assert.equal(firstAsset.statusCode, 201, firstAsset.body);
  const first = firstAsset.json() as { digest: string };

  const secondAsset = await app.inject({
    method: "POST",
    url: "/v1/eval-assets",
    payload: {
      projectId: "project-a",
      asset: {
        ...assetInput(),
        revision: 2,
        contentDigest: B,
        supersedesDigest: first.digest,
        createdAt: "2026-07-11T01:00:00.000Z"
      }
    }
  });
  assert.equal(secondAsset.statusCode, 201, secondAsset.body);
  assert.equal(secondAsset.json().revision, 2);

  const assets = await app.inject({
    method: "GET",
    url: "/v1/eval-assets?projectId=project-a&specClauseId=accept-checkout"
  });
  assert.equal(assets.statusCode, 200, assets.body);
  assert.deepEqual(
    (assets.json() as { evalAssets: Array<{ revision: number }> }).evalAssets.map(
      (asset) => asset.revision
    ),
    [2]
  );

  const oldAsset = await app.inject({
    method: "GET",
    url: "/v1/eval-assets/contract-check?projectId=project-a&revision=1"
  });
  assert.equal(oldAsset.statusCode, 200, oldAsset.body);
  assert.equal(oldAsset.json().contentDigest, A);

  const graph = await app.inject({
    method: "POST",
    url: "/v1/trace-graphs",
    payload: {
      projectId: "project-a",
      id: "checkout-trace",
      graph: {
        nodes: [
          {
            id: "clause",
            kind: "spec_clause",
            ref: "accept-checkout",
            digest: A,
            serviceIds: ["checkout-api"]
          },
          {
            id: "gate",
            kind: "test_gate",
            ref: "gate:contract",
            digest: B,
            serviceIds: ["checkout-api"]
          }
        ],
        edges: [{ from: "clause", to: "gate", kind: "verifies" }]
      },
      analysis: {
        requiredSpecClauseIds: ["accept-checkout"],
        expectedContextDigest: A,
        actualContextDigest: A
      }
    }
  });
  assert.equal(graph.statusCode, 201, graph.body);
  assert.equal(graph.json().analysis.complete, true);

  const maturity = await app.inject({
    method: "POST",
    url: "/v1/maturity-report",
    payload: {
      projectId: "project-a",
      id: "week-28",
      generatedAt: "2026-07-11T02:00:00.000Z",
      measurement: maturityMeasurement()
    }
  });
  assert.equal(maturity.statusCode, 201, maturity.body);
  assert.equal(maturity.json().report.failureRate, 0.2);

  const otherTenant = await app.inject({
    method: "GET",
    url: "/v1/eval-assets?projectId=project-other-tenant"
  });
  assert.equal(otherTenant.statusCode, 404, otherTenant.body);
  assert.equal(
    [...store.auditEvents.values()].find(
      (event) => event.action === "POST /v1/maturity-report"
    )?.projectId,
    "project-a"
  );
  const evidenceDomainActions = new Set(
    [...store.auditEvents.values()]
      .filter((event) => !event.action.includes(" "))
      .map((event) => event.action)
  );
  assert.deepEqual(
    [...evidenceDomainActions].sort(),
    ["eval_asset.create", "maturity_report.create", "trace_graph.create"]
  );
  assert.ok(
    [...store.auditEvents.values()]
      .filter((event) => evidenceDomainActions.has(event.action))
      .every(
        (event) =>
          Boolean(event.resourceId) &&
          event.projectId === "project-a" &&
          event.result === "success" &&
          event.policyDecision === "allow" &&
          /^[a-f0-9]{64}$/u.test(event.afterDigest ?? "")
      )
  );

  const snapshot = JSON.parse(await readFile(statePath, "utf8")) as {
    evalAssets: unknown[];
    traceGraphs: unknown[];
    maturityReports: unknown[];
  };
  assert.equal(snapshot.evalAssets.length, 2);
  assert.equal(snapshot.traceGraphs.length, 1);
  assert.equal(snapshot.maturityReports.length, 1);

  await app.close();
  const reloadedStore = new MemoryStore({ statePath });
  const reloaded = buildServer({
    store: reloadedStore,
    mniuRoot: join(root, "reloaded-mniu"),
    workspaceRoot: join(root, "reloaded-worktrees"),
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false
  });
  t.after(() => reloaded.close());
  const persisted = await reloaded.inject({
    method: "GET",
    url: "/v1/trace-graphs/checkout-trace?projectId=project-a"
  });
  assert.equal(persisted.statusCode, 200, persisted.body);
  assert.equal(persisted.json().graph.nodes.length, 2);
});

test("Learning Proposal API enforces review, canary, trusted promotion, and no activation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-learning-api-"));
  const statePath = join(root, "api-state.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MemoryStore({ statePath });
  const { tenantId: _projectTenant, ...legacyProject } = project("project-a", "local");
  const { tenantId: _runTenant, ...legacyRun } = run("run-1", "project-a", "local");
  store.projects.set("project-a", legacyProject);
  store.runs.set("run-1", legacyRun);
  const app = buildServer({
    store,
    mniuRoot: join(root, "mniu"),
    workspaceRoot: join(root, "worktrees"),
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false,
    learningProposalSignatureVerifier: ({ signature }) =>
      signature.keyId === "governance-key" && signature.value === "valid-signature"
  });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/v1/learning-proposals",
    payload: {
      projectId: "project-a",
      proposal: proposalInput()
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().status, "draft");

  const prematureCanary = await learningAction(app, "canary", {
    projectId: "project-a",
    passed: true,
    environment: "canary",
    evidenceDigest: B,
    completedAt: "2026-07-11T03:00:00.000Z"
  });
  assert.equal(prematureCanary.statusCode, 409, prematureCanary.body);

  assert.equal((await learningAction(app, "submit", {
    projectId: "project-a",
    at: "2026-07-11T01:00:00.000Z"
  })).statusCode, 200);
  assert.equal((await learningAction(app, "review", {
    projectId: "project-a",
    approved: true,
    decidedAt: "2026-07-11T02:00:00.000Z",
    reason: "Safe declarative change"
  })).statusCode, 200);
  assert.equal((await learningAction(app, "canary", {
    projectId: "project-a",
    passed: true,
    environment: "canary",
    evidenceDigest: B,
    completedAt: "2026-07-11T03:00:00.000Z"
  })).statusCode, 200);

  const forged = await learningAction(app, "promote", {
    projectId: "project-a",
    promotedAt: "2026-07-11T04:00:00.000Z",
    rollbackRef: "pack-lock:previous",
    signature: {
      algorithm: "ed25519",
      keyId: "governance-key",
      value: "forged"
    }
  });
  assert.equal(forged.statusCode, 403, forged.body);

  const packCount = store.standardPacks.size;
  const layerCount = store.governanceLayers.size;
  const lockCount = store.projectPackLocks.size;
  const promoted = await learningAction(app, "promote", {
    projectId: "project-a",
    promotedAt: "2026-07-11T04:00:00.000Z",
    rollbackRef: "pack-lock:previous",
    signature: {
      algorithm: "ed25519",
      keyId: "governance-key",
      value: "valid-signature"
    }
  });
  assert.equal(promoted.statusCode, 200, promoted.body);
  assert.equal(promoted.json().status, "promoted");
  assert.equal(store.standardPacks.size, packCount);
  assert.equal(store.governanceLayers.size, layerCount);
  assert.equal(store.projectPackLocks.size, lockCount);

  const rolledBack = await learningAction(app, "rollback", {
    projectId: "project-a",
    at: "2026-07-11T05:00:00.000Z",
    reason: "Canary regression after promotion"
  });
  assert.equal(rolledBack.statusCode, 200, rolledBack.body);
  assert.equal(rolledBack.json().status, "rolled_back");
  assert.equal(rolledBack.json().review.actor, "local-user");

  const list = await app.inject({
    method: "GET",
    url: "/v1/learning-proposals?projectId=project-a"
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(
    (list.json() as { learningProposals: Array<{ status: string }> }).learningProposals.map(
      (proposal) => proposal.status
    ),
    ["rolled_back"]
  );

  const spoofedCreator = await app.inject({
    method: "POST",
    url: "/v1/learning-proposals",
    payload: {
      projectId: "project-a",
      proposal: { ...proposalInput(), id: "spoof", createdBy: "another-user" }
    }
  });
  assert.equal(spoofedCreator.statusCode, 400, spoofedCreator.body);

  const learningAudits = [...store.auditEvents.values()].filter((event) =>
    event.action.startsWith("learning_proposal.")
  );
  assert.deepEqual(
    [...new Set(learningAudits.map((event) => event.action))].sort(),
    [
      "learning_proposal.canary",
      "learning_proposal.create",
      "learning_proposal.promote",
      "learning_proposal.review",
      "learning_proposal.rollback",
      "learning_proposal.submit"
    ]
  );
  assert.ok(
    learningAudits
      .filter((event) => event.resourceId === "learn-1")
      .every(
        (event) =>
          event.projectId === "project-a" && event.actorId === "local-user"
      )
  );
  assert.ok(
    learningAudits.some(
      (event) =>
        event.action === "learning_proposal.canary" &&
        event.statusCode === 409 &&
        event.result === "failure" &&
        event.policyDecision === "deny" &&
        event.afterDigest === undefined
    ),
    "a rejected transition must not be recorded as successful evidence"
  );
  assert.ok(
    learningAudits.some(
      (event) =>
        event.action === "learning_proposal.promote" &&
        event.statusCode === 200 &&
        event.result === "success" &&
        /^[a-f0-9]{64}$/u.test(event.beforeDigest ?? "") &&
        /^[a-f0-9]{64}$/u.test(event.afterDigest ?? "")
    )
  );

  await app.close();
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
    learningProposals: unknown[];
  };
  assert.equal(persisted.learningProposals.length, 6);
  const reloadedStore = new MemoryStore({ statePath });
  const reloaded = buildServer({
    store: reloadedStore,
    mniuRoot: join(root, "reloaded-mniu"),
    workspaceRoot: join(root, "reloaded-worktrees"),
    useMockExecutors: true,
    autoResumeRuns: false,
    providerModelCatalogSyncScheduler: false,
    learningProposalSignatureVerifier: ({ signature }) =>
      signature.keyId === "governance-key" && signature.value === "valid-signature"
  });
  t.after(() => reloaded.close());
  const reloadedProposal = await reloaded.inject({
    method: "GET",
    url: "/v1/learning-proposals/learn-1?projectId=project-a"
  });
  assert.equal(reloadedProposal.statusCode, 200, reloadedProposal.body);
  assert.equal(reloadedProposal.json().status, "rolled_back");
});

function project(id: string, tenantId: string): Project {
  return {
    id,
    tenantId,
    name: id,
    rootPath: `/tmp/${id}`,
    defaultBranch: "main",
    services: [],
    policyId: "builtin/default@1"
  };
}

function run(id: string, projectId: string, tenantId: string): RunRecord {
  return {
    id,
    tenantId,
    taskId: "task-1",
    projectId,
    status: "completed",
    candidates: [],
    gates: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}

function assetInput() {
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
    createdBy: "local-user"
  };
}

function proposalInput() {
  return {
    id: "learn-1",
    kind: "standard_pack",
    title: "Require checkout regression",
    rationale: "Repeated incident shows a durable gap",
    sourceRunId: "run-1",
    sourceEvidenceIds: ["evidence-1"],
    targetRef: "corp/default@next",
    changeDigest: A,
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "local-user"
  };
}

function maturityMeasurement() {
  return {
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
  };
}

function learningAction(
  app: ReturnType<typeof buildServer>,
  action: "submit" | "review" | "canary" | "promote" | "rollback",
  payload: Record<string, unknown>
) {
  return app.inject({
    method: "POST",
    url: `/v1/learning-proposals/learn-1/${action}`,
    payload
  });
}
