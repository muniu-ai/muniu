// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Execution, ExecutionAuthority, MemoryRecord, Thread } from '@mn/contracts';
import { InMemoryKernelStore, sha256 } from '@mn/kernel';
import { prepareMemoryModelRequest, memoryContextForRequest, commitMemoryContext } from '../src/memory-selection.js';
import { assertExecutionContextSources } from '../src/execution-context.js';
const now='2026-10-10T00:00:00.000Z';
const execution={id:'e',tenantId:'local',workspaceId:'w',generation:1,initiatedBy:'owner',pluginId:'opc',executionPrincipalId:'agent:opc'} as Execution;
const thread={id:'t',tenantId:'local',workspaceId:'w',pluginId:'opc'} as Thread;
const authority={dataScopes:[{namespace:'asset',resourceId:'a'}]} as unknown as ExecutionAuthority;
function memory(id:string):MemoryRecord{return {id,tenantId:'local',workspaceId:'w',scopeType:'workspace',namespace:'opc',resourceId:'w',sourceEventId:'user',status:'accepted',confidence:1,streamVersion:1,createdAt:now,updatedAt:now,shareGrantIds:[],protectedPayloadRef:`key:${id}`,provenance:{version:1,kind:'preference',origin:'user',sourceRefs:[]}};}
async function fixture(){const store=new InMemoryKernelStore();await store.transact('local',tx=>{tx.putProjection('execution','e',execution);for(let i=0;i<9;i++){tx.putProjection('memory',`m${i}`,memory(`m${i}`));tx.putProjection('protectedPayloadKey',`key:m${i}`,{});}});return {store,reader:{async read(_t:string,m:MemoryRecord){return {summary:m.id==='m8'?'交付必须包含回滚说明':'日常会议安排'};}},tenantId:'local',workspaceId:'w',thread,execution,authority,requestingNamespace:'opc',executionPrincipalId:'agent:opc',now:()=>now};}
const request={executionId:'e',agentId:'opc',generation:1,messages:[{role:'user' as const,content:'请交付回滚说明'}],availableToolIds:[]};
test('按关键词选择完整记忆并保存实际发送清单，最多六条且八千字节',async()=>{
 const f=await fixture(),prepared=await prepareMemoryModelRequest(request,f);const selected=prepared.contextSelection!.memories as any;
 assert.equal(selected.adoptions.length,1);assert.equal(selected.adoptions[0].memoryRef.resourceId,'m8');
 assert.equal(selected.contentDigest,sha256(prepared.messages[selected.messageIndex]!.content));assert.ok(Buffer.byteLength(prepared.messages[selected.messageIndex]!.content)<=8192);
 await f.store.transact('local',tx=>{const context=memoryContextForRequest(tx,execution,prepared);assert.equal(context!.sourceRefs[0]!.namespace,'memory');commitMemoryContext(tx,execution,prepared);});
 const events=(await f.store.readEvents('local',0,100)).events;assert.equal(events.some(event=>event.type==='execution.context_bound'),true);
 await f.store.transact('local',tx=>tx.deleteProjection('protectedPayloadKey','key:m8'));
 await assert.rejects(f.store.transact('local',tx=>assertExecutionContextSources(tx,execution)));
});
test('选择后撤权或正文清单被篡改不能提交，旧上下文依赖不会被下一次选择删除',async()=>{
 const f=await fixture();const prepared=await prepareMemoryModelRequest(request,f);
 await assert.rejects(f.store.transact('local',tx=>commitMemoryContext(tx,execution,{...prepared,messages:[{role:'system',content:'篡改'}]})),{code:'MEMORY_MANIFEST_INVALID'});
 await f.store.transact('local',tx=>commitMemoryContext(tx,execution,prepared));
 const second=await prepareMemoryModelRequest({...request,messages:[{role:'user',content:'完全无关问题'}]},f);
 await f.store.transact('local',tx=>commitMemoryContext(tx,execution,second));
 const current=await f.store.transact('local',tx=>assertExecutionContextSources(tx,execution));assert.equal(current!.sourceRefs.some(ref=>ref.resourceId==='m8'),true);
 await assert.rejects(f.store.transact('local',tx=>commitMemoryContext(tx,execution,prepared)),{code:'MEMORY_CONTEXT_CHANGED'});
});
test('解密期间来源更新不选入旧摘要；调用提交前共享撤销使整个请求失败',async()=>{
 const f=await fixture();const source={namespace:'asset',resourceId:'a',streamVersion:1,digest:'a'.repeat(64)};
 await f.store.transact('local',tx=>{
  tx.putProjection('asset','a',{id:'a',tenantId:'local',workspaceId:'w',streamVersion:1,digest:source.digest,protected:true,protectedPayloadRef:'asset-key'});tx.putProjection('protectedPayloadKey','asset-key',{});
  tx.putProjection('memory','m8',{...memory('m8'),provenance:{version:1,kind:'fact',origin:'user',sourceRefs:[source]}});
 });
 const delayed={...f,reader:{async read(_tenant:string,m:MemoryRecord){if(m.id==='m8')await f.store.transact('local',tx=>tx.putProjection('asset','a',{id:'a',tenantId:'local',workspaceId:'w',streamVersion:2,digest:'b'.repeat(64)}));return {summary:'交付回滚'};}}};
 const changed=await prepareMemoryModelRequest(request,delayed);
 assert.equal(JSON.stringify(changed.contextSelection).includes('"resourceId":"m8"'),false);
 await f.store.transact('local',tx=>{
  tx.putProjection('memory','m8',{...memory('m8'),namespace:'coding'});
  tx.putProjection('shareGrant','g',{id:'g',tenantId:'local',workspaceId:'w',streamVersion:1,memoryId:'m8',fromNamespace:'coding',toNamespace:'opc',grantedAt:now,grantedBy:'owner'});
 });
 const shared=await prepareMemoryModelRequest(request,f);
 assert.equal((shared.contextSelection!.memories as any).adoptions[0].shareGrantRef.resourceId,'g');
 await f.store.transact('local',tx=>{const grant=tx.getProjection<any>('shareGrant','g');tx.putProjection('shareGrant','g',{...grant,revokedAt:now});});
 await assert.rejects(f.store.transact('local',tx=>commitMemoryContext(tx,execution,shared)));
});
test('预算只接收完整条目，来源清单与六条上限一致',async()=>{
 const f=await fixture(),reader={async read(_tenant:string,m:MemoryRecord){return {summary:m.id==='m0'?'回滚'.repeat(5000):`回滚交付 ${m.id}`};}};
 const selected=await prepareMemoryModelRequest(request,{...f,reader});const manifest=selected.contextSelection!.memories as any;
 assert.equal(manifest.adoptions.length,6);assert.equal(manifest.adoptions.some((item:any)=>item.memoryRef.resourceId==='m0'),false);
 assert.ok(Buffer.byteLength(selected.messages[manifest.messageIndex]!.content)<=8192);
});
test('新普通会话首次请求也记录明确空来源闭包，不倒填旧请求',async()=>{
 const f=await fixture();const context=await f.store.transact('local',tx=>memoryContextForRequest(tx,execution,request));
 assert.equal(context?.streamVersion,1);assert.deepEqual(context?.sourceRefs,[]);
 await f.store.transact('local',tx=>commitMemoryContext(tx,execution,request));
 assert.deepEqual((await f.store.transact('local',tx=>assertExecutionContextSources(tx,execution)))?.sourceRefs,[]);
});
test('单次来源检查对重复派生子图只核验一次，新的检查仍能发现撤权',async()=>{
 const {assertContextSource}=await import('../src/execution-context.js');const f=await fixture();let newest:any;await f.store.transact('local',tx=>{
  const refs:any[]=[];for(let n=0;n<10;n++){const value={...memory(`chain${n}`),provenance:{version:1,kind:'fact',origin:'user',sourceRefs:[...refs]}};tx.putProjection('memory',value.id,value);tx.putProjection('protectedPayloadKey',value.protectedPayloadRef!,{});newest={namespace:'memory',resourceId:value.id,streamVersion:1,digest:sha256(value)};refs.push(newest);}
 });
 let calls=0;await f.store.transact('local',tx=>assertContextSource(tx,execution,newest,()=>{calls++;return false;}));assert.ok(calls<=10,`重复子图被核验 ${calls} 次`);
 await f.store.transact('local',tx=>tx.deleteProjection('protectedPayloadKey','key:chain0'));
 await assert.rejects(f.store.transact('local',tx=>assertContextSource(tx,execution,newest)));
});
test('采用的模型记忆继承原调用记录删除约束，原文密钥销毁后历史不能传播',async()=>{
 const f=await fixture();await f.store.transact('local',tx=>{
  const source={...execution,id:'origin',status:'completed'};tx.putProjection('execution','origin',source);
  const body={version:1,executionId:'origin',tenantId:'local',workspaceId:'w',streamVersion:1,sourceRefs:[],materials:[],inheritedExecutionIds:[]};const context={...body,digest:sha256(body)};tx.putProjection('execution.context','origin',context);
  tx.putProjection('agent-runtime','origin',{records:[{type:'model/request',protectedPayloadRef:'origin-request'},{type:'model/response',protectedPayloadRef:'origin-response'},{type:'model/response',protectedPayloadRef:'origin-response-2'}]});tx.putProjection('protectedPayloadKey','origin-request',{});tx.putProjection('protectedPayloadKey','origin-response',{});tx.putProjection('protectedPayloadKey','origin-response-2',{});
  tx.putProjection('memory','m8',{...memory('m8'),provenance:{version:1,kind:'fact',origin:'model',sourceRefs:[{namespace:'execution.context',resourceId:'origin',streamVersion:1,digest:context.digest}],sourceExecution:{executionId:'origin',generation:1}}});
 });
 const prepared=await prepareMemoryModelRequest(request,f);await f.store.transact('local',tx=>commitMemoryContext(tx,execution,prepared));
 await f.store.transact('local',tx=>tx.deleteProjection('protectedPayloadKey','origin-response'));
 await assert.rejects(f.store.transact('local',tx=>assertExecutionContextSources(tx,execution)),{code:'CONTEXT_SOURCE_REVOKED'});
});

test('派生记忆的间接资料也必须属于本次任务授权范围',async()=>{
 const f=await fixture();await f.store.transact('local',tx=>{
  const source={namespace:'asset',resourceId:'private-source',streamVersion:1,digest:'a'.repeat(64)};
  tx.putProjection('asset',source.resourceId,{id:source.resourceId,tenantId:'local',workspaceId:'w',streamVersion:1,digest:source.digest,protected:true,protectedPayloadRef:'private-key'});tx.putProjection('protectedPayloadKey','private-key',{});
  const original={...memory('original'),provenance:{version:1,kind:'fact',origin:'user',sourceRefs:[source]}};tx.putProjection('memory',original.id,original);tx.putProjection('protectedPayloadKey',original.protectedPayloadRef!,{});
  tx.putProjection('memory','m8',{...memory('m8'),provenance:{version:1,kind:'fact',origin:'user',sourceRefs:[{namespace:'memory',resourceId:original.id,streamVersion:1,digest:sha256(original)}]}});
 });
 const prepared=await prepareMemoryModelRequest(request,{...f,authority:{...f.authority,dataScopes:[]}});assert.equal(prepared.contextSelection?.memories,undefined);
});
test('目标已固定的确切来源可授权记忆采用，空工具数据范围不会误拦；无此来源仍拒绝',async()=>{
 const f=await fixture();const source={namespace:'asset',resourceId:'goal-source',streamVersion:1,digest:'a'.repeat(64)};
 await f.store.transact('local',tx=>{
  tx.putProjection('asset',source.resourceId,{id:source.resourceId,tenantId:'local',workspaceId:'w',streamVersion:1,digest:source.digest,protected:true,protectedPayloadRef:'goal-key'});tx.putProjection('protectedPayloadKey','goal-key',{});
  tx.putProjection('memory','m8',{...memory('m8'),provenance:{version:1,kind:'fact',origin:'user',sourceRefs:[source]}});
 });
 const options={...f,authority:{...f.authority,dataScopes:[]}};
 assert.equal((await prepareMemoryModelRequest(request,options)).contextSelection?.memories,undefined);
 await f.store.transact('local',tx=>{const body={version:1,executionId:'e',tenantId:'local',workspaceId:'w',streamVersion:1,sourceRefs:[source],materials:[],inheritedExecutionIds:[]};tx.putProjection('execution.context','e',{...body,digest:sha256(body)});});
 const allowed=await prepareMemoryModelRequest(request,options);assert.equal((allowed.contextSelection?.memories as any)?.adoptions[0].memoryRef.resourceId,'m8');
});
