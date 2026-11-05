// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EnterpriseContractTypes as Types, ProviderBinding } from '@mn/contracts';
import { InMemoryKeyProvider } from '@mn/storage';
import { fixture } from './fixtures/business.js';
import { createTestOidcIssuer } from './fixtures/enterprise-oidc-issuer.js';
import { createEnterpriseHost } from '../src/enterprise-host.js';
import { startEnterpriseLocalHost } from '../src/enterprise-local.js';
import { EnterpriseExecutionRuntime } from '../src/enterprise-execution-runtime.js';
import { EnterpriseProviderService } from '../src/enterprise-provider-service.js';

async function data<T>(response: Response, status = 200): Promise<T> {
  const result = await response.json() as { data: T; code?: string };
  assert.equal(response.status, status, result.code);
  return result.data;
}
async function browser(host: Pick<ReturnType<typeof createEnterpriseHost>, 'dispatch'>, issuer: Awaited<ReturnType<typeof createTestOidcIssuer>>, origin: string, person: string, tenant = 'tenant') {
  const start = await host.dispatch(new Request(origin + '/v2/auth/login?organizationId=' + tenant));
  assert.equal(start.status, 302);
  const callback = await host.dispatch(new Request(issuer.callback(start.headers.get('location')!, person), { headers: { cookie: start.headers.getSetCookie()[0]!.split(';')[0]! } }));
  assert.equal(callback.status, 303);
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-mn-enterprise-session='))!.split(';')[0]!;
  const session = await data<Types['EnterpriseSessionView']>(await host.dispatch(new Request(origin + '/v2/auth/session', { headers: { cookie } })));
  let sequence = 0;
  return (path: string, input?: unknown, key = person + '-request-' + (++sequence), csrf = session.csrfToken) => host.dispatch(new Request(origin + path, {
    method: input === undefined ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': key },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }));
}

test('提供方 HTTP 按当前身份读取快照、增量与报价预览，人工动作经过已有批准和执行接口', async t => {
  const issuer = await createTestOidcIssuer(); t.after(() => issuer.close());
  const f = await fixture(t, true, true, issuer.issuer), base = await f.base(), origin = 'https://providers.example.test';
  let businessProviders: EnterpriseProviderService;
  const executionRuntime = new EnterpriseExecutionRuntime({ store: f.store, repository: f.repository, now: f.now,
    resolveProvider: (tenant, workspace, id) => businessProviders.resolveRuntime(tenant, workspace, id), usageForReceipt: () => ({ tokens: 0, costMinorUnits: '0', currency: 'CNY' }) });
  businessProviders = new EnterpriseProviderService({ store: f.store, repository: f.repository, execution: executionRuntime, protection: { cas: f.cas, keyProvider: f.keyProvider }, now: f.now });
  const options = { repository: f.repository, origin, profile: 'development' as const, providers: { tenant: { issuer: issuer.issuer, clientId: 'muniu-fixture' } }, now: f.now, executionRuntime, businessProviders };
  const host = createEnterpriseHost(options); t.after(() => host.close());
  const sales = await browser(host, issuer, origin, 'sales'), admin = await browser(host, issuer, origin, 'admin');
  const manager = await browser(host, issuer, origin, 'manager'), viewer = await browser(host, issuer, origin, 'viewer');
  const workspacePath = '/v2/workspaces/' + f.workspace.id, path = workspacePath + '/providers';
  assert.equal((await sales(path + '/initializations', { expectedStreamVersion: 0 })).status, 403);
  assert.equal((await admin(path + '/initializations', { expectedStreamVersion: 0 }, '')).status, 400);
  const binding = await data<ProviderBinding>(await admin(path + '/initializations', { expectedStreamVersion: 0 }, 'initialize'));
  assert.equal(binding.streamVersion, 1);
  assert.deepEqual(await data(await admin(path + '/initializations', { expectedStreamVersion: 0 }, 'initialize')), binding);
  assert.equal((await admin(path + '/initializations', { expectedStreamVersion: 0 }, 'stale')).status, 409);
  assert.equal((await sales(path + '/snapshots', base.quote.reference, 'snapshot', 'bad')).status, 403);
  const snapshot = await data<Types['EnterpriseProviderSnapshot']>(await sales(path + '/snapshots', base.quote.reference));
  const content = await data<Types['EnterpriseBusinessObjectView']>(await sales(path + '/content/reads', { reference: snapshot.protectedContentRef }));
  assert.equal(content.values.totalMinor, 30000);
  assert.equal((await viewer(path + '/content/reads', { reference: snapshot.protectedContentRef })).status, 404);
  const visible = await data<Types['EnterpriseProviderSnapshot']>(await viewer(path + '/snapshots', base.quote.reference));
  assert.equal((await data<Types['EnterpriseBusinessObjectView']>(await viewer(path + '/content/reads', { reference: visible.protectedContentRef }))).values.totalMinor, undefined);
  assert.equal((await sales(path + '/snapshots', { ...base.quote.reference, tenantId: 'another' })).status, 403);
  assert.equal((await sales(path + '/snapshots', { ...base.quote.reference, principalId: 'admin' })).status, 400);
  const changes = await data<Types['EnterpriseProviderChanges']>(await sales(path + '/changes', { cursor: null }));
  assert.ok(changes.changes.length > 0);
  assert.equal((await data<Types['EnterpriseProviderChanges']>(await sales(path + '/changes', { cursor: changes.nextCursor }))).changes.length, 0);
  assert.equal((await viewer(path + '/changes', { cursor: changes.nextCursor })).status, 409);
  await data(await admin(workspacePath + '/execution-settings', { expectedStreamVersion: 0, responsibilities: [{ id: 'sales', capabilities: ['update_followup_date', 'issue_quote_package'], fieldClasses: ['public', 'price'] }] }));
  await f.permissions.grantRole(f.admin, 'execution', { id: 'execution', workspaceId: f.workspace.id, principalId: 'manager', role: 'sales_manager', scope: { kind: 'workspace' }, operations: ['read', 'execution_approve'], fieldClasses: ['public', 'price'], expiresAt: '2027-01-01T00:00:00.000Z' });
  const quote = await f.command({ type: 'quote.approve', id: 'quote', expectedStreamVersion: 1 }, 'manager');
  const packageAction = await data<Types['EnterpriseActionView']>(await sales(path + '/actions', { target: quote.reference, responsibilityId: 'sales', action: 'issue_quote_package', businessApprovalRef: String(quote.values.approvalId), expiresAt: '2026-11-02T02:00:00.000Z', input: { format: 'docx' } }));
  const packagePreview = await data<Types['EnterpriseProviderActionPreview']>(await sales('/v2/actions/' + encodeURIComponent(packageAction.action.id) + '/preview'));
  const packageContent = await data<Types['EnterpriseProviderPackageContent']>(await sales(path + '/packages/reads', { reference: packagePreview.document!.protectedContentRef }));
  assert.equal(packageContent.official, false); assert.ok(Buffer.from(packageContent.bytesBase64, 'base64').length > 100);
  const input = { target: base.customer.reference, responsibilityId: 'sales', action: 'update_followup_date', expiresAt: '2026-11-02T02:00:00.000Z', input: { nextFollowupAt: '2026-11-06T00:00:00.000Z' } };
  assert.equal((await sales(path + '/actions', input, '')).status, 400);
  assert.equal((await sales(path + '/actions', { ...input, principalId: 'admin' })).status, 400);
  const pending = await data<Types['EnterpriseActionView']>(await sales(path + '/actions', input, 'action'));
  assert.equal(pending.action.status, 'awaiting_approval');
  assert.equal((await data<Types['EnterpriseActionView']>(await sales(path + '/actions', input, 'action'))).action.id, pending.action.id);
  assert.equal((await sales(path + '/actions', { ...input, input: { nextFollowupAt: '2026-11-07T00:00:00.000Z' } }, 'action')).status, 409);
  const actionPath = '/v2/actions/' + encodeURIComponent(pending.action.id);
  const preview = await data<Types['EnterpriseProviderActionPreview']>(await manager(actionPath + '/preview'));
  assert.equal(preview.request.action, 'update_followup_date');
  assert.equal((await f.get('customer', 'customer')).values.nextFollowupAt, undefined);
  const decision = { expectedStreamVersion: pending.approval!.streamVersion, actionDigest: pending.approval!.actionDigest, decision: 'approve_once' };
  assert.equal((await sales('/v2/approvals/' + encodeURIComponent(pending.approval!.id) + '/decisions', decision)).status, 403);
  await data(await manager('/v2/approvals/' + encodeURIComponent(pending.approval!.id) + '/decisions', decision));
  const worker = executionRuntime.createWorker({ id: 'http-provider-worker', jobs: f.store, lock: { engineLockDigest: 'fixture', expectedEngineLockDigest: 'fixture', pluginLockDigest: 'fixture', expectedPluginLockDigest: 'fixture' } });
  assert.equal((await worker.pollOnce()).status, 'completed');
  const settled = await data<Types['EnterpriseActionView']>(await sales(actionPath));
  assert.equal(settled.action.status, 'settled'); assert.equal(settled.receipt!.status, 'succeeded');
  assert.ok(settled.receipt?.status === 'succeeded');
  const receiptReference = settled.receipt.evidenceRefs[0]!.protectedContentRef;
  const receiptEvidence = await data<Types['EnterpriseProviderReceiptEvidence']>(await sales(path + '/receipts/reads', { reference: receiptReference }));
  assert.equal(receiptEvidence.receipt.operationKey, settled.receipt.operationKey);
  assert.deepEqual(receiptEvidence.target, pending.action.target);
  assert.deepEqual(receiptEvidence.result, (await f.get('customer', 'customer')).reference);
  assert.equal((await f.get('customer', 'customer')).values.nextFollowupAt, input.input.nextFollowupAt);
  const settledReplay = await data<Types['EnterpriseActionView']>(await sales(path + '/actions', input, 'action'));
  assert.equal(settledReplay.action.id, pending.action.id); assert.equal(settledReplay.action.status, 'settled');
  assert.equal((await f.get('customer', 'customer')).reference.streamVersion, 2);
  await f.permissions.revoke(f.admin, 'revoke-sales', 'role', 'sales-own', 1);
  assert.equal((await sales(path + '/content/reads', { reference: snapshot.protectedContentRef })).status, 403);
  assert.equal((await sales(path + '/changes', { cursor: changes.nextCursor })).status, 409);
  assert.equal((await sales(path + '/packages/reads', { reference: packagePreview.document!.protectedContentRef })).status, 403);
  assert.equal((await sales(path + '/receipts/reads', { reference: receiptReference })).status, 403);
});

test('本地入口在新工作区初始化绑定，现有串行 Worker 执行内置动作，Sales 端口保持不可用', async t => {
  const issuer = await createTestOidcIssuer(); t.after(() => issuer.close());
  const root = await mkdtemp(join(tmpdir(), 'mn-enterprise-providers-http-')); t.after(() => rm(root, { recursive: true, force: true }));
  const origin = 'https://local-providers.example.test', now = () => '2026-11-02T01:00:00.000Z';
  const host = await startEnterpriseLocalHost({ stateRoot: join(root, 'fresh'), origin, profile: 'development', port: 0, now,
    keys: { hmacKey: randomBytes(32), keyProvider: new InMemoryKeyProvider(randomBytes(32)) },
    providers: Object.fromEntries(['tenant', 'sales-tenant'].map(id => [id, { issuer: issuer.issuer, clientId: 'muniu-fixture' }])),
    organizations: ['tenant', 'sales-tenant'].map(tenantId => ({ tenantId, name: '合成企业', issuer: issuer.issuer, maxMembers: 5, administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } })),
  }); t.after(() => host.close());
  const adminActor = { tenantId: 'tenant', principalId: 'admin', sessionEpoch: 1 }, admin = await browser(host, issuer, origin, 'admin');
  const workspace = await data<Types['EnterpriseWorkspaceView']>(await admin('/v2/workspaces', { name: '内置工作区', mode: 'builtin' }, 'workspace'), 201);
  await data(await admin('/v2/workspaces', { name: '内置工作区', mode: 'builtin' }, 'workspace'), 201);
  const prefix = '/v2/workspaces/' + workspace.id;
  const configuration = await data<Types['EnterpriseExecutionConfiguration']>(await admin(prefix + '/execution-configuration'));
  assert.equal(configuration.binding!.streamVersion, 1);
  assert.ok(configuration.binding!.bindings.every(b => b.provider === 'builtin'));
  for (const person of ['sales', 'manager']) {
    const invitation = await host.identity.invite(adminActor, 'invite-' + person, { id: person, subject: person, displayName: person, organizationAdmin: false });
    await host.identity.acceptInvitation({ ...adminActor, principalId: person }, 'accept-' + person, person, 1, invitation.token);
    await host.permissions.grantRole(adminActor, 'grant-' + person, { id: person, workspaceId: workspace.id, principalId: person, role: person === 'sales' ? 'sales' : 'sales_manager', scope: { kind: 'workspace' }, operations: person === 'sales' ? ['read', 'write'] : ['read', 'execution_approve'], fieldClasses: ['public'], expiresAt: '2027-01-01T00:00:00.000Z' });
  }
  const sales = await browser(host, issuer, origin, 'sales'), manager = await browser(host, issuer, origin, 'manager');
  await data(await admin(prefix + '/execution-settings', { expectedStreamVersion: 0, responsibilities: [{ id: 'followup', capabilities: ['update_followup_date'], fieldClasses: ['public'] }] }));
  const customer = await data<Types['EnterpriseBusinessObjectView']>(await sales(prefix + '/business/commands', { type: 'customer.create', id: 'customer', name: '合成客户' }));
  const pending = await data<Types['EnterpriseActionView']>(await sales(prefix + '/providers/actions', { target: customer.reference, responsibilityId: 'followup', action: 'update_followup_date', expiresAt: '2026-11-02T02:00:00.000Z', input: { nextFollowupAt: '2026-11-06T00:00:00.000Z' } }));
  await data(await manager('/v2/approvals/' + encodeURIComponent(pending.approval!.id) + '/decisions', { expectedStreamVersion: pending.approval!.streamVersion, actionDigest: pending.approval!.actionDigest, decision: 'approve_once' }));
  await host.runOperatingCycle();
  const completed = await data<Types['EnterpriseActionView']>(await sales('/v2/actions/' + encodeURIComponent(pending.action.id)));
  const jobs = await host.executionRuntime!.bridge.store.transact('tenant', tx => tx.listProjections<{ kind: string; status: string; attempts: number; failure?: { code?: string; message?: string } }>('job').map(job => ({ kind: job.kind, status: job.status, attempts: job.attempts, failureCode: job.failure?.code, ...(job.failure?.message && /^[A-Z_]+$/u.test(job.failure.message) ? { reasonCode: job.failure.message } : {}) })));
  assert.equal(completed.action.status, 'settled', JSON.stringify({ executionStatus: completed.executionStatus, jobs })); assert.equal(completed.receipt!.status, 'succeeded');
  assert.equal((await data<Types['EnterpriseBusinessObjectView']>(await sales(prefix + '/business/customer/customer'))).values.nextFollowupAt, '2026-11-06T00:00:00.000Z');
  const salesAdmin = await browser(host, issuer, origin, 'admin', 'sales-tenant');
  const connected = await data<Types['EnterpriseWorkspaceView']>(await salesAdmin('/v2/workspaces', { name: 'Sales 工作区', mode: 'sales' }), 201), connectedPath = '/v2/workspaces/' + connected.id;
  const salesBinding = (await data<Types['EnterpriseExecutionConfiguration']>(await salesAdmin(connectedPath + '/execution-configuration'))).binding!;
  assert.equal(salesBinding.mode, 'sales'); assert.ok(salesBinding.bindings.every(b => b.supportedPorts.length === 0));
  const unavailable = await salesAdmin(connectedPath + '/providers/changes', { cursor: null });
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json() as { code: string }).code, 'PROVIDER_CONNECTION_UNCONFIGURED');
});
