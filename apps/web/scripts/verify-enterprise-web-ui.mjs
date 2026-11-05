// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startEnterpriseWebFixture } from '../../../scripts/lib/enterprise-web-fixture.mjs';
import { verifySubmissionCancellation } from './submission-cancellation-checks.mjs';
import { verifySalesBusinessFlow, verifyDeliveryBusinessFlow, verifyMetricsBusinessFlow, verifyFinanceBusinessFlow, verifyChangesBusinessFlow } from './business-flow-checks.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--scenario')) throw new Error('WEB_SCENARIO_INVALID');
const selected = args[1] ?? 'smoke';
const evidence = await mkdtemp(join(tmpdir(), 'mn-e61-ui-evidence-'));
let browser, fixture, context, page, startingFixture, startingBrowser, closing;
const report = { scenario: selected, synthetic: true, checks: [], screenshots: [], pageErrors: [], apiRefusals: [], evidence };
const cleanup = () => closing ??= (async () => {
  const failures = [];
  fixture ??= await startingFixture?.catch(() => undefined);
  browser ??= await startingBrowser?.catch(() => undefined);
  for (const [name, close] of [['browser', () => browser?.close()], ['fixture', () => fixture?.close()]]) {
    try { await close(); } catch { failures.push(name); }
  }
  report.cleanup = failures.length ? 'failed:' + failures.join(',') : 'passed';
  if (failures.length) { report.status = 'cleanup_failed'; process.exitCode = 1; }
})();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.status = 'interrupted'; report.interruption = signal;
  void cleanup().finally(async () => {
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
});

async function login(person, { url = fixture.origin, invited = false } = {}) {
  await context?.close();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  context.setDefaultTimeout(8000); page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', async response => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith('/v2/') || (response.status() < 400 && !path.endsWith('/business-command-checks'))) return;
    const envelope = await response.json().catch(() => undefined);
    if (response.status() >= 400 || envelope?.data?.allowedNow === false) report.apiRefusals.push({ path, status: response.status(), code: envelope?.code ?? envelope?.data?.reasonCode });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: '木牛合成验收企业' }).click();
  const account = fixture.accounts.find(item => item.id === person); assert.ok(account);
  await page.getByRole('button', { name: account.label, exact: true }).click();
  if (invited) await page.getByRole('heading', { name: '接受企业邀请', exact: true }).waitFor();
  else await page.getByRole('navigation', { name: '主导航', exact: true }).waitFor();
  report.checks.push('real-oidc-login:' + person);
}
async function navigate(group, tab) {
  await page.getByRole('button', { name: group, exact: true }).click();
  if (tab) await page.getByRole('tab', { name: tab, exact: true }).click();
}
async function screenshot(name) {
  const fit = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(fit.scrollWidth <= fit.width + 1, 'Unexpected horizontal page overflow');
  const file = join(evidence, name + '.jpg');
  await page.screenshot({ path: file, type: 'jpeg', quality: 80, scale: 'css' });
  report.screenshots.push({ name, file, viewport: page.viewportSize() });
}
async function closeDialog() { await page.getByRole('dialog').getByRole('button', { name: '关闭对话框', exact: true }).click(); }
async function nativeObjects(type) {
  return page.evaluate(async ({ workspaceId, type }) => {
    const result = await fetch('/v2/workspaces/' + encodeURIComponent(workspaceId) + '/business/' + type, { cache: 'no-store', credentials: 'same-origin' });
    if (!result.ok) throw new Error('NATIVE_READ_FAILED'); return (await result.json()).data;
  }, { workspaceId: fixture.workspaceId, type });
}

async function smoke() {
  await login('sales');
  assert.deepEqual(await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button').allTextContents(), ['经营总览', '待我处理', '客户与销售', '项目与交付', '资金与复盘', '知识与成果']);
  assert.equal(await page.getByRole('navigation', { name: '企业管理', exact: true }).count(), 0);
  await navigate('客户与销售', '客户'); await page.getByRole('table').waitFor();
  assert.doesNotMatch(await page.getByRole('table').innerText(), /当前状态|未提供/u);
  const name = '合成浏览器新客户', renamed = name + '（已核对）';
  await page.getByRole('button', { name: '新建客户', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(name);
  await page.getByRole('dialog').getByLabel(/^归属部门/u).waitFor();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('button', { name: '关闭对话框', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: '新建客户', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: '关闭对话框', exact: true }).evaluate(element => element === document.activeElement), true);
  report.checks.push('dialog-keyboard-focus-cycle');
  await page.getByRole('dialog').getByRole('button', { name: '新建客户', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: '查看详情' }).click();
  await page.getByRole('button', { name: '修改客户名称', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(renamed);
  await page.getByRole('dialog').getByRole('button', { name: '修改客户名称', exact: true }).last().click();
  await page.getByRole('dialog').getByText(renamed, { exact: true }).first().waitFor();
  await page.getByText(/当前第 2 版/u).waitFor();
  const saved = (await nativeObjects('customer')).filter(item => item.values.name === renamed); assert.equal(saved.length, 1); assert.equal(saved[0].reference.streamVersion, 2);
  report.checks.push('customer-create-and-rename-real-facts'); await screenshot('customer-detail'); await closeDialog();
  await page.getByLabel('筛选客户', { exact: true }).fill('不存在的合成记录'); await page.getByText('没有匹配的记录', { exact: true }).waitFor();
  await page.getByLabel('筛选客户', { exact: true }).fill(''); await page.getByRole('table').waitFor(); report.checks.push('filter-empty-and-restore');
  await navigate('经营总览');
  const objective = page.locator('section').filter({ has: page.getByRole('heading', { name: '经营目标', exact: true }) });
  await objective.getByRole('button', { name: '查看台账', exact: true }).click();
  await page.getByRole('tab', { name: '经营目标', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '经营目标', exact: true }).getAttribute('aria-selected'), 'true');
  await page.goBack(); await page.getByRole('heading', { name: '经营总览', exact: true }).waitFor();
  await page.goForward(); assert.equal(await page.getByRole('tab', { name: '经营目标', exact: true }).getAttribute('aria-selected'), 'true'); report.checks.push('overview-category-history');
  await navigate('客户与销售', '客户'); await page.getByRole('table').waitFor(); await screenshot('customer-list-desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('customer-list-mobile');
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.getByRole('heading', { name: '登录企业工作台', exact: true }).waitFor(); report.checks.push('logout-clears-business-view');
}

async function permissions() {
  await login('reader'); await navigate('客户与销售', '报价'); await page.getByRole('table').waitFor();
  assert.doesNotMatch(await page.getByRole('table').innerText(), /¥|300\.00|200\.00/u);
  await page.getByRole('row').filter({ hasText: '草稿' }).getByRole('button', { name: '查看详情' }).click();
  await page.getByText('当前账号仅能查看这条记录。', { exact: true }).waitFor();
  assert.doesNotMatch(await page.getByRole('dialog').innerText(), /¥|单价|合计金额/u);
  assert.equal(await page.getByRole('button', { name: '批准报价', exact: true }).count(), 0);
  await screenshot('reader-quote'); report.checks.push('reader-price-and-write-isolation'); await closeDialog();
  await login('manager'); await navigate('客户与销售', '报价'); await page.getByRole('table').waitFor();
  await page.getByRole('row').filter({ hasText: '草稿' }).getByRole('button', { name: '查看详情' }).click();
  await page.getByRole('button', { name: '批准报价', exact: true }).click();
  await page.getByLabel('我已核对上方当前内容，明确提交本次业务决定', { exact: true }).check();
  await page.getByRole('dialog').getByRole('button', { name: '批准报价', exact: true }).last().click();
  await page.getByText(/当前第 2 版/u).waitFor();
  const quotes = await nativeObjects('quote_version'), quote = quotes.find(item => item.reference.objectId === fixture.references.quoteDraft.objectId);
  assert.equal(quote.values.status, 'approved'); assert.equal(quote.reference.streamVersion, 2);
  await screenshot('manager-approved-quote'); report.checks.push('different-actor-business-approval');
}

async function initialization() {
  await login('admin');
  await page.getByRole('heading', { name: '建立经营主体', exact: true }).waitFor();
  assert.equal(await page.getByRole('radio', { name: /连接木牛 Sales/u }).isDisabled(), true);
  await page.getByLabel('经营主体名称', { exact: true }).fill('合成首次经营主体');
  await page.getByRole('button', { name: '建立经营主体', exact: true }).click();
  await page.getByLabel('当前经营主体', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('当前经营主体', { exact: true }).locator('option:checked').innerText(), '合成首次经营主体');
  await page.getByRole('navigation', { name: '企业管理', exact: true }).waitFor();
  await navigate('客户与销售', '客户');
  await page.getByRole('button', { name: '新建客户', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('不得自动取得业务权限');
  await page.getByRole('dialog').getByRole('alert').waitFor();
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: '新建客户', exact: true }).isDisabled(), true);
  const count = await page.evaluate(async () => {
    const workspaces = (await (await fetch('/v2/workspaces', { cache: 'no-store' })).json()).data;
    const objects = await fetch('/v2/workspaces/' + encodeURIComponent(workspaces[0].id) + '/business/customer', { cache: 'no-store' });
    return (await objects.json()).data.length;
  });
  assert.equal(count, 0);
  report.checks.push('administrator-workspace-initialization', 'administrator-does-not-inherit-business-rights', 'unavailable-sales-mode-disabled');
  await screenshot('administrator-business-refusal');
}

async function knowledge() {
  await login('sales'); await navigate('知识与成果');
  const title = '合成浏览器资料';
  await page.getByRole('button', { name: '导入资料', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入业务资料', exact: true });
  await dialog.getByLabel('资料标题', { exact: true }).fill(title);
  await dialog.getByLabel(/^资料文件/u).setInputFiles({ name: 'browser-brief.txt', mimeType: 'text/plain', buffer: Buffer.from(title + '\n\n这是经过浏览器导入的合成需求，供来源和导出验收使用。') });
  await dialog.getByLabel(/^关联业务记录/u).selectOption(fixture.references.customer.objectId);
  await dialog.getByRole('group', { name: '关联资料字段', exact: true }).getByLabel('名称', { exact: true }).check();
  await dialog.getByRole('button', { name: '保存资料', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('dialog').getByRole('button', { name: '导出当前资料', exact: true }).waitFor(); await closeDialog();
  await page.getByLabel('搜索业务资料', { exact: true }).fill(title); await page.getByRole('button', { name: '搜索资料', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(title, 'u') }).first().click();
  const detail = page.getByRole('dialog'); await detail.getByText('这是经过浏览器导入的合成需求，供来源和导出验收使用。', { exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download'); await detail.getByRole('button', { name: '导出当前资料', exact: true }).click();
  const download = await downloadPromise, file = join(evidence, 'knowledge.docx'); await download.saveAs(file);
  const bytes = await readFile(file); assert.equal(bytes.subarray(0, 2).toString(), 'PK'); assert.ok(bytes.byteLength > 100);
  report.checks.push('knowledge-import-with-real-source', 'knowledge-search-and-read', 'permission-checked-document-download'); await screenshot('knowledge-read');
  await login('reader'); await navigate('知识与成果'); await page.getByLabel('搜索业务资料', { exact: true }).fill(title); await page.getByRole('button', { name: '搜索资料', exact: true }).click();
  await page.getByText('没有匹配的可见资料', { exact: true }).waitFor(); report.checks.push('private-document-hidden-from-other-member');
}

async function finance() {
  await login('finance'); await navigate('客户与销售', '订单'); await page.getByRole('table').waitFor();
  await page.getByRole('row').filter({ hasText: '有效' }).getByRole('button', { name: '查看详情' }).click();
  const summary = page.getByRole('heading', { name: '订单资金', exact: true }).locator('..');
  await summary.getByText('应收余额', { exact: true }).waitFor();
  const amount = label => summary.getByText(label, { exact: true }).evaluate(element => element.nextElementSibling?.textContent);
  assert.equal(await amount('合计金额'), '¥200.00'); assert.equal(await amount('净回款'), '¥100.00'); assert.equal(await amount('应收余额'), '¥100.00');
  report.checks.push('partial-receipt-order-balance-from-host'); await screenshot('partial-receipt-balance'); await closeDialog();
  await navigate('项目与交付', '项目'); await page.getByRole('table').waitFor();
  await page.getByRole('table').getByRole('button', { name: '查看详情' }).first().click();
  await page.getByText('成本尚未确认完整，暂不显示毛利。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').getByText('毛利', { exact: true }).count(), 0);
  report.checks.push('missing-cost-does-not-display-margin'); await screenshot('project-cost-incomplete');
}

async function management() {
  await login('admin'); await navigate('组织与权限');
  await page.getByRole('button', { name: '添加部门', exact: true }).click();
  await page.getByRole('dialog').getByLabel('部门名称', { exact: true }).fill('合成业务部门');
  await page.getByRole('dialog').getByRole('button', { name: '添加部门', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByText('合成业务部门', { exact: true }).waitFor();
  await page.getByRole('button', { name: '邀请成员', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('成员姓名', { exact: true }).fill('合成新成员');
  await dialog.getByLabel(/^企业登录账号标识/u).fill(fixture.invitationSubject);
  await dialog.getByRole('button', { name: '创建邀请', exact: true }).click();
  const invitation = await dialog.getByLabel('邀请链接', { exact: true }).inputValue();
  assert.equal(new URL(invitation).origin, fixture.origin);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await login('invitee', { url: invitation, invited: true });
  assert.equal(await page.getByLabel(/^管理员提供的完整邀请链接/u).inputValue(), invitation);
  await page.getByRole('button', { name: '接受企业邀请', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航', exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: '企业管理', exact: true }).count(), 0);
  report.checks.push('invite-and-accept-with-bound-oidc-person');
  await login('admin'); await navigate('组织与权限');
  await page.getByRole('button', { name: '授予业务权限', exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^成员/u).selectOption({ label: '合成新成员' });
  await dialog.getByLabel(/^对象范围/u).selectOption('department');
  await dialog.getByLabel(/^部门/u).selectOption({ label: '合成业务部门' });
  await dialog.getByLabel('修改业务记录', { exact: true }).check();
  await dialog.getByLabel('有效期至', { exact: true }).fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  await dialog.getByRole('button', { name: '授予业务权限', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  let roleRow = page.getByRole('row').filter({ hasText: '合成新成员' }).filter({ hasText: '指定部门' });
  await roleRow.getByRole('button', { name: '撤销权限', exact: true }).waitFor();
  await screenshot('organization-granted-department');
  await login('invitee'); await navigate('客户与销售', '客户');
  await page.getByRole('button', { name: '新建客户', exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('部门候选原草稿');
  await dialog.getByLabel(/^归属部门/u).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '新建客户', exact: true }).isDisabled(), true);
  await dialog.getByLabel(/^归属部门/u).selectOption({ label: '合成业务部门' });
  await dialog.getByLabel('名称', { exact: true }).fill('合成部门客户');
  await dialog.getByLabel(/^归属部门/u).waitFor();
  assert.equal(await dialog.getByLabel(/^归属部门/u).inputValue(), '');
  assert.equal(await dialog.getByRole('button', { name: '新建客户', exact: true }).isDisabled(), true);
  await dialog.getByLabel(/^归属部门/u).selectOption({ label: '合成业务部门' });
  await screenshot('customer-department-selection');
  await dialog.getByRole('button', { name: '新建客户', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  const created = (await nativeObjects('customer')).filter(item => item.values.name === '合成部门客户');
  assert.equal(created.length, 1); assert.equal(created[0].reference.streamVersion, 1); assert.equal(typeof created[0].values.departmentId, 'string');
  report.checks.push('department-only-customer-creation-and-draft-reset');
  await login('admin'); await navigate('组织与权限');
  roleRow = page.getByRole('row').filter({ hasText: '合成新成员' }).filter({ hasText: '指定部门' });
  await roleRow.getByRole('button', { name: '撤销权限', exact: true }).click();
  await page.getByLabel('确认撤销这项业务授权', { exact: true }).check();
  await page.getByRole('dialog').getByRole('button', { name: '撤销权限', exact: true }).click();
  await roleRow.getByText('已撤销', { exact: true }).waitFor();
  report.checks.push('create-department-and-grant-revoke-scoped-role');
  await login('invitee'); await navigate('客户与销售', '客户');
  assert.equal((await nativeObjects('customer')).length, 0);
  await page.getByRole('button', { name: '新建客户', exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('撤权后不得创建'); await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.getByRole('button', { name: '新建客户', exact: true }).isDisabled(), true);
  report.checks.push('revoked-department-membership-hides-and-blocks-customer');
  await login('admin'); await navigate('组织与权限');
  for (const [operation, state] of [['disable', '已停用'], ['activate', '有效'], ['remove', '已移除']]) {
    const memberRow = page.getByRole('row').filter({ hasText: '合成新成员' }).filter({ has: page.getByRole('button', { name: '管理成员状态', exact: true }) });
    await memberRow.getByRole('button', { name: '管理成员状态', exact: true }).click();
    await page.getByLabel(/^成员操作/u).selectOption(operation);
    await page.getByLabel('确认对 合成新成员 提交这次变更', { exact: true }).check();
    await page.getByRole('dialog').getByRole('button', { name: '确认变更', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await memberRow.getByText(state, { exact: true }).waitFor();
  }
  report.checks.push('member-disable-reactivate-remove');
  const adminRow = page.getByRole('row').filter({ hasText: '组织管理员（合成）' }).filter({ has: page.getByRole('button', { name: '管理成员状态', exact: true }) });
  await adminRow.getByRole('button', { name: '管理成员状态', exact: true }).click();
  await page.getByLabel('确认对 组织管理员（合成） 提交这次变更', { exact: true }).check();
  await page.getByRole('dialog').getByRole('button', { name: '确认变更', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').waitFor();
  assert.match(await page.getByRole('dialog').getByRole('alert').innerText(), /至少保留一名有效的组织管理员/u);
  await screenshot('last-administrator-refusal'); await closeDialog();
  report.checks.push('last-active-administrator-cannot-disable-self');
  await navigate('Agent 与流程');
  const enable = page.getByRole('button', { name: '启用流程', exact: true }); await enable.first().waitFor();
  assert.equal(await enable.count(), 5);
  await enable.first().click(); await page.getByRole('button', { name: '已启用', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '已启用', exact: true }).isDisabled(), true);
  await screenshot('workflow-selected'); report.checks.push('workflow-publish-select-real-state');
  await navigate('连接与模型'); await page.getByText('尚未配置可用模型', { exact: true }).waitFor();
  await navigate('用量与审计'); await page.getByText('尚未配置工作区模型额度', { exact: true }).waitFor();
  report.checks.push('missing-model-and-quota-honest-empty-states');
}

try {
  if (!['smoke', 'permissions', 'cancellation', 'initialization', 'knowledge', 'finance', 'management', 'sales', 'delivery', 'metrics', 'finance-actions', 'changes'].includes(selected)) throw new Error('WEB_SCENARIO_INVALID');
  startingFixture = startEnterpriseWebFixture({ webRoot: join(root, 'apps/web/dist'), mode: selected === 'initialization' ? 'uninitialized' : 'seeded' }); fixture = await startingFixture;
  startingBrowser = chromium.launch({ headless: true, chromiumSandbox: true, args: ['--disable-gpu', '--renderer-process-limit=2', '--js-flags=--max-old-space-size=128'] }); browser = await startingBrowser;
  report.browserVersion = browser.version();
  if (selected === 'smoke') await smoke();
  if (selected === 'permissions') await permissions();
  if (selected === 'initialization') await initialization();
  if (selected === 'knowledge') await knowledge();
  if (selected === 'finance') await finance();
  if (selected === 'management') await management();
  if (selected === 'sales') await verifySalesBusinessFlow({ getPage: () => page, login, navigate, nativeObjects, closeDialog, screenshot, fixture, report });
  if (selected === 'delivery') await verifyDeliveryBusinessFlow({ getPage: () => page, login, navigate, nativeObjects, closeDialog, screenshot, fixture, report });
  if (selected === 'metrics') await verifyMetricsBusinessFlow({ getPage: () => page, login, navigate, nativeObjects, closeDialog, screenshot, fixture, report });
  if (selected === 'finance-actions') await verifyFinanceBusinessFlow({ getPage: () => page, login, navigate, nativeObjects, closeDialog, screenshot, fixture, report });
  if (selected === 'changes') await verifyChangesBusinessFlow({ getPage: () => page, login, navigate, nativeObjects, closeDialog, screenshot, fixture, report });
  if (selected === 'cancellation') { await login('sales'); report.cancellation = await verifySubmissionCancellation({ page, fixture }); report.checks.push('submission-abort-and-original-ticket-reconciliation'); }
  assert.deepEqual(report.pageErrors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error?.message ?? error).replace(/\?[^'"\s)]+/gu, '?[redacted]'); process.exitCode = 1;
  if (page && !page.isClosed()) {
    report.failureBody = (await page.locator('body').innerText().catch(() => '')).slice(0, 8000);
    report.failureControls = await page.locator('input,select,button').evaluateAll(items => items.map(item => ({ tag: item.tagName, type: item.getAttribute('type'), text: item.tagName === 'BUTTON' ? item.textContent : undefined, aria: item.getAttribute('aria-label'), labels: item.labels ? [...item.labels].map(label => label.textContent) : undefined, disabled: item.disabled }))).catch(() => []);
    await page.screenshot({ path: join(evidence, 'failure.jpg'), type: 'jpeg', quality: 80, scale: 'css' }).catch(() => {});
  }
} finally {
  await cleanup();
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: report.status, scenario: selected, checks: report.checks, evidence, ...(report.error ? { error: report.error } : {}) }) + '\n');
}
