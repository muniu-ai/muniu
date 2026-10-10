// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {AgentOsKernel,InMemoryKernelStore,sha256} from '@mn/kernel';
import {InMemoryKeyProvider,type ContentAddressedStorage} from '@mn/storage';
import {createGoalExport,getGoalExport,listGoalExports,type GoalExportOptions} from '../src/goal-exports.js';
import {readAssetContent} from '../src/assets.js';
async function fixture(){
 const store=new InMemoryKernelStore(),kernel=new AgentOsKernel(store);await kernel.bootstrapLocal('boot');const w=await kernel.createWorkspace('local','local-owner','workspace',{name:'导出',viewMode:'business',pluginIds:['opc']});
 const objects=new Map<string,Buffer>(),cas:ContentAddressedStorage={async put(b){const bytes=Buffer.from(b),digest=createHash('sha256').update(bytes).digest('hex');objects.set(digest,bytes);return{digest,byteLength:bytes.length,created:true};},async get(id){return Buffer.from(objects.get(id)!);},async has(id){return objects.has(id);},async gcOrphans(){return[];}};
 const scope={tenantId:'local',workspaceId:w.id,principalId:'local-owner'},origin={goalId:'g',planRevisionId:'p',deliverySetId:'s',outputKey:'report',outputDigest:sha256('fixed')};
 const source={namespace:'asset',resourceId:'source',streamVersion:1,digest:sha256('source')};
 await store.transact('local',tx=>{tx.putProjection('asset','source',{id:'source',...scope,streamVersion:1,digest:source.digest,protected:true,protectedPayloadRef:'key'});tx.putProjection('protectedPayloadKey','key',{id:'key'});tx.putProjection('goal.result','result',{...scope,streamVersion:1,digest:origin.outputDigest});});
 let calls=0,afterRender:()=>Promise<void>=async()=>{};const keyProvider=new InMemoryKeyProvider(Buffer.alloc(32,9));
 const options:GoalExportOptions={store,cas,keyProvider,protectedJournal:true,...scope,now:()=> '2026-10-10T00:00:00.000Z',id:()=>randomUUID(),ports:{readOutput(tx,_scope,selected){assert.deepEqual(selected,origin);if(!tx.getProjection('protectedPayloadKey','key'))throw Object.assign(Error(),{code:'CONTEXT_SOURCE_REVOKED'});return{origin,sourceRefs:[source],proposals:[],accepted:true,context:{goal:{id:'g'},plan:{deliverables:[{key:'report',title:'报告'}],resourceRefs:[source]},deliverySet:{}} as any,output:{key:'report',resourceRef:{namespace:'goal.result',resourceId:'result',streamVersion:1,digest:origin.outputDigest},preview:'机密正文',sourceRefs:[source]},proof:{projections:[],protectedPayloadRefs:[]}} as any;}},async render(){calls++;await afterRender();return{bytes:Buffer.from('%PDF-1.7\n机密正文'),mediaType:'application/pdf',rendererVersion:'1'};}};
 const input={workspaceId:w.id,expectedStreamVersion:0 as const,planRevisionId:'p',deliverySetId:'s',outputKey:'report',outputDigest:origin.outputDigest,format:'pdf' as const};
 return{store,scope,options,input,cas,keyProvider,calls:()=>calls,setAfter:(fn:()=>Promise<void>)=>afterRender=fn};
}
test('固定成果导出原子提交受保护Asset及幂等结果，重复请求不再渲染',async()=>{
 const f=await fixture(),result=await createGoalExport(f.options,'g',f.input,'once');assert.equal(result.accepted,true);assert.notEqual(result.assetRef.digest,result.contentSha256);assert.equal(result.byteLength,Buffer.byteLength('%PDF-1.7\n机密正文'));
 assert.deepEqual(await createGoalExport(f.options,'g',f.input,'once'),result);assert.equal(f.calls(),1);assert.equal((await listGoalExports(f.options,'g')).length,1);
 await assert.rejects(createGoalExport(f.options,'g',{...f.input,format:'docx'},'once'),{code:'IDEMPOTENCY_CONFLICT'});
 const asset=await f.store.transact('local',tx=>tx.getProjection<any>('asset',result.assetRef.resourceId));assert.equal((await readAssetContent({store:f.store,cas:f.cas,protectedPayloadKeyProvider:f.keyProvider,tenantId:'local',principalId:'local-owner',asset})).toString(),'%PDF-1.7\n机密正文');
 await f.store.transact('local',tx=>tx.deleteProjection('protectedPayloadKey','key'));
 await assert.rejects(getGoalExport(f.options,'g',result.id),{code:'CONTEXT_SOURCE_REVOKED'});await assert.rejects(createGoalExport(f.options,'g',f.input,'once'),{code:'CONTEXT_SOURCE_REVOKED'});
});
test('渲染期间撤权不得提交任何导出或Asset；当前成员移除不返回历史回执',async()=>{
 const f=await fixture();f.setAfter(()=>f.store.transact('local',tx=>tx.deleteProjection('protectedPayloadKey','key')));
 await assert.rejects(createGoalExport(f.options,'g',f.input,'revoke'),{code:'CONTEXT_SOURCE_REVOKED'});
 assert.equal(await f.store.transact('local',tx=>tx.listProjections('goal.export').length),0);assert.equal(await f.store.transact('local',tx=>tx.listProjections('asset').length),1);
 const g=await fixture(),value=await createGoalExport(g.options,'g',g.input,'existing');await g.store.transact('local',tx=>{const m=tx.getProjection<any>('membership',`${g.scope.workspaceId}:local-owner`);tx.putProjection('membership',`${g.scope.workspaceId}:local-owner`,{...m,removedAt:'now'});});
 await assert.rejects(getGoalExport(g.options,'g',value.id),{code:'WORKSPACE_ACCESS_DENIED'});await assert.rejects(createGoalExport(g.options,'g',g.input,'existing'),{code:'WORKSPACE_ACCESS_DENIED'});
});
test('导出资源或字形限制成为可识别的领域错误，不被包装为服务器故障',async()=>{
 const f=await fixture(),{GoalExportError}=await import('../src/goal-export-renderer.js'),{KernelError}=await import('@mn/kernel');
 await assert.rejects(createGoalExport({...f.options,render:async()=>{throw new GoalExportError('EXPORT_GLYPH_UNAVAILABLE','固定字体缺少字形');}},'g',f.input,'glyph'),error=>error instanceof KernelError&&error.code==='EXPORT_GLYPH_UNAVAILABLE');
});
