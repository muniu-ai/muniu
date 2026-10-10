// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256, type KernelTransaction } from '@mn/kernel';
import { createGoalOutputAccess,createGoalOutputReader } from '../src/goal-output-access.js';

function fixture() {
  const records = new Map<string, any>(), scope = { tenantId: 't', workspaceId: 'w', principalId: 'u' };
  const put = (ns: string, id: string, value: any) => records.set(`${ns}:${id}`, value);
  const tx = { getProjection: (ns: string, id: string) => records.get(`${ns}:${id}`), listProjections: (ns: string) => [...records].filter(([key]) => key.startsWith(`${ns}:`)).map(([, value]) => value), putProjection() { throw Error('read must not write'); } } as unknown as KernelTransaction;
  put('workspace', 'w', { id: 'w', tenantId: 't', activePluginIds: ['opc'] });
  put('principal', 'u', { id: 'u', tenantId: 't', kind: 'human' });
  put('membership', 'w:u', { tenantId: 't', workspaceId: 'w', principalId: 'u', workspaceRole: 'owner', streamVersion: 1 });
  const source = { namespace: 'asset', resourceId: 'a', streamVersion: 1, digest: sha256('source') };
  put('asset', 'a', { id: 'a', tenantId: 't', workspaceId: 'w', streamVersion: 1, digest: source.digest });
  const proposal = { key: 'review', title: '复盘候选', rationale: '核对资料', command: { type: 'review.record', reviewId: 'r', period: { start: '2026-10-01', end: '2026-10-10' }, explanation: '复盘', nextDecisions: ['核对交付'] }, evidenceRefs: [source] };
  const specs = [{ key: 'report', title: '报告', required: true, criteria: [{ id: 'complete', description: '完整' }] }];
  const planBody = { id: 'p', goalId: 'g', threadId: 'th', criteriaVersion: 'criteria', deliverables: specs, resourceRefs: [source], outputFormat: 'items-v1' };
  const plan = { ...planBody, digest: sha256(planBody) }; put('goal.plan', 'p', plan);
  const raw = { key: 'report', resourceRef: { namespace: 'goal.result', resourceId: 'r', streamVersion: 1, digest: sha256('raw') }, digest: sha256('raw'), criteriaVersion: 'criteria', preview: JSON.stringify({ format: 'muniu.goal-delivery.v1', items: [{ key: 'report', text: '固定报告', proposals: [proposal] }] }), sourceRefs: [source], checks: [] };
  put('goal.result', 'r', { tenantId: 't', workspaceId: 'w', streamVersion: 1, digest: raw.digest });
  const producedBody = { id: `goal-produced:${sha256(['g', 'p', 'report'])}`, tenantId: 't', workspaceId: 'w', goalId: 'g', planRevisionId: 'p', streamVersion: 1, key: 'report', text: '固定报告', proposals: [proposal], source: raw };
  const produced = { ...producedBody, digest: sha256(producedBody) }; put('goal.producedOutput', produced.id, produced);
  const output = { key: 'report', resourceRef: { namespace: 'goal.producedOutput', resourceId: produced.id, streamVersion: 1, digest: produced.digest }, digest: produced.digest, criteriaVersion: 'criteria', preview: produced.text, sourceRefs: [...raw.sourceRefs, raw.resourceRef], checks: [], businessProposals: [{ key: 'review', title: '复盘候选', commandType: 'review.record' }] };
  const deliveryBody = { goalId: 'g', planRevisionId: 'p', criteriaVersion: 'criteria', items: [output] }, digest = sha256(deliveryBody);
  const delivery = { ...deliveryBody, id: `goal-delivery-${digest}`, digest, createdAt: '2026-10-10' }; put('goal.deliverySet', delivery.id, delivery);
  const goal = { id: 'g', ...scope, threadId: 'th', planRevisionId: 'p', deliverySetId: delivery.id, criteriaVersion: 'criteria', resourceRefs: [source], status: 'awaiting_acceptance', streamVersion: 5 }; put('goal.state', 'g', goal);
  const origin = { goalId: 'g', planRevisionId: 'p', deliverySetId: delivery.id, outputKey: 'report', outputDigest: output.digest };
  let verified = 0, verifiedPlanId: string | undefined;
  const access = createGoalOutputAccess({ assertDelivery(_tx, context, purpose) { verified++; verifiedPlanId = context.goal.planRevisionId; assert.equal(context.goal.id, 'g'); assert.ok(['read', 'create', 'apply'].includes(purpose)); } });
  const read = (purpose: 'read' | 'create' | 'apply' = 'read', selected = origin) => access.readOutput(tx, scope, selected, purpose);
  return { records, put, tx, scope, plan, goal, produced, source, raw, output, delivery, origin, proposal, read, verified: () => verified, verifiedPlanId: () => verifiedPlanId };
}

test('固定成果只读返回提议，完整调用权威证据校验且不隐式冻结', () => {
  const f = fixture(), before = sha256([...f.records]);
  assert.deepEqual(f.read().proposals, [f.proposal]); assert.equal(f.verified(), 1); assert.equal(f.read().accepted, false);
  assert.equal(sha256([...f.records]), before);
  f.records.delete(`goal.producedOutput:${f.produced.id}`);
  assert.throws(() => f.read(), { code: 'GOAL_RESOURCE_CHANGED' });
});
test('跨工作区、错误计划、成果集合、key与digest，以及被篡改的固定成果均拒绝', () => {
  for (const override of [{ planRevisionId: 'other' }, { deliverySetId: 'other' }, { outputKey: 'other' }, { outputDigest: 'f'.repeat(64) }]) {
    const f = fixture(); assert.throws(() => f.read('read', { ...f.origin, ...override }));
  }
  const f = fixture(); f.put('goal.state', 'g', { ...f.goal, workspaceId: 'other' }); assert.throws(() => f.read());
  const g = fixture(); g.put('goal.producedOutput', g.produced.id, { ...g.produced, proposals: [] }); assert.throws(() => g.read());
});
test('来源撤权与当前成员撤权立即阻断读取，旧计划只能历史读取而不能新采纳', () => {
  const f = fixture(); f.put('assetTombstone', 'a', {}); assert.throws(() => f.read(), { code: 'GOAL_RESOURCE_REVOKED' });
  const g = fixture(); g.put('membership', 'w:u', { removedAt: 'now' }); assert.throws(() => g.read());
  const h = fixture(); h.put('goal.state', 'g', { ...h.goal, planRevisionId: 'next' }); assert.throws(() => h.read('apply'), { code: 'OPC_CANDIDATE_STALE' });
});
test('逐项接收必须匹配成果与全部验收项，最新暂缓覆盖接收；业务或goal状态不代替验收', () => {
  const f = fixture(); f.put('goal.state', 'g', { ...f.goal, status: 'accepted' }); assert.equal(f.read().accepted, false);
  const decision = { id: 'd1', tenantId: 't', workspaceId: 'w', goalId: 'g', deliverySetId: f.delivery.id, criteriaVersion: 'criteria', principalId: 'u', decidedAt: 'now', goalStreamVersion: 6, items: [{ key: 'report', digest: f.output.digest, decision: 'accept', reviewedCriterionIds: ['complete'] }] };
  f.put('goal.deliveryDecision', 'd1', decision); assert.equal(f.read().accepted, true);
  f.put('goal.deliveryDecision', 'd2', { ...decision, id: 'd2', goalStreamVersion: 7, items: [{ key: 'report', digest: f.output.digest, decision: 'defer' }] }); assert.equal(f.read().accepted, false);
  f.records.delete('goal.deliveryDecision:d2'); f.put('goal.deliveryDecision', 'd1', { ...decision, items: [{ ...decision.items[0], reviewedCriterionIds: [] }] }); assert.equal(f.read().accepted, false);
});
test('旧整体接收凭据仍可确认对应成果；原始JSON仅在显式格式启用时解析', () => {
  const f = fixture(); f.put('goal.deliveryAcceptance', 'a1', { id: 'a1', goalId: 'g', deliverySetId: f.delivery.id, criteriaVersion: 'criteria', principalId: 'u', acceptedAt: 'now', items: [{ key: 'report', digest: f.output.digest, reviewedCriterionIds: ['complete'] }] });
  f.put('goal.state', 'g', { ...f.goal, acceptanceId: 'a1' }); assert.equal(f.read().accepted, true);
  const installRaw = (format: boolean) => {
    const { digest: _digest, outputFormat: _format, ...body } = f.plan; const next = { ...body, ...(format ? { outputFormat: 'items-v1' } : {}) };
    f.put('goal.plan', 'p', { ...next, digest: sha256(next) });
    const bodySet = { goalId: 'g', planRevisionId: 'p', criteriaVersion: 'criteria', items: [f.raw] }, digest = sha256(bodySet), id = `goal-delivery-${digest}`;
    f.put('goal.deliverySet', id, { ...bodySet, digest, id, createdAt: 'now' }); f.put('goal.state', 'g', { ...f.goal, deliverySetId: id });
    return { ...f.origin, deliverySetId: id, outputDigest: f.raw.digest };
  };
  assert.equal(f.read('read', installRaw(false)).proposals.length, 0);
  assert.equal(f.read('read', installRaw(true)).proposals.length, 1);
});

test('返工后历史成果必须绑定受保护旧goal快照，新采纳仍拒绝旧修订', () => {
  const f = fixture(); f.put('goal.state', 'g', { ...f.goal, planRevisionId: 'next', deliverySetId: 'next-delivery' });
  assert.throws(() => f.read('read'), { code: 'GOAL_OUTPUT_INVALID' });
  const history = { id: 'g:p', tenantId: 't', workspaceId: 'w', goal: f.goal, planRevisionId: 'p', deliverySet: f.delivery };
  f.put('goal.deliveryHistory', 'g:p', history);
  assert.equal(f.read().proposals.length, 1); assert.equal(f.verifiedPlanId(), 'p');
  assert.throws(() => f.read('apply'), { code: 'OPC_CANDIDATE_STALE' });
  f.put('goal.deliveryHistory', 'g:p', { ...history, workspaceId: 'other' }); assert.throws(() => f.read());
});

test('返工保留项从原计划回源，修改项仅解析待修改交付项，候选仍绑定新集合验收', () => {
  const f = fixture(), { digest: _digest, ...body } = f.plan;
  const specs = [...f.plan.deliverables, { key: 'addition', title: '补充', required: true, criteria: [{ id: 'complete', description: '完整' }] }];
  const planBody = { ...body, id: 'p2', revision: 2, deliverables: specs }, plan = { ...planBody, digest: sha256(planBody) };
  f.put('goal.plan', 'p2', plan);
  const proposal = { ...f.proposal, key: 'new-review', title: '修订复盘' };
  const raw = { ...f.raw, key: 'addition', resourceRef: { ...f.raw.resourceRef, resourceId: 'r2', digest: sha256('raw2') }, digest: sha256('raw2'), preview: JSON.stringify({ format: 'muniu.goal-delivery.v1', items: [{ key: 'addition', text: '修订补充', proposals: [proposal] }] }) };
  f.put('goal.result', 'r2', { tenantId: 't', workspaceId: 'w', streamVersion: 1, digest: raw.digest });
  const producedBody = { id: `goal-produced:${sha256(['g', 'p2', 'addition'])}`, tenantId: 't', workspaceId: 'w', goalId: 'g', planRevisionId: 'p2', streamVersion: 1, key: 'addition', text: '修订补充', proposals: [proposal], source: raw };
  const produced = { ...producedBody, digest: sha256(producedBody) }; f.put('goal.producedOutput', produced.id, produced);
  const output = { ...f.output, key: 'addition', resourceRef: { ...f.output.resourceRef, resourceId: produced.id, digest: produced.digest }, digest: produced.digest, preview: produced.text, sourceRefs: [...raw.sourceRefs, raw.resourceRef], businessProposals: [{ key: proposal.key, title: proposal.title, commandType: proposal.command.type }] };
  const setBody = { goalId: 'g', planRevisionId: 'p2', criteriaVersion: 'criteria', items: [f.output, output] }, digest = sha256(setBody), id = `goal-delivery-${digest}`;
  const set = { ...setBody, id, digest, createdAt: 'now' }; f.put('goal.deliverySet', id, set);
  f.put('goal.state', 'g', { ...f.goal, planRevisionId: 'p2', deliverySetId: id });
  f.put('goal.deliveryHistory', 'g:p', { id: 'g:p', tenantId: 't', workspaceId: 'w', goal: f.goal, planRevisionId: 'p', deliverySet: f.delivery });
  f.put('goal.rework', 'rw', { id: 'rw', goalId: 'g', planRevisionId: 'p2', sourcePlanRevisionId: 'p', sourceDeliverySetId: f.delivery.id,
    retainedOutputs: [{ sourceDeliverySetId: f.delivery.id, key: 'report', outputDigest: f.output.digest, output: f.output }] });
  const retainedOrigin = { ...f.origin, planRevisionId: 'p2', deliverySetId: id };
  assert.equal(f.read('create', retainedOrigin).proposals[0]?.key, 'review');
  assert.equal(f.read('create', retainedOrigin).accepted, false);
  assert.equal(f.read('create', { ...retainedOrigin, outputKey: 'addition', outputDigest: output.digest }).proposals[0]?.key, 'new-review');
  f.records.delete('goal.rework:rw'); assert.throws(() => f.read('read', retainedOrigin));
});

test('中立成果读取检查已移除成员，允许只读角色且保留全部证明和响应密钥',()=>{
 const f=fixture();f.put('membership','w:u',{tenantId:'t',workspaceId:'w',principalId:'u',workspaceRole:'viewer'});
 f.put('execution','e',{id:'e',tenantId:'t',workspaceId:'w'});f.put('agent-runtime','e',{records:[{protectedPayloadRef:'response-key'}]});f.put('protectedPayloadKey','response-key',{id:'response-key'});
 const reader=createGoalOutputReader({assertDelivery(tx){tx.getProjection('execution','e');}}),read=()=>reader.readOutput(f.tx,f.scope,f.origin,'read');
 const proof=read();assert.ok(proof.proof.projections.some(x=>x.namespace==='goal.plan'));assert.deepEqual(proof.proof.protectedPayloadRefs,['response-key']);
 f.records.delete('protectedPayloadKey:response-key');assert.throws(read,{code:'CONTEXT_SOURCE_REVOKED'});
 f.put('membership','w:u',{tenantId:'t',workspaceId:'w',principalId:'u',workspaceRole:'owner',removedAt:'now'});assert.throws(read,{code:'WORKSPACE_ACCESS_DENIED'});
});
