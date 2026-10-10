// SPDX-License-Identifier: Apache-2.0
import type { GoalResourceRefV2, MemoryProvenanceV2, Principal, Workspace, WorkspaceMembership } from '@mn/contracts';
import { assertMemoryProvenance, KernelError, sha256, type KernelTransaction, type MemorySourceScope, type MemorySourceValidationPort } from '@mn/kernel';
import { assertContextSource, assertExecutionContextSources, assertMemoryOriginExecution, createEncryptedMemoryReader, type EncryptedMemoryReaderOptions } from '@mn/worker';
import { validateTeamSkillContextSource } from './team-skill-context.js';
import { assertBusinessContextRef, isBusinessContextRef, validateBusinessContextSource } from './business-context.js';
const currentMemorySource = (tx:KernelTransaction,scope:{tenantId:string;workspaceId:string},ref:GoalResourceRefV2) => validateTeamSkillContextSource(tx,scope,ref) || validateBusinessContextSource(tx,scope,ref);
export function assertMemoryWorkspace(tx: KernelTransaction, scope: MemorySourceScope, access: 'view'|'operate'|'review'|'owner'='view'): void {
 const workspace=tx.getProjection<Workspace>('workspace',scope.workspaceId),principal=tx.getProjection<Principal>('principal',scope.principalId);
 const member=tx.getProjection<WorkspaceMembership>('membership',`${scope.workspaceId}:${scope.principalId}`);
 const roles=access==='view'?['owner','operator','reviewer','viewer']:access==='operate'?['owner','operator']:access==='review'?['owner','operator','reviewer']:['owner'];
 if(!workspace||workspace.tenantId!==scope.tenantId||!principal||principal.disabledAt||!member||member.tenantId!==scope.tenantId||member.removedAt||!roles.includes(member.workspaceRole))
  throw new KernelError('WORKSPACE_ACCESS_DENIED','无权访问此工作区','联系工作区所有者');
}
function failure(): never {throw new KernelError('MEMORY_SOURCE_CLOSURE_INVALID','模型记忆缺少真实执行来源','从已完成且来源有效的执行重新创建提案');}
function executionSources(tx:KernelTransaction,scope:MemorySourceScope,provenance:MemoryProvenanceV2):readonly GoalResourceRefV2[]{
 const binding=provenance.sourceExecution;if(!binding)failure();
 const execution=assertMemoryOriginExecution(tx,scope,binding);
 const context=assertExecutionContextSources(tx,execution,currentMemorySource);
 if(!context)failure();
 return [...context.sourceRefs,{namespace:'execution.context',resourceId:execution.id,streamVersion:context.streamVersion,digest:context.digest}];
}
export function resolveMemoryProvenance(tx:KernelTransaction,scope:MemorySourceScope,input:MemoryProvenanceV2):MemoryProvenanceV2{
 assertMemoryWorkspace(tx,scope,'operate');assertMemoryProvenance(input);
 const refs=new Map(input.sourceRefs.map(ref=>[`${ref.namespace}:${ref.resourceId}`,ref]));
 if(input.origin==='model')for(const ref of executionSources(tx,scope,input)){
  const key=`${ref.namespace}:${ref.resourceId}`,old=refs.get(key);if(old&&sha256(old)!==sha256(ref))failure();refs.set(key,ref);
 }
 const result={...input,sourceRefs:[...refs.values()].sort((a,b)=>`${a.namespace}:${a.resourceId}`.localeCompare(`${b.namespace}:${b.resourceId}`))};
 hostMemorySourceValidationPort.assert(tx,scope,result,'propose');return result;
}
export const hostMemorySourceValidationPort:MemorySourceValidationPort={assert(tx,scope,provenance,purpose){
 assertMemoryWorkspace(tx,scope,purpose==='read'?'view':purpose==='accept'?'review':'operate');assertMemoryProvenance(provenance);
 if(provenance.origin==='model')for(const ref of executionSources(tx,scope,provenance))if(!provenance.sourceRefs.some(candidate=>sha256(candidate)===sha256(ref)))failure();
 for(const ref of provenance.sourceRefs){
  if(isBusinessContextRef(ref))assertBusinessContextRef(tx,scope,ref);
  else assertContextSource(tx,scope,ref,currentMemorySource);
 }
}};
export function createHostMemoryReader(options:EncryptedMemoryReaderOptions){return createEncryptedMemoryReader({...options,memorySources:hostMemorySourceValidationPort});}

/** Historical business snapshots never make an obsolete memory current again. */
export function validateHostMemoryContextSource(tx:KernelTransaction,scope:{tenantId:string;workspaceId:string},ref:GoalResourceRefV2):boolean {
 if(ref.namespace==='memory')assertContextSource(tx,scope,ref,currentMemorySource);
 return false;
}
