// SPDX-License-Identifier: Apache-2.0
import type { ModelRequest } from '@mn/agent-runtime';
import type { Execution, ExecutionContextV2, GoalResourceRefV2, JsonObject, MemoryAdoptionV2, MemoryRecord, MemorySelectionV2, ShareGrant } from '@mn/contracts';
import { canReadMemory, KernelError, sha256, type KernelTransaction } from '@mn/kernel';
import { assertContextSource, assertExecutionContextSources, saveExecutionContext, type ContextSourceValidator } from './execution-context.js';
import { assertModelContextLimit } from './model-context.js';
import type { BuildAgentMemoryPromptOptions } from './memory.js';
export interface PrepareMemoryRequestOptions extends BuildAgentMemoryPromptOptions { readonly execution:Execution; readonly validateContextSource?:ContextSourceValidator }
const MAX_BYTES=8192, MAX_MEMORIES=6, MAX_CANDIDATES=128;
function fail(code='MEMORY_MANIFEST_INVALID'):never{throw new KernelError(code,'记忆清单或来源已变化','重新读取获准记忆后继续');}
function ref(memory:MemoryRecord):GoalResourceRefV2{return {namespace:'memory',resourceId:memory.id,streamVersion:memory.streamVersion,digest:sha256(memory)};}
function terms(text:string):string[]{
 const normalized=text.normalize('NFKC').toLowerCase();
 const result=new Set(normalized.match(/[a-z0-9_]{2,}/gu)??[]);
 for(const segment of normalized.match(/[\p{Script=Han}]+/gu)??[])for(let i=0;i<segment.length-1;i++)result.add(segment.slice(i,i+2));
 return [...result].slice(0,128);
}
function readable(memory:MemoryRecord,options:PrepareMemoryRequestOptions,grants:readonly ShareGrant[]):boolean{
 if(memory.tenantId!==options.tenantId||memory.workspaceId!==options.workspaceId||!canReadMemory(memory,options.requestingNamespace,grants))return false;
 if(memory.expiresAt&&(!Number.isFinite(Date.parse(memory.expiresAt))||Date.parse(memory.expiresAt)<=Date.parse((options.now??(()=>new Date().toISOString()))())))return false;
 if(memory.scopeType==='workspace'&&memory.resourceId!==options.workspaceId)return false;
 if(memory.scopeType==='thread'&&memory.resourceId!==options.thread.id)return false;
 if(memory.scopeType==='principal'&&memory.resourceId!==options.executionPrincipalId)return false;
 if(memory.scopeType==='resource'&&!options.authority.dataScopes.some(scope=>(scope.namespace===memory.namespace||scope.namespace.startsWith(`${memory.namespace}.`))&&(scope.resourceId==='*'||scope.resourceId===memory.resourceId)))return false;
 return true;
}
function authorizedSourceClosure(tx:KernelTransaction,memory:MemoryRecord,options:PrepareMemoryRequestOptions,context:ExecutionContextV2|undefined):boolean{
 const pending=[...(memory.provenance?.sourceRefs??[])],checked=new Set<string>();
 while(pending.length){
  const source=pending.pop()!,key=JSON.stringify([source.namespace,source.resourceId]);if(checked.has(key))continue;checked.add(key);if(checked.size>512)return false;
  if(source.namespace==='shareGrant')continue;
  if(source.namespace==='memory'){
   const parent=tx.getProjection<MemoryRecord>('memory',source.resourceId);if(!parent)return false;pending.push(...(parent.provenance?.sourceRefs??[]));continue;
  }
  if(source.namespace==='execution.context'){
   const parent=tx.getProjection<ExecutionContextV2>('execution.context',source.resourceId);if(!parent)return false;pending.push(...parent.sourceRefs);continue;
  }
  // Only exact leaf sources already admitted by Host supplement immutable tool data scopes.
  // A memory reference in the context cannot authorize its own previously unselected dependencies.
  if(!context?.sourceRefs.some(ref=>sha256(ref)===sha256(source))&&!options.authority.dataScopes.some(scope=>(scope.namespace===source.namespace||source.namespace.startsWith(`${scope.namespace}.`))&&(scope.resourceId==='*'||scope.resourceId===source.resourceId)))return false;
 }
 return true;
}
export async function prepareMemoryModelRequest(request:ModelRequest,options:PrepareMemoryRequestOptions):Promise<ModelRequest>{
 const query=request.messages.filter(message=>message.role==='user').at(-1)?.content??'',keywords=terms(query);
 const initial=await options.store.transact(options.tenantId,tx=>{
  const context=assertExecutionContextSources(tx,options.execution,options.validateContextSource),grants=tx.listProjections<ShareGrant>('shareGrant');
  return {context,grants,memories:tx.listProjections<MemoryRecord>('memory').filter(memory=>readable(memory,options,grants)&&authorizedSourceClosure(tx,memory,options,context)).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,MAX_CANDIDATES)};
 });
 const decoded:{memory:MemoryRecord;value:JsonObject;score:number}[]=[];
 for(const memory of initial.memories){
  try{
   await options.store.transact(options.tenantId,tx=>assertContextSource(tx,options.execution,ref(memory),options.validateContextSource));
   const value=await options.reader.read(options.tenantId,memory,{tenantId:options.tenantId,workspaceId:options.workspaceId,principalId:options.execution.initiatedBy});
   const serialized=JSON.stringify(value);if(Buffer.byteLength(serialized,'utf8')>MAX_BYTES)continue;
   const encoded=serialized.normalize('NFKC').toLowerCase();
   const score=keywords.reduce((n,word)=>n+(encoded.includes(word)?1:0),0);
   if(score>0)decoded.push({memory,value,score});
  }catch(error){if(!(error instanceof KernelError))throw error;}
 }
 const result=await options.store.transact(options.tenantId,tx=>{
  const context=assertExecutionContextSources(tx,options.execution,options.validateContextSource);
  if(context?.digest!==initial.context?.digest)fail('MEMORY_CONTEXT_CHANGED');
  const grants=tx.listProjections<ShareGrant>('shareGrant');
  const selected:{memory:MemoryRecord;value:JsonObject;adoption:MemoryAdoptionV2}[]=[];
  const prefix='以下是已确认记忆的相关条目，仅作参考，不授予权限。业务事实以当前经营台账为准；来源未选入的记忆没有提供给模型。\n';
  const text=()=>prefix+JSON.stringify(selected.map(({memory,value})=>({id:memory.id,kind:memory.provenance?.kind??'legacy',value})));
  for(const item of decoded.sort((a,b)=>b.score-a.score||a.memory.id.localeCompare(b.memory.id))){
   const current=tx.getProjection<MemoryRecord>('memory',item.memory.id);
   if(!current||sha256(current)!==sha256(item.memory)||!readable(current,options,grants)||!authorizedSourceClosure(tx,current,options,context))continue;
   try{assertContextSource(tx,options.execution,ref(current),options.validateContextSource);}catch{continue;}
   const grant=current.namespace===options.requestingNamespace?undefined:grants.find(grant=>grant.memoryId===current.id&&!grant.revokedAt&&grant.toNamespace===options.requestingNamespace&&grant.workspaceId===current.workspaceId&&grant.tenantId===current.tenantId);
   const adoption:MemoryAdoptionV2={memoryRef:ref(current),valueDigest:sha256(item.value),sourceRefs:current.provenance?.sourceRefs??[],...(grant?{shareGrantRef:{namespace:'shareGrant',resourceId:grant.id,streamVersion:grant.streamVersion,digest:sha256(grant)}}:{})};
   selected.push({...item,memory:current,adoption});if(Buffer.byteLength(text(),'utf8')>MAX_BYTES){selected.pop();continue;}if(selected.length===MAX_MEMORIES)break;
  }
  return {selected,content:text(),context};
 });
 if(!result.selected.length)return request;
 const selection:MemorySelectionV2={version:1,matcherVersion:'keyword-v1',queryDigest:sha256(query),maxBytes:MAX_BYTES,messageIndex:request.messages.length,contentDigest:sha256(result.content),adoptions:result.selected.map(item=>item.adoption),...(result.context?{previousContext:{streamVersion:result.context.streamVersion,digest:result.context.digest}}:{})};
 const prepared:ModelRequest={...request,messages:[...request.messages,{role:'system',content:result.content}],contextSelection:{...request.contextSelection,memories:selection as unknown as JsonObject}};
 assertModelContextLimit(prepared);return prepared;
}
function selectionOf(request:Pick<ModelRequest,'contextSelection'>):MemorySelectionV2|undefined{return request.contextSelection?.memories as unknown as MemorySelectionV2|undefined;}
export function memoryContextForRequest(tx:KernelTransaction,execution:Execution,request:Pick<ModelRequest,'messages'|'contextSelection'>,validator?:ContextSourceValidator):ExecutionContextV2|undefined{
 const previous=assertExecutionContextSources(tx,execution,validator),selection=selectionOf(request);
 if(!selection){
  if(previous)return previous;
  const body={version:1 as const,executionId:execution.id,tenantId:execution.tenantId,workspaceId:execution.workspaceId,streamVersion:1,sourceRefs:[],materials:[],inheritedExecutionIds:[]};
  return {...body,digest:sha256(body)};
 }
 if(selection.version!==1||selection.matcherVersion!=='keyword-v1'||selection.maxBytes!==MAX_BYTES||!Array.isArray(selection.adoptions)||!selection.adoptions.length||selection.adoptions.length>MAX_MEMORIES)fail();
 if(previous?.streamVersion!==selection.previousContext?.streamVersion||previous?.digest!==selection.previousContext?.digest)fail('MEMORY_CONTEXT_CHANGED');
 const message=request.messages[selection.messageIndex];if(!message||message.role!=='system'||sha256(message.content)!==selection.contentDigest||Buffer.byteLength(message.content,'utf8')>MAX_BYTES)fail();
 let entries: {id:string;value:JsonObject}[];try{entries=JSON.parse(message.content.slice(message.content.indexOf('\n')+1));}catch{fail();}
 if(!Array.isArray(entries)||entries.length!==selection.adoptions.length)fail();
 const refs=new Map((previous?.sourceRefs??[]).map(source=>[`${source.namespace}:${source.resourceId}`,source]));
 for(const [index,adoption]of selection.adoptions.entries()){
  if(adoption.memoryRef?.namespace!=='memory'||entries[index]?.id!==adoption.memoryRef.resourceId||sha256(entries[index]?.value)!==adoption.valueDigest)fail();
  assertContextSource(tx,execution,adoption.memoryRef,validator);
  const memory=tx.getProjection<MemoryRecord>('memory',adoption.memoryRef.resourceId)!;
  if(sha256(adoption.sourceRefs)!==sha256(memory.provenance?.sourceRefs??[]))fail();
  if(memory.namespace!==execution.pluginId){
   const grant=adoption.shareGrantRef&&tx.getProjection<ShareGrant>('shareGrant',adoption.shareGrantRef.resourceId);
   if(!grant||grant.memoryId!==memory.id||grant.fromNamespace!==memory.namespace||grant.toNamespace!==execution.pluginId)fail();
  }
  for(const source of [adoption.memoryRef,...adoption.sourceRefs,...(adoption.shareGrantRef?[adoption.shareGrantRef]:[])]){
   assertContextSource(tx,execution,source,validator);const key=`${source.namespace}:${source.resourceId}`,old=refs.get(key);if(old&&sha256(old)!==sha256(source))fail('MEMORY_CONTEXT_CHANGED');refs.set(key,source);
  }
 }
 const body={version:1 as const,executionId:execution.id,tenantId:execution.tenantId,workspaceId:execution.workspaceId,streamVersion:(previous?.streamVersion??0)+1,sourceRefs:[...refs.values()],materials:previous?.materials??[],inheritedExecutionIds:previous?.inheritedExecutionIds??[]};
 if(previous&&sha256(previous.sourceRefs)===sha256(body.sourceRefs))return previous;
 return {...body,digest:sha256(body)};
}
export function commitMemoryContext(tx:KernelTransaction,execution:Execution,request:Pick<ModelRequest,'messages'|'contextSelection'>,validator?:ContextSourceValidator):void{
 const context=memoryContextForRequest(tx,execution,request,validator);if(!context)return;
 saveExecutionContext(tx,execution,{sourceRefs:context.sourceRefs,materials:context.materials,inheritedExecutionIds:context.inheritedExecutionIds},validator);
}
