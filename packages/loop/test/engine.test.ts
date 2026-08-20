import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { RunStageName } from "@mn/core";
import {
  GOVERNED_INCREMENT_DEFINITION,
  GOVERNED_INCREMENT_WORKFLOW_REF,
  GovernedLoopInterruptionError,
  GovernedLoopInputError,
  LoopPersistenceError,
  canonicalJson,
  createApprovalDecision,
  executeGovernedIncrement,
  sha256Canonical,
  validateGovernedRunState,
  validateGovernedRunStateAgainstHarness,
  type ExecuteGovernedRunInput,
  type GovernedGovernanceSnapshot,
  type GovernedHarnessManifest,
  type GovernedRunState,
  type GovernedStageHandlers,
  type LoopArtifact,
  type LoopBudgetDelta,
  type LoopBudgetMeasurementProof,
  type StageHandler,
  type StageHandlerContext
} from "../src/index.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const specRef = Object.freeze({
  specSetId: "orders",
  revision: 2,
  digest: digest("orders-spec-2")
});

function governance(): GovernedGovernanceSnapshot {
  const semantic = {
    schemaVersion: 1 as const,
    layers: [],
    policy: {
      requiredGates: [],
      deny: [],
      protectedPaths: [],
      budgets: { maxRepairAttempts: 3 },
      approvalMode: "before-merge" as const
    },
    appliedWaivers: [],
    decisions: [],
    specRef,
    workflowRef: GOVERNED_INCREMENT_WORKFLOW_REF
  };
  return {
    ...semantic,
    resolvedAt: "2026-07-11T00:00:00.000Z",
    digest: sha256Canonical(semantic)
  };
}

function harness(
  snapshot: GovernedGovernanceSnapshot,
  stopConditions: Partial<{
    maxCandidates: number;
    maxDurationSeconds: number;
    maxTokens: number;
    maxCostUsd: number;
    maxRepairAttempts: number;
    maxChangedFiles: number;
    maxChangedLines: number;
  }> = { maxRepairAttempts: 3 }
): GovernedHarnessManifest {
  const policy = snapshot.policy;
  const context = {
    fragments: [],
    omitted: [],
    usedBytes: 0,
    usedTokens: 0,
    maxBytes: 1_000,
    maxTokens: 1_000,
    tokenEstimator: { id: "utf8-byte-upper-bound" as const, version: "1" as const },
    digest: digest("context")
  };
  const semantic = {
    schemaVersion: 1 as const,
    profile: { id: "enterprise", version: "1", digest: digest("profile") },
    task: { taskId: "task-1", projectRoot: "/repo" },
    specRef,
    governanceDigest: snapshot.digest,
    workflowRef: GOVERNED_INCREMENT_WORKFLOW_REF,
    selectedServices: ["orders", "payments"],
    languageByService: { orders: "typescript", payments: "go" },
    policy,
    executionPolicy: {
      deny: policy.deny,
      protectedPaths: policy.protectedPaths
    },
    context,
    gatePlan: [],
    sandbox: {
      backendId: "container",
      backendVersion: "1",
      enforcement: "enforced" as const,
      capabilities: ["network-policy"]
    },
    stopConditions,
    outputSchema: "mn/evidence-v2"
  };
  return {
    ...semantic,
    generatedAt: "2026-07-11T00:00:01.000Z",
    digest: sha256Canonical(semantic)
  } as GovernedHarnessManifest;
}

function artifact(kind: LoopArtifact["kind"], id: string): LoopArtifact {
  return {
    id,
    kind,
    path: `.mn/artifacts/${id}.json`,
    digest: digest(id),
    contentType: "application/json"
  };
}

function outputKind(stage: RunStageName): LoopArtifact["kind"] {
  switch (stage) {
    case "discovery":
      return "discovery";
    case "specification":
      return "specification";
    case "impact_architecture":
      return "impact_report";
    case "implementation":
      return "diff";
    case "verification":
      return "verification_evidence";
    case "approval_demo":
      return "approval_material";
    case "learning":
      return "learning_proposal";
  }
}

function defaultHandlers(overrides: Partial<Record<RunStageName, StageHandler>> = {}): GovernedStageHandlers {
  const handlers = Object.fromEntries(
    GOVERNED_INCREMENT_DEFINITION.stages.map((stage) => [
      stage,
      async (context: StageHandlerContext) => {
        if (stage === "approval_demo") {
          return {
            status: "waiting_approval" as const,
            artifacts: [artifact("approval_material", `${stage}-${context.attempt}`)]
          };
        }
        return {
          status: "completed" as const,
          artifacts: [artifact(outputKind(stage), `${stage}-${context.attempt}`)],
          budgetDelta: {
            durationSeconds: 0,
            tokens: 1,
            costUsd: 0.001,
            changedFiles: stage === "implementation" ? 1 : 0,
            changedLines: stage === "implementation" ? 5 : 0
          }
        };
      }
    ])
  ) as unknown as Record<RunStageName, StageHandler>;
  return Object.freeze({ ...handlers, ...overrides });
}

function tickingClock(startSeconds = 10): () => string {
  let second = startSeconds;
  return () => {
    const value = new Date(Date.UTC(2026, 6, 11, 0, 0, second)).toISOString();
    second += 1;
    return value;
  };
}

function baseInput(
  overrides: Partial<ExecuteGovernedRunInput> = {}
): ExecuteGovernedRunInput & { checkpoints: GovernedRunState[] } {
  const snapshot = governance();
  const checkpoints: GovernedRunState[] = [];
  return Object.assign(
    {
      schemaVersion: 1 as const,
      runId: "run-1",
      specRef,
      governanceSnapshot: snapshot,
      harnessManifest: harness(snapshot),
      handlers: defaultHandlers(),
      onCheckpoint: (state: GovernedRunState) => {
        checkpoints.push(state);
      },
      now: tickingClock()
    },
    overrides,
    { checkpoints }
  );
}

function withoutCheckpoints(input: ReturnType<typeof baseInput>): ExecuteGovernedRunInput {
  const { checkpoints: _checkpoints, ...executionInput } = input;
  return executionInput;
}

test("workflow definition and digest are fixed and deterministic", () => {
  assert.deepEqual(GOVERNED_INCREMENT_DEFINITION.stages, [
    "discovery",
    "specification",
    "impact_architecture",
    "implementation",
    "verification",
    "approval_demo",
    "learning"
  ]);
  const { digest: _digest, ...semantic } = GOVERNED_INCREMENT_DEFINITION;
  assert.equal(GOVERNED_INCREMENT_DEFINITION.digest, sha256Canonical(semantic));
  assert.equal(GOVERNED_INCREMENT_WORKFLOW_REF.digest, GOVERNED_INCREMENT_DEFINITION.digest);
  assert.ok(Object.isFrozen(GOVERNED_INCREMENT_DEFINITION));
});

test("Harness maxCandidates is strictly validated but remains an implementation-engine limit", async () => {
  const snapshot = governance();
  const accepted = baseInput({
    governanceSnapshot: snapshot,
    harnessManifest: harness(snapshot, {
      maxCandidates: 2,
      maxRepairAttempts: 3
    })
  });
  const waiting = await executeGovernedIncrement(withoutCheckpoints(accepted));
  assert.equal(waiting.status, "waiting_approval");
  assert.equal("maxCandidates" in waiting.limits, false);

  const invalid = baseInput({
    governanceSnapshot: snapshot,
    harnessManifest: harness(snapshot, {
      maxCandidates: 0,
      maxRepairAttempts: 3
    })
  });
  await assert.rejects(
    executeGovernedIncrement(withoutCheckpoints(invalid)),
    /stopConditions\.maxCandidates/u
  );
});

test("successful run checkpoints every stage, waits for signed approval, then learns", async () => {
  const first = baseInput();
  const waiting = await executeGovernedIncrement(withoutCheckpoints(first));
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.currentStage, "approval_demo");
  assert.equal(waiting.attempts.length, 6);
  assert.equal(waiting.attempts.at(-1)?.status, "waiting_approval");
  assert.ok(first.checkpoints.length >= 12, "each invoked handler gets pre and post checkpoints");
  assert.ok(first.checkpoints.every(Object.isFrozen));
  assert.throws(() => {
    (waiting.budgetUsage as { tokens: number }).tokens = 9_999;
  }, TypeError);

  const approval = createApprovalDecision({
    runId: waiting.runId,
    stageAttemptId: waiting.attempts.at(-1)!.id,
    decision: "approve",
    actorId: "reviewer@example.com",
    decidedAt: "2026-07-11T00:01:00.000Z"
  });
  const resumed = baseInput({
    resumeFrom: waiting,
    approvalDecision: approval,
    now: tickingClock(61)
  });
  const completed = await executeGovernedIncrement(withoutCheckpoints(resumed));
  assert.equal(completed.status, "completed");
  assert.equal(completed.attempts.length, 7);
  assert.equal(completed.approval?.actorId, "reviewer@example.com");
  assert.deepEqual(
    completed.attempts.map((attempt) => attempt.stage),
    GOVERNED_INCREMENT_DEFINITION.stages
  );
  assert.deepEqual(completed.attempts.at(-1)?.outputArtifacts.map((item) => item.kind), [
    "learning_proposal"
  ]);
});

test("a non-verification stage failure is classified, persisted, and terminates", async () => {
  const input = baseInput({
    handlers: defaultHandlers({
      specification: async () => ({
        status: "failed",
        artifacts: [],
        failure: { kind: "stage_failure", retryable: true, reason: "ambiguous contract" }
      })
    })
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(input));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "stage_failure");
  assert.equal(result.attempts.at(-1)?.stage, "specification");
  assert.equal(result.attempts.at(-1)?.status, "failed");
  assert.equal(input.checkpoints.at(-1)?.digest, result.digest);
});

test("verification failure performs a bounded repair and then succeeds", async () => {
  let verificationCalls = 0;
  const repairContexts: StageHandlerContext[] = [];
  const input = baseInput({
    handlers: defaultHandlers({
      implementation: async (context) => {
        repairContexts.push(context);
        return {
          status: "completed",
          artifacts: [artifact("diff", `diff-${context.attempt}`)],
          budgetDelta: { changedFiles: 1, changedLines: 2 }
        };
      },
      verification: async () => {
        verificationCalls += 1;
        if (verificationCalls === 1) {
          return {
            status: "failed",
            artifacts: [artifact("verification_evidence", "failed-evidence")],
            failure: { kind: "stage_failure", retryable: true, reason: "contract failure" },
            failureSignature: digest("contract-failure"),
            diffDigest: digest("diff-v1")
          };
        }
        return {
          status: "completed",
          artifacts: [artifact("verification_evidence", "passed-evidence")]
        };
      }
    })
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(input));
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.budgetUsage.repairAttempts, 1);
  assert.equal(verificationCalls, 2);
  assert.deepEqual(repairContexts.map((context) => context.isRepair), [false, true]);
  assert.equal(result.repairHistory.length, 1);
});

test("all duration, token, cost and change budgets fail closed", async () => {
  for (const scenario of [
    { stop: { maxDurationSeconds: 0 }, delta: {} },
    { stop: { maxTokens: 1 }, delta: { tokens: 2 } },
    { stop: { maxCostUsd: 0.01 }, delta: { costUsd: 0.02 } },
    { stop: { maxChangedFiles: 1 }, delta: { changedFiles: 2 } },
    { stop: { maxChangedLines: 1 }, delta: { changedLines: 2 } }
  ]) {
    const snapshot = governance();
    const input = baseInput({
      governanceSnapshot: snapshot,
      harnessManifest: harness(snapshot, { ...scenario.stop, maxRepairAttempts: 3 }),
      handlers: defaultHandlers({
        discovery: async () => ({
          status: "completed",
          artifacts: [artifact("discovery", "budget-output")],
          budgetDelta: scenario.delta
        })
      })
    });
    const result = await executeGovernedIncrement(withoutCheckpoints(input));
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.kind, "budget_exhausted");
    assert.equal(result.attempts[0]?.status, "failed");
  }
});

test("authoritative measurement overrides worker zero-reporting and is sealed into the ledger", async () => {
  const snapshot = governance();
  const input = baseInput({
    governanceSnapshot: snapshot,
    harnessManifest: harness(snapshot, { maxTokens: 1, maxRepairAttempts: 3 }),
    handlers: defaultHandlers({
      discovery: async () => ({
        status: "completed",
        artifacts: [artifact("discovery", "authoritative-budget")],
        budgetDelta: { tokens: 0, costUsd: 0, changedFiles: 0, changedLines: 0 }
      })
    }),
    measureBudgetDelta: (request) => {
      const delta: LoopBudgetDelta = {
        durationSeconds: 1,
        tokens: 2,
        costUsd: 0.02,
        changedFiles: 0,
        changedLines: 0
      };
      return {
        delta,
        proof: measurementProof(request, delta)
      };
    }
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(input));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "budget_exhausted");
  assert.equal(result.budgetUsage.tokens, 2);
  assert.equal(result.attempts[0]?.budgetDelta.tokens, 2);
  assert.equal(result.attempts[0]?.budgetMeasurement?.issuer, "mn-api");
  assert.equal(validateGovernedRunState(result).digest, result.digest);
});

test("measurement proofs form an append-only cumulative chain", async () => {
  const input = baseInput({
    measureBudgetDelta: (request) => {
      const delta: LoopBudgetDelta = {
        durationSeconds: 1,
        tokens: 1,
        costUsd: 0.001,
        changedFiles: request.stage === "implementation" ? 1 : 0,
        changedLines: request.stage === "implementation" ? 4 : 0
      };
      return { delta, proof: measurementProof(request, delta) };
    }
  });
  const waiting = await executeGovernedIncrement(withoutCheckpoints(input));
  const proofs = waiting.attempts.map((attempt) => attempt.budgetMeasurement);
  assert.equal(proofs.every(Boolean), true);
  for (let index = 1; index < proofs.length; index += 1) {
    assert.equal(proofs[index]?.previousMeasurementDigest, proofs[index - 1]?.digest);
  }

  const { digest: _stateDigest, ...stateSemantic } = waiting;
  const forgedAttempt = {
    ...waiting.attempts[1]!,
    budgetMeasurement: {
      ...waiting.attempts[1]!.budgetMeasurement!,
      previousMeasurementDigest: digest("unrelated-proof")
    }
  };
  const forgedSemantic = {
    ...stateSemantic,
    attempts: [waiting.attempts[0]!, forgedAttempt, ...waiting.attempts.slice(2)]
  };
  assert.throws(
    () => validateGovernedRunState({
      ...forgedSemantic,
      digest: sha256Canonical(forgedSemantic)
    }),
    /budgetMeasurement/u
  );
});

test("two unchanged verification rounds escalate no progress to a human", async () => {
  const signature = digest("same-failure");
  const sameDiff = digest("same-diff");
  const input = baseInput({
    handlers: defaultHandlers({
      verification: async () => ({
        status: "failed",
        artifacts: [artifact("verification_evidence", "same-output")],
        failure: { kind: "stage_failure", retryable: true, reason: "still broken" },
        failureSignature: signature,
        diffDigest: sameDiff
      })
    })
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(input));
  assert.equal(result.status, "needs_human");
  assert.equal(result.failure?.kind, "no_progress");
  assert.equal(result.repairHistory.length, 2);
  assert.equal(result.budgetUsage.repairAttempts, 1);
});

test("repair attempts stop at the configured bound", async () => {
  let call = 0;
  const snapshot = governance();
  const input = baseInput({
    governanceSnapshot: snapshot,
    harnessManifest: harness(snapshot, { maxRepairAttempts: 1 }),
    handlers: defaultHandlers({
      verification: async () => {
        call += 1;
        return {
          status: "failed",
          artifacts: [artifact("verification_evidence", `failure-${call}`)],
          failure: { kind: "stage_failure", retryable: true, reason: `failure-${call}` },
          failureSignature: digest(`signature-${call}`),
          diffDigest: digest(`diff-${call}`)
        };
      }
    })
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(input));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "budget_exhausted");
  assert.equal(result.budgetUsage.repairAttempts, 1);
  assert.equal(call, 2);
});

test("approval rejection is bound, audited in state, and terminal", async () => {
  const input = baseInput();
  const waiting = await executeGovernedIncrement(withoutCheckpoints(input));
  const decision = createApprovalDecision({
    runId: waiting.runId,
    stageAttemptId: waiting.attempts.at(-1)!.id,
    decision: "reject",
    actorId: "owner@example.com",
    decidedAt: "2026-07-11T00:01:00.000Z"
  });
  const resumed = baseInput({ resumeFrom: waiting, approvalDecision: decision, now: tickingClock(61) });
  const result = await executeGovernedIncrement(withoutCheckpoints(resumed));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "approval_rejected");
  assert.equal(result.approval?.digest, decision.digest);
  assert.equal(result.attempts.at(-1)?.status, "failed");
});

test("resume abandons an indeterminate handler and reruns from last definite stage", async () => {
  let captured: GovernedRunState | undefined;
  const first = baseInput({
    onCheckpoint: (state) => {
      captured = state;
      throw new Error("simulated persistence outage after durable capture");
    }
  });
  await assert.rejects(executeGovernedIncrement(withoutCheckpoints(first)), LoopPersistenceError);
  assert.equal(captured?.attempts.at(-1)?.status, "running");

  let discoveries = 0;
  const resumed = baseInput({
    resumeFrom: captured,
    handlers: defaultHandlers({
      discovery: async (context) => {
        discoveries += 1;
        return {
          status: "completed",
          artifacts: [artifact("discovery", `recovered-${context.attempt}`)]
        };
      }
    }),
    now: tickingClock(20)
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(resumed));
  assert.equal(result.status, "waiting_approval");
  assert.equal(discoveries, 1);
  assert.deepEqual(
    result.attempts.filter((attempt) => attempt.stage === "discovery").map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.equal(result.attempts[0]?.failure?.kind, "interrupted");
});

test("cancellation during a handler is checkpointed and terminal", async () => {
  const controller = new AbortController();
  const input = baseInput({
    signal: controller.signal,
    handlers: defaultHandlers({
      discovery: async () => {
        controller.abort();
        throw new Error("abort");
      }
    })
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(input));
  assert.equal(result.status, "cancelled");
  assert.equal(result.failure?.kind, "cancelled");
  assert.equal(result.attempts[0]?.status, "cancelled");
  assert.equal(input.checkpoints.at(-1)?.status, "cancelled");
});

test("authoritative budget exhaustion outranks cancellation during a handler", async () => {
  const controller = new AbortController();
  const snapshot = governance();
  const input = baseInput({
    governanceSnapshot: snapshot,
    harnessManifest: harness(snapshot, { maxTokens: 1, maxRepairAttempts: 3 }),
    signal: controller.signal,
    handlers: defaultHandlers({
      discovery: async () => {
        controller.abort();
        throw new Error("abort after provider usage");
      }
    }),
    measureBudgetDelta: (request) => {
      const delta: LoopBudgetDelta = {
        durationSeconds: 1,
        tokens: 2,
        costUsd: 0,
        changedFiles: 0,
        changedLines: 0
      };
      return { delta, proof: measurementProof(request, delta) };
    }
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(input));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "budget_exhausted");
  assert.equal(result.attempts[0]?.status, "failed");
  assert.equal(result.attempts[0]?.budgetMeasurement?.delta.tokens, 2);
});

test("authoritative budget exhaustion outranks cancellation before a handler", async () => {
  const controller = new AbortController();
  controller.abort();
  const snapshot = governance();
  const input = baseInput({
    governanceSnapshot: snapshot,
    harnessManifest: harness(snapshot, { maxTokens: 1, maxRepairAttempts: 3 }),
    signal: controller.signal,
    measureBudgetDelta: (request) => {
      const delta: LoopBudgetDelta = {
        durationSeconds: 0,
        tokens: 2,
        costUsd: 0,
        changedFiles: 0,
        changedLines: 0
      };
      return { delta, proof: measurementProof(request, delta) };
    }
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(input));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "budget_exhausted");
  assert.equal(result.attempts[0]?.status, "failed");
  assert.equal(result.attempts[0]?.budgetMeasurement?.delta.tokens, 2);
});

test("handler throws are classified without persisting exception or secret text", async () => {
  const input = baseInput({
    handlers: defaultHandlers({
      discovery: async () => {
        throw new Error("password=do-not-persist");
      }
    })
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(input));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "handler_error");
  assert.doesNotMatch(JSON.stringify(result), /do-not-persist/);
});

test("infrastructure interruption leaves the durable running checkpoint for takeover", async () => {
  const input = baseInput({
    handlers: defaultHandlers({
      discovery: async () => {
        throw new GovernedLoopInterruptionError("owner lease expired");
      }
    })
  });
  await assert.rejects(
    executeGovernedIncrement(withoutCheckpoints(input)),
    GovernedLoopInterruptionError
  );
  assert.equal(input.checkpoints.length, 1);
  assert.equal(input.checkpoints[0]?.status, "running");
  assert.equal(input.checkpoints[0]?.attempts.at(-1)?.status, "running");
  assert.equal(input.checkpoints[0]?.attempts.at(-1)?.stage, "discovery");
});

test("Learning cannot auto-activate or emit non-proposal artifacts", async () => {
  const first = baseInput({
    handlers: defaultHandlers({
      learning: async () => ({
        status: "completed",
        artifacts: [artifact("other", "activated-pack")],
        autoActivate: true
      } as never)
    })
  });
  const waiting = await executeGovernedIncrement(withoutCheckpoints(first));
  const decision = createApprovalDecision({
    runId: waiting.runId,
    stageAttemptId: waiting.attempts.at(-1)!.id,
    decision: "approve",
    actorId: "reviewer@example.com",
    decidedAt: "2026-07-11T00:01:00.000Z"
  });
  const resumed = baseInput({
    resumeFrom: waiting,
    approvalDecision: decision,
    handlers: first.handlers,
    now: tickingClock(61)
  });
  const result = await executeGovernedIncrement(withoutCheckpoints(resumed));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "invalid_handler_result");
  assert.doesNotMatch(JSON.stringify(result), /autoActivate/);
});

test("immutable binding mismatches, tampered checkpoints, and non-exact inputs fail", async () => {
  const mismatched = baseInput();
  const otherSpec = { ...specRef, digest: digest("other-spec") };
  await assert.rejects(
    executeGovernedIncrement(withoutCheckpoints({ ...mismatched, specRef: otherSpec })),
    GovernedLoopInputError
  );

  const initial = baseInput();
  const waiting = await executeGovernedIncrement(withoutCheckpoints(initial));
  const tampered = { ...waiting, status: "completed" as const };
  const resume = baseInput({ resumeFrom: tampered });
  await assert.rejects(executeGovernedIncrement(withoutCheckpoints(resume)), /resumeFrom.digest/);

  const extra = baseInput();
  await assert.rejects(
    executeGovernedIncrement({ ...withoutCheckpoints(extra), hiddenPolicyOverride: true } as never),
    /not allowed/
  );

  const sparse = new Array<LoopArtifact>(1);
  const sparseInput = baseInput({ initialArtifacts: sparse });
  await assert.rejects(executeGovernedIncrement(withoutCheckpoints(sparseInput)), /dense/);
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("external checkpoints cannot expand Harness limits or rewrite the budget ledger", async () => {
  const input = baseInput();
  const waiting = await executeGovernedIncrement(withoutCheckpoints(input));
  const { digest: _waitingDigest, ...waitingSemantic } = waiting;
  const expandedSemantic = {
    ...waitingSemantic,
    limits: { ...waiting.limits, maxRepairAttempts: 999 }
  };
  const expanded = {
    ...expandedSemantic,
    digest: sha256Canonical(expandedSemantic)
  };
  assert.equal(validateGovernedRunState(expanded).limits.maxRepairAttempts, 999);
  assert.throws(
    () => validateGovernedRunStateAgainstHarness(expanded, input.harnessManifest),
    /immutable Harness stopConditions/u
  );

  const forgedUsageSemantic = {
    ...waitingSemantic,
    budgetUsage: { ...waiting.budgetUsage, tokens: waiting.budgetUsage.tokens + 1 }
  };
  const forgedUsage = {
    ...forgedUsageSemantic,
    digest: sha256Canonical(forgedUsageSemantic)
  };
  assert.throws(
    () => validateGovernedRunState(forgedUsage),
    /stage budget ledger/u
  );
});

function measurementProof(
  request: Parameters<NonNullable<ExecuteGovernedRunInput["measureBudgetDelta"]>>[0],
  delta: LoopBudgetDelta
): LoopBudgetMeasurementProof {
  const previous = request.previousMeasurement;
  const cumulative: LoopBudgetDelta = {
    durationSeconds: (previous?.cumulative.durationSeconds ?? 0) + delta.durationSeconds,
    tokens: (previous?.cumulative.tokens ?? 0) + delta.tokens,
    costUsd: (previous?.cumulative.costUsd ?? 0) + delta.costUsd,
    changedFiles: (previous?.cumulative.changedFiles ?? 0) + delta.changedFiles,
    changedLines: (previous?.cumulative.changedLines ?? 0) + delta.changedLines
  };
  const semantic = {
    schemaVersion: 1 as const,
    issuer: "mn-api" as const,
    tenantId: "tenant-a",
    runId: request.runId,
    workerId: "worker-a",
    claimDigest: digest("claim-a"),
    stageAttemptId: request.stageAttemptId,
    stage: request.stage,
    attempt: request.attempt,
    ...(previous ? { previousMeasurementDigest: previous.digest } : {}),
    intervalStartedAt: request.startedAt,
    measuredAt: request.finishedAt,
    usageRequestIds: [] as string[],
    usageDigest: digest(`usage-${request.stageAttemptId}`),
    delta,
    cumulative
  };
  return {
    ...semantic,
    digest: sha256Canonical(semantic),
    signature: digest(`signature-${request.stageAttemptId}`)
  };
}
