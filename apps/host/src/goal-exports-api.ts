// SPDX-License-Identifier: Apache-2.0
import {parseCreateGoalExportV2} from '@mn/contracts';
import {KernelError} from '@mn/kernel';
import {readBoundedJsonBody} from './http-body.js';
import {createGoalExport,getGoalExport,listGoalExports,type GoalExportOptions} from './goal-exports.js';
export interface GoalExportRequestOptions extends Omit<GoalExportOptions,'workspaceId'> {readonly request:Request;readonly mutationKey?:string}
function invalid():never{throw new KernelError('EXPORT_REQUEST_INVALID','成果导出请求字段无效','选择固定成果版本和导出格式');}
function text(value:string|null):string{if(!value?.trim()||value.length>200)invalid();return value;}
export async function dispatchGoalExportRequest(options:GoalExportRequestOptions):Promise<{status:number;data:unknown}|undefined>{
 const url=new URL(options.request.url),match=/^\/v2\/goals\/([^/]+)\/exports(?:\/([^/]+))?$/u.exec(url.pathname);if(!match)return;
 let goalId:string,exportId:string|undefined;try{goalId=text(decodeURIComponent(match[1]!));exportId=match[2]?text(decodeURIComponent(match[2])):undefined;}catch{return invalid();}
 if(options.request.method==='GET'){
  if([...url.searchParams.keys()].some(k=>k!=='workspaceId')||url.searchParams.getAll('workspaceId').length!==1)invalid();
  const scoped={...options,workspaceId:text(url.searchParams.get('workspaceId'))};return{status:200,data:exportId?await getGoalExport(scoped,goalId,exportId):await listGoalExports(scoped,goalId)};
 }
 if(options.request.method!=='POST'||exportId)return;if(url.searchParams.size)invalid();
 const key=options.mutationKey??options.request.headers.get('Idempotency-Key');if(!key?.trim()||key.length>200)throw new KernelError('IDEMPOTENCY_KEY_REQUIRED','导出需要幂等键','提供 Idempotency-Key');
 let input;try{input=parseCreateGoalExportV2(await readBoundedJsonBody(options.request,{maxBytes:16*1024}));}catch{return invalid();}
 return{status:201,data:await createGoalExport({...options,workspaceId:input.workspaceId},goalId,input,key)};
}
