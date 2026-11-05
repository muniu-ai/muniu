// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EnterpriseContractTypes } from '@mn/contracts';
import { WorkspaceNavigation, MAIN_NAVIGATION } from '../src/navigation.js';
import { BusinessFields } from '../src/business-fields.js';
import { formatMoney, parseMoneyInput } from '../src/format.js';

test('六个主导航顺序固定，专业工具不进入经营首次使用导航', () => {
  assert.deepEqual(MAIN_NAVIGATION.map(item => item.label), ['经营总览', '待我处理', '客户与销售', '项目与交付', '资金与复盘', '知识与成果']);
  const html = renderToStaticMarkup(<WorkspaceNavigation active="overview" onNavigate={() => {}} organizationAdmin={false} />);
  for (const item of MAIN_NAVIGATION) assert.ok(html.includes(item.label));
  assert.doesNotMatch(html, /Coding|JSON|组织与权限/u); assert.match(html, /aria-current="page"/u);
});

test('详情只呈现服务端允许且实际返回的字段，不输出隐藏金额、未知字段或原始对象', () => {
  const html = renderToStaticMarkup(<BusinessFields objectType="quote_version" values={{ currency: 'CNY', totalMinor: 987654, privateSalary: 'protected-value', status: 'approved' }} readableFields={['currency', 'status']} />);
  assert.doesNotMatch(html, /987654|9,876|protected-value|privateSalary|totalMinor/u);
  assert.match(html, /人民币|CNY/u); assert.match(html, /已批准/u);
});

test('金额缺失不显示为零，元输入转换严格保留整数分并拒绝溢出', () => {
  assert.equal(formatMoney(undefined), '未提供'); assert.equal(formatMoney(null), '未提供');
  assert.match(formatMoney(0), /0\.00/u); assert.match(formatMoney(1234), /12\.34/u);
  assert.equal(parseMoneyInput('0.01'), 1); assert.equal(parseMoneyInput('12.30'), 1230);
  assert.throws(() => parseMoneyInput('0.001')); assert.throws(() => parseMoneyInput('90071992547409.92'));
});

test('金额上界和负毛利按整数分精确呈现，不因浮点除法丢失最后一分', () => {
  assert.equal(formatMoney(Number.MAX_SAFE_INTEGER).replace(/[^0-9.-]/gu, ''), '90071992547409.91');
  assert.equal(formatMoney(-Number.MAX_SAFE_INTEGER).replace(/[^0-9.-]/gu, ''), '-90071992547409.91');
  assert.equal(parseMoneyInput('90071992547409.91'), Number.MAX_SAFE_INTEGER);
});

test('受限姓名映射仅用于获准人员字段，缺名时不回退到技术ID', () => {
  const capabilities: EnterpriseContractTypes['EnterpriseBusinessCapabilities'] = {
    reference: { tenantId: 'tenant', workspaceId: 'workspace', objectType: 'customer', objectId: 'customer', streamVersion: 1, digest: 'a'.repeat(64) },
    readableFields: ['ownerPrincipalId', 'preparedByPrincipalId'], writableFields: [], businessApprovalFields: [], canRecordEvidence: false,
    people: [{ principalId: 'visible-person', displayName: '王明' }],
  };
  const html = renderToStaticMarkup(<BusinessFields objectType="customer" values={{ ownerPrincipalId: 'visible-person', preparedByPrincipalId: 'constructor', confirmedByPrincipalId: 'hidden-person' }} readableFields={capabilities.readableFields} names={Object.fromEntries(capabilities.people.map(person => [person.principalId, person.displayName]))} />);
  assert.match(html, /王明/u); assert.match(html, /已关联/u);
  assert.doesNotMatch(html, /visible-person|constructor|hidden-person|可以批准/u);
});

test('报价明细使用实际字段成表，展示原行金额且不重复范围明细', () => {
  const html = renderToStaticMarkup(<BusinessFields objectType="quote_version" values={{ lines: [{ title: '可核对服务', quantity: 3, unit: '次', unitPriceMinor: 10000, totalMinor: 29999, scope: '原始服务范围', acceptanceCriteria: ['交付报告'] }], scopeLines: [{ title: '可核对服务', quantity: 3, unit: '次', scope: '原始服务范围' }] }} readableFields={['lines', 'scopeLines']} />);
  assert.match(html, /<table/u); assert.match(html, /名称/u); assert.match(html, /数量/u); assert.match(html, /单价/u); assert.match(html, /金额/u);
  assert.match(html, /299\.99/u); assert.doesNotMatch(html, /300\.00/u);
  assert.equal(html.split('可核对服务').length - 1, 1); assert.equal(html.split('原始服务范围').length - 1, 1);
});

test('只有公开范围时不出现价格列；缺失行金额不能由单价和数量补算', () => {
  const scope = renderToStaticMarkup(<BusinessFields objectType="quote_version" values={{ scopeLines: [{ title: '公开服务', quantity: 2, unit: '次' }] }} readableFields={['scopeLines']} />);
  assert.match(scope, /<table/u); assert.doesNotMatch(scope, /单价|金额|¥|￥/u);
  const missing = renderToStaticMarkup(<BusinessFields objectType="quote_version" values={{ lines: [{ title: '授权单价', quantity: 3, unit: '次', unitPriceMinor: 10000 }] }} readableFields={['lines']} />);
  assert.match(missing, /单价/u); assert.doesNotMatch(missing, /<th[^>]*>金额|300\.00/u);
});

test('复盘资金按累计、本期与付款期分组，保留各自实际金额及表格字段', () => {
  const html = renderToStaticMarkup(<BusinessFields objectType="business_review" values={{ financialMetrics: { totalMinor: 30000, grossReceivedMinor: 10000, netReceivedMinor: 9000, outstandingMinor: 21000, period: { grossReceivedMinor: 4000, netReceivedMinor: 3500, refundedMinor: 500 }, periods: [{ id: 'hidden-period-id', dueDate: '2026-12-01', amountMinor: 30000, allocatedMinor: 9000, writtenOffMinor: 0, outstandingMinor: 21000 }], privateSalary: 'hidden-salary' } }} readableFields={['financialMetrics']} />);
  const cumulative = html.match(/<section[^>]*aria-label="累计资金"[^>]*>([\s\S]*?)<\/section>/u)?.[1];
  const period = html.match(/<section[^>]*aria-label="本期收支"[^>]*>([\s\S]*?)<\/section>/u)?.[1];
  const schedules = html.match(/<section[^>]*aria-label="付款期明细"[^>]*>([\s\S]*?)<\/section>/u)?.[1];
  assert.ok(cumulative); assert.ok(period); assert.ok(schedules);
  assert.match(cumulative, /100\.00/u); assert.doesNotMatch(cumulative, /40\.00|35\.00/u);
  assert.match(period, /40\.00/u); assert.match(period, /35\.00/u); assert.doesNotMatch(period, /100\.00/u);
  assert.match(schedules, /<table/u); assert.match(schedules, /到期日期/u); assert.match(schedules, /300\.00/u); assert.match(schedules, /210\.00/u);
  assert.doesNotMatch(html, /hidden-period-id|privateSalary|hidden-salary/u);
});

test('复盘未获准字段不出现分组，缺失累计金额或付款期金额不补零', () => {
  const values = { financialMetrics: { netReceivedMinor: 25, period: { netReceivedMinor: 10 }, periods: [{ dueDate: '2026-12-01', allocatedMinor: 5 }] }, costMetrics: { confirmedCostMinor: 987654 } };
  const hidden = renderToStaticMarkup(<BusinessFields objectType="business_review" values={values} readableFields={[]} />);
  assert.doesNotMatch(hidden, /累计资金|本期收支|付款期明细|¥|￥/u);
  const html = renderToStaticMarkup(<BusinessFields objectType="business_review" values={values} readableFields={['financialMetrics']} />);
  assert.match(html, /aria-label="累计资金"/u); assert.match(html, /0\.25/u); assert.match(html, /0\.10/u); assert.match(html, /0\.05/u);
  assert.doesNotMatch(html, /¥0\.00|￥0\.00|<th[^>]*>金额|987654|9,876\.54/u);
});
