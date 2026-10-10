// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeStore } from '@mn/agent-runtime';
import { assertModelContextLimit } from '../src/model-context.js';
import { invokeBudgetedByokModel } from '../src/model-invoker.js';

test('上下文按保守输入上界保留输出和工具空间，不使用目标累计预算代替窗口', async () => {
  assert.throws(() => assertModelContextLimit({ messages: [{ role: 'user', content: 'x'.repeat(60_000) }] }), /上下文限额/u);
  let quotes = 0, calls = 0;
  await assert.rejects(invokeBudgetedByokModel({
    store: new InMemoryRuntimeStore(), limits: { maxTokens: 10_000_000, maxCostMinorUnits: '99999999', currency: 'CNY' },
    input: { presetId: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'fixture', signal: new AbortController().signal,
      request: { executionId: 'execution', agentId: 'test', generation: 1, availableToolIds: [], messages: [{ role: 'user', content: 'x'.repeat(60_000) }] } },
    async quote() { quotes++; throw new Error('不允许预检'); },
    async invoke() { calls++; throw new Error('不允许调用'); },
  }), /上下文限额/u);
  assert.equal(quotes, 0);
  assert.equal(calls, 0);
});

for (const revokedAt of ['quote', 'invoke'] as const) test(`模型 ${revokedAt} 出站前重新检查当前授权`, async () => {
  let checks = 0, quotes = 0, calls = 0;
  const revoked = new Error('授权已撤销');
  const options = {
    store: new InMemoryRuntimeStore(), limits: { maxTokens: 1000, maxCostMinorUnits: '100', currency: 'CNY' },
    input: { presetId: 'deepseek' as const, model: 'deepseek-chat', apiKey: 'fixture', signal: new AbortController().signal,
      request: { executionId: 'execution', agentId: 'test', generation: 1, availableToolIds: [], messages: [{ role: 'user' as const, content: '资料' }] } },
    async assertAllowed() { checks++; if (checks === (revokedAt === 'quote' ? 1 : 2)) throw revoked; },
    async quote() { quotes++; return { inputTokenLimit: 10, maxOutputTokens: 10,
      rates: { id: 'fixture', currency: 'CNY', inputNanoMinorUnitsPerToken: '0', cachedInputNanoMinorUnitsPerToken: '0', outputNanoMinorUnitsPerToken: '0' } }; },
    async invoke() { calls++; return { text: '禁止发送', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } }; },
  };
  await assert.rejects(invokeBudgetedByokModel(options), /授权已撤销|未结算/u);
  assert.equal(checks, revokedAt === 'quote' ? 1 : 2);
  assert.equal(quotes, revokedAt === 'quote' ? 0 : 1);
  assert.equal(calls, 0);
  assert.equal((await options.store.readExecution('execution')).filter(record => record.type === 'model/reserved').length, revokedAt === 'quote' ? 0 : 1);
});
