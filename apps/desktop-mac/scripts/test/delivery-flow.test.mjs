// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright-core";

let browser, server, address;
before(async () => {
  const bundled = await build({ entryPoints: [new URL("../fixtures/delivery-flow.tsx", import.meta.url).pathname], bundle: true,
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

test("多个交付项随未知请求固定，正文不含业务资料", async () => {
 const current=await page('composer');try{
 await current.getByLabel('任务目标',{exact:true}).fill('提供研究与报价'); await current.getByLabel('验收要求',{exact:true}).fill('覆盖客户需求');
 await current.getByRole('button',{name:'增加交付项',exact:true}).click();
 await current.getByLabel('交付项 2 名称').fill('报价草案');await current.getByLabel('交付项 2 验收要求').fill('价格依据明确');await current.getByRole('radio',{name:'研发',exact:true}).check();assert.equal(await current.getByRole('button',{name:'增加交付项',exact:true}).isDisabled(),true);await current.getByText('代码交付使用一个完整候选，包含变更差异、检查结果和交付说明。',{exact:true}).waitFor();await current.getByRole('radio',{name:'经营',exact:true}).check();assert.equal(await current.getByLabel('交付项 2 名称').inputValue(),'报价草案');
 for(const selection of ['customer:customer','service:service']){await current.getByRole('button',{name:'选择业务资料',exact:true}).click();await current.getByLabel('业务对象资料').selectOption(selection);await current.getByRole('button',{name:'加入任务资料',exact:true}).click();}
 await current.getByRole('button',{name:'准备执行计划',exact:true}).click();await current.getByRole('button',{name:'继续准备',exact:true}).click();
 await current.getByText('创建完成',{exact:true}).waitFor();
 const calls=await current.evaluate(()=>window.calls);assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].input.deliverables.length,2);assert.equal(calls[0].input.deliverables[1].title,'报价草案');assert.equal(calls[0].input.deliverables[1].criteria[0].description,'价格依据明确');assert.deepEqual(calls[0].input.resourceRefs.map(ref=>ref.namespace),['opc.business.customer','opc.business.service']);assert.equal(calls[0].input.objective.includes('专用资料正文'),false);
 }finally{await current.close();}
});
test("报价接受与订单生效分开保存",async()=>{const current=await page('business');try{
 await current.getByRole('button',{name:'报价与订单',exact:true}).click();await current.getByRole('button',{name:'登记客户确认',exact:true}).click();
 await current.locator('input[name=sourceRef]').fill('客户邮件');await current.getByRole('form',{name:'登记客户接受报价'}).getByRole('button',{name:'登记客户接受报价',exact:true}).click();
 await current.getByText('客户已接受报价',{exact:true}).waitFor();let calls=await current.evaluate(()=>window.calls);assert.equal(calls[0].command.type,'quote.confirm');assert.ok(calls[0].command.confirmationId);assert.equal(calls[0].command.orderId,undefined);
 await current.getByRole('button',{name:'登记订单生效',exact:true}).click();await current.locator('input[name=sourceRef]').fill('已签署合同');await current.getByRole('form',{name:'登记订单生效'}).getByRole('button',{name:'登记订单生效',exact:true}).click();
 await current.getByText('订单已生效',{exact:true}).waitFor();calls=await current.evaluate(()=>window.calls);assert.equal(calls[1].command.type,'order.activate');assert.equal(calls[1].command.quoteConfirmationId,calls[0].command.confirmationId);
 }finally{await current.close();}});

test("逐项决定未知响应复用身份，返工先预览再保存单 Agent 新修订",async()=>{const current=await page('goals');try{
 await current.getByLabel('研究报告的验收决定').selectOption('request_changes');await current.getByRole('form',{name:'逐项验收'}).getByLabel('来源可核验',{exact:true}).check();await current.getByLabel('修改说明',{exact:true}).fill('补充来源');await current.getByLabel('报价建议的验收决定').selectOption('defer');
 await current.getByRole('button',{name:'保存逐项决定',exact:true}).click();await current.getByRole('button',{name:'重试上次操作',exact:true}).waitFor();assert.equal(await current.getByLabel('研究报告的验收决定').isDisabled(),true);await current.getByRole('button',{name:'重试上次操作',exact:true}).click();
 await current.getByRole('button',{name:'预览返工',exact:true}).click();await current.getByRole('region',{name:'返工预览'}).waitFor();await current.getByText('仅修改研究报告的来源',{exact:true}).waitFor();
 const requests=await current.evaluate(()=>window.calls);assert.deepEqual(requests.filter(call=>call.method==='delivery')[0],requests.filter(call=>call.method==='delivery')[1]);assert.equal(requests.some(call=>call.method==='rework'),false);
 await current.getByRole('button',{name:'确认返工计划',exact:true}).click();await current.getByRole('heading',{name:'单 Agent',exact:true}).waitFor();await current.getByRole('button',{name:'确认计划并启动',exact:true}).waitFor();
 await current.getByRole('tab',{name:'成果',exact:true}).click();await current.getByText('历史计划修订 1 · 2 项成果',{exact:true}).click();await current.getByText('研究报告正文',{exact:true}).waitFor();assert.equal(await current.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 }finally{await current.close();}});
test("候选未知请求跨面板保留身份，撤权立即移除差异及采纳按钮",async()=>{const current=await page('candidate');try{
 await current.getByRole('button',{name:'审阅候选：服务报价建议',exact:true}).click();await current.getByRole('button',{name:'核对候选操作',exact:true}).waitFor();await current.getByRole('button',{name:'卸载候选面板',exact:true}).click();await current.getByRole('button',{name:'打开候选面板',exact:true}).click();
 await current.getByRole('button',{name:'核对候选操作',exact:true}).click();await current.getByRole('button',{name:'采纳候选',exact:true}).waitFor();const requests=await current.evaluate(()=>window.calls);assert.deepEqual(requests[0],requests[1]);assert.equal(await current.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await current.getByRole('button',{name:'撤销资料权限',exact:true}).click();assert.equal(await current.getByRole('button',{name:'采纳候选',exact:true}).count(),0);await current.getByText('资料撤权。重新授权',{exact:true}).waitFor();assert.equal(await current.getByText('报价金额',{exact:true}).count(),0);
 }finally{await current.close();}});

test("已接收成果进入交付草稿，不自动登记客户验收或收款",async()=>{const current=await page('delivery-draft');try{const form=current.getByRole('form',{name:'记录交付',exact:true});await form.waitFor();assert.equal(await form.locator('[name=title]').inputValue(),'已接收的报告');assert.equal(await form.locator('[name=artifactRef]').inputValue(),'goal:goal/delivery:set/report@digest');assert.deepEqual(await current.evaluate(()=>window.calls),[]);}finally{await current.close();}});

test("不同业务类型使用相同ID时仍只打开所选来源",async()=>{const current=await page('sources');try{await current.getByRole('button',{name:'查看业务资料：示例客户',exact:true}).click();await current.getByText('customer 专用资料正文',{exact:true}).waitFor();assert.equal(await current.getByText('service 专用资料正文',{exact:true}).count(),0);}finally{await current.close();}});

test("独立复核未通过直接显示成果，只能要求修改或暂缓",async()=>{const current=await page('goals&failure=review');try{await current.getByRole('tab',{name:'成果',exact:true}).waitFor();assert.equal(await current.getByRole('tab',{name:'成果',exact:true}).getAttribute('aria-selected'),'true');await current.getByText('独立复核未通过。请查看成果检查，选择未满足的验收项并要求修改。',{exact:true}).waitFor();const review=current.getByRole('form',{name:'逐项验收'});assert.notEqual(await review.getByLabel('研究报告的验收决定').locator('option[value=accept]').getAttribute('disabled'),null);await review.getByLabel('研究报告的验收决定').selectOption('request_changes');await review.getByLabel('来源可核验',{exact:true}).check();await review.getByLabel('修改说明',{exact:true}).fill('按独立复核意见补充来源');assert.equal(await review.getByRole('button',{name:'保存逐项决定',exact:true}).isEnabled(),true);assert.equal(await current.getByRole('button',{name:'接收成果',exact:true}).count(),0);}finally{await current.close();}});
test("成果格式错误明确说明未形成可验收成果，不提供返工或接收入口",async()=>{const current=await page('goals&failure=invalid');try{await current.getByText('成果格式或交付项不符合计划，未登记可验收成果。',{exact:true}).waitFor();await current.getByRole('tab',{name:'成果',exact:true}).click();await current.getByText('此次执行未形成可验收成果。请在进展中核对失败原因。',{exact:true}).waitFor();assert.equal(await current.getByRole('form',{name:'逐项验收'}).count(),0);assert.equal(await current.getByRole('button',{name:'预览返工',exact:true}).count(),0);}finally{await current.close();}});
test("费用未知保留历史决定，禁用返工且不能记为零费用",async()=>{const current=await page('goals&failure=unknown');try{await current.getByRole('tab',{name:'成果',exact:true}).click();await current.getByText('费用或外部结果尚未核对，暂不能返工。请在进展中处理待核对事项。',{exact:true}).waitFor();assert.equal(await current.getByRole('button',{name:'预览返工',exact:true}).isDisabled(),true);assert.equal(await current.getByRole('form',{name:'逐项验收'}).count(),0);await current.getByRole('tab',{name:'目标',exact:true}).click();await current.getByText('用量：待核对，额度继续保留',{exact:true}).waitFor();assert.equal(await current.getByText('用量：0 分 CNY，0 tokens',{exact:true}).count(),0);assert.equal((await current.evaluate(()=>window.calls)).length,0);}finally{await current.close();}});
test("最终接收后保留修改历史但关闭原目标返工",async()=>{const current=await page('goals&failure=accepted');try{await current.getByText('任务已最终接收。如有新的交付要求，请创建新任务。',{exact:true}).waitFor();assert.equal(await current.getByRole('button',{name:'预览返工',exact:true}).isDisabled(),true);assert.equal(await current.getByRole('form',{name:'逐项验收'}).count(),0);assert.equal((await current.evaluate(()=>window.calls)).length,0);}finally{await current.close();}});
test("工作区事件后重新核验返工预览，资料撤权不恢复旧预览",async()=>{const current=await page('goals');try{await current.getByLabel('研究报告的验收决定').selectOption('request_changes');await current.getByRole('form',{name:'逐项验收'}).getByLabel('来源可核验',{exact:true}).check();await current.getByLabel('修改说明',{exact:true}).fill('补充来源');await current.getByRole('button',{name:'保存逐项决定',exact:true}).click();await current.getByRole('button',{name:'重试上次操作',exact:true}).click();await current.getByRole('button',{name:'预览返工',exact:true}).click();const confirm=current.getByRole('button',{name:'确认返工计划',exact:true});await confirm.waitFor();await current.evaluate(()=>window.goalEvent());await confirm.waitFor({state:'hidden'});await confirm.waitFor();await current.evaluate(()=>window.goalEvent('revoke'));await confirm.waitFor({state:'hidden'});await current.getByText('资料撤权。重新授权',{exact:true}).waitFor();assert.equal(await confirm.count(),0);}finally{await current.close();}});
test("子集决定保留未处理修改，返工始终绑定最近决定",async()=>{const current=await page('goals&failure=partial');try{const preview=current.getByRole('button',{name:'预览返工',exact:true});await preview.waitFor();assert.equal(await preview.count(),1);await preview.click();await current.getByRole('region',{name:'返工预览'}).waitFor();const requests=await current.evaluate(()=>window.calls);assert.equal(requests.find(call=>call.method==='preview').decisionId,'latest');}finally{await current.close();}});
test("修改要求被后来接收决定替代后不再提供返工",async()=>{const current=await page('goals&failure=superseded');try{await current.getByRole('region',{name:'验收与返工历史'}).waitFor();assert.equal(await current.getByRole('button',{name:'预览返工',exact:true}).count(),0);}finally{await current.close();}});
test("外部CLI单执行者返工支持核对账单，未知响应复用原请求",async()=>{const current=await page('goals&failure=external');try{const form=current.getByRole('form',{name:'外部用量核对'});await form.waitFor();await form.getByLabel('CLI 实际费用',{exact:true}).fill('100');await form.getByLabel('CLI 实际 tokens',{exact:true}).fill('200');await form.getByLabel('CLI 账单依据',{exact:true}).fill('厂商账单');await form.getByRole('button',{name:'确认用量',exact:true}).click();await current.getByRole('button',{name:'重试上次操作',exact:true}).waitFor();assert.equal(await form.getByLabel('CLI 实际费用',{exact:true}).isDisabled(),true);await current.getByRole('button',{name:'重试上次操作',exact:true}).click();await current.getByRole('form',{name:'逐项验收'}).waitFor();const calls=await current.evaluate(()=>window.calls);assert.equal(calls.length,2);assert.ok(calls[0].key);assert.deepEqual(calls[0],calls[1]);}finally{await current.close();}});
