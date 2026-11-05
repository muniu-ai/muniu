// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessObjectRef, EnterpriseContractTypes } from '@mn/contracts';
import { EnterpriseBrowserClient } from '../src/client.js';
import { BusinessReferenceModel } from '../src/business-references.js';

const session = { tenantId: 'tenant', principalId: 'manager', displayName: '经理', status: 'active', organizationAdmin: false, csrfToken: 'csrf', expiresAt: '2026-12-01T00:00:00.000Z', profile: 'development' };
const ref = (objectType: BusinessObjectRef['objectType'], objectId: string, streamVersion = 1): BusinessObjectRef => ({ tenantId: 'tenant', workspaceId: 'workspace', objectType, objectId, streamVersion, digest: String(streamVersion).repeat(64) });
const customer = ref('customer', 'customer'), opportunity = ref('opportunity', 'opportunity', 2), owner = ref('quote_version', 'quote', 3);
const envelope = (data: unknown) => new Response(JSON.stringify({ data, traceId: 'synthetic' }));
const denied = () => new Response(JSON.stringify({ code: 'OBJECT_ACCESS_DENIED', message: '无权读取', action: '核对权限', traceId: 'denied', fieldIssues: [], retryable: false }), { status: 403 });
const view = (reference = owner, values: Record<string, unknown> = { customer, opportunity }) => ({ reference, values });
function caps(reference = owner, fields: readonly string[] = ['customer', 'opportunity']): EnterpriseContractTypes['EnterpriseBusinessCapabilities'] { return { reference, readableFields: fields, writableFields: [], businessApprovalFields: [], canRecordEvidence: false, people: [] }; }
async function client(reply: (request: Request) => Promise<Response> | Response) {
  const requests: Request[] = [];
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), fetch: async (input, init) => {
    const request = new Request(input, init); if (request.url.endsWith('/session')) return envelope(session); requests.push(request); return reply(request);
  } });
  await api.loadSession(); return { api, requests };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }

test('仅读取实际可见的顶层业务引用，并使用原版本接口而不是成员目录或当前版本', async () => {
  const f = await client(request => request.url.includes('/customer/') ? envelope({ reference: customer, values: { name: '原客户名称' } }) : envelope({ reference: opportunity, values: { title: '原商机名称' } }));
  const model = new BusinessReferenceModel(f.api);
  await model.load(view(owner, { customer, opportunity, contract: ref('contract', 'hidden'), ownerPrincipalId: 'other-person', lines: [{ service: ref('service_version', 'nested') }] }), caps(owner, ['customer', 'opportunity', 'ownerPrincipalId', 'lines']));
  assert.deepEqual(f.requests.map(request => new URL(request.url).pathname), ['/v2/workspaces/workspace/business/customer/customer/versions/1', '/v2/workspaces/workspace/business/opportunity/opportunity/versions/2']);
  assert.equal(model.snapshot().data?.fields.customer?.name, '原客户名称'); assert.equal(model.snapshot().data?.fields.opportunity?.name, '原商机名称');
  assert.equal(model.snapshot().data?.fields.contract, undefined); assert.equal(f.requests.some(request => request.url.includes('/members')), false);
});
test('返回版本或摘要不符时不补名，不自动升级关联引用', async () => {
  let mismatch = 'version';
  const f = await client(() => envelope({ reference: mismatch === 'version' ? { ...customer, streamVersion: 2 } : { ...customer, digest: 'f'.repeat(64) }, values: { name: '不能使用的名称' } }));
  const model = new BusinessReferenceModel(f.api);
  for (const kind of ['version', 'digest']) { mismatch = kind; await model.load(view(owner, { customer }), caps(owner, ['customer'])); assert.equal(model.snapshot().data?.fields.customer?.status, 'stale'); assert.equal(model.snapshot().data?.fields.customer?.name, undefined); }
  assert.equal(f.requests.length, 2);
});
test('撤权响应清空旧名称，字段不再可见时不再发出引用读取', async () => {
  let revoked = false;
  const f = await client(() => revoked ? denied() : envelope({ reference: customer, values: { name: '原可见名称' } })), model = new BusinessReferenceModel(f.api);
  await model.load(view(owner, { customer }), caps(owner, ['customer'])); assert.equal(model.snapshot().data?.fields.customer?.name, '原可见名称');
  revoked = true; const loading = model.load(view(owner, { customer }), caps(owner, ['customer'])); assert.equal(model.snapshot().data, undefined); await loading;
  assert.equal(model.snapshot().data?.fields.customer?.status, 'denied'); assert.equal(model.snapshot().data?.fields.customer?.name, undefined);
  await model.load(view(owner, { customer }), caps(owner, [])); assert.deepEqual(model.snapshot().data?.fields, {}); assert.equal(f.requests.length, 2);
});
test('跨租户、跨工作区或对象种类不符的引用不发出请求', async () => {
  const f = await client(() => { throw new Error('UNEXPECTED_READ'); }), model = new BusinessReferenceModel(f.api);
  for (const invalid of [{ ...customer, tenantId: 'other' }, { ...customer, workspaceId: 'other' }, ref('project', 'project')]) {
    await model.load(view(owner, { customer: invalid }), caps(owner, ['customer'])); assert.equal(model.snapshot().data?.fields.customer?.status, 'invalid');
  }
  assert.equal(f.requests.length, 0);
});
test('旧对象的延迟名称响应不会串到新对象', async () => {
  const delayed = deferred<Response>(), secondCustomer = ref('customer', 'second'), secondOwner = ref('quote_version', 'second-quote');
  const f = await client(request => request.url.includes('/customer/customer/') ? delayed.promise : envelope({ reference: secondCustomer, values: { name: '新对象的客户' } }));
  const model = new BusinessReferenceModel(f.api), old = model.load(view(owner, { customer }), caps(owner, ['customer']));
  await model.load(view(secondOwner, { customer: secondCustomer }), caps(secondOwner, ['customer']));
  delayed.resolve(envelope({ reference: customer, values: { name: '旧对象的客户' } })); await old;
  assert.equal(model.snapshot().data?.owner.objectId, 'second-quote'); assert.equal(model.snapshot().data?.fields.customer?.name, '新对象的客户');
});

test('无标题订单和经营目标使用原版本的已授权摘要，隐藏金额不补算或显示为零', async () => {
  const order = ref('order', 'actual-order', 2), objective = ref('operating_objective', 'actual-objective'), review = ref('business_review', 'actual-review');
  let visible: 'full' | 'scope' | 'empty' = 'full';
  const f = await client(request => request.url.includes('/order/') ? envelope({ reference: order, values: visible === 'full' ? { totalMinor: 29999, scopeLines: [{ title: '已授权服务', quantity: 3, unitPriceMinor: 10000 }] } : visible === 'scope' ? { scopeLines: [{ title: '已授权服务', quantity: 3 }] } : {} }) : envelope({ reference: objective, values: { targetMinor: 15000, periodStart: '2026-11-01', periodEnd: '2026-11-05' } }));
  const model = new BusinessReferenceModel(f.api);
  await model.load(view(review, { order, objective }), caps(review, ['order', 'objective']));
  const fields = model.snapshot().data!.fields;
  assert.equal(fields.order?.status, 'ready'); assert.match(fields.order!.name!, /已授权服务/u); assert.match(fields.order!.name!, /299\.99/u); assert.doesNotMatch(fields.order!.name!, /300\.00|actual-order/u);
  assert.deepEqual(fields.order!.reference, order); assert.equal(fields.objective?.status, 'ready'); assert.match(fields.objective!.name!, /150\.00/u);
  visible = 'scope'; await model.load(view(review, { order }), caps(review, ['order']));
  assert.equal(model.snapshot().data?.fields.order?.status, 'ready'); assert.match(model.snapshot().data!.fields.order!.name!, /已授权服务/u); assert.doesNotMatch(model.snapshot().data!.fields.order!.name!, /¥|￥|299\.99|300\.00/u);
  visible = 'empty'; await model.load(view(review, { order }), caps(review, ['order']));
  assert.equal(model.snapshot().data?.fields.order?.status, 'unnamed'); assert.equal(model.snapshot().data?.fields.order?.name, undefined);
});
