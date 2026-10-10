// SPDX-License-Identifier: Apache-2.0
import type { JsonObject, ModelRequest, RuntimeStore } from '@mn/agent-runtime';
import { KernelError, sha256 } from '@mn/kernel';
import { assertModelContextLimit } from './model-context.js';

interface Change { readonly index: number; readonly kind: 'tool_result' | 'history'; readonly originalDigest: string }
function fits(request: ModelRequest): boolean {
  try { assertModelContextLimit(request); return true; }
  catch (error) { if (error instanceof KernelError && error.code === 'CONTEXT_LIMIT_EXCEEDED') return false; throw error; }
}
/** Original text stays protected and all source dependencies survive selection. This is an excerpt, never a new fact summary. */
export async function prepareBoundedModelRequest(input: ModelRequest, store: RuntimeStore): Promise<ModelRequest> {
  const request = structuredClone(input);
  if (fits(request)) return request;
  const messages = request.messages.map(message => ({ ...message }));
  const changes: Change[] = [];
  const excerpt = (index: number, kind: Change['kind']) => {
    const source = request.messages[index]!;
    changes.push({ index, kind, originalDigest: sha256(source.content) });
    messages[index] = { ...source, content: `[上下文摘录，不代表原文全貌；完整内容见受保护运行记录的 messages[${index}]，读取须重新核验来源权限。]\n${source.content.slice(0, 512)}\n[后续内容已卸载]` };
  };
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool' && Buffer.byteLength(message.content, 'utf8') > 2048) excerpt(index, 'tool_result');
    if (fits({ ...request, messages })) break;
  }
  if (!fits({ ...request, messages })) for (const [index, message] of messages.entries()) {
    if (message.contextOrigin && (message.role === 'user' || message.role === 'assistant') && Buffer.byteLength(message.content, 'utf8') > 2048) excerpt(index, 'history');
    if (fits({ ...request, messages })) break;
  }
  assertModelContextLimit({ ...request, messages });
  const original = await store.append({ executionId: request.executionId, type: 'context/prepared', payload: {
    generation: request.generation, messages: request.messages as unknown as JsonObject['messages'], availableToolIds: request.availableToolIds,
  } });
  for (const change of changes) messages[change.index] = { ...messages[change.index]!, content: messages[change.index]!.content.replace('受保护运行记录的', `受保护运行记录 ${original.id}（execution ${request.executionId}, sequence ${original.sequence}）的`) };
  const result: ModelRequest = { ...request, messages, contextSelection: { ...request.contextSelection, originalRecordId: original.id, originalSequence: original.sequence,
    changes: changes as unknown as JsonObject['changes'], method: 'deterministic_excerpt_v1' } };
  assertModelContextLimit(result);
  return result;
}
