// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EnterpriseRepository } from '@mn/enterprise-services';
import { createEnterpriseHost } from '../src/enterprise-host.js';

const origin = 'https://web.example.test';
const repository: EnterpriseRepository = { async read() { throw new Error('public routes must not enumerate tenant state'); }, async transact() { throw new Error('public routes must not write enterprise state'); } };
const options = { repository, origin, profile: 'development' as const, providers: { public: { issuer: 'https://issuer.example.test', clientId: 'fixture' }, private: { issuer: 'https://private-issuer.example.test', clientId: 'fixture' } } };

test('公共登录目录只展示显式受信白名单，未配置不枚举企业，拒绝歧义和未配置入口', async t => {
  const hidden = createEnterpriseHost(options); t.after(() => hidden.close());
  const first = await hidden.dispatch(new Request(origin + '/v2/auth/organizations'));
  assert.equal(first.status, 200); assert.deepEqual((await first.json() as { data: unknown }).data, { organizations: [] });
  const config = { ...options, loginOrganizations: [{ id: 'public', name: '公开企业入口' }] };
  const host = createEnterpriseHost(config); t.after(() => host.close());
  const response = await host.dispatch(new Request(origin + '/v2/auth/organizations'));
  assert.equal(response.status, 200); assert.deepEqual((await response.json() as { data: unknown }).data, { organizations: config.loginOrganizations });
  assert.equal((await host.dispatch(new Request(origin + '/v2/auth/organizations?tenantId=private'))).status, 400);
  assert.throws(() => createEnterpriseHost({ ...options, loginOrganizations: [{ id: 'absent', name: '未配置企业' }] } as typeof config), /LOGIN_DIRECTORY_INVALID/);
  assert.throws(() => createEnterpriseHost({ ...options, loginOrganizations: [{ id: 'public', name: '甲' }, { id: 'public', name: '乙' }] } as typeof config), /LOGIN_DIRECTORY_INVALID/);
});

test('受信 Web 目录同源提供 HTML 和资源，API 错误保持 JSON，拒绝目录穿越及符号链接', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mn-enterprise-web-')); t.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, 'web'), assets = join(webRoot, 'assets'), outside = join(root, 'outside');
  await mkdir(assets, { recursive: true }); await mkdir(outside);
  const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';
  await writeFile(join(webRoot, 'index.html'), html); await writeFile(join(assets, 'app.js'), 'export const page = "enterprise";');
  await writeFile(join(assets, 'app.css'), 'body { color: #123; }'); await writeFile(join(outside, 'private.js'), 'synthetic-private-file');
  await symlink(join(outside, 'private.js'), join(assets, 'linked.js')); await symlink(outside, join(assets, 'linked-directory'));
  await symlink(webRoot, join(root, 'linked-root'));
  const config = { ...options, webRoot }, host = createEnterpriseHost(config); t.after(() => host.close());
  const index = await host.dispatch(new Request(origin + '/'));
  assert.equal(index.status, 200); assert.equal(await index.text(), html);
  assert.match(index.headers.get('content-type')!, /text\/html/); assert.equal(index.headers.get('cache-control'), 'no-store');
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff'); assert.match(index.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const script = await host.dispatch(new Request(origin + '/assets/app.js'));
  assert.equal(script.status, 200); assert.match(script.headers.get('content-type')!, /javascript/); assert.equal(await script.text(), 'export const page = "enterprise";');
  const head = await host.dispatch(new Request(origin + '/assets/app.css', { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength('body { color: #123; }'));
  for (const path of ['/assets/%2e%2e%2foutside/private.js', '/assets/%252e%252e%252foutside/private.js', '/assets/linked.js', '/assets/linked-directory/private.js', '/assets/.env', '/assets/missing.js', '/assets/', '/unregistered-page']) {
    const denied = await host.dispatch(new Request(origin + path));
    assert.equal(denied.status, 404, path); assert.doesNotMatch(await denied.text(), /synthetic-private-file|<html/);
  }
  const health = await host.dispatch(new Request(origin + '/v2/health'));
  assert.equal(health.status, 200); assert.match(health.headers.get('content-type')!, /application\/json/);
  const api = await host.dispatch(new Request(origin + '/v2/unregistered'));
  assert.equal(api.status, 401); assert.match(api.headers.get('content-type')!, /application\/json/);
  assert.throws(() => createEnterpriseHost({ ...options, webRoot: 'relative' } as typeof config), /WEB_ROOT_INVALID/);
  assert.throws(() => createEnterpriseHost({ ...options, webRoot: join(root, 'linked-root') } as typeof config), /WEB_ROOT_INVALID/);
});
