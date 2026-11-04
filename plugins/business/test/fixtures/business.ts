// SPDX-License-Identifier: Apache-2.0
import { decideBusinessCommand,reduceBusinessEvents,type BusinessEvent } from '../../src/index.js';
import type { BusinessObjectRef, EvidenceRef } from '@mn/contracts';
export function businessFixture() {
 const events:BusinessEvent[]=[]; const now='2026-11-02T01:00:00.000Z';
 const execute=(command:unknown,actorId='maker',actorKind:'human'|'agent'='human')=>{
  const result=decideBusinessCommand(reduceBusinessEvents(events),command as never,{tenantId:'tenant',workspaceId:'workspace',actorId,actorKind,now,revisionSalt:'a'.repeat(64),assertCurrent:()=>{},assertEvidence:()=>{}});
  events.push(...result.events); return reduceBusinessEvents(events).objects.get(result.primaryObjectKey)!;
 };
 const ref=(type:string,id:string)=>reduceBusinessEvents(events).objects.get(type+':'+id)!.reference;
 const proof=(subject:BusinessObjectRef):EvidenceRef=>({id:'evidence-'+subject.objectId,tenantId:'tenant',workspaceId:'workspace',sourceKind:'human_decision',sourceVersion:'1',digest:'b'.repeat(64),permissionRef:'fixture',protectedContentRef:'protected-evidence',locator:{paragraph:'confirmation'}});
 const order=(quantity=10)=>{
  execute({type:'customer.create',id:'customer',name:'合成客户'});
  execute({type:'opportunity.create',id:'opportunity',customer:ref('customer','customer'),title:'需求'});
  execute({type:'service.publish',id:'service',serviceCode:'service',title:'服务',unit:'项',unitPriceMinor:100000,scope:'服务范围',acceptanceCriteria:['验收条件'],validFrom:now,validUntil:'2027-01-01T00:00:00.000Z'},'manager');
  execute({type:'quote.prepare',id:'quote',opportunity:ref('opportunity','opportunity'),lines:[{service:ref('service_version','service'),quantity}],validUntil:'2026-12-01T00:00:00.000Z'});
  execute({type:'quote.approve',id:'quote',expectedStreamVersion:1},'manager');
  execute({type:'quote.record_acceptance',id:'quote',expectedStreamVersion:2,evidence:proof(ref('quote_version','quote'))},'manager');
  execute({type:'contract.create',id:'contract',quote:ref('quote_version','quote'),title:'服务合同'});
  execute({type:'contract.activate',id:'contract',expectedStreamVersion:1,evidence:proof(ref('contract','contract'))},'manager');
  execute({type:'order.create',id:'order',contract:ref('contract','contract'),lines:[{quoteLineId:'line-1',quantity}]});
  return execute({type:'order.activate',id:'order',expectedStreamVersion:1},'manager');
 };
 return {events,execute,ref,proof,order,state:()=>reduceBusinessEvents(events)};
}
