// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

function deferred() { let resolve, reject; const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; }); void promise.catch(() => {}); return { promise, resolve, reject }; }
async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 15000); })]); }
  finally { clearTimeout(timer); }
}
async function readObjects(page, fixture, type) {
  return page.evaluate(async ({ workspaceId, type }) => {
    const response = await fetch('/v2/workspaces/' + encodeURIComponent(workspaceId) + '/business/' + type, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('FIXTURE_READ_FAILED'); return (await response.json()).data;
  }, { workspaceId: fixture.workspaceId, type });
}
async function openCustomerForm(page, name) {
  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '客户与销售', exact: true }).click();
  await page.getByRole('heading', { name: '客户与销售', exact: true }).waitFor();
  await page.getByRole('tab', { name: '客户', exact: true }).click();
  await page.getByRole('button', { name: '新建客户', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建客户', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill(name); return dialog;
}

/** Only call with a dedicated, seeded startEnterpriseWebFixture and its sales account. This helper never starts a browser or server. */
export async function verifySubmissionCancellation({ page, fixture }) {
  assert.equal(fixture.tenantId, 'enterprise-web-fixture'); assert.equal(fixture.mode, 'seeded'); assert.ok(fixture.workspaceId);
  const origin = new URL(fixture.origin); assert.equal(origin.hostname, '127.0.0.1'); assert.equal(new URL(page.url()).origin, fixture.origin);
  const session = await page.evaluate(async () => (await (await fetch('/v2/auth/session', { cache: 'no-store' })).json()).data);
  assert.equal(session.tenantId, fixture.tenantId); assert.equal(session.principalId, 'sales'); assert.equal(session.profile, 'development');
  const stamp = Date.now().toString(36), preflightName = '合成取消预检-' + stamp, savedName = '合成未知保存-' + stamp;
  const writes = [];
  const observe = request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/business/commands')) writes.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() });
  };
  page.on('request', observe);
  try {
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '知识与成果', exact: true }).click();
    await page.getByRole('heading', { name: '知识与成果', exact: true }).waitFor();
    const checked = deferred(), checkRelease = deferred(), checkFinished = deferred();
    const checkPattern = '**/business-command-checks';
    const holdCheck = async route => {
      try {
        const response = await route.fetch(); assert.equal(response.ok(), true);
        const body = await response.json(); assert.equal(body.data.allowedNow, true); checked.resolve();
        await checkRelease.promise;
        await route.fulfill({ response, json: body }).catch(error => { if (!/closed|cancel|not found|handled/iu.test(String(error))) throw error; });
      } catch (error) { checked.reject(error); checkFinished.reject(error); await route.abort('failed').catch(() => {}); }
      finally { checkFinished.resolve(); }
    };
    await page.route(checkPattern, holdCheck);
    try {
      const dialog = await openCustomerForm(page, preflightName);
      await dialog.getByRole('button', { name: '新建客户', exact: true }).click(); await within(checked.promise, 'PREFLIGHT_NOT_REACHED');
      assert.equal(await dialog.getByRole('button', { name: '关闭对话框', exact: true }).isDisabled(), true);
      await page.goBack(); await page.getByRole('heading', { name: '知识与成果', exact: true }).waitFor();
      checkRelease.resolve(); await within(checkFinished.promise, 'PREFLIGHT_NOT_RELEASED');
      await page.waitForFunction(() => document.querySelector('.mn-submission-scope')?.getAttribute('aria-busy') === 'false');
      assert.equal(writes.filter(item => item.body.name === preflightName).length, 0);
      assert.equal((await readObjects(page, fixture, 'customer')).filter(item => item.values.name === preflightName).length, 0);
    } finally { checkRelease.resolve(); await page.unroute(checkPattern, holdCheck); }

    // Delay an actual File read, not a fabricated import response.
    await page.evaluate(() => {
      if (window.__mnSubmissionFileGate) throw new Error('FILE_GATE_ALREADY_INSTALLED');
      const original = File.prototype.arrayBuffer;
      const gate = { started: false, release: undefined, restore: undefined };
      const replacement = async function () { const bytes = await original.call(this); gate.started = true; return new Promise(resolve => { gate.release = () => resolve(bytes); }); };
      gate.restore = () => { if (File.prototype.arrayBuffer === replacement) File.prototype.arrayBuffer = original; gate.release?.(); delete window.__mnSubmissionFileGate; };
      window.__mnSubmissionFileGate = gate; File.prototype.arrayBuffer = replacement;
    });
    const importRequests = [], observeImport = request => { if (request.method() === 'POST' && /\/workspaces\/[^/]+\/knowledge$/u.test(new URL(request.url()).pathname)) importRequests.push(request); };
    page.on('request', observeImport);
    try {
      const customers = await readObjects(page, fixture, 'customer'), source = customers.find(item => item.reference.objectId === fixture.references.customer.objectId); assert.ok(source);
      await page.getByRole('button', { name: '导入资料', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '导入业务资料', exact: true });
      await dialog.getByLabel('资料标题', { exact: true }).fill('合成取消文件-' + stamp);
      await dialog.getByLabel(/^资料文件/u).setInputFiles({ name: 'synthetic-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('仅用于取消边界验收。') });
      await dialog.getByLabel(/^关联业务记录/u).selectOption(source.reference.objectId);
      await dialog.getByRole('group', { name: '关联资料字段', exact: true }).getByLabel('名称', { exact: true }).check();
      await dialog.getByRole('button', { name: '保存资料', exact: true }).click();
      await page.waitForFunction(() => window.__mnSubmissionFileGate?.started === true);
      assert.equal(await dialog.getByRole('button', { name: '关闭对话框', exact: true }).isDisabled(), true);
      await page.goForward(); await page.getByRole('heading', { name: '客户与销售', exact: true }).waitFor();
      await page.evaluate(() => window.__mnSubmissionFileGate.release());
      await page.waitForFunction(() => document.querySelector('.mn-submission-scope')?.getAttribute('aria-busy') === 'false');
      assert.equal(importRequests.length, 0);
    } finally { page.off('request', observeImport); await page.evaluate(() => window.__mnSubmissionFileGate?.restore()); }

    const committed = deferred(), writeRelease = deferred(), writeFinished = deferred(), writePattern = '**/business/commands';
    const holdWrite = async route => {
      try {
        const response = await route.fetch(); assert.equal(response.ok(), true); const body = await response.json();
        assert.equal(body.data.values.name, savedName); committed.resolve(); await writeRelease.promise;
        await route.fulfill({ response, json: body }).catch(error => { if (!/closed|cancel|not found|handled/iu.test(String(error))) throw error; });
      } catch (error) { committed.reject(error); writeFinished.reject(error); await route.abort('failed').catch(() => {}); }
      finally { writeFinished.resolve(); }
    };
    await page.route(writePattern, holdWrite);
    try {
      const dialog = await openCustomerForm(page, savedName);
      await dialog.getByRole('button', { name: '新建客户', exact: true }).click(); await within(committed.promise, 'WRITE_NOT_COMMITTED');
      await page.goBack(); await page.getByRole('heading', { name: '知识与成果', exact: true }).waitFor();
      writeRelease.resolve(); await within(writeFinished.promise, 'WRITE_NOT_RELEASED');
    } finally { writeRelease.resolve(); await page.unroute(writePattern, holdWrite); }
    const recovery = page.getByRole('complementary', { name: '保存结果核对', exact: true });
    await recovery.getByRole('button', { name: '重试原保存', exact: true }).waitFor();
    assert.equal((await readObjects(page, fixture, 'customer')).filter(item => item.values.name === savedName).length, 1);
    await recovery.getByRole('button', { name: '重试原保存', exact: true }).click();
    await recovery.getByRole('status').waitFor();
    const savedRequests = writes.filter(item => item.body.name === savedName);
    assert.equal(savedRequests.length, 2); assert.ok(savedRequests[0].key); assert.equal(savedRequests[0].key, savedRequests[1].key);
    assert.deepEqual(savedRequests[0].body, savedRequests[1].body);
    assert.equal((await readObjects(page, fixture, 'customer')).filter(item => item.values.name === savedName).length, 1);
    return { fileReadStopped: true, preflightStopped: true, originalWriteReconciled: true };
  } finally { page.off('request', observe); }
}
