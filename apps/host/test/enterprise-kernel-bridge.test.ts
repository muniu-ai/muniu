// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnterpriseIdentityService } from '@mn/enterprise-services';
import { FileCas, InMemoryKeyProvider, SqliteStorage, DEFAULT_PROJECTION_JOURNAL_NAMESPACES } from '@mn/storage';
import { createEnterpriseEventRepository } from '../src/enterprise-event-repository.js';
import { EnterpriseKernelBridge } from '../src/enterprise-kernel-bridge.js';
test('Kernel 运行身份来自当前企业事实；普通成员投影不会获得业务权限，旧快照不得提交', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mn-bridge-')), cas = new FileCas({ rootDir: join(root, 'cas') }), keyProvider = new InMemoryKeyProvider(randomBytes(32));
    const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite'), hmacKey: randomBytes(32), projectionJournal: { cas, keyProvider, namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES } });
    t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
    const repository = createEnterpriseEventRepository({ store, cas, keyProvider, allowExecutionEvents: true });
    const identity = new EnterpriseIdentityService({ repository });
    await identity.provision({ tenantId: 'tenant', name: '合成企业', issuer: 'https://issuer.test/', maxMembers: 20, administrator: { id: 'admin', subject: 'private-subject', displayName: '管理员' } });
    const actor = { tenantId: 'tenant', principalId: 'admin', sessionEpoch: 1 };
    const workspace = await identity.createWorkspace(actor, 'workspace', { name: '主体', mode: 'builtin' });
    const bridge = new EnterpriseKernelBridge({ store, repository });
    await bridge.store.transact('tenant', tx => { assert.equal(bridge.snapshot(tx).tenantId, 'tenant'); const principal = tx.getProjection<any>('principal', 'admin'); assert.equal(principal.kind, 'human'); assert.equal(principal.subject, undefined); assert.equal(principal.disabledAt, undefined); assert.equal(tx.getProjection<any>('membership', workspace.id + ':admin').workspaceRole, 'operator'); });
    const { EnterpriseBusinessService } = await import('../src/enterprise-business.js');
    await assert.rejects(new EnterpriseBusinessService({ repository }).execute({ actor, actorKind: 'human', workspaceId: workspace.id, idempotencyKey: 'denied', command: { type: 'customer.create', id: 'customer', name: '不得自动获权' } }), { code: 'OBJECT_ACCESS_DENIED' });
    assert.equal((await repository.read('tenant')).filter(e => e.type === 'enterprise.organization.provisioned').length, 1);
    assert.doesNotMatch(JSON.stringify(await store.readEventHistory('tenant', 0, 1000)), /private-subject|displayName/);
});
test('执行接入拒绝未配置保护事实存储的适配器', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mn-bridge-denied-'));
    const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite'), hmacKey: randomBytes(32) });
    t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
    const repository = createEnterpriseEventRepository({ store, cas: new FileCas({ rootDir: join(root, 'cas') }), keyProvider: new InMemoryKeyProvider(randomBytes(32)), allowExecutionEvents: true });
    const identity = new EnterpriseIdentityService({ repository });
    await identity.provision({ tenantId: 'tenant', name: '企业', issuer: 'https://issuer.test/', maxMembers: 20, administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } });
    const bridge = new EnterpriseKernelBridge({ store, repository });
    await assert.rejects(bridge.store.transact('tenant', () => { }), { code: 'PROTECTED_EXECUTION_STORAGE_REQUIRED' });
});
