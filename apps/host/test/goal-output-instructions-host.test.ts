// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendKernelEvent, sha256 } from '@mn/kernel';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { AgentOsWorker, createKernelAgentTurnHandler, createProtectedRuntimeStore } from '@mn/worker';
import { createAgentOsHost } from '../src/host.js';
import { assertGoalExecutionResources } from '../src/goal-runtime.js';
import { validateBusinessContextSource } from '../src/business-context.js';
import { createOpcModelContextReader } from '../src/opc-model-context.js';

test('实际模型请求先保存三个描述性候选 schema 与摘要，经营写命令不成为工具', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mn-output-schema-'));
  const store = new SqliteStorage({ databaseFile: join(directory, 'state.sqlite'), hmacKey: Buffer.alloc(32, 65) });
  const cas = new FileCas({ rootDir: join(directory, 'cas') }), keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 66));
  const secretStore = { async save() { return 'keychain://muniu.v2/output-schema'; }, async read() { return 'fixture'; } };
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider, secretStore, goalPollIntervalMs: 60_000 });
  t.after(async () => { await host.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const workspace = await host.kernel.createWorkspace('local', 'local-owner', randomUUID(), { name: '候选描述约束', viewMode: 'business', pluginIds: ['opc'] });
  const model = await host.kernel.saveModelConnection('local', 'local-owner', randomUUID(), { presetId: 'deepseek', displayName: '合成模型',
    secretRef: 'keychain://muniu.v2/output-schema', defaultModel: 'deepseek-v4-flash', discoveredModels: ['deepseek-v4-flash'] });
  await store.transact('local', tx => {
    tx.putProjection('modelConnection', model.id, { ...model, status: 'ready', streamVersion: 2 });
    appendKernelEvent(tx, { tenantId: 'local', aggregateType: 'modelConnection', aggregateId: model.id, expectedStreamVersion: 1,
      type: 'fixture.model_ready', actorId: 'local-owner', generation: 0, correlationId: randomUUID(), publicPayload: {} });
  });
  const send = async (path: string, body: unknown) => {
    const response = await host.dispatch(new Request(`http://fixture${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) }));
    const result = await response.json() as any;
    assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(result)); return result.data;
  };
  const thread = await host.kernel.createThread('local', 'local-owner', randomUUID(), { workspaceId: workspace.id, subject: '生成交付', pluginId: 'opc' });
  const created = await send(`/v2/workspaces/${workspace.id}/goals`, { threadId: thread.id, objective: '整理方案，不登记业务事实', resourceRefs: [],
    budget: { maxTokens: 60000, maxCostMinorUnits: '1000', currency: 'CNY', maxDurationMs: 120000 },
    deliverables: [{ key: 'report', title: '方案', required: true, criteria: [{ id: 'complete', description: '完整说明' }] }] });
  const path = `/v2/goals/${created.goal.id}`;
  const planned = await send(`${path}/plan-revisions`, { workspaceId: workspace.id, expectedStreamVersion: created.goal.streamVersion, modelBindingId: model.id });
  await send(`${path}/commands`, { workspaceId: workspace.id, expectedStreamVersion: planned.goal.streamVersion, command: 'start', planRevisionId: planned.plan.id, planDigest: planned.plan.digest });
  let invoked = 0, verified = false;
  const worker = new AgentOsWorker({ id: 'schema-worker', store,
    lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' },
    handlers: { 'agent.execution.run': createKernelAgentTurnHandler({ store, approvalKernel: host.kernel, secretStore,
      runtimeProtection: { cas, keyProvider, validateContextSource: validateBusinessContextSource }, assertExecutionResources: assertGoalExecutionResources,
      resolveThreadContext: createOpcModelContextReader({ store, cas, protectedPayloadKeyProvider: keyProvider }), codingSandboxRoot: join(directory, 'sandboxes'),
      modelInvoker: async ({ request }) => {
        invoked++;
        const records = await createProtectedRuntimeStore({ store, cas, keyProvider, tenantId: 'local', workspaceId: workspace.id }).readExecution(request.executionId);
        const persisted = records.filter(record => record.type === 'model/request').at(-1)!;
        assert.deepEqual(persisted.payload.messages, request.messages, '约束随实际请求完整保存');
        const text = request.messages.map(message => message.content).join('\n');
        const schemaLine = text.split('\n').find(line => line.startsWith('经营候选命令 schema：'));
        assert.ok(schemaLine, '实际请求必须包含候选命令的完整 schema');
        const schema = JSON.parse(schemaLine.slice('经营候选命令 schema：'.length));
        assert.ok(text.includes(`经营候选命令 schema 摘要：${sha256(schema)}`));
        const [quote, delivery, review] = schema.oneOf;
        assert.deepEqual(schema.oneOf.map((item: any) => item.properties.type.const), ['quote.create', 'delivery.record', 'review.record']);
        assert.ok(quote.required.includes('serviceVersion')); assert.equal(quote.properties.serviceVersion.minimum, 1);
        assert.equal(quote.properties.discountMinor.type, 'string'); assert.equal(quote.additionalProperties, false);
        assert.equal(delivery.properties.progressPercent.maximum, 100);
        assert.deepEqual(review.properties.period.required, ['start', 'end']); assert.ok(review.required.includes('nextDecisions'));
        assert.deepEqual(request.availableToolIds, [], '描述不授予经营写工具');
        verified = true;
        return { text: JSON.stringify({ format: 'muniu.goal-delivery.v1', items: [{ key: 'report', text: '内部分析说明', proposals: [] }] }), toolCalls: [], usage: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 60 } };
      },
      modelQuoter: async () => ({ inputTokenLimit: 10000, maxOutputTokens: 2500, rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '0', cachedInputNanoMinorUnitsPerToken: '0', outputNanoMinorUnitsPerToken: '0' } }),
    }) } });
  const result = await worker.pollOnce();
  assert.equal(invoked, 1); assert.equal(verified, true, JSON.stringify(result));
  assert.equal(result.status, 'completed', JSON.stringify(result));
});
