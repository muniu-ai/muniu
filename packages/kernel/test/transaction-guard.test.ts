// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';import test from 'node:test';
import {InMemoryKernelStore} from '../src/index.js';
const event={tenantId:'tenant',aggregateType:'guard',aggregateId:'record',expectedStreamVersion:0,type:'guard.changed',actorId:'actor',generation:0,correlationId:'guard',publicPayload:{}};
test('事务能读取本租户事件流版本，提交前检查失败会回滚全部修改',async()=>{
 const store=new InMemoryKernelStore();let checked=false;
 await assert.rejects(store.transact('tenant',tx=>{const gate=tx as any;assert.equal(gate.getStreamVersion('guard','record'),0);tx.appendEvent(event);assert.equal(gate.getStreamVersion('guard','record'),1);gate.beforeCommit(()=>{checked=true;throw new Error('AUTHORITY_EXPIRED');});}),/AUTHORITY_EXPIRED/);
 assert.equal(checked,true);assert.equal((await store.readEvents('tenant',0,100)).events.length,0);
 await store.transact('other',tx=>assert.equal((tx as any).getStreamVersion('guard','record'),0));
});
test('提交检查必须同步且不能补写事实或在事务结束后使用事务句柄',async()=>{
 const store=new InMemoryKernelStore();let escaped:any;
 for(const guard of [()=>false,async()=>{},()=>escaped.appendEvent(event)])await assert.rejects(store.transact('tenant',tx=>{escaped=tx;(tx as any).beforeCommit(guard);}),/GUARD|READ_ONLY/);
 await store.transact('tenant',tx=>{escaped=tx;});assert.throws(()=>escaped.appendEvent(event),/TRANSACTION_CLOSED/);
});

test('执行与授权能随企业范围事实在同一事务回滚',async()=>{
 const {AgentOsKernel}=await import('../src/index.js');const store=new InMemoryKernelStore(),kernel=new AgentOsKernel(store);await kernel.bootstrapLocal('bootstrap');
 const workspace=await kernel.createWorkspace('local','local-owner','workspace',{name:'主体',viewMode:'business',pluginIds:['business']});const thread=await kernel.createThread('local','local-owner','thread',{workspaceId:workspace.id,pluginId:'business',subject:'工作'});
 await assert.rejects(store.transact('local',tx=>{(kernel as any).createExecutionInTransaction(tx,'local','local-owner','execution',{workspaceId:workspace.id,threadId:thread.id,pluginId:'business',agentDefinitionId:'business.provider-action',modelBindingId:'none',executionPrincipalId:'agent:business',authority:{workspaceId:workspace.id,principalId:'agent:business',toolIds:[],dataScopes:[],autoAllowedEffects:[],budget:{maxTokens:10,maxCostMinorUnits:'10',currency:'CNY',maxDurationMs:10000,maxSubagents:0,maxSubagentDepth:0}}});throw new Error('SCOPE_REJECTED');}),/SCOPE_REJECTED/);
 assert.equal(await store.transact('local',tx=>tx.listProjections('execution').length),0);assert.equal(await store.transact('local',tx=>tx.listProjections('authority').length),0);
});
