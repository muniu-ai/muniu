// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {AgentOsKernel,InMemoryKernelStore,appendKernelEvent} from '@mn/kernel';
import {InMemoryKeyProvider,type ContentAddressedStorage} from '@mn/storage';
import {prepareProtectedAsset,commitPreparedDerivedAssetInTransaction,readAssetContent} from '../src/assets.js';
test('派生资料准备不泄露明文，来源与结果在同一事务提交，撤权后不能读出',async()=>{
 const store=new InMemoryKernelStore(),kernel=new AgentOsKernel(store);await kernel.bootstrapLocal('init');
 const w=await kernel.createWorkspace('local','local-owner','w',{name:'export',pluginIds:['opc'],viewMode:'business'});
 const objects=new Map<string,Buffer>(),cas:ContentAddressedStorage={async put(bytes){const b=Buffer.from(bytes),digest=createHash('sha256').update(b).digest('hex');objects.set(digest,b);return{digest,byteLength:b.length,created:true};},async get(id){return Buffer.from(objects.get(id)!);},async has(id){return objects.has(id);},async gcOrphans(){return[];}};
 const keyProvider=new InMemoryKeyProvider(Buffer.alloc(32,73)),scope={tenantId:'local',workspaceId:w.id,principalId:'local-owner'},now=()=> '2026-10-10T00:00:00.000Z';
 await store.transact('local',tx=>{tx.putProjection('asset','source',{id:'source',tenantId:'local',workspaceId:w.id,streamVersion:1,digest:'source',protected:true,protectedPayloadRef:'source-key'});tx.putProjection('protectedPayloadKey','source-key',{id:'source-key'});});
 const bytes=Buffer.from('PRIVATE_EXPORT_TEXT'),prepared=await prepareProtectedAsset({cas,keyProvider,...scope,assetId:'derived',bytes,fileName:'report.txt',mediaType:'text/plain',now,id:()=>randomUUID()});
 assert.equal(bytes.toString(),'PRIVATE_EXPORT_TEXT');assert.ok(!JSON.stringify(prepared).includes('PRIVATE_EXPORT_TEXT'));
 assert.ok(![...objects.values()].some(b=>b.includes(Buffer.from('PRIVATE_EXPORT_TEXT'))));
 const provenance={version:1 as const,kind:'mcp_resource' as const,producer:{namespace:'mcp.resourceRead' as const,resourceId:'operation'},sourceRefs:[{namespace:'asset',resourceId:'source',streamVersion:1,digest:'source'}]};
 await assert.rejects(store.transact('local',tx=>{commitPreparedDerivedAssetInTransaction(tx,scope,prepared,provenance,{now,id:()=>randomUUID()});throw new Error('operation failed');}));
 assert.equal(await store.transact('local',tx=>tx.getProjection('asset','derived')),undefined);
 const asset=await store.transact('local',tx=>commitPreparedDerivedAssetInTransaction(tx,scope,prepared,provenance,{now,id:()=>randomUUID()}));
 const read=()=>readAssetContent({store,cas,protectedPayloadKeyProvider:keyProvider,tenantId:'local',principalId:'local-owner',asset});
 assert.equal((await read()).toString(),'PRIVATE_EXPORT_TEXT');
 await store.transact('local',tx=>{tx.deleteProjection('protectedPayloadKey','source-key');appendKernelEvent(tx,{tenantId:'local',aggregateType:'test',aggregateId:randomUUID(),expectedStreamVersion:0,type:'test.revoked',actorId:'local-owner',generation:0,correlationId:randomUUID(),publicPayload:{}});});
 await assert.rejects(read(),{code:'CONTEXT_SOURCE_REVOKED'});
});
