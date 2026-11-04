// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EnterpriseIdentityService, EnterprisePermissionService, type EnterpriseActor } from '@mn/enterprise-services';
import { FileCas, InMemoryKeyProvider, SqliteStorage, DEFAULT_PROJECTION_JOURNAL_NAMESPACES, type ContentAddressedStorage } from '@mn/storage';
import type { BusinessCommand } from '@mn/plugin-business';
import { createEnterpriseEventRepository } from '../../src/enterprise-event-repository.js';
import { EnterpriseBusinessService } from '../../src/enterprise-business.js';
export async function fixture(t: test.TestContext, runtime = false, memoryObjects = false, issuer = 'https://issuer.test/') {
  const root = await mkdtemp(join(tmpdir(), 'mn-enterprise-business-'));
  let clock = '2026-11-02T01:00:00.000Z'; const now = () => clock;
  const objects=new Map<string,{bytes:Buffer;created:Date}>();
  const cas:ContentAddressedStorage=memoryObjects?{async put(bytes){const digest=createHash('sha256').update(bytes).digest('hex'),created=!objects.has(digest);if(created)objects.set(digest,{bytes:Buffer.from(bytes),created:new Date()});return {digest,created,byteLength:bytes.byteLength};},async get(digest){const value=objects.get(digest);if(!value)throw new Error('CAS_OBJECT_NOT_FOUND');return Buffer.from(value.bytes);},async has(digest){return objects.has(digest);},async gcOrphans(refs,cutoff){const removed:string[]=[];for(const [digest,value]of objects)if(!refs.has(digest)&&value.created<cutoff){objects.delete(digest);removed.push(digest);}return removed;}}:new FileCas({ rootDir: join(root, 'cas') });
  const keyProvider = new InMemoryKeyProvider(randomBytes(32));
  const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite'), hmacKey: randomBytes(32), ...(runtime ? {now:()=>new Date(now()),projectionJournal:{cas,keyProvider,namespaces:DEFAULT_PROJECTION_JOURNAL_NAMESPACES}} : {}) });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const repository = createEnterpriseEventRepository({ store, cas, keyProvider, allowExecutionEvents:runtime });
  const identity = new EnterpriseIdentityService({ repository, now }), permissions = new EnterprisePermissionService({ repository, now });
  await identity.provision({ tenantId: 'tenant', name: '合成企业', issuer, maxMembers: 20,
    administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } });
  const admin = { tenantId: 'tenant', principalId: 'admin', sessionEpoch: 1 };
  const workspace = await identity.createWorkspace(admin, 'workspace', { name: '业务主体', mode: 'builtin' });
  for (const id of ['sales', 'manager', 'viewer', 'project', 'reviewer', 'finance-a', 'finance-b']) {
    const invitation = await identity.invite(admin, 'invite-'+id, { id, subject: id, displayName: id, organizationAdmin: false });
    await identity.acceptInvitation({ ...admin, principalId: id }, 'accept-'+id, id, 1, invitation.token);
  }
  for (const [id, role, fields, scope, operations] of [
    ['sales-own', 'sales', ['public','price','contact'], { kind: 'owned' }, ['read','draft','write']],
    ['sales-catalog', 'sales', ['public','price'], { kind: 'objects', objects: [{ objectType: 'service_version', objectId: 'service' }] }, ['read']],
    ['manager', 'sales_manager', ['public','price','contact'], { kind: 'workspace' }, ['read','write','business_approve']],
    ['viewer', 'sales', ['public'], { kind: 'workspace' }, ['read']],
  ] as const) await permissions.grantRole(admin, 'grant-'+id, { id, workspaceId: workspace.id, principalId: id.startsWith('sales-') ? 'sales' : id,
    role, fieldClasses: fields, scope, operations, expiresAt: '2027-01-01T00:00:00.000Z' });
  for(const id of ['project','reviewer','finance-a','finance-b']) await permissions.grantRole(admin,'grant-'+id,{id,workspaceId:workspace.id,principalId:id,role:id.startsWith('finance')?'finance':'project_owner',scope:{kind:'objects',objects:[{objectType:'order',objectId:'order'}]},operations:['read','write','business_approve'],fieldClasses:id.startsWith('finance')?['public','price','cost']:['public'],expiresAt:'2027-01-01T00:00:00.000Z'});
  const actor = (principalId: string): EnterpriseActor => ({ ...admin, principalId });
  const service = new EnterpriseBusinessService({ repository, now });
  let sequence = 0;
  const command = (command: BusinessCommand, principalId = 'sales', key = 'command-'+(++sequence)) => service.execute({ actor: actor(principalId), actorKind: 'human', workspaceId: workspace.id, idempotencyKey: key, command });
  const get = (type: string, id: string, principalId = 'sales') => service.get(actor(principalId), workspace.id, type, id);
  const base = async () => {
    const customer = await command({ type: 'customer.create', id: 'customer', name: '机密合成客户' });
    const opportunity = await command({ type: 'opportunity.create', id: 'opportunity', title: '需求', customer: customer.reference });
    const catalog = await command({ type: 'service.publish', id: 'service', serviceCode: 'consulting', title: '咨询', unit: '次', unitPriceMinor: 10000,
      scope: '需求评估', acceptanceCriteria: ['报告'], validFrom: now(), validUntil: '2027-01-01T00:00:00.000Z' }, 'manager');
    const quote = await command({ type: 'quote.prepare', id: 'quote', opportunity: opportunity.reference,
      lines: [{ service: catalog.reference, quantity: 3 }], validUntil: '2026-12-01T00:00:00.000Z' });
    return { customer, opportunity, catalog, quote };
  };
  const proof=async(type:string,id:string,person='sales')=>service.recordEvidence({actor:actor(person),actorKind:'human',workspaceId:workspace.id,idempotencyKey:'proof-'+(++sequence),subject:(await get(type,id,person)).reference,attestation:'合成事实已核对。',additionalFieldClasses:[]});
  const order=async()=>{await base();await command({type:'quote.approve',id:'quote',expectedStreamVersion:1},'manager');const quote=await command({type:'quote.record_acceptance',id:'quote',expectedStreamVersion:2,evidence:await proof('quote_version','quote')},'manager');await command({type:'contract.create',id:'contract',quote:quote.reference,title:'合同'});const contract=await command({type:'contract.activate',id:'contract',expectedStreamVersion:1,evidence:await proof('contract','contract')},'manager');await command({type:'order.create',id:'order',contract:contract.reference,lines:[{quoteLineId:'line-1',quantity:3}]});return command({type:'order.activate',id:'order',expectedStreamVersion:1},'manager');};
  return { store, cas, keyProvider, repository, permissions, identity, now, actor, admin, workspace, service, command, get, base, proof, order,
    newService: () => new EnterpriseBusinessService({ repository: createEnterpriseEventRepository({ store, cas, keyProvider, allowExecutionEvents:runtime }), now }), advance: (value: string) => { clock = value; } };
}
