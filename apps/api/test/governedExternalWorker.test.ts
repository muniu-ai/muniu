import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentTask,
  ArtifactRef,
  GateResultV2,
  RunRecord,
  RunStageAttempt
} from "@mn/core";
import {
  createApprovalDecision,
  executeGovernedIncrement,
  sha256Canonical,
  type GovernedRunState,
  type GovernedStageHandlers,
  type LoopArtifact,
  type LoopArtifactKind
} from "@mn/loop";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";
import { gateResultV2OutputDigest } from "@mn/worker";
import { buildServer } from "../src/server.js";
import { LOCAL_TENANT_ID } from "../src/store.js";

function artifact(id: string, kind: LoopArtifactKind): LoopArtifact {
  return {
    id,
    kind,
    path: `mn://test/${id}`,
    digest: sha256Canonical(id),
    contentType: "application/json"
  };
}

function handlers(): GovernedStageHandlers {
  let verification = 0;
  return {
    discovery: async () => ({
      status: "completed",
      artifacts: [artifact("discovery", "discovery")]
    }),
    specification: async () => ({
      status: "completed",
      artifacts: [artifact("specification", "specification")]
    }),
    impact_architecture: async () => ({
      status: "completed",
      artifacts: [artifact("impact", "impact_report")]
    }),
    implementation: async (context) => ({
      status: "completed",
      artifacts: [artifact(`diff-${context.attempt}`, "diff")],
      diffDigest: sha256Canonical(`diff-${context.attempt}`)
    }),
    verification: async (context) => {
      verification += 1;
      if (verification === 1) {
        return {
          status: "failed",
          artifacts: [artifact(`evidence-${context.attempt}`, "verification_evidence")],
          failure: {
            kind: "stage_failure",
            retryable: true,
            reason: "first verification fails"
          },
          failureSignature: sha256Canonical("first-failure"),
          diffDigest: sha256Canonical("diff-1")
        };
      }
      return {
        status: "completed",
        artifacts: [artifact(`evidence-${context.attempt}`, "verification_evidence")]
      };
    },
    approval_demo: async () => ({
      status: "waiting_approval",
      artifacts: [artifact("approval", "approval_material")]
    }),
    learning: async () => ({
      status: "completed",
      artifacts: [artifact("learning", "learning_proposal")]
    })
  };
}

function coreArtifact(value: LoopArtifact): ArtifactRef {
  return {
    id: value.id,
    kind:
      value.kind === "diff"
        ? "diff"
        : value.kind === "verification_evidence"
          ? "test-report"
          : "trace",
    path: value.path,
    sha256: value.digest,
    ...(value.contentType ? { contentType: value.contentType } : {})
  };
}

function coreStage(
  attempt: GovernedRunState["attempts"][number]
): RunStageAttempt {
  return {
    id: attempt.id,
    runId: attempt.runId,
    stage: attempt.stage,
    attempt: attempt.attempt,
    status: attempt.status,
    inputArtifacts: attempt.inputArtifacts.map(coreArtifact),
    outputArtifacts: attempt.outputArtifacts.map(coreArtifact),
    inputDigest: attempt.inputDigest,
    ...(attempt.outputDigest ? { outputDigest: attempt.outputDigest } : {}),
    budgetUsage: { ...attempt.budgetUsage },
    ...(attempt.failure
      ? {
          failure: {
            kind: "test_failure" as const,
            retryable: attempt.failure.retryable,
            reason: attempt.failure.reason
          }
        }
      : {}),
    startedAt: attempt.startedAt,
    ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {})
  };
}

function gateResult(
  runId: string,
  candidateId: string,
  gateId: string,
  status: GateResultV2["status"],
  sequence: number,
  runner: { runnerId: string; runnerVersion: string }
): GateResultV2 {
  const now = new Date();
  const summary = `${gateId} ${status}`;
  const draft: GateResultV2 = {
    schemaVersion: 2,
    id: `gate-result-${sequence}`,
    runId,
    candidateId,
    gateId,
    runnerId: runner.runnerId,
    runnerVersion: runner.runnerVersion,
    required: true,
    status,
    summary,
    specClauseIds: ["accepted"],
    tool: { id: "test-runner", version: "1" },
    workingDirectory: "/worker/workspace",
    exitCode: status === "pass" ? 0 : 1,
    inputDigest: createHash("sha256").update(`${gateId}:${sequence}`).digest("hex"),
    outputDigest: "0".repeat(64),
    artifacts: [
      {
        id: `${gateId}-log-${sequence}`,
        kind: "log",
        contentType: "text/plain; charset=utf-8",
        digest: createHash("sha256").update(summary).digest("hex"),
        byteLength: Buffer.byteLength(summary),
        path: `mn://test/${gateId}/${sequence}`
      }
    ],
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    freshUntil: new Date(now.getTime() + 3_600_000).toISOString()
  };
  return { ...draft, outputDigest: gateResultV2OutputDigest(draft) };
}

function materializeRun(
  queued: RunRecord,
  state: GovernedRunState,
  results: readonly GateResultV2[],
  verificationEvidence: NonNullable<RunRecord["verificationEvidence"]>
): RunRecord {
  const candidateId = "claude-1";
  return {
    ...queued,
    status:
      state.status === "waiting_approval"
        ? "waiting_approval"
        : state.status === "completed"
          ? "completed"
          : state.status === "cancelled"
            ? "cancelled"
            : state.status === "failed" || state.status === "needs_human"
              ? "failed"
              : "running",
    candidates: [
      {
        id: candidateId,
        runId: queued.id,
        provider: "claude",
        worktreePath: "/worker/workspace",
        status: "completed",
        result: {
          provider: "claude",
          candidateId,
          status: "completed",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          summary: "ok",
          artifacts: [],
          startedAt: queued.createdAt,
          finishedAt: state.updatedAt
        },
        gates: []
      }
    ],
    gates: [],
    gateResultsV2: [...results],
    verificationEvidence: verificationEvidence.map((binding) => ({
      stageAttemptId: binding.stageAttemptId,
      gateResultIds: [...binding.gateResultIds]
    })),
    winnerCandidateId: candidateId,
    stages: state.attempts.map(coreStage),
    budgetUsage: { ...state.budgetUsage },
    updatedAt: new Date(
      Math.max(Date.parse(queued.updatedAt) + 1, Date.parse(state.updatedAt))
    ).toISOString()
  };
}

async function approvedSpec(
  app: ReturnType<typeof buildServer>,
  specSetId: string
): Promise<{ specSetId: string; revision: number; digest: string }> {
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId,
    revision: 1,
    status: "draft",
    source: "native",
    title: "External governed checkpoint",
    hypothesis: "Remote evidence is accepted only when bound.",
    outcomes: ["The checkpoint is auditable."],
    nonGoals: ["No production deployment."],
    targetServices: [],
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
        id: "accepted",
        kind: "positive",
        title: "Accept bound evidence",
        given: ["A governed run exists."],
        when: "A worker reports evidence.",
        then: ["The evidence is bound to its verification attempt."]
      }
    ],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "product@example.com"
  };
  const created = await app.inject({
    method: "POST",
    url: "/v1/spec-sets",
    payload: {
      specSet: {
        id: specSetId,
        title: unsigned.title,
        latestRevision: 0,
        createdAt: unsigned.createdAt,
        updatedAt: unsigned.createdAt
      },
      initialRevision: { ...unsigned, digest: digestSpecRevision(unsigned) }
    }
  });
  assert.equal(created.statusCode, 201);
  const approved = await app.inject({
    method: "POST",
    url: `/v1/spec-sets/${specSetId}/revisions/1/approve`,
    payload: {
      approvedBy: "reviewer@example.com",
      approvedAt: "2026-07-11T01:00:00.000Z"
    }
  });
  assert.equal(approved.statusCode, 201);
  return {
    specSetId,
    revision: approved.json().revision,
    digest: approved.json().digest
  };
}

function resealState(
  state: GovernedRunState,
  attempts: GovernedRunState["attempts"]
): GovernedRunState {
  const { digest: _digest, ...semantic } = state;
  const rewritten = { ...semantic, attempts };
  return { ...rewritten, digest: sha256Canonical(rewritten) } as GovernedRunState;
}

test("external governed checkpoints enforce state, Gate coverage, repair, and approval bindings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-api-external-governed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
  const authoritativeRouteStatuses: string[] = [];
  const app = buildServer({
    mniuRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    useMockExecutors: true,
    authoritativeGateCheckpointAuthorizer: async ({ incoming }) => {
      authoritativeRouteStatuses.push(incoming.status);
      return (incoming as RunRecord & { authorityProbe?: string }).authorityProbe === "reject"
        ? {
            error: "authoritative Gate re-execution rejected forged worker evidence",
            newReceipts: []
          }
        : { newReceipts: [] };
    }
  });
  t.after(() => app.close());

  const project = (
    await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "external-governed", rootPath: root }
    })
  ).json();
  const specRef = await approvedSpec(app, "external-checkpoint");
  const taskResponse = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      projectId: project.id,
      title: "External governed worker",
      prompt: "implement",
      specRef,
      harnessProfileRef: { id: "local", version: "1" },
      strategy: {
        providers: ["claude", "codex"],
        candidates: 1,
        requiredGates: ["unit_test"],
        sandbox: "isolated-worktree",
        humanApproval: "before-merge",
        timeoutSeconds: 60
      }
    }
  });
  assert.equal(taskResponse.statusCode, 201, taskResponse.body);
  const task = taskResponse.json() as AgentTask;
  const queuedResponse = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/runs`,
    payload: { queueOnly: true }
  });
  assert.equal(queuedResponse.statusCode, 201, queuedResponse.body);
  const queued = queuedResponse.json() as RunRecord;
  assert.ok(queued.governanceSnapshot && queued.harnessManifest && task.specRef);
  assert.ok(queued.harnessManifest.gatePlan.length > 0);

  const claimResponse = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/claim",
    payload: {
      ownerId: "external-governed-worker",
      ttlMs: 60_000,
      capabilities: {
        providers: ["claude", "codex"],
        gateRunnerIds: queued.harnessManifest.gatePlan.map((gate) => gate.runnerId),
        tenantIds: [LOCAL_TENANT_ID],
        tools: [
          "cargo",
          "git",
          "go",
          "node",
          "npm",
          "npx",
          "pnpm",
          "pytest",
          "python",
          "tsc",
          "vitest",
          "yarn"
        ],
        sandboxBackends: [
          {
            backendId: "worktree-postcheck",
            enforcement: "postcheck",
            capabilities: ["source-isolation", "diff-postcheck"]
          }
        ]
      }
    }
  });
  assert.equal(claimResponse.statusCode, 200);
  const claim = claimResponse.json();
  assert.equal(claim.item?.runId, queued.id, claimResponse.body);

  let milliseconds = Math.max(Date.now(), Date.parse(queued.updatedAt) + 1_000);
  const clock = () => new Date(milliseconds++).toISOString();
  const stageHandlers = handlers();
  const waiting = await executeGovernedIncrement({
    schemaVersion: 1,
    runId: queued.id,
    specRef: task.specRef!,
    governanceSnapshot: queued.governanceSnapshot!,
    harnessManifest: queued.harnessManifest!,
    handlers: stageHandlers,
    onCheckpoint: () => undefined,
    now: clock
  });
  assert.equal(waiting.status, "waiting_approval");
  const verificationAttempts = waiting.attempts.filter(
    (attempt) => attempt.stage === "verification"
  );
  assert.deepEqual(verificationAttempts.map((attempt) => attempt.status), [
    "failed",
    "completed"
  ]);
  const requiredGates = queued.harnessManifest.gatePlan;
  const requiredGateIds = requiredGates.map((gate) => gate.id);
  const failed = gateResult(
    queued.id,
    "claude-1",
    requiredGates[0]!.id,
    "fail",
    1,
    requiredGates[0]!
  );
  const passed = requiredGates.map((gate, index) =>
    gateResult(queued.id, "claude-1", gate.id, "pass", index + 2, gate)
  );
  const results = [failed, ...passed];
  const bindings = [
    {
      stageAttemptId: verificationAttempts[0]!.id,
      gateResultIds: [failed.id]
    },
    {
      stageAttemptId: verificationAttempts[1]!.id,
      gateResultIds: passed.map((result) => result.id)
    }
  ];
  const waitingRun = materializeRun(queued, waiting, results, bindings);
  const updateUrl = `/v1/run-jobs/queue/${queued.id}/update`;
  const payload = (run: RunRecord, governedLoopState?: unknown) => ({
    ownerId: "external-governed-worker",
    claimToken: claim.claimToken,
    ttlMs: 60_000,
    run,
    ...(governedLoopState === undefined ? {} : { governedLoopState })
  });

  const noState = await app.inject({ method: "POST", url: updateUrl, payload: payload(waitingRun) });
  assert.equal(noState.statusCode, 400);
  assert.match(noState.body, /require governedLoopState/u);

  const badDigest = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(waitingRun, { ...waiting, digest: "0".repeat(64) })
  });
  assert.equal(badDigest.statusCode, 400);
  assert.match(badDigest.body, /digest does not match/u);

  const { digest: _waitingDigest, ...waitingSemantic } = waiting;
  const expandedLimitsSemantic = {
    ...waitingSemantic,
    limits: { ...waiting.limits, maxRepairAttempts: 999 }
  };
  const expandedLimits = {
    ...expandedLimitsSemantic,
    digest: sha256Canonical(expandedLimitsSemantic)
  };
  const expandedLimitsResponse = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(waitingRun, expandedLimits)
  });
  assert.equal(expandedLimitsResponse.statusCode, 400);
  assert.match(expandedLimitsResponse.body, /immutable Harness stopConditions/u);

  const clearedBudgetSemantic = {
    ...waitingSemantic,
    budgetUsage: { ...waiting.budgetUsage, tokens: waiting.budgetUsage.tokens + 1 }
  };
  const clearedBudget = {
    ...clearedBudgetSemantic,
    digest: sha256Canonical(clearedBudgetSemantic)
  };
  const clearedBudgetResponse = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(waitingRun, clearedBudget)
  });
  assert.equal(clearedBudgetResponse.statusCode, 400);
  assert.match(clearedBudgetResponse.body, /stage budget ledger/u);

  const forgedRunnerResult = {
    ...failed,
    runnerId: "attacker/forged-runner",
    runnerVersion: "999"
  };
  const forgedRunnerRun = materializeRun(
    queued,
    waiting,
    [forgedRunnerResult, ...passed],
    [
      { stageAttemptId: verificationAttempts[0]!.id, gateResultIds: [forgedRunnerResult.id] },
      { stageAttemptId: verificationAttempts[1]!.id, gateResultIds: passed.map((result) => result.id) }
    ]
  );
  const forgedRunnerResponse = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(forgedRunnerRun, waiting)
  });
  assert.equal(forgedRunnerResponse.statusCode, 400);
  assert.match(forgedRunnerResponse.body, /runner identity/u);

  const impossiblePassDraft = { ...passed[0]!, exitCode: 99 };
  const impossiblePass = {
    ...impossiblePassDraft,
    outputDigest: gateResultV2OutputDigest(impossiblePassDraft)
  };
  const impossiblePassRun = materializeRun(
    queued,
    waiting,
    [failed, impossiblePass, ...passed.slice(1)],
    [
      bindings[0]!,
      {
        stageAttemptId: bindings[1]!.stageAttemptId,
        gateResultIds: [impossiblePass.id, ...passed.slice(1).map((result) => result.id)]
      }
    ]
  );
  const impossiblePassResponse = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(impossiblePassRun, waiting)
  });
  assert.equal(impossiblePassResponse.statusCode, 400);
  assert.match(impossiblePassResponse.body, /pass evidence must have exitCode 0/u);

  const forgedCandidateRun = {
    ...waitingRun,
    gateResultsV2: [
      { ...failed, candidateId: "forged-candidate" },
      ...passed
    ]
  } as RunRecord;
  const forgedCandidate = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(forgedCandidateRun, waiting)
  });
  assert.equal(forgedCandidate.statusCode, 400);
  assert.match(forgedCandidate.body, /unknown candidate/u);

  const forgedAttemptRun = {
    ...waitingRun,
    verificationEvidence: [
      ...bindings.slice(0, 1),
      {
        stageAttemptId: `${queued.id}:verification:99`,
        gateResultIds: passed.map((result) => result.id)
      }
    ]
  } as RunRecord;
  const forgedAttempt = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(forgedAttemptRun, waiting)
  });
  assert.equal(forgedAttempt.statusCode, 400);
  assert.match(forgedAttempt.body, /unknown Loop attempt/u);

  const missingPassRun = materializeRun(queued, waiting, [failed], [
    bindings[0]!,
    { stageAttemptId: bindings[1]!.stageAttemptId, gateResultIds: [] }
  ]);
  const missingPass = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(missingPassRun, waiting)
  });
  assert.equal(missingPass.statusCode, 400);
  assert.match(missingPass.body, /missing required gates/u);

  const nonPass = gateResult(
    queued.id,
    "claude-1",
    requiredGateIds[0]!,
    "error",
    100,
    requiredGates[0]!
  );
  const nonPassResults = [failed, nonPass, ...passed.slice(1)];
  const nonPassRun = materializeRun(queued, waiting, nonPassResults, [
    bindings[0]!,
    {
      stageAttemptId: bindings[1]!.stageAttemptId,
      gateResultIds: nonPassResults.slice(1).map((result) => result.id)
    }
  ]);
  const nonPassResponse = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(nonPassRun, waiting)
  });
  assert.equal(nonPassResponse.statusCode, 400);
  assert.match(nonPassResponse.body, /non-pass evidence/u);

  const authorityRejected = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(
      { ...waitingRun, authorityProbe: "reject" } as RunRecord,
      waiting
    )
  });
  assert.equal(authorityRejected.statusCode, 400, authorityRejected.body);
  assert.match(authorityRejected.body, /authoritative Gate re-execution/u);

  const accepted = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(waitingRun, waiting)
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().run.status, "waiting_approval");

  const rewrittenArtifacts = [
    {
      ...waiting.attempts[0]!.outputArtifacts[0]!,
      path: "mn://test/rewritten-history"
    }
  ];
  const rewrittenAttempt = {
    ...waiting.attempts[0]!,
    outputArtifacts: rewrittenArtifacts,
    outputDigest: sha256Canonical(rewrittenArtifacts)
  };
  const rewritten = resealState(waiting, [
    rewrittenAttempt,
    ...waiting.attempts.slice(1)
  ]);
  const rewriteResponse = await app.inject({
    method: "POST",
    url: updateUrl,
    payload: payload(waitingRun, rewritten)
  });
  assert.equal(rewriteResponse.statusCode, 400);
  assert.match(rewriteResponse.body, /cannot rewrite/u);

  const decidedAt = new Date(Date.parse(waiting.updatedAt) + 1_000).toISOString();
  const decision = createApprovalDecision({
    runId: queued.id,
    stageAttemptId: waiting.attempts.at(-1)!.id,
    decision: "approve",
    actorId: "reviewer@example.com",
    decidedAt
  });
  milliseconds = Date.parse(decidedAt) + 1;
  const completed = await executeGovernedIncrement({
    schemaVersion: 1,
    runId: queued.id,
    specRef: task.specRef!,
    governanceSnapshot: queued.governanceSnapshot!,
    harnessManifest: queued.harnessManifest!,
    handlers: stageHandlers,
    onCheckpoint: () => undefined,
    resumeFrom: waiting,
    approvalDecision: decision,
    now: clock
  });
  assert.equal(completed.status, "completed");
  const completedRun = materializeRun(queued, completed, results, bindings);
  const finish = await app.inject({
    method: "POST",
    url: `/v1/run-jobs/queue/${queued.id}/finish`,
    payload: payload(completedRun, completed)
  });
  assert.equal(finish.statusCode, 200, finish.body);
  assert.equal(finish.json().run.status, "completed");
  assert.ok(
    authoritativeRouteStatuses.includes("waiting_approval") &&
      authoritativeRouteStatuses.includes("completed"),
    "update and finish routes must both invoke the authoritative Gate coordinator"
  );

  const auditResponse = await app.inject({ method: "GET", url: "/v1/audit-events" });
  const runAudits = (auditResponse.json().auditEvents as Array<{
    action: string;
    actorId: string;
    resourceType: string;
    resourceId?: string;
    projectId?: string;
    beforeDigest?: string;
    afterDigest?: string;
    packDigest?: string;
    result: string;
  }>).filter((event) =>
    event.resourceId === queued.id &&
    ["run.create", "run.checkpoint", "run.finish"].includes(event.action)
  );
  for (const [action, resourceType] of [
    ["run.create", "run"],
    ["run.checkpoint", "run_checkpoint"],
    ["run.finish", "run"]
  ] as const) {
    const success = runAudits.find(
      (event) => event.action === action && event.result === "success"
    );
    assert.equal(success?.resourceType, resourceType, `missing ${action} audit`);
    assert.equal(success?.projectId, project.id);
    assert.equal(success?.actorId, "local-user");
    assert.match(success?.afterDigest ?? "", /^[a-f0-9]{64}$/u);
    assert.match(success?.packDigest ?? "", /^[a-f0-9]{64}$/u);
  }
  assert.ok(
    runAudits.some(
      (event) =>
        event.action === "run.checkpoint" &&
        event.result === "failure" &&
        event.afterDigest === undefined
    ),
    "rejected worker checkpoints must not forge success audit evidence"
  );
});
