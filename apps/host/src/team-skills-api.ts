// SPDX-License-Identifier: Apache-2.0
import { parseCreateTeamSkillVersionV2, parseRegisterTeamSkillEvaluationV2, parseSubmitTeamSkillEvaluationV2, parseCommandTeamSkillV2 } from '@mn/contracts';
import { KernelError } from '@mn/kernel';
import type { HostTeamRuntimeOptions } from './team-planning.js';
import { readBoundedJsonBody } from './http-body.js';
import { createHostTeamSkillOptions } from './team-skills-runtime.js';
import { listTeamSkills, getTeamSkill, createTeamSkillVersion, registerTeamSkillEvaluation, submitTeamSkillEvaluation, commandTeamSkill } from './team-skills.js';
export interface TeamSkillRequestOptions extends HostTeamRuntimeOptions { readonly request: Request; readonly tenantId: string; readonly principalId: string; readonly mutationKey?: string }
function invalid(): never { throw new KernelError('TEAM_SKILL_REQUEST_INVALID', '团队技能请求字段无效', '刷新并检查技能操作参数'); }
function text(value: string): string { let decoded: string; try { decoded = decodeURIComponent(value); } catch { return invalid(); } if (!decoded.trim() || decoded.length > 200) invalid(); return decoded; }
function parse<T>(parser: (value: unknown) => T, value: unknown): T { try { return parser(value); } catch { return invalid(); } }
export async function dispatchTeamSkillRequest(options: TeamSkillRequestOptions): Promise<{ readonly status: number; readonly data: unknown } | undefined> {
  const url = new URL(options.request.url);
  const match = /^\/v2\/workspaces\/([^/]+)\/team-skills(?:\/([^/]+)(?:\/(evaluations|commands)(?:\/([^/]+)\/(results))?)?)?$/u.exec(url.pathname);
  if (!match) return undefined;
  const workspaceId = text(match[1]!), skillId = match[2] ? text(match[2]) : undefined;
  const service = createHostTeamSkillOptions(options, { tenantId: options.tenantId, principalId: options.principalId, workspaceId });
  if (options.request.method === 'GET') {
    if (match[3]) return undefined;
    const query = skillId ? 'version' : 'goalId';
    if ([...url.searchParams.keys()].some(key => key !== query) || url.searchParams.getAll(query).length > 1) invalid();
    const requested = url.searchParams.get('version') ?? undefined;
    if (requested !== undefined && !/^[1-9][0-9]{0,5}$/u.test(requested)) invalid();
    return { status: 200, data: skillId ? await getTeamSkill(service, skillId, requested) : await listTeamSkills(service, url.searchParams.has('goalId') ? text(url.searchParams.get('goalId')!) : undefined) };
  }
  if (options.request.method !== 'POST' || (skillId && !match[3]) || (match[3] === 'commands' && match[4])) return undefined;
  if (url.searchParams.size) invalid();
  const key = options.mutationKey ?? options.request.headers.get('Idempotency-Key');
  if (!key?.trim() || key.length > 200) throw new KernelError('IDEMPOTENCY_KEY_REQUIRED', '技能变更需要幂等键', '提供 Idempotency-Key');
  const body = await readBoundedJsonBody(options.request, { maxBytes: 1024 * 1024 });
  if (!skillId) return { status: 201, data: await createTeamSkillVersion(service, parse(parseCreateTeamSkillVersionV2, body), key) };
  if (match[3] === 'commands') return { status: 200, data: await commandTeamSkill(service, skillId, parse(parseCommandTeamSkillV2, body), key) };
  if (match[4]) return { status: 200, data: await submitTeamSkillEvaluation(service, skillId, text(match[4]), parse(parseSubmitTeamSkillEvaluationV2, body), key) };
  return { status: 201, data: await registerTeamSkillEvaluation(service, skillId, parse(parseRegisterTeamSkillEvaluationV2, body), key) };
}
