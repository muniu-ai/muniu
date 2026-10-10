// SPDX-License-Identifier: Apache-2.0
import { validateBusinessContextSource } from "../src/business-context.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendKernelEvent, recordToolAdmission } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { createAgentOsHost } from "../src/host.js";
import type { Thread, Execution, Approval } from "@mn/contracts";
import { AgentOsWorker, createKernelAgentTurnHandler, type ByokModelInvoker } from "@mn/worker";
import { GOAL_NAMESPACE } from "../src/goals.js";
import { assertGoalExecutionResources } from "../src/goal-runtime.js";
import { captureOpportunity, captureCodingRepository, captureCodingTask } from "../src/product-state.js";
import { createOpcModelContextReader } from "../src/opc-model-context.js";
import { confirmCodingRunner } from "../src/coding-runners.js";

const runnerInspection = { requestedPath: "/opt/fixture/codex", realPath: "/opt/fixture/codex", sha256: "b".repeat(64), device: "1", inode: "2", byteLength: 100, modifiedAtMs: 100 };

async function fixture(t: test.TestContext, goalPollIntervalMs = 60_000, sandboxAvailable = false) {
  const root = await mkdtemp(join(tmpdir(), "mn-goal-host-"));
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 71));
  const store = new SqliteStorage({ databaseFile: join(root, "state.sqlite"), hmacKey: Buffer.alloc(32, 72) });
  const secretStore = { async save() { return "keychain://muniu.v2/goal-fixture"; }, async read() { return "fixture"; } };
  const allocated: string[] = [];
  const host = await createAgentOsHost({ id: kind => { allocated.push(kind); return `${kind}-${randomUUID()}`; }, goalPollIntervalMs, store, cas, protectedPayloadKeyProvider: keyProvider, secretStore, runnerIdentityInspector: { async inspect() { return runnerInspection; } }, ...(sandboxAvailable ? { agentRuntimeReadiness: async () => ({ worker: "available" as const, sandbox: "available" as const, runnerSupervisor: "available" as const }) } : {}) });
  t.after(async () => { await host.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace("local", "local-owner", randomUUID(), { name: "目标验收", viewMode: "business", pluginIds: ["opc", "coding", "runner-codex-cli"] });
  const opportunity = await captureOpportunity({ store, tenantId: "local", workspaceId: workspace.id, actorId: "local-owner", now: () => new Date().toISOString(), id: kind => `${kind}-${randomUUID()}`, idempotencyKey: "opportunity", expectedStreamVersion: 0, input: "为独立开发者整理需求验证问题" });
  const thread = (await store.transact("local", tx => tx.listProjections<Thread>("thread").find(item => item.resourceRef?.resourceId === opportunity.id)))!;
  const model = await host.kernel.saveModelConnection("local", "local-owner", randomUUID(), { presetId: "deepseek", displayName: "测试连接", secretRef: "keychain://muniu.v2/goal-fixture", defaultModel: "deepseek-v4-flash", discoveredModels: ["deepseek-v4-flash"] });
  await store.transact("local", tx => { tx.putProjection("modelConnection", model.id, { ...model, status: "ready", streamVersion: 2 }); appendKernelEvent(tx, { tenantId: "local", aggregateType: "modelConnection", aggregateId: model.id, expectedStreamVersion: 1, type: "fixture.model_ready", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} }); });
  const send = async (path: string, body?: unknown, key: string = randomUUID()) => {
    const response = await host.dispatch(new Request(`http://fixture${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as any };
  };
  const create = () => send(`/v2/workspaces/${workspace.id}/goals`, { threadId: thread.id, objective: "整理现有机会资料中的待验证问题", resourceRefs: [], budget: { maxTokens: 1000, maxCostMinorUnits: "50", currency: "CNY", maxDurationMs: 60_000 }, deliverables: [{ key: "report", title: "机会分析", required: true, criteria: [{ id: "sources", description: "说明证据及仍待验证的问题" }] }] });
  return { root, host, store, allocated, cas, keyProvider, secretStore, workspace, thread, model, opportunity, send, create };
}

test("经营目标可固定 CLI 身份并启动，不要求借用木牛模型；重试不重新调度", async t => {
  const f = await fixture(t);
  await f.store.transact("local", transaction => confirmCodingRunner({ transaction, tenantId: "local", workspaceId: f.workspace.id, actorId: "local-owner", runnerId: "codex-cli", expectedStreamVersion: 0, expectedVersion: "fixture", expectedSha256: runnerInspection.sha256, inspection: runnerInspection, occurredAt: new Date().toISOString(), correlationId: randomUUID() }));
  const created = await f.create(), path = `/v2/goals/${created.body.data.goal.id}`;
  const input = { workspaceId: f.workspace.id, expectedStreamVersion: 1, scheduling: { runnerId: "codex-cli", strategy: "quality" } };
  const planned = await f.send(`${path}/plan-revisions`, input, "cli-plan");
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.equal(planned.body.data.plan.runnerId, "codex-cli");
  assert.equal(planned.body.data.plan.modelBindingId, "runner:codex-cli");
  assert.ok(planned.body.data.plan.runnerBinding.identityDigest);
  assert.deepEqual(planned.body.data.plan.toolIds, ["runner.codex.execute"]);
  const started = await f.send(`${path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: 2, command: "start", planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual((await f.send(`${path}/plan-revisions`, input, "cli-plan")).body.data, planned.body.data);
  const usage = { workspaceId: f.workspace.id, expectedStreamVersion: started.body.data.goal.streamVersion, command: "record_external_usage", usage: { tokens: 20, costMinorUnits: "12", currency: "CNY" }, source: "CLI 账单条目 fixture-1" };
  assert.ok((await f.send(`${path}/commands`, usage)).status >= 400, "运行中不能核销用量");
  await f.store.transact("local", tx => {
    const execution = tx.getProjection<Execution>("execution", started.body.data.goal.executionRef.executionId)!;
    tx.putProjection("execution", execution.id, { ...execution, status: "failed", streamVersion: execution.streamVersion + 1 });
    appendKernelEvent(tx, { tenantId: "local", aggregateType: "execution", aggregateId: execution.id, expectedStreamVersion: execution.streamVersion, type: "fixture.failed", actorId: "local-owner", generation: execution.generation, correlationId: randomUUID(), publicPayload: {} });
  });
  const recorded = await f.send(`${path}/commands`, usage, "external-bill");
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.deepEqual(recorded.body.data.goal.reservation.actual, usage.usage);
  assert.equal(recorded.body.data.goal.status, "failed");
  assert.deepEqual((await f.send(`${path}/commands`, usage, "external-bill")).body.data, recorded.body.data);
  const changed = await f.send(`${path}/commands`, { ...usage, expectedStreamVersion: recorded.body.data.goal.streamVersion, usage: { ...usage.usage, costMinorUnits: "0" } });
  assert.ok(changed.status >= 400, "同一账单不可悄悄覆盖");

});

async function start(f: Awaited<ReturnType<typeof fixture>>, created: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["create"]>>) {
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `/v2/goals/${created.body.data.goal.id}`;
  const planned = await f.send(`${path}/plan-revisions`, { workspaceId: f.workspace.id, expectedStreamVersion: created.body.data.goal.streamVersion, modelBindingId: f.model.id });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const result = await f.send(`${path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: planned.body.data.goal.streamVersion, command: "start", planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { path, detail: result.body.data };
}
function worker(f: Awaited<ReturnType<typeof fixture>>, modelInvoker: ByokModelInvoker) {
  return new AgentOsWorker({ id: "goal-worker", store: f.store, lock: { engineLockDigest: "fixture", expectedEngineLockDigest: "fixture", pluginLockDigest: "fixture", expectedPluginLockDigest: "fixture" }, handlers: {
    "agent.execution.run": createKernelAgentTurnHandler({ store: f.store, secretStore: f.secretStore, approvalKernel: f.host.kernel,
      runtimeProtection: { cas: f.cas, keyProvider: f.keyProvider, validateContextSource: validateBusinessContextSource }, assertExecutionResources: assertGoalExecutionResources,
      resolveThreadContext: createOpcModelContextReader({ store: f.store, cas: f.cas, protectedPayloadKeyProvider: f.keyProvider }),
      codingSandboxRoot: join(f.root, "sandboxes"), approvalPollIntervalMs: 5, modelInvoker,
      modelQuoter: async () => ({ inputTokenLimit: 100, maxOutputTokens: 100, rates: { id: "fixture", currency: "CNY", inputNanoMinorUnitsPerToken: "0", cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } }),
    }),
  } });
}

test("CLI 配置变化不改写重试返回的计划，但阻止旧计划启动", async t => {
  const f = await fixture(t);
  await f.store.transact("local", transaction => confirmCodingRunner({ transaction, tenantId: "local", workspaceId: f.workspace.id, actorId: "local-owner", runnerId: "codex-cli", expectedStreamVersion: 0, expectedVersion: "fixture", expectedSha256: runnerInspection.sha256, inspection: runnerInspection, occurredAt: new Date().toISOString(), correlationId: randomUUID() }));
  const created = await f.create(), path = `/v2/goals/${created.body.data.goal.id}`;
  const input = { workspaceId: f.workspace.id, expectedStreamVersion: 1, scheduling: { runnerId: "codex-cli", strategy: "quality" } };
  const planned = await f.send(`${path}/plan-revisions`, input, "frozen-cli-plan");
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  await f.store.transact("local", transaction => confirmCodingRunner({ transaction, tenantId: "local", workspaceId: f.workspace.id, actorId: "local-owner", runnerId: "codex-cli", expectedStreamVersion: 1, expectedVersion: "fixture", expectedSha256: runnerInspection.sha256, inspection: runnerInspection, occurredAt: new Date().toISOString(), correlationId: randomUUID() }));
  assert.deepEqual((await f.send(`${path}/plan-revisions`, input, "frozen-cli-plan")).body.data, planned.body.data);
  const started = await f.send(`${path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: 2, command: "start", planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest });
  assert.ok(started.status >= 400);
  assert.equal((await f.store.transact("local", tx => tx.listProjections("job"))).length, 0);
});

test("Host 目标计划冻结当前模型与最小权限，开始在同一事务绑定唯一 Job", async t => {
  const f = await fixture(t);
  const created = await f.create();
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `/v2/goals/${created.body.data.goal.id}`;
  const planned = await f.send(`${path}/plan-revisions`, { workspaceId: f.workspace.id, expectedStreamVersion: created.body.data.goal.streamVersion, modelBindingId: f.model.id }, "plan-goal");
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.deepEqual(planned.body.data.plan.toolIds, []);
  assert.equal(planned.body.data.plan.runnerId, "builtin");
  const input = { workspaceId: f.workspace.id, expectedStreamVersion: planned.body.data.goal.streamVersion, command: "start", planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest };
  const started = await f.send(`${path}/commands`, input, "start-goal");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const replanned = await f.send(`${path}/plan-revisions`, { workspaceId: f.workspace.id, expectedStreamVersion: created.body.data.goal.streamVersion, modelBindingId: f.model.id }, "plan-goal");
  assert.deepEqual(replanned.body.data, planned.body.data, JSON.stringify(replanned.body));
  const replay = await f.send(`${path}/commands`, input, "start-goal");
  assert.deepEqual(replay.body.data, started.body.data);
  assert.equal(f.allocated.filter(kind => kind === "goal-message").length, 1);
  for (let i = 0; i < 2; i++) {
    await f.send(`${path}?workspaceId=${f.workspace.id}`);
    await f.send(`${path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: started.body.data.goal.streamVersion, command: "refresh" });
  }
  assert.equal(f.allocated.filter(kind => kind === "goal-message").length, 1);
  const facts = await f.store.transact("local", tx => ({ executions: tx.listProjections<any>("execution"), jobs: tx.listProjections<any>("job") }));
  assert.equal(facts.executions.length, 1);
  assert.equal(facts.jobs.length, 1);
  assert.equal(facts.jobs[0].payload.coordination.aggregateId, started.body.data.goal.id);
  assert.equal(facts.executions[0].id, started.body.data.goal.executionRef.executionId);
  await assert.rejects(f.store.transact("local", tx => { tx.deleteProjection(GOAL_NAMESPACE, started.body.data.goal.id); assertGoalExecutionResources(tx, facts.executions[0]); }), /目标执行缺少完整绑定/u);
});

test("Host 拒绝客户端扩充计划权限和伪造验收检查", async t => {
  const f = await fixture(t);
  const created = await f.create();
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `/v2/goals/${created.body.data.goal.id}`;
  const injected = await f.send(`${path}/plan-revisions`, { workspaceId: f.workspace.id, expectedStreamVersion: created.body.data.goal.streamVersion, modelBindingId: f.model.id, toolIds: ["coding.candidate.accept"] });
  assert.ok(injected.status >= 400);
  const forged = await f.send(`${path}/acceptances`, { workspaceId: f.workspace.id, expectedStreamVersion: created.body.data.goal.streamVersion, deliverySetId: "forged", criteriaVersion: "forged", items: [], checks: [{ checkId: "all", status: "passed" }] });
  assert.ok(forged.status >= 400);
  assert.equal((await f.store.transact("local", tx => tx.listProjections("execution"))).length, 0);
});

test("OPC 真实 Worker 答复绑定来源和用量，语义标准必须逐项人工接收", async t => {
  const f = await fixture(t), current = await start(f, await f.create());
  let calls = 0;
  const result = await worker(f, async ({ request }) => {
    calls++;
    assert.deepEqual(request.availableToolIds, []);
    assert.ok(request.messages.some(message => message.content.includes("为独立开发者整理需求验证问题")));
    return { text: "现有资料尚不能证明付费需求；请访谈最近遇到问题的独立开发者，并记录反证。", toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
  }).pollOnce();
  assert.equal(result.status, "completed", JSON.stringify(result));
  const refreshed = await f.send(`${current.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: current.detail.goal.streamVersion, command: "refresh" });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  const detail = refreshed.body.data;
  assert.equal(detail.goal.status, "awaiting_acceptance");
  assert.equal(detail.goal.reservation.actual.tokens, 20);
  assert.match(detail.deliverySet.items[0].preview, /不能证明付费需求/u);
  const input = { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion, deliverySetId: detail.deliverySet.id, criteriaVersion: detail.goal.criteriaVersion, items: [{ key: "report", digest: detail.deliverySet.items[0].digest, reviewedCriterionIds: [] }] };
  assert.ok((await f.send(`${current.path}/acceptances`, input)).status >= 400);
  const accepted = await f.send(`${current.path}/acceptances`, { ...input, items: [{ ...input.items[0], reviewedCriterionIds: ["sources"] }] });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.goal.status, "accepted");
  assert.equal(calls, 1);
});

test("派发后模型版本变化阻止 Worker 外发，取消未开始执行后计量归零", async t => {
  const f = await fixture(t), current = await start(f, await f.create());
  await f.store.transact("local", tx => { const model = tx.getProjection<any>("modelConnection", f.model.id); tx.putProjection("modelConnection", model.id, { ...model, streamVersion: model.streamVersion + 1 }); appendKernelEvent(tx, { tenantId: "local", aggregateType: "modelConnection", aggregateId: model.id, expectedStreamVersion: model.streamVersion, type: "fixture.changed", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} }); });
  let calls = 0;
  await worker(f, async () => { calls++; throw new Error("must not call"); }).pollOnce();
  assert.equal(calls, 0);
  const cancelled = await f.send(`${current.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: current.detail.goal.streamVersion, command: "cancel" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const refreshed = await f.send(`${current.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: cancelled.body.data.goal.streamVersion, command: "refresh" });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.data.goal.reservation.actual.tokens, 0);
});


test("Host 后台自动冻结完成答复和用量，不要求用户刷新", async t => {
  const f = await fixture(t, 25), current = await start(f, await f.create());
  await worker(f, async () => ({ text: "需要进一步验证付费需求。", toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } })).pollOnce();
  let detail;
  for (let attempt = 0; attempt < 80; attempt++) {
    detail = (await f.send(`${current.path}?workspaceId=${f.workspace.id}`)).body.data;
    if (detail.goal.status === "awaiting_acceptance") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(detail.goal.status, "awaiting_acceptance");
  assert.equal(detail.goal.reservation.actual.tokens, 20);
});

test("目标执行中会话可读，普通会话提交不能绕过目标计划", async t => {
  const f = await fixture(t), current = await start(f, await f.create());
  const read = await f.send(`/v2/workspaces/${f.workspace.id}/threads/${f.thread.id}/turns`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const sent = await f.send(`/v2/workspaces/${f.workspace.id}/threads/${f.thread.id}/turns`, { workspaceId: f.workspace.id, expectedStreamVersion: f.thread.streamVersion + 1, message: "扩展到其他工作", modelBindingId: f.model.id });
  assert.ok(sent.status >= 400, JSON.stringify(sent.body));
  assert.equal((await f.store.transact("local", tx => tx.listProjections("job"))).length, 1);
  assert.ok(current.detail.goal.executionRef);
});


test("Coding 真实 Worker 的候选、Gate 和批准共同形成可接收成果", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  const root = join(f.root, "repository"); await mkdir(root); await writeFile(join(root, "message.txt"), "old value\n");
  for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]]) execFileSync("git", args, { cwd: root });
  const mutation = { store: f.store, tenantId: "local", workspaceId: f.workspace.id, actorId: "local-owner", now: () => new Date().toISOString(), id: (kind: string) => `${kind}-${randomUUID()}`, expectedStreamVersion: 0 };
  const repository = await captureCodingRepository({ ...mutation, idempotencyKey: "repository", input: await realpath(root) });
  const task = await captureCodingTask({ ...mutation, idempotencyKey: "task", repositoryId: repository.id, input: "将 message.txt 中的 old value 改为 new value" });
  const thread = (await f.store.transact("local", tx => tx.listProjections<Thread>("thread").find(item => item.resourceRef?.resourceId === task.id)))!;
  const created = await f.send(`/v2/workspaces/${f.workspace.id}/goals`, { threadId: thread.id, objective: "更新消息内容", resourceRefs: [], budget: { maxTokens: 1000, maxCostMinorUnits: "50", currency: "CNY", maxDurationMs: 60_000 }, deliverables: [{ key: "report", title: "代码变更", required: true, criteria: [{ id: "sources", description: "只更新 message.txt 的文案" }] }] });
  const current = await start(f, created);
  const polling = worker(f, async () => ({ text: "更新文案", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 }, toolCalls: [{ id: "patch", toolId: "coding.sandbox.write", arguments: { patch: "diff --git a/message.txt b/message.txt\n--- a/message.txt\n+++ b/message.txt\n@@ -1 +1 @@\n-old value\n+new value\n", summary: "更新文案" } }] })).pollOnce();
  let finished: unknown; void polling.then(value => { finished = value; });
  let approval: Approval | undefined;
  for (let attempt = 0; attempt < 1000; attempt++) {
    approval = await f.store.transact("local", tx => tx.listProjections<Approval>("approval").find(item => item.status === "pending"));
    if (approval || finished) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(approval, JSON.stringify(finished));
  await f.host.kernel.decideApproval("local", "local-owner", "approve-candidate", approval.id, approval.streamVersion, "approve_once");
  const polled = await polling;
  assert.equal(polled.status, "completed", JSON.stringify(polled));
  const refreshed = await f.send(`${current.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: current.detail.goal.streamVersion, command: "refresh" });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  const detail = refreshed.body.data;
  assert.equal(detail.goal.status, "awaiting_acceptance", JSON.stringify(detail));
  assert.match(detail.deliverySet.items[0].preview, /\+new value/u);
  const candidate = await f.store.transact("local", tx => tx.listProjections<any>("coding.candidate")[0]);
  await f.store.transact("local", tx => { tx.putProjection("coding.candidate", candidate.id, { ...candidate, diff: candidate.diff + "tampered" }); appendKernelEvent(tx, { tenantId: "local", aggregateType: "fixture.candidate", aggregateId: candidate.id, expectedStreamVersion: 0, type: "fixture.tampered", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} }); });
  const input = { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion, deliverySetId: detail.deliverySet.id, criteriaVersion: detail.goal.criteriaVersion, items: [{ key: "report", digest: detail.deliverySet.items[0].digest, reviewedCriterionIds: ["sources"] }] };
  assert.ok((await f.send(`${current.path}/acceptances`, input)).status >= 400);
  await f.store.transact("local", tx => { tx.putProjection("coding.candidate", candidate.id, candidate); appendKernelEvent(tx, { tenantId: "local", aggregateType: "fixture.candidate", aggregateId: candidate.id, expectedStreamVersion: 1, type: "fixture.restored", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} }); });
  const accepted = await f.send(`${current.path}/acceptances`, input);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.goal.status, "accepted");
});


test("工具已开始但结果未知时仍保存取消意图并保留待核对执行", async t => {
  const f = await fixture(t), current = await start(f, await f.create());
  await f.store.transact("local", tx => {
    const execution = tx.getProjection<Execution>("execution", current.detail.goal.executionRef.executionId)!;
    tx.putProjection("execution", execution.id, { ...execution, status: "running", streamVersion: execution.streamVersion + 1 });
    appendKernelEvent(tx, { tenantId: "local", aggregateType: "execution", aggregateId: execution.id, expectedStreamVersion: execution.streamVersion, type: "fixture.running", actorId: "local-owner", generation: execution.generation, correlationId: randomUUID(), publicPayload: {} });
    recordToolAdmission(tx, execution, "unknown-tool", "started", new Date().toISOString());
  });
  const cancelled = await f.send(`${current.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: current.detail.goal.streamVersion, command: "cancel" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.goal.status, "needs_reconciliation");
  assert.ok(cancelled.body.data.goal.cancellationRequestedAt);
  const execution = await f.store.transact("local", tx => tx.getProjection<Execution>("execution", current.detail.goal.executionRef.executionId)!);
  assert.equal(execution.status, "needs_reconciliation");
  assert.equal(execution.generation, current.detail.goal.executionRef.generation);
});

test("撤销成员权限后后台仍核对原执行费用，不形成交付", async t => {
  const f = await fixture(t, 25), current = await start(f, await f.create());
  await worker(f, async () => {
    await f.store.transact("local", tx => {
      const id = `${f.workspace.id}:local-owner`, member = tx.getProjection<any>("membership", id);
      tx.putProjection("membership", id, { ...member, removedAt: new Date().toISOString(), streamVersion: member.streamVersion + 1 });
      appendKernelEvent(tx, { tenantId: "local", aggregateType: "workspaceMembership", aggregateId: id, expectedStreamVersion: member.streamVersion, type: "fixture.revoked", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} });
    });
    return { text: "不会形成可见交付", toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
  }).pollOnce();
  let goal: any;
  for (let attempt = 0; attempt < 80; attempt++) {
    goal = await f.store.transact("local", tx => tx.getProjection(GOAL_NAMESPACE, current.detail.goal.id));
    if (goal?.reservation?.status === "settled") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(goal.reservation.actual?.tokens, 20);
  assert.equal(goal.status, "needs_reconciliation");
  assert.equal(goal.deliverySetId, undefined);
  assert.ok((await f.send(`${current.path}?workspaceId=${f.workspace.id}`)).status >= 400);
});


test("目标只引用会话实际读取的资料，不能额外声明未使用来源", async t => {
  const f = await fixture(t);
  const other = await captureOpportunity({ store: f.store, tenantId: "local", workspaceId: f.workspace.id, actorId: "local-owner", now: () => new Date().toISOString(), id: kind => `${kind}-${randomUUID()}`, idempotencyKey: "other-opportunity", expectedStreamVersion: 0, input: "另一个未绑定机会" });
  const response = await f.send(`/v2/workspaces/${f.workspace.id}/goals`, { threadId: f.thread.id, objective: "整理分析", resourceRefs: [{ namespace: "opc.opportunity", resourceId: other.id, streamVersion: other.streamVersion }], budget: { maxTokens: 1000, maxCostMinorUnits: "50", currency: "CNY", maxDurationMs: 60_000 }, deliverables: [{ key: "report", title: "分析", required: true, criteria: [{ id: "source", description: "使用实际来源" }] }] });
  assert.ok(response.status >= 400, JSON.stringify(response.body));
  assert.equal((await f.store.transact("local", tx => tx.listProjections(GOAL_NAMESPACE))).length, 0);
});

test("经营任务使用独立经营助手，执行不新增机会或改写经营账目", async t => {
  const f = await fixture(t);
  const thread = await f.host.kernel.createThread("local", "local-owner", "business-thread", { workspaceId: f.workspace.id, pluginId: "opc", subject: "规划下月经营" });
  const created = await f.send(`/v2/workspaces/${f.workspace.id}/goals`, {
    threadId: thread.id, objective: "规划下月经营，分析现金流与交付安排", resourceRefs: [],
    budget: { maxTokens: 1000, maxCostMinorUnits: "50", currency: "CNY", maxDurationMs: 60_000 },
    deliverables: [{ key: "report", title: "经营计划", required: true, criteria: [{ id: "facts", description: "区分事实和建议" }] }],
  });
  const current = await start(f, created);
  assert.equal(current.detail.plan.agentDefinitionId, "opc.business-assistant");
  assert.deepEqual(current.detail.plan.toolIds, []);
  const before = await f.store.transact("local", tx => ({ opportunities: tx.listProjections("opc.opportunity"), business: tx.listProjections("opc.business") }));
  let calls = 0;
  const result = await worker(f, async ({ request }) => {
    calls++;
    assert.ok(request.messages.some(message => message.content.includes("经营助手")));
    assert.ok(request.messages.some(message => message.content.includes("分析现金流与交付安排")));
    assert.ok(!request.messages.some(message => message.content.includes("你是木牛 OPC 机会验证 Agent")));
    assert.deepEqual(request.availableToolIds, []);
    return { text: "经营建议：先核对现有订单交付安排；缺少收支资料，不能推断现金余额。", toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
  }).pollOnce();
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(calls, 1);
  const refreshed = await f.send(`${current.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: current.detail.goal.streamVersion, command: "refresh" });
  assert.equal(refreshed.body.data.goal.status, "awaiting_acceptance");
  assert.match(refreshed.body.data.deliverySet.items[0].preview, /经营建议/u);
  assert.deepEqual(await f.store.transact("local", tx => ({ opportunities: tx.listProjections("opc.opportunity"), business: tx.listProjections("opc.business") })), before);
});

test("固定目标允许执行中补充说明，保持原计划与额度且禁止绕过目标重启", async t => {
  const f = await fixture(t), current = await start(f, await f.create());
  await f.store.transact("local", tx => {
    const execution = tx.getProjection<Execution>("execution", current.detail.goal.executionRef.executionId)!;
    tx.putProjection("execution", execution.id, { ...execution, status: "running", streamVersion: execution.streamVersion + 1 });
    appendKernelEvent(tx, { tenantId: "local", aggregateType: "execution", aggregateId: execution.id, expectedStreamVersion: execution.streamVersion, type: "fixture.running", actorId: "local-owner", generation: execution.generation, correlationId: randomUUID(), publicPayload: {} });
  });
  const execution = await f.store.transact("local", tx => tx.getProjection<Execution>("execution", current.detail.goal.executionRef.executionId)!);
  const sent = await f.send(`/v2/executions/${execution.id}/commands`, { expectedStreamVersion: execution.streamVersion, command: "steer", message: "标出缺少证据的部分" });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.equal(sent.body.data.authorityId, execution.authorityId);
  assert.equal(sent.body.data.runnerId, execution.runnerId);
  assert.ok((await f.send(`/v2/executions/${execution.id}/commands`, { expectedStreamVersion: sent.body.data.streamVersion, command: "resume" })).status >= 400);
});

async function materialGoal(f: Awaited<ReturnType<typeof fixture>>, content = '受保护事实：项目代号紫杉，约定两周交付。') {
  const upload = await f.send('/v2/assets', { workspaceId: f.workspace.id, expectedStreamVersion: 0,
    attachments: [{ fileName: 'requirements.md', mediaType: 'text/markdown', contentBase64: Buffer.from(content).toString('base64'), protected: true }] });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  const asset = upload.body.data[0];
  const ref = { namespace: 'asset', resourceId: asset.id, streamVersion: asset.streamVersion, digest: asset.digest };
  const thread = await f.host.kernel.createThread('local', 'local-owner', randomUUID(), { workspaceId: f.workspace.id, pluginId: 'opc', subject: '资料分析' });
  const input = { threadId: thread.id, objective: '分析材料并给出交付建议', resourceRefs: [ref],
    budget: { maxTokens: 1000, maxCostMinorUnits: '50', currency: 'CNY', maxDurationMs: 60_000 },
    deliverables: [{ key: 'report', title: '交付建议', required: true, criteria: [{ id: 'sources', description: '标明资料依据' }] }] };
  return { asset, ref, thread, input, created: await f.send(`/v2/workspaces/${f.workspace.id}/goals`, input) };
}

test('保护资料以版本引用准入，提取可定位，模型调用前保存实际内容和来源', async t => {
  const f = await fixture(t), material = await materialGoal(f);
  const extracted = await f.send(`/v2/assets/${material.asset.id}/extraction`);
  assert.equal(extracted.status, 200, JSON.stringify(extracted.body));
  assert.equal(extracted.body.data.status, 'complete');
  assert.deepEqual(extracted.body.data.assetRef, material.ref);
  assert.match(extracted.body.data.blocks[0].text, /项目代号紫杉/u);
  assert.ok(extracted.body.data.blocks[0].locator);
  const current = await start(f, material.created);
  assert.equal(current.detail.goal.objective, material.input.objective);
  let calls = 0;
  const result = await worker(f, async ({ request }) => {
    calls++;
    assert.ok(request.messages.some(message => message.content.includes('项目代号紫杉')));
    const context = await f.store.transact('local', tx => tx.getProjection<any>('execution.context', request.executionId));
    assert.deepEqual(context.sourceRefs, [material.ref]);
    assert.ok(context.materials[0].selectedBlocks.length);
    const records = await (await import('@mn/worker')).createProtectedRuntimeStore({ store: f.store, cas: f.cas, keyProvider: f.keyProvider, tenantId: 'local', workspaceId: f.workspace.id }).readExecution(request.executionId);
    const persisted = records.filter(record => record.type === 'model/request').at(-1)!;
    assert.ok(JSON.stringify(persisted.payload.messages).includes('项目代号紫杉'));
    assert.deepEqual((persisted.payload.contextManifest as any).sourceRefs, [material.ref]);
    return { text: '根据紫杉项目资料，先确认两周内的交付安排。', toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
  }).pollOnce();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(calls, 1);
  const deleted = await f.host.dispatch(new Request(`http://fixture/v2/assets/${material.asset.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedStreamVersion: material.asset.streamVersion, reason: '撤回资料授权' }) }));
  assert.equal(deleted.status, 200);
  assert.ok((await f.send(`/v2/workspaces/${f.workspace.id}/threads/${material.thread.id}/turns`)).status >= 400);
  assert.ok((await f.send(`${current.path}?workspaceId=${f.workspace.id}`)).status >= 400);
});

test('保护资料拒绝伪造版本、未保护来源及超过上下文硬限额的整份输入', async t => {
  const f = await fixture(t), material = await materialGoal(f, 'x'.repeat(110_000));
  assert.equal(material.created.status, 201, JSON.stringify(material.created.body));
  const bad = await f.send(`/v2/workspaces/${f.workspace.id}/goals`, { ...material.input, resourceRefs: [{ ...material.ref, digest: 'a'.repeat(64) }] });
  assert.ok(bad.status >= 400);
  const path = `/v2/goals/${material.created.body.data.goal.id}`;
  const planned = await f.send(`${path}/plan-revisions`, { workspaceId: f.workspace.id, expectedStreamVersion: 1, modelBindingId: f.model.id });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const started = await f.send(`${path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: 2, command: 'start', planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest });
  assert.ok(started.status >= 400, JSON.stringify(started.body));
  assert.equal((await f.store.transact('local', tx => tx.listProjections('job'))).length, 0);
});

test('后续普通会话继承来源，撤权后禁止第三轮外发和历史成果读取', async t => {
  const f = await fixture(t), material = await materialGoal(f), first = await start(f, material.created);
  assert.equal((await worker(f, async () => ({ text: '紫杉项目需两周交付。' + '历史背景'.repeat(4000), toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } })).pollOnce()).status, 'completed');
  const refreshed = await f.send(`${first.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: first.detail.goal.streamVersion, command: 'refresh' });
  const ready = refreshed.body.data;
  const accepted = await f.send(`${first.path}/acceptances`, { workspaceId: f.workspace.id, expectedStreamVersion: ready.goal.streamVersion, deliverySetId: ready.deliverySet.id, criteriaVersion: ready.goal.criteriaVersion,
    items: [{ key: 'report', digest: ready.deliverySet.items[0].digest, reviewedCriterionIds: ['sources'] }] });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const turnsPath = `/v2/workspaces/${f.workspace.id}/threads/${material.thread.id}/turns`;
  async function next(message: string) {
    const thread = await f.store.transact('local', tx => tx.getProjection<Thread>('thread', material.thread.id)!);
    const turn = await f.send(turnsPath, { expectedStreamVersion: thread.streamVersion, message, agentDefinitionId: 'opc.business-assistant', modelBindingId: f.model.id });
    assert.equal(turn.status, 202, JSON.stringify(turn.body));
    return turn.body.data;
  }
  const second = await next('依据上轮结论整理下一步。');
  assert.equal((await worker(f, async ({ request }) => {
    assert.ok(request.messages.some(message => message.content.includes('紫杉项目需两周交付')));
    const context = await f.store.transact('local', tx => tx.getProjection<any>('execution.context', request.executionId));
    assert.deepEqual(context.sourceRefs, [material.ref]);
    assert.ok(context.inheritedExecutionIds.includes(first.detail.goal.executionRef.executionId));
    assert.ok(request.contextSelection, '超限历史应在实际发送前摘录');
    const runtime = (await import('@mn/worker')).createProtectedRuntimeStore({ store: f.store, cas: f.cas, keyProvider: f.keyProvider, tenantId: 'local', workspaceId: f.workspace.id });
    const original = (await runtime.readExecution(request.executionId)).find(record => record.type === 'context/prepared');
    assert.ok(JSON.stringify(original?.payload.messages).includes('历史背景'.repeat(4000)));
    assert.ok(request.messages.some(message => message.content.includes('上下文摘录，不代表原文全貌')));
    return { text: '先核对交付清单。', toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
  }).pollOnce()).status, 'completed');
  await next('继续整理。');
  await f.host.dispatch(new Request(`http://fixture/v2/assets/${material.asset.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedStreamVersion: material.asset.streamVersion, reason: '撤权' }) }));
  let calls = 0;
  await worker(f, async () => { calls++; throw new Error('资料已撤权，禁止调用'); }).pollOnce();
  assert.equal(calls, 0);
  assert.ok((await f.send(turnsPath)).status >= 400);
  const runtime = (await import('@mn/worker')).createProtectedRuntimeStore({ store: f.store, cas: f.cas, keyProvider: f.keyProvider, tenantId: 'local', workspaceId: f.workspace.id });
  await assert.rejects(runtime.readExecution(second.id), /资料来源|资料已删除/u);
});

test('资料解密期间撤权阻止提取返回，启动后撤权阻止模型预算预检', async t => {
  const f = await fixture(t), material = await materialGoal(f);
  const current = await start(f, material.created);
  const get = f.cas.get.bind(f.cas);
  let revoked = false;
  f.cas.get = async digest => {
    const bytes = await get(digest);
    if (digest === material.asset.digest && !revoked) {
      revoked = true;
      await f.store.transact('local', tx => { tx.deleteProjection('protectedPayloadKey', material.asset.protectedPayloadRef); appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'fixture-revocation', aggregateId: material.asset.id, expectedStreamVersion: 0, type: 'fixture.source_revoked', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} }); });
    }
    return bytes;
  };
  assert.ok((await f.send(`/v2/assets/${material.asset.id}/extraction`)).status >= 400);
  let calls = 0;
  await worker(f, async () => { calls++; throw new Error('禁止调用'); }).pollOnce();
  assert.equal(calls, 0);
  assert.ok((await f.send(`${current.path}?workspaceId=${f.workspace.id}`)).status >= 400);
});

test('业务对象版本进入实际模型上下文，台账变化阻止历史再次传播', async t => {
  const f = await fixture(t);
  const { applyBusinessCommand, createEmptyBusiness } = await import('@mn/plugin-opc');
  const { readBusinessContext } = await import('../src/business-context.js');
  const state = applyBusinessCommand(createEmptyBusiness(f.workspace.id), { type: 'customer.record', customerId: 'customer-context', name: '青禾', source: '面谈', need: '确认交付范围' }, { principalId: 'local-owner', occurredAt: new Date().toISOString() });
  await f.store.transact('local', tx => {
    tx.putProjection('opc.business', f.workspace.id, state);
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'opc.business', aggregateId: f.workspace.id, expectedStreamVersion: 0, type: 'fixture.business_created', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: { workspaceId: f.workspace.id } });
  });
  const context = await f.store.transact('local', tx => readBusinessContext(tx, { tenantId: 'local', workspaceId: f.workspace.id, principalId: 'local-owner' }, { kind: 'customer', resourceId: 'customer-context' }));
  const material = await materialGoal(f);
  const created = await f.send(`/v2/workspaces/${f.workspace.id}/goals`, { ...material.input, resourceRefs: [context.sourceRef], threadId: (await f.host.kernel.createThread('local', 'local-owner', randomUUID(), { workspaceId: f.workspace.id, pluginId: 'opc', subject: '客户委派' })).id });
  const current = await start(f, created);
  assert.equal((await worker(f, async ({ request }) => {
    assert.ok(request.messages.some(message => message.content.includes('青禾') && message.content.includes('确认交付范围')));
    assert.ok(!request.messages.some(message => message.content.includes('项目代号紫杉')));
    return { text: '先与青禾核对交付范围。', toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
  }).pollOnce()).status, 'completed');
  await f.store.transact('local', tx => {
    tx.putProjection('opc.business', f.workspace.id, applyBusinessCommand(state, { type: 'customer.record', customerId: 'customer-context', name: '青禾', source: '更新面谈', need: '增加新范围' }, { principalId: 'local-owner', occurredAt: new Date().toISOString() }));
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'opc.business', aggregateId: f.workspace.id, expectedStreamVersion: 1, type: 'fixture.business_changed', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: { workspaceId: f.workspace.id } });
  });
  assert.ok((await f.send(`${current.path}?workspaceId=${f.workspace.id}`)).status >= 400);
  assert.ok((await f.send(`/v2/workspaces/${f.workspace.id}/threads/${current.detail.goal.threadId}/turns`)).status >= 400);
});

test('模型在途撤销资料仍结算已发生费用，正文不进入后续工作', async t => {
  const f = await fixture(t), material = await materialGoal(f), current = await start(f, material.created);
  const result = await worker(f, async () => {
    const response = await f.host.dispatch(new Request(`http://fixture/v2/assets/${material.asset.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedStreamVersion: material.asset.streamVersion, reason: '模型在途撤权' }) }));
    assert.equal(response.status, 200);
    return { text: '禁止传播的紫杉答复', toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 7 } };
  }).pollOnce();
  assert.notEqual(result.status, 'completed');
  const rows = await f.store.transact('local', tx => tx.getProjection<any>('agent-runtime', current.detail.goal.executionRef.executionId).records);
  const settled = rows.find((row: any) => row.type === 'model/settled');
  assert.ok(settled, '已发生用量必须结算');
  const value = await (await import('@mn/worker')).readProtectedRuntimePayload({ store: f.store, cas: f.cas, keyProvider: f.keyProvider, tenantId: 'local', workspaceId: f.workspace.id, ownerType: 'runtime', ownerId: current.detail.goal.executionRef.executionId, protectedPayloadRef: settled.protectedPayloadRef });
  assert.equal((value.usage as any).outputTokens, 7);
  assert.equal(rows.some((row: any) => row.type === 'model/response'), false);
  const runtime = (await import('@mn/worker')).createProtectedRuntimeStore({ store: f.store, cas: f.cas, keyProvider: f.keyProvider, tenantId: 'local', workspaceId: f.workspace.id });
  assert.equal(JSON.stringify(await runtime.readSettlementRecords!(current.detail.goal.executionRef.executionId)).includes('紫杉'), false);
  assert.equal((await f.send(`/v2/activity?workspaceId=${f.workspace.id}`)).status, 200);
  assert.ok((await f.send(`/v2/workspaces/${f.workspace.id}/threads/${material.thread.id}/turns`)).status >= 400);
});

test('材料引用拒绝未保护、跨工作区、缺摘要和重复来源', async t => {
  const f = await fixture(t), material = await materialGoal(f);
  const other = await f.host.kernel.createWorkspace('local', 'local-owner', randomUUID(), { name: '另一工作区', viewMode: 'business', pluginIds: ['opc'] });
  for (const input of [
    { workspaceId: f.workspace.id, protected: false }, { workspaceId: other.id, protected: true },
  ]) {
    const uploaded = await f.send('/v2/assets', { workspaceId: input.workspaceId, expectedStreamVersion: 0,
      attachments: [{ fileName: 'other.txt', mediaType: 'text/plain', contentBase64: Buffer.from('未授权引用').toString('base64'), protected: input.protected }] });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const asset = uploaded.body.data[0];
    const result = await f.send(`/v2/workspaces/${f.workspace.id}/goals`, { ...material.input, resourceRefs: [{ namespace: 'asset', resourceId: asset.id, streamVersion: asset.streamVersion, digest: asset.digest }] });
    assert.ok(result.status >= 400);
  }
  for (const resourceRefs of [[{ ...material.ref, digest: undefined }], [material.ref, material.ref]]) {
    assert.ok((await f.send(`/v2/workspaces/${f.workspace.id}/goals`, { ...material.input, resourceRefs })).status >= 400);
  }
});

test('受保护上下文可从事件重建，删除来源后重建不会恢复读取权限', async t => {
  const f = await fixture(t), material = await materialGoal(f), current = await start(f, material.created);
  const executionId = current.detail.goal.executionRef.executionId;
  const before = await f.store.transact('local', tx => tx.getProjection('execution.context', executionId));
  await f.store.rebuildProjections('local');
  assert.deepEqual(await f.store.transact('local', tx => tx.getProjection('execution.context', executionId)), before);
  const page = await f.store.readEventHistory('local', 0, 1000);
  assert.equal(JSON.stringify(page).includes('项目代号紫杉'), false);
  await f.host.dispatch(new Request(`http://fixture/v2/assets/${material.asset.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedStreamVersion: material.asset.streamVersion, reason: '重建前撤权' }) }));
  await f.store.rebuildProjections('local');
  assert.ok((await f.send(`/v2/workspaces/${f.workspace.id}/threads/${material.thread.id}/turns`)).status >= 400);
  let calls = 0;
  await worker(f, async () => { calls++; throw new Error('禁止重建后传播'); }).pollOnce();
  assert.equal(calls, 0);
});

test('大资料只选目标相关完整段落，调用清单与实际发送段落一致', async t => {
  const f = await fixture(t);
  const irrelevant = Array.from({ length: 100 }, (_, index) => `无关背景${index}：${'天气记录'.repeat(200)}`).join('\n\n');
  const material = await materialGoal(f, `${irrelevant}\n\n交付安排：项目应在两周内提交可验收文件。\n\n${irrelevant}`);
  const current = await start(f, material.created);
  assert.equal((await worker(f, async ({ request }) => {
    const manifest = await f.store.transact('local', tx => tx.getProjection<any>('execution.context', request.executionId));
    const selected = manifest.materials[0];
    assert.ok(selected.selectedBlocks.length < selected.selection.totalBlockCount);
    const content = request.messages.find(message => message.content.includes('selectedBlockCount'))!.content;
    const payload = JSON.parse(content.slice(content.indexOf('{"assetRef"')));
    assert.ok(payload.blocks.some((block: any) => block.text.includes('交付安排：项目应在两周内')));
    assert.deepEqual(payload.blocks.map((block: any) => block.id), selected.selectedBlocks.map((block: any) => block.id));
    assert.equal(payload.selectedBlockCount, selected.selectedBlocks.length);
    return { text: '依据交付安排段落，两周内提交验收文件。', toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
  }).pollOnce()).status, 'completed');
  assert.equal(current.detail.goal.objective, material.input.objective);
});

test('读取会话正文期间撤销成员权限，响应前再次检查读权限', async t => {
  const f = await fixture(t), material = await materialGoal(f), current = await start(f, material.created);
  const key = await f.store.transact('local', tx => {
    const entry = tx.listProjections<any>('session-log-entry').find(item => item.executionId === current.detail.goal.executionRef.executionId)!;
    return tx.getProjection<any>('protectedPayloadKey', entry.protectedPayloadRef)!;
  });
  const get = f.cas.get.bind(f.cas);
  let revoked = false;
  f.cas.get = async digest => {
    const bytes = await get(digest);
    if (digest === key.ciphertextDigest && !revoked) {
      revoked = true;
      await f.store.transact('local', tx => {
        const member = tx.getProjection<any>('membership', `${f.workspace.id}:local-owner`)!;
        tx.putProjection('membership', member.id, { ...member, streamVersion: member.streamVersion + 1, removedAt: new Date().toISOString() });
        appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'membership', aggregateId: member.id, expectedStreamVersion: member.streamVersion, type: 'fixture.membership_removed', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
      });
    }
    return bytes;
  };
  assert.ok((await f.send(`/v2/workspaces/${f.workspace.id}/threads/${material.thread.id}/turns`)).status >= 400);
  assert.equal(revoked, true);
});


for (const sourceUnavailable of [false, true]) test(`外部 CLI 单执行者返工保留原身份与未知费用，${sourceUnavailable ? '来源撤回后只结算费用' : '所有者核对后累计结算且不要求 BYOK'}`, async t => {
  const f = await fixture(t, 10, true);
  await f.store.transact('local', tx => {
    confirmCodingRunner({ transaction: tx, tenantId: 'local', workspaceId: f.workspace.id, actorId: 'local-owner', runnerId: 'codex-cli', expectedStreamVersion: 0, expectedVersion: 'fixture', expectedSha256: runnerInspection.sha256, inspection: runnerInspection, occurredAt: new Date().toISOString(), correlationId: randomUUID() });
    tx.putProjection('modelConnection', f.model.id, { ...f.model, status: 'error', streamVersion: 3 });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'fixture', aggregateId: randomUUID(), expectedStreamVersion: 0, type: 'fixture.model_disabled', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  const created = await f.create(), path = `/v2/goals/${created.body.data.goal.id}`;
  const ok = async (suffix: string, body?: unknown, key?: string) => {
    const value = await f.send(path + suffix, body, key); assert.ok(value.status >= 200 && value.status < 300, JSON.stringify(value)); return value.body.data;
  };
  const planned = await ok('/plan-revisions', { workspaceId: f.workspace.id, expectedStreamVersion: 1, scheduling: { runnerId: 'codex-cli', strategy: 'quality' } });
  await ok('/commands', { workspaceId: f.workspace.id, expectedStreamVersion: planned.goal.streamVersion, command: 'start', planRevisionId: planned.plan.id, planDigest: planned.plan.digest });
  const runtime = (await import('@mn/worker')).createProtectedRuntimeStore({ store: f.store, cas: f.cas, keyProvider: f.keyProvider, tenantId: 'local', workspaceId: f.workspace.id });
  let calls = 0;
  const runnerWorker = new AgentOsWorker({ id: 'external-rework-fixture', store: f.store,
    lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' },
    handlers: { 'agent.execution.run': async job => {
      const execution = await f.store.transact('local', tx => { const value = tx.getProjection<Execution>('execution', job.payload.executionId as string)!; assertGoalExecutionResources(tx, value); return value; });
      assert.equal(execution.runnerId, 'codex-cli'); assert.equal(execution.modelBindingId, 'runner:codex-cli'); calls++;
      await runtime.append({ executionId: execution.id, type: 'model/response', payload: { generation: execution.generation, text: calls === 1 ? '待改进的机会分析' : '已补充反证和验收说明', toolCalls: [] } });
      await runtime.append({ executionId: execution.id, type: 'turn/completed', payload: { generation: execution.generation } });
      return { text: 'fixture completed; no external binary launched' };
    } } });
  const wait = async (status: string) => {
    for (let i = 0; i < 200; i++) { await runnerWorker.pollOnce(); const value = await ok(`?workspaceId=${f.workspace.id}`); if (value.goal.status === status) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(JSON.stringify(await ok(`?workspaceId=${f.workspace.id}`)));
  };
  let detail = await wait('needs_reconciliation');
  assert.notEqual(detail.goal.reservation.status, 'settled');
  detail = await ok('/commands', { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion, command: 'record_external_usage', usage: { currency: 'CNY', tokens: 20, costMinorUnits: '12' }, source: '首轮厂商账单' });
  assert.equal(detail.goal.status, 'awaiting_acceptance');
  detail = await ok('/delivery-decisions', { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion,
    deliverySetId: detail.deliverySet.id, criteriaVersion: detail.deliverySet.criteriaVersion,
    items: [{ key: 'report', digest: detail.deliverySet.items[0].digest, decision: 'request_changes', failedCriterionIds: ['sources'], instruction: '补充反证和验收说明' }] });
  const preview = await ok('/rework-previews', { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion, decisionId: detail.deliveryReview.decisions.at(-1).id });
  assert.equal(preview.plan.kind, 'single-v2'); assert.equal(preview.plan.nodes[0].executor.runnerId, 'codex-cli');
  assert.equal(preview.remainingBudget.maxCostMinorUnits, '38');
  await ok('/reworks', { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion, previewId: preview.id, previewDigest: preview.digest });
  detail = await wait('needs_reconciliation'); assert.equal(calls, 2); assert.notEqual(detail.goal.reservation.status, 'settled');
  assert.equal(detail.goal.reasonCode, 'GOAL_USAGE_UNKNOWN', '已结束的CLI账单需提供统一核对入口');
  const attempted = await f.store.transact('local', tx => tx.listProjections<any>('coordination.attempt').find(value => value.runId === detail.goal.coordinationRef.runId));
  assert.notEqual(attempted.reservation.status, 'settled', 'CLI 未知费用不能结算为零');
  const bill = { workspaceId: f.workspace.id, expectedStreamVersion: detail.goal.streamVersion, command: 'record_external_usage', usage: { currency: 'CNY', tokens: 10, costMinorUnits: '7' }, source: '返工厂商账单' };
  await f.store.transact('local', tx => recordToolAdmission(tx, tx.getProjection<Execution>('execution', attempted.executionId)!, 'external-unknown', 'started', new Date().toISOString()));
  assert.ok((await f.send(path + '/commands', bill)).status >= 400, '未知外部副作用不能用账单核对绕过');
  await f.store.transact('local', tx => recordToolAdmission(tx, tx.getProjection<Execution>('execution', attempted.executionId)!, 'external-unknown', 'settled', new Date().toISOString()));
  if (sourceUnavailable) await f.store.transact('local', tx => {
    tx.deleteProjection('opc.opportunity', f.opportunity.id);
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'fixture', aggregateId: randomUUID(), expectedStreamVersion: 0, type: 'fixture.source_removed', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  const settled = await ok('/commands', bill, 'external-rework-bill');
  if (sourceUnavailable) { assert.equal(settled.deliverySet, null); assert.equal(JSON.stringify(settled).includes('已补充反证和验收说明'), false); }
  else assert.equal(settled.goal.status, 'awaiting_acceptance');
  assert.deepEqual(settled.goal.reservation.actual, { currency: 'CNY', tokens: 30, costMinorUnits: '19' });
  assert.deepEqual(await ok('/commands', bill, 'external-rework-bill'), settled);
  assert.ok((await f.send(path + '/commands', { ...bill, expectedStreamVersion: settled.goal.streamVersion, usage: { ...bill.usage, costMinorUnits: '0' } })).status >= 400);
  await f.store.transact('local', tx => {
    const member = tx.getProjection<any>('membership', `${f.workspace.id}:local-owner`)!;
    tx.putProjection('membership', member.id, { ...member, workspaceRole: 'operator', streamVersion: member.streamVersion + 1 });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'fixture', aggregateId: randomUUID(), expectedStreamVersion: 0, type: 'fixture.owner_downgraded', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  const deniedReplay = await f.send(path + '/commands', bill, 'external-rework-bill');
  assert.equal(deniedReplay.body.code, 'FORBIDDEN', '幂等账单重放也必须检查当前所有者权限');
});
