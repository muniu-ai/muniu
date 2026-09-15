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
import { AgentOsKernel, type InboxItem, type KernelTransaction } from "@mn/kernel";
import { createCodingTask, createRepository, type CodingTask, type Spec, type GovernanceSnapshot, type HarnessSnapshot } from "@mn/plugin-coding";
import { SqliteStorage } from "@mn/storage";
import { KernelProjectionRuntimeStore, PersistentInbox } from "@mn/agent-runtime";

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
  const fixture = await codingFixture(t, [passingPatch()], { inputMessage: "只修改文案，不要新增文件" });
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
    specs: transaction.listProjections<Spec>("coding.spec"),
    governance: transaction.listProjections<GovernanceSnapshot>("coding.governance"),
    harness: transaction.listProjections<HarnessSnapshot>("coding.harness"),
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
  assert.equal(state.specs.length, 1);
  assert.match(state.specs[0]!.body, /只修改文案，不要新增文件/u);
  assert.equal(state.evidence[0].specDigest, state.specs[0]!.digest);
  assert.equal(state.evidence[0].governanceDigest, state.governance[0]!.digest);
  assert.equal(state.evidence[0].harnessDigest, state.harness[0]!.digest);
  assert.equal(state.deliverables.length, 1);
  assert.equal(state.deliverables[0]?.executionId, "execution-1");
  assert.equal((await fixture.store.getJob("job-1"))?.status, "completed");
  assert.equal(fixture.modelCalls(), 1);
  const runtime = new KernelProjectionRuntimeStore({ tenantId: "local", store: fixture.store });
  assert.equal((await runtime.readExecution("execution-1")).filter(record => record.type === "job/started").length, 1);
  assert.deepEqual(await readdir(fixture.sandboxRoot), []);
  const codingEvents = (await fixture.store.readEvents("local", { afterPosition: 0, limit: 200 }))
    .events.filter((event) => event.aggregateType === "coding.task");
  assert.deepEqual(codingEvents.map((event) => event.type), [
    "coding.candidate_recorded",
    "coding.gate_result_recorded",
    "coding.code_evidence_recorded",
    "coding.execution_waiting_approval",
    "coding.candidate_approved",
    "coding.task_settled",
  ]);
});

test("Coding 在同一个 AgentHandle 中按 FIFO 消费后续输入并保留各轮成果", { skip: !SANDBOX_AVAILABLE }, async t => {
  const fixture = await codingFixture(t, [passingPatch(), passingPatch()]);
  const runtime = new KernelProjectionRuntimeStore({ tenantId: "local", store: fixture.store });
  await new PersistentInbox(runtime, "execution-1").enqueue("follow_up", "再检查一次文案");
  const polling = fixture.worker.pollOnce();
  for (let turn = 1; turn <= 2; turn += 1) {
    const approval = await waitForApproval(fixture.store);
    await fixture.kernel.decideApproval("local", "local-owner", `approve-turn-${turn}`, approval.id, approval.streamVersion, "approve_once");
  }
  assert.deepEqual(await polling, { status: "completed", jobId: "job-1" });
  assert.equal(fixture.modelCalls(), 2);
  const records = await runtime.readExecution("execution-1");
  assert.deepEqual(records.filter(record => record.type === "turn/started").map(record => record.payload.turn), [1, 2]);
  assert.deepEqual(records.filter(record => record.type === "session/entry" && record.payload.role === "user").map(record => record.payload.content),
    ["把 message.txt 的 old value 改成 new value", "再检查一次文案"]);
  assert.equal((await fixture.store.transact("local", tx => tx.listProjections<Deliverable>("deliverable"))).length, 2);
  const specs = await fixture.store.transact("local", tx => tx.listProjections<Spec>("coding.spec"));
  assert.deepEqual(specs.map(spec => spec.revision), [1, 2]);
  assert.equal(specs[1]!.supersedesSpecId, specs[0]!.id);
  assert.equal(specs[0]!.body, "把 message.txt 的 old value 改成 new value");
  assert.equal(specs[1]!.body, "再检查一次文案");
});

test("Coding 结果与 Job 原子终结，不给普通取消留下矛盾窗口", {
  skip: !SANDBOX_AVAILABLE,
}, async (t) => {
  const fixture = await codingFixture(t, [passingPatch()], { cancelAfterCodingCompletion: true });
  const polling = fixture.worker.pollOnce();
  const approval = await waitForApproval(fixture.store);
  await fixture.kernel.decideApproval(
    "local",
    "local-owner",
    "approve-before-cancel-race",
    approval.id,
    approval.streamVersion,
    "approve_once",
  );

  assert.deepEqual(await polling, { status: "completed", jobId: "job-1" });
  assert.equal(fixture.cancelAttempts(), 1);
  assert.equal(fixture.cancelAccepted(), false);
  const state = await fixture.store.transact("local", (transaction) => ({
    execution: transaction.getProjection<Execution>("execution", "execution-1"),
    task: transaction.getProjection<CodingTask>("coding.task", "task-1"),
    run: transaction.getProjection<any>("coding.execution", "execution-1"),
  }));
  assert.equal(state.execution?.status, "completed");
  assert.equal(state.task?.status, "completed");
  assert.equal(state.run?.status, "completed");
  assert.equal((await fixture.store.getJob("job-1"))?.status, "completed");
});

test("Coding 多轮共用三次修复预算，耗尽后不继续调用模型", { skip: !SANDBOX_AVAILABLE }, async t => {
  const fixture = await codingFixture(t, [failingPatch(), failingPatch(), passingPatch(), ...Array.from({ length: 4 }, () => failingPatch())]);
  const runtime = new KernelProjectionRuntimeStore({ tenantId: "local", store: fixture.store });
  await new PersistentInbox(runtime, "execution-1").enqueue("follow_up", "继续核对");
  const pending = fixture.worker.pollOnce();
  const approval = await waitForApproval(fixture.store, 5_000);
  await fixture.kernel.decideApproval("local", "local-owner", "approve-before-budget", approval.id, approval.streamVersion, "approve_once");
  assert.deepEqual(await pending, { status: "completed", jobId: "job-1" });
  assert.equal(fixture.modelCalls(), 5);
  assert.equal((await fixture.store.transact("local", tx => tx.getProjection<Execution>("execution", "execution-1")))?.status, "paused");
  assert.equal((await runtime.readExecution("execution-1")).filter(record => record.type === "budget/reserved").length, 3);
});

test("模型用量未知时暂停 Coding 执行和任务，保留预留且不重试", { skip: !SANDBOX_AVAILABLE }, async t => {
  const fixture = await codingFixture(t, []);
  assert.deepEqual(await fixture.worker.pollOnce(), { status: "completed", jobId: "job-1" });
  const state = await fixture.store.transact("local", tx => ({ run: tx.getProjection<{ status: string }>("coding.execution", "execution-1"),
    task: tx.getProjection<CodingTask>("coding.task", "task-1"), execution: tx.getProjection<Execution>("execution", "execution-1") }));
  assert.equal(state.execution?.status, "paused");
  assert.equal(state.task?.status, "needs_human_decision");
  assert.equal(state.run?.status, "needs_human_decision");
  const records = await new KernelProjectionRuntimeStore({ tenantId: "local", store: fixture.store }).readExecution("execution-1");
  assert.equal(records.filter(record => record.type === "model/reserved").length, 1);
  assert.equal(records.filter(record => record.type === "model/settled").length, 0);
  assert.equal(fixture.modelCalls(), 1);
});

test("模型已结算但未提交规定工具调用时失败关闭，不留下运行中的 Coding 投影", { skip: !SANDBOX_AVAILABLE }, async t => {
  const fixture = await codingFixture(t, [passingPatch()], { invalidModelResponse: true });
  assert.deepEqual(await fixture.worker.pollOnce(), { status: "failed", jobId: "job-1" });
  const state = await fixture.store.transact("local", tx => ({ run: tx.getProjection<{ status: string }>("coding.execution", "execution-1"),
    task: tx.getProjection<CodingTask>("coding.task", "task-1"), execution: tx.getProjection<Execution>("execution", "execution-1") }));
  assert.equal(state.execution?.status, "failed");
  assert.equal(state.task?.status, "failed");
  assert.equal(state.run?.status, "failed");
});

test("恢复前时间预算已耗尽时不启动模型，并将 CodingTask 置为人工决定", { skip: !SANDBOX_AVAILABLE }, async t => {
  const fixture = await codingFixture(t, []);
  await fixture.store.transact("local", tx => {
    tx.putProjection("coding.execution", "execution-1", { executionId: "execution-1", taskId: "task-1", workspaceId: "workspace-1",
      status: "running", streamVersion: 1, createdAt: NOW, updatedAt: NOW });
    tx.appendEvent({ tenantId: "local", aggregateType: "coding.execution", aggregateId: "execution-1", expectedStreamVersion: 0,
      type: "coding.execution_started", executionId: "execution-1", actorId: "agent", generation: 1, correlationId: "prepared-before-crash", publicPayload: {} });
  });
  const runtime = new KernelProjectionRuntimeStore({ tenantId: "local", store: fixture.store });
  await runtime.append({ executionId: "execution-1", type: "budget/started",
    payload: { startedAtMs: Date.parse(NOW) - 3_600_001, maxDurationMs: 3_600_000 } });
  assert.deepEqual(await fixture.worker.pollOnce(), { status: "completed", jobId: "job-1" });
  assert.equal(fixture.modelCalls(), 0);
  assert.equal((await fixture.store.transact("local", tx => tx.getProjection<Execution>("execution", "execution-1")))?.status, "paused");
  assert.equal((await fixture.store.transact("local", tx => tx.getProjection<CodingTask>("coding.task", "task-1")))?.status, "needs_human_decision");
  assert.equal((await fixture.store.transact("local", tx => tx.getProjection<{ status: string }>("coding.execution", "execution-1")))?.status, "needs_human_decision");
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
  assert.equal(state.execution?.status, "paused");
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
  const records = await new KernelProjectionRuntimeStore({ tenantId: "local", store: fixture.store }).readExecution("execution-1");
  const acceptance = records.filter(record => record.type === "tool/intent" && record.payload.toolId === "coding.candidate.accept");
  assert.equal(acceptance.length, 1, "重复恢复不能复制同一审批意图");
  assert.equal(records.filter(record => record.type === "tool/result" && record.payload.toolCallId === acceptance[0]!.payload.toolCallId).length, 1);
  assert.equal((await fixture.store.getJob("job-1"))?.status, "completed");
});

async function codingFixture(
  t: test.TestContext,
  patches: readonly { readonly patch: string; readonly summary: string }[],
  options: { readonly cancelAfterCodingCompletion?: boolean; readonly inputMessage?: string; readonly invalidModelResponse?: boolean } = {},
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
  await seed(store, fixedRepositoryPath, options.inputMessage);

  let calls = 0;
  const modelInvoker: ByokModelInvoker = async (input) => {
    const item = patches[calls++];
    assert.ok(item, "模型调用次数超过测试候选数");
    assert.deepEqual(input.request.availableToolIds, ["coding.sandbox.write"]);
    if (options.inputMessage) assert.ok(input.request.messages.some(message =>
      message.role === "user" && message.content === options.inputMessage), "Coding 模型必须收到本轮输入");
    return {
      text: item.summary,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 },
      toolCalls: options.invalidModelResponse ? [] : [{
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
  let cancelAttemptCount = 0;
  let cancellationAccepted = false;
  const workerStore = options.cancelAfterCodingCompletion
    ? interceptCodingCompletion(store, async () => {
        cancelAttemptCount += 1;
        const execution = await store.transact("local", (transaction) =>
          transaction.getProjection<Execution>("execution", "execution-1"));
        assert.ok(execution);
        try {
          await kernel.commandExecution(
            "local",
            "local-owner",
            `cancel-after-coding-result-${cancelAttemptCount}`,
            execution.id,
            execution.streamVersion,
            "cancel",
          );
          cancellationAccepted = true;
        } catch {
          cancellationAccepted = false;
        }
      })
    : store;
  const handler = createKernelAgentTurnHandler({
    store: workerStore,
    secretStore: { async read() { return "fixture-api-key"; } },
    modelInvoker,
    modelQuoter: async () => ({ inputTokenLimit: 100, maxOutputTokens: 100,
      rates: { id: "non-billable-fixture", currency: "CNY", inputNanoMinorUnitsPerToken: "0",
        cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } }),
    approvalKernel: kernel,
    codingSandboxRoot: join(root, "sandboxes"),
    approvalPollIntervalMs: 2,
    now: () => NOW,
  });
  const worker = new AgentOsWorker({
    id: "worker-1",
    store: workerStore,
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
    cancelAttempts: () => cancelAttemptCount,
    cancelAccepted: () => cancellationAccepted,
  };
}

function interceptCodingCompletion(
  store: SqliteStorage,
  afterCommit: () => Promise<void>,
): SqliteStorage {
  const transact: SqliteStorage["transact"] = async (tenantId, work) => {
    let completed = false;
    const result = await store.transact(tenantId, (transaction) => work({
      ...transaction,
      putProjection<Value>(namespace: string, id: string, value: Value) {
        transaction.putProjection(namespace, id, value);
        if (namespace === "coding.execution"
          && typeof value === "object" && value !== null
          && (value as { readonly status?: unknown }).status === "completed") {
          completed = true;
        }
      },
    } satisfies KernelTransaction));
    if (completed) await afterCommit();
    return result;
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === "transact") return transact;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seed(store: SqliteStorage, repositoryPath: string, inputMessage?: string): Promise<void> {
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
    payload: { executionId: execution.id, message: inputMessage ?? task.request },
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

async function waitForApproval(store: SqliteStorage, timeoutMs = 5_000): Promise<Approval> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
