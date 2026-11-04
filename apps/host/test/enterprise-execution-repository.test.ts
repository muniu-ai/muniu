// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnterpriseIdentityService } from '@mn/enterprise-services';
import { FileCas, InMemoryKeyProvider, SqliteStorage } from '@mn/storage';
import { createEnterpriseEventRepository } from '../src/enterprise-event-repository.js';
async function fixture(t: test.TestContext) { const root = await mkdtemp(join(tmpdir(), 'mn-execution-repository-')); const store = new SqliteStorage({ databaseFile: join(root, 'state.sqlite'), hmacKey: randomBytes(32) }); t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); }); const options = { store, cas: new FileCas({ rootDir: join(root, 'cas') }), keyProvider: new InMemoryKeyProvider(randomBytes(32)) }; const repository = createEnterpriseEventRepository({ ...options, allowExecutionEvents: true } as any) as any; const identity = new EnterpriseIdentityService({ repository }); return { store, options, repository, identity }; }
const event = (tenantId: string) => ({ tenantId, aggregateType: 'execution', aggregateId: 'attempt', expectedStreamVersion: 0, type: 'execution.queued', actorId: 'member', generation: 1, correlationId: 'attempt', publicPayload: {} });
test('新企业初始化后可共享执行事件历史，企业快照只返回业务事实与批次版本', async (t) => {
    const f = await fixture(t);
    await f.identity.provision({ tenantId: 'tenant', name: '合成企业', issuer: 'https://issuer.test/', maxMembers: 20, administrator: { id: 'admin', subject: 'admin', displayName: '管理员' } });
    const before = await f.repository.readSnapshot('tenant');
    await f.store.transact('tenant', tx => tx.appendEvent(event('tenant')));
    const after = await f.repository.readSnapshot('tenant');
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.records, before.records);
    assert.ok(after.position > before.position);
    const strict = createEnterpriseEventRepository(f.options);
    await assert.rejects(strict.read('tenant'), { code: 'ENTERPRISE_STATE_NAMESPACE_REQUIRED' });
    await f.identity.createWorkspace({ tenantId: 'tenant', principalId: 'admin', sessionEpoch: 1 }, 'workspace', { name: '主体', mode: 'builtin' });
    await assert.rejects(f.store.transact('tenant', tx => f.repository.assertSnapshot('tenant', tx, before)), { code: 'ENTERPRISE_SNAPSHOT_CHANGED' });
});
test('执行事件接入也不接受没有新企业初始化事实的旧状态', async (t) => {
    const f = await fixture(t);
    await f.store.transact('legacy', tx => tx.appendEvent(event('legacy')));
    await assert.rejects(f.repository.read('legacy'), { code: 'ENTERPRISE_STATE_NAMESPACE_REQUIRED' });
});
