// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { MacOsKeychainKeyProvider, EnvelopeCipher } from '../src/encryption.js';
test('企业包装密钥只使用独立 Keychain service，不读取旧 0.2 账号', async () => {
  const calls: readonly string[][] = [];
  const mutable = calls as string[][];
  const provider = new MacOsKeychainKeyProvider({ account: 'enterprise-fixture', service: 'com.muniu.enterprise.v1',
    command: async args => { mutable.push([...args]); return Buffer.alloc(32, 70).toString('base64'); } });
  const cipher = new EnvelopeCipher(provider);
  const encrypted = await cipher.encrypt(Buffer.from('fixture'), { tenantId: 'fixture', purpose: 'enterprise' });
  assert.equal((await cipher.decrypt(encrypted)).toString(), 'fixture');
  assert.ok(calls.every(args => args.includes('com.muniu.enterprise.v1') && !args.includes('com.muniu.agent-os.v2')));
});
