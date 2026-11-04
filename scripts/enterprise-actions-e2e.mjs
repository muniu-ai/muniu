// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {verifyEnterpriseAdmission} from './lib/enterprise-admission-fixture.mjs';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {execFile,fork} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createBudgetAccount} from '@mn/kernel';
import {computeActionIntentDigest} from '@mn/contracts';
import {PROVIDER_ACTION_AGENT_ID,PROVIDER_ACTION_JOB_KIND} from '@mn/business-execution';
import {waitForFixturePort} from './lib/fixture-network.mjs';
import {actionFixture} from './lib/enterprise-action-fixture.mjs';
const exec=promisify(execFile),docker=async(...args)=>(await exec('docker',args,{maxBuffer:1024*1024})).stdout.trim();
const root=await mkdtemp(join(tmpdir(),'mn-actions-')),name='mn-enterprise-actions-'+randomUUID(),sessions=[];
let container,server,child;const coordinators=new Map();
try{
 container=await docker('run','--detach','--name',name,'--memory','192m','--cpus','0.5','--tmpfs','/var/lib/postgresql/data:rw,size=256m','-p','127.0.0.1::5432','-e','POSTGRES_USER=mn','-e','POSTGRES_PASSWORD=synthetic-only','-e','POSTGRES_DB=actions_fixture','postgres:16-alpine');
 const address=await waitForFixturePort(()=>docker('port',container,'5432/tcp'));
 for(let i=0;;i++){const ready=await exec('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','mn']).then(()=>true,()=>false);if(ready)break;if(i===60)throw new Error('POSTGRES_NOT_READY');await delay(500);}
 const config={connectionString:`postgres://mn:synthetic-only@${address}/actions_fixture`,casRoot:join(root,'cas'),hmac:randomBytes(32).toString('hex'),key:randomBytes(32).toString('hex')};
 const connect=async extra=>{const f=await actionFixture({...config,...extra},{workerId:'worker-'+sessions.length,offset:extra?.offset??0});sessions.push(f);return f;};
 const a=await connect();coordinators.set('local',a.coordinator);await a.pool.query("create schema fixture_provider;create table fixture_provider.receipts(operation_key text primary key, receipt jsonb not null, calls integer not null);create schema mn_v2;create table mn_v2.sentinel(value text);insert into mn_v2.sentinel values('untouched')");
 await a.store.transact('guard-tenant',tx=>{
  assert.equal(tx.getStreamVersion('guard','counter'),0);tx.appendEvent({tenantId:'guard-tenant',aggregateType:'guard',aggregateId:'counter',expectedStreamVersion:0,type:'guard.created',actorId:'fixture',generation:0,correlationId:'guard',publicPayload:{}});
  tx.beforeCommit(()=>assert.equal(tx.getStreamVersion('guard','counter'),1));
 });
 let authorized=true;const put=a.cas.put.bind(a.cas);a.cas.put=async bytes=>{const result=await put(bytes);authorized=false;return result;};
 await assert.rejects(a.store.transact('guard-tenant',tx=>{tx.beforeCommit(()=>{if(!authorized)throw new Error('EXPIRED_AFTER_PROTECTION');});tx.putProjection('guard-protected','item',{streamVersion:1,value:'synthetic'});tx.appendEvent({tenantId:'guard-tenant',aggregateType:'guard',aggregateId:'expired',expectedStreamVersion:0,type:'guard.created',actorId:'fixture',generation:0,correlationId:'guard',publicPayload:{}});}),/EXPIRED_AFTER_PROTECTION/);
 a.cas.put=put;await a.store.transact('guard-tenant',tx=>{assert.equal(tx.getStreamVersion('guard','expired'),0);assert.equal(tx.getProjection('guard-protected','item'),undefined);});
 server=createServer((request,response)=>{void(async()=>{
  if(request.method==='GET'){const key=decodeURIComponent(request.url.slice('/receipt/'.length));const result=await a.pool.query('select receipt from fixture_provider.receipts where operation_key=$1',[key]);if(!result.rows.length){response.writeHead(404).end();return;}response.setHeader('content-type','application/json');response.end(JSON.stringify(result.rows[0].receipt));return;}
  let raw='';for await(const chunk of request)raw+=chunk;const intent=JSON.parse(raw),time=new Date().toISOString();
  const committed=await coordinators.get(intent.tenantId)?.get(intent.tenantId,intent.id);assert.equal(committed?.status,'committed');assert.equal(computeActionIntentDigest(intent),committed.actionDigest);
  const receipt={id:'receipt-'+intent.operationKey,tenantId:intent.tenantId,workspaceId:intent.workspaceId,provider:'fixture',operationKey:intent.operationKey,actionDigest:computeActionIntentDigest(intent),status:'succeeded',receivedAt:time,completedAt:time,evidenceRefs:[{id:'proof',tenantId:intent.tenantId,workspaceId:intent.workspaceId,sourceKind:'business_fact',sourceVersion:'1',digest:'c'.repeat(64),permissionRef:'fixture',protectedContentRef:'protected-provider-receipt',locator:{paragraph:'record'}}]};
  await a.pool.query('insert into fixture_provider.receipts values($1,$2,1) on conflict(operation_key) do update set calls=fixture_provider.receipts.calls+1',[intent.operationKey,JSON.stringify(receipt)]);
  if(intent.operationKey.endsWith('lost-response')){request.socket.destroy();return;}response.setHeader('content-type','application/json');response.end(JSON.stringify(receipt));
 })().catch(()=>{response.writeHead(500).end();});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));config.providerUrl=`http://127.0.0.1:${server.address().port}`;
 await a.kernel.bootstrapLocal('bootstrap');const workspace=await a.kernel.createWorkspace('local','local-owner','workspace',{name:'动作验收',viewMode:'business',pluginIds:['business']});config.workspaceId=workspace.id;
 const thread=await a.kernel.createThread('local','local-owner','thread',{workspaceId:workspace.id,pluginId:'business',subject:'合成任务'});
 const account=await a.store.transact('local',tx=>createBudgetAccount(tx,{tenantId:'local',workspaceId:workspace.id,principalId:'local-owner',occurredAt:a.now(),scope:{namespace:'goal',resourceId:'goal'},limit:{tokens:100,costMinorUnits:'100',currency:'CNY'},expiresAt:new Date(Date.now()+3600000).toISOString()}));
 const prepare=async id=>{
  const target={tenantId:'local',workspaceId:workspace.id,provider:'fixture',objectType:'opportunity',objectId:id,sourceVersion:'1',digest:'a'.repeat(64),observedAt:a.now(),permissionRef:'fixture'};
  const execution=await a.kernel.createExecution('local','local-owner','execution-'+id,{workspaceId:workspace.id,threadId:thread.id,pluginId:'business',agentDefinitionId:PROVIDER_ACTION_AGENT_ID,modelBindingId:'none',executionPrincipalId:'agent:business',authority:{workspaceId:workspace.id,principalId:'agent:business',toolIds:['provider.followup'],dataScopes:[{namespace:'provider.fixture.opportunity',resourceId:id,digest:target.digest}],autoAllowedEffects:[],budget:{maxSubagents:0,maxSubagentDepth:0,maxTokens:100,maxCostMinorUnits:'100',currency:'CNY',maxDurationMs:3600000}}});
  const input={id,tenantId:'local',workspaceId:workspace.id,operationKey:id,goalId:'goal',nodeId:id,attemptId:id,generation:1,provider:'fixture',action:'create_followup_task',target,authorityRevisionId:execution.authorityId,providerBindingVersion:1,preparedInputRef:'CONFIDENTIAL-input-ref',inputDigest:'b'.repeat(64),expiresAt:new Date(Date.now()+1800000).toISOString()},options={executionId:execution.id,accountId:account.id,actorId:'local-owner',idempotencyKey:id,toolId:'provider.followup',toolVersion:'1',amount:{tokens:10,costMinorUnits:'10',currency:'CNY'}};
  const value=await a.coordinator.prepare(input,options);assert.deepEqual(await a.coordinator.prepare({...input,id:'duplicate-'+id},{...options,idempotencyKey:'duplicate-'+id}),value);
  const approval=await a.coordinator.requestApproval('local',id);await a.kernel.decideApproval('local','local-owner','approve-'+id,approval.id,approval.streamVersion,'approve_once');return a.coordinator.enqueue('local',id);
 };
 const b=await connect(),c=await connect();const balance=()=>a.store.transact('local',tx=>tx.getProjection('budget.account',account.id));
 const success=await prepare('success');const races=await Promise.all([b.worker(workspace.id).pollOnce(),c.worker(workspace.id).pollOnce()]);assert.equal(races.filter(r=>r.status==='completed').length,1);assert.equal((await a.pool.query("select calls from fixture_provider.receipts where operation_key='success'")).rows[0].calls,1);
 assert.equal((await balance()).spentCostMinorUnits,'3');
 const lost=await prepare('lost-response');assert.equal((await b.worker(workspace.id).pollOnce()).status,'needs_reconciliation');assert.equal((await balance()).heldCostMinorUnits,'10');
 const restarted=await connect();await restarted.kernelStore.rebuildProjections('local');assert.equal((await restarted.worker(workspace.id).pollOnce()).status,'idle');const pending=await restarted.coordinator.get('local',lost.id);const received=(await restarted.provider(workspace.id).getReceipt(lost.operationKey)).value;
 await restarted.coordinator.reconcile('local',lost.id,pending.streamVersion,'local-owner',received,{tokens:2,costMinorUnits:'3',currency:'CNY'});await restarted.coordinator.reconcile('local',lost.id,pending.streamVersion,'local-owner',received,{tokens:2,costMinorUnits:'3',currency:'CNY'});assert.equal((await balance()).spentCostMinorUnits,'6');assert.equal((await balance()).heldCostMinorUnits,'0');
 const crash=await prepare('crash');const file=join(root,'child.json');await writeFile(file,JSON.stringify(config),{mode:0o600});child=fork(new URL('./enterprise-actions-child.mjs',import.meta.url),[file],{env:{...process.env,NODE_OPTIONS:'--max-old-space-size=128'},stdio:['ignore','ignore','pipe','ipc']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CHILD_COMMIT_TIMEOUT')),20000);child.once('message',m=>{clearTimeout(timer);assert.equal(m.status,'committed');resolve();});child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(new Error('CHILD_EXITED_BEFORE_COMMIT'));});});
 const closed=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await closed;child=undefined;
 const recovered=await connect({offset:31000});await recovered.kernelStore.rebuildProjections('local');assert.equal((await recovered.worker(workspace.id).pollOnce()).status,'needs_reconciliation');assert.equal((await a.pool.query("select count(*)::int as count from fixture_provider.receipts where operation_key='crash'")).rows[0].count,0);assert.equal((await balance()).heldCostMinorUnits,'10');
 assert.equal((await recovered.coordinator.get('local',crash.id)).operationKey,crash.operationKey);
 const notExecuted={id:'absent-receipt',tenantId:'local',workspaceId:workspace.id,provider:'fixture',operationKey:crash.operationKey,actionDigest:crash.actionDigest,status:'not_executed',receivedAt:recovered.now(),reasonCode:'PROVEN_NOT_SENT'};
 await assert.rejects(a.coordinator.complete('local',crash.id,notExecuted,{tokens:0,costMinorUnits:'0',currency:'CNY'},{jobId:crash.jobId,workerId:'crash-worker',fencingToken:1,occurredAt:a.now()}),{code:'STALE_FENCING_TOKEN'});

 const waiting=await prepare('cancel');await a.coordinator.cancelBeforeDispatch('local',waiting.id,'local-owner');assert.equal((await balance()).heldCostMinorUnits,'10');assert.equal((await c.worker(workspace.id).pollOnce()).status,'idle');
 const raw=await a.pool.query('select public_payload::text from mn_enterprise_v1.events');assert.doesNotMatch(JSON.stringify(raw.rows),/CONFIDENTIAL-input-ref|heldCostMinorUnits/);assert.deepEqual((await a.pool.query('select value from mn_v2.sentinel')).rows,[{value:'untouched'}]);
 assert.equal((await a.pool.query('select count(*)::int as count from fixture_provider.receipts where calls<>1')).rows[0].count,0);
 assert.equal((await a.pool.query("select count(*)::int as count from mn_enterprise_v1.outbox where topic='action.queued'")).rows[0].count,4);
 if(process.argv.includes('--with-enterprise-admission'))await verifyEnterpriseAdmission({store:a.store,cas:a.cas,key:config.key,providerUrl:config.providerUrl,registerCoordinator:(tenant,coordinator)=>coordinators.set(tenant,coordinator),pool:a.pool,rebuild:tenant=>a.kernelStore.rebuildProjections(tenant)});
 process.stdout.write('E3.1 PostgreSQL：双 Worker 竞争、事务派发、响应丢失、SIGKILL、重建、不重放、预算保留、核对去重和取消通过。\n');
}finally{
 child?.kill('SIGKILL');if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 for(const f of sessions)await f.close();if(container)await docker('rm','--force',container);await rm(root,{recursive:true,force:true});
}
