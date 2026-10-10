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
import { validateHostContextSource } from "../src/context-source-validation.js";
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

function worker(f: Awaited<ReturnType<typeof fixture>>, modelInvoker: ByokModelInvoker) {
  return new AgentOsWorker({ id: 'team-worker', store: f.store,
    lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' },
    handlers: { 'agent.execution.run': createKernelAgentTurnHandler({ store: f.store, approvalKernel: f.host.kernel,
      secretStore: { async read() { return 'fixture'; } },
      runtimeProtection: { cas: f.cas, keyProvider: f.keyProvider, validateContextSource: validateHostContextSource }, assertExecutionResources: assertGoalExecutionResources,
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
  const deadline = Date.now() + 30_000;
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

async function acceptedSource(f: Awaited<ReturnType<typeof fixture>>) {
  const runner = worker(f, async input => ({ text: JSON.stringify(input.request.messages).includes('当前职责：独立复核') ? JSON.stringify({ decision: 'pass', findings: [] }) : '合成证据，缺少外部验证。', toolCalls: [], usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 20 } }));
  await startTeam(f); const finished = await drive(f, runner, detail => detail.goal.status === 'awaiting_acceptance');
  const accepted = await f.send(`${f.path}/acceptances`, { workspaceId: f.workspace.id, expectedStreamVersion: finished.goal.streamVersion, deliverySetId: finished.deliverySet.id, criteriaVersion: finished.goal.criteriaVersion,
    items: finished.deliverySet.items.map((item: any) => ({ key: item.key, digest: item.digest, reviewedCriterionIds: ['sources'] })) });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body)); return accepted.body.data;
}
test('已接收团队保存技能，新目标实际调用固定角色版本并保留来源；新版本不改变在途执行', async t => {
  const f = await fixture(t, 10), source = await acceptedSource(f);
  const collection = `/v2/workspaces/${f.workspace.id}/team-skills`;
  const input = { skillId: 'research-process', expectedStreamVersion: 0, source: { goalId: source.goal.id, planRevisionId: source.plan.id, deliverySetId: source.deliverySet.id, deliveryDigest: source.deliverySet.digest },
    title: '研究流程', description: '从接收的研究任务提取流程', roles: [{ nodeId: 'review', instructions: 'SKILL-V1：独立检查未解决的反证。', sourceRefs: [] }] };
  const saved = await f.send(collection, input); assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const version = saved.body.data.version, ref = { id: version.skillId, version: version.version, digest: version.digest };
  assert.equal(saved.body.data.validation, 'unmeasured'); assert.equal(saved.body.data.activation.recommendationEnabled, false);
  const thread = await f.host.kernel.createThread('local', 'local-owner', randomUUID(), { workspaceId: f.workspace.id, subject: '新研究', pluginId: 'opc' });
  const created = await f.send(`/v2/workspaces/${f.workspace.id}/goals`, { threadId: thread.id, objective: '研究新的目标', resourceRefs: [], budget: f.created.goal.budget, deliverables: f.created.goal.deliverables });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const next = { ...f, path: `/v2/goals/${created.body.data.goal.id}` };
  const planned = await next.send(`${next.path}/plan-revisions`, { ...f.request, skillRef: ref });
  assert.equal(planned.status, 200, JSON.stringify(planned.body)); assert.deepEqual(planned.body.data.plan.skillRef, ref);
  const started = await next.send(`${next.path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: planned.body.data.goal.streamVersion, command: 'start', planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const newer = await f.send(collection, { ...input, expectedStreamVersion: 1, roles: [{ nodeId: 'review', instructions: 'SKILL-V2：新版本未授权给在途目标。', sourceRefs: [] }] });
  assert.equal(newer.status, 201, JSON.stringify(newer.body));
  const prompts: string[] = [], runner = worker(f, async input => { const prompt = JSON.stringify(input.request.messages); prompts.push(prompt); return { text: prompt.includes('当前职责：独立复核') ? JSON.stringify({ decision: 'pass', findings: [] }) : '合成证据，缺少外部验证。', toolCalls: [], usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 20 } }; });
  const finished = await drive(next, runner, detail => ['awaiting_acceptance', 'failed'].includes(detail.goal.status));
  assert.equal(finished.goal.status, 'awaiting_acceptance'); assert.equal(prompts.length, 4);
  assert.match(prompts.find(text => text.includes('当前职责：独立复核'))!, /SKILL-V1/u); assert.doesNotMatch(JSON.stringify(prompts), /SKILL-V2/u);
  const sources = finished.deliverySet.items.flatMap((item: any) => item.sourceRefs);
  assert.ok(sources.some((item: any) => item.namespace === 'team.skillVersion' && item.resourceId === version.id && item.digest === ref.digest));
  assert.deepEqual(finished.plan.skillRef, ref);
});

test('角色摘录来源在模型调用期间撤权，后继与正文读取停止且已发生用量仍结算', async t => {
  const f = await fixture(t, 10), source = await acceptedSource(f);
  const uploaded = await f.send('/v2/assets', { workspaceId: f.workspace.id, expectedStreamVersion: 0, attachments: [{ fileName: 'role.md', mediaType: 'text/markdown', protected: true, contentBase64: Buffer.from('ROLE-SECRET：核对试验资料。').toString('base64') }] });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body)); const asset = uploaded.body.data[0];
  const material = { namespace: 'asset', resourceId: asset.id, streamVersion: asset.streamVersion, digest: asset.digest };
  const collection = `/v2/workspaces/${f.workspace.id}/team-skills`;
  const saved = await f.send(collection, { skillId: 'source-bound', expectedStreamVersion: 0, source: { goalId: source.goal.id, planRevisionId: source.plan.id, deliverySetId: source.deliverySet.id, deliveryDigest: source.deliverySet.digest }, title: '带摘录的研究', description: '摘录需要当前来源授权', roles: [{ nodeId: 'research-primary', instructions: 'ROLE-SECRET：核对试验资料。', sourceRefs: [material] }] });
  assert.equal(saved.status, 201, JSON.stringify(saved.body)); const version = saved.body.data.version;
  const thread = await f.host.kernel.createThread('local', 'local-owner', randomUUID(), { workspaceId: f.workspace.id, subject: '来源撤权试用', pluginId: 'opc' });
  const created = await f.send(`/v2/workspaces/${f.workspace.id}/goals`, { threadId: thread.id, objective: '研究新的目标', resourceRefs: [], budget: f.created.goal.budget, deliverables: f.created.goal.deliverables });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const path = `/v2/goals/${created.body.data.goal.id}`;
  const planned = await f.send(`${path}/plan-revisions`, { ...f.request, skillRef: { id: version.skillId, version: version.version, digest: version.digest } });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const started = await f.send(`${path}/commands`, { workspaceId: f.workspace.id, expectedStreamVersion: planned.body.data.goal.streamVersion, command: 'start', planRevisionId: planned.body.data.plan.id, planDigest: planned.body.data.plan.digest });
  assert.equal(started.status, 200, JSON.stringify(started.body)); let calls = 0;
  const runner = worker(f, async () => {
    calls++;
    const response = await f.host.dispatch(new Request(`http://fixture/v2/assets/${asset.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ expectedStreamVersion: asset.streamVersion, reason: '撤销摘录来源' }) }));
    assert.equal(response.status, 200, await response.text());
    return { text: 'REVOKED-DERIVATIVE 不得传播', toolCalls: [], usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 20 } };
  });
  const attempts = () => f.store.transact('local', tx => tx.listProjections<CoordinationAttemptV2>('coordination.attempt').filter(item => item.runId === started.body.data.goal.coordinationRef.runId));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { await runner.pollOnce(); const items = await attempts(); if (calls && items.every(item => item.reservation.status === 'settled')) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(calls, 1); const items = await attempts(); assert.ok(items.length <= 2); assert.ok(items.every(item => item.reservation.status === 'settled'));
  assert.equal(items.reduce((sum, item) => sum + (item.reservation.usage?.tokens ?? 0), 0), 40);
  const detail = await f.send(`${collection}/source-bound`); assert.ok(detail.status >= 400); assert.doesNotMatch(JSON.stringify(detail.body), /ROLE-SECRET/u);
  for (const attempt of items) { const read = await f.send(`/v2/workspaces/${f.workspace.id}/threads/${attempt.threadId}/turns`); assert.ok(read.status >= 400, JSON.stringify({ status: read.status, body: read.body, attempt, context: await f.store.transact('local', tx => tx.getProjection('execution.context', attempt.executionId)) })); assert.doesNotMatch(JSON.stringify(read.body), /ROLE-SECRET|REVOKED-DERIVATIVE/u); }
});
