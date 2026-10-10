// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryKernelStore } from '@mn/kernel';
import { createAgentOsHost } from '@mn/host';

test('受信 Desktop 来源可以预检带幂等键的 PUT，非受信来源仍拒绝', async t => {
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(), allowedOrigins: ['http://127.0.0.1:5173'],
    secretStore: { async save() { return 'fixture'; }, async read() { return 'fixture'; } } });
  t.after(() => host.close());
  const address = await host.listen({ port: 0, host: '127.0.0.1' });
  const request = origin => fetch(`http://${address.host}:${address.port}/v2/goals/fixture/assignment`, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'Content-Type,Idempotency-Key' } });
  const trusted = await request('http://127.0.0.1:5173');
  assert.equal(trusted.status, 204);
  assert.equal(trusted.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173');
  assert.ok(trusted.headers.get('Access-Control-Allow-Methods')?.split(',').includes('PUT'));
  assert.ok(trusted.headers.get('Access-Control-Allow-Headers')?.includes('Idempotency-Key'));
  const untrusted = await request('https://untrusted.example.test');
  assert.equal(untrusted.status, 403); assert.equal(untrusted.headers.get('Access-Control-Allow-Origin'), null);
});
