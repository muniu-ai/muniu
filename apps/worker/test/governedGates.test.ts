import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GOVERNED_INCREMENT_WORKFLOW_REF,
  normalizeStrategy,
  type AgentRunInput,
  type AgentRunResult,
  type AgentTask,
  type Project,
  type RunRecord
} from "@mn/core";
import type { GovernanceSnapshot } from "@mn/governance";
import type { HarnessManifest } from "@mn/harness";
import { sha256Canonical } from "@mn/loop";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";
import {
  GateRegistryV2,
  GovernedRunOrchestrator,
  captureContractBaseline,
  runGovernedGatePlan,
  validateGateResultV2Integrity
} from "../src/index.js";

async function fixture(t: test.TestContext): Promise<{
  root: string;
  workspaces: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mn-governed-gates-project-"));
  const workspaces = await mkdtemp(join(tmpdir(), "mn-governed-gates-workspaces-"));
  t.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(workspaces, { recursive: true, force: true })
    ]);
  });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "governed-fixture",
      scripts: { test: "node -e \"process.exit(1)\"" }
    }),
    "utf8"
  );
  return { root, workspaces };
}

function approvedSpec(): SpecRevision {
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId: "checkout",
    revision: 1,
    status: "approved",
    source: "native",
    title: "Checkout",
    hypothesis: "Checkout remains verifiable.",
    outcomes: ["Checkout completes."],
    nonGoals: ["No deployment."],
    targetServices: ["api"],
    contracts: {
      interface: { transport: "http" },
      data: { owner: "api" },
      state: { states: ["pending", "confirmed"] },
      permission: { role: "customer" },
      exception: { timeout: "fail" },
      quality: { p95Ms: 500 },
      observability: { metric: "checkout_total" }
    },
    acceptanceCases: [
      {
        id: "accept-checkout",
        kind: "positive",
        title: "Complete checkout",
        given: ["Stock exists."],
        when: "Checkout starts.",
        then: ["Order is confirmed."]
      }
    ],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    createdBy: "owner@example.com",
    approvedAt: "2026-07-11T01:00:00.000Z",
    approvedBy: "reviewer@example.com"
  };
  return { ...unsigned, digest: digestSpecRevision(unsigned) };
}

function bindings(
  spec: SpecRevision,
  gateIds: readonly string[]
): { governance: GovernanceSnapshot; harness: HarnessManifest } {
  const specRef = {
    specSetId: spec.specSetId,
    revision: spec.revision,
    digest: spec.digest
  };
  const policy = {
    requiredGates: [...gateIds],
    deny: [],
    protectedPaths: [],
    commandAllowlist: ["npm", "node"],
    budgets: { maxRepairAttempts: 3 },
    approvalMode: "before-merge" as const
  };
  const governanceSemantic = {
    schemaVersion: 1 as const,
    layers: [],
    policy,
    appliedWaivers: [],
    decisions: [],
    specRef,
    workflowRef: GOVERNED_INCREMENT_WORKFLOW_REF
  };
  const governance = {
    ...governanceSemantic,
    resolvedAt: "2026-07-11T01:00:01.000Z",
    digest: sha256Canonical(governanceSemantic)
  } as GovernanceSnapshot;
  const contextSemantic = {
    fragments: [],
    omitted: [],
    usedBytes: 0,
    usedTokens: 0,
    maxBytes: 10_000,
    maxTokens: 10_000,
    tokenEstimator: { id: "utf8-byte-upper-bound" as const, version: "1" as const }
  };
  const context = { ...contextSemantic, digest: sha256Canonical(contextSemantic) };
  const harnessSemantic = {
    schemaVersion: 1 as const,
    profile: { id: "local", version: "1", digest: sha256Canonical("local") },
    task: { taskId: "task-1", projectRoot: "/bound/by-test" },
    specRef,
    governanceDigest: governance.digest,
    workflowRef: GOVERNED_INCREMENT_WORKFLOW_REF,
    selectedServices: ["api"],
    languageByService: { api: "typescript" },
    policy,
    executionPolicy: {
      commandAllowlist: ["npm", "node"],
      deny: [],
      protectedPaths: []
    },
    context,
    gatePlan: gateIds.map((id) => ({
      id,
      runnerId: id,
      runnerVersion: "1",
      languages: ["typescript"],
      required: true as const
    })),
    sandbox: {
      backendId: "worktree-postcheck",
      backendVersion: "1",
      enforcement: "postcheck" as const,
      capabilities: ["source-isolation", "diff-postcheck"]
    },
    stopConditions: { maxRepairAttempts: 3, maxDurationSeconds: 120 },
    outputSchema: "mn/evidence-v2"
  };
  const harness = {
    ...harnessSemantic,
    generatedAt: "2026-07-11T01:00:02.000Z",
    digest: sha256Canonical(harnessSemantic)
  } as HarnessManifest;
  return { governance, harness };
}

function project(root: string): Project {
  return {
    id: "project-1",
    name: "Governed fixture",
    rootPath: root,
    defaultBranch: "main",
    policyId: "enterprise",
    services: [
      {
        id: "api",
        name: "API",
        path: root,
        owners: ["api-team"],
        language: "typescript",
        contracts: []
      }
    ]
  };
}

function task(spec: SpecRevision): AgentTask {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Governed change",
    intent: "implement",
    targetServices: ["api"],
    prompt: "Implement the approved change.",
    acceptanceCriteria: ["Checkout passes."],
    strategy: normalizeStrategy({
      providers: ["codex"],
      candidates: 1,
      sandbox: "isolated-worktree",
      requiredGates: ["unit_test"],
      humanApproval: "before-merge",
      timeoutSeconds: 30
    }),
    specRef: {
      specSetId: spec.specSetId,
      revision: spec.revision,
      digest: spec.digest!
    },
    workflowRef: GOVERNED_INCREMENT_WORKFLOW_REF,
    createdAt: "2026-07-11T01:00:03.000Z"
  };
}

function baseRun(
  spec: SpecRevision,
  governance: GovernanceSnapshot,
  harness: HarnessManifest
): RunRecord {
  return {
    id: "run-1",
    taskId: "task-1",
    projectId: "project-1",
    status: "queued",
    candidates: [],
    gates: [],
    createdAt: "2026-07-11T01:00:04.000Z",
    updatedAt: "2026-07-11T01:00:04.000Z",
    workflowRef: GOVERNED_INCREMENT_WORKFLOW_REF,
    governanceSnapshot: governance,
    harnessManifest: harness,
    trace: {
      traceId: "trace-1",
      specDigest: spec.digest,
      governanceDigest: governance.digest,
      harnessDigest: harness.digest,
      evidenceIds: []
    }
  };
}

class RepairingExecutor {
  readonly provider = "codex" as const;
  calls = 0;

  constructor(private readonly repair = true) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls += 1;
    if (this.repair && this.calls > 1) {
      await writeFile(
        join(input.cwd, "package.json"),
        JSON.stringify({
          name: "governed-fixture",
          scripts: { test: "node -e \"console.log('repaired')\"" }
        }),
        "utf8"
      );
    }
    return {
      provider: this.provider,
      candidateId: input.candidateId,
      status: "completed",
      exitCode: 0,
      stdout: this.calls > 1 ? "repair produced" : "initial implementation",
      stderr: "",
      summary: "implementation complete",
      artifacts: [],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    };
  }
}

test("governed verification runs real Gate V2 evidence and repairs until it passes", async (t) => {
  const { root, workspaces } = await fixture(t);
  const spec = approvedSpec();
  const { governance, harness } = bindings(spec, ["unit_test"]);
  const executor = new RepairingExecutor();
  const orchestrator = new GovernedRunOrchestrator({
    workspaceRoot: workspaces,
    executors: { claude: executor, codex: executor },
    resolveSpecRevision: () => spec
  });

  const result = await orchestrator.run(
    project(root),
    task(spec),
    baseRun(spec, governance, harness)
  );

  assert.equal(result.state.status, "waiting_approval");
  assert.equal(result.state.budgetUsage.repairAttempts, 1);
  assert.equal(executor.calls, 2);
  assert.deepEqual(
    result.run.gateResultsV2?.map((gate) => gate.status),
    ["fail", "pass"]
  );
  const passed = result.run.gateResultsV2?.at(-1);
  assert.equal(passed?.command?.display, "npm run test");
  assert.deepEqual(passed?.specClauseIds, ["accept-checkout"]);
  assert.equal(validateGateResultV2Integrity(passed!).length, 0);
  assert.ok(result.run.trace?.evidenceIds.includes(passed!.id));
  assert.deepEqual(
    result.run.verificationEvidence,
    [
      {
        stageAttemptId: "run-1:verification:1",
        gateResultIds: [result.run.gateResultsV2![0]!.id]
      },
      {
        stageAttemptId: "run-1:verification:2",
        gateResultIds: [result.run.gateResultsV2![1]!.id]
      }
    ]
  );
  assert.deepEqual(
    result.state.attempts
      .filter((attempt) => attempt.stage === "verification")
      .map((attempt) => attempt.status),
    ["failed", "completed"]
  );
});

test("governed materialization preserves an API-issued Run clock floor", async (t) => {
  const { root, workspaces } = await fixture(t);
  const spec = approvedSpec();
  const { governance, harness } = bindings(spec, ["unit_test"]);
  const executor = new RepairingExecutor();
  const apiClockFloor = new Date(Date.now() + 60_000).toISOString();
  const updates: RunRecord[] = [];
  const orchestrator = new GovernedRunOrchestrator({
    workspaceRoot: workspaces,
    executors: { claude: executor, codex: executor },
    resolveSpecRevision: () => spec,
    onUpdate: (run) => updates.push(run)
  });

  const result = await orchestrator.run(
    project(root),
    task(spec),
    { ...baseRun(spec, governance, harness), updatedAt: apiClockFloor }
  );

  assert.ok(updates.length > 0);
  assert.ok(updates.every((run) => Date.parse(run.updatedAt) >= Date.parse(apiClockFloor)));
  assert.equal(result.run.updatedAt, apiClockFloor);
  assert.ok(Date.parse(result.state.updatedAt) < Date.parse(apiClockFloor));
});

test("missing governed Gate runner fails closed and enters bounded no-progress handling", async (t) => {
  const { root, workspaces } = await fixture(t);
  const spec = approvedSpec();
  const { governance, harness } = bindings(spec, ["enterprise_custom_gate"]);
  const executor = new RepairingExecutor(false);
  const orchestrator = new GovernedRunOrchestrator({
    workspaceRoot: workspaces,
    executors: { claude: executor, codex: executor },
    resolveSpecRevision: () => spec
  });

  const result = await orchestrator.run(
    project(root),
    { ...task(spec), strategy: { ...task(spec).strategy, requiredGates: ["enterprise_custom_gate"] } },
    baseRun(spec, governance, harness)
  );

  assert.equal(result.state.status, "needs_human", JSON.stringify(result.state, null, 2));
  assert.equal(result.state.failure?.kind, "no_progress");
  assert.ok(result.run.gateResultsV2?.every((gate) => gate.status === "error"));
  assert.match(result.run.gateResultsV2?.[0]?.summary ?? "", /No runner supports/u);
});

test("required skipped Gate is normalized to an error and evidence tampering is detected", async (t) => {
  const { root } = await fixture(t);
  const spec = approvedSpec();
  const { harness } = bindings(spec, ["unit_test"]);
  const registry = new GateRegistryV2();
  registry.register({
    id: "test/skipping-runner",
    version: "1",
    gateIds: ["unit_test"],
    languages: ["typescript"],
    evaluate() {
      return { status: "skipped", summary: "tool intentionally skipped" };
    }
  });
  const verification = await runGovernedGatePlan({
    project: project(root),
    task: task(spec),
    manifest: harness,
    candidateRoot: root,
    runId: "run-skipped",
    candidateId: "candidate-1",
    changedPaths: [],
    spec,
    registry
  });
  assert.equal(verification.successful, false);
  assert.equal(verification.results[0]?.status, "error");
  assert.match(verification.results[0]?.summary ?? "", /cannot be skipped/u);
  assert.equal(validateGateResultV2Integrity(verification.results[0]!).length, 0);

  const tampered = {
    ...verification.results[0]!,
    summary: "tampered after persistence"
  };
  assert.ok(
    validateGateResultV2Integrity(tampered).some((issue) =>
      issue.includes("outputDigest does not match")
    )
  );
});

test("governed manifest executes project-declared commands for each bound language", async (t) => {
  const { root } = await fixture(t);
  await Promise.all([
    mkdir(join(root, "services", "web"), { recursive: true }),
    mkdir(join(root, "services", "ledger"), { recursive: true })
  ]);
  const spec = approvedSpec();
  const { harness: baseHarness } = bindings(spec, ["enterprise_verify"]);
  const projectManifest = `apiVersion: mn.dev/project/v1
kind: Project
metadata:
  id: multilingual
services:
  - id: web
    path: services/web
    owners: [web-team]
    language: typescript
    commands:
      enterprise_verify: node -e "console.log('web-ok')"
  - id: ledger
    path: services/ledger
    owners: [ledger-team]
    language: go
    commands:
      enterprise_verify: node -e "console.log('ledger-ok')"
`;
  const fragmentSemantic = {
    id: "repository:.mn/project.yaml",
    kind: "repository-rule",
    source: ".mn/project.yaml",
    sourceId: "repository-governance",
    content: projectManifest,
    priority: 1_000,
    required: false,
    byteLength: Buffer.byteLength(projectManifest),
    tokenEstimate: Buffer.byteLength(projectManifest),
    contentDigest: createHash("sha256").update(projectManifest).digest("hex")
  };
  const fragment = {
    ...fragmentSemantic,
    digest: sha256Canonical(fragmentSemantic)
  };
  const contextSemantic = {
    ...baseHarness.context,
    fragments: [fragment],
  };
  const { digest: _contextDigest, ...contextWithoutDigest } = contextSemantic;
  const context = {
    ...contextWithoutDigest,
    digest: sha256Canonical(contextWithoutDigest)
  };
  const { generatedAt, digest: _digest, ...baseSemantic } = baseHarness;
  const semantic = {
    ...baseSemantic,
    selectedServices: ["ledger", "web"],
    languageByService: { ledger: "go", web: "typescript" },
    context,
    gatePlan: [
      {
        id: "enterprise_verify",
        runnerId: "enterprise_verify",
        runnerVersion: "1",
        languages: ["go", "typescript"],
        required: true as const
      }
    ]
  };
  const harness = {
    ...semantic,
    generatedAt,
    digest: sha256Canonical(semantic)
  } as HarnessManifest;
  const multiProject: Project = {
    ...project(root),
    services: [
      {
        id: "web",
        name: "Web",
        path: "services/web",
        owners: ["web-team"],
        language: "typescript",
        contracts: []
      },
      {
        id: "ledger",
        name: "Ledger",
        path: "services/ledger",
        owners: ["ledger-team"],
        language: "go",
        contracts: []
      }
    ]
  };

  const verification = await runGovernedGatePlan({
    project: multiProject,
    task: { ...task(spec), targetServices: ["ledger", "web"] },
    manifest: harness,
    candidateRoot: root,
    runId: "run-multilingual",
    candidateId: "candidate-1",
    changedPaths: [],
    spec
  });

  assert.equal(verification.successful, true);
  assert.equal(verification.results.length, 2);
  assert.deepEqual(
    verification.results.map((result) => result.command?.executable),
    ["node", "node"]
  );
  assert.deepEqual(
    verification.results.map((result) => result.workingDirectory).sort(),
    [join(root, "services", "ledger"), join(root, "services", "web")].sort()
  );
});

test("governed contract paths canonicalize root aliases and reject realpath escape", async (t) => {
  const realRoot = await mkdtemp(join(tmpdir(), "mn-governed-realpath-real-"));
  const aliasParent = await mkdtemp(join(tmpdir(), "mn-governed-realpath-alias-"));
  const outside = await mkdtemp(join(tmpdir(), "mn-governed-realpath-outside-"));
  t.after(async () => {
    await Promise.all([
      rm(realRoot, { recursive: true, force: true }),
      rm(aliasParent, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true })
    ]);
  });
  await mkdir(join(realRoot, "services", "api"), { recursive: true });
  const contractPath = join(realRoot, "services", "api", "openapi.yaml");
  await writeFile(
    contractPath,
    "openapi: 3.1.0\ninfo: {title: api, version: 1.0.0}\npaths: {}\n",
    "utf8"
  );
  const aliasRoot = join(aliasParent, "project");
  await symlink(realRoot, aliasRoot);
  const spec = approvedSpec();
  const { harness } = bindings(spec, ["contract"]);
  const aliasedProject: Project = {
    ...project(aliasRoot),
    rootPath: aliasRoot,
    services: [
      {
        id: "api",
        name: "API",
        path: join(realRoot, "services", "api"),
        owners: ["api-team"],
        language: "typescript",
        contracts: [{ type: "openapi", path: contractPath }]
      }
    ]
  };
  const baseline = await captureContractBaseline(aliasedProject);
  assert.equal(
    baseline["services/api/openapi.yaml"]?.includes("openapi: 3.1.0"),
    true
  );
  const verification = await runGovernedGatePlan({
    project: aliasedProject,
    task: task(spec),
    manifest: harness,
    candidateRoot: aliasRoot,
    runId: "run-realpath",
    candidateId: "candidate-1",
    changedPaths: [],
    spec,
    contractBaseline: baseline
  });
  assert.equal(verification.successful, true);

  const escapedContract = join(outside, "openapi.yaml");
  await writeFile(escapedContract, "openapi: 3.1.0\npaths: {}\n", "utf8");
  await assert.rejects(
    captureContractBaseline({
      ...aliasedProject,
      services: [
        {
          ...aliasedProject.services[0]!,
          contracts: [{ type: "openapi", path: escapedContract }]
        }
      ]
    }),
    /Contract path escapes project root/u
  );
});
