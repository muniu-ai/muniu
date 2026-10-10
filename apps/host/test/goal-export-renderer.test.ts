// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {renderGoalExport} from '../src/goal-export-renderer.js';
import {extractDocument} from '../src/document-extraction.js';
const document={title:'木牛成果',text:'客户需求与交付验收\n=SUM(A1:A2)\n<资料> & "报价"\nCNY 1,234.56',sourceLabel:'goal:g / plan:p / output:report',accepted:true,createdAt:'2026-10-10T00:00:00.000Z'};
for(const format of ['docx','pdf','xlsx'] as const)test(`导出 ${format} 内容可独立解析回读且保留中文与安全文本`,async()=>{
 const rendered=await renderGoalExport(format,document);
 const extracted=await extractDocument({fileName:`report.${format}`,mediaType:rendered.mediaType,bytes:rendered.bytes});
 const text=extracted.blocks.map(block=>block.text).join('\n');
 assert.equal(extracted.status,'complete');assert.match(text,/客户需求与交付验收/u);assert.match(text,/SUM\(A1:A2\)/u);assert.match(text,/<资料>/u);assert.match(text,/1,234\.56/u);
 assert.ok(rendered.bytes.length<20*1024*1024);
});
test('导出拒绝超限与缺失字形，不能静默截断',async()=>{
 await assert.rejects(renderGoalExport('pdf',{...document,text:'🧑'}),{code:'EXPORT_GLYPH_UNAVAILABLE'});
 await assert.rejects(renderGoalExport('docx',{...document,text:'x'.repeat(1024*1024+1)}),{code:'EXPORT_LIMIT'});
});
test('工作表文字不成为公式或外部链接，文档不包含宏或外部关系',async()=>{
 const {fromBuffer}=await import('yauzl');
 const entries=async(bytes:Uint8Array)=>new Promise<Record<string,string>>((resolve,reject)=>fromBuffer(Buffer.from(bytes),{lazyEntries:true},(error,zip)=>{
  if(error||!zip){reject(error);return;}const result:Record<string,string>={};zip.on('error',reject);zip.on('end',()=>resolve(result));zip.on('entry',entry=>{zip.openReadStream(entry,(cause,stream)=>{if(cause||!stream){reject(cause);return;}const chunks:Buffer[]=[];stream.on('data',(chunk:Buffer)=>chunks.push(chunk));stream.on('error',reject);stream.on('end',()=>{result[entry.fileName]=Buffer.concat(chunks).toString('utf8');zip.readEntry();});});});zip.readEntry();}));
 for(const format of ['xlsx','docx'] as const){const result=await renderGoalExport(format,{...document,text:'=HYPERLINK("https://example.invalid", "打开")\n<!DOCTYPE x SYSTEM "file:///etc/passwd">'}),parts=await entries(result.bytes);const all=Object.values(parts).join('\n');assert.doesNotMatch(all,/<f[ >]|TargetMode="External"|<!DOCTYPE/u);assert.ok(Object.keys(parts).every(path=>!/(vba|macro|externalLink)/iu.test(path)));assert.match(all,/HYPERLINK/u);}
});
test('导出进程隔离继承环境并明确拒绝页数和单元格显示限额',async()=>{
 const original=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='--require=/must-not-inherit-credentials-or-options.js';
 try{const result=await renderGoalExport('docx',document);assert.ok(result.bytes.length);}finally{if(original===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=original;}
 await assert.rejects(renderGoalExport('pdf',{...document,text:'资料核对与交付\n'.repeat(5000)}),{code:'EXPORT_LIMIT'});
 await assert.rejects(renderGoalExport('xlsx',{...document,text:'中'.repeat(600)}),{code:'EXPORT_LIMIT'});
});
test('导出使用有界队列，额外请求可重试且Host事件循环继续响应',async()=>{
 let heartbeat=false;const beat=new Promise<void>(resolve=>setTimeout(()=>{heartbeat=true;resolve();},1));
 const work=Array.from({length:9},()=>renderGoalExport('pdf',document));const result=await Promise.allSettled(work);await beat;
 assert.equal(heartbeat,true);assert.equal(result.filter(item=>item.status==='fulfilled').length,8);assert.equal(result.filter(item=>item.status==='rejected'&&(item.reason as {code:string}).code==='EXPORT_BUSY').length,1);
});
