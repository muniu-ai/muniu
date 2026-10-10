// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
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
    { MN_FIXTURE_API_PORT: new URL(apiUrl).port, MN_FIXTURE_APP_ORIGIN: appUrl, MN_FIXTURE_MODE: "delivery" });
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
  await page.getByRole('button',{name:'委派任务',exact:true}).click();
  const composer=page.getByRole('form',{name:'委派新任务'});
  await composer.getByLabel('任务目标',{exact:true}).fill('验证逐项返工与历史保留');await composer.getByLabel('验收要求',{exact:true}).fill('来源明确');
  await composer.getByRole('button',{name:'增加交付项',exact:true}).click();await composer.getByLabel('交付项 2 名称').fill('交付说明');await composer.getByLabel('交付项 2 验收要求').fill('步骤完整');
  await composer.getByRole('button',{name:'准备执行计划',exact:true}).click();await page.getByRole('button',{name:'确认计划并启动',exact:true}).click();
  const review=page.getByRole('form',{name:'逐项验收'});await review.waitFor({timeout:30000});
  await review.getByLabel('经营成果的验收决定').selectOption('accept');await review.getByLabel('来源明确',{exact:true}).check();await review.getByLabel('交付说明的验收决定').selectOption('request_changes');await review.getByLabel('步骤完整',{exact:true}).check();await review.getByLabel('修改说明',{exact:true}).fill('补充逐步操作说明');
  await review.getByRole('button',{name:'保存逐项决定',exact:true}).click();await page.getByRole('button',{name:'预览返工',exact:true}).click();
  const preview=page.getByRole('region',{name:'返工预览'});await preview.waitFor();assert.ok((await preview.textContent()).includes('第 1 轮'));
  await preview.getByRole('button',{name:'确认返工计划',exact:true}).click();await preview.waitFor({state:'hidden'});await page.getByRole('tab',{name:'计划',exact:true}).click();await page.getByRole('heading',{name:'单 Agent',exact:true}).waitFor();
  const restart=page.getByRole('button',{name:'确认计划并启动',exact:true});if(await restart.count())await restart.click();await page.getByRole('tab',{name:'成果',exact:true}).click();
  await page.getByRole('button',{name:'接收成果',exact:true}).waitFor({timeout:30000});
  for(const checkbox of await page.getByRole('checkbox').all())await checkbox.check();
  await page.getByRole('button',{name:'接收成果',exact:true}).click();await page.getByRole('region',{name:'目标详情',exact:true}).getByText('已验收',{exact:true}).waitFor();
  const goals=await read(`/v2/workspaces/${workspace.id}/goals`),first=goals.find(goal=>goal.objective==='验证逐项返工与历史保留');
  const detail=await read(`/v2/goals/${first.id}?workspaceId=${workspace.id}`);assert.equal(detail.plan.kind,'single-v2');assert.equal(detail.deliveryReview.reworks.length,1);assert.equal(detail.deliveryReview.history[0].deliverySet.items.length,2);assert.equal(detail.goal.status,'accepted');
  await page.getByRole('button',{name:'新建任务',exact:true}).click();await composer.getByLabel('任务目标',{exact:true}).fill('依据客户与服务版本提出报价候选');await composer.getByLabel('验收要求',{exact:true}).fill('保留价格依据');
  for(const selection of ['customer:delivery-customer','service:delivery-service']){await composer.getByRole('button',{name:'选择业务资料',exact:true}).click();await composer.getByLabel('业务对象资料').selectOption(selection);await composer.getByRole('button',{name:'加入任务资料',exact:true}).click();}
  await composer.getByRole('button',{name:'准备执行计划',exact:true}).click();await page.getByRole('button',{name:'确认计划并启动',exact:true}).click();await page.getByRole('button',{name:'接收成果',exact:true}).waitFor({timeout:30000});
  await page.getByRole('checkbox',{name:'已复核：保留价格依据',exact:true}).check();await page.getByRole('button',{name:'接收成果',exact:true}).click();await page.getByRole('region',{name:'目标详情',exact:true}).getByText('已验收',{exact:true}).waitFor();
  await page.getByRole('button',{name:'审阅候选：研究服务报价',exact:true}).click();await page.getByRole('article',{name:'经营候选审阅'}).waitFor();
  let business=await read(`/v2/plugins/opc/business?workspaceId=${workspace.id}`);assert.equal(business.state.quotes.length,0);await page.getByRole('button',{name:'采纳候选',exact:true}).click();await page.getByText('已采纳',{exact:true}).waitFor();
  business=await read(`/v2/plugins/opc/business?workspaceId=${workspace.id}`);assert.equal(business.state.quotes.length,1);assert.equal(business.state.quoteConfirmations.length,0);assert.equal(business.state.orders.length,0);assert.equal(business.state.payments.length,0);
  const quoteGoal=(await read(`/v2/workspaces/${workspace.id}/goals`)).find(goal=>goal.objective==='依据客户与服务版本提出报价候选');const acceptedQuoteDetail=await read(`/v2/goals/${quoteGoal.id}?workspaceId=${workspace.id}`);assert.equal(acceptedQuoteDetail.goal.status,'accepted');assert.ok(acceptedQuoteDetail.deliverySet);
  await read(`/v2/workspaces/${workspace.id}/threads/${quoteGoal.threadId}/turns`);
  await page.getByRole('tab',{name:'目标',exact:true}).click();await page.getByRole('region',{name:'任务资料来源'}).getByText('当前业务事实已更新。以下保留任务选入时的版本，继续修改经营记录前需重新核验。',{exact:true}).first().waitFor();
  await page.setViewportSize({width:960,height:640});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(hostErrors,[],"正常交付流程不应出现失败的后台请求");
  console.log(JSON.stringify({ok:true,scenarios:['multi-delivery-partial-decisions','single-rework-preview-history','explicit-customer-service-sources','candidate-apply-keeps-business-facts-separate','historical-source-read']}));
} catch(error) {
  if(diagnosticPage)process.stderr.write(`Delivery UI fixture at failure: ${(await diagnosticPage.locator('body').innerText()).slice(-18000)}\n`);
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
