// SPDX-License-Identifier: Apache-2.0
import { verifyFulfillment } from './lib/enterprise-fulfillment-fixture.mjs';
import { waitForFixturePort } from './lib/fixture-network.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EnterpriseIdentityService, EnterprisePermissionService, EnterpriseQuotaService } from '@mn/enterprise-services';
import { FileCas, InMemoryKeyProvider } from '@mn/storage';
import { EnterpriseBusinessService } from '../apps/host/dist/enterprise-business.js';
import { createEnterpriseEventRepository } from '../apps/host/dist/enterprise-event-repository.js';
import { PostgresKernelStore } from './lib/postgres-kernel-store.mjs';
import { createPostgresPool } from './lib/postgres-pool.mjs';
const execute = promisify(execFile), name = `mn-enterprise-business-${randomUUID()}`;
const root = await mkdtemp(join(tmpdir(), 'mn-enterprise-business-'));
const docker = async (...args) => (await execute('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim();
let container; const pools = [];
try {
  container = await docker('run', '--detach', '--name', name, '--label', 'com.muniu.fixture=enterprise-business',
    '--memory', '192m', '--cpus', '0.5', '--tmpfs', '/var/lib/postgresql/data:rw,size=256m',
    '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=mn', '-e', 'POSTGRES_PASSWORD=synthetic-only', '-e', 'POSTGRES_DB=enterprise_fixture', 'postgres:16-alpine');
  const address = await waitForFixturePort(() => docker('port', container, '5432/tcp'));
  assert.match(address, /^127\.0\.0\.1:\d+$/u);
  const connectionString = `postgres://mn:synthetic-only@${address}/enterprise_fixture`;
  const makePool = () => { const pool = createPostgresPool({ connectionString, max: 2 }); pools.push(pool); return pool; };
  const firstPool = makePool(); let ready = false, connectionFailure;
  for (let i = 0; i < 60; i++) { try { await firstPool.query('select 1'); ready = true; break; } catch (error) { connectionFailure = error.code ?? error.name; await delay(1000); } }
  if (!ready) { process.stderr.write(`PostgreSQL readiness: ${connectionFailure}\n`); process.stderr.write(await docker('logs', container)); }
  assert.ok(ready, 'Disposable PostgreSQL did not become ready');
  // A sentinel in the disposable database proves that new code never initializes or updates the legacy namespace.
  await firstPool.query("create schema mn_v2; create table mn_v2.sentinel (value text); insert into mn_v2.sentinel values ('untouched')");
  const hmacKey = randomBytes(32), keyProvider = new InMemoryKeyProvider(randomBytes(32)), cas = new FileCas({ rootDir: join(root, 'cas') });
  const make = async pool => {
    const store = new PostgresKernelStore({ pool, hmacKey, namespace: 'mn_enterprise_v1' }); await store.initialize();
    const repository = createEnterpriseEventRepository({ store, cas, keyProvider });
    return { store, identity: new EnterpriseIdentityService({ repository }), permissions: new EnterprisePermissionService({ repository }), quotas: new EnterpriseQuotaService({ repository }), business: new EnterpriseBusinessService({ repository }) };
  };
  const a = await make(firstPool), b = await make(makePool());
  await a.identity.provision({ tenantId: 'tenant-a', name: '受保护合成企业', issuer: 'https://issuer.test/', maxMembers: 20,
    administrator: { id: 'admin', subject: 'protected-admin-subject', displayName: '管理员' } });
  const actor = { tenantId: 'tenant-a', principalId: 'admin', sessionEpoch: 1 };
  const workspace = await a.identity.createWorkspace(actor, 'workspace', { name: '主体', mode: 'builtin' });
  for (const id of ['sales','manager']) {
    const invite=await a.identity.invite(actor,'invite-'+id,{id,subject:id,displayName:id,organizationAdmin:false});
    await a.identity.acceptInvitation({...actor,principalId:id},'accept-'+id,id,1,invite.token);
    await a.permissions.grantRole(actor,'role-'+id,{id:'role-'+id,workspaceId:workspace.id,principalId:id,role:id==='sales'?'sales':'sales_manager',scope:{kind:'workspace'},
      operations:['read','write','business_approve'],fieldClasses:['public','price','contact'],expiresAt:new Date(Date.now()+86400000).toISOString()});
  }
  let sequence=0;
  const command=(service,body,person='sales',idempotencyKey='command-'+(++sequence))=>service.execute({actor:{...actor,principalId:person},actorKind:'human',workspaceId:workspace.id,idempotencyKey,command:body});
  const customer=await command(a.business,{type:'customer.create',id:'customer',name:'受保护合成客户'});
  const opportunity=await command(a.business,{type:'opportunity.create',id:'opportunity',customer:customer.reference,title:'需求'});
  const catalog=await command(a.business,{type:'service.publish',id:'service',serviceCode:'consulting',title:'咨询',unit:'次',unitPriceMinor:10000,scope:'评估需求',acceptanceCriteria:['报告'],validFrom:new Date(Date.now()-10000).toISOString(),validUntil:new Date(Date.now()+7*86400000).toISOString()},'manager');
  const prepared=await command(a.business,{type:'quote.prepare',id:'quote',opportunity:opportunity.reference,lines:[{service:catalog.reference,quantity:3}],validUntil:new Date(Date.now()+86400000).toISOString()});
  await assert.rejects(command(a.business,{type:'quote.approve',id:'quote',expectedStreamVersion:1}),{code:'OBJECT_ACCESS_DENIED'});
  const quoted=await command(a.business,{type:'quote.approve',id:'quote',expectedStreamVersion:1},'manager');
  const evidence=(subject,idempotencyKey)=>a.business.recordEvidence({actor:{...actor,principalId:'sales'},actorKind:'human',workspaceId:workspace.id,subject,idempotencyKey,attestation:'合成核对说明',additionalFieldClasses:[]});
  const accepted=await command(a.business,{type:'quote.record_acceptance',id:'quote',expectedStreamVersion:2,evidence:await evidence(quoted.reference,'customer-accepted')},'manager');
  const contract=await command(a.business,{type:'contract.create',id:'contract',quote:accepted.reference,title:'合成合同'});
  const active=await command(a.business,{type:'contract.activate',id:'contract',expectedStreamVersion:1,evidence:await evidence(contract.reference,'signed')},'manager');
  for(const id of ['order-a','order-b'])await command(a.business,{type:'order.create',id,contract:active.reference,lines:[{quoteLineId:'line-1',quantity:3}]});
  const outcomes=await Promise.allSettled([a.business,b.business].map((service,index)=>command(service,{type:'order.activate',id:index?'order-b':'order-a',expectedStreamVersion:1},'manager','activate-'+index)));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(outcomes.find(result=>result.status==='rejected').reason.code,'CONTRACT_ALLOCATION_EXCEEDED');
  const restarted=await make(makePool());
  const orders=await restarted.business.list({...actor,principalId:'manager'},workspace.id,'order');
  assert.equal(orders.filter(order=>order.values.status==='active').reduce((sum,order)=>sum+order.values.totalMinor,0),30000);
  await verifyFulfillment({a,b:restarted,actor,workspace,command,order:orders.find(order=>order.values.status==='active')});
  const original=await restarted.business.get({...actor,principalId:'sales'},workspace.id,'quote_version','quote',1);
  assert.deepEqual(original,prepared);
  const raw=await firstPool.query('select public_payload::text, protected_payload_ref from mn_enterprise_v1.events');
  assert.doesNotMatch(JSON.stringify(raw.rows),/受保护合成客户|unitPriceMinor|attestation|revisionSalt/u);
  assert.deepEqual((await firstPool.query('select value from mn_v2.sentinel')).rows,[{value:'untouched'}]);
  const interrupted=await firstPool.connect();
  assert.ok(interrupted.listenerCount('error')>0,'checked-out client must retain an error listener');
  const disconnected=new Promise(resolve=>interrupted.once('error',resolve));
  await interrupted.query('begin');
  const pid=(await interrupted.query('select pg_backend_pid() as pid')).rows[0].pid;
  await firstPool.query('select pg_terminate_backend($1)',[pid]);
  await disconnected;
  await assert.rejects(interrupted.query('commit'));
  interrupted.release(true);
  assert.equal((await firstPool.query('select 1 as value')).rows[0].value,1);
  process.stdout.write('企业业务 PostgreSQL 验收通过：报价到订单、独立批准、并发额度竞争、历史重放和密文事实。\n');
} catch (error) {
  if (container) {
    process.stderr.write(await docker('inspect', '--format', '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}', container));
    const logs = await execute('docker', ['logs', container], { maxBuffer: 1024 * 1024 });
    process.stderr.write(logs.stdout + logs.stderr);
  }
  throw error;
} finally {
  await Promise.allSettled(pools.map(pool => pool.end()));
  if (container) await docker('rm', '--force', container);
  await rm(root, { recursive: true, force: true });
}
