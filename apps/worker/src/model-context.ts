// SPDX-License-Identifier: Apache-2.0
import { KernelError } from '@mn/kernel';

// Product input policy, not a claim about any provider's context window.
export const MAX_MODEL_CONTEXT_BYTES = 96 * 1024;
export const MODEL_CONTEXT_TOOL_RESERVE_TOKENS = 4096;
export function assertModelContextLimit(request: unknown, maxInputTokens = 100_000): void {
  const body = typeof request === 'object' && request !== null && 'messages' in request
    ? { messages: (request as { messages: unknown }).messages, availableToolIds: 'availableToolIds' in request ? request.availableToolIds : [] } : request;
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  const output = typeof request === 'object' && request !== null && 'maxOutputTokens' in request
    ? (request as { maxOutputTokens?: number }).maxOutputTokens ?? 4096 : 4096;
  // Match the provider quoter conservative bound; output and protocol reserves are independent of cumulative budget.
  if (!Number.isSafeInteger(output) || output < 1 || bytes > MAX_MODEL_CONTEXT_BYTES || bytes * 2 + 4096 + output + MODEL_CONTEXT_TOOL_RESERVE_TOKENS > maxInputTokens) {
    throw new KernelError('CONTEXT_LIMIT_EXCEEDED', '必要资料与历史超过本次上下文限额', '减少资料或新建会话后重新委派；目标累计费用和 token 额度不会扩大上下文');
  }
}
