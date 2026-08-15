import { mkdtemp, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeStrategy } from "@mn/core";
import type {
  AgentRunInput,
  AgentRunResult,
  AgentTask,
  Project,
  RunRecord
} from "@mn/core";
import { MockExecutor } from "@mn/executors";
import { RunOrchestrator } from "../src/index.js";

test("run orchestrator runs mock candidates and selects a winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "mn-project-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-worktrees-"));
  const project: Project = {
    id: "p1",
    name: "demo",
    rootPath: root,
    defaultBranch: "main",
    policyId: "default",
    services: [
      {
        id: "api",
        name: "api",
        path: root,
        owners: ["team-api"],
        language: "typescript",
        contracts: []
      }
    ]
  };
  const task: AgentTask = {
    id: "t1",
    projectId: "p1",
    title: "demo task",
    intent: "implement",
    targetServices: ["api"],
    prompt: "make a tiny change",
    acceptanceCriteria: ["unit tests pass"],
    strategy: normalizeStrategy({
      providers: ["claude", "codex"],
      candidates: 2,
      requiredGates: ["llm_verifier"],
      sandbox: "workspace-write",
      humanApproval: "never",
      timeoutSeconds: 60
    }),
    createdAt: new Date(0).toISOString()
  };

  const orchestrator = new RunOrchestrator({
    workspaceRoot,
    executors: {
      claude: new MockExecutor("claude"),
      codex: new MockExecutor("codex")
    }
  });

  const run = await orchestrator.run(project, task);

  assert.equal(run.status, "completed");
  assert.equal(run.candidates.length, 2);
  assert.ok(run.winnerCandidateId);

  await rm(root, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("run orchestrator fails the run when every candidate execution fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mn-project-failed-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-worktrees-failed-"));
  const project = buildProject(root);
  const task = buildTask({
    providers: ["claude"],
    candidates: 1,
    requiredGates: ["llm_verifier"],
    sandbox: "workspace-write",
    humanApproval: "never",
    timeoutSeconds: 60
  });

  const orchestrator = new RunOrchestrator({
    workspaceRoot,
    executors: {
      claude: new FailingExecutor(),
      codex: new MockExecutor("codex")
    }
  });

  const run = await orchestrator.run(project, task);

  assert.equal(run.status, "failed");
  assert.equal(run.winnerCandidateId, undefined);

  await rm(root, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("run orchestrator injects associated proxy env into real candidate execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "mn-project-proxy-env-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-worktrees-proxy-env-"));
  const project = buildProject(root);
  const task = buildTask({
    providers: ["codex"],
    candidates: 1,
    requiredGates: [],
    sandbox: "workspace-write",
    humanApproval: "never",
    timeoutSeconds: 60
  });
  const executor = new RecordingExecutor("codex");

  const orchestrator = new RunOrchestrator({
    workspaceRoot,
    proxyBaseUrl: "http://127.0.0.1:15721/",
    executors: {
      claude: new MockExecutor("claude"),
      codex: executor
    }
  });

  const run = await orchestrator.run(project, task, { runId: "run/proxy" });

  assert.equal(
    run.status,
    "completed",
    JSON.stringify(run.candidates[0]?.gates ?? [])
  );
  assert.equal(executor.lastInput?.env?.MN_RUN_ID, "run/proxy");
  assert.equal(executor.lastInput?.env?.MN_CANDIDATE_ID, "codex-1");
  assert.equal(
    executor.lastInput?.env?.OPENAI_BASE_URL,
    "http://127.0.0.1:15721/mn/runs/run%2Fproxy/candidates/codex-1/v1"
  );
  assert.equal(
    executor.lastInput?.env?.MN_ASSOCIATED_PROXY_BASE_URL,
    "http://127.0.0.1:15721/mn/runs/run%2Fproxy/candidates/codex-1"
  );
  assert.match(
    executor.lastInput?.outputCheckpoint?.stdoutPath ?? "",
    /checkpoints\/run%2Fproxy\/codex-1\/stdout\.txt$/
  );

  await rm(root, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("run orchestrator uses an API receipt instead of forgeable run headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "mn-project-proxy-receipt-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-worktrees-proxy-receipt-"));
  const project = buildProject(root);
  const task = buildTask({
    providers: ["codex"],
    candidates: 1,
    requiredGates: [],
    sandbox: "workspace-write",
    humanApproval: "never",
    timeoutSeconds: 60
  });
  const executor = new RecordingExecutor("codex");
  const requests: unknown[] = [];
  const orchestrator = new RunOrchestrator({
    workspaceRoot,
    proxyBaseUrl: "http://127.0.0.1:15721/",
    resolveProxyAssociationReceipt: async (request) => {
      requests.push(request);
      return "api.receipt";
    },
    executors: {
      claude: new MockExecutor("claude"),
      codex: executor
    }
  });

  await orchestrator.run(project, task, { runId: "run/receipt" });
  assert.deepEqual(requests, [{
    runId: "run/receipt",
    candidateId: "codex-1",
    provider: "codex"
  }]);
  assert.equal(
    executor.lastInput?.env?.OPENAI_BASE_URL,
    "http://127.0.0.1:15721/mn/usage-receipts/api.receipt/v1"
  );
  assert.equal(
    executor.lastInput?.env?.MN_ASSOCIATED_PROXY_BASE_URL,
    "http://127.0.0.1:15721/mn/usage-receipts/api.receipt"
  );

  await rm(root, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("run orchestrator skips checkpointed completed candidates on resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "mn-project-checkpoint-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-worktrees-checkpoint-"));
  const project = buildProject(root);
  const task = buildTask({
    providers: ["claude", "codex"],
    candidates: 2,
    requiredGates: [],
    sandbox: "workspace-write",
    humanApproval: "never",
    timeoutSeconds: 60
  });
  const claude = new RecordingExecutor("claude");
  const codex = new RecordingExecutor("codex");
  const checkpoint: RunRecord = {
    id: "run-checkpoint",
    taskId: task.id,
    projectId: project.id,
    status: "running",
    candidates: [
      {
        id: "claude-1",
        runId: "run-checkpoint",
        provider: "claude",
        worktreePath: join(root, "checkpointed-claude"),
        status: "completed",
        result: {
          provider: "claude",
          candidateId: "claude-1",
          status: "completed",
          exitCode: 0,
          stdout: "checkpointed claude output",
          stderr: "",
          summary: "checkpointed claude summary",
          artifacts: [],
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(1).toISOString()
        },
        gates: []
      }
    ],
    gates: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1).toISOString()
  };
  const events: string[] = [];

  const orchestrator = new RunOrchestrator({
    workspaceRoot,
    executors: {
      claude,
      codex
    },
    onEvent: (event) => events.push(event.message)
  });

  const run = await orchestrator.run(project, task, {
    runId: "run-checkpoint",
    resumeFrom: checkpoint
  });

  assert.equal(run.status, "completed");
  assert.equal(run.candidates.length, 2);
  assert.equal(claude.calls, 0);
  assert.equal(codex.calls, 1);
  assert.equal(run.candidates[0]?.result?.stdout, "checkpointed claude output");
  assert.equal(run.candidates[1]?.provider, "codex");
  assert.equal(
    events.some((message) =>
      message.includes("Skipping checkpointed candidate claude-1")
    ),
    true
  );

  await rm(root, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("run orchestrator resumes queued checkpointed candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "mn-project-queued-checkpoint-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mn-worktrees-queued-checkpoint-"));
  const project = buildProject(root);
  const queuedCodexPath = join(workspaceRoot, "run-checkpoint-codex-2");
  const task = buildTask({
    providers: ["claude", "codex"],
    candidates: 2,
    requiredGates: [],
    sandbox: "workspace-write",
    humanApproval: "never",
    timeoutSeconds: 60
  });
  const claude = new RecordingExecutor("claude");
  const codex = new RecordingExecutor("codex");
  const checkpoint: RunRecord = {
    id: "run-checkpoint",
    taskId: task.id,
    projectId: project.id,
    status: "running",
    candidates: [
      {
        id: "claude-1",
        runId: "run-checkpoint",
        provider: "claude",
        worktreePath: join(root, "checkpointed-claude"),
        status: "completed",
        result: {
          provider: "claude",
          candidateId: "claude-1",
          status: "completed",
          exitCode: 0,
          stdout: "checkpointed claude output",
          stderr: "",
          summary: "checkpointed claude summary",
          artifacts: [],
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(1).toISOString()
        },
        gates: []
      },
      {
        id: "codex-2",
        runId: "run-checkpoint",
        provider: "codex",
        worktreePath: queuedCodexPath,
        status: "queued",
        gates: []
      }
    ],
    gates: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1).toISOString()
  };
  const events: string[] = [];

  const orchestrator = new RunOrchestrator({
    workspaceRoot,
    executors: {
      claude,
      codex
    },
    onEvent: (event) => events.push(event.message)
  });

  const run = await orchestrator.run(project, task, {
    runId: "run-checkpoint",
    resumeFrom: checkpoint
  });

  assert.equal(run.status, "completed");
  assert.equal(claude.calls, 0);
  assert.equal(codex.calls, 1);
  assert.equal(codex.lastInput?.cwd, queuedCodexPath);
  assert.equal(run.candidates[1]?.status, "completed");
  assert.equal(
    events.some((message) =>
      message.includes("Resuming queued checkpointed candidate codex-2")
    ),
    true
  );

  await rm(root, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

function buildProject(root: string): Project {
  return {
    id: "p1",
    name: "demo",
    rootPath: root,
    defaultBranch: "main",
    policyId: "default",
    services: [
      {
        id: "api",
        name: "api",
        path: root,
        owners: ["team-api"],
        language: "typescript",
        contracts: []
      }
    ]
  };
}

function buildTask(strategy: Parameters<typeof normalizeStrategy>[0]): AgentTask {
  return {
    id: "t1",
    projectId: "p1",
    title: "demo task",
    intent: "implement",
    targetServices: ["api"],
    prompt: "make a tiny change",
    acceptanceCriteria: ["unit tests pass"],
    strategy: normalizeStrategy(strategy),
    createdAt: new Date(0).toISOString()
  };
}

class FailingExecutor {
  provider = "claude" as const;

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return {
      provider: "claude",
      candidateId: input.candidateId,
      status: "failed",
      exitCode: 1,
      stdout: "stopped before producing a valid change",
      stderr: "",
      summary: "failed without stderr",
      artifacts: [],
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString()
    };
  }
}

class RecordingExecutor {
  lastInput?: AgentRunInput;
  calls = 0;

  constructor(public readonly provider: AgentRunInput["provider"]) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls += 1;
    this.lastInput = input;
    return {
      provider: input.provider,
      candidateId: input.candidateId,
      status: "completed",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      summary: "ok",
      artifacts: [],
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString()
    };
  }
}
