// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Approval,
  CodingRunnerConfigurationV1,
  Execution,
  ExecutionAuthority,
  ExternalCodingRunnerId,
  Job,
  Thread,
  Workspace,
} from "@mn/contracts";
import { CODING_RUNNER_CONFIGURATION_NAMESPACE } from "@mn/contracts";
import { AgentOsKernel, sha256 } from "@mn/kernel";
import { createCodingTask, createRepository, type CodingTask } from "@mn/plugin-coding";
import { inspectRunnerBinary as inspectClaudeRunnerBinary } from "@mn/runner-claude-cli";
import { inspectRunnerBinary as inspectCodexRunnerBinary } from "@mn/runner-codex-cli";
import { SqliteStorage } from "@mn/storage";

import {
  AgentOsWorker,
  createCodingSandboxCleanupWorkerHandler,
  createKernelAgentTurnHandler,
  type ByokModelInvoker,
} from "../src/index.js";

const NOW = "2026-09-04T12:00:00.000Z";
const SANDBOX_AVAILABLE = process.platform === "darwin";

test("Worker 在可恢复候选仓库中显式执行 Claude CLI，且不调用 BYOK 模型", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "completed");
  const polling = fixture.worker.pollOnce();

  const runnerApproval = await waitForApproval(fixture.store, []);
  assert.equal(runnerApproval.effectClass, "external_side_effect");
  assert.match(runnerApproval.intent, /Claude CLI/u);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-runner", runnerApproval.id,
    runnerApproval.streamVersion, "approve_once",
  );

  const candidateApproval = await waitForApproval(fixture.store, [runnerApproval.id]);
  assert.equal(candidateApproval.effectClass, "privileged");
  assert.match(candidateApproval.intent, /候选成果/u);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-candidate", candidateApproval.id,
    candidateApproval.streamVersion, "approve_once",
  );

  assert.deepEqual(await polling, { status: "completed", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    task: transaction.getProjection<CodingTask>("coding.task", "task-1"),
    candidates: transaction.listProjections<any>("coding.candidate"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
    runtime: transaction.getProjection<any>("agent-runtime", "execution-1"),
  }));
  assert.equal(state.execution?.runnerId, "claude-cli");
  assert.equal(state.execution?.status, "completed");
  assert.equal(state.task?.status, "completed");
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].runnerId, "claude-cli");
  assert.match(state.candidates[0].diff, /\+new value/u);
  assert.match(state.candidates[0].diff, /added\.txt/u);
  assert.match(state.candidates[0].diff, /new file mode/u);
  assert.equal(state.run.externalInvocation.status, "settled");
  assert.equal(state.run.externalInvocation.attempt, 1);
  assert.equal(fixture.modelCalls(), 0);
  assert.equal(await readFile(join(fixture.repositoryPath, "message.txt"), "utf8"), "old value\n");
  assert.deepEqual(await readdir(fixture.sandboxRoot), []);
  const runnerRecords = state.runtime.records.filter((record: any) =>
    record.type === "runner/event" || record.type === "runner/diagnostic");
  assert.ok(runnerRecords.length >= 2);
  assert.equal(JSON.stringify(runnerRecords).includes("claude-session-fixture"), false);
});

test("Worker 通过同一生产链显式执行 Codex CLI", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "completed", "codex-cli");
  const polling = fixture.worker.pollOnce();

  const runnerApproval = await waitForApproval(fixture.store, []);
  assert.equal(runnerApproval.effectClass, "external_side_effect");
  assert.match(runnerApproval.intent, /Codex CLI/u);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-codex-runner", runnerApproval.id,
    runnerApproval.streamVersion, "approve_once",
  );
  const candidateApproval = await waitForApproval(fixture.store, [runnerApproval.id]);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-codex-candidate", candidateApproval.id,
    candidateApproval.streamVersion, "approve_once",
  );

  assert.deepEqual(await polling, { status: "completed", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    candidates: transaction.listProjections<any>("coding.candidate"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
    runtime: transaction.getProjection<any>("agent-runtime", "execution-1"),
  }));
  assert.equal(state.execution?.runnerId, "codex-cli");
  assert.equal(state.candidates[0]?.runnerId, "codex-cli");
  assert.match(state.candidates[0]?.diff ?? "", /added\.txt/u);
  assert.equal(state.run.externalInvocation.status, "settled");
  assert.equal(fixture.modelCalls(), 0);
  assert.equal(JSON.stringify(state.runtime.records).includes("codex-session-fixture"), false);
  assert.equal(await readFile(join(fixture.repositoryPath, "message.txt"), "utf8"), "old value\n");
});

test("Runner 获批前原路径被替换时仍只执行 Worker 管理的已验副本", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "completed");
  const polling = fixture.worker.pollOnce();
  const runnerApproval = await waitForApproval(fixture.store, []);
  const marker = `${fixture.binaryPath}.replacement-ran`;
  await writeFile(fixture.binaryPath, [
    "#!/bin/sh",
    `printf 'unsafe\\n' > '${marker}'`,
    "exit 0",
    "",
  ].join("\n"), "utf8");
  await chmod(fixture.binaryPath, 0o755);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-staged-runner", runnerApproval.id,
    runnerApproval.streamVersion, "approve_once",
  );
  const candidateApproval = await waitForApproval(fixture.store, [runnerApproval.id]);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-staged-candidate", candidateApproval.id,
    candidateApproval.streamVersion, "approve_once",
  );

  assert.deepEqual(await polling, { status: "completed", jobId: "job-1" });
  await assert.rejects(() => readFile(marker), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.deepEqual(await readdir(fixture.sandboxRoot), []);
});

test("Runner 没有可确认终态时进入人工核对，Job 不自动重放", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "unknown");
  const polling = fixture.worker.pollOnce();
  const approval = await waitForApproval(fixture.store, []);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-unknown-runner", approval.id,
    approval.streamVersion, "approve_once",
  );

  assert.deepEqual(await polling, { status: "needs_reconciliation", jobId: "job-1" });
  assert.deepEqual(await fixture.worker.pollOnce(), { status: "idle" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
    runtime: transaction.getProjection<any>("agent-runtime", "execution-1"),
  }));
  assert.equal(state.execution?.status, "needs_reconciliation");
  assert.equal(state.execution?.failureCode, "UNKNOWN_EXTERNAL_SIDE_EFFECT");
  assert.equal(state.run.status, "needs_reconciliation");
  assert.equal(state.run.externalInvocation.status, "outcome_unknown");
  assert.equal(
    state.runtime.records.filter((record: any) => record.type === "tool/outcome_unknown").length,
    1,
  );
  assert.equal((await fixture.store.getJob("job-1"))?.status, "failed");
  assert.equal(await readFile(join(fixture.repositoryPath, "message.txt"), "utf8"), "old value\n");
  assert.equal((await readdir(fixture.sandboxRoot)).length, 1);
  assert.equal(
    await readFile(join(state.run.externalInvocation.sandboxPath, "message.txt"), "utf8"),
    "new value\n",
  );
});

test("生产 launcher 遇到 stdin EPIPE 时失败关闭，Worker 不崩溃也不误判完成", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(
    t,
    "stdin_closed",
    "claude-cli",
    3_600_000,
    "native",
    `写入短消息\n${"x".repeat(512 * 1024)}`,
  );
  const polling = fixture.worker.pollOnce();
  const approval = await waitForApproval(fixture.store, []);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-stdin-closed-runner", approval.id,
    approval.streamVersion, "approve_once",
  );

  assert.deepEqual(await polling, { status: "needs_reconciliation", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
  }));
  assert.equal(state.execution?.status, "needs_reconciliation");
  assert.equal(state.run?.status, "needs_reconciliation");
  assert.equal(state.run?.externalInvocation.status, "outcome_unknown");
  assert.notEqual(state.run?.result?.status, "completed");
});

test("Worker 拒绝 npm/shebang 包装器并给出原生 macOS CLI 安装指引", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "completed", "claude-cli", 3_600_000, "shebang");

  assert.deepEqual(await fixture.worker.pollOnce(), { status: "failed", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    approvals: transaction.listProjections<Approval>("approval"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
  }));
  assert.equal(state.execution?.status, "failed");
  assert.equal(state.approvals.length, 0);
  assert.match(
    state.run?.result?.nextStep ?? "",
    /不支持 npm\/shebang 包装器，请安装官方原生 CLI/u,
  );
  assert.deepEqual(await readdir(fixture.sandboxRoot), []);
});

test("Worker 在 claim 后重读工作区并拒绝已停用的外部 Runner 插件", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "completed");
  await fixture.store.transact("local", (transaction) => {
    const workspace = transaction.getProjection<Workspace>("workspace", "workspace-1");
    assert.ok(workspace);
    transaction.putProjection("workspace", workspace.id, {
      ...workspace,
      activePluginIds: ["coding"],
      streamVersion: workspace.streamVersion + 1,
      updatedAt: NOW,
    });
  });

  assert.deepEqual(await fixture.worker.pollOnce(), { status: "failed", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    approvals: transaction.listProjections<Approval>("approval"),
  }));
  assert.equal(state.execution?.status, "failed");
  assert.equal(state.approvals.length, 0);
  assert.deepEqual(await readdir(fixture.sandboxRoot).catch(() => []), []);
});

test("Worker 发现已确认 Runner 的摘要变化时失败关闭，不启动进程", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "completed");
  const versionProbeMarker = `${fixture.binaryPath}.version-probe-ran`;
  await writeFile(fixture.binaryPath, [
    "#!/bin/sh",
    "if [ \"${1:-}\" = \"--version\" ]; then",
    `  printf 'unsafe\\n' > '${versionProbeMarker}'`,
    "  printf 'claude-fixture 2.0.0\\n'",
    "  exit 0",
    "fi",
    "printf 'should not run\\n' > message.txt",
    "",
  ].join("\n"), "utf8");
  await chmod(fixture.binaryPath, 0o755);

  assert.deepEqual(await fixture.worker.pollOnce(), { status: "failed", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    approvals: transaction.listProjections<Approval>("approval"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
  }));
  assert.equal(state.execution?.status, "failed");
  assert.equal(state.approvals.length, 0);
  assert.equal(state.run?.status, "failed");
  assert.match(state.run?.result?.nextStep ?? "", /Runner 二进制已变化，需要重新确认/u);
  assert.equal(state.run?.externalInvocation, undefined);
  assert.equal(await readFile(join(fixture.repositoryPath, "message.txt"), "utf8"), "old value\n");
  await assert.rejects(() => readFile(versionProbeMarker), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("外部 Runner 审批被拒绝时记录已知失败，不进入人工核对", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "completed");
  const polling = fixture.worker.pollOnce();
  const approval = await waitForApproval(fixture.store, []);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "deny-runner", approval.id,
    approval.streamVersion, "deny",
  );

  assert.deepEqual(await polling, { status: "failed", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
  }));
  assert.equal(state.execution?.status, "failed");
  assert.equal(state.run.result.status, "failed");
  assert.equal(state.run.externalInvocation, undefined);
  assert.deepEqual(await readdir(fixture.sandboxRoot), []);
});

test("外部 Runner 超过 Execution 时限后终止进程并保留人工核对证据", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "hang", "claude-cli", 25);
  const polling = fixture.worker.pollOnce();
  const approval = await waitForApproval(fixture.store, []);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-timeout-runner", approval.id,
    approval.streamVersion, "approve_once",
  );

  assert.deepEqual(await polling, { status: "needs_reconciliation", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
  }));
  assert.equal(state.execution?.status, "needs_reconciliation");
  assert.equal(state.run.externalInvocation.status, "outcome_unknown");
  assert.equal((await readdir(fixture.sandboxRoot)).length, 1);
});

test("用户取消外部 Runner 后持久化 Coding cancelled 并清理隔离资源", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "hang");
  const polling = fixture.worker.pollOnce();
  const approval = await waitForApproval(fixture.store, []);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-cancel-runner", approval.id,
    approval.streamVersion, "approve_once",
  );
  await waitForExternalInvocation(fixture.store);
  const running = await fixture.store.transact("local", (transaction) =>
    transaction.getProjection<Execution>("execution", "execution-1"));
  assert.ok(running);
  await fixture.kernel.commandExecution(
    "local",
    "local-owner",
    "cancel-external-runner",
    running.id,
    running.streamVersion,
    "cancel",
  );

  assert.deepEqual(await polling, { status: "cancelled", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    task: transaction.getProjection<CodingTask>("coding.task", "task-1"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
  }));
  assert.equal(state.execution?.status, "cancelled");
  assert.equal(state.task?.status, "cancelled");
  assert.equal(state.run?.status, "cancelled");
  assert.equal(state.run?.externalInvocation.status, "settled");
  assert.deepEqual(await readdir(fixture.sandboxRoot), []);
});

test("候选审批期间取消也会收敛 Coding 投影并关闭审批收件箱", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "completed");
  const polling = fixture.worker.pollOnce();
  const runnerApproval = await waitForApproval(fixture.store, []);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-before-review-cancel", runnerApproval.id,
    runnerApproval.streamVersion, "approve_once",
  );
  const candidateApproval = await waitForApproval(fixture.store, [runnerApproval.id]);
  const waiting = await fixture.store.transact("local", (transaction) =>
    transaction.getProjection<Execution>("execution", "execution-1"));
  assert.ok(waiting);
  await fixture.kernel.commandExecution(
    "local", "local-owner", "cancel-candidate-review", waiting.id,
    waiting.streamVersion, "cancel",
  );

  assert.deepEqual(await polling, { status: "cancelled", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    task: transaction.getProjection<CodingTask>("coding.task", "task-1"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
    approval: transaction.getProjection<Approval>("approval", candidateApproval.id),
    inbox: transaction.getProjection<any>("inbox", `approval:${candidateApproval.id}`),
  }));
  assert.equal(state.task?.status, "cancelled");
  assert.equal(state.run?.status, "cancelled");
  assert.equal(state.approval?.status, "expired");
  assert.equal(state.inbox?.status, "resolved");
  assert.deepEqual(await readdir(fixture.sandboxRoot), []);
});

test("人工核对后由持久化受 fencing 保护的 Job 幂等清理 sandbox", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await externalFixture(t, "unknown");
  const original = fixture.worker.pollOnce();
  const approval = await waitForApproval(fixture.store, []);
  await fixture.kernel.decideApproval(
    "local", "local-owner", "approve-cleanup-fixture", approval.id,
    approval.streamVersion, "approve_once",
  );
  assert.deepEqual(await original, { status: "needs_reconciliation", jobId: "job-1" });
  assert.equal((await readdir(fixture.sandboxRoot)).length, 1);
  await enqueueSandboxCleanup(fixture.store);

  assert.deepEqual(await fixture.worker.pollOnce(), { status: "completed", jobId: "cleanup-job-1" });
  assert.deepEqual(await readdir(fixture.sandboxRoot), []);
  const state = await fixture.store.transact("local", (transaction) => ({
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
    job: transaction.getProjection<Job>("job", "cleanup-job-1"),
  }));
  assert.equal(state.run?.externalInvocation.cleanupStatus, "cleaned");
  assert.equal(state.job?.status, "completed");
  assert.equal((await fixture.store.getJob("cleanup-job-1"))?.status, "completed");
});

async function externalFixture(
  t: test.TestContext,
  terminal: "completed" | "unknown" | "hang" | "stdin_closed",
  runnerId: ExternalCodingRunnerId = "claude-cli",
  maxDurationMs = 3_600_000,
  binaryFormat: "native" | "shebang" = "native",
  taskRequest = "把 message.txt 的 old value 改成 new value",
) {
  const root = await mkdtemp(join(tmpdir(), "muniu-external-runner-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "source");
  const binaryPath = join(root, `${runnerId}-fixture`);
  const sandboxRoot = join(root, "sandboxes");
  await mkdir(repositoryPath);
  await writeFile(join(repositoryPath, "message.txt"), "old value\n", "utf8");
  await runGit(repositoryPath, ["init", "--quiet"]);
  await runGit(repositoryPath, ["add", "message.txt"]);
  await runGit(repositoryPath, [
    "-c", "user.name=Muniu Test",
    "-c", "user.email=test@muniu.invalid",
    "commit", "--quiet", "-m", "fixture",
  ]);
  if (binaryFormat === "native") {
    await compileRunnerBinary(binaryPath, terminal, "new value", runnerId);
  } else {
    await writeFile(binaryPath, "#!/bin/sh\nprintf 'not allowed\\n'\n", "utf8");
    await chmod(binaryPath, 0o755);
  }
  const fixedRepositoryPath = await realpath(repositoryPath);
  const identity = await (runnerId === "claude-cli"
    ? inspectClaudeRunnerBinary(binaryPath)
    : inspectCodexRunnerBinary(binaryPath));
  const store = new SqliteStorage({
    databaseFile: join(root, "state.sqlite"),
    hmacKey: Buffer.alloc(32, 8),
  });
  await store.initialize();
  t.after(async () => store.close());
  await seed(store, fixedRepositoryPath, identity, runnerId, maxDurationMs, taskRequest);

  let modelCalls = 0;
  const modelInvoker: ByokModelInvoker = async () => {
    modelCalls += 1;
    throw new Error("External Runner 不应调用 BYOK 模型");
  };
  let id = 0;
  const kernel = new AgentOsKernel(store, {
    now: () => NOW,
    id: (kind) => `${kind}-external-${++id}`,
  });
  const handler = createKernelAgentTurnHandler({
    store,
    secretStore: { async read() { throw new Error("不应读取 BYOK 密钥"); } },
    modelInvoker,
    approvalKernel: kernel,
    codingSandboxRoot: sandboxRoot,
    approvalPollIntervalMs: 2,
    controlPollIntervalMs: 2,
    now: () => NOW,
  });
  const cleanupHandler = createCodingSandboxCleanupWorkerHandler({
    store,
    sandboxRoot,
    now: () => NOW,
  });
  const worker = new AgentOsWorker({
    id: "worker-external",
    store,
    lock: {
      engineLockDigest: "same",
      expectedEngineLockDigest: "same",
      pluginLockDigest: "same",
      expectedPluginLockDigest: "same",
    },
    handlers: {
      "agent.execution.run": handler,
      "coding.sandbox.cleanup": cleanupHandler,
    },
    tenantId: "local",
    kinds: ["agent.execution.run", "coding.sandbox.cleanup"],
    now: () => new Date(NOW),
  });
  return {
    binaryPath,
    repositoryPath: fixedRepositoryPath,
    sandboxRoot,
    store,
    kernel,
    worker,
    modelCalls: () => modelCalls,
  };
}

async function seed(
  store: SqliteStorage,
  repositoryPath: string,
  identity: CodingRunnerConfigurationV1["identity"],
  runnerId: ExternalCodingRunnerId,
  maxDurationMs: number,
  taskRequest: string,
): Promise<void> {
  const task = createCodingTask({
    id: "task-1",
    workspaceId: "workspace-1",
    repositoryId: "repository-1",
    title: "更新消息",
    request: taskRequest,
    createdAt: NOW,
  });
  const repository = createRepository({
    id: "repository-1",
    workspaceId: "workspace-1",
    name: "source",
    rootRealPath: repositoryPath,
    vcs: "git",
    createdAt: NOW,
  });
  const thread: Thread = {
    id: "thread-1",
    tenantId: "local",
    workspaceId: "workspace-1",
    subject: task.title,
    pluginId: "coding",
    resourceRef: { namespace: "coding.task", resourceId: task.id },
    streamVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const execution: Execution = {
    id: "execution-1",
    tenantId: "local",
    workspaceId: "workspace-1",
    threadId: thread.id,
    pluginId: "coding",
    agentDefinitionId: "coding.builtin",
    runnerId,
    modelBindingId: "model-1",
    initiatedBy: "local-owner",
    executionPrincipalId: "agent:coding",
    generation: 1,
    status: "queued",
    authorityId: "authority-1",
    streamVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const authority: ExecutionAuthority = {
    id: "authority-1",
    tenantId: "local",
    workspaceId: "workspace-1",
    executionId: execution.id,
    principalId: "agent:coding",
    toolIds: [
      "coding.repository.read",
      "coding.sandbox.write",
      "coding.gate.verify",
      "coding.candidate.accept",
      runnerId === "claude-cli" ? "runner.claude.execute" : "runner.codex.execute",
    ],
    dataScopes: [{ namespace: "repository", resourceId: "*" }],
    autoAllowedEffects: ["local_read", "local_reversible_write"],
    budget: {
      maxSubagentDepth: 0,
      maxSubagents: 0,
      maxTokens: 10_000,
      maxCostMinorUnits: "100",
      currency: "CNY",
      maxDurationMs,
    },
    commitment: "external-authority-commitment",
    streamVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const runnerConfiguration: CodingRunnerConfigurationV1 = {
    id: `workspace-1:${runnerId}`,
    tenantId: "local",
    workspaceId: "workspace-1",
    runnerId,
    status: "confirmed",
    identity,
    identityDigest: sha256(identity),
    confirmedBy: "local-owner",
    confirmedAt: NOW,
    streamVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const workspace: Workspace = {
    id: "workspace-1",
    tenantId: "local",
    name: "External Runner Fixture",
    viewMode: "professional",
    activePluginIds: [
      "coding",
      runnerId === "claude-cli" ? "runner-claude-cli" : "runner-codex-cli",
    ],
    streamVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const job = {
    id: "job-1",
    tenantId: "local",
    workspaceId: "workspace-1",
    kind: "agent.execution.run",
    payload: { executionId: execution.id, message: task.request },
    status: "available",
    attempts: 0,
    availableAt: NOW,
    fencingToken: 0,
    idempotencyKey: "execution:execution-1:generation:1",
    streamVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
  await store.transact("local", (transaction) => {
    transaction.putProjection("workspace", workspace.id, workspace);
    transaction.putProjection("thread", thread.id, thread);
    transaction.putProjection("execution", execution.id, execution);
    transaction.putProjection("authority", authority.id, authority);
    transaction.putProjection("coding.task", task.id, { ...task, streamVersion: 0 });
    transaction.putProjection("coding.repository", repository.id, {
      ...repository, streamVersion: 0, updatedAt: NOW,
    });
    transaction.putProjection(CODING_RUNNER_CONFIGURATION_NAMESPACE, runnerConfiguration.id, runnerConfiguration);
    transaction.putProjection("modelConnection", "model-1", {
      id: "model-1",
      tenantId: "local",
      presetId: "deepseek",
      secretRef: "keychain://muniu.v2/model-1",
      defaultModel: "deepseek-chat",
      status: "ready",
    });
    transaction.putProjection("job", job.id, job);
    transaction.putJob({
      id: job.id,
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      kind: job.kind,
      payload: job.payload,
      availableAt: job.availableAt,
      idempotencyKey: job.idempotencyKey,
    });
  });
}

async function waitForApproval(
  store: SqliteStorage,
  excludedIds: readonly string[],
): Promise<Approval> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const approval = await store.transact("local", (transaction) =>
      transaction.listProjections<Approval>("approval")
        .find((item) => item.status === "pending" && !excludedIds.includes(item.id)));
    if (approval) return approval;
    const job = await store.getJob("job-1");
    if (job?.status === "failed") throw new Error(`Job 失败：${JSON.stringify(job.failure)}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("等待 Runner 批准超时");
}

async function waitForExternalInvocation(store: SqliteStorage): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const started = await store.transact("local", (transaction) =>
      transaction.getProjection<any>("coding.execution", "execution-1")
        ?.externalInvocation?.status === "started");
    if (started) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("等待外部 Runner 启动检查点超时");
}

async function enqueueSandboxCleanup(store: SqliteStorage): Promise<void> {
  await store.transact("local", (transaction) => {
    const run = transaction.getProjection<any>("coding.execution", "execution-1");
    assert.ok(run?.externalInvocation);
    const nextRun = {
      ...run,
      externalInvocation: {
        ...run.externalInvocation,
        cleanupStatus: "pending",
        cleanupJobId: "cleanup-job-1",
        updatedAt: NOW,
      },
      streamVersion: run.streamVersion + 1,
      updatedAt: NOW,
    };
    transaction.putProjection("coding.execution", "execution-1", nextRun);
    transaction.appendEvent({
      tenantId: "local",
      aggregateType: "coding.execution",
      aggregateId: "execution-1",
      expectedStreamVersion: run.streamVersion,
      type: "coding.reconciliation_decided",
      actorId: "local-owner",
      executionId: "execution-1",
      generation: 1,
      correlationId: "coding:execution-1:cleanup",
      publicPayload: { workspaceId: "workspace-1", cleanupJobId: "cleanup-job-1" },
    });
    const job: Job = {
      id: "cleanup-job-1",
      tenantId: "local",
      workspaceId: "workspace-1",
      kind: "coding.sandbox.cleanup",
      payload: { reconciliationExecutionId: "execution-1" },
      status: "available",
      attempts: 0,
      availableAt: NOW,
      fencingToken: 0,
      idempotencyKey: "coding:execution-1:cleanup",
      streamVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    transaction.putProjection("job", job.id, job);
    transaction.appendEvent({
      tenantId: "local",
      aggregateType: "job",
      aggregateId: job.id,
      expectedStreamVersion: 0,
      type: "job.available",
      actorId: "local-owner",
      executionId: "execution-1",
      generation: 1,
      correlationId: "coding:execution-1:cleanup",
      publicPayload: { workspaceId: "workspace-1", kind: job.kind },
    });
    transaction.putJob({
      id: job.id,
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      kind: job.kind,
      payload: job.payload,
      availableAt: job.availableAt,
      idempotencyKey: job.idempotencyKey,
    });
  });
}

async function compileRunnerBinary(
  binaryPath: string,
  terminal: "completed" | "unknown" | "hang" | "stdin_closed",
  value: string,
  runnerId: ExternalCodingRunnerId = "claude-cli",
): Promise<void> {
  const version = runnerId === "claude-cli" ? "claude-fixture 1.0.0" : "codex-fixture 1.0.0";
  const session = runnerId === "claude-cli"
    ? '{"type":"system","subtype":"init","session_id":"claude-session-fixture"}'
    : '{"type":"thread.started","thread_id":"codex-session-fixture"}';
  const result = runnerId === "claude-cli"
    ? terminal === "completed" || terminal === "stdin_closed"
      ? '{"type":"result","is_error":false}'
      : '{"type":"assistant","message":"done without terminal"}'
    : terminal === "completed"
      ? '{"type":"turn.completed"}'
      : '{"type":"item.completed","item":{"type":"agent_message"}}';
  const sourcePath = `${binaryPath}.c`;
  await writeFile(sourcePath, [
    "#include <stdio.h>",
    "#include <string.h>",
    "#include <unistd.h>",
    "int main(int argc, char **argv) {",
    `  if (argc > 1 && strcmp(argv[1], "--version") == 0) { fputs(${JSON.stringify(`${version}\n`)}, stdout); return 0; }`,
    terminal === "stdin_closed" ? "  close(STDIN_FILENO); usleep(200000);" : "",
    `  FILE *message = fopen("message.txt", "w"); if (!message) return 2; fputs(${JSON.stringify(`${value}\n`)}, message); fclose(message);`,
    "  FILE *added = fopen(\"added.txt\", \"w\"); if (!added) return 3; fputs(\"created by runner\\n\", added); fclose(added);",
    `  fputs(${JSON.stringify(`${session}\n`)}, stdout); fflush(stdout);`,
    terminal === "hang"
      ? "  sleep(60);"
      : `  fputs(${JSON.stringify(`${result}\n`)}, stdout);`,
    "  return 0;",
    "}",
    "",
  ].join("\n"), "utf8");
  await new Promise<void>((resolveCommand, rejectCommand) => {
    execFile("/usr/bin/clang", [sourcePath, "-o", binaryPath], (error) => {
      if (error) rejectCommand(error);
      else resolveCommand();
    });
  });
}

function runGit(cwd: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile("/usr/bin/git", [...arguments_], { cwd }, (error) => {
      if (error) rejectCommand(error);
      else resolveCommand();
    });
  });
}
