// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOsKernel, InMemoryKernelStore, KernelError } from '../src/index.js';
const provenance = { version: 1 as const, kind: 'fact' as const, origin: 'user' as const, sourceRefs: [] };
const input = { workspaceId: 'w', scopeType: 'workspace' as const, namespace: 'opc', resourceId: 'w', sourceEventId: 'user', confidence: 1, provenance };
test('新记忆来源没有校验端口时拒绝写入，旧记录仍可提案', async () => {
 const store = new InMemoryKernelStore(), kernel = new AgentOsKernel(store);
 await assert.rejects(kernel.proposeMemory('local','owner','new',input), { code: 'MEMORY_SOURCE_VALIDATOR_REQUIRED' });
 const { provenance: _, ...legacy } = input;
 assert.equal((await kernel.proposeMemory('local','owner','old',legacy)).status, 'proposed');
});
test('确认与共享前复核来源，拒绝不需要再次读取失效来源', async () => {
 const store = new InMemoryKernelStore(); let valid = true; const purposes: string[] = [];
 const kernel = new AgentOsKernel(store, { memorySources: { assert(_tx, _scope, _provenance, purpose) { purposes.push(purpose); if (!valid) throw new KernelError('MEMORY_SOURCE_STALE','资料过期','重新选择'); } } });
 const memory = await kernel.proposeMemory('local','owner','new',input);
 assert.deepEqual(memory.provenance, provenance); valid = false;
 await assert.rejects(kernel.decideMemory('local','owner','accept',memory.id,1,'accept'), { code: 'MEMORY_SOURCE_STALE' });
 assert.equal((await kernel.decideMemory('local','owner','reject',memory.id,1,'reject')).status,'rejected');
 valid = true; const second = await kernel.proposeMemory('local','owner','second',input);
 const accepted = await kernel.decideMemory('local','owner','accepted',second.id,1,'accept'); valid=false;
 await assert.rejects(kernel.createShareGrant('local','owner','share',accepted.id,2,'coding'),{code:'MEMORY_SOURCE_STALE'});
 assert.ok(purposes.includes('share'));
});
test('派生记忆不能删除或减少已有的来源保护', async () => {
 const store = new InMemoryKernelStore(), kernel = new AgentOsKernel(store,{ memorySources:{assert(){}} });
 const ref = {namespace:'asset',resourceId:'a',streamVersion:1,digest:'a'.repeat(64)};
 const source = await kernel.proposeMemory('local','owner','source',{...input,provenance:{...provenance,sourceRefs:[ref]}});
 await kernel.decideMemory('local','owner','accept',source.id,1,'accept');
 const grant = await kernel.createShareGrant('local','owner','share',source.id,2,'coding');
 const derived = {...input,namespace:'coding',derivedFromMemoryId:source.id,derivedViaShareGrantId:grant.id};
 await assert.rejects(kernel.proposeMemory('local','owner','bad',derived),{code:'MEMORY_PROVENANCE_DOWNGRADE'});
 const {provenance:_,...legacy}=derived;
 await assert.rejects(kernel.proposeMemory('local','owner','bad-legacy',legacy),{code:'MEMORY_PROVENANCE_DOWNGRADE'});
});
test('新记忆到期后不能确认或继续共享',async()=>{
 const store=new InMemoryKernelStore();let now='2026-10-10T00:00:00.000Z';const kernel=new AgentOsKernel(store,{now:()=>now,memorySources:{assert(){}}});
 const value=await kernel.proposeMemory('local','owner','expiring',{...input,expiresAt:'2026-10-11T00:00:00.000Z'});now='2026-10-12T00:00:00.000Z';
 await assert.rejects(kernel.decideMemory('local','owner','expired',value.id,1,'accept'),{code:'MEMORY_EXPIRED'});
});
test('直接 memory 来源引用不能绕过跨 namespace 共享授权',async()=>{
 const {sha256}=await import('../src/index.js');const store=new InMemoryKernelStore(),kernel=new AgentOsKernel(store,{memorySources:{assert(){}}});
 const source=await kernel.proposeMemory('local','owner','source',input),accepted=await kernel.decideMemory('local','owner','accepted',source.id,1,'accept');
 const sourceRef={namespace:'memory',resourceId:accepted.id,streamVersion:accepted.streamVersion,digest:sha256(accepted)};
 await assert.rejects(kernel.proposeMemory('local','owner','launder',{...input,namespace:'coding',provenance:{...provenance,sourceRefs:[sourceRef]}}),{code:'MEMORY_SHARE_REQUIRED'});
 const grant=await kernel.createShareGrant('local','owner','grant',accepted.id,accepted.streamVersion,'coding');
 const current=await store.transact('local',tx=>tx.getProjection<any>('memory',source.id));
 const candidate=await kernel.proposeMemory('local','owner','derived',{...input,namespace:'coding',provenance:{...provenance,sourceRefs:[{...sourceRef,streamVersion:current.streamVersion,digest:sha256(current)},{namespace:'shareGrant',resourceId:grant.id,streamVersion:grant.streamVersion,digest:sha256(grant)}]}});
 await kernel.revokeShareGrant('local','owner','revoke',grant.id,grant.streamVersion);
 await assert.rejects(kernel.decideMemory('local','owner','accept-derived',candidate.id,1,'accept'),{code:'MEMORY_SHARE_REQUIRED'});
});
test('来源元数据拒绝未声明正文与额外字段',async()=>{
 const store=new InMemoryKernelStore(),kernel=new AgentOsKernel(store,{memorySources:{assert(){}}});
 for(const value of [{...provenance,body:'不能把正文夹进来源元数据'},{...provenance,sourceRefs:[{namespace:'asset',resourceId:'a',streamVersion:1,digest:'a'.repeat(64),text:'未声明正文'}]},{...provenance,origin:'model',sourceExecution:{executionId:'e',generation:1,raw:'未声明正文'}}])
  await assert.rejects(kernel.proposeMemory('local','owner',JSON.stringify(value),{...input,provenance:value as any}),{code:'MEMORY_PROVENANCE_INVALID'});
});
