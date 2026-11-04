// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { businessFixture } from './fixtures/business.js';
import { projectProgress } from '../src/fulfillment-queries.js';
const prepare=(f:ReturnType<typeof businessFixture>,quantity:number)=>{
 f.execute({type:'change_request.prepare',id:'change',project:f.ref('project','project'),description:'调整承诺'},'project-owner');
 f.execute({type:'change_request.price',id:'change',expectedStreamVersion:1,lines:[{orderLineId:'line-1',quantity}]},'maker');
 f.execute({type:'change_request.approve',id:'change',expectedStreamVersion:2,evidence:f.proof(f.ref('change_request','change'))},'manager');
};
test('缩减范围可移除未交付里程碑，保留未改动里程碑及其版本',()=>{
 const f=businessFixture();f.order();f.execute({type:'project.create',id:'project',order:f.ref('order','order'),title:'项目'},'project-owner');
 for(const [id,quantity] of [['keep',6],['remove',4]] as const)f.execute({type:'milestone.create',id,project:f.ref('project','project'),title:id,dueDate:'2026-11-30',lines:[{lineId:'line-1',quantity}]},'project-owner');
 const kept=f.ref('milestone','keep');prepare(f,6);
 f.execute({type:'change_request.project_confirm',id:'change',expectedStreamVersion:3,milestones:[{milestone:f.ref('milestone','remove'),expectedStreamVersion:1,lines:[]}]},'project-owner');
 assert.deepEqual(f.ref('milestone','keep'),kept);assert.equal(f.state().objects.get('milestone:remove')!.value.status,'removed');assert.equal(projectProgress(f.state(),'project').lines[0]!.promised,6);
 assert.throws(()=>f.execute({type:'delivery.report',id:'bad',milestone:f.ref('milestone','remove'),summary:'已移除阶段',lines:[{lineId:'line-1',quantity:1}]},'project-owner'),{code:'DELIVERY_QUANTITY_EXCEEDED'});
});
test('项目超过一百个里程碑时也可确认范围，无须改写所有未变化的里程碑',()=>{
 const f=businessFixture();f.order(101);f.execute({type:'project.create',id:'project',order:f.ref('order','order'),title:'大项目'},'project-owner');
 for(let i=0;i<101;i++)f.execute({type:'milestone.create',id:'m-'+i,project:f.ref('project','project'),title:'阶段',dueDate:'2026-11-30',lines:[{lineId:'line-1',quantity:1}]},'project-owner');
 prepare(f,102);f.execute({type:'change_request.project_confirm',id:'change',expectedStreamVersion:3,milestones:[]},'project-owner');assert.equal(projectProgress(f.state(),'project').status,'active');assert.equal(f.ref('milestone','m-100').streamVersion,1);
});
