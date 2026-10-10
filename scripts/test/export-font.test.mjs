// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyExportFont, verifyLargeExportAsset} from '../verify-export-font.mjs';
test('导出字体必须固定上游提交、原字节和原OFL许可',async()=>{
 assert.equal(verifyExportFont().license,'OFL-1.1');const dir=await mkdtemp(join(tmpdir(),'mn-font-check-'));
 try{await cp(new URL('../../apps/host/assets/fonts/noto-sans-cjk/',import.meta.url),dir,{recursive:true});const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));await writeFile(join(dir,'manifest.json'),JSON.stringify({...manifest,commit:'main'}));assert.throws(()=>verifyExportFont(dir));await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));await writeFile(join(dir,'OFL.txt'),'MIT');assert.throws(()=>verifyExportFont(dir));}finally{await rm(dir,{recursive:true,force:true});}
});
test('大文件豁免仅覆盖固定原字体，不接受改名、改字节或变更许可',async()=>{
 const root=new URL('../../',import.meta.url),relativePath='apps/host/assets/fonts/noto-sans-cjk/NotoSansCJKsc-Regular.otf';
 const font=await readFile(new URL(relativePath,root));
 assert.equal(verifyLargeExportAsset(relativePath,font),true);
 assert.equal(verifyLargeExportAsset('other.otf',font),false);
 assert.equal(verifyLargeExportAsset(relativePath,font.subarray(1)),false);
 const changed=Buffer.from(font);changed[0]^=1;
 assert.equal(verifyLargeExportAsset(relativePath,changed),false);
 const dir=await mkdtemp(join(tmpdir(),'mn-large-font-'));
 try{await cp(new URL('../../apps/host/assets/fonts/noto-sans-cjk/',import.meta.url),dir,{recursive:true});await writeFile(join(dir,'OFL.txt'),'MIT');assert.throws(()=>verifyLargeExportAsset(relativePath,font,dir));}finally{await rm(dir,{recursive:true,force:true});}
});
