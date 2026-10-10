// SPDX-License-Identifier: Apache-2.0
import {execFile,spawn} from 'node:child_process';
import {access,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {GoalExportFormatV2} from '@mn/contracts';
import {EXPORT_FONT_SHA256,EXPORT_MAX_BYTES,EXPORT_MEDIA_TYPES,EXPORT_RENDERER_VERSION,GoalExportError,validateExportDocument,type GoalExportDocument,type RenderedGoalExport} from './goal-export-renderer-types.js';
export type {GoalExportDocument,RenderedGoalExport} from './goal-export-renderer-types.js';
export {GoalExportError} from './goal-export-renderer-types.js';
const TIMEOUT_MS=15000,MAX_ACTIVE=2,MAX_QUEUED=6,HEAP_MIB=256,RSS_MIB=384;
let active=0;const queued:{start:()=>void}[]=[];
async function acquire():Promise<void>{if(active<MAX_ACTIVE){active++;return;}if(queued.length>=MAX_QUEUED)throw new GoalExportError('EXPORT_BUSY','导出任务已满，请稍后重试');await new Promise<void>((resolve,reject)=>{const item={start:()=>{clearTimeout(timer);resolve();}};const timer=setTimeout(()=>{queued.splice(queued.indexOf(item),1);reject(new GoalExportError('EXPORT_LIMIT','等待导出超时'));},TIMEOUT_MS);queued.push(item);});}
function release():void{const next=queued.shift();if(next)next.start();else active--;}
async function fontLocation():Promise<string>{for(const relative of ['../assets/fonts/noto-sans-cjk/NotoSansCJKsc-Regular.otf','../../assets/fonts/noto-sans-cjk/NotoSansCJKsc-Regular.otf']){const path=fileURLToPath(new URL(relative,import.meta.url));try{await access(path);return path;}catch{/* Fixed build-layout alternatives only. */}}throw new GoalExportError('EXPORT_FONT_INVALID','固定导出字体不可用');}
export async function renderGoalExport(format:GoalExportFormatV2,document:GoalExportDocument):Promise<RenderedGoalExport>{
 validateExportDocument(format,document);if(!['darwin','linux'].includes(process.platform))throw new GoalExportError('EXPORT_ISOLATION_UNAVAILABLE','当前系统不能提供受限导出进程');
 const deadline=Date.now()+TIMEOUT_MS;await acquire();let directory:string|undefined;
 try{
  const packaged=Boolean((process as NodeJS.Process&{pkg?:unknown}).pkg);
  let entry=fileURLToPath(new URL('./goal-export-worker.js',import.meta.url)),fontPath:string;
  if(packaged){directory=await mkdtemp(join(tmpdir(),'mn-export-'));entry=join(directory,'export.cjs');fontPath=join(directory,'font.otf');await writeFile(entry,await readFile(fileURLToPath(new URL('./goal-export-child.cjs',import.meta.url))),{mode:0o400,flag:'wx'});await writeFile(fontPath,await readFile(fileURLToPath(new URL('./NotoSansCJKsc-Regular.otf',import.meta.url))),{mode:0o400,flag:'wx'});}
  else fontPath=await fontLocation();
  const remaining=deadline-Date.now();if(remaining<=0)throw new GoalExportError('EXPORT_LIMIT','等待导出超时');
  const bytes=await new Promise<Uint8Array>((resolve,reject)=>{
   const child=spawn(process.execPath,[`--max-old-space-size=${HEAP_MIB}`,'--disallow-code-generation-from-strings',entry,fontPath],{env:{TZ:'UTC',...(packaged?{PKG_EXECPATH:'PKG_INVOKE_NODEJS'}:{})},stdio:['pipe','pipe','ignore']});
   let error:GoalExportError|undefined,closed=false,polling=false,size=0;const chunks:Buffer[]=[];
   const stop=(code:string,message:string)=>{error??=new GoalExportError(code,message);if(!closed)child.kill('SIGKILL');};
   const timer=setTimeout(()=>stop('EXPORT_LIMIT','导出超过时间限制'),remaining);
   // Heap is a V8 limit. RSS sampling also includes native buffers; it is a kill threshold, not a kernel allocation cap.
   const inspect=()=>{if(polling||closed||!child.pid)return;polling=true;const done=(cause:unknown,stdout:string)=>{polling=false;if(closed||child.exitCode!==null||child.signalCode!==null)return;if(cause||!/^\s*\d+\s*$/.test(stdout)){stop('EXPORT_ISOLATION_UNAVAILABLE','不能核对导出进程资源');return;}if(Number(stdout.trim())>RSS_MIB*1024)stop('EXPORT_LIMIT','导出超过内存限制');};if(process.platform==='linux')void readFile(`/proc/${child.pid}/status`,'utf8').then(text=>done(undefined,/^VmRSS:\s*(\d+)\s+kB$/m.exec(text)?.[1]??''),cause=>done(cause,''));else execFile('/bin/ps',['-o','rss=','-p',String(child.pid)],{timeout:500,maxBuffer:1024,env:{LC_ALL:'C'}},done);};
   const monitor=setInterval(inspect,25);inspect();child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>Math.ceil(EXPORT_MAX_BYTES*4/3)+4096){stop('EXPORT_LIMIT','导出超过传输限制');return;}chunks.push(chunk);});child.stdin.on('error',()=>{});child.once('error',()=>stop('EXPORT_ISOLATION_UNAVAILABLE','不能启动导出进程'));
   child.once('close',(code,signal)=>{closed=true;clearTimeout(timer);clearInterval(monitor);if(error){reject(error);return;}if(code!==0||signal){reject(new GoalExportError('EXPORT_LIMIT','导出进程异常退出'));return;}try{const reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(reply.error?.code){reject(new GoalExportError(reply.error.code,'成果未能导出，请检查格式、字形和资源限制'));return;}if(typeof reply.bytesBase64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(reply.bytesBase64))throw new Error();const result=Buffer.from(reply.bytesBase64,'base64');if(!result.length||result.length>EXPORT_MAX_BYTES||result.toString('base64')!==reply.bytesBase64)throw new Error();resolve(result);}catch{reject(new GoalExportError('EXPORT_INVALID_RESULT','导出进程结果无效'));}finally{for(const chunk of chunks)chunk.fill(0);}});
   const input=Buffer.from(JSON.stringify({format,document}));child.stdin.end(input,()=>input.fill(0));
  });
  return {bytes,mediaType:EXPORT_MEDIA_TYPES[format],rendererVersion:EXPORT_RENDERER_VERSION,...(format==='pdf'?{fontSha256:EXPORT_FONT_SHA256}:{})};
 }finally{try{if(directory)await rm(directory,{recursive:true,force:true});}finally{release();}}
}
