// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeStore, type ModelRequest } from '@mn/agent-runtime';
import { prepareBoundedModelRequest } from '../src/context-selection.js';

const request = (messages: ModelRequest['messages']): ModelRequest => ({ executionId: 'current', agentId: 'agent', generation: 1, messages, availableToolIds: ['approved.tool'] });
test('先卸载大工具结果，再摘录历史；保留目标、权限和工具调用结构及原文引用', async () => {
  const store = new InMemoryRuntimeStore();
  const original = request([
    { role: 'system', content: '只能使用已授权工具' },
    { role: 'user', content: '旧会话证据'.repeat(6000), contextOrigin: { executionId: 'prior', sequence: 3 } } as any,
    { role: 'user', content: '当前目标与验收标准必须完整保留' },
    { role: 'tool', name: 'approved.tool', toolCallId: 'call-1', content: '工具原文'.repeat(8000) },
  ]);
  const result = await prepareBoundedModelRequest(original, store);
  assert.deepEqual(result.messages[0], original.messages[0]);
  assert.deepEqual(result.messages[2], original.messages[2]);
  assert.equal(result.messages[3]?.toolCallId, 'call-1');
  assert.equal(result.messages[3]?.name, 'approved.tool');
  assert.match(result.messages[1]!.content, /摘录.*不代表/u);
  assert.match(result.messages[3]!.content, /摘录.*不代表/u);
  const stored = (await store.readExecution('current')).find(record => record.type === 'context/prepared')!;
  assert.ok(stored);
  assert.deepEqual(stored.payload.messages, original.messages);
  assert.equal((result.contextSelection as any).originalRecordId, stored.id);
  assert.equal((result.contextSelection as any).changes.length, 2);
  assert.deepEqual(result.availableToolIds, original.availableToolIds);
});

test('必要输入不能被当作历史丢弃，压缩失败不伪造可发送请求', async () => {
  const store = new InMemoryRuntimeStore();
  await assert.rejects(prepareBoundedModelRequest(request([
    { role: 'system', content: '固定边界' }, { role: 'user', content: '当前必须阅读的资料'.repeat(8000) },
  ]), store), /上下文限额/u);
  assert.equal((await store.readExecution('current')).filter(record => record.type === 'model/request').length, 0);
});
