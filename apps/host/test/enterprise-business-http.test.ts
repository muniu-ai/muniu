// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { createEnterpriseHost } from '../src/enterprise-host.js';
import { createEnterpriseEventRepository } from '../src/enterprise-event-repository.js';
import { createTestOidcIssuer } from './fixtures/enterprise-oidc-issuer.js';
const origin = 'https://business.example.test';
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mn-business-http-')), issuer = await createTestOidcIssuer();
  const databaseFile = join(root, 'state.sqlite'), hmacKey = randomBytes(32), cas = new FileCas({ rootDir: join(root,'objects') }), keyProvider = new InMemoryKeyProvider(randomBytes(32));
  let store = new SqliteStorage({ databaseFile, hmacKey });
  const create = () => createEnterpriseHost({ repository: createEnterpriseEventRepository({ store, cas, keyProvider }), origin, profile: 'development', providers: { tenant: { issuer: issuer.issuer, clientId: 'muniu-fixture' } } });
  let host = create();
  t.after(async () => { await host.close(); await store.close(); await issuer.close(); await rm(root,{recursive:true,force:true}); });
  await host.identity.provision({ tenantId:'tenant',name:'合成企业',issuer:issuer.issuer,maxMembers:20,administrator:{id:'admin',subject:'admin',displayName:'管理员'} });
  const admin = { tenantId:'tenant',principalId:'admin',sessionEpoch:1 };
  const workspace = await host.identity.createWorkspace(admin,'workspace',{name:'业务',mode:'builtin'});
  for (const id of ['sales','manager','reader']) {
    const invited = await host.identity.invite(admin,'invite-'+id,{id,subject:id,displayName:id,organizationAdmin:false});
    await host.identity.acceptInvitation({...admin,principalId:id},'accept-'+id,id,1,invited.token);
    await host.permissions.grantRole(admin,'role-'+id,{id:'role-'+id,workspaceId:workspace.id,principalId:id,role:id==='manager'?'sales_manager':'sales',scope:{kind:'workspace'},
      operations:id==='reader'?['read']:['read','write','business_approve'],fieldClasses:id==='reader'?['public']:['public','price','contact'],expiresAt:new Date(Date.now()+86400000).toISOString()});
  }
  const browsers = new Map<string,{cookie:string;csrf:string}>();
  for(const id of ['admin','sales','manager','reader']) {
    const start = await host.dispatch(new Request(origin+'/v2/auth/login?organizationId=tenant'));
    const loginCookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const callback = await host.dispatch(new Request(issuer.callback(start.headers.get('location')!,id),{headers:{cookie:loginCookie}}));
    assert.equal(callback.status,303);
    const cookie = callback.headers.getSetCookie().find(value=>value.startsWith('__Host-mn-enterprise-session='))!.split(';')[0]!;
    const session = await host.dispatch(new Request(origin+'/v2/auth/session',{headers:{cookie}}));
    browsers.set(id,{cookie,csrf:(await session.json() as any).data.csrfToken});
  }
  let sequence=0;
  const request = (path:string,actor='sales',body?:unknown,key='key-'+(++sequence)) => {
    const browser=browsers.get(actor)!;
    return host.dispatch(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{cookie:browser.cookie,origin,'content-type':'application/json','x-csrf-token':browser.csrf,'idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  };
  const ok = async(path:string,actor='sales',body?:unknown,key?:string) => {const response=await request(path,actor,body,key);assert.equal(response.status,200,await response.clone().text());return (await response.json() as any).data;};
  return { workspace, request, ok, commandPath:`/v2/workspaces/${workspace.id}/business/commands`,
    async restart(){await host.close();await store.close();store=new SqliteStorage({databaseFile,hmacKey});host=create();},
  };
}
test('浏览器业务链完成报价、客户接受、合同和订单，重启后保留事实与幂等结果',async t=>{
  const f=await fixture(t), prefix=`/v2/workspaces/${f.workspace.id}`, command=(value:unknown,actor='sales',key?:string)=>f.ok(f.commandPath,actor,value,key);
  const customer=await command({type:'customer.create',id:'customer',name:'合成客户'});
  const contact=await command({type:'contact.create',id:'contact',customer:customer.reference,name:'联系人',phone:'synthetic-contact'});
  const opportunity=await command({type:'opportunity.create',id:'opportunity',customer:customer.reference,title:'需求评估'});
  const service=await command({type:'service.publish',id:'service',serviceCode:'consulting',title:'咨询',unit:'次',unitPriceMinor:10000,scope:'评估需求',acceptanceCriteria:['报告'],validFrom:new Date(Date.now()-10000).toISOString(),validUntil:new Date(Date.now()+7*86400000).toISOString()},'manager');
  const prepared=await command({type:'quote.prepare',id:'quote',opportunity:opportunity.reference,lines:[{service:service.reference,quantity:3}],validUntil:new Date(Date.now()+86400000).toISOString()});
  assert.equal(prepared.values.totalMinor,30000);
  assert.equal((await f.request(f.commandPath,'sales',{type:'quote.approve',id:'quote',expectedStreamVersion:1})).status,403);
  const approvalCommand={type:'quote.approve',id:'quote',expectedStreamVersion:1};
  const approved=await command(approvalCommand,'manager','approve');
  const decision=await f.ok(prefix+'/business-approvals/'+approved.values.approvalId);
  assert.equal(decision.preparedByPrincipalId,'sales');assert.equal(decision.approvedByPrincipalId,'manager');
  assert.deepEqual(decision.subjectRef,prepared.reference);
  assert.equal((await f.request(f.commandPath,'manager',approvalCommand,'stale')).status,409);
  const proof=(subject:unknown,key:string)=>f.ok(prefix+'/business-evidence','sales',{subject,attestation:'已核对合成客户签署材料。',additionalFieldClasses:[]},key);
  const accepted=await command({type:'quote.record_acceptance',id:'quote',expectedStreamVersion:2,evidence:await proof(approved.reference,'acceptance')},'manager');
  const contract=await command({type:'contract.create',id:'contract',quote:accepted.reference,title:'服务合同'});
  const signed=await command({type:'contract.activate',id:'contract',expectedStreamVersion:1,evidence:await proof(contract.reference,'signature')},'manager');
  await command({type:'order.create',id:'order',contract:signed.reference,lines:[{quoteLineId:'line-1',quantity:3}]});
  const order=await command({type:'order.activate',id:'order',expectedStreamVersion:1},'manager');
  assert.equal(order.values.status,'active');assert.equal(order.values.totalMinor,30000);
  const deliveryScope=await f.ok(prefix+'/business/order/order','reader');
  assert.equal(deliveryScope.values.scopeLines[0].scope,'评估需求');
  assert.doesNotMatch(JSON.stringify(deliveryScope.values.scopeLines),/unitPriceMinor|totalMinor/);
  assert.equal((await f.ok(prefix+'/business/quote_version/quote','reader')).values.totalMinor,undefined);
  assert.equal((await f.ok(prefix+'/business/contact/contact','reader')).values.phone,undefined);
  assert.equal((await f.request(prefix+'/business/order/order','admin')).status,403);
  assert.equal((await f.request('/v2/workspaces/foreign/business/order/order')).status,404);
  assert.equal((await f.request(f.commandPath,'sales',{type:'customer.create',id:'forged',name:'伪造',tenantId:'foreign'})).status,400);
  await f.restart();
  assert.deepEqual(await f.ok(prefix+'/business/order/order'),order);
  assert.deepEqual(await command(approvalCommand,'manager','approve'),approved);
  assert.equal((await f.ok(prefix+'/business/quote_version/quote/versions/1')).values.status,'draft');
  assert.equal((await f.ok(prefix+'/business/contact/contact')).values.phone,contact.values.phone);
  assert.equal((await f.ok(prefix+'/business/order')).length,1);
});

test('业务命令拒绝无法安全寻址的对象标识与空名称',async t=>{
 const f=await fixture(t);
 for(const id of ['.','..','bad\u0000id']) assert.equal((await f.request(f.commandPath,'sales',{type:'customer.create',id,name:'合成客户'})).status,400);
 assert.equal((await f.request(f.commandPath,'sales',{type:'customer.create',id:'blank',name:'   '})).status,400);
});
