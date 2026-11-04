// SPDX-License-Identifier: Apache-2.0
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
import { createEnterpriseEventRepository } from '../apps/host/dist/enterprise-event-repository.js';
import { PostgresKernelStore } from './lib/postgres-kernel-store.mjs';
import { createPostgresPool } from './lib/postgres-pool.mjs';
const execute = promisify(execFile), name = `mn-enterprise-access-${randomUUID()}`;
const root = await mkdtemp(join(tmpdir(), 'mn-enterprise-access-'));
const docker = async (...args) => (await execute('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim();
let container; const pools = [];
try {
  container = await docker('run', '--detach', '--name', name, '--label', 'com.muniu.fixture=enterprise-access',
    '--memory', '512m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql/data:rw,size=256m',
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
    return { store, identity: new EnterpriseIdentityService({ repository }), permissions: new EnterprisePermissionService({ repository }), quotas: new EnterpriseQuotaService({ repository }) };
  };
  const a = await make(firstPool), b = await make(makePool());
  await a.identity.provision({ tenantId: 'tenant-a', name: '受保护合成企业', issuer: 'https://issuer.test/', maxMembers: 20,
    administrator: { id: 'admin', subject: 'protected-admin-subject', displayName: '管理员' } });
  const actor = { tenantId: 'tenant-a', principalId: 'admin', sessionEpoch: 1 };
  const workspace = await a.identity.createWorkspace(actor, 'workspace', { name: '主体', mode: 'builtin' });
  const grant = { id: 'role', workspaceId: workspace.id, principalId: 'admin', role: 'finance', scope: { kind: 'workspace' },
    operations: ['read', 'business_approve'], fieldClasses: ['public', 'price'], expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const results = await Promise.all([a.permissions.grantRole(actor, 'grant', grant), b.permissions.grantRole(actor, 'grant', grant)]);
  assert.deepEqual(results[0], results[1]);
  const object = { tenantId: 'tenant-a', workspaceId: workspace.id, objectType: 'receipt', objectId: 'receipt', fieldClasses: { amount: 'price', cost: 'cost' }, approvalFields: ['amount'] };
  assert.deepEqual(await b.permissions.filterFields(actor, object, { amount: 100, cost: 50 }), { amount: 100 });
  await assert.rejects(b.permissions.assertBusinessDecision(actor, object, 'admin'), { code: 'SEPARATION_OF_DUTIES_REQUIRED' });
  await assert.rejects(b.permissions.assertAccess(actor, { ...object, tenantId: 'tenant-b' }, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
  const revoked = await Promise.allSettled([a.permissions.revoke(actor, 'revoke-a', 'role', 'role', 1), b.permissions.revoke(actor, 'revoke-b', 'role', 'role', 1)]);
  assert.equal(revoked.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(revoked.find(result => result.status === 'rejected').reason.code, 'STREAM_VERSION_CONFLICT');
  await assert.rejects(a.permissions.assertAccess(actor, object, 'read'), { code: 'OBJECT_ACCESS_DENIED' });
  const c = await make(makePool());
  assert.equal((await c.permissions.configuration(actor, workspace.id)).roles[0].streamVersion, 2);
  const raw = await firstPool.query('select public_payload::text, protected_payload_ref from mn_enterprise_v1.events');
  assert.doesNotMatch(JSON.stringify(raw.rows), /protected-admin-subject|受保护合成企业|fieldClasses|business_approve/u);
  assert.ok(raw.rows.some(row => row.protected_payload_ref));
  assert.deepEqual((await firstPool.query('select value from mn_v2.sentinel')).rows, [{ value: 'untouched' }]);
  assert.deepEqual((await firstPool.query("select tablename from pg_tables where schemaname = 'mn_v2'")).rows, [{ tablename: 'sentinel' }]);
  process.stdout.write('企业权限 PostgreSQL 验收通过：双实例并发、字段过滤、撤权、职责分离、加密事实重放及旧命名空间隔离。\n');
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
