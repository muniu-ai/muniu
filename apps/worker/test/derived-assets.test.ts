// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryKernelStore, sha256 } from '@mn/kernel';
import { assertContextSource } from '../src/execution-context.js';
test('派生资料继承撤权、证明密钥与权威内容变化并拒绝循环和跨区', async () => {
  const store = new InMemoryKernelStore();
  await store.transact('t', tx => {
    const source = { id:'s', tenantId:'t', workspaceId:'w', streamVersion:1, digest:'s', protected:true, protectedPayloadRef:'sk' };
    const ref = {namespace:'asset',resourceId:'s',streamVersion:1,digest:'s'};
    tx.putProjection('asset','s',source); tx.putProjection('protectedPayloadKey','sk',{id:'sk'});
    tx.putProjection('protectedPayloadKey','dk',{id:'dk'}); tx.putProjection('protectedPayloadKey','response',{id:'response'});
    const gate = {id:'gate',status:'passed'}; tx.putProjection('coding.gate-result','gate',gate);
    const derived = { id:'d',tenantId:'t',workspaceId:'w',streamVersion:1,digest:'d',protected:true,protectedPayloadRef:'dk',
      provenance:{version:1,kind:'goal_export',producer:{namespace:'goal.export',resourceId:'e'},sourceRefs:[ref],proof:{projections:[{namespace:'coding.gate-result',resourceId:'gate',digest:sha256(gate)}],protectedPayloadRefs:['response']}} };
    const check=()=>assertContextSource(tx,{tenantId:'t',workspaceId:'w'},{namespace:'asset',resourceId:'d',streamVersion:1,digest:'d'});
    tx.putProjection('asset','d',derived); check();
    tx.deleteProjection('protectedPayloadKey','sk'); assert.throws(check); tx.putProjection('protectedPayloadKey','sk',{id:'sk'});
    tx.deleteProjection('protectedPayloadKey','response'); assert.throws(check); tx.putProjection('protectedPayloadKey','response',{id:'response'});
    tx.putProjection('coding.gate-result','gate',{...gate,status:'failed'}); assert.throws(check); tx.putProjection('coding.gate-result','gate',gate);
    tx.putProjection('asset','s',{...source,workspaceId:'other'}); assert.throws(check); tx.putProjection('asset','s',source);
    tx.putProjection('asset','d',{...derived,provenance:{...derived.provenance,sourceRefs:[{...ref,resourceId:'d',digest:'d'}]}}); assert.throws(check);
  });
});
test('叶来源校验回调跨模块回源时仍拒绝循环并释放递归上下文',async()=>{
 const store=new InMemoryKernelStore();await store.transact('t',tx=>{
  const scope={tenantId:'t',workspaceId:'w'},ref={namespace:'team.skillVersion',resourceId:'s',streamVersion:1,digest:'s'};
  const recursive=()=>{assertContextSource(tx,scope,ref,recursive);return true;};
  assert.throws(()=>assertContextSource(tx,scope,ref,recursive),{code:'CONTEXT_INVALID'});
  assert.doesNotThrow(()=>assertContextSource(tx,scope,ref,()=>true));
 });
});
test('历史读取为同一来源执行更严格的当前叶核验不是循环',async()=>{
 const store=new InMemoryKernelStore();await store.transact('t',tx=>{
  const scope={tenantId:'t',workspaceId:'w'},ref={namespace:'source',resourceId:'s',streamVersion:1,digest:'s'};
  tx.putProjection('source','s',{tenantId:'t',workspaceId:'w',streamVersion:1,digest:'s'});
  const current=()=>false,historical=()=>{assertContextSource(tx,scope,ref,current);return false;};
  assert.doesNotThrow(()=>assertContextSource(tx,scope,ref,historical));
 });
});
