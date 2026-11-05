// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { InMemoryKeyProvider } from '@mn/storage';
import { startEnterpriseLocalHost } from '../../apps/host/dist/enterprise-local.js';
import { EnterpriseBusinessService } from '../../apps/host/dist/enterprise-business.js';
import { createTestOidcIssuer } from '../../apps/host/dist-test/test/fixtures/enterprise-oidc-issuer.js';

const ACCOUNTS = Object.freeze([
  { id: 'admin', label: '组织管理员（合成）' }, { id: 'sales', label: '销售（合成）' },
  { id: 'manager', label: '经理（合成）' }, { id: 'finance', label: '财务（合成）' }, { id: 'reader', label: '只读成员（合成）' },
  { id: 'project-maker', label: '项目制单人（合成）' },
]);
const INVITEE = Object.freeze({ id: 'invitee', label: '待邀请成员（合成）' });
async function unusedLoopbackPort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('FIXTURE_PORT_UNAVAILABLE');
  return address.port;
}

export async function startEnterpriseWebFixture({ webRoot, mode = 'seeded' } = {}) {
  if (typeof webRoot !== 'string' || !isAbsolute(webRoot) || !['seeded', 'empty', 'uninitialized'].includes(mode)) throw new Error('FIXTURE_OPTIONS_INVALID');
  const root = await mkdtemp(join(tmpdir(), 'mn-e61-web-')), stateRoot = join(root, 'state');
  const tenantId = 'enterprise-web-fixture', now = () => new Date().toISOString();
  let host, issuer, closing, closed = false;
  const close = () => closing ??= (async () => {
    closed = true;
    try { await host?.close(); }
    finally { try { await issuer?.close(); } finally { await rm(root, { recursive: true, force: true }); } }
  })();
  try {
    const port = await unusedLoopbackPort(), origin = 'http://127.0.0.1:' + port;
    issuer = await createTestOidcIssuer({ browser: { accounts: [...ACCOUNTS, INVITEE].map(account => ({ subject: account.id, label: account.label })), redirectUris: [origin + '/v2/auth/callback'] } });
    host = await startEnterpriseLocalHost({ origin, profile: 'development', port, host: '127.0.0.1', stateRoot, webRoot, now,
      operatingBackground: false, keys: { hmacKey: randomBytes(32), keyProvider: new InMemoryKeyProvider(randomBytes(32)) },
      providers: { [tenantId]: { issuer: issuer.issuer, clientId: 'muniu-fixture' } }, loginOrganizations: [{ id: tenantId, name: '木牛合成验收企业' }],
      organizations: [{ tenantId, name: '木牛合成验收企业', issuer: issuer.issuer, maxMembers: 10, administrator: { id: 'admin', subject: 'admin', displayName: ACCOUNTS[0].label } }],
    });
    const actor = id => ({ tenantId, principalId: id, sessionEpoch: 1 }), admin = actor('admin');
    for (const account of ACCOUNTS.filter(account => account.id !== 'admin')) {
      const invitation = await host.identity.invite(admin, 'invite-' + account.id, { id: account.id, subject: account.id, displayName: account.label, organizationAdmin: false });
      await host.identity.acceptInvitation(actor(account.id), 'accept-' + account.id, account.id, invitation.member.streamVersion, invitation.token);
    }
    const workspace = mode === 'uninitialized' ? undefined : await host.identity.createWorkspace(admin, 'workspace', { name: '合成经营主体', mode: 'builtin' });
    const grants = new Map(ACCOUNTS.map(account => [account.id, []]));
    if (workspace) {
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      for (const [id, principalId, role, scope, operations, fieldClasses] of [
        ['sales-own', 'sales', 'sales', { kind: 'owned' }, ['read', 'draft', 'write'], ['public', 'price', 'contact']],
        ['sales-catalog', 'sales', 'sales', { kind: 'objects', objects: [{ objectType: 'service_version', objectId: 'service' }] }, ['read'], ['public', 'price']],
        ['manager-sales', 'manager', 'sales_manager', { kind: 'workspace' }, ['read', 'write', 'business_approve'], ['public', 'price', 'contact']],
        ['manager-project', 'manager', 'project_owner', { kind: 'workspace' }, ['read', 'write', 'business_approve'], ['public']],
        ['manager-finance', 'manager', 'finance', { kind: 'workspace' }, ['read', 'write', 'business_approve'], ['public', 'price', 'cost']],
        ['project-maker-delivery', 'project-maker', 'project_owner', { kind: 'workspace' }, ['read', 'write', 'business_approve'], ['public']],
        ['project-maker-commercial', 'project-maker', 'sales_manager', { kind: 'workspace' }, ['read', 'write'], ['public', 'price']],
        ['finance', 'finance', 'finance', { kind: 'workspace' }, ['read', 'write', 'business_approve'], ['public', 'price', 'cost']],
        ['reader', 'reader', 'sales', { kind: 'workspace' }, ['read'], ['public']],
      ]) {
        const granted = await host.permissions.grantRole(admin, 'grant-' + id, { id, workspaceId: workspace.id, principalId, role, scope, operations, fieldClasses, expiresAt });
        grants.get(principalId).push(granted);
      }
    }
    const business = new EnterpriseBusinessService({ repository: host.executionRuntime.options.repository, now });
    let sequence = 0;
    const command = (value, person = 'sales') => {
      if (!workspace) throw new Error('FIXTURE_DATA_REQUIRED');
      return business.execute({ actor: actor(person), actorKind: 'human', workspaceId: workspace.id, idempotencyKey: 'fixture-command-' + (++sequence), command: value });
    };
    const proof = async (type, id, person) => business.recordEvidence({ actor: actor(person), actorKind: 'human', workspaceId: workspace.id,
      idempotencyKey: 'fixture-evidence-' + (++sequence), subject: (await business.get(actor(person), workspace.id, type, id)).reference,
      attestation: '已核对合成验收事实，仅供本地测试。', additionalFieldClasses: [] });
    const references = {};
    if (mode === 'seeded') {
      const validFrom = now(), validUntil = new Date(Date.now() + 90 * 86400000).toISOString(), quoteUntil = new Date(Date.now() + 30 * 86400000).toISOString();
      const customer = await command({ type: 'customer.create', id: 'customer', name: '合成客户 · 明川项目' });
      references.customer = customer.reference;
      references.versionCustomer = (await command({ type: 'customer.create', id: 'version-customer', name: '合成客户 · 版本核对' })).reference;
      references.contact = (await command({ type: 'contact.create', id: 'contact', customer: customer.reference, name: '合成联系人', email: 'fixture@example.invalid', phone: 'synthetic-contact-only' })).reference;
      references.emptyContact = (await command({ type: 'contact.create', id: 'empty-contact', customer: customer.reference, name: '合成联系人 · 尚未填写' })).reference;
      const opportunity = await command({ type: 'opportunity.create', id: 'opportunity', customer: customer.reference, title: '合成咨询需求' }); references.opportunity = opportunity.reference;
      const service = await command({ type: 'service.publish', id: 'service', serviceCode: 'synthetic-consulting', title: '合成咨询服务', unit: '次', unitPriceMinor: 10000,
        scope: '合成需求评估', acceptanceCriteria: ['合成评估报告'], validFrom, validUntil }, 'manager'); references.service = service.reference;
      references.quoteDraft = (await command({ type: 'quote.prepare', id: 'quote-draft', opportunity: opportunity.reference, lines: [{ service: service.reference, quantity: 3 }], validUntil: quoteUntil })).reference;
      await command({ type: 'quote.prepare', id: 'quote-order', opportunity: opportunity.reference, lines: [{ service: service.reference, quantity: 2 }], validUntil: quoteUntil });
      await command({ type: 'quote.approve', id: 'quote-order', expectedStreamVersion: 1 }, 'manager');
      const accepted = await command({ type: 'quote.record_acceptance', id: 'quote-order', expectedStreamVersion: 2, evidence: await proof('quote_version', 'quote-order', 'manager') }, 'manager');
      await command({ type: 'contract.create', id: 'contract', quote: accepted.reference, title: '合成服务合同' });
      const contract = await command({ type: 'contract.activate', id: 'contract', expectedStreamVersion: 1, evidence: await proof('contract', 'contract', 'manager') }, 'manager'); references.contract = contract.reference;
      await command({ type: 'order.create', id: 'order', contract: contract.reference, lines: [{ quoteLineId: 'line-1', quantity: 2 }] });
      const order = await command({ type: 'order.activate', id: 'order', expectedStreamVersion: 1 }, 'manager'); references.order = order.reference;
      const project = await command({ type: 'project.create', id: 'project', order: order.reference, title: '合成交付项目' }, 'manager'); references.project = project.reference;
      const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), businessDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(now()));
      references.milestone = (await command({ type: 'milestone.create', id: 'milestone', project: project.reference, title: '合成第一阶段', dueDate, lines: [{ lineId: 'line-1', quantity: 2 }] }, 'manager')).reference;
      await command({ type: 'payment_schedule.create', id: 'schedule', order: order.reference, amountMinor: 20000, dueDate }, 'finance');
      const schedule = await command({ type: 'payment_schedule.confirm', id: 'schedule', expectedStreamVersion: 1, evidence: await proof('payment_schedule', 'schedule', 'manager') }, 'manager'); references.schedule = schedule.reference;
      await command({ type: 'receipt.prepare', id: 'receipt', order: order.reference, amountMinor: 10000, businessDate, allocations: [{ schedule: schedule.reference, amountMinor: 10000 }] }, 'finance');
      references.receipt = (await command({ type: 'receipt.confirm', id: 'receipt', expectedStreamVersion: 1, evidence: await proof('receipt', 'receipt', 'manager') }, 'manager')).reference;
      references.document = (await host.knowledge.importDocument(actor('sales'), workspace.id, 'fixture-document', { documentId: 'fixture-brief', expectedStreamVersion: 0,
        title: '合成验收资料', fileName: 'fixture-brief.txt', mediaType: 'text/plain', contentBase64: Buffer.from('合成验收资料\n\n这份资料仅用于本地浏览器验收，内容与真实企业无关。').toString('base64'),
        bindings: [{ reference: customer.reference, fields: ['name'] }], classification: ['public'], visibility: 'business_scope' })).reference;
    }
    const available = person => {
      if (closed) throw new Error('FIXTURE_CLOSED');
      if (!ACCOUNTS.some(account => account.id === person) || person === 'admin') throw new Error('FIXTURE_ACCOUNT_INVALID');
    };
    return {
      origin, tenantId, workspaceId: workspace?.id, stateRoot, mode, accounts: structuredClone([...ACCOUNTS, INVITEE]), invitationSubject: INVITEE.id, references: structuredClone(references),
      hooks: {
        protocol: () => ({ tokenExchanges: issuer.exchanges() }),
        async changeCustomerVersion() {
          available('manager'); if (!references.versionCustomer) throw new Error('FIXTURE_DATA_REQUIRED');
          const current = await business.get(actor('manager'), workspace.id, 'customer', references.versionCustomer.objectId);
          return (await command({ type: 'customer.rename', id: current.reference.objectId, expectedStreamVersion: current.reference.streamVersion, name: '合成客户 · 版本 ' + (current.reference.streamVersion + 1) }, 'manager')).reference;
        },
        async revokeAccount(person) {
          available(person);
          for (const grant of grants.get(person)) await host.permissions.revoke(admin, 'fixture-revoke-' + grant.id, 'role', grant.id, grant.streamVersion);
        },
        async disableAccount(person) {
          available(person);
          const member = (await host.identity.listMembers(admin)).find(member => member.id === person);
          await host.identity.commandMember(admin, 'fixture-disable-' + person + '-' + member.streamVersion, person, member.streamVersion, { type: 'disable' });
        },
      }, close,
    };
  } catch (error) { await close().catch(() => {}); throw error; }
}
