// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveReworkScope, validateDeliveryDecision, assertOutputReuse } from '../src/index.js';

const digest = 'a'.repeat(64), criteria = [{ id: 'complete', description: '覆盖要求' }];
const specs = [{ key: 'a', title: '方案', required: true, criteria }, { key: 'b', title: '说明', required: true, criteria }];
const output = (key: string) => ({ key, digest, criteriaVersion: digest, preview: '成果', resourceRef: { namespace: 'asset', resourceId: key, streamVersion: 1, digest }, sourceRefs: [], checks: [{ checkId: 'check', status: 'passed' as const, evidenceRefs: [{ namespace: 'asset', resourceId: key, streamVersion: 1, digest }] }] });
const delivery = { id: 'set', goalId: 'goal', planRevisionId: 'plan', criteriaVersion: digest, digest, createdAt: '2026-10-10T00:00:00Z', items: specs.map(spec => output(spec.key)) };
const node = (id: string, dependsOn: string[] = [], kind = 'agent') => ({ id, kind, dependsOn, inputs: [], outputs: [{ key: 'result', kind: 'artifact' }], ...(kind === 'join' ? { mappings: [{ outputKey: 'result', fromNodeId: 'producer-a', fromOutputKey: 'result' }] } : {}) });

test('逐项决定绑定成果和条款，部分接收不等于整体完成', () => {
  const items = [{ key: 'a', digest, decision: 'accept' as const, reviewedCriterionIds: ['complete'] }, { key: 'b', digest, decision: 'request_changes' as const, failedCriterionIds: ['complete'], instruction: '补齐说明' }];
  assert.deepEqual(validateDeliveryDecision({ deliverySet: delivery, specs, criteriaVersion: digest, items }), { acceptedKeys: ['a'], changedKeys: ['b'], deferredKeys: [], allRequiredAccepted: false });
  for (const bad of [items.slice(0, 1), [items[0], items[0]], [{ ...items[0], reviewedCriterionIds: [] }, items[1]], [items[0], { ...items[1], digest: 'b'.repeat(64) }]]) {
    assert.throws(() => validateDeliveryDecision({ deliverySet: delivery, specs, criteriaVersion: digest, items: bad as any }));
  }
});

test('独立检查失败的成果可要求修改，但不能直接接收', () => {
  const failed = { ...delivery, items: delivery.items.map(output => ({ ...output, checks: output.checks.map(check => ({ ...check, status: 'failed' as const })) })) };
  const items = failed.items.map(output => ({ key: output.key, digest, decision: 'accept' as const, reviewedCriterionIds: ['complete'] }));
  assert.throws(() => validateDeliveryDecision({ deliverySet: failed, specs, criteriaVersion: digest, items }), /检查/u);
  assert.doesNotThrow(() => validateDeliveryDecision({ deliverySet: failed, specs, criteriaVersion: digest,
    items: items.map(item => ({ key: item.key, digest, decision: 'request_changes', failedCriterionIds: ['complete'], instruction: '修复未通过检查的内容' })) }));
});

test('返工只影响生产者及其后继，未改动独立节点可沿用', () => {
  const plan = { nodes: [node('producer-a'), node('producer-b'), node('review', ['producer-a']), node('handoff', ['producer-a', 'review'], 'join')], deliverableBindings: [{ deliverableKey: 'a', nodeId: 'handoff', outputKey: 'result' }, { deliverableKey: 'b', nodeId: 'producer-b', outputKey: 'result' }] };
  assert.deepEqual(deriveReworkScope(plan as any, ['a']), { affectedNodeIds: ['producer-a', 'review', 'handoff'], reusableNodeIds: ['producer-b'] });
  assert.throws(() => deriveReworkScope(plan as any, ['missing']));
  assert.throws(() => deriveReworkScope({ ...plan, nodes: [node('producer-a', ['handoff']), ...plan.nodes.slice(1)] } as any, ['a']));
});

test('沿用必须保持完整版本、输入和验收条件，当前授权检查不能省略', () => {
  const input = { original: output('b'), proposed: output('b'), originalInputDigest: digest, currentInputDigest: digest, criteriaVersion: digest,
    sourceAccessValid: true, authorizationValid: true, executionCompleted: true, evidenceValid: true };
  assert.doesNotThrow(() => assertOutputReuse(input));
  for (const patch of [{ sourceAccessValid: false }, { authorizationValid: false }, { executionCompleted: false }, { evidenceValid: false }, { currentInputDigest: 'b'.repeat(64) }, { proposed: { ...output('b'), preview: '被替换' } }]) assert.throws(() => assertOutputReuse({ ...input, ...patch }));
});
