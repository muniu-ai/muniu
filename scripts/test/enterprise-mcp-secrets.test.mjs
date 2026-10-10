// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { VaultMcpSecretStore, lazyVaultMcpSecretStore } from '../lib/enterprise-mcp-secrets.mjs';
const scope = { tenantId: 'tenant', workspaceId: 'workspace', connectionId: 'connection', credentialId: 'credential' };
test('Vault MCP凭据独立作用域与路径，拒绝跨租户引用且不使用模型密钥', async () => {
  const calls = [], values = new Map();
  const store = new VaultMcpSecretStore({ address: 'https://vault.test', token: 'vault-fixture', fetchImplementation: async (url, init) => {
    calls.push({ url: url.href, method: init.method }); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    assert.ok(url.pathname.startsWith('/v1/secret/data/muniu/v2/mcp/'));
    if (init.method === 'POST') { const body = JSON.parse(init.body); assert.equal(body.options.cas, 0); values.set(url.pathname, body.data); return new Response(null, { status: 204 }); }
    return Response.json({ data: { data: values.get(url.pathname) } });
  } });
  const ref = await store.save(scope, 'connector-fixture'); assert.equal(await store.read(scope, ref), 'connector-fixture');
  const before = calls.length;
  await assert.rejects(store.read({ ...scope, tenantId: 'other' }, ref));
  await assert.rejects(store.read(scope, 'vault://muniu/v2/models/connection')); assert.equal(calls.length, before);
  assert.notEqual(await store.save({ ...scope, credentialId: 'rotation' }, 'next-fixture'), ref);
});
test('未使用 MCP 的企业 Worker 不读取独立 Vault 配置', async () => {
  let calls = 0;
  const store = lazyVaultMcpSecretStore(() => { calls++; return {}; });
  assert.equal(calls, 0);
  await assert.rejects(store.read(scope, 'invalid'), error => error.code === 'MCP_CREDENTIAL_UNAVAILABLE');
  assert.equal(calls, 1);
});
test('Vault错误、超限及重定向不泄漏服务正文或凭据', async () => {
  for (const fetchImplementation of [async () => { throw new Error('vault-fixture connector-fixture'); }, async () => new Response('vault-fixture', { status: 403 }), async () => new Response('x'.repeat(20000)), async () => Response.json({ data: { data: { bearerToken: 'bad\nvalue' } } })]) {
    const store = new VaultMcpSecretStore({ address: 'https://vault.test', token: 'vault-fixture', fetchImplementation });
    await assert.rejects(store.read(scope, store.reference(scope)), error => !String(error).includes('vault-fixture') && !String(error).includes('connector-fixture'));
  }
});
