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
