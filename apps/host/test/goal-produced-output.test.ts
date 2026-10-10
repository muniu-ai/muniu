// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProducedGoalItems } from '../src/goal-produced-output.js';
const specs = ['plan', 'quote'].map(key => ({ key, title: key, required: true, criteria: [{ id: 'complete', description: '完整' }] }));
const source = { namespace: 'opc.business.service', resourceId: 'service', streamVersion: 1, digest: '1'.repeat(64) };
const proposal = { key: 'quote', title: '报价候选', rationale: '按获准服务版本', command: { type: 'quote.create', quoteId: 'quote', customerId: 'customer', serviceId: 'service', serviceVersion: 1, quantity: 1, discountMinor: '0', validUntil: '2026-10-20', dueOn: '2026-10-30' }, evidenceRefs: [source] };
const encode = (items: unknown[]) => JSON.stringify({ format: 'muniu.goal-delivery.v1', items });
test('多成果逐项绑定key，旧单成果纯文本保持原内容', () => {
  assert.deepEqual(parseProducedGoalItems('原有单成果', specs.slice(0, 1), []), [{ key: 'plan', text: '原有单成果', proposals: [] }]);
  const items = parseProducedGoalItems(encode([{ key: 'plan', text: '方案正文' }, { key: 'quote', text: '报价说明', proposals: [proposal] }]), specs, [source]);
  assert.equal(items[0]?.text, '方案正文');
  assert.equal(items[1]?.proposals[0]?.key, 'quote');
});
test('多成果缺失、重复、额外key或混淆字段均拒绝，不能复制一份正文冒充多个成果', () => {
  assert.throws(() => parseProducedGoalItems('一份正文', specs, []));
  for (const items of [[{ key: 'plan', text: '方案' }], [{ key: 'plan', text: '方案' }, { key: 'plan', text: '复制' }], [{ key: 'plan', text: '方案' }, { key: 'unknown', text: '未知' }], [{ key: 'plan', text: '方案', permission: 'all' }, { key: 'quote', text: '报价' }]])
    assert.throws(() => parseProducedGoalItems(encode(items), specs, []));
});
test('模型提议不能声明收款或使用未授权来源，金额由领域规则计算', () => {
  const parse = (value: unknown) => parseProducedGoalItems(encode([{ key: 'plan', text: '候选', proposals: [value] }]), specs.slice(0, 1), [source]);
  assert.throws(() => parse({ ...proposal, command: { type: 'payment.record', paymentId: 'payment', orderId: 'order', amountMinor: '100', receivedOn: '2026-10-10', sourceRef: 'model' } }));
  assert.throws(() => parse({ ...proposal, evidenceRefs: [{ ...source, resourceId: 'other' }] }));
  assert.throws(() => parse({ ...proposal, command: { ...proposal.command, totalMinor: '99999' } }));
});
test('候选 schema 描述不替代确定性解析，缺字段或越界仍拒绝', () => {
  const parse = (command: unknown) => parseProducedGoalItems(encode([{ key: 'plan', text: '候选', proposals: [{ ...proposal, command }] }]), specs.slice(0, 1), [source]);
  const { serviceVersion: _version, ...missingVersion } = proposal.command;
  for (const command of [missingVersion, { ...proposal.command, quantity: 10001 }, { ...proposal.command, discountMinor: 0 },
    { type: 'review.record', reviewId: 'r', period: { start: '2026-10-10' }, explanation: '复盘', nextDecisions: ['核对'] }])
    assert.throws(() => parse(command), { code: 'GOAL_OUTPUT_INVALID' });
});
