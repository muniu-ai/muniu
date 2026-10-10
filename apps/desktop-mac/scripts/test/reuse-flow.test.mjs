// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright-core";

let browser, server, address;
before(async () => {
  const bundled = await build({ entryPoints: [new URL("../fixtures/reuse-flow.tsx", import.meta.url).pathname], bundle: true,
    platform: "browser", format: "esm", jsx: "automatic", write: false, outfile: "team-views.js" });
  const files = new Map(bundled.outputFiles.map(file => [file.path.endsWith(".css") ? "/app.css" : "/app.js", file.text]));
  server = createServer((request, response) => {
    const content = files.get(request.url);
    response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript" : request.url === "/app.css" ? "text/css" : "text/html");
    response.end(content ?? '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${server.address().port}`;
  const executablePath = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  assert.ok(executablePath, "视图测试需要 Chrome 或 Chromium");
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function page(fixture) { const current = await browser.newPage({ viewport: { width: 960, height: 640 } }); current.setDefaultTimeout(5000);current.on("pageerror",error=>console.error("fixture page error:",error.message));await current.goto(`${address}${fixture ? `?fixture=${fixture}` : ""}`); return current; }

test('记忆未知请求跨卸载复用身份，撤权立即清理并拒收旧响应', async () => {
 const current = await page('memory'); try {
  await current.getByRole('button', { name: '接受', exact: true }).click(); await current.getByRole('button', { name: '重试记忆操作', exact: true }).waitFor();
  await current.getByRole('button', { name: '卸载面板', exact: true }).click(); await current.getByRole('button', { name: '打开面板', exact: true }).click(); await current.getByRole('button', { name: '重试记忆操作', exact: true }).click(); await current.getByText('已确认', { exact: true }).waitFor();
  const calls = await current.evaluate(() => window.calls); assert.deepEqual(calls[0], calls[1]);
  const before = await current.evaluate(() => window.reuseDriver.reads); await current.evaluate(() => window.reuseDriver.hold()); await current.waitForFunction(count => window.reuseDriver.reads > count, before);
  await current.evaluate(() => { window.reuseDriver.revoke(); window.reuseDriver.release(); }); assert.equal(await current.getByText('受保护记忆正文', { exact: true }).count(), 0); await current.getByText('来源已撤权', { exact: true }).waitFor();
 } finally { await current.close(); }
});
test('启用未知请求跨面板保存版本，来源撤权隐藏技能说明', async () => {
 const current = await page('skill'); try {
  await current.getByRole('button').filter({ hasText: '研究技能' }).click(); await current.getByRole('button', { name: '启用此版本', exact: true }).click(); await current.getByRole('button', { name: '核对上次技能操作', exact: true }).waitFor();
  await current.getByRole('button', { name: '卸载面板', exact: true }).click(); await current.getByRole('button', { name: '打开面板', exact: true }).click(); await current.getByRole('button', { name: '核对上次技能操作', exact: true }).click(); await current.getByText('技能操作已保存。', { exact: true }).waitFor();
  const calls = await current.evaluate(() => window.calls); assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0].input.recommendationEnabled, false);
  await current.getByRole('button').filter({ hasText: '研究技能' }).click(); await current.getByText('获准期间可见的角色说明', { exact: true }).waitFor(); await current.evaluate(() => window.reuseDriver.revoke()); await current.getByText('获准期间可见的角色说明', { exact: true }).waitFor({ state: 'hidden' }); assert.equal(await current.getByText('获准期间可见的角色说明', { exact: true }).count(), 0); await current.getByText('资料撤权。重新授权', { exact: true }).waitFor();
 } finally { await current.close(); }
});
test('技能试用新目标固定版本与所有交付项，不复制原任务资料', async () => {
 const current = await page('trial'); try {
  await current.getByRole('button', { name: '选入技能试用', exact: true }).click(); await current.getByText('反证清单', { exact: true }).waitFor(); await current.getByText('说明不确定性', { exact: true }).waitFor();
  await current.getByRole('button', { name: '准备执行计划', exact: true }).click(); await current.getByRole('button', { name: '继续准备', exact: true }).waitFor(); assert.equal(await current.getByLabel('任务目标', { exact: true }).isDisabled(), true); await current.getByRole('button', { name: '继续准备', exact: true }).click(); await current.getByText('新任务已准备', { exact: true }).waitFor();
  const calls = await current.evaluate(() => window.calls), created = calls.filter(item => item.method === 'goal'); assert.deepEqual(created[0], created[1]); assert.deepEqual(created[0].input.resourceRefs, []); assert.equal(created[0].input.deliverables.length, 2); assert.deepEqual(calls.find(item => item.method === 'plan').input.skillRef, { id: 'skill', version: '3', digest: 'c'.repeat(64) });
 } finally { await current.close(); }
});
test('首次打开已撤权技能仍可按 Host 元数据停用，未知响应复用原命令', async () => {
 const current = await page('skill-revoked'); try {
  await current.getByRole('button').filter({ hasText: '来源已不可用' }).click(); await current.getByText('资料撤权。重新授权', { exact: true }).waitFor();
  assert.equal(await current.getByText('获准期间可见的角色说明', { exact: true }).count(), 0);
  await current.getByRole('button', { name: '停用此技能', exact: true }).click(); await current.getByRole('button', { name: '核对上次技能操作', exact: true }).click(); await current.getByText('技能操作已保存。', { exact: true }).waitFor();
  await current.getByRole('button', { name: '停用此技能', exact: true }).waitFor({ state: 'hidden' });
  const calls = await current.evaluate(() => window.calls); assert.deepEqual(calls[0], calls[1]); assert.deepEqual(calls[0].input, { command: 'disable', expectedStreamVersion: 2 });
  assert.equal(await current.getByText('获准期间可见的角色说明', { exact: true }).count(), 0);
 } finally { await current.close(); }
});
test('工作区事件复验技能权限时保留用户已选评测文件，重新获准后仍能提交原草稿', async () => {
 const current = await page('skill-evaluation'); try {
  await current.getByRole('button').filter({ hasText: '研究技能' }).click();
  const evidence = [{ artifactRef: { namespace: 'asset', resourceId: 'proof', streamVersion: 1, digest: 'e'.repeat(64) }, artifactSha256: 'f'.repeat(64), method: 'human', reviewer: 'owner' }];
  await current.getByLabel('受保护评测报告', { exact: true }).setInputFiles({ name: 'local-report.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await current.getByLabel('评测证据引用文件', { exact: true }).setInputFiles({ name: 'evidence.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(evidence)) });
  await current.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === '提交受保护报告')?.disabled);
  await current.evaluate(() => window.reuseDriver.event()); await current.getByRole('heading', { name: '质量评测', exact: true }).waitFor();
  await current.getByRole('button', { name: '提交受保护报告', exact: true }).click(); await current.getByText('技能操作已保存。', { exact: true }).waitFor();
  const calls = await current.evaluate(() => window.calls); assert.equal(calls[0].name, 'local-report.json'); assert.equal(calls[0].protected, true); assert.deepEqual(calls[1].input.evidence, evidence); assert.equal(calls[1].evaluationId, 'evaluation');
 } finally { await current.close(); }
});
test('跟进必须明确新增授权，未知响应复用原周期额度和身份', async () => {
 const current = await page('followup'); try {
  await current.getByText('新增受控跟进', { exact: true }).click(); await current.getByLabel('关联目标', { exact: true }).selectOption('goal'); await current.getByLabel('跟进名称', { exact: true }).fill('跟进需求'); await current.getByLabel('每次变化后完成什么', { exact: true }).fill('整理新增需求'); await current.getByLabel('跟进执行模型', { exact: true }).selectOption('model'); await current.getByLabel('有效期至', { exact: true }).fill('2026-10-20T00:00');
  const submit = current.getByRole('button', { name: '启用跟进', exact: true }); assert.equal(await submit.isDisabled(), true); await current.getByRole('checkbox').check(); await submit.click(); await current.getByRole('button', { name: '核对上次跟进操作', exact: true }).waitFor(); await current.getByRole('button', { name: '卸载面板', exact: true }).click(); await current.getByRole('button', { name: '打开面板', exact: true }).click(); await current.getByRole('button', { name: '核对上次跟进操作', exact: true }).click(); await current.getByText('跟进操作已保存。', { exact: true }).waitFor();
  const calls = await current.evaluate(() => window.calls); assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0].input.enabled, true); assert.equal(calls[0].input.periodBudget.periodMs, 86400000); assert.deepEqual(calls[0].input.resourceRefs, [calls[0].input.trigger.sourceRef]);
 } finally { await current.close(); }
});
