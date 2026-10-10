// SPDX-License-Identifier: Apache-2.0
import type { HostGoalRuntimeOptions } from './goal-runtime.js';
import { followupFail } from './followup-authority.js';
import { commandFollowup, createFollowup, getFollowup, listFollowups } from './followups.js';
import { readBoundedJsonBody } from './http-body.js';
export async function dispatchFollowupRequest(options: HostGoalRuntimeOptions & { readonly request: Request; readonly tenantId: string; readonly principalId: string; readonly mutationKey?: string }): Promise<{ status: number; data: unknown } | undefined> {
  const url = new URL(options.request.url), match = /^\/v2\/workspaces\/([^/]+)\/followups(?:\/([^/]+)(?:\/(commands))?)?$/u.exec(url.pathname); if (!match) return;
  if (url.searchParams.size) followupFail('FOLLOWUP_REQUEST_INVALID', '跟进接口不接受查询参数');
  const decode = (value: string) => { try { const result = decodeURIComponent(value); if (result.length > 200 || !result.trim()) throw new Error(); return result; } catch { return followupFail('FOLLOWUP_REQUEST_INVALID', '跟进标识无效'); } };
  const service = { ...options, workspaceId: decode(match[1]!) }, id = match[2] ? decode(match[2]) : undefined;
  if (options.request.method === 'GET' && !match[3]) return { status: 200, data: id ? await getFollowup(service, id) : await listFollowups(service) };
  if (options.request.method !== 'POST' || (id && !match[3])) return;
  const key = options.mutationKey ?? options.request.headers.get('Idempotency-Key'); if (!key?.trim() || key.length > 200) followupFail('IDEMPOTENCY_KEY_REQUIRED', '跟进变更需要幂等键');
  const body = await readBoundedJsonBody(options.request, { maxBytes: 128 * 1024 });
  return id ? { status: 200, data: await commandFollowup(service, id, body, key) } : { status: 201, data: await createFollowup(service, body, key) };
}
