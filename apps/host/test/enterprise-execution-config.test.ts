// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures/business.js';
import { EnterpriseExecutionConfigurationService } from '../src/enterprise-execution-config.js';
test('执行职责不能扩大人员业务权限，有限策略需负责人明确接受且正式报价不能自动批准', async (t) => {
    const f = await fixture(t);
    const { opportunity } = await f.base();
    const config = new EnterpriseExecutionConfigurationService({ repository: f.repository, now: () => '2026-11-02T01:00:00.000Z' });
    await assert.rejects(config.configure(f.actor('sales'), f.workspace.id, 'settings', { expectedStreamVersion: 0, responsibilities: [{ id: 'sales-support', capabilities: ['create_followup_task'], fieldClasses: ['public'] }] }), { code: 'ORGANIZATION_ADMIN_REQUIRED' });
    await config.configure(f.admin, f.workspace.id, 'settings', { expectedStreamVersion: 0, responsibilities: [{ id: 'sales-support', capabilities: ['create_followup_task', 'issue_quote_package'], fieldClasses: ['public', 'price'] }] });
    await config.registerBinding(f.admin, f.workspace.id, 'binding', 0, { id: 'binding', tenantId: 'tenant', workspaceId: f.workspace.id, streamVersion: 1, mode: 'builtin', bindings: [{ objectType: 'opportunity', provider: 'fixture', allowedActions: ['create_followup_task'], supportedPorts: ['executeAction', 'getReceipt'] }] });
    const policy = await config.writePolicy(f.admin, f.workspace.id, 'policy', { id: 'followup', expectedStreamVersion: 0, responsiblePrincipalId: 'sales', responsibilityId: 'sales-support', action: 'create_followup_task', target: opportunity.reference, maxActions: 2, validUntil: '2026-12-01T00:00:00.000Z' });
    assert.equal(policy.status, 'awaiting_acceptance');
    await assert.rejects(config.acceptPolicy(f.admin, f.workspace.id, 'followup', 1, 'accept'), { code: 'POLICY_RESPONSIBLE_REQUIRED' });
    await assert.rejects(config.acceptPolicy(f.actor('sales'), f.workspace.id, 'followup', 1, 'accept'), { code: 'OBJECT_ACCESS_DENIED' });
    await f.permissions.grantRole(f.admin, 'policy-execution', { id: 'policy-execution', workspaceId: f.workspace.id, principalId: 'sales', role: 'sales', scope: { kind: 'owned' }, operations: ['read', 'write', 'execution_approve'], fieldClasses: ['public'], expiresAt: '2027-01-01T00:00:00.000Z' });
    assert.equal((await config.acceptPolicy(f.actor('sales'), f.workspace.id, 'followup', 1, 'accept')).status, 'active');
    await f.permissions.revoke(f.admin, 'revoke-policy-role', 'role', 'policy-execution', 1);
    await assert.rejects(config.acceptPolicy(f.actor('sales'), f.workspace.id, 'followup', 1, 'accept'), { code: 'OBJECT_ACCESS_DENIED' });
    await assert.rejects(config.writePolicy(f.admin, f.workspace.id, 'formal', { id: 'formal', expectedStreamVersion: 0, responsiblePrincipalId: 'sales', responsibilityId: 'sales-support', action: 'issue_quote_package', target: opportunity.reference, maxActions: 2, validUntil: '2026-12-01T00:00:00.000Z' } as never));
});
