// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { SubmissionChain } from '../src/submission-chain.js';
import { EnterpriseApiFailure, EnterpriseBrowserClient } from '../src/client.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
for (const stage of ['file', 'preflight'] as const) test('关闭在途' + stage + '后不启动后继业务写入', async () => {
  const chain = new SubmissionChain(), started = deferred<void>(), pending = deferred<string>(); let writes = 0, signal: AbortSignal | undefined;
  const result = chain.run(async scope => {
    if (stage === 'preflight') await scope.read(async () => 'file already read');
    const value = await scope.read(async current => { signal = current; started.resolve(); return pending.promise; });
    return scope.write({ key: 'original-operation', execute: async () => { writes++; return value; } });
  });
  await started.promise; chain.cancel(); assert.equal(signal!.aborted, true);
  pending.resolve('ready'); await assert.rejects(result, { code: 'SUBMISSION_STOPPED' });
  assert.equal(writes, 0); assert.equal(chain.snapshot().status, 'stopped'); assert.equal(chain.snapshot().pendingKey, undefined);
});

test('完整提交链等待实际响应体，响应头到达时不能解锁对话框', async () => {
  const chain = new SubmissionChain(), first = deferred<void>(), second = deferred<void>(), bodyStarted = deferred<void>(); let stream!: ReadableStreamDefaultController<Uint8Array>, writes = 0;
  const delayed = new Response(new ReadableStream<Uint8Array>({ start(value) { stream = value; } }));
  const parse = delayed.json.bind(delayed); delayed.json = async () => { bodyStarted.resolve(); return parse(); };
  const busy: boolean[] = []; const unsubscribe = chain.subscribe(() => busy.push(chain.snapshot().busy));
  const result = chain.run(async scope => {
    await scope.read(() => first.promise); await scope.read(() => second.promise);
    return scope.write({ key: 'save', execute: async () => { writes++; return delayed.json(); } });
  });
  first.resolve(); await Promise.resolve(); assert.equal(chain.snapshot().busy, true);
  second.resolve(); await bodyStarted.promise; assert.equal(writes, 1); assert.equal(chain.snapshot().busy, true);
  stream.enqueue(new TextEncoder().encode('{"saved":true}')); stream.close();
  assert.deepEqual(await result, { saved: true }); assert.equal(chain.snapshot().busy, false); assert.equal(chain.snapshot().status, 'completed');
  assert.ok(busy.slice(0, -1).every(Boolean)); unsubscribe();
});

test('已发出的写入中止后保留未知与原票据，仅重试原键且不重启剩余步骤', async () => {
  const session = { tenantId: 'tenant', principalId: 'actor', displayName: '经办人', status: 'active', organizationAdmin: false, csrfToken: 'csrf', expiresAt: '2026-12-01T00:00:00.000Z', profile: 'development' };
  const reference = { tenantId: 'tenant', workspaceId: 'workspace', objectType: 'customer', objectId: 'customer', streamVersion: 1, digest: 'a'.repeat(64) };
  const stored = new Map<string, unknown>(), keys: string[] = [], started = deferred<void>(); let stream!: ReadableStreamDefaultController<Uint8Array>, laterWrites = 0;
  const delayed = new Response(new ReadableStream<Uint8Array>({ start(value) { stream = value; } }));
  const parse = delayed.json.bind(delayed); delayed.json = async () => { started.resolve(); return parse(); };
  const api = new EnterpriseBrowserClient({ origin: 'https://muniu.test', now: () => Date.parse('2026-11-05'), randomId: () => 'unchanged-key', fetch: async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') return new Response(JSON.stringify({ data: session, traceId: 'session' }));
    const key = request.headers.get('idempotency-key')!; keys.push(key);
    if (!stored.has(key)) stored.set(key, { reference, values: { name: '合成客户' } });
    return keys.length === 1 ? delayed : new Response(JSON.stringify({ data: stored.get(key), traceId: 'saved' }));
  } });
  await api.loadSession();
  const ticket = api.prepareMutation('executeBusinessCommand', { path: { workspaceId: 'workspace' }, body: { type: 'customer.create', id: 'customer', name: '合成客户' } });
  const chain = new SubmissionChain();
  const result = chain.run(async scope => {
    await scope.write({ key: ticket.key, execute: signal => api.executeMutation(ticket, signal) });
    return scope.write({ key: 'must-not-follow', execute: async () => { laterWrites++; return true; } });
  });
  await started.promise; chain.cancel(); stream.error(new DOMException('Synthetic request aborted', 'AbortError'));
  await assert.rejects(result); assert.equal(chain.snapshot().status, 'uncertain'); assert.equal(chain.snapshot().pendingKey, ticket.key);
  assert.equal(laterWrites, 0); assert.equal(stored.size, 1);
  const replay = await chain.retryPending(); assert.deepEqual(replay, stored.get(ticket.key));
  assert.deepEqual(keys, ['unchanged-key', 'unchanged-key']); assert.equal(stored.size, 1); assert.equal(laterWrites, 0);
  assert.equal(chain.snapshot().status, 'completed'); assert.equal(chain.snapshot().pendingKey, undefined);
});

test('停止已部分保存的提交链会保留已确认写入，不谎称全部取消', async () => {
  const chain = new SubmissionChain(), started = deferred<void>(), pending = deferred<void>(); let evidenceWrites = 0, decisionWrites = 0;
  const result = chain.run(async scope => {
    await scope.write({ key: 'evidence', execute: async () => { evidenceWrites++; return { saved: true }; } });
    await scope.read(async () => { started.resolve(); return pending.promise; });
    return scope.write({ key: 'decision', execute: async () => { decisionWrites++; return true; } });
  });
  await started.promise; chain.cancel(); pending.resolve(); await assert.rejects(result, { code: 'SUBMISSION_STOPPED' });
  assert.equal(evidenceWrites, 1); assert.equal(decisionWrites, 0); assert.equal(chain.snapshot().status, 'stopped');
  assert.deepEqual(chain.snapshot().confirmedKeys, ['evidence']);
});

test('未知写入的权限拒绝不等于未发生，也不能换新键继续', async () => {
  const chain = new SubmissionChain(); let attempts = 0, unrelated = 0;
  await assert.rejects(chain.run(scope => scope.write({ key: 'uncertain-operation', execute: async () => {
    if (++attempts === 1) throw new EnterpriseApiFailure({ status: 0, code: 'NETWORK_UNAVAILABLE', unknownOutcome: true });
    throw new EnterpriseApiFailure({ status: 403, code: 'OBJECT_ACCESS_DENIED' });
  } })));
  await assert.rejects(chain.retryPending()); assert.equal(chain.snapshot().status, 'uncertain'); assert.equal(chain.snapshot().pendingKey, 'uncertain-operation');
  await assert.rejects(chain.run(scope => scope.write({ key: 'new-key', execute: async () => { unrelated++; return true; } })), { code: 'SUBMISSION_RECONCILIATION_REQUIRED' });
  assert.equal(unrelated, 0); assert.equal(chain.snapshot().pendingKey, 'uncertain-operation');
});

test('写入已提交后读取结果被撤权，仍保留原键而不能断言未保存', async () => {
  const chain = new SubmissionChain(); let persisted = 0;
  await assert.rejects(chain.run(scope => scope.write({ key: 'saved-before-revocation', execute: async () => {
    persisted++; throw new EnterpriseApiFailure({ status: 403, code: 'FIELD_ACCESS_DENIED' });
  } })));
  assert.equal(persisted, 1); assert.equal(chain.snapshot().status, 'uncertain');
  assert.equal(chain.snapshot().pendingKey, 'saved-before-revocation');
});
