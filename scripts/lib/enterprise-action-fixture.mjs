// SPDX-License-Identifier: Apache-2.0
import { AgentOsKernel } from '@mn/kernel';
import { ActionCoordinator,PROVIDER_ACTION_JOB_KIND } from '@mn/business-execution';
import { AgentOsWorker,createProviderActionWorkerHandler } from '@mn/worker';
import { FileCas,InMemoryKeyProvider,DEFAULT_PROJECTION_JOURNAL_NAMESPACES } from '@mn/storage';
import { createPostgresPool } from './postgres-pool.mjs';
import { PostgresKernelStore } from './postgres-kernel-store.mjs';
import { PostgresWorkerStore } from './postgres-worker-store.mjs';
import { createEnterpriseWorkerStore } from './enterprise-worker-store.mjs';
export async function actionFixture(config,{offset=0,workerId='worker',afterCommit}={}) {
 const now=()=>new Date(Date.now()+offset).toISOString(),pool=createPostgresPool({connectionString:config.connectionString,max:2});
 const projectionJournal={cas:new FileCas({rootDir:config.casRoot}),keyProvider:new InMemoryKeyProvider(Buffer.from(config.key,'hex')),namespaces:DEFAULT_PROJECTION_JOURNAL_NAMESPACES};
 const options={pool,hmacKey:Buffer.from(config.hmac,'hex'),projectionJournal,namespace:'mn_enterprise_v1'};
 const kernelStore=new PostgresKernelStore({...options,now});try{await kernelStore.initialize();}catch(error){await pool.end();throw error;}
 const jobStore=new PostgresWorkerStore(options),store=createEnterpriseWorkerStore({kernelStore,jobStore}),kernel=new AgentOsKernel(store,{now});
 const coordinator=new ActionCoordinator({store,kernel,now,assertCurrent:(_tx,context)=>{
  if(context.action.provider!=='fixture'||context.execution.initiatedBy!=='local-owner')throw new Error('FIXTURE_POLICY_DENIED');
 }});
 if(afterCommit){const begin=coordinator.begin.bind(coordinator);coordinator.begin=async(...args)=>{const result=await begin(...args);await afterCommit(result);return result;};}
 const provider=(workspaceId)=>({id:'fixture',version:'1',binding:{id:'binding',tenantId:'local',workspaceId,streamVersion:1,mode:'builtin',bindings:[{objectType:'opportunity',provider:'fixture',allowedActions:['create_followup_task'],supportedPorts:['executeAction','getReceipt']}]},
  async readSnapshot(){return {status:'not_supported',capability:'readSnapshot'};},async listChanges(){return {status:'not_supported',capability:'listChanges'};},async prepareAction(){return {status:'not_supported',capability:'prepareAction'};},
  async executeAction(intent){const response=await fetch(config.providerUrl+'/execute',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(intent)});if(!response.ok)throw new Error('PROVIDER_REJECTED');return {status:'supported',value:await response.json()};},
  async getReceipt(operationKey){const response=await fetch(config.providerUrl+'/receipt/'+encodeURIComponent(operationKey));if(!response.ok)throw new Error('RECEIPT_UNKNOWN');return {status:'supported',value:await response.json()};}});
 const worker=(workspaceId)=>new AgentOsWorker({id:workerId,store,now:()=>new Date(now()),lock:{engineLockDigest:'fixture',expectedEngineLockDigest:'fixture',pluginLockDigest:'fixture',expectedPluginLockDigest:'fixture'},handlers:{[PROVIDER_ACTION_JOB_KIND]:createProviderActionWorkerHandler({store,coordinator,now,resolveProvider:async()=>provider(workspaceId),usageForReceipt:()=>({tokens:2,costMinorUnits:'3',currency:'CNY'})})}});
 return {cas:projectionJournal.cas,pool,kernelStore,store,kernel,coordinator,worker,provider,now,close:()=>pool.end()};
}
