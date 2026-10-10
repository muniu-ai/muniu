// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import type { JsonObject, MemoryAccessV2, MemoryActionV2, MemoryProvenanceV2, MemoryRecord, MemoryTombstone, ShareGrant, Workspace } from '@mn/contracts';
import { KernelError, type AgentOsKernel, type KernelStore } from '@mn/kernel';
import type { ContentAddressedStorage, KeyProvider } from '@mn/storage';
import { readBoundedJsonBody } from './http-body.js';
import { prepareMemoryPayload, publicMemory, readMemoryValue } from './memories.js';
import { assertMemoryWorkspace, resolveMemoryProvenance } from './memory-sources.js';
export interface MemoryRequestOptions {
 readonly request:Request; readonly mutationKey?:string; readonly tenantId:string; readonly principalId:string;
 readonly store:KernelStore; readonly kernel:AgentOsKernel; readonly cas?:ContentAddressedStorage; readonly keyProvider?:KeyProvider;
 readonly now?:()=>string; readonly id?:(kind:string)=>string;
 readonly erasePayloadKeys:(tenantId:string,actorId:string,purpose:string,requestId:string)=>Promise<void>;
}
function invalid():never{throw new KernelError('INVALID_BODY','记忆请求字段无效','核对记忆内容与来源');}
function string(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.length>500)invalid();return value;}
function version(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)invalid();return value;}
function object(value:unknown):value is JsonObject{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function fields(body:JsonObject,allowed:readonly string[]):void{
 if(Object.hasOwn(body,'protectedPayloadRef'))throw new KernelError('PROTECTED_PAYLOAD_REF_FORBIDDEN','客户端不能指定受保护数据引用','由 Host 创建受保护数据引用');
 if(Object.keys(body).some(key=>!allowed.includes(key)))invalid();
}
function blockedAccess(error:unknown):MemoryAccessV2{
 const code=error instanceof KernelError?error.code:'';
 if(/CHANGED|STALE|EXPIRED/u.test(code))return 'stale';
 if(/REVOKED|DESTROYED|DENIED|INVALIDATED|NOT_FOUND/u.test(code))return 'revoked';
 return 'unavailable';
}
export async function dispatchMemoryRequest(options:MemoryRequestOptions):Promise<{readonly status:number;readonly data:unknown}|undefined>{
 const {request,store,tenantId,principalId,kernel}=options,url=new URL(request.url);
 const collection=url.pathname==='/v2/memories',item=/^\/v2\/memories\/([^/]+)(?:\/(decisions))?$/u.exec(url.pathname);
 const shares=url.pathname==='/v2/share-grants',share=/^\/v2\/share-grants\/([^/]+)$/u.exec(url.pathname);
 if(!collection&&!item&&!shares&&!share)return undefined;
 const now=options.now??(()=>new Date().toISOString()),id=options.id??((kind:string)=>`${kind}-${randomUUID()}`);
 const scope=(workspaceId:string)=>({tenantId,principalId,workspaceId});
 const authorize=(workspaceId:string,access:'view'|'operate'|'review'|'owner'='view')=>store.transact(tenantId,tx=>assertMemoryWorkspace(tx,scope(workspaceId),access));
 const get=async(memoryId:string)=>{const value=await store.transact(tenantId,tx=>tx.getProjection<MemoryRecord>('memory',memoryId));if(!value)throw new KernelError('MEMORY_NOT_FOUND','记忆不存在','刷新记忆列表');await authorize(value.workspaceId);return value;};
 const visibleValue=async(memory:MemoryRecord)=>{
  try{return {access:'readable' as MemoryAccessV2,value:await readMemoryValue({...options,tenantId,memory,principalId})};}
  catch(error){await authorize(memory.workspaceId);return {access:blockedAccess(error),value:{} as JsonObject};}
 };
 const actions=async(memory:MemoryRecord,access:MemoryAccessV2)=>store.transact(tenantId,tx=>{
  const result:MemoryActionV2[]=[];
  const allowed=(role:'operate'|'review'|'owner')=>{try{assertMemoryWorkspace(tx,scope(memory.workspaceId),role);return true;}catch{return false;}};
  if(allowed('owner'))result.push('delete');
  if(memory.status==='proposed'){if(allowed('review')){result.push('reject');if(access==='readable')result.push('accept');}if(access==='readable'&&allowed('operate'))result.push('revise');}
  if(memory.status==='accepted'&&access==='readable'&&allowed('operate'))result.push('share');return result;
 });
 const view=async(memory:MemoryRecord)=>{const {access,value}=await visibleValue(memory);return {...publicMemory(memory,value),access,allowedActions:await actions(memory,access)};};
 if(request.method==='GET'){
  if(item||share)return undefined;
  if([...url.searchParams.keys()].some(key=>![...(collection?['workspaceId','namespace']:[])].includes(key)))invalid();
  const workspaceId=url.searchParams.get('workspaceId');if(workspaceId)await authorize(workspaceId);
  const allowed=await store.transact(tenantId,tx=>new Set(tx.listProjections<Workspace>('workspace').filter(w=>{try{assertMemoryWorkspace(tx,scope(w.id));return true;}catch{return false;}}).map(w=>w.id)));
  if(shares)return {status:200,data:await store.transact(tenantId,tx=>tx.listProjections<ShareGrant>('shareGrant').filter(grant=>allowed.has(grant.workspaceId)))};
  const namespace=url.searchParams.get('namespace');
  const records=await store.transact(tenantId,tx=>tx.listProjections<MemoryRecord>('memory').filter(memory=>allowed.has(memory.workspaceId)&&(!workspaceId||workspaceId===memory.workspaceId)&&(!namespace||namespace===memory.namespace)));
  const data=[];for(const memory of records){const current=await view(memory);data.push({id:memory.id,namespace:memory.namespace,resourceId:memory.resourceId,source:memory.sourceEventId,confidence:memory.confidence,status:memory.status,streamVersion:memory.streamVersion,
   summary:current.access==='readable'&&typeof current.value.summary==='string'?current.value.summary:current.access==='readable'?'待审阅的记忆提案':'来源已变化或无法读取，请返回原资料核对',...(memory.provenance?{provenance:memory.provenance}:{}),access:current.access,allowedActions:current.allowedActions});}
  return {status:200,data};
 }
 if(url.searchParams.size)invalid();
 const key=options.mutationKey??request.headers.get('Idempotency-Key');if(!key?.trim())throw new KernelError('IDEMPOTENCY_KEY_REQUIRED','缺少幂等键','为操作提供 Idempotency-Key');
 const body=await readBoundedJsonBody(request);
 if(collection&&request.method==='POST'){
  fields(body,['workspaceId','scopeType','namespace','resourceId','sourceEventId','confidence','expiresAt','derivedFromMemoryId','derivedViaShareGrantId','value','provenance']);
  if(!object(body.value))invalid();const workspaceId=string(body.workspaceId);await authorize(workspaceId,'operate');
  const provenance=body.provenance===undefined?undefined:await store.transact(tenantId,tx=>resolveMemoryProvenance(tx,scope(workspaceId),body.provenance as unknown as MemoryProvenanceV2));
  const preparedPayload=await prepareMemoryPayload({...options,tenantId,workspaceId,memoryId:id('memory'),protectedPayloadRef:id('protected-payload'),value:body.value,createdAt:now()});
  await authorize(workspaceId,'operate');
  const memory=await kernel.proposeMemory(tenantId,principalId,key,{workspaceId,scopeType:body.scopeType==='thread'||body.scopeType==='resource'||body.scopeType==='principal'?body.scopeType:'workspace',namespace:string(body.namespace),resourceId:string(body.resourceId),sourceEventId:string(body.sourceEventId),confidence:typeof body.confidence==='number'?body.confidence:0,
   ...(typeof body.expiresAt==='string'?{expiresAt:body.expiresAt}:{}),...(typeof body.derivedFromMemoryId==='string'?{derivedFromMemoryId:body.derivedFromMemoryId}:{}),...(typeof body.derivedViaShareGrantId==='string'?{derivedViaShareGrantId:body.derivedViaShareGrantId}:{}),...(provenance?{provenance}:{}),preparedPayload});
  return {status:201,data:await view(memory)};
 }
 if(item&&item[2]&&request.method==='POST'){
  fields(body,['expectedStreamVersion','decision']);const memory=await get(decodeURIComponent(item[1]!));await authorize(memory.workspaceId,'review');
  if(body.decision!=='accept'&&body.decision!=='reject')throw new KernelError('INVALID_DECISION','记忆决定无效','选择 accept 或 reject');
  return {status:200,data:await view(await kernel.decideMemory(tenantId,principalId,key,memory.id,version(body.expectedStreamVersion),body.decision))};
 }
 if(item&&!item[2]&&request.method==='PATCH'){
  fields(body,['expectedStreamVersion','confidence','value']);const memory=await get(decodeURIComponent(item[1]!));await authorize(memory.workspaceId,'operate');if(!object(body.value)||typeof body.confidence!=='number')invalid();
  const preparedPayload=await prepareMemoryPayload({...options,tenantId,workspaceId:memory.workspaceId,memoryId:memory.id,protectedPayloadRef:id('protected-payload'),value:body.value,createdAt:now()});await authorize(memory.workspaceId,'operate');
  const revised=await kernel.reviseMemoryProposal(tenantId,principalId,key,memory.id,version(body.expectedStreamVersion),{confidence:body.confidence,preparedPayload});
  await options.erasePayloadKeys(tenantId,principalId,`memory:${memory.id}`,key);return {status:200,data:await view(revised)};
 }
 if(item&&!item[2]&&request.method==='DELETE'){
  fields(body,['expectedStreamVersion','reason']);const memoryId=decodeURIComponent(item[1]!);const memory=await store.transact(tenantId,tx=>tx.getProjection<MemoryRecord>('memory',memoryId)??tx.getProjection<MemoryTombstone>('memoryTombstone',memoryId));if(!memory)throw new KernelError('MEMORY_NOT_FOUND','记忆不存在','刷新记忆列表');await authorize(memory.workspaceId,'owner');
  const result=await kernel.deleteMemory(tenantId,principalId,key,memoryId,version(body.expectedStreamVersion),string(body.reason));await options.erasePayloadKeys(tenantId,principalId,`memory:${memoryId}`,key);return {status:200,data:result};
 }
 if(shares&&request.method==='POST'){
  fields(body,['memoryId','expectedStreamVersion','toNamespace']);const memory=await get(string(body.memoryId));await authorize(memory.workspaceId,'operate');return {status:201,data:await kernel.createShareGrant(tenantId,principalId,key,memory.id,version(body.expectedStreamVersion),string(body.toNamespace))};
 }
 if(share&&request.method==='DELETE'){
  fields(body,['expectedStreamVersion']);const grantId=decodeURIComponent(share[1]!);const grant=await store.transact(tenantId,tx=>tx.getProjection<ShareGrant>('shareGrant',grantId));if(!grant)throw new KernelError('SHARE_GRANT_NOT_FOUND','共享授权不存在','刷新授权列表');await authorize(grant.workspaceId,'owner');return {status:200,data:await kernel.revokeShareGrant(tenantId,principalId,key,grantId,version(body.expectedStreamVersion))};
 }
 return undefined;
}
