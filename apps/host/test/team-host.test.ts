// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CoordinationAttemptV2, Execution } from "@mn/contracts";
import { AgentOsWorker, createKernelAgentTurnHandler, type ByokModelInvoker } from "@mn/worker";
import { assertGoalExecutionResources } from "../src/goal-runtime.js";
import { validateBusinessContextSource } from "../src/business-context.js";
import { createOpcModelContextReader } from "../src/opc-model-context.js";
import { appendKernelEvent } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { createAgentOsHost } from "../src/host.js";

async function fixture(t: test.TestContext, goalPollIntervalMs = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), "mn-team-host-"));
  const cas = new FileCas({ rootDir: join(directory, "cas") });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 73));
  const store = new SqliteStorage({ databaseFile: join(directory, "state.sqlite"), hmacKey: Buffer.alloc(32, 74) });
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider,
    goalPollIntervalMs, secretStore: { async save() { return "keychain://muniu.v2/team-fixture"; }, async read() { return "fixture"; } } });
  t.after(async () => { await host.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace("local", "local-owner", randomUUID(), { name: "团队流程", viewMode: "business", pluginIds: ["opc"] });
  const thread = await host.kernel.createThread("local", "local-owner", randomUUID(), { workspaceId: workspace.id, subject: "研究现有资料", pluginId: "opc" });
  const model = await host.kernel.saveModelConnection("local", "local-owner", randomUUID(), {
    presetId: "deepseek", displayName: "测试模型", secretRef: "keychain://muniu.v2/team-fixture", defaultModel: "deepseek-v4-flash", discoveredModels: ["deepseek-v4-flash"],
  });
  await store.transact("local", tx => {
    tx.putProjection("modelConnection", model.id, { ...model, status: "ready", streamVersion: 2 });
    appendKernelEvent(tx, { tenantId: "local", aggregateType: "modelConnection", aggregateId: model.id, expectedStreamVersion: 1,
      type: "fixture.model_ready", actorId: "local-owner", generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  const send = async (path: string, body?: unknown, key: string = randomUUID()) => {
    const response = await host.dispatch(new Request(`http://fixture${path}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() as any };
  };
  const created = await send(`/v2/workspaces/${workspace.id}/goals`, { threadId: thread.id, objective: "依据现有资料整理结论、来源及反证",
    resourceRefs: [], budget: { maxTokens: 20000, maxCostMinorUnits: "500", currency: "CNY", maxDurationMs: 60000 },
    deliverables: [{ key: "report", title: "研究报告", required: true, criteria: [{ id: "sources", description: "保留来源和反证，缺失证据明确说明" }] }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `/v2/goals/${created.body.data.goal.id}`;
  const request = { workspaceId: workspace.id, expectedStreamVersion: 1, kind: "team-v1", templateId: "research-summary", templateVersion: "1", modelBindingId: model.id };
  return { directory, cas, keyProvider, host, store, workspace, model, send, created: created.body.data, path, request };
}

test("团队模板显式选择且受当前插件限制，旧请求仍生成单执行者计划", async t => {
  const f = await fixture(t);
  const catalog = await f.send(`/v2/workspaces/${f.workspace.id}/team-templates`);
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.deepEqual(catalog.body.data.map((item: any) => item.id), ["research-summary", "business-proposal", "code-delivery"]);
  assert.equal(catalog.body.data.find((item: any) => item.id === "code-delivery").available, false);
  const planned = await f.send(`${f.path}/plan-revisions`, { workspaceId: f.workspace.id, expectedStreamVersion: 1, modelBindingId: f.model.id });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.equal(planned.body.data.plan.kind, undefined);
  assert.equal(planned.body.data.plan.agentDefinitionId, "opc.business-assistant");
});

test("团队计划固定节点、模型、预算与独立复核，幂等重放不重新生成", async t => {
  const f = await fixture(t);
  const planned = await f.send(`${f.path}/plan-revisions`, f.request, "team-plan");
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const plan = planned.body.data.plan;
  assert.equal(plan.kind, "team-v1");
  assert.equal(plan.nodes.length, 5);
  const review = plan.nodes.find((node: any) => node.id === "review");
  assert.equal(review.review.independent, true);
  assert.deepEqual(review.executor.toolIds, []);
  assert.ok(review.inputs.some((input: any) => input.kind === "goal"));
  assert.ok(review.inputs.some((input: any) => input.outputKey === "evidence"));
  const agents = plan.nodes.filter((node: any) => node.kind === "agent");
  assert.equal(agents.every((node: any) => node.executor.modelBindingId === f.model.id && node.executor.runnerId === "builtin"), true);
  assert.ok(agents.reduce((sum: bigint, node: any) => sum + BigInt(node.budget.maxCostMinorUnits), 0n) <= 500n);
  assert.deepEqual((await f.send(`${f.path}/plan-revisions`, f.request, "team-plan")).body.data, planned.body.data);
  const injected = await f.send(`${f.path}/plan-revisions`, { ...f.request, expectedStreamVersion: 2, nodes: [{ id: "unbounded" }] });
  assert.ok(injected.status >= 400);
  assert.equal((await f.store.transact("local", tx => tx.listProjections("execution"))).length, 0);
});

test("团队启动持久化协调意图，暂停与恢复不创建新修订或重置额度", async t => {
  const f = await fixture(t);
  const planned = await f.send(`${f.path}/plan-revisions`, f.request);
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const input = { workspaceId: f.workspace.id, expectedStreamVersion: planned.body.data.goal.streamVersion, command: "start",
    planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest };
  const started = await f.send(`${f.path}/commands`, input, "team-start");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.ok(started.body.data.goal.coordinationRef.runId);
  assert.equal(started.body.data.goal.executionRef, undefined);
  assert.deepEqual((await f.send(`${f.path}/commands`, input, "team-start")).body.data, started.body.data);
  const paused = await f.send(`${f.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: started.body.data.goal.streamVersion, command: "pause" });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.data.goal.status, "paused");
  const nodes = await f.send(`${f.path}/nodes?workspaceId=${f.workspace.id}`);
  assert.equal(nodes.status, 200, JSON.stringify(nodes.body));
  assert.ok(nodes.body.data.allowedActions.includes("resume"));
  const resumed = await f.send(`${f.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: paused.body.data.goal.streamVersion, command: "resume" });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.deepEqual(resumed.body.data.goal.coordinationRef, started.body.data.goal.coordinationRef);
  assert.equal((await f.store.transact("local", tx => tx.listProjections("coordination.group"))).length, 1);
});

function worker(f: Awaited<ReturnType<typeof fixture>>, modelInvoker: ByokModelInvoker) {
  return new AgentOsWorker({ id: 'team-worker', store: f.store,
    lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' },
    handlers: { 'agent.execution.run': createKernelAgentTurnHandler({ store: f.store, approvalKernel: f.host.kernel,
      secretStore: { async read() { return 'fixture'; } },
      runtimeProtection: { cas: f.cas, keyProvider: f.keyProvider, validateContextSource: validateBusinessContextSource }, assertExecutionResources: assertGoalExecutionResources,
      resolveThreadContext: createOpcModelContextReader({ store: f.store, cas: f.cas, protectedPayloadKeyProvider: f.keyProvider }),
      codingSandboxRoot: join(f.directory, 'sandboxes'), modelInvoker,
      modelQuoter: async () => ({ inputTokenLimit: 2000, maxOutputTokens: 500, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '0', cachedInputNanoMinorUnitsPerToken: '0', outputNanoMinorUnitsPerToken: '0' } }),
    }) } });
}
async function startTeam(f: Awaited<ReturnType<typeof fixture>>, templateId = 'research-summary') {
  const planned = await f.send(`${f.path}/plan-revisions`, { ...f.request, templateId });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const started = await f.send(`${f.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: planned.body.data.goal.streamVersion,
    command: 'start', planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return started.body.data;
}
async function drive(f: Awaited<ReturnType<typeof fixture>>, runner: AgentOsWorker, done: (detail: any) => boolean) {
  const deadline = Date.now() + 15_000;
  let latest: any;
  while (Date.now() < deadline) {
    await runner.pollOnce();
    latest = await f.send(`${f.path}?workspaceId=${f.workspace.id}`);
    if (latest.status === 200 && done(latest.body.data)) return latest.body.data;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const attempts = await f.store.transact('local', tx => tx.listProjections<CoordinationAttemptV2>('coordination.attempt'));
  const executions = await f.store.transact('local', tx => tx.listProjections<Execution>('execution').map(item => ({ id: item.id, status: item.status })));
  assert.fail(JSON.stringify({ latest: latest?.body?.data?.goal ?? latest, attempts, executions }));
}
for (const reviewDecision of ['pass', 'needs_revision'] as const) test(`研究团队真实 Worker 完成取证、汇总和独立复核：${reviewDecision}`, async t => {
  const f = await fixture(t, 10), received: string[] = [];
  const runner = worker(f, async input => {
    const prompt = JSON.stringify(input.request.messages); received.push(prompt);
    return { text: prompt.includes('当前职责：独立复核') ? JSON.stringify({ decision: reviewDecision, findings: [] }) : '合成研究结论；尚无外部证据，不将假设作为事实。',
      toolCalls: [], usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 20 } };
  });
  const started = await startTeam(f);
  const finished = await drive(f, runner, detail => ['awaiting_acceptance', 'failed'].includes(detail.goal.status));
  assert.equal(finished.goal.status, reviewDecision === 'pass' ? 'awaiting_acceptance' : 'failed');
  assert.equal(received.length, 4);
  assert.equal(finished.goal.reservation.actual.tokens, 160);
  const attempts = await f.store.transact('local', tx => tx.listProjections<CoordinationAttemptV2>('coordination.attempt'));
  assert.equal(new Set(attempts.map(item => item.threadId)).size, 4);
  assert.equal(attempts.every(item => item.reservation.status === 'settled'), true);
  const progress = await f.send(`${f.path}/nodes?workspaceId=${f.workspace.id}`);
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  const nodes = progress.body.data;
  if (reviewDecision === 'pass') {
    assert.equal(nodes.nodes.every((node: any) => node.status === 'completed'), true);
    const accepted = await f.send(`${f.path}/acceptances`, { workspaceId: f.workspace.id, expectedStreamVersion: finished.goal.streamVersion,
      deliverySetId: finished.deliverySet.id, criteriaVersion: finished.goal.criteriaVersion,
      items: finished.deliverySet.items.map((item: any) => ({ key: item.key, digest: item.digest, reviewedCriterionIds: ['sources'] })) });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.goal.status, 'accepted');
  } else {
    assert.equal(finished.deliverySet, null);
    assert.equal(nodes.nodes.find((node: any) => node.nodeId === 'handoff').status, 'pending');
  }
  const bypass = await f.send(`/v2/executions/${attempts[0]!.executionId}/commands`, { command: 'follow_up', message: '重新执行', expectedStreamVersion: 1 });
  assert.equal(bypass.body.code, 'GOAL_EXECUTION_ENTRY_REQUIRED');
  assert.equal(started.goal.coordinationRef.runId, finished.goal.coordinationRef.runId);
});

test('经营团队等候人工事实确认，确认动作不写入经营成交或收款状态', async t => {
  const f = await fixture(t, 10);
  const runner = worker(f, async input => ({ text: JSON.stringify(input.request.messages).includes('当前职责：独立复核')
    ? JSON.stringify({ decision: 'pass', findings: [] }) : '需求与方案候选，须核对业务事实。', toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } }));
  await startTeam(f, 'business-proposal');
  const waiting = await drive(f, runner, detail => detail.goal.status === 'waiting_approval');
  const nodes = await f.send(`${f.path}/nodes?workspaceId=${f.workspace.id}`);
  assert.equal(nodes.body.data.nodes.find((node: any) => node.nodeId === 'confirm').status, 'awaiting_decision');
  const confirmed = await f.send(`${f.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: waiting.goal.streamVersion,
    command: 'decide', nodeId: 'confirm', decision: 'continue' });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const finished = await drive(f, runner, detail => detail.goal.status === 'awaiting_acceptance');
  assert.equal(finished.goal.reservation.actual.tokens, 60);
  assert.equal((await f.store.transact('local', tx => tx.listProjections('opc.business'))).length, 0);
});

test('同一父会话有团队活动时，单执行者目标不能并行绕过会话占用', async t => {
  const f = await fixture(t);
  await startTeam(f);
  const created = await f.send(`/v2/workspaces/${f.workspace.id}/goals`, {
    threadId: f.created.goal.threadId, objective: '第二个目标', resourceRefs: [], budget: f.created.goal.budget, deliverables: f.created.goal.deliverables,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `/v2/goals/${created.body.data.goal.id}`;
  const planned = await f.send(`${path}/plan-revisions`, { workspaceId: f.workspace.id, expectedStreamVersion: 1, modelBindingId: f.model.id });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const started = await f.send(`${path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: planned.body.data.goal.streamVersion,
    command: 'start', planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest });
  assert.equal(started.body.code, 'GOAL_THREAD_BUSY');
  assert.equal((await f.store.transact('local', tx => tx.listProjections('execution'))).length, 0);
});
