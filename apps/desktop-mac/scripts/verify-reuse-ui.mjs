// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TEAM_SKILL_BENCHMARK as corpus, benchmarkDigest, teamSkillResultsDigest } from "@mn/task-orchestration";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktopDir, "../..");
const apiUrl = `http://127.0.0.1:${await freePort()}`;
const appUrl = `http://127.0.0.1:${await freePort()}`;
const children = [];
const hostErrors = [];
let browser;
let diagnosticPage;
try {
  launch(process.execPath, [join(desktopDir, "scripts/real-host-fixture.mjs")], root,
    { MN_FIXTURE_API_PORT: new URL(apiUrl).port, MN_FIXTURE_APP_ORIGIN: appUrl, MN_FIXTURE_MODE: "reuse" });
  await ready(`${apiUrl}/v2/health`);
  launch(join(root, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", new URL(appUrl).port, "--strictPort"], desktopDir, { VITE_MN_API_URL: apiUrl });
  await ready(appUrl);
  const executablePath = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
  assert.ok(executablePath, "资料验收需要 Chrome 或 Chromium");
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 760 }, acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem("muniu:v2:onboarding-complete", "1"));
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  diagnosticPage = page;
  page.on("pageerror",error=>process.stderr.write(`UI error: ${error.message}\n`));
  page.on("response",async response=>{if(response.url().startsWith(apiUrl)&&response.status()>=400){hostErrors.push({status:response.status(),path:new URL(response.url()).pathname});try{const body=await response.json();process.stderr.write(`Host error: ${response.status()} ${new URL(response.url()).pathname} ${JSON.stringify(body.error??body)}\n`);}catch{process.stderr.write(`Host error: ${response.status()}\n`);}}});
  const read=async(path)=>{const response=await fetch(`${apiUrl}${path}`);assert.ok(response.ok,`${path}: ${response.status}`);return(await response.json()).data;};
  const workspace=(await read('/v2/workspaces'))[0];
  await page.goto(appUrl);
  async function compose(objective, team = false, businessSource = false) {
    const create = page.getByRole('button', { name: '新建任务', exact: true });
    await (await create.isVisible() ? create : page.getByRole('button', { name: '委派任务', exact: true })).click();
    const composer = page.getByRole('form', { name: '委派新任务' });
    await composer.getByLabel('任务目标', { exact: true }).fill(objective); await composer.getByLabel('验收要求', { exact: true }).fill('来源明确');
    if (businessSource) { await composer.getByRole('button', { name: '选择业务资料', exact: true }).click(); await composer.getByLabel('业务对象资料').selectOption('customer:delivery-customer'); await composer.getByRole('button', { name: '加入任务资料', exact: true }).click(); }
    if (team) await composer.getByRole('radio', { name: '研究汇总', exact: true }).check();
    await composer.getByRole('button', { name: '准备执行计划', exact: true }).click(); await page.getByRole('button', { name: '确认计划并启动', exact: true }).click(); await page.getByRole('button', { name: '接收成果', exact: true }).waitFor({ timeout: 30000 });
    const goals = await read(`/v2/workspaces/${workspace.id}/goals`); return goals.find(goal => goal.objective === objective);
  }
  async function accept() { const output = page.getByRole('region', { name: '成果验收', exact: true }); for (const box of await output.getByRole('checkbox').all()) await box.check(); await output.getByRole('button', { name: '接收成果', exact: true }).click(); await page.getByRole('region', { name: '目标详情', exact: true }).getByText('已验收', { exact: true }).waitFor(); }
  async function agents() { if (!await page.getByRole('button', { name: 'Agents', exact: true }).isVisible()) await page.getByRole('button', { name: '技术配置', exact: true }).click(); await page.getByRole('button', { name: 'Agents', exact: true }).click(); await page.getByRole('heading', { name: '团队技能', exact: true }).waitFor(); }
  const parent = await compose('保留未关闭目标供业务跟进', false, true);
  const sourceGoal = await compose('形成可复用的研究交付流程', true); await accept();
  await agents(); await page.getByText('从验收成果保存技能版本', { exact: true }).click();
  const save = page.getByRole('form', { name: '保存团队技能', exact: true }); await save.getByLabel('已验收任务', { exact: true }).selectOption(sourceGoal.id); await save.getByLabel('技能名称', { exact: true }).fill('合成研究流程'); await save.getByLabel('适用场景', { exact: true }).fill('核对需求、来源与反证'); await save.getByRole('button', { name: '保存不可变版本', exact: true }).click();
  const skillPanel = page.getByRole('article', { name: '团队技能详情', exact: true }); await skillPanel.waitFor(); assert.equal(await skillPanel.getByRole('button', { name: '启用此版本', exact: true }).count(), 0);
  const catalog = await read(`/v2/workspaces/${workspace.id}/team-skills`), skill = catalog.items[0]; assert.equal(skill.validation, 'unmeasured');
  await skillPanel.getByRole('button', { name: '试用为新任务', exact: true }).click(); const trialComposer = page.getByRole('form', { name: '委派新任务' }); await trialComposer.getByRole('region', { name: '技能试用', exact: true }).waitFor(); await trialComposer.getByRole('button', { name: '准备执行计划', exact: true }).click(); await page.getByText(`技能版本 ${skill.version}（本任务固定）`, { exact: true }).waitFor();
  const trial = (await read(`/v2/workspaces/${workspace.id}/goals`)).find(goal => goal.objective === '合成研究流程'); const trialDetail = await read(`/v2/goals/${trial.id}?workspaceId=${workspace.id}`); assert.deepEqual(trialDetail.plan.skillRef, { id: skill.id, version: skill.version, digest: skill.digest }); assert.notEqual(trial.id, sourceGoal.id); assert.deepEqual(trial.resourceRefs, []);
  await page.getByRole('button', { name: '确认计划并启动', exact: true }).click(); await page.getByRole('button', { name: '接收成果', exact: true }).waitFor({ timeout: 30000 }); await accept();
  await agents(); await page.getByRole('button').filter({ hasText: '合成研究流程' }).click();
  const configuration = { executionMode: 'test_fixture', configuration: { model: { provider: 'fixture', name: 'fixture', revision: 'fixed', parameters: { temperature: 0 } }, promptSha256: 'a'.repeat(64), policySha256: 'b'.repeat(64), materialsSha256: corpus.manifest.tasksSha256, budget: { revision: 'budget-v1', maxTokens: 10000, maxCostMinorUnits: '100', currency: 'CNY' } }, baselineRevision: 'd'.repeat(40), candidateRevision: 'e'.repeat(40) };
  await page.getByLabel('评测配置文件', { exact: true }).setInputFiles({ name: 'configuration.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(configuration)) }); await page.getByRole('button', { name: '登记评测配置', exact: true }).click(); await page.getByText('测试替身 · 等待报告', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '启用此版本', exact: true }).count(), 0);
  const registered = (await read(`/v2/workspaces/${workspace.id}/team-skills/${skill.id}`)).evaluations[0], skillRef = { id: skill.id, version: skill.version, digest: skill.digest };
  const evidence = { artifactSha256: '0'.repeat(64), method: 'human', reviewer: 'local-owner' }, checks = rules => rules.map(rule => ({ id: rule.id, passed: true, evidence }));
  const report = { schemaVersion: 1, evaluationId: registered.id, skillRef, executionMode: 'test_fixture', datasetVersion: '1.0.0', datasetSha256: corpus.manifest.tasksSha256, configuration: configuration.configuration, configurationSha256: registered.configurationDigest, frozenAt: registered.frozenAt, tuningCaseIds: [], arms: ['baseline', 'candidate'].map(arm => ({ arm, implementationRevision: arm === 'baseline' ? configuration.baselineRevision : configuration.candidateRevision, configurationSha256: registered.configurationDigest, safetyRecovery: checks(corpus.controls), results: corpus.tasks.map(task => ({ taskId: task.id, runId: `${arm}:${task.id}`, startedAt: registered.frozenAt, inputSha256: benchmarkDigest(task.input), configurationSha256: registered.configurationDigest, firstAttempt: checks(task.acceptance), finalAttempt: checks(task.acceptance), safety: checks(task.safety), cost: { status: 'known', currency: 'CNY', minorUnits: arm === 'baseline' ? '100' : '50', evidence }, humanTime: { status: 'known', milliseconds: arm === 'baseline' ? 100 : 50, evidence } })) })) };
  const proofBytes = Buffer.from(JSON.stringify({ format: 'muniu.skill-evidence.v1', evaluationId: registered.id, executionMode: 'test_fixture', configurationDigest: registered.configurationDigest, skillRef, method: 'human', reviewer: 'local-owner', resultsDigest: teamSkillResultsDigest(report), observations: '合成证据，仅验证协议，不代表模型质量' }));
  const proofResponse = await fetch(`${apiUrl}/v2/assets`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'ui-skill-proof' }, body: JSON.stringify({ workspaceId: workspace.id, expectedStreamVersion: 0, attachments: [{ fileName: 'proof.json', mediaType: 'application/json', protected: true, contentBase64: proofBytes.toString('base64') }] }) }); assert.ok(proofResponse.ok); const proof = (await proofResponse.json()).data[0]; evidence.artifactSha256 = createHash('sha256').update(proofBytes).digest('hex');
  await page.getByLabel('受保护评测报告', { exact: true }).setInputFiles({ name: 'report.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) }); await page.getByLabel('评测证据引用文件', { exact: true }).setInputFiles({ name: 'evidence.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([{ artifactRef: { namespace: 'asset', resourceId: proof.id, streamVersion: proof.streamVersion, digest: proof.digest }, artifactSha256: evidence.artifactSha256, method: 'human', reviewer: 'local-owner' }])) }); await page.getByRole('button', { name: '提交受保护报告', exact: true }).click(); await page.getByRole('listitem').filter({ hasText: /^测试替身 · 未达到质量门槛/u }).waitFor(); assert.equal(await page.getByRole('button', { name: '启用此版本', exact: true }).count(), 0);
  const evaluated = (await read(`/v2/workspaces/${workspace.id}/team-skills/${skill.id}`)).evaluations[0]; assert.equal(evaluated.releaseGate, 'blocked'); assert.equal((await read(`/v2/assets/${evaluated.reportRef.resourceId}`)).protected, true);
  await page.getByRole('button', { name: '设置', exact: true }).click(); const memory = page.getByRole('article', { name: '记忆提案', exact: true }).filter({ hasText: '报告先列来源与反证' }); await memory.getByText('偏好 · 用户提供；经营事实仍以经营记录为准。', { exact: true }).waitFor(); await memory.getByRole('button', { name: '接受', exact: true }).click(); await memory.getByText('已确认', { exact: true }).waitFor();
  await agents(); await page.getByText('新增受控跟进', { exact: true }).click(); const form = page.getByRole('form', { name: '新增受控跟进', exact: true }); await form.getByLabel('关联目标', { exact: true }).selectOption(parent.id); await form.getByLabel('跟进名称', { exact: true }).fill('合成客户需求跟进'); await form.getByLabel('每次变化后完成什么', { exact: true }).fill('整理需求变化并说明来源'); const models = await read('/v2/model-connections'); await form.getByLabel('跟进执行模型', { exact: true }).selectOption(models[0].id); await form.getByLabel('有效期至', { exact: true }).fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16)); assert.equal(await form.getByRole('button', { name: '启用跟进', exact: true }).isDisabled(), true); await form.getByRole('checkbox').check(); await form.getByRole('button', { name: '启用跟进', exact: true }).click(); await page.getByRole('button', { name: '暂停跟进', exact: true }).waitFor();
  const followups = await read(`/v2/workspaces/${workspace.id}/followups`), policyId = followups[0].policy.id; assert.equal(followups[0].runs.length, 0); await page.getByRole('button', { name: '暂停跟进', exact: true }).click(); await page.getByRole('button', { name: '继续跟进', exact: true }).waitFor(); await page.getByRole('button', { name: '继续跟进', exact: true }).click(); await page.getByRole('button', { name: '暂停跟进', exact: true }).waitFor();
  const business = await read(`/v2/plugins/opc/business?workspaceId=${workspace.id}`); const changed = await fetch(`${apiUrl}/v2/plugins/opc/business/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'ui-reuse-customer-change' }, body: JSON.stringify({ workspaceId: workspace.id, expectedStreamVersion: business.state.streamVersion, command: { type: 'customer.record', customerId: 'delivery-customer', name: '合成客户', source: '合成访谈更新', need: '新增来源与反证核对要求' } }) }); assert.ok(changed.ok, `更新合成业务对象失败 ${changed.status}`);
  await page.getByRole('button', { name: '查看跟进任务', exact: true }).waitFor({ timeout: 30000 }); const latest = await read(`/v2/workspaces/${workspace.id}/followups/${policyId}`); assert.equal(latest.runs.length, 1); assert.ok(latest.runs[0].goalId); await page.getByRole('button', { name: '查看跟进任务', exact: true }).click(); await page.getByRole('region', { name: '目标详情', exact: true }).waitFor(); await page.getByRole('button', { name: '接收成果', exact: true }).waitFor({ timeout: 30000 });
  const { runCli } = await import('../../cli/dist/index.js'); const lines = []; assert.equal(await runCli(['followup', 'show', policyId, '--workspace', workspace.id, '--json'], { apiUrl, io: { stdout: line => lines.push(line), stderr: line => lines.push(line) } }), 0); assert.equal(JSON.parse(lines.at(-1)).data.runs[0].goalId, latest.runs[0].goalId);
  await page.setViewportSize({ width: 960, height: 640 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); assert.deepEqual(hostErrors, [], '正常复用流程不应出现失败的后台请求');
  console.log(JSON.stringify({ ok: true, scenarios: ['accepted-team-to-immutable-skill', 'explicit-trial-new-goal-fixed-version', 'protected-evaluation-report-fixture-blocked', 'memory-user-preference-confirmation', 'explicit-followup-independent-budget', 'followup-pause-resume-change-trigger', 'desktop-cli-followup-consistency'], hostErrors: 0 }));
} catch(error) {
  if(diagnosticPage)process.stderr.write(`Reuse UI fixture at failure: ${(await diagnosticPage.locator('body').innerText()).slice(-18000)}\n`);
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
}
function launch(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", chunk => process.stderr.write(chunk)); children.push(child);
}
function freePort() { return new Promise((resolvePort, reject) => { const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolvePort(address.port)); }); }); }
async function ready(url) {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return; } catch { /* Wait for the isolated fixture. */ } await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
  throw new Error(`服务未就绪：${url}`);
}
