// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
export async function verifyFulfillment({a,b,actor,workspace,command,order}) {
 const id=order.reference.objectId,date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
 for(const person of ['project','reviewer','finance-a','finance-b']){
  const invitation=await a.identity.invite(actor,'invite-'+person,{id:person,subject:person,displayName:person,organizationAdmin:false});
  await a.identity.acceptInvitation({...actor,principalId:person},'accept-'+person,person,1,invitation.token);
  await a.permissions.grantRole(actor,'role-'+person,{id:'role-'+person,workspaceId:workspace.id,principalId:person,role:person.startsWith('finance')?'finance':'project_owner',scope:{kind:'objects',objects:[{objectType:'order',objectId:id}]},operations:['read','write','business_approve'],fieldClasses:person.startsWith('finance')?['public','price','cost']:['public'],expiresAt:new Date(Date.now()+86400000).toISOString()});
 }
 const act=person=>({...actor,principalId:person}),get=(type,id,person='finance-b')=>a.business.get(act(person),workspace.id,type,id);let n=0;
 const run=(body,person)=>command(a.business,body,person);
 const proof=async(type,id,person)=>a.business.recordEvidence({actor:act(person),actorKind:'human',workspaceId:workspace.id,idempotencyKey:'fulfillment-proof-'+(++n),subject:(await get(type,id,person)).reference,attestation:'合成业务材料已核对',additionalFieldClasses:[]});
 const project=await run({type:'project.create',id:'project',order:order.reference,title:'交付项目'},'project');
 const milestone=await run({type:'milestone.create',id:'milestone',project:project.reference,title:'阶段一',dueDate:date,lines:[{lineId:'line-1',quantity:3}]},'project');
 await run({type:'delivery.report',id:'delivery',milestone:milestone.reference,summary:'两项合成成果',lines:[{lineId:'line-1',quantity:2}]},'project');
 const delivery=await run({type:'delivery.receive',id:'delivery',expectedStreamVersion:1},'project');
 assert.equal((await a.business.summary(act('project'),workspace.id,'progress','project')).values.lines[0].accepted,0);
 await run({type:'acceptance.prepare',id:'acceptance',delivery:delivery.reference,lines:[{lineId:'line-1',quantity:1}]},'project');
 await run({type:'acceptance.confirm',id:'acceptance',expectedStreamVersion:1,evidence:await proof('customer_acceptance','acceptance','reviewer')},'reviewer');
 for(const [schedule,amountMinor] of [['first',10000],['second',20000]]){
  await run({type:'payment_schedule.create',id:schedule,order:order.reference,amountMinor,dueDate:date},'finance-a');
  await run({type:'payment_schedule.confirm',id:schedule,expectedStreamVersion:1,evidence:await proof('payment_schedule',schedule,'finance-b')},'finance-b');
 }
 const schedule=(await get('payment_schedule','first')).reference;
 await run({type:'receipt.prepare',id:'receipt',order:order.reference,amountMinor:6000,businessDate:date,allocations:[{schedule,amountMinor:6000}]},'finance-a');
 const confirmed=await run({type:'receipt.confirm',id:'receipt',expectedStreamVersion:1,evidence:await proof('receipt','receipt','finance-b')},'finance-b');
 await run({type:'refund.prepare',id:'refund',receipt:confirmed.reference,amountMinor:1000,businessDate:date,releasedAllocations:[{schedule,amountMinor:1000}]},'finance-a');
 await run({type:'refund.confirm',id:'refund',expectedStreamVersion:1,evidence:await proof('refund','refund','finance-b')},'finance-b');
 await run({type:'adjustment.prepare',id:'reversal',kind:'receipt_reversal',receipt:confirmed.reference,amountMinor:500,businessDate:date,releasedAllocations:[{schedule,amountMinor:500}],reason:'错误入账'},'finance-a');
 await run({type:'adjustment.confirm',id:'reversal',expectedStreamVersion:1,evidence:await proof('adjustment','reversal','finance-b')},'finance-b');
 await run({type:'adjustment.prepare',id:'write-off',kind:'write_off',order:order.reference,schedule,amountMinor:500,businessDate:date,reason:'合成减免'},'finance-a');
 await run({type:'adjustment.confirm',id:'write-off',expectedStreamVersion:1,evidence:await proof('adjustment','write-off','finance-b')},'finance-b');
 const balance=await b.business.summary(act('finance-b'),workspace.id,'balance',id,date);assert.equal(balance.values.outstandingMinor,25000);assert.equal(balance.values.refundedMinor,1000);assert.equal(balance.values.reversedMinor,500);
 await run({type:'expense.prepare',id:'expense',project:project.reference,amountMinor:10000,businessDate:date,description:'合成支出'},'finance-a');
 const expense=await run({type:'expense.confirm',id:'expense',expectedStreamVersion:1,evidence:await proof('expense','expense','finance-b')},'finance-b');
 assert.equal((await a.business.summary(act('finance-b'),workspace.id,'costs','project')).values.marginMinor,null);
 await run({type:'project.costs.confirm',id:'project',expectedStreamVersion:1,evidence:await proof('project','project','finance-b'),expenseRefs:[expense.reference],zeroCost:false},'finance-b');
 const review=await run({type:'business_review.snapshot',id:'review',order:order.reference,periodStart:date,periodEnd:date,includeCosts:true},'finance-b');assert.equal(review.values.costMetrics.marginMinor,20000);
 const period=(await get('payment_schedule','second')).reference;
 for(const receipt of ['race-a','race-b'])await run({type:'receipt.prepare',id:receipt,order:order.reference,amountMinor:17000,businessDate:date,allocations:[{schedule:period,amountMinor:17000}]},'finance-a');
 const proofs=[await proof('receipt','race-a','finance-b'),await proof('receipt','race-b','finance-b')];
 const races=await Promise.allSettled([a.business,b.business].map((service,i)=>command(service,{type:'receipt.confirm',id:i?'race-b':'race-a',expectedStreamVersion:1,evidence:proofs[i]},'finance-b')));assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.equal(races.find(r=>r.status==='rejected').reason.code,'PAYMENT_ALLOCATION_EXCEEDED');
 assert.deepEqual(await b.business.get(act('finance-b'),workspace.id,'business_review','review'),review);
 const currentProject=await get('project','project','project');
 await run({type:'change_request.prepare',id:'change',project:currentProject.reference,description:'追加一项'},'project');
 await run({type:'change_request.price',id:'change',expectedStreamVersion:1,lines:[{orderLineId:'line-1',quantity:4}]},'sales');
 await run({type:'change_request.approve',id:'change',expectedStreamVersion:2,evidence:await proof('change_request','change','manager')},'manager');
 await assert.rejects(run({type:'delivery.report',id:'blocked',milestone:milestone.reference,summary:'待项目确认',lines:[{lineId:'line-1',quantity:1}]},'project'),{code:'PROJECT_SCOPE_PENDING'});
 await run({type:'change_request.project_confirm',id:'change',expectedStreamVersion:3,milestones:[]},'project');
 assert.equal((await b.business.get(act('project'),workspace.id,'milestone','milestone')).reference.streamVersion,1);
 assert.equal((await b.business.summary(act('finance-b'),workspace.id,'balance',id,date)).values.outstandingMinor,18000);
 assert.equal((await b.business.summary(act('finance-b'),workspace.id,'costs','project')).values.marginMinor,null);
 assert.deepEqual(await b.business.get(act('finance-b'),workspace.id,'business_review','review'),review);
 const previousDate=new Date(Date.parse(date+'T00:00:00.000Z')-86400000).toISOString().slice(0,10);
 const historical=(await b.business.summary(act('finance-b'),workspace.id,'balance',id,previousDate)).values;
 const originalPeriod=await get('payment_schedule','first');
 await run({type:'adjustment.prepare',id:'reschedule',kind:'schedule_revision',schedule:originalPeriod.reference,proposedAmountMinor:9000,proposedDueDate:date,businessDate:date,reason:'重新安排分期'},'finance-a');
 await run({type:'adjustment.confirm',id:'reschedule',expectedStreamVersion:1,evidence:await proof('adjustment','reschedule','finance-b')},'finance-b');
 const currentOrder=await get('order',id);
 await run({type:'payment_schedule.create',id:'remaining-period',order:currentOrder.reference,amountMinor:1000,dueDate:date},'finance-a');
 await run({type:'payment_schedule.confirm',id:'remaining-period',expectedStreamVersion:1,evidence:await proof('payment_schedule','remaining-period','finance-b')},'finance-b');
 assert.deepEqual((await b.business.summary(act('finance-b'),workspace.id,'balance',id,previousDate)).values,historical);
 assert.equal((await b.business.get(act('finance-b'),workspace.id,'payment_schedule','remaining-period')).values.businessDate,date);
 assert.deepEqual(await b.business.get(act('finance-b'),workspace.id,'payment_schedule','first',originalPeriod.reference.streamVersion),originalPeriod);
 await a.permissions.revoke(actor,'revoke-project','role','role-project',1);await assert.rejects(a.business.summary(act('project'),workspace.id,'progress','project'),{code:'OBJECT_ACCESS_DENIED'});
 process.stdout.write('E2.2 PostgreSQL：部分交付、客户验收、分期发生日期、退款、冲销、减免、成本、固定复盘、并发超额拒绝、范围变更及撤权通过。\n');
}
