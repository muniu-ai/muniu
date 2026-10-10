// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
let directory,fixture;
before(async()=>{directory=await mkdtemp(join(tmpdir(),'muniu-delivery-review-'));const file=join(directory,'fixture.cjs');await build({entryPoints:[new URL('../fixtures/delivery-review.tsx',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.env':'{}'},outfile:file});fixture=createRequire(import.meta.url)(file);});
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
test('逐项决定保留成果摘要；接受必须复核全部要求，返工只提交失败条目',()=>{
 const {specs,outputs,buildDeliveryDecisions:build}=fixture;
 assert.equal(build(specs,outputs,{}),null);
 assert.equal(build(specs,outputs,{report:{decision:'accept',criteria:['source']}}),null);
 assert.equal(build(specs,outputs,{report:{decision:'request_changes',criteria:['source'],instruction:'  '}}),null);
 const result=build(specs,outputs,{report:{decision:'request_changes',criteria:['source'],instruction:'补充两处来源'},quote:{decision:'defer',reason:'等客户补充需求'}});
 assert.deepEqual(result,[{key:'report',digest:'digest-report',decision:'request_changes',failedCriterionIds:['source'],instruction:'补充两处来源'},{key:'quote',digest:'digest-quote',decision:'defer',reason:'等客户补充需求'}]);
 assert.equal(build(specs,outputs,{report:{decision:'accept',criteria:['source','scope','invented']}}),null);
});
test('成果表单提供三个明确决定且默认不代替用户选择',()=>{const html=fixture.formMarkup();for(const text of ['逐项验收','研究报告','报价方案','接收','暂缓','要求修改','请选择决定'])assert.ok(html.includes(text),text);assert.ok(html.includes('disabled=""'));});
test('返工预览展示累计轮次、沿用成果、剩余预算及新增授权',()=>{const html=fixture.previewMarkup();for(const text of ['第 2 轮','修订研究报告','已完成资料研究','报价方案','4.50 CNY','仅补充来源','新增资料范围','确认返工计划'])assert.ok(html.includes(text),text);});
test('过期候选不能采纳；字段差异、安全文本及经营影响可审阅',()=>{const html=fixture.candidateMarkup();for(const text of ['报价金额','5000 &lt;script&gt;','50.00 CNY','服务版本已更新','客户接受报价','订单生效','实际收款'])assert.ok(html.includes(text),text);assert.match(html,/<button[^>]*disabled=""[^>]*>采纳候选/u);assert.equal(html.includes('<script>'),false);});
