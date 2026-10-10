// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { CODING_RUNNER_CONFIGURATION_NAMESPACE } from '@mn/contracts';
import { sha256, type KernelTransaction } from '@mn/kernel';
import { externalGoalRunnerBindingValid, readCoordinatedExternalUsage } from '../src/goal-external-rework.js';
import { currentTeamCapabilities } from '../src/team-planning.js';
function fixture() {
  const values = new Map<string, any>(), put = (ns: string, id: string, value: any) => values.set(`${ns}:${id}`, value);
  const tx = { getProjection: (ns: string, id: string) => values.get(`${ns}:${id}`) } as unknown as KernelTransaction;
  const identity = { version: 'fixture', sha256: 'a'.repeat(64) }, configuration = { tenantId: 't', workspaceId: 'w', status: 'confirmed', streamVersion: 2, identity, identityDigest: sha256(identity) };
  put(CODING_RUNNER_CONFIGURATION_NAMESPACE, 'w:codex-cli', configuration);
  put('workspace', 'w', { tenantId: 't', activePluginIds: ['opc', 'runner-codex-cli'] });
  const executor = { pluginId: 'opc', pluginVersion: '0.2.0', agentDefinitionId: 'opc.business-assistant', runnerId: 'codex-cli', modelBindingId: 'runner:codex-cli', model: 'CLI 自有模型', modelConnectionStreamVersion: 2, runnerBinding: { configurationStreamVersion: 2, identityDigest: configuration.identityDigest }, toolIds: ['runner.codex.execute'], autoAllowedEffects: ['local_read'], dataScopes: [] } as any;
  const execution = { id: 'e', tenantId: 't', workspaceId: 'w', runnerId: 'codex-cli', generation: 1 } as any;
  const attempt = { id: 'a', tenantId: 't', workspaceId: 'w', executionId: 'e', generation: 1, runId: 'run', reservation: { budget: { currency: 'CNY' } } } as any;
  const goal = { id: 'g', tenantId: 't', workspaceId: 'w', budget: { currency: 'CNY' } } as any;
  const options = { definitions: [{ id: 'opc', version: '0.2.0', contributions: { agents: [{ id: 'opc.business-assistant' }], tools: [] } }, { id: 'runner-codex-cli', version: '0.2.0', contributions: { tools: [{ id: 'runner.codex.execute', effectClass: 'external_side_effect' }] } }], sandboxAvailable: true } as any;
  const plan = { kind: 'single-v2', nodes: [{ id: 'execute', kind: 'agent', roleId: 'execute', executor }] } as any;
  return { put, tx, values, configuration, executor, execution, attempt, goal, options, plan };
}
test('外部单节点费用缺少确切账单时未知，不能按零元结算', () => {
  const f = fixture(); assert.equal(readCoordinatedExternalUsage(f.tx, f.attempt, f.execution), undefined);
  const receipt = { tenantId: 't', workspaceId: 'w', executionId: 'e', generation: 1, attemptId: 'a', runId: 'run', usage: { tokens: 4, costMinorUnits: '7', currency: 'CNY' } };
  f.put('goal.externalUsage', 'e', receipt); assert.deepEqual(readCoordinatedExternalUsage(f.tx, f.attempt, f.execution), receipt.usage);
  for (const update of [{ workspaceId: 'other' }, { attemptId: 'other' }, { generation: 2 }, { usage: { ...receipt.usage, costMinorUnits: '-1' } }]) {
    f.put('goal.externalUsage', 'e', { ...receipt, ...update }); assert.throws(() => readCoordinatedExternalUsage(f.tx, f.attempt, f.execution));
  }
});
test('返工 CLI 身份和配置固定，插件停用或身份变化即拒绝', () => {
  const f = fixture(); assert.equal(externalGoalRunnerBindingValid(f.tx, f.goal, f.executor), true);
  f.put(CODING_RUNNER_CONFIGURATION_NAMESPACE, 'w:codex-cli', { ...f.configuration, streamVersion: 3 }); assert.equal(externalGoalRunnerBindingValid(f.tx, f.goal, f.executor), false);
  f.put(CODING_RUNNER_CONFIGURATION_NAMESPACE, 'w:codex-cli', f.configuration); f.put('workspace', 'w', { tenantId: 't', activePluginIds: ['opc'] });
  assert.equal(externalGoalRunnerBindingValid(f.tx, f.goal, f.executor), false);
});
test('仅单节点返工允许无 BYOK CLI，能力明确费用未知并始终要求沙箱', () => {
  const f = fixture(), capability = currentTeamCapabilities(f.options, f.tx, f.goal, f.plan)[0]!;
  assert.equal(capability.costControl, 'unknown'); assert.equal(capability.isolation, 'required_sandbox'); assert.deepEqual(capability.runnerIds, ['codex-cli']);
  assert.throws(() => currentTeamCapabilities(f.options, f.tx, f.goal, { ...f.plan, kind: 'team-v1' }));
  assert.throws(() => currentTeamCapabilities(f.options, f.tx, f.goal, { ...f.plan, nodes: [...f.plan.nodes, { ...f.plan.nodes[0], id: 'other' }] }));
  f.options.definitions[1].contributions.tools[0].effectClass = 'local_read'; assert.throws(() => currentTeamCapabilities(f.options, f.tx, f.goal, f.plan));
});
