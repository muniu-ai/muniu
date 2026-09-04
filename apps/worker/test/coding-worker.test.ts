// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Approval,
  Deliverable,
  Execution,
  ExecutionAuthority,
  Thread,
} from "@mn/contracts";
import { AgentOsKernel, type InboxItem } from "@mn/kernel";
import { createCodingTask, createRepository, type CodingTask } from "@mn/plugin-coding";
import { SqliteStorage } from "@mn/storage";

import {
  AgentOsWorker,
  createKernelAgentTurnHandler,
  type ByokModelInvoker,
} from "../src/index.js";

const NOW = "2026-09-04T00:00:00.000Z";
const SANDBOX_AVAILABLE = process.platform === "darwin";

test("真实 Worker 通过受控仓库、macOS sandbox 和 Gate 持久化 Coding 成果", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await codingFixture(t, [passingPatch()]);
  const polling = fixture.worker.pollOnce();
  const approval = await waitForApproval(fixture.store);
  assert.equal(approval.effectClass, "privileged");
  assert.match(approval.intent, /候选成果/u);
  await fixture.kernel.decideApproval(
    "local",
    "local-owner",
    "approve-candidate",
    approval.id,
    approval.streamVersion,
    "approve_once",
  );

  assert.deepEqual(await polling, { status: "completed", jobId: "job-1" });
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    task: transaction.getProjection<CodingTask>("coding.task", "task-1"),
    candidates: transaction.listProjections<any>("coding.candidate"),
    gates: transaction.listProjections<any>("coding.gate-result"),
    evidence: transaction.listProjections<any>("coding.code-evidence"),
    deliverables: transaction.listProjections<Deliverable>("deliverable"),
  }));
  assert.equal(state.execution?.status, "completed");
  assert.equal(state.task?.status, "completed");
  assert.equal(state.task?.stage, "learn");
  assert.equal(state.candidates.length, 1);
  assert.match(state.candidates[0].diff, /\+new value/u);
  assert.equal("sandboxPath" in state.candidates[0], false);
  assert.equal(state.candidates[0].sandbox.enforced, true);
  assert.equal(state.gates[0].status, "passed");
  assert.equal(state.gates[0].authoritative, true);
  assert.equal(state.evidence.length, 1);
  assert.equal(state.deliverables.length, 1);
  assert.equal(state.deliverables[0]?.executionId, "execution-1");
  assert.equal((await fixture.store.getJob("job-1"))?.status, "completed");
  assert.equal(fixture.modelCalls(), 1);
  assert.deepEqual(await readdir(fixture.sandboxRoot), []);
  const codingEvents = (await fixture.store.readEvents("local", { afterPosition: 0, limit: 200 }))
    .events.filter((event) => event.aggregateType === "coding.task");
  assert.deepEqual(codingEvents.map((event) => event.type), [
    "coding.candidate_recorded",
    "coding.gate_result_recorded",
    "coding.code_evidence_recorded",
    "coding.execution_waiting_approval",
    "coding.candidate_approved",
  ]);
});

test("真实 Worker 在 Gate 连续失败后最多修复三次并进入人工决定终态", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await codingFixture(t, Array.from({ length: 4 }, () => failingPatch()));
  assert.deepEqual(await fixture.worker.pollOnce(), { status: "completed", jobId: "job-1" });

  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    task: transaction.getProjection<CodingTask>("coding.task", "task-1"),
    candidates: transaction.listProjections<any>("coding.candidate"),
    gates: transaction.listProjections<any>("coding.gate-result"),
    evidence: transaction.listProjections<any>("coding.code-evidence"),
    deliverables: transaction.listProjections<Deliverable>("deliverable"),
    inbox: transaction.listProjections<InboxItem>("inbox"),
  }));
  assert.equal(fixture.modelCalls(), 4, "首次候选加三次修复后必须停止");
  assert.equal(state.execution?.status, "completed");
  assert.equal(state.task?.status, "needs_human_decision");
  assert.equal(state.candidates.length, 4);
  assert.equal(state.gates.length, 4);
  assert.ok(state.gates.every((gate) => gate.status === "failed"));
  assert.equal(state.evidence.length, 0);
  assert.equal(state.deliverables.length, 0);
  assert.equal(state.inbox.filter((item) => item.id === "coding-review:execution-1").length, 1);
  assert.equal((await fixture.store.getJob("job-1"))?.status, "completed");
});

test("审批等待期间重复处理同一 Job 从持久检查点恢复且不重放模型与 Gate", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await codingFixture(t, [passingPatch()]);
  const claimed = await fixture.store.claimJob("worker-recovery", NOW, {
    tenantId: "local",
    kinds: ["agent.execution.run"],
  });
  assert.ok(claimed);
  const context = {
    workerId: "worker-recovery",
    fencingToken: claimed.fencingToken,
    leaseExpiresAt: claimed.leaseExpiresAt!,
    signal: new AbortController().signal,
  };
  const first = fixture.handler(claimed, context);
  const approval = await waitForApproval(fixture.store);
  const recovered = fixture.handler(claimed, context);
  await fixture.kernel.decideApproval(
    "local",
    "local-owner",
    "approve-after-recovery",
    approval.id,
    approval.streamVersion,
    "approve_once",
  );
  assert.deepEqual(await first, { executionId: "execution-1", status: "completed" });
  assert.deepEqual(await recovered, { executionId: "execution-1", status: "completed" });
  await fixture.store.completeJob(
    claimed.id,
    "worker-recovery",
    claimed.fencingToken,
    { executionId: "execution-1", status: "completed" },
    NOW,
  );

  const persisted = await fixture.store.transact("local", (transaction) => ({
    deliverables: transaction.listProjections<Deliverable>("deliverable"),
    candidates: transaction.listProjections<any>("coding.candidate"),
  }));
  assert.equal(fixture.modelCalls(), 1);
  assert.equal(persisted.candidates.length, 1);
  assert.equal(persisted.deliverables.length, 1);
  assert.equal((await fixture.store.getJob("job-1"))?.status, "completed");
});

async function codingFixture(
  t: test.TestContext,
  patches: readonly { readonly patch: string; readonly summary: string }[],
) {
  const root = await mkdtemp(join(tmpdir(), "muniu-coding-worker-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "source");
  await mkdir(repositoryPath);
  await writeFile(join(repositoryPath, "message.txt"), "old value\n", "utf8");
  await runGit(repositoryPath, ["init", "--quiet"]);
  await runGit(repositoryPath, ["add", "message.txt"]);
  await runGit(repositoryPath, [
    "-c", "user.name=Muniu Test",
    "-c", "user.email=test@muniu.invalid",
    "commit", "--quiet", "-m", "fixture",
  ]);
  const fixedRepositoryPath = await realpath(repositoryPath);
  const store = new SqliteStorage({
    databaseFile: join(root, "state.sqlite"),
    hmacKey: Buffer.alloc(32, 7),
  });
  await store.initialize();
  t.after(async () => store.close());
  await seed(store, fixedRepositoryPath);

  let calls = 0;
  const modelInvoker: ByokModelInvoker = async (input) => {
    const item = patches[calls++];
    assert.ok(item, "模型调用次数超过测试候选数");
    assert.deepEqual(input.request.availableToolIds, ["coding.sandbox.write"]);
    return {
      text: item.summary,
      toolCalls: [{
        id: `model-call-${calls}`,
        toolId: "coding.sandbox.write",
        arguments: { patch: item.patch, summary: item.summary },
      }],
    };
  };
  let idSequence = 0;
  const kernel = new AgentOsKernel(store, {
    now: () => NOW,
    id: (kind) => `${kind}-${++idSequence}`,
  });
  const handler = createKernelAgentTurnHandler({
    store,
    secretStore: { async read() { return "fixture-api-key"; } },
    modelInvoker,
    approvalKernel: kernel,
    codingSandboxRoot: join(root, "sandboxes"),
    approvalPollIntervalMs: 2,
    now: () => NOW,
  });
  const worker = new AgentOsWorker({
    id: "worker-1",
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
    store,
    kernel,
    handler,
    worker,
    sandboxRoot: join(root, "sandboxes"),
    modelCalls: () => calls,
  };
}

async function seed(store: SqliteStorage, repositoryPath: string): Promise<void> {
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
    ],
    dataScopes: [{ namespace: "repository", resourceId: "*" }],
    autoAllowedEffects: ["local_read", "local_reversible_write"],
    budget: {
      maxSubagentDepth: 0,
      maxSubagents: 0,
      maxTokens: 10_000,
      maxCostMinorUnits: "100",
      currency: "CNY",
      maxDurationMs: 3_600_000,
    },
    commitment: "coding-authority-commitment",
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
      ...repository,
      streamVersion: 0,
      updatedAt: NOW,
    });
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

async function waitForApproval(store: SqliteStorage): Promise<Approval> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const approval = await store.transact("local", (transaction) =>
      transaction.listProjections<Approval>("approval").find((item) => item.status === "pending"));
    if (approval) return approval;
    const job = await store.getJob("job-1");
    if (job?.status === "failed") {
      throw new Error(`Coding Job 在审批前失败：${JSON.stringify(job.failure)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("等待 Coding 审批超时");
}

function passingPatch() {
  return {
    summary: "更新消息内容",
    patch: [
      "diff --git a/message.txt b/message.txt",
      "--- a/message.txt",
      "+++ b/message.txt",
      "@@ -1 +1 @@",
      "-old value",
      "+new value",
      "",
    ].join("\n"),
  };
}

function failingPatch() {
  return {
    summary: "产生带尾随空格的候选",
    patch: [
      "diff --git a/message.txt b/message.txt",
      "--- a/message.txt",
      "+++ b/message.txt",
      "@@ -1 +1 @@",
      "-old value",
      "+new value ",
      "",
    ].join("\n"),
  };
}

function runGit(cwd: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile("/usr/bin/git", [...arguments_], { cwd }, (error) => {
      if (error) rejectCommand(error);
      else resolveCommand();
    });
  });
}
