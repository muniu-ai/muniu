// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOsKernel, InMemoryKernelStore, sha256 } from '@mn/kernel';
import { hostMemorySourceValidationPort, resolveMemoryProvenance } from '../src/memory-sources.js';
const now='2026-10-10T00:00:00.000Z';
async function fixture(){const store=new InMemoryKernelStore(),kernel=new AgentOsKernel(store);await kernel.bootstrapLocal('setup');const w=await kernel.createWorkspace('local','local-owner','workspace',{name:'记忆',viewMode:'business',pluginIds:['opc']});return {store,scope:{tenantId:'local',workspaceId:w.id,principalId:'local-owner'}};}
test('模型记忆从实际提交执行补齐来源，客户端减少或跨区伪造均拒绝',async()=>{
 const {store,scope}=await fixture();
 await store.transact('local',tx=>{tx.putProjection('asset','a',{id:'a',tenantId:'local',workspaceId:scope.workspaceId,streamVersion:1,digest:'a'.repeat(64),protected:true,protectedPayloadRef:'ak'});tx.putProjection('protectedPayloadKey','ak',{});
 tx.putProjection('execution','e',{id:'e',tenantId:'local',workspaceId:scope.workspaceId,generation:1,status:'completed'});
 const body={version:1,executionId:'e',tenantId:'local',workspaceId:scope.workspaceId,streamVersion:1,sourceRefs:[{namespace:'asset',resourceId:'a',streamVersion:1,digest:'a'.repeat(64)}],materials:[],inheritedExecutionIds:[]};tx.putProjection('execution.context','e',{...body,digest:sha256(body)});
 tx.putProjection('agent-runtime','e',{records:[{type:'model/request',protectedPayloadRef:'rk'},{type:'model/response',protectedPayloadRef:'rr'}]});tx.putProjection('protectedPayloadKey','rk',{});tx.putProjection('protectedPayloadKey','rr',{});});
 const origin={version:1 as const,kind:'fact' as const,origin:'model' as const,sourceRefs:[],sourceExecution:{executionId:'e',generation:1}};
 const result=await store.transact('local',tx=>resolveMemoryProvenance(tx,scope,origin));
 assert.equal(result.sourceRefs.some(ref=>ref.namespace==='asset'),true);
 await assert.rejects(store.transact('local',tx=>hostMemorySourceValidationPort.assert(tx,scope,origin,'propose')),{code:'MEMORY_SOURCE_CLOSURE_INVALID'});
 await store.transact('local',tx=>tx.deleteProjection('protectedPayloadKey','ak'));
 await assert.rejects(store.transact('local',tx=>hostMemorySourceValidationPort.assert(tx,scope,result,'accept')));
});
test('技能执行模型提案保留技能与职责资料来源，职责材料撤回后禁止确认',async()=>{
 const {store,scope}=await fixture();const {teamSkillVersionId}=await import('../src/team-skill-context.js');
 const id=teamSkillVersionId(scope.workspaceId,'research','1');
 const source={namespace:'asset',resourceId:'skill-material',streamVersion:1,digest:'a'.repeat(64)};
 await store.transact('local',tx=>{
  tx.putProjection('asset',source.resourceId,{id:source.resourceId,tenantId:'local',workspaceId:scope.workspaceId,streamVersion:1,digest:source.digest,protected:true,protectedPayloadRef:'skill-key'});tx.putProjection('protectedPayloadKey','skill-key',{});
  const skill={id,tenantId:'local',workspaceId:scope.workspaceId,streamVersion:1,skillId:'research',version:'1',sourceRefs:[],roles:[{nodeId:'research',instructions:'核对交付事实',sourceRefs:[source]}]};const skillDigest=sha256(skill);tx.putProjection('team.skillVersion',id,{...skill,digest:skillDigest});
  tx.putProjection('execution','skill-execution',{id:'skill-execution',tenantId:'local',workspaceId:scope.workspaceId,generation:1,status:'completed'});
  const body={version:1,executionId:'skill-execution',tenantId:'local',workspaceId:scope.workspaceId,streamVersion:1,sourceRefs:[{namespace:'team.skillVersion',resourceId:id,streamVersion:1,digest:skillDigest},source],materials:[],inheritedExecutionIds:[]};tx.putProjection('execution.context','skill-execution',{...body,digest:sha256(body)});
  tx.putProjection('agent-runtime','skill-execution',{records:[{type:'model/request',protectedPayloadRef:'sk-request'},{type:'model/response',protectedPayloadRef:'sk-response'}]});tx.putProjection('protectedPayloadKey','sk-request',{});tx.putProjection('protectedPayloadKey','sk-response',{});
 });
 const result=await store.transact('local',tx=>resolveMemoryProvenance(tx,scope,{version:1,kind:'fact',origin:'model',sourceRefs:[],sourceExecution:{executionId:'skill-execution',generation:1}}));
 assert.ok(result.sourceRefs.some(ref=>ref.namespace==='team.skillVersion'));
 await store.transact('local',tx=>tx.deleteProjection('protectedPayloadKey','skill-key'));
 await assert.rejects(store.transact('local',tx=>hostMemorySourceValidationPort.assert(tx,scope,result,'accept')));
});
