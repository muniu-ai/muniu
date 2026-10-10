// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { before, after, test } from 'node:test';
import { build } from 'esbuild';

let directory, saveBinaryExport;
const bytes = Buffer.from('%PDF-1.7\n合成成果\n%%EOF');
const metadata = { format: 'pdf', fileName: '成果.pdf', mediaType: 'application/pdf', byteLength: bytes.length, contentSha256: createHash('sha256').update(bytes).digest('hex') };
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mn-binary-export-'));
  const file = join(directory, 'export.mjs');
  await build({ entryPoints: [new URL('../../src/export.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', outfile: file });
  ({ saveBinaryExport } = await import(pathToFileURL(file).href));
});
after(async () => { delete globalThis.window; if (directory) await rm(directory, { recursive: true, force: true }); });
test('原生保存前核对明文摘要、大小和类型，保存命令不接收任意路径或URL', async () => {
  const calls = []; globalThis.window = { __TAURI__: { core: { invoke: async (command, input) => { calls.push({ command, input }); return command==='prepare_binary_export'?'ticket':true; } } } };
  assert.equal(await saveBinaryExport(metadata, new Blob([bytes], { type: metadata.mediaType }), async()=>{}), 'saved');
  assert.deepEqual(calls,[{command:'prepare_binary_export',input:{fileName:metadata.fileName,mediaType:metadata.mediaType,contentSha256:metadata.contentSha256,byteLength:metadata.byteLength}},{command:'commit_binary_export',input:{ticket:'ticket',contentBase64:bytes.toString('base64')}},{command:'discard_binary_export',input:{ticket:'ticket'}}]);
});
test('用户取消保存对话框返回取消，原生错误不冒充下载成功', async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async () => null } } };
  assert.equal(await saveBinaryExport(metadata, new Blob([bytes]), async()=>{}), 'cancelled');
  globalThis.window.__TAURI__.core.invoke = async () => { throw new Error('private path'); };
  await assert.rejects(() => saveBinaryExport(metadata, new Blob([bytes]), async()=>{}), error => !error.message.includes('private path') && (error.message.includes('未保存')||error.message.includes('未选择')));
});
test('来源摘要或长度不符、伪造格式和路径名均在保存前拒绝', async () => {
  let saves = 0; globalThis.window = { __TAURI__: { core: { invoke: async () => { saves++; return true; } } } };
  for (const change of [{ contentSha256: '0'.repeat(64) }, { byteLength: bytes.length + 1 }, { fileName: '../成果.pdf' }, { fileName: '成果.sh' }, { mediaType: 'text/plain' }, { format: 'docx' }, { byteLength: 20 * 1024 * 1024 + 1 }]) {
    await assert.rejects(() => saveBinaryExport({ ...metadata, ...change }, new Blob([bytes]), async()=>{}));
  }
  const fake = Buffer.from('not a PDF');
  await assert.rejects(() => saveBinaryExport({ ...metadata, byteLength: fake.length, contentSha256: createHash('sha256').update(fake).digest('hex') }, new Blob([fake]), async()=>{}));
  assert.equal(saves, 0);
});
test('资料撤权或离开页面后取消在途保存', async () => {
 let saves=0;globalThis.window={__TAURI__:{core:{invoke:async()=>{saves++;return true;}}}};
 const controller=new AbortController();controller.abort();await assert.rejects(()=>saveBinaryExport(metadata,new Blob([bytes]),async()=>{},controller.signal));assert.equal(saves,0);
});

test('系统对话框结束后重新检查授权，撤权或验证失败均丢弃票据且不写文件', async()=>{
 const controller=new AbortController(), calls=[];let resolveDialog;
 globalThis.window={__TAURI__:{core:{invoke:async(command,input)=>{calls.push({command,input});if(command==='prepare_binary_export')return new Promise(resolve=>{resolveDialog=resolve;});return true;}}}};
 let authorized=0;const saving=saveBinaryExport(metadata,new Blob([bytes]),async()=>{authorized++;},controller.signal);saving.catch(()=>{});
 for(let i=0;i<100&&!resolveDialog;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(resolveDialog);controller.abort();resolveDialog('ticket');await assert.rejects(()=>saving);assert.equal(authorized,0);assert.deepEqual(calls.map(call=>call.command),['prepare_binary_export','discard_binary_export']);
 calls.length=0;window.__TAURI__.core.invoke=async(command,input)=>{calls.push({command,input});return command==='prepare_binary_export'?'ticket':true;};await assert.rejects(()=>saveBinaryExport(metadata,new Blob([bytes]),async()=>{throw new Error('revoked');}));assert.deepEqual(calls.map(call=>call.command),['prepare_binary_export','discard_binary_export']);
});
