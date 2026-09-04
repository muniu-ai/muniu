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
  Thread,
} from "@mn/contracts";
import { CODING_RUNNER_CONFIGURATION_NAMESPACE } from "@mn/contracts";
import { AgentOsKernel, sha256 } from "@mn/kernel";
import { createCodingTask, createRepository, type CodingTask } from "@mn/plugin-coding";
import { inspectRunnerBinary as inspectClaudeRunnerBinary } from "@mn/runner-claude-cli";
import { inspectRunnerBinary as inspectCodexRunnerBinary } from "@mn/runner-codex-cli";
import { SqliteStorage } from "@mn/storage";

import {
  AgentOsWorker,
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
  assert.equal(state.run, undefined);
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

async function externalFixture(
  t: test.TestContext,
  terminal: "completed" | "unknown" | "hang",
  runnerId: ExternalCodingRunnerId = "claude-cli",
  maxDurationMs = 3_600_000,
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
  await writeFile(binaryPath, runnerScript(terminal, "new value", runnerId), "utf8");
  await chmod(binaryPath, 0o755);
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
  await seed(store, fixedRepositoryPath, identity, runnerId, maxDurationMs);

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
    handlers: { "agent.execution.run": handler },
    tenantId: "local",
    kinds: ["agent.execution.run"],
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
): Promise<void> {
  const task = createCodingTask({
    id: "task-1",
    workspaceId: "workspace-1",
    repositoryId: "repository-1",
    title: "更新消息",
    request: "把 message.txt 的 old value 改成 new value",
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

function runnerScript(
  terminal: "completed" | "unknown" | "hang",
  value: string,
  runnerId: ExternalCodingRunnerId = "claude-cli",
): string {
  const version = runnerId === "claude-cli" ? "claude-fixture 1.0.0" : "codex-fixture 1.0.0";
  const session = runnerId === "claude-cli"
    ? '{"type":"system","subtype":"init","session_id":"claude-session-fixture"}'
    : '{"type":"thread.started","thread_id":"codex-session-fixture"}';
  const result = runnerId === "claude-cli"
    ? terminal === "completed"
      ? '{"type":"result","is_error":false}'
      : '{"type":"assistant","message":"done without terminal"}'
    : terminal === "completed"
      ? '{"type":"turn.completed"}'
      : '{"type":"item.completed","item":{"type":"agent_message"}}';
  return [
    "#!/bin/sh",
    "if [ \"${1:-}\" = \"--version\" ]; then",
    `  printf '${version}\\n'`,
    "  exit 0",
    "fi",
    `printf '${value}\\n' > message.txt`,
    "printf 'created by runner\\n' > added.txt",
    `printf '%s\\n' '${session}'`,
    ...(terminal === "hang"
      ? ["sleep 60"]
      : [`printf '%s\\n' '${result}'`]),
    "",
  ].join("\n");
}

function runGit(cwd: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile("/usr/bin/git", [...arguments_], { cwd }, (error) => {
      if (error) rejectCommand(error);
      else resolveCommand();
    });
  });
}
