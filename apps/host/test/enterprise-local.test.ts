// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InMemoryKeyProvider } from '@mn/storage';
import { startEnterpriseLocalHost } from '../src/enterprise-local.js';

test('新入口使用独立状态标识，拒绝非空旧目录，重启保持企业身份', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mn-enterprise-local-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = { hmacKey: randomBytes(32), keyProvider: new InMemoryKeyProvider(randomBytes(32)) };
  const config = { stateRoot: join(root, 'fresh'), origin: 'http://127.0.0.1:7319', profile: 'development' as const, port: 0, keys,
    providers: { tenant: { issuer: 'https://issuer.test/', clientId: 'fixture' } },
    organizations: [{ tenantId: 'tenant', name: '合成企业', issuer: 'https://issuer.test/', maxMembers: 200,
      administrator: { id: 'admin', subject: 'admin-subject', displayName: '管理员' } }] };
  const host = await startEnterpriseLocalHost(config);
  assert.equal((await host.dispatch(new Request('http://127.0.0.1:7319/v2/health'))).status, 200);
  await host.close();
  const marker = JSON.parse(await readFile(join(config.stateRoot, 'enterprise-state.json'), 'utf8'));
  assert.equal(marker.format, 'muniu.enterprise.state');
  const reopened = await startEnterpriseLocalHost(config);
  assert.equal((await reopened.identity.listMembers({ tenantId: 'tenant', principalId: 'admin', sessionEpoch: 1 })).length, 1);
  await reopened.close();
  const old = await mkdtemp(join(root, 'old-')); await writeFile(join(old, 'old-business.sqlite'), 'preserve');
  await assert.rejects(startEnterpriseLocalHost({ ...config, stateRoot: old }), /ENTERPRISE_STATE_DIRECTORY_NOT_EMPTY/);
  assert.deepEqual(await readdir(old), ['old-business.sqlite']);
  assert.equal(await readFile(join(old, 'old-business.sqlite'), 'utf8'), 'preserve');
});
