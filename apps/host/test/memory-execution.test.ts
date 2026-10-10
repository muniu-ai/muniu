// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCas,InMemoryKeyProvider,SqliteStorage } from '@mn/storage';
import type { Execution,MemoryRecord,Thread } from '@mn/contracts';
import { appendKernelEvent } from '@mn/kernel';
import { AgentOsWorker,createKernelAgentTurnHandler,createProtectedRuntimeStore } from '@mn/worker';
import { createAgentOsHost } from '../src/host.js';
import { createHostMemoryReader } from '../src/memory-sources.js';
import { validateHostContextSource,validateHistoricalHostContextSource } from '../src/context-source-validation.js';
import { readBusinessContext } from '../src/business-context.js';
async function fixture(t:test.TestContext,sourceKind:'asset'|'business'='asset'){
 const directory=await mkdtemp(join(tmpdir(),'mn-memory-p4-')),store=new SqliteStorage({databaseFile:join(directory,'state.sqlite'),hmacKey:Buffer.alloc(32,7)}),cas=new FileCas({rootDir:join(directory,'cas')}),keyProvider=new InMemoryKeyProvider(Buffer.alloc(32,8));
 let secretRead=async()=>{};let modelResponse=async()=>{};
 const secretStore={async save(){return 'keychain://muniu.v2/memory';},async read(){await secretRead();return 'fixture';}};
 const host=await createAgentOsHost({store,cas,protectedPayloadKeyProvider:keyProvider,secretStore,goalPollIntervalMs:60000});
 t.after(async()=>{await host.close();await store.close();await rm(directory,{recursive:true,force:true});});
 const workspace=await host.kernel.createWorkspace('local','local-owner','workspace',{name:'记忆验证',viewMode:'business',pluginIds:['opc']});
 const send=async(path:string,body?:unknown,key:string=randomUUID(),method='POST')=>{const response=await host.dispatch(new Request(`http://memory.test${path}`,body===undefined?{}:{method,headers:{'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)}));return {status:response.status,body:await response.json() as any};};
 const asset=await send('/v2/assets',{workspaceId:workspace.id,expectedStreamVersion:0,attachments:[{fileName:'记忆资料.txt',mediaType:'text/plain',protected:true,contentBase64:Buffer.from('交付包含回滚检查').toString('base64')}]});assert.equal(asset.status,201,JSON.stringify(asset.body));
 const command=async(command:unknown)=>{const state=await send(`/v2/plugins/opc/business?workspaceId=${workspace.id}`);assert.equal(state.status,200);const result=await send('/v2/plugins/opc/business/commands',{workspaceId:workspace.id,expectedStreamVersion:state.body.data.state.streamVersion,command});assert.equal(result.status,200,JSON.stringify(result.body));return result;};
 let sourceRef={namespace:'asset',resourceId:asset.body.data[0].id,streamVersion:asset.body.data[0].streamVersion,digest:asset.body.data[0].digest};
 if(sourceKind==='business'){await command({type:'customer.record',customerId:'c',name:'合成客户',source:'访谈',need:'交付回滚检查'});const context=await send(`/v2/workspaces/${workspace.id}/business-context/customer/c`);assert.equal(context.status,200);sourceRef=context.body.data.sourceRef;}

 const proposed=await send('/v2/memories',{workspaceId:workspace.id,scopeType:'workspace',namespace:'opc',resourceId:workspace.id,sourceEventId:'user-confirmed',confidence:1,provenance:{version:1,kind:'preference',origin:'user',sourceRefs:[sourceRef]},value:{summary:'交付必须包含回滚检查'}});assert.equal(proposed.status,201,JSON.stringify(proposed.body));
 const accepted=await send(`/v2/memories/${proposed.body.data.id}/decisions`,{expectedStreamVersion:1,decision:'accept'});assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 const thread=await host.kernel.createThread('local','local-owner','thread',{workspaceId:workspace.id,subject:'交付回滚检查',pluginId:'opc'});
 const model=await host.kernel.saveModelConnection('local','local-owner','model',{presetId:'deepseek',displayName:'fixture',secretRef:'keychain://muniu.v2/memory',defaultModel:'deepseek-v4-flash',discoveredModels:['deepseek-v4-flash']});
 await store.transact('local',tx=>{tx.putProjection('modelConnection',model.id,{...model,status:'ready',streamVersion:2});appendKernelEvent(tx,{tenantId:'local',aggregateType:'modelConnection',aggregateId:model.id,expectedStreamVersion:1,type:'fixture.ready',actorId:'local-owner',generation:0,correlationId:'ready',publicPayload:{}});});
 const execution=await host.kernel.submitTurn('local','local-owner','turn',{workspaceId:workspace.id,threadId:thread.id,expectedStreamVersion:thread.streamVersion,message:'请准备交付回滚检查',agentDefinitionId:'opc.business-assistant',modelBindingId:model.id,executionPrincipalId:'local-owner',authority:{workspaceId:workspace.id,principalId:'local-owner',toolIds:[],dataScopes:[{namespace:sourceRef.namespace,resourceId:sourceRef.resourceId}],autoAllowedEffects:[],budget:{maxSubagentDepth:0,maxSubagents:0,maxTokens:1000,maxCostMinorUnits:'100',currency:'CNY',maxDurationMs:60000}}});
 const runtimeProtection={cas,keyProvider,validateContextSource:validateHostContextSource};const runtime=createProtectedRuntimeStore({...runtimeProtection,store,tenantId:'local',workspaceId:workspace.id});
 let calls=0,quotes=0;
 const worker=new AgentOsWorker({id:'memory-worker',store,lock:{engineLockDigest:'x',expectedEngineLockDigest:'x',pluginLockDigest:'x',expectedPluginLockDigest:'x'},handlers:{'agent.execution.run':createKernelAgentTurnHandler({store,scopeContext:host.context,approvalKernel:host.kernel,secretStore,runtimeProtection,memoryReader:createHostMemoryReader({store,cas,keyProvider}),modelInvoker:async({request})=>{calls++;const records=await runtime.readExecution(execution.id),actual=records.find(record=>record.type==='model/request')!.payload;assert.deepEqual(actual.messages,request.messages);assert.ok(JSON.stringify(request.messages).includes('交付必须包含回滚检查'));assert.equal((actual.contextSelection as any).memories.adoptions[0].memoryRef.resourceId,accepted.body.data.id);assert.equal((actual.contextManifest as any).sourceRefs.some((ref:any)=>ref.namespace==='memory'),true);await modelResponse();return {text:'交付与回滚检查已整理',toolCalls:[],usage:{inputTokens:3,cachedInputTokens:0,outputTokens:2}};},modelQuoter:async()=>{quotes++;return {inputTokenLimit:100,maxOutputTokens:100,rates:{id:'fixture',currency:'CNY',inputNanoMinorUnitsPerToken:'0',cachedInputNanoMinorUnitsPerToken:'0',outputNanoMinorUnitsPerToken:'0'}};}})}});
 const revoke=async()=>{const deleted=await send(`/v2/assets/${sourceRef.resourceId}`,{expectedStreamVersion:sourceRef.streamVersion,reason:'撤回资料'},'revoke-source','DELETE');assert.equal(deleted.status,200,JSON.stringify(deleted.body));};
 return {store,host,cas,keyProvider,workspace,sourceRef,accepted,send,worker,runtime,execution,thread,revoke,command,calls:()=>calls,quotes:()=>quotes,setSecretRead:(fn:()=>Promise<void>)=>{secretRead=fn;},setModelResponse:(fn:()=>Promise<void>)=>{modelResponse=fn;}};
}
test('真实 Host/Worker 持久化实际记忆清单，撤回来源后列表和历史均不泄漏正文',async t=>{
 const f=await fixture(t);assert.equal((await f.worker.pollOnce()).status,'completed');assert.equal(f.calls(),1);
 const records=await f.runtime.readExecution(f.execution.id);assert.equal(records.filter(record=>record.type==='model/request').length,1);
 await f.store.rebuildProjections('local');assert.deepEqual(await f.runtime.readExecution(f.execution.id),records);
 const proposal=await f.send('/v2/memories',{workspaceId:f.workspace.id,scopeType:'workspace',namespace:'opc',resourceId:f.workspace.id,sourceEventId:'model',confidence:0.8,provenance:{version:1,kind:'fact',origin:'model',sourceRefs:[],sourceExecution:{executionId:f.execution.id,generation:f.execution.generation}},value:{summary:'模型候选须由用户确认'}});assert.equal(proposal.status,201,JSON.stringify(proposal.body));assert.equal(proposal.body.data.status,'proposed');assert.ok(proposal.body.data.provenance.sourceRefs.some((ref:any)=>ref.namespace==='memory'));assert.ok(proposal.body.data.provenance.sourceRefs.some((ref:any)=>ref.namespace==='asset'));
 await f.revoke();const listed=await f.send(`/v2/memories?workspaceId=${f.workspace.id}`);assert.equal(listed.status,200);assert.equal(listed.body.data[0].access,'revoked');assert.equal(JSON.stringify(listed.body).includes('交付必须包含回滚检查'),false);
 await assert.rejects(f.runtime.readExecution(f.execution.id));const accounting=await f.runtime.readSettlementRecords!(f.execution.id);assert.ok(accounting.some(record=>record.type==='model/settled'));assert.equal(JSON.stringify(accounting).includes('交付必须'),false);
});
test('实际模型请求持久化后、凭据读取期间撤回来源，报价与模型外发均被阻止',async t=>{
 const f=await fixture(t);f.setSecretRead(f.revoke);await f.worker.pollOnce();assert.equal(f.calls(),0);assert.equal(f.quotes(),0);
 const context=await f.store.transact('local',tx=>tx.getProjection<any>('execution.context',f.execution.id));assert.ok(context.sourceRefs.some((ref:any)=>ref.namespace==='memory'));
});
test('记忆读取解密期间撤回来源，响应只返回状态且不能接受失效提案',async t=>{
 const f=await fixture(t);
 const proposed=await f.send('/v2/memories',{workspaceId:f.workspace.id,scopeType:'workspace',namespace:'opc',resourceId:f.workspace.id,sourceEventId:'user',confidence:1,provenance:{version:1,kind:'fact',origin:'user',sourceRefs:[f.sourceRef]},value:{summary:'敏感交付回滚规则'}},'proposal');assert.equal(proposed.status,201,JSON.stringify(proposed.body));
 const replay=await f.send('/v2/memories',{workspaceId:f.workspace.id,scopeType:'workspace',namespace:'opc',resourceId:f.workspace.id,sourceEventId:'user',confidence:1,provenance:{version:1,kind:'fact',origin:'user',sourceRefs:[f.sourceRef]},value:{summary:'敏感交付回滚规则'}},'proposal');assert.equal(replay.body.data.id,proposed.body.data.id);
 const downgrade=await f.send(`/v2/memories/${proposed.body.data.id}`,{expectedStreamVersion:1,confidence:1,value:{summary:'修改'},provenance:null},'downgrade','PATCH');assert.equal(downgrade.status,422);
 const memory=await f.store.transact('local',tx=>tx.getProjection<MemoryRecord>('memory',proposed.body.data.id)!);
 const {readMemoryValue}=await import('../src/memories.js');
 let revoked=false;const cas={...f.cas,get:async(digest:string)=>{const data=await f.cas.get(digest);if(!revoked){revoked=true;await f.revoke();}return data;},put:f.cas.put.bind(f.cas),has:f.cas.has.bind(f.cas),gcOrphans:f.cas.gcOrphans.bind(f.cas)};
 await assert.rejects(readMemoryValue({store:f.store,cas,keyProvider:f.keyProvider,tenantId:'local',principalId:'local-owner',memory}));
 const accept=await f.send(`/v2/memories/${memory.id}/decisions`,{expectedStreamVersion:1,decision:'accept'});assert.ok(accept.status>=400);
 const rejected=await f.send(`/v2/memories/${memory.id}/decisions`,{expectedStreamVersion:1,decision:'reject'});assert.equal(rejected.status,200,JSON.stringify(rejected.body));assert.deepEqual(rejected.body.data.value,{});assert.equal(JSON.stringify(rejected.body).includes('敏感交付'),false);
});

test('模型在途时撤回记忆来源，已知用量仍结算且不继续传播答复',async t=>{
 const f=await fixture(t);f.setModelResponse(f.revoke);await f.worker.pollOnce();assert.equal(f.calls(),1);
 const records=await f.runtime.readSettlementRecords!(f.execution.id);assert.equal(records.filter(record=>record.type==='model/settled').length,1);
 assert.equal(JSON.stringify(records).includes('交付与回滚检查已整理'),false);await assert.rejects(f.runtime.readExecution(f.execution.id));
 const current=await f.store.transact('local',tx=>tx.getProjection<Execution>('execution',f.execution.id));assert.notEqual(current?.status,'completed');
});

test('真实历史读取不把旧业务快照中的记忆继续当作当前事实',async t=>{
 const f=await fixture(t,'business');assert.equal((await f.worker.pollOnce()).status,'completed');
 const path=`/v2/workspaces/${f.workspace.id}/threads/${f.thread.id}/turns`;assert.equal((await f.send(path)).status,200);
 await f.command({type:'customer.record',customerId:'c',name:'合成客户',source:'新访谈',need:'变更后的交付范围'});
 const original=await f.store.transact('local',tx=>readBusinessContext(tx,{tenantId:'local',workspaceId:f.workspace.id,principalId:'local-owner'},f.sourceRef,'historical'));assert.ok(original.content.includes('交付回滚检查'));
 const history=await f.send(path);assert.ok(history.status>=400,JSON.stringify(history.body));assert.equal(JSON.stringify(history.body).includes('交付与回滚检查已整理'),false);
 const historical=createProtectedRuntimeStore({store:f.store,tenantId:'local',workspaceId:f.workspace.id,cas:f.cas,keyProvider:f.keyProvider,validateContextSource:validateHistoricalHostContextSource});await assert.rejects(historical.readExecution(f.execution.id));
 const memories=await f.send(`/v2/memories?workspaceId=${f.workspace.id}`);assert.equal(memories.body.data[0].access,'stale');assert.equal(JSON.stringify(memories.body).includes('交付必须包含回滚检查'),false);
});
