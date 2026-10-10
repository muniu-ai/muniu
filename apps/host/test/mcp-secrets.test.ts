// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { MacOsMcpSecretStore } from '../src/mcp-secrets.js';
const scope = { tenantId: 'local', workspaceId: 'workspace', connectionId: 'connection', credentialId: 'credential' };
test('Keychain MCP 凭据使用独立作用域且只从标准输入传入密钥', async () => {
  const calls: { args: readonly string[]; stdin?: string }[] = [];
  const store = new MacOsMcpSecretStore(async (args, stdin) => { calls.push({ args, stdin }); return 'fixture-token'; });
  const ref = await store.save(scope, 'fixture-token'); assert.equal(await store.read(scope, ref), 'fixture-token');
  assert.equal(calls[0]!.stdin, 'fixture-token\n'); assert.equal(calls[0]!.args.includes('fixture-token'), false);
  assert.ok(calls[0]!.args.includes('com.muniu.agent-os.v2.mcp'));
  await assert.rejects(store.read({ ...scope, workspaceId: 'other' }, ref)); assert.equal(calls.length, 2);
  assert.notEqual(await store.save({ ...scope, credentialId: 'rotated' }, 'next-token'), ref);
});
test('无效或带换行的 Keychain token 在网络调用前被拒绝', async () => {
  for (const token of ['中文', 'x\ny', '']) {
    const store = new MacOsMcpSecretStore(async () => token);
    await assert.rejects(store.save(scope, token));
    const valid = new MacOsMcpSecretStore(async () => token), ref = await valid.save(scope, 'valid-token');
    await assert.rejects(valid.read(scope, ref));
  }
});
