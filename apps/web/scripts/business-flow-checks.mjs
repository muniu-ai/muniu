// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

export const SALES_BROWSER_COMMANDS = Object.freeze([
  'customer.create', 'customer.rename', 'contact.create', 'contact.update', 'opportunity.create', 'opportunity.update',
  'service.publish', 'quote.prepare', 'quote.approve', 'quote.record_acceptance', 'contract.create', 'contract.activate', 'order.create', 'order.activate',
]);
export const DELIVERY_BROWSER_COMMANDS = Object.freeze(['project.create', 'milestone.create', 'delivery.report', 'delivery.receive', 'acceptance.prepare', 'acceptance.confirm']);
export const METRICS_BROWSER_COMMANDS = Object.freeze(['metric.publish', 'objective.create', 'business_review.snapshot']);
export const FINANCE_BROWSER_COMMANDS = Object.freeze(['payment_schedule.create', 'payment_schedule.confirm', 'receipt.prepare', 'receipt.confirm', 'receipt.cancel', 'refund.prepare', 'refund.confirm', 'refund.cancel', 'adjustment.prepare', 'adjustment.confirm', 'adjustment.cancel', 'expense.prepare', 'expense.confirm', 'expense.cancel', 'project.costs.confirm']);
export const CHANGES_BROWSER_COMMANDS = Object.freeze(['change_request.prepare', 'change_request.price', 'change_request.approve', 'change_request.cancel', 'change_request.project_confirm']);

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const money = minor => '¥' + (minor / 100).toFixed(2);
const localTime = offset => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + offset)).replace(' ', 'T');
const confirmation = '我已核对上方当前内容，明确提交本次业务决定';

function controls(context, group = '客户与销售') {
  const { getPage, navigate, nativeObjects, report } = context;
  const dialog = () => getPage().getByRole('dialog');
  const field = label => dialog().getByLabel(new RegExp('^' + escapePattern(label), 'u'));
  const checked = command => { report.checks.push('business-command:' + command); };
  async function native(type, id) {
    const found = (await nativeObjects(type)).filter(item => item.reference.objectId === id);
    assert.equal(found.length, 1, 'Expected one visible native ' + type); return found[0];
  }
  async function begin(tab, label) {
    await navigate(group, tab);
    await getPage().getByRole('button', { name: label, exact: true }).click();
    await dialog().getByRole('heading', { name: label, exact: true }).waitFor();
  }
  async function open(tab, visibleText) {
    await navigate(group, tab); await getPage().getByRole('table').waitFor();
    const row = getPage().getByRole('row').filter({ hasText: visibleText });
    assert.equal(await row.count(), 1, 'Business record must be distinguishable from visible row content');
    await row.getByRole('button', { name: '查看详情', exact: true }).click();
    await dialog().getByText(/当前第 \d+ 版/u).waitFor();
  }
  async function choose(label, record, { contains, version = false } = {}) {
    const selector = field(label), options = selector.getByRole('option');
    await selector.waitFor();
    const values = await options.evaluateAll(items => items.map(option => ({ value: option.value, label: option.textContent?.trim() ?? '' })));
    const option = values.find(item => item.value === record.reference.objectId);
    assert.ok(option, 'Authorized reference must appear in the labelled selector');
    if (contains) assert.match(option.label, contains, 'Reference label needs visible business context, not a generic record label');
    if (version) assert.match(option.label, new RegExp('第\\s*' + record.reference.streamVersion + '\\s*版', 'u'), 'Reference label must identify the selected source version');
    assert.equal(values.filter(item => item.label === option.label).length, 1, 'Visible reference labels must distinguish the intended record');
    assert.notEqual(option.label, record.reference.objectId, 'Technical IDs must not be the business label');
    await selector.selectOption({ label: option.label });
  }
  async function submit(command, label, type, expectedVersion = 1) {
    const page = getPage();
    const responsePromise = page.waitForResponse(response => {
      const request = response.request();
      return request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/business/commands') && request.postDataJSON()?.type === command;
    });
    await dialog().getByRole('button', { name: label, exact: true }).last().click();
    const response = await responsePromise, envelope = await response.json();
    assert.equal(response.status(), 200, 'Business submission failed: ' + (envelope.code ?? 'unknown'));
    await dialog().locator('form.mn-form').waitFor({ state: 'hidden' });
    assert.equal(envelope.data?.reference?.objectType, type);
    const saved = await native(type, envelope.data.reference.objectId);
    assert.deepEqual(saved.reference, envelope.data.reference); assert.equal(saved.reference.streamVersion, expectedVersion);
    assert.deepEqual(saved.values, envelope.data.values); checked(command); return saved;
  }
  async function decide(tab, visibleText, command, label, before, { proof } = {}) {
    await open(tab, visibleText);
    await dialog().getByRole('button', { name: label, exact: true }).click();
    if (proof) await field('实际核对依据').fill(proof);
    await dialog().getByLabel(confirmation, { exact: true }).check();
    return submit(command, label, before.reference.objectType, before.reference.streamVersion + 1);
  }
  async function reject(tab, visibleText, command, label, before, reasonCode, { proof } = {}) {
    await open(tab, visibleText);
    await dialog().getByRole('button', { name: label, exact: true }).click();
    if (proof) await field('实际核对依据').fill(proof);
    await dialog().getByLabel(confirmation, { exact: true }).check();
    const page = getPage(), writes = [];
    const collect = request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/business/commands')) writes.push(request.postDataJSON()); };
    page.on('request', collect);
    try {
      const checkedPromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/business-command-checks') && response.request().postDataJSON()?.type === command);
      await dialog().getByRole('button', { name: label, exact: true }).last().click();
      const response = await checkedPromise, envelope = await response.json();
      assert.equal(response.status(), 200); assert.deepEqual(envelope.data, { allowedNow: false, reasonCode });
      await page.getByRole('alert').first().waitFor();
      assert.deepEqual(await native(before.reference.objectType, before.reference.objectId), before, 'Refused command must preserve the original native version and business facts');
      assert.equal(writes.length, 0, 'Read-only rejection must not send a business write');
      report.checks.push('business-refusal:' + reasonCode);
    } finally { page.off('request', collect); }
  }
  return { dialog, field, native, begin, open, choose, submit, decide, reject };
}

async function onlyLine(selector) {
  await selector.getByRole('option').nth(1).waitFor({ state: 'attached' });
  const options = await selector.getByRole('option').evaluateAll(items => items.filter(option => option.value).map(option => ({ value: option.value, label: option.textContent?.trim() ?? '' })));
  assert.equal(options.length, 1, 'This fixture must have one original business line');
  assert.ok(options[0].label); assert.notEqual(options[0].label, options[0].value);
  await selector.selectOption({ label: options[0].label });
}

async function projection(context, kind, id, asOfDate) {
  return context.getPage().evaluate(async ({ workspaceId, kind, id, asOfDate }) => {
    const response = await fetch('/v2/workspaces/' + encodeURIComponent(workspaceId) + '/business-' + kind + '/' + encodeURIComponent(id) + (kind === 'balances' ? '/' + encodeURIComponent(asOfDate) : ''), { method: 'GET', cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('NATIVE_PROJECTION_READ_FAILED'); return (await response.json()).data;
  }, { workspaceId: context.fixture.workspaceId, kind, id, asOfDate });
}

/** Uses only a dedicated seeded fixture. Writes go through visible form controls; injected nativeObjects is read-only. */
export async function verifySalesBusinessFlow(context) {
  const { getPage, login, nativeObjects, closeDialog, screenshot, fixture, report } = context;
  assert.equal(fixture.tenantId, 'enterprise-web-fixture'); assert.equal(fixture.mode, 'seeded'); assert.ok(fixture.workspaceId);
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(fixture.origin).hostname));
  const ui = controls(context), completedAtStart = report.checks.length;
  const names = { customer: '合成全流程客户', renamed: '合成全流程客户（已核对）', contact: '合成全流程联系人', updatedContact: '合成全流程联系人（已更新）', opportunity: '合成全流程需求', updatedOpportunity: '合成全流程需求（已确认）', service: '合成浏览器发布服务', contract: '合成全流程服务合同' };

  await login('manager');
  await ui.begin('服务', '发布服务版本');
  await ui.field('服务代码').fill('synthetic-browser-service'); await ui.field('标题').fill(names.service);
  await ui.field('计量单位').fill('次'); await ui.field('单价').fill('125.50'); await ui.field('服务范围').fill('合成浏览器业务核对');
  await ui.field('验收条件').fill('合成报告已核对\n合成范围已确认');
  await ui.field('生效时间').fill(localTime(-3600000)); await ui.field('有效期').fill(localTime(60 * 86400000));
  const published = await ui.submit('service.publish', '发布服务版本', 'service_version');
  assert.equal(published.values.title, names.service); assert.equal(published.values.unitPriceMinor, 12550); assert.equal(published.values.status, 'active');
  assert.deepEqual(published.values.acceptanceCriteria, ['合成报告已核对', '合成范围已确认']);

  await login('sales');
  await ui.begin('客户', '新建客户'); await ui.field('名称').fill(names.customer);
  await ui.field('归属部门').selectOption({ label: '不指定部门' });
  let customer = await ui.submit('customer.create', '新建客户', 'customer'); assert.equal(customer.values.name, names.customer);
  await ui.open('客户', names.customer); await ui.dialog().getByRole('button', { name: '修改客户名称', exact: true }).click();
  await ui.field('名称').fill(names.renamed); customer = await ui.submit('customer.rename', '修改客户名称', 'customer', 2);
  assert.equal(customer.values.name, names.renamed); await closeDialog();

  await ui.begin('联系人', '添加联系人'); await ui.choose('客户', customer, { contains: new RegExp(escapePattern(names.renamed), 'u') });
  await ui.field('名称').fill(names.contact); await ui.field('电子邮箱').fill('first@example.invalid'); await ui.field('电话').fill('synthetic-phone-one');
  let contact = await ui.submit('contact.create', '添加联系人', 'contact'); assert.deepEqual(contact.values.customer, customer.reference);
  await ui.open('联系人', names.contact); await ui.dialog().getByRole('button', { name: '修改联系人', exact: true }).click();
  await ui.field('名称').fill(names.updatedContact); await ui.field('电子邮箱').fill('updated@example.invalid'); await ui.field('电话').fill('synthetic-phone-two');
  contact = await ui.submit('contact.update', '修改联系人', 'contact', 2);
  assert.equal(contact.values.name, names.updatedContact); assert.equal(contact.values.email, 'updated@example.invalid'); assert.equal(contact.values.phone, 'synthetic-phone-two'); await closeDialog();

  await ui.begin('商机', '新建商机'); await ui.choose('客户', customer, { contains: new RegExp(escapePattern(names.renamed), 'u') }); await ui.field('标题').fill(names.opportunity);
  let opportunity = await ui.submit('opportunity.create', '新建商机', 'opportunity'); assert.deepEqual(opportunity.values.customer, customer.reference);
  await ui.open('商机', names.opportunity); await ui.dialog().getByRole('button', { name: '修改商机', exact: true }).click(); await ui.field('标题').fill(names.updatedOpportunity);
  opportunity = await ui.submit('opportunity.update', '修改商机', 'opportunity', 2); assert.equal(opportunity.values.title, names.updatedOpportunity); await closeDialog();

  const service = await ui.native('service_version', fixture.references.service.objectId);
  const unitPrice = service.values.unitPriceMinor; assert.equal(unitPrice, 10000);
  async function prepareQuote(quantity) {
    await ui.begin('报价', '准备报价'); await ui.choose('商机', opportunity, { contains: new RegExp(escapePattern(names.updatedOpportunity), 'u') });
    await ui.choose('服务版本', service, { contains: /合成咨询服务/u }); await ui.field('数量').fill(String(quantity)); await ui.field('有效期').fill(localTime(20 * 86400000));
    const quote = await ui.submit('quote.prepare', '准备报价', 'quote_version');
    assert.equal(quote.values.status, 'draft'); assert.deepEqual(quote.values.opportunity, opportunity.reference);
    assert.equal(quote.values.totalMinor, unitPrice * quantity); assert.equal(quote.values.lines.length, 1);
    assert.equal(quote.values.lines[0].quantity, quantity); assert.equal(quote.values.lines[0].totalMinor, quote.values.totalMinor); return quote;
  }
  let quote = await prepareQuote(7);
  await login('manager');
  const selfPrepared = await prepareQuote(4);
  await ui.reject('报价', money(selfPrepared.values.totalMinor), 'quote.approve', '批准报价', selfPrepared, 'SEPARATION_OF_DUTIES_REQUIRED');
  await screenshot('sales-self-approval-refused'); await closeDialog();
  quote = await ui.decide('报价', money(quote.values.totalMinor), 'quote.approve', '批准报价', quote);
  assert.equal(quote.values.status, 'approved'); assert.equal(quote.values.totalMinor, 70000); await closeDialog();
  quote = await ui.decide('报价', money(quote.values.totalMinor), 'quote.record_acceptance', '登记客户接受', quote, { proof: '已核对合成客户明确接受当前报价及全部七次服务，仅供本地验收。' });
  assert.equal(quote.values.status, 'accepted'); assert.equal(quote.values.totalMinor, 70000);
  const acceptance = (await nativeObjects('customer_acceptance')).filter(item => item.values.subjectRef?.objectId === quote.reference.objectId);
  assert.equal(acceptance.length, 1); assert.equal(acceptance[0].values.subjectRef.streamVersion, 2); assert.equal(acceptance[0].values.confirmedByPrincipalId, 'manager');
  await screenshot('sales-customer-accepted-quote'); await closeDialog();

  await login('sales');
  await ui.begin('合同', '起草合同');
  await ui.choose('报价', quote, { contains: /¥700\.00/u, version: true }); await ui.field('标题').fill(names.contract);
  let contract = await ui.submit('contract.create', '起草合同', 'contract');
  assert.equal(contract.values.status, 'draft'); assert.deepEqual(contract.values.quote, quote.reference); assert.equal(contract.values.totalMinor, quote.values.totalMinor);
  assert.deepEqual(contract.values.lines, quote.values.lines);
  await login('manager');
  contract = await ui.decide('合同', names.contract, 'contract.activate', '确认合同生效', contract, { proof: '已核对合成合同签署资料与当前报价的完整范围，仅供本地验收。' });
  assert.equal(contract.values.status, 'active'); assert.equal(contract.values.totalMinor, 70000); await closeDialog();

  await login('sales');
  async function createOrder(quantity) {
    await ui.begin('订单', '起草订单'); await ui.choose('合同', contract, { contains: new RegExp(escapePattern(names.contract), 'u') });
    await ui.field('报价明细').selectOption({ label: '合成咨询服务' }); await ui.field('数量').fill(String(quantity));
    const order = await ui.submit('order.create', '起草订单', 'order');
    assert.equal(order.values.status, 'draft'); assert.deepEqual(order.values.contract, contract.reference);
    assert.equal(order.values.totalMinor, unitPrice * quantity); assert.equal(order.values.lines[0].quantity, quantity); assert.equal(order.values.lines[0].totalMinor, order.values.totalMinor); return order;
  }
  let order = await createOrder(3); const excess = await createOrder(5);
  await login('manager');
  order = await ui.decide('订单', money(order.values.totalMinor), 'order.activate', '确认订单生效', order);
  assert.equal(order.values.status, 'active'); assert.equal(order.values.totalMinor, 30000); await closeDialog();
  await ui.reject('订单', money(excess.values.totalMinor), 'order.activate', '确认订单生效', excess, 'CONTRACT_ALLOCATION_EXCEEDED');
  const orders = (await nativeObjects('order')).filter(item => item.values.contract?.objectId === contract.reference.objectId);
  const active = orders.filter(item => item.values.status === 'active'); assert.equal(active.length, 1); assert.equal(orders.length, 2);
  assert.equal(active.reduce((sum, item) => sum + item.values.totalMinor, 0), 30000);
  assert.equal(contract.values.totalMinor - active.reduce((sum, item) => sum + item.values.totalMinor, 0), 40000);
  assert.deepEqual(await ui.native('order', order.reference.objectId), order);
  await screenshot('sales-contract-allocation-refused');
  report.checks.push('sales-contract-quote-money-conservation', 'sales-partial-order-and-refused-over-allocation');
  const covered = new Set(report.checks.slice(completedAtStart).filter(item => item.startsWith('business-command:')).map(item => item.slice('business-command:'.length)));
  assert.deepEqual([...covered].sort(), [...SALES_BROWSER_COMMANDS].sort());
  return { customer, contact, opportunity, published, quote, contract, order };
}

export async function verifyDeliveryBusinessFlow(context) {
  const { login, closeDialog, screenshot, report, fixture } = context;
  assert.ok(fixture.accounts.some(account => account.id === 'project-maker'), 'Independent project maker must be explicitly provisioned by the fixture');
  const sales = await verifySalesBusinessFlow(context), ui = controls(context, '项目与交付'), completedAtStart = report.checks.length;
  const title = '合成浏览器交付项目', milestoneTitle = '合成浏览器第一阶段', summary = '合成首次部分交付', excessSummary = '合成超额交付草稿';
  const dueDate = localTime(10 * 86400000).slice(0, 10), lineId = sales.order.values.scopeLines[0].lineId;
  await login('project-maker');
  await ui.begin('项目', '建立项目'); await ui.choose('订单', sales.order, { contains: /¥300\.00/u, version: true }); await ui.field('标题').fill(title);
  const project = await ui.submit('project.create', '建立项目', 'project');
  assert.deepEqual(project.values.order, sales.order.reference); assert.deepEqual(project.values.scopeLines, sales.order.values.scopeLines); assert.equal(project.values.status, 'active');
  await ui.begin('里程碑', '添加里程碑'); await ui.choose('项目', project, { contains: new RegExp(escapePattern(title), 'u') }); await ui.field('标题').fill(milestoneTitle); await ui.field('到期日期').fill(dueDate);
  await onlyLine(ui.field('范围明细')); await ui.field('数量').fill('3');
  const milestone = await ui.submit('milestone.create', '添加里程碑', 'milestone');
  assert.deepEqual(milestone.values.project, project.reference); assert.deepEqual(milestone.values.lines, [{ lineId, quantity: 3 }]);

  async function reportDelivery(description) {
    await ui.begin('交付', '登记交付'); await ui.choose('里程碑', milestone, { contains: new RegExp(escapePattern(milestoneTitle), 'u') }); await ui.field('交付说明').fill(description);
    await onlyLine(ui.field('范围明细')); await ui.field('数量').fill('2');
    const delivered = await ui.submit('delivery.report', '登记交付', 'delivery_version');
    assert.deepEqual(delivered.values.milestone, milestone.reference); assert.deepEqual(delivered.values.lines, [{ lineId, quantity: 2 }]); assert.equal(delivered.values.status, 'draft'); return delivered;
  }
  let delivery = await reportDelivery(summary);
  const beforeReceive = await projection(context, 'progress', project.reference.objectId);
  assert.deepEqual(beforeReceive.values.lines, [{ lineId, promised: 3, delivered: 0, internallyReceived: 0, accepted: 0, remaining: 3 }]);
  delivery = await ui.decide('交付', summary, 'delivery.receive', '内部接收交付', delivery);
  assert.equal(delivery.values.status, 'received'); assert.equal(delivery.values.receivedBy, 'project-maker'); await closeDialog();

  async function prepareAcceptance(quantity) {
    await ui.begin('客户验收', '准备客户验收'); await ui.choose('交付记录', delivery, { contains: new RegExp(escapePattern(summary), 'u'), version: true });
    await onlyLine(ui.field('范围明细')); await ui.field('数量').fill(String(quantity));
    const acceptance = await ui.submit('acceptance.prepare', '准备客户验收', 'customer_acceptance');
    assert.deepEqual(acceptance.values.delivery, delivery.reference); assert.deepEqual(acceptance.values.lines, [{ lineId, quantity }]); assert.equal(acceptance.values.status, 'draft'); return acceptance;
  }
  let acceptance = await prepareAcceptance(1);
  await ui.reject('客户验收', '草稿', 'acceptance.confirm', '确认客户验收', acceptance, 'SEPARATION_OF_DUTIES_REQUIRED', { proof: '合成交付制单人不能自行确认客户验收，本次仅登记实际核对说明。' });
  await screenshot('delivery-self-acceptance-refused'); await closeDialog();
  await login('manager');
  acceptance = await ui.decide('客户验收', '草稿', 'acceptance.confirm', '确认客户验收', acceptance, { proof: '已由独立人员核对合成客户仅验收一次服务的实际资料。' });
  assert.equal(acceptance.values.status, 'confirmed'); assert.deepEqual(acceptance.values.lines, [{ lineId, quantity: 1 }]); await closeDialog();
  await login('project-maker');
  const excessiveDelivery = await reportDelivery(excessSummary);
  await ui.reject('交付', excessSummary, 'delivery.receive', '内部接收交付', excessiveDelivery, 'DELIVERY_QUANTITY_EXCEEDED');
  await closeDialog();
  const excessiveAcceptance = await prepareAcceptance(2);
  await login('manager');
  await ui.reject('客户验收', '草稿', 'acceptance.confirm', '确认客户验收', excessiveAcceptance, 'ACCEPTANCE_QUANTITY_EXCEEDED', { proof: '已核对合成验收草稿，当前申请超过该交付尚可验收的数量。' });
  await closeDialog();
  const progress = await projection(context, 'progress', project.reference.objectId);
  assert.deepEqual(progress.values.lines, [{ lineId, promised: 3, delivered: 2, internallyReceived: 2, accepted: 1, remaining: 2 }]);
  assert.deepEqual(await ui.native('project', project.reference.objectId), project);
  assert.deepEqual(await ui.native('delivery_version', delivery.reference.objectId), delivery);
  await ui.open('项目', title); await screenshot('delivery-partial-progress'); await closeDialog();
  report.checks.push('delivery-reported-is-not-received', 'delivery-partial-receipt-and-acceptance', 'delivery-refused-excess-keeps-quantities');
  const covered = new Set(report.checks.slice(completedAtStart).filter(item => item.startsWith('business-command:')).map(item => item.slice('business-command:'.length)));
  assert.deepEqual([...covered].sort(), [...DELIVERY_BROWSER_COMMANDS].sort());
  return { ...sales, project, milestone, delivery, acceptance };
}

export async function verifyMetricsBusinessFlow(context) {
  const { getPage, login, nativeObjects, closeDialog, screenshot, report, fixture } = context;
  assert.equal(fixture.tenantId, 'enterprise-web-fixture'); assert.equal(fixture.mode, 'seeded');
  const ui = controls(context, '资金与复盘'), completedAtStart = report.checks.length;
  await login('finance');
  const order = await ui.native('order', fixture.references.order.objectId), receipt = await ui.native('receipt', fixture.references.receipt.objectId);
  const periodStart = receipt.values.businessDate, periodEnd = localTime(0).slice(0, 10);
  await ui.begin('经营指标', '发布经营指标'); await ui.field('指标').selectOption({ label: '净回款' }); await ui.field('标题').fill('合成浏览器净回款指标');
  const metric = await ui.submit('metric.publish', '发布经营指标', 'metric_definition');
  assert.equal(metric.values.metric, 'net_received'); assert.equal(metric.values.algorithmVersion, 'business-balances-v1');
  await ui.begin('经营目标', '设定经营目标'); await ui.choose('订单', order, { contains: /¥200\.00/u, version: true });
  await ui.choose('指标', metric, { contains: /合成浏览器净回款指标/u });
  await ui.field('起始日期').fill(periodStart); await ui.field('结束日期').fill(periodEnd); await ui.field('目标金额').fill('150.00');
  const objective = await ui.submit('objective.create', '设定经营目标', 'operating_objective');
  assert.deepEqual(objective.values.order, order.reference); assert.deepEqual(objective.values.metric, metric.reference);
  assert.equal(objective.values.targetMinor, 15000); assert.equal(objective.values.responsiblePrincipalId, 'finance');
  await ui.begin('经营复盘', '形成经营复盘'); await ui.choose('订单', order, { contains: /¥200\.00/u, version: true });
  await ui.field('起始日期').fill(periodStart); await ui.field('结束日期').fill(periodEnd);
  await ui.field('在复盘中纳入已授权的成本信息').uncheck();
  await ui.choose('经营目标', objective, { contains: /¥150\.00/u, version: true });
  const review = await ui.submit('business_review.snapshot', '形成经营复盘', 'business_review');
  assert.equal(review.values.periodStart, periodStart); assert.equal(review.values.periodEnd, periodEnd);
  assert.deepEqual(review.values.objective, objective.reference); assert.equal(review.values.objectiveResult.targetMinor, 15000); assert.equal(review.values.objectiveResult.actualMinor, 10000);
  assert.equal(review.values.financialMetrics.totalMinor, 20000); assert.equal(review.values.financialMetrics.netReceivedMinor, 10000); assert.equal(review.values.financialMetrics.outstandingMinor, 10000);
  assert.equal(review.values.financialMetrics.period.netReceivedMinor, 10000); assert.equal(Object.hasOwn(review.values, 'costMetrics'), false);
  assert.ok(review.values.financialSources.some(reference => reference.objectId === receipt.reference.objectId));
  await ui.open('经营复盘', '经营复盘记录'); await screenshot('metrics-native-review');
  await ui.dialog().getByRole('heading', { name: '付款期明细', exact: true }).scrollIntoViewIfNeeded();
  await screenshot('metrics-funds-details'); await closeDialog();

  const before = await nativeObjects('operating_objective');
  await ui.begin('经营目标', '设定经营目标'); await ui.choose('订单', order, { contains: /¥200\.00/u }); await ui.choose('指标', metric, { contains: /合成浏览器净回款指标/u });
  await ui.field('起始日期').fill(localTime(2 * 86400000).slice(0, 10)); await ui.field('结束日期').fill(periodEnd); await ui.field('目标金额').fill('100.00');
  const page = getPage(), writes = [];
  const collect = request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/business/commands')) writes.push(request.postDataJSON()); };
  page.on('request', collect);
  try {
    const checkPromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/business-command-checks') && response.request().postDataJSON()?.type === 'objective.create');
    await ui.dialog().getByRole('button', { name: '设定经营目标', exact: true }).click();
    const checked = await checkPromise; assert.equal(checked.status(), 200); assert.deepEqual((await checked.json()).data, { allowedNow: false, reasonCode: 'REVIEW_PERIOD_INVALID' });
    await page.getByRole('alert').first().waitFor();
    assert.deepEqual(await nativeObjects('operating_objective'), before); assert.deepEqual(await ui.native('business_review', review.reference.objectId), review); assert.equal(writes.length, 0);
    await screenshot('metrics-invalid-period-refused');
    report.checks.push('metrics-period-snapshot-from-host', 'metrics-cost-fields-not-requested-not-shown', 'metrics-invalid-period-preserves-facts');
  } finally { page.off('request', collect); }
  const covered = new Set(report.checks.slice(completedAtStart).filter(item => item.startsWith('business-command:')).map(item => item.slice('business-command:'.length)));
  assert.deepEqual([...covered].sort(), [...METRICS_BROWSER_COMMANDS].sort());
  return { metric, objective, review };
}

export async function verifyFinanceBusinessFlow(context) {
  const { login, closeDialog, screenshot, report, fixture } = context;
  assert.equal(fixture.tenantId, 'enterprise-web-fixture'); assert.equal(fixture.mode, 'seeded');
  const ui = controls(context, '资金与复盘'), projectUi = controls(context, '项目与交付'), completedAtStart = report.checks.length;
  const date = localTime(0).slice(0, 10), dueDate = localTime(15 * 86400000).slice(0, 10);
  await login('finance');
  const order = await ui.native('order', fixture.references.order.objectId), seedReceipt = await ui.native('receipt', fixture.references.receipt.objectId), project = await ui.native('project', fixture.references.project.objectId);
  let originalSchedule = await ui.native('payment_schedule', fixture.references.schedule.objectId);
  const baseline = await projection(context, 'balances', order.reference.objectId, date);
  assert.equal(baseline.values.totalMinor, 20000); assert.equal(baseline.values.netReceivedMinor, 10000);

  async function adjustment(kind, fill) {
    await ui.begin('金额调整', '登记金额调整'); await ui.field('调整方式').selectOption({ label: kind });
    await fill(); await ui.field('发生日期').fill(date); await ui.field('原因').fill('合成浏览器核对：' + kind);
    return ui.submit('adjustment.prepare', '登记金额调整', 'adjustment');
  }
  async function approve(tab, visibleText, command, label, before) {
    await login('manager');
    const saved = await ui.decide(tab, visibleText, command, label, before, { proof: '已由独立人员核对合成资料及原始金额，仅供本地验收。' });
    assert.equal(saved.values.status, 'confirmed'); await closeDialog(); return saved;
  }
  async function addAllocation(groupName, schedule, amount) {
    const group = ui.dialog().getByRole('group', { name: groupName, exact: true });
    await group.getByRole('button', { name: '添加一项', exact: true }).click();
    await ui.choose('付款期', schedule, { contains: new RegExp(escapePattern(money(schedule.values.amountMinor)), 'u'), version: true });
    await group.getByLabel(/^金额/u).fill(amount);
  }

  let revision = await adjustment('调整付款期', async () => {
    await ui.choose('付款期', originalSchedule, { contains: /¥200\.00/u, version: true }); await ui.field('调整后金额').fill('150.00'); await ui.field('调整后日期').fill(dueDate);
  });
  revision = await approve('金额调整', '金额调整记录', 'adjustment.confirm', '确认金额调整', revision);
  originalSchedule = await ui.native('payment_schedule', originalSchedule.reference.objectId);
  assert.equal(originalSchedule.reference.streamVersion, 3); assert.equal(originalSchedule.values.amountMinor, 15000); assert.equal(originalSchedule.values.dueDate, dueDate);
  assert.equal(revision.values.kind, 'schedule_revision');

  await login('finance'); await ui.begin('付款期', '安排付款期'); await ui.choose('订单', order, { contains: /¥200\.00/u, version: true });
  await ui.field('金额').fill('50.00'); await ui.field('到期日期').fill(dueDate);
  let schedule = await ui.submit('payment_schedule.create', '安排付款期', 'payment_schedule');
  schedule = await approve('付款期', '¥50.00', 'payment_schedule.confirm', '确认付款安排', schedule);
  assert.equal(schedule.values.amountMinor, 5000); assert.deepEqual(schedule.values.order, order.reference);

  await login('finance'); await ui.begin('收款', '登记收款草稿'); await ui.choose('订单', order, { contains: /¥200\.00/u });
  await ui.field('金额').fill('40.00'); await ui.field('发生日期').fill(date); await addAllocation('款项分配', schedule, '20.00');
  let receipt = await ui.submit('receipt.prepare', '登记收款草稿', 'receipt');
  assert.equal(receipt.values.amountMinor, 4000); assert.deepEqual(receipt.values.allocations, [{ schedule: schedule.reference, amountMinor: 2000 }]);
  await ui.reject('收款', '¥40.00', 'receipt.confirm', '确认实际到账', receipt, 'SEPARATION_OF_DUTIES_REQUIRED', { proof: '合成财务制单人不得自行确认实际到账。' });
  await closeDialog(); receipt = await approve('收款', '¥40.00', 'receipt.confirm', '确认实际到账', receipt);
  let balance = await projection(context, 'balances', order.reference.objectId, date);
  assert.equal(balance.values.netReceivedMinor, 14000); assert.equal(balance.values.allocatedMinor, 12000); assert.equal(balance.values.unallocatedMinor, 2000);

  await login('finance');
  let allocation = await adjustment('分配已有收款', async () => {
    await ui.choose('原收款记录', receipt, { contains: /¥40\.00/u, version: true }); await ui.choose('付款期', schedule, { contains: /¥50\.00/u, version: true }); await ui.field('金额').fill('12.00');
  });
  allocation = await approve('金额调整', '¥12.00', 'adjustment.confirm', '确认金额调整', allocation);
  assert.equal(allocation.values.kind, 'receipt_allocation');

  await login('finance'); await ui.begin('退款', '登记退款草稿'); await ui.choose('原收款记录', receipt, { contains: /¥40\.00/u, version: true });
  await ui.field('金额').fill('7.00'); await ui.field('发生日期').fill(date); await addAllocation('退回分配', schedule, '7.00');
  let refund = await ui.submit('refund.prepare', '登记退款草稿', 'refund');
  refund = await approve('退款', '¥7.00', 'refund.confirm', '确认退款', refund);
  assert.equal(refund.values.amountMinor, 700); assert.deepEqual(refund.values.receipt, receipt.reference);

  await login('finance');
  let reversal = await adjustment('收款冲正', async () => {
    await ui.choose('原收款记录', seedReceipt, { contains: /¥100\.00/u, version: true }); await ui.field('金额').fill('9.00'); await addAllocation('退回分配', originalSchedule, '9.00');
  });
  reversal = await approve('金额调整', '¥9.00', 'adjustment.confirm', '确认金额调整', reversal); assert.equal(reversal.values.kind, 'receipt_reversal');
  await login('finance');
  let writeOff = await adjustment('应收核销', async () => {
    await ui.choose('订单', order, { contains: /¥200\.00/u }); await ui.choose('付款期', originalSchedule, { contains: /¥150\.00/u }); await ui.field('金额').fill('5.00');
  });
  writeOff = await approve('金额调整', '¥5.00', 'adjustment.confirm', '确认金额调整', writeOff); assert.equal(writeOff.values.kind, 'write_off');
  balance = await projection(context, 'balances', order.reference.objectId, date);
  const expected = { totalMinor: 20000, grossReceivedMinor: 14000, refundedMinor: 700, reversedMinor: 900, netReceivedMinor: 12400, allocatedMinor: 11600, unallocatedMinor: 800, writtenOffMinor: 500, outstandingMinor: 7900 };
  for (const [field, value] of Object.entries(expected)) assert.equal(balance.values[field], value, 'Native balance field: ' + field);
  assert.equal(balance.values.grossReceivedMinor - balance.values.refundedMinor - balance.values.reversedMinor, balance.values.netReceivedMinor);
  assert.equal(balance.values.totalMinor - balance.values.allocatedMinor - balance.values.writtenOffMinor, balance.values.outstandingMinor);
  assert.equal(balance.values.allocatedMinor + balance.values.unallocatedMinor, balance.values.netReceivedMinor);

  await login('finance');
  await ui.begin('收款', '登记收款草稿'); await ui.choose('订单', order, { contains: /¥200\.00/u }); await ui.field('金额').fill('3.00'); await ui.field('发生日期').fill(date);
  let cancelledReceipt = await ui.submit('receipt.prepare', '登记收款草稿', 'receipt');
  cancelledReceipt = await ui.decide('收款', '¥3.00', 'receipt.cancel', '取消收款草稿', cancelledReceipt); assert.equal(cancelledReceipt.values.status, 'cancelled'); await closeDialog();
  await ui.begin('退款', '登记退款草稿'); await ui.choose('原收款记录', receipt, { contains: /¥40\.00/u }); await ui.field('金额').fill('2.00'); await ui.field('发生日期').fill(date);
  let cancelledRefund = await ui.submit('refund.prepare', '登记退款草稿', 'refund');
  cancelledRefund = await ui.decide('退款', '¥2.00', 'refund.cancel', '取消退款草稿', cancelledRefund); assert.equal(cancelledRefund.values.status, 'cancelled'); await closeDialog();
  let cancelledAdjustment = await adjustment('应收核销', async () => {
    await ui.choose('订单', order, { contains: /¥200\.00/u }); await ui.choose('付款期', originalSchedule, { contains: /¥150\.00/u }); await ui.field('金额').fill('1.00');
  });
  cancelledAdjustment = await ui.decide('金额调整', '¥1.00', 'adjustment.cancel', '取消调整草稿', cancelledAdjustment); assert.equal(cancelledAdjustment.values.status, 'cancelled'); await closeDialog();

  async function expense(description, amount) {
    await ui.begin('费用', '登记费用草稿'); await ui.choose('项目', project, { contains: /合成交付项目/u }); await ui.field('金额').fill(amount); await ui.field('发生日期').fill(date); await ui.field('说明').fill(description);
    return ui.submit('expense.prepare', '登记费用草稿', 'expense');
  }
  let cost = await expense('合成浏览器已核对成本', '30.00');
  let cancelledCost = await expense('合成浏览器取消费用', '4.00');
  cancelledCost = await ui.decide('费用', '合成浏览器取消费用', 'expense.cancel', '取消费用草稿', cancelledCost); assert.equal(cancelledCost.values.status, 'cancelled'); await closeDialog();
  cost = await approve('费用', '合成浏览器已核对成本', 'expense.confirm', '确认费用', cost);
  const incomplete = await projection(context, 'costs', project.reference.objectId); assert.equal(incomplete.values.costsComplete, false); assert.equal(incomplete.values.marginMinor, null);
  await login('finance'); await projectUi.open('项目', '合成交付项目'); await projectUi.dialog().getByRole('button', { name: '确认成本完整', exact: true }).click();
  await projectUi.dialog().getByRole('group', { name: '纳入核对的费用', exact: true }).getByRole('button', { name: '添加一项', exact: true }).click();
  await projectUi.choose('纳入核对的费用', cost, { contains: /合成浏览器已核对成本/u });
  await projectUi.field('实际核对依据').fill('已核对本项目全部合成成本，取消草稿不计入成本，唯一已确认费用为三十元。');
  await projectUi.dialog().getByLabel(confirmation, { exact: true }).check();
  const completeProject = await projectUi.submit('project.costs.confirm', '确认成本完整', 'project', 2);
  const costs = await projection(context, 'costs', project.reference.objectId); assert.deepEqual(costs.values, { costsComplete: true, confirmedCostMinor: 3000, marginMinor: 17000, marginBasis: 'order_value_minus_confirmed_cost' });
  await screenshot('finance-complete-project-cost'); await closeDialog();

  await ui.begin('退款', '登记退款草稿'); await ui.choose('原收款记录', receipt, { contains: /¥40\.00/u }); await ui.field('金额').fill('50.00'); await ui.field('发生日期').fill(date);
  const excessiveRefund = await ui.submit('refund.prepare', '登记退款草稿', 'refund');
  await login('manager');
  await ui.reject('退款', '¥50.00', 'refund.confirm', '确认退款', excessiveRefund, 'RECEIPT_REDUCTION_EXCEEDED', { proof: '已核对合成退款申请，金额超过原收款可退余额。' });
  assert.deepEqual(await projection(context, 'balances', order.reference.objectId, date), balance);
  assert.deepEqual(await projection(context, 'costs', project.reference.objectId), costs);
  await screenshot('finance-excess-refund-refused');
  report.checks.push('finance-all-four-adjustments-from-ui', 'finance-money-conservation', 'finance-cancelled-drafts-have-no-balance-effect', 'finance-cost-completeness-controls-margin', 'finance-excess-refund-preserves-facts');
  const covered = new Set(report.checks.slice(completedAtStart).filter(item => item.startsWith('business-command:')).map(item => item.slice('business-command:'.length)));
  assert.deepEqual([...covered].sort(), [...FINANCE_BROWSER_COMMANDS].sort());
  return { order, schedule, receipt, refund, allocation, reversal, revision, writeOff, cost, project: completeProject, balance, costs };
}

export async function verifyChangesBusinessFlow(context) {
  const { getPage, login, nativeObjects, closeDialog, screenshot, report, fixture } = context;
  assert.equal(fixture.tenantId, 'enterprise-web-fixture'); assert.equal(fixture.mode, 'seeded');
  assert.ok(fixture.accounts.some(account => account.id === 'project-maker'));
  const ui = controls(context, '项目与交付'), completedAtStart = report.checks.length;
  await login('project-maker');
  const project = await ui.native('project', fixture.references.project.objectId), order = await ui.native('order', fixture.references.order.objectId), contract = await ui.native('contract', fixture.references.contract.objectId), milestone = await ui.native('milestone', fixture.references.milestone.objectId);
  const lineId = order.values.scopeLines[0].lineId, description = '合成浏览器增加一次服务', cancelledDescription = '合成浏览器取消范围草稿';
  async function prepare(reason) {
    await ui.begin('范围变更', '提出范围变更'); await ui.choose('项目', project, { contains: /合成交付项目/u, version: true }); await ui.field('说明').fill(reason);
    const change = await ui.submit('change_request.prepare', '提出范围变更', 'change_request'); assert.equal(change.values.status, 'draft'); assert.deepEqual(change.values.project, project.reference); return change;
  }
  let cancelled = await prepare(cancelledDescription);
  cancelled = await ui.decide('范围变更', cancelledDescription, 'change_request.cancel', '取消变更草稿', cancelled);
  assert.equal(cancelled.values.status, 'cancelled'); assert.deepEqual(await ui.native('project', project.reference.objectId), project); assert.deepEqual(await ui.native('order', order.reference.objectId), order); await closeDialog();
  let change = await prepare(description);
  await ui.open('范围变更', description); await ui.dialog().getByRole('button', { name: '核对变更价格', exact: true }).click();
  await ui.field('明细来源').selectOption({ label: '原订单明细' }); await onlyLine(ui.field('原订单明细')); await ui.field('数量').fill('3');
  change = await ui.submit('change_request.price', '核对变更价格', 'change_request', 2);
  assert.equal(change.values.status, 'priced'); assert.equal(change.values.totalMinor, 30000); assert.equal(change.values.contractTotalMinor, 30000);
  assert.equal(change.values.commercialPreparedByPrincipalId, 'project-maker'); assert.equal(change.values.lines[0].quoteLineId, lineId); assert.equal(change.values.lines[0].quantity, 3);
  assert.deepEqual(await ui.native('order', order.reference.objectId), order); assert.deepEqual(await ui.native('contract', contract.reference.objectId), contract); await closeDialog();
  await login('manager');
  change = await ui.decide('范围变更', description, 'change_request.approve', '批准范围变更', change, { proof: '已由独立人员核对合成客户同意新增一次服务，订单与合同总额由二百元调整为三百元。' });
  assert.equal(change.values.status, 'approved');
  const amendedOrder = await ui.native('order', order.reference.objectId), amendedContract = await ui.native('contract', contract.reference.objectId), blockedProject = await ui.native('project', project.reference.objectId);
  assert.equal(amendedOrder.reference.streamVersion, order.reference.streamVersion + 1); assert.equal(amendedContract.reference.streamVersion, contract.reference.streamVersion + 1);
  assert.equal(amendedOrder.values.totalMinor, 30000); assert.equal(amendedContract.values.totalMinor, 30000); assert.deepEqual(amendedOrder.values.contract, amendedContract.reference);
  assert.equal(blockedProject.values.status, 'scope_pending'); assert.deepEqual(blockedProject.values.scopeLines, project.values.scopeLines);
  assert.deepEqual(await ui.native('milestone', milestone.reference.objectId), milestone); await screenshot('changes-commercial-approved-awaiting-project'); await closeDialog();

  await login('project-maker');
  const deliveries = await nativeObjects('delivery_version');
  await ui.begin('交付', '登记交付'); await ui.choose('里程碑', milestone, { contains: /合成第一阶段/u }); await ui.field('交付说明').fill('合成未确认项目范围不得交付');
  await onlyLine(ui.field('范围明细')); await ui.field('数量').fill('1');
  const page = getPage(), writes = [];
  const collect = request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/business/commands')) writes.push(request.postDataJSON()); };
  page.on('request', collect);
  try {
    const checkPromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/business-command-checks') && response.request().postDataJSON()?.type === 'delivery.report');
    await ui.dialog().getByRole('button', { name: '登记交付', exact: true }).click();
    const response = await checkPromise; assert.equal(response.status(), 200); assert.deepEqual((await response.json()).data, { allowedNow: false, reasonCode: 'PROJECT_SCOPE_PENDING' });
    await page.getByRole('alert').first().waitFor(); assert.equal(writes.length, 0); assert.deepEqual(await nativeObjects('delivery_version'), deliveries);
    assert.deepEqual(await ui.native('project', project.reference.objectId), blockedProject); report.checks.push('changes-pending-project-blocks-delivery');
  } finally { page.off('request', collect); }
  await closeDialog();
  await ui.open('范围变更', description); await ui.dialog().getByRole('button', { name: '确认项目新范围', exact: true }).click();
  const milestones = ui.dialog().getByRole('group', { name: '受影响的里程碑', exact: true });
  await milestones.getByRole('button', { name: '添加一项', exact: true }).click();
  await ui.choose('里程碑', milestone, { contains: /合成第一阶段/u, version: true });
  const lines = milestones.getByRole('group', { name: '明细', exact: true });
  await lines.getByRole('button', { name: '添加一项', exact: true }).click(); await onlyLine(lines.getByLabel(/^范围明细/u)); await lines.getByLabel('数量', { exact: true }).fill('3');
  await ui.dialog().getByLabel(confirmation, { exact: true }).check();
  change = await ui.submit('change_request.project_confirm', '确认项目新范围', 'change_request', 4);
  const confirmedProject = await ui.native('project', project.reference.objectId), confirmedMilestone = await ui.native('milestone', milestone.reference.objectId);
  assert.equal(change.values.status, 'completed'); assert.equal(change.values.projectConfirmedBy, 'project-maker');
  assert.equal(confirmedProject.values.status, 'active'); assert.equal(confirmedProject.reference.streamVersion, 3); assert.deepEqual(confirmedProject.values.order, amendedOrder.reference);
  assert.deepEqual(confirmedProject.values.scopeLines, amendedOrder.values.scopeLines); assert.deepEqual(confirmedMilestone.values.lines, [{ lineId, quantity: 3 }]); assert.equal(confirmedMilestone.reference.streamVersion, 2);
  const progress = await projection(context, 'progress', project.reference.objectId); assert.deepEqual(progress.values.lines, [{ lineId, promised: 3, delivered: 0, internallyReceived: 0, accepted: 0, remaining: 3 }]);
  assert.deepEqual(await ui.native('order', order.reference.objectId), amendedOrder); assert.deepEqual(await ui.native('contract', contract.reference.objectId), amendedContract);
  await screenshot('changes-project-scope-confirmed'); await closeDialog();
  report.checks.push('changes-price-does-not-apply-commercial-facts', 'changes-contract-order-atomic-money-update', 'changes-project-scope-confirmation-is-separate');
  const covered = new Set(report.checks.slice(completedAtStart).filter(item => item.startsWith('business-command:')).map(item => item.slice('business-command:'.length)));
  assert.deepEqual([...covered].sort(), [...CHANGES_BROWSER_COMMANDS].sort());
  return { change, project: confirmedProject, milestone: confirmedMilestone, order: amendedOrder, contract: amendedContract };
}
