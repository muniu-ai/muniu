// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {appendKernelEvent} from '@mn/kernel';
import {FileCas,InMemoryKeyProvider,SqliteStorage} from '@mn/storage';
import {AgentOsWorker,createKernelAgentTurnHandler} from '@mn/worker';
import {createAgentOsHost} from '../src/host.js';
import {assertGoalExecutionResources} from '../src/goal-runtime.js';
import {validateHostContextSource} from '../src/context-source-validation.js';
import {createOpcModelContextReader} from '../src/opc-model-context.js';
async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'mn-export-host-')),cas=new FileCas({rootDir:join(dir,'cas')}),keyProvider=new InMemoryKeyProvider(Buffer.alloc(32,29));
 const store=new SqliteStorage({databaseFile:join(dir,'state.sqlite'),hmacKey:Buffer.alloc(32,30)}),secretStore={async save(){return 'keychain://muniu.v2/export';},async read(){return 'fixture';}};
 const host=await createAgentOsHost({store,cas,protectedPayloadKeyProvider:keyProvider,secretStore,goalPollIntervalMs:60000});t.after(async()=>{await host.close();await store.close();await rm(dir,{recursive:true,force:true});});
 const w=await host.kernel.createWorkspace('local','local-owner',randomUUID(),{name:'成果导出',pluginIds:['opc'],viewMode:'business'}),thread=await host.kernel.createThread('local','local-owner',randomUUID(),{workspaceId:w.id,subject:'报告',pluginId:'opc'});
 const model=await host.kernel.saveModelConnection('local','local-owner',randomUUID(),{presetId:'deepseek',displayName:'fixture',secretRef:'keychain://muniu.v2/export',defaultModel:'deepseek-v4-flash',discoveredModels:['deepseek-v4-flash']});
 await store.transact('local',tx=>{tx.putProjection('modelConnection',model.id,{...model,status:'ready',streamVersion:2});appendKernelEvent(tx,{tenantId:'local',aggregateType:'modelConnection',aggregateId:model.id,expectedStreamVersion:1,type:'fixture.ready',actorId:'local-owner',generation:0,correlationId:randomUUID(),publicPayload:{}});});
 const response=(path:string,body?:unknown,key:string=randomUUID())=>host.dispatch(new Request('http://fixture'+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)}));
 const send=async(path:string,body?:unknown,key?:string)=>{const r=await response(path,body,key);return{status:r.status,body:await r.json() as any};};
 const upload=await send('/v2/assets',{workspaceId:w.id,expectedStreamVersion:0,attachments:[{fileName:'资料.txt',mediaType:'text/plain',protected:true,contentBase64:Buffer.from('本报告只根据已授权资料整理。').toString('base64')}]});assert.equal(upload.status,201,JSON.stringify(upload.body));const asset=upload.body.data[0];
 const created=await send(`/v2/workspaces/${w.id}/goals`,{threadId:thread.id,objective:'整理一份简短的交付报告',resourceRefs:[{namespace:'asset',resourceId:asset.id,streamVersion:asset.streamVersion,digest:asset.digest}],budget:{maxTokens:10000,maxCostMinorUnits:'100',currency:'CNY',maxDurationMs:60000},deliverables:[{key:'report',title:'交付报告',required:true,criteria:[{id:'complete',description:'说明结论与来源'}]}]});assert.equal(created.status,201,JSON.stringify(created.body));const path=`/v2/goals/${created.body.data.goal.id}`;
 const planned=await send(path+'/plan-revisions',{workspaceId:w.id,expectedStreamVersion:1,modelBindingId:model.id});assert.equal(planned.status,200,JSON.stringify(planned.body));const started=await send(path+'/commands',{workspaceId:w.id,expectedStreamVersion:planned.body.data.goal.streamVersion,command:'start',planRevisionId:planned.body.data.plan.id,planDigest:planned.body.data.plan.digest});assert.equal(started.status,200,JSON.stringify(started.body));
 const worker=new AgentOsWorker({id:'export-worker',store,lock:{engineLockDigest:'fixture',expectedEngineLockDigest:'fixture',pluginLockDigest:'fixture',expectedPluginLockDigest:'fixture'},handlers:{'agent.execution.run':createKernelAgentTurnHandler({store,secretStore,approvalKernel:host.kernel,runtimeProtection:{cas,keyProvider,validateContextSource:validateHostContextSource},assertExecutionResources:assertGoalExecutionResources,resolveThreadContext:createOpcModelContextReader({store,cas,protectedPayloadKeyProvider:keyProvider}),modelQuoter:async()=>({inputTokenLimit:5000,maxOutputTokens:1000,rates:{id:'fixture',currency:'CNY',inputNanoMinorUnitsPerToken:'0',cachedInputNanoMinorUnitsPerToken:'0',outputNanoMinorUnitsPerToken:'0'}}),modelInvoker:async()=>({text:'木牛交付报告\n客户资料支持本次结论，需人工核对。\n=SUM(A1:A2)\n费用 CNY 1,234.56',toolCalls:[],usage:{inputTokens:100,cachedInputTokens:0,outputTokens:30}})})}});
 assert.equal((await worker.pollOnce()).status,'completed');const refreshed=await send(path+'/commands',{workspaceId:w.id,expectedStreamVersion:started.body.data.goal.streamVersion,command:'refresh'});assert.equal(refreshed.status,200,JSON.stringify(refreshed.body));const d=refreshed.body.data;assert.equal(d.goal.status,'awaiting_acceptance');
 const accepted=await send(path+'/acceptances',{workspaceId:w.id,expectedStreamVersion:d.goal.streamVersion,deliverySetId:d.deliverySet.id,criteriaVersion:d.deliverySet.criteriaVersion,items:[{key:'report',digest:d.deliverySet.items[0].digest,reviewedCriterionIds:['complete']}]});assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 return{store,host,send,response,path,w,asset,detail:accepted.body.data,executionId:started.body.data.goal.executionRef.executionId};
}
test('真实Host/Worker成果可导出三格式、幂等下载校验并在重建后保留；撤源后所有出口关闭',async t=>{
 const f=await fixture(t),d=f.detail,input={workspaceId:f.w.id,expectedStreamVersion:0,planRevisionId:d.plan.id,deliverySetId:d.deliverySet.id,outputKey:'report',outputDigest:d.deliverySet.items[0].digest};const records:any[]=[];
 for(const format of ['docx','pdf','xlsx']){const r=await f.send(f.path+'/exports',{...input,format},'export-'+format);assert.equal(r.status,201,JSON.stringify(r.body));const out=r.body.data;records.push(out);assert.equal(out.accepted,true);assert.deepEqual((await f.send(f.path+'/exports',{...input,format},'export-'+format)).body.data,out);
  const download=await f.response(`/v2/assets/${out.assetRef.resourceId}/content`);assert.equal(download.status,200);const bytes=Buffer.from(await download.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),out.contentSha256);assert.equal(bytes.length,out.byteLength);
  const extracted=await f.send(`/v2/assets/${out.assetRef.resourceId}/extraction`);assert.equal(extracted.status,200,JSON.stringify(extracted.body));assert.match(JSON.stringify(extracted.body.data.blocks),/客户资料支持/u);
 }
 await f.store.rebuildProjections('local');assert.equal((await f.send(f.path+'/exports?workspaceId='+f.w.id)).body.data.length,3);
 await f.store.transact('local',tx=>{tx.deleteProjection('protectedPayloadKey',f.asset.protectedPayloadRef);appendKernelEvent(tx,{tenantId:'local',aggregateType:'fixture',aggregateId:randomUUID(),expectedStreamVersion:0,type:'fixture.revoked',actorId:'local-owner',generation:0,correlationId:randomUUID(),publicPayload:{}});});
 for(const out of records){for(const suffix of ['', '/content','/extraction']){const r=await f.response(`/v2/assets/${out.assetRef.resourceId}${suffix}`);assert.ok(r.status>=400,`${suffix} should revoke`);assert.ok(!(await r.text()).includes('客户资料支持'));}assert.ok((await f.send(`${f.path}/exports/${out.id}?workspaceId=${f.w.id}`)).status>=400);}
 assert.ok((await f.send(f.path+'/exports',{...input,format:'pdf'},'export-pdf')).status>=400);
});
test('删除模型响应密钥会撤回既有导出，不能借导出副本绕过原文删除',async t=>{
 const f=await fixture(t),d=f.detail,r=await f.send(f.path+'/exports',{workspaceId:f.w.id,expectedStreamVersion:0,planRevisionId:d.plan.id,deliverySetId:d.deliverySet.id,outputKey:'report',outputDigest:d.deliverySet.items[0].digest,format:'docx'});assert.equal(r.status,201,JSON.stringify(r.body));
 await f.store.transact('local',tx=>{const runtime=tx.getProjection<any>('agent-runtime',f.executionId);const response=runtime.records.find((record:any)=>record.type==='model/response');assert.ok(response.protectedPayloadRef);tx.deleteProjection('protectedPayloadKey',response.protectedPayloadRef);appendKernelEvent(tx,{tenantId:'local',aggregateType:'fixture',aggregateId:randomUUID(),expectedStreamVersion:0,type:'fixture.revoked',actorId:'local-owner',generation:0,correlationId:randomUUID(),publicPayload:{}});});
 assert.ok((await f.response(`/v2/assets/${r.body.data.assetRef.resourceId}/content`)).status>=400);
});
