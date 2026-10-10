// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareReport, validateBenchmark } from '../src/benchmark-comparison.mjs';
import { TEAM_SKILL_BENCHMARK } from '../src/benchmark-corpus.mjs';
test('生产内嵌评测集保留冻结60项和15条安全恢复，未实测不能通过', () => {
  const corpus = validateBenchmark(TEAM_SKILL_BENCHMARK);
  assert.equal(corpus.tasks.length, 60); assert.equal(corpus.controls.length, 15);
  assert.deepEqual(compareReport(corpus, { schemaVersion: 1, datasetVersion: '1.0.0', datasetSha256: corpus.manifest.tasksSha256, executionMode: 'not_measured', arms: [] }),
    { status: 'not_measured', releaseGate: 'not_evaluated', reason: 'NO_MEASURED_RESULTS' });
  assert.throws(() => compareReport(corpus, { schemaVersion: 1, datasetVersion: '1.0.0', datasetSha256: corpus.manifest.tasksSha256, executionMode: 'test_fixture', arms: [] }));
});

test('技能声明保留独立复核、汇合映射和交付绑定，不能替换图的语义', async () => {
  const { getTeamTemplate, extractTeamSkillDefinition, assertTeamSkillStructure, TEAM_DEFAULT_LIMITS } = await import('../src/index.js');
  const template = getTeamTemplate('research-summary');
  const plan: any = { kind: 'team-v1', template: { id: template.id, version: template.version, digest: template.digest }, pluginId: 'opc', resourceRefs: [], deliverables: [], limits: TEAM_DEFAULT_LIMITS,
    deliverableBindings: [{ deliverableKey: 'report', nodeId: 'handoff', outputKey: 'delivery.report' }],
    nodes: template.nodes.map(slot => ({ ...slot, inputs: [], outputs: [], ...(slot.kind === 'agent' ? { executor: { runnerId: 'builtin', pluginId: 'opc', agentDefinitionId: 'opc.business-assistant', toolIds: [], autoAllowedEffects: ['local_read'] }, ...(slot.id === 'review' ? { review: { independent: true, producerNodeIds: ['synthesis'] } } : {}) } : { mappings: [{ outputKey: 'delivery.report', fromNodeId: 'synthesis', fromOutputKey: 'result' }] }) })) };
  const definition: any = extractTeamSkillDefinition(plan);
  assert.deepEqual(definition.nodes.find((node: any) => node.id === 'review').review, { independent: true, producerNodeIds: ['synthesis'] });
  assert.deepEqual(definition.nodes.find((node: any) => node.id === 'handoff').mappings, plan.nodes.at(-1).mappings);
  assert.deepEqual(definition.deliverableBindings, plan.deliverableBindings);
  const changed = structuredClone(plan); changed.nodes.find((node: any) => node.id === 'review').review.producerNodeIds = ['evidence'];
  assert.throws(() => assertTeamSkillStructure(definition, changed));
});
