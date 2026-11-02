// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, type JsonObject } from '@mn/contracts';
import { EnterpriseError, opaqueHash, reduceIdentityEvents, requireActor, type EnterpriseActor } from './identity.js';
import type { EnterpriseRecord, EnterpriseRepository } from './repository.js';
export const DEFAULT_SCHEDULING_LIMITS = { parallelNodes: 6, totalNodes: 32, totalAttempts: 64, automaticReplans: 3, tenantRunningNodes: 20 } as const;
export interface EnterpriseQuotaLimits {
  readonly parallelNodes: number; readonly totalNodes: number; readonly totalAttempts: number; readonly automaticReplans: number; readonly tenantRunningNodes: number;
  readonly tokens: number; readonly costMinorUnits: string; readonly currency: 'CNY';
  readonly evaluationDailyTokens: number; readonly evaluationDailyCostMinorUnits: string;
  readonly singleEvaluationTokens: number; readonly singleEvaluationCostMinorUnits: string;
  readonly validFrom: string; readonly expiresAt: string;
}
export interface EnterpriseQuota extends EnterpriseQuotaLimits {
  readonly tenantId: string; readonly workspaceId?: string; readonly streamVersion: number; readonly capacityEvidenceDigest?: string;
}
const numericKeys = ['parallelNodes', 'totalNodes', 'totalAttempts', 'automaticReplans', 'tenantRunningNodes', 'tokens', 'evaluationDailyTokens', 'singleEvaluationTokens'] as const;
const moneyKeys = ['costMinorUnits', 'evaluationDailyCostMinorUnits', 'singleEvaluationCostMinorUnits'] as const;
function validate(input: EnterpriseQuotaLimits): void {
  if (input.currency !== 'CNY' || numericKeys.some(key => !Number.isSafeInteger(input[key]) || input[key] < 0)
    || moneyKeys.some(key => typeof input[key] !== 'string' || !/^(0|[1-9][0-9]{0,17})$/u.test(input[key]))
    || !Number.isFinite(Date.parse(input.validFrom)) || !Number.isFinite(Date.parse(input.expiresAt))
    || Date.parse(input.expiresAt) <= Date.parse(input.validFrom)
    || input.parallelNodes > input.totalNodes || input.totalNodes > input.totalAttempts
    || input.singleEvaluationTokens > input.evaluationDailyTokens || BigInt(input.singleEvaluationCostMinorUnits) > BigInt(input.evaluationDailyCostMinorUnits)) throw new EnterpriseError('INVALID_QUOTA', 400);
}
function within(input: EnterpriseQuotaLimits, ceiling: EnterpriseQuotaLimits): void {
  if (numericKeys.some(key => input[key] > ceiling[key]) || moneyKeys.some(key => BigInt(input[key]) > BigInt(ceiling[key]))
    || input.currency !== ceiling.currency || Date.parse(input.validFrom) < Date.parse(ceiling.validFrom) || Date.parse(input.expiresAt) > Date.parse(ceiling.expiresAt)) throw new EnterpriseError('PLATFORM_QUOTA_EXCEEDED', 409);
}
export function reduceQuotaEvents(records: readonly EnterpriseRecord[]) {
  let platform: EnterpriseQuota | undefined;
  const workspaces = new Map<string, EnterpriseQuota>();
  const receipts = new Map<string, { requestDigest: string; response: EnterpriseQuota }>();
  for (const record of records) {
    if (record.type === 'enterprise.quota.platform_configured' || record.type === 'enterprise.quota.workspace_configured') {
      const value = record.payload.value as unknown as EnterpriseQuota;
      const previous = value.workspaceId ? workspaces.get(value.workspaceId) : platform;
      if ((previous?.streamVersion ?? 0) !== record.expectedStreamVersion || value.streamVersion !== record.expectedStreamVersion + 1) throw new EnterpriseError('EVENT_HISTORY_INVALID', 503);
      if (value.workspaceId) workspaces.set(value.workspaceId, value); else platform = value;
    }
    if (record.type === 'enterprise.quota.command_recorded') receipts.set(record.aggregateId, record.payload as unknown as { requestDigest: string; response: EnterpriseQuota });
  }
  return { platform, workspaces, receipts };
}
/** Admission policy only; the execution coordinator must atomically reserve and settle the shared accounts. */
export function assertModelQuota(records: readonly EnterpriseRecord[], actor: EnterpriseActor, workspaceId: string,
  request: { tokens: number; costMinorUnits: string; expiresAt: string; purpose: 'goal' | 'evaluation' }, now: string): EnterpriseQuota {
  const identity = reduceIdentityEvents(records); requireActor(identity, actor);
  if (!identity.workspaces.has(workspaceId)) throw new EnterpriseError('WORKSPACE_NOT_FOUND', 404);
  const state = reduceQuotaEvents(records), quota = state.workspaces.get(workspaceId);
  if (!state.platform || !quota) throw new EnterpriseError('MODEL_QUOTA_UNCONFIGURED', 409);
  within(quota, state.platform);
  if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(now) < Date.parse(quota.validFrom)
    || Date.parse(now) >= Date.parse(quota.expiresAt) || Date.parse(request.expiresAt) <= Date.parse(now) || Date.parse(request.expiresAt) > Date.parse(quota.expiresAt)) throw new EnterpriseError('MODEL_QUOTA_EXPIRED', 409);
  if (!Number.isSafeInteger(request.tokens) || request.tokens <= 0 || !/^(0|[1-9][0-9]{0,17})$/u.test(request.costMinorUnits)
    || !['goal', 'evaluation'].includes(request.purpose)) throw new EnterpriseError('INVALID_QUOTA', 400);
  const tokens = request.purpose === 'evaluation' ? quota.singleEvaluationTokens : quota.tokens;
  const cost = request.purpose === 'evaluation' ? quota.singleEvaluationCostMinorUnits : quota.costMinorUnits;
  if (tokens <= 0 || BigInt(cost) <= 0n || request.tokens > tokens || BigInt(request.costMinorUnits) > BigInt(cost)
    || quota.parallelNodes === 0 || quota.tenantRunningNodes === 0) throw new EnterpriseError('MODEL_QUOTA_EXCEEDED', 409);
  return quota;
}
export class EnterpriseQuotaService {
  private readonly now: () => string;
  constructor(readonly options: { repository: EnterpriseRepository; now?: () => string }) { this.now = options.now ?? (() => new Date().toISOString()); }
  private event(type: string, aggregateType: string, aggregateId: string, expectedStreamVersion: number, actorId: string, payload: unknown): EnterpriseRecord {
    return { type, aggregateType, aggregateId, expectedStreamVersion, actorId, occurredAt: this.now(), payload: JSON.parse(JSON.stringify(payload)) as JsonObject };
  }
  private async change(tenantId: string, key: string, expectedStreamVersion: number, input: EnterpriseQuotaLimits, actor?: EnterpriseActor, workspaceId?: string, capacityEvidenceDigest?: string): Promise<EnterpriseQuota> {
    validate(input);
    if (!key.trim() || key.length > 200 || !Number.isSafeInteger(expectedStreamVersion) || expectedStreamVersion < 0) throw new EnterpriseError('INVALID_QUOTA', 400);
    const actorId = actor?.principalId ?? 'platform-operator', namespace = workspaceId ? 'enterprise.quota.workspace' : 'enterprise.quota.platform';
    const id = opaqueHash(canonicalJson([actorId, key, actor ? 'member' : 'platform']));
    const requestDigest = opaqueHash(canonicalJson([input, expectedStreamVersion, workspaceId ?? null, capacityEvidenceDigest ?? null]));
    return this.options.repository.transact(tenantId, records => {
      const identity = reduceIdentityEvents(records);
      if (!identity.organization || identity.organization.id !== tenantId) throw new EnterpriseError('ORGANIZATION_NOT_FOUND', 404);
      if (actor && !requireActor(identity, actor).organizationAdmin) throw new EnterpriseError('ORGANIZATION_ADMIN_REQUIRED');
      if (workspaceId && !identity.workspaces.has(workspaceId)) throw new EnterpriseError('WORKSPACE_NOT_FOUND', 404);
      const state = reduceQuotaEvents(records), prior = state.receipts.get(id);
      if (prior) { if (prior.requestDigest !== requestDigest) throw new EnterpriseError('IDEMPOTENCY_KEY_REUSED', 409); return { events: [], value: prior.response }; }
      const current = workspaceId ? state.workspaces.get(workspaceId) : state.platform;
      if ((current?.streamVersion ?? 0) !== expectedStreamVersion) throw new EnterpriseError('STREAM_VERSION_CONFLICT', 409);
      if (workspaceId) {
        if (!state.platform) throw new EnterpriseError('MODEL_QUOTA_UNCONFIGURED', 409);
        within(input, state.platform);
        const others = [...state.workspaces.values()].filter(value => value.workspaceId !== workspaceId && Date.parse(value.expiresAt) > Date.parse(input.validFrom) && Date.parse(value.validFrom) < Date.parse(input.expiresAt));
        for (const key of ['tokens', 'evaluationDailyTokens'] as const) if (others.reduce((sum, value) => sum + BigInt(value[key]), BigInt(input[key])) > BigInt(state.platform[key])) throw new EnterpriseError('PLATFORM_QUOTA_EXCEEDED', 409);
        for (const key of ['costMinorUnits', 'evaluationDailyCostMinorUnits'] as const) if (others.reduce((sum, value) => sum + BigInt(value[key]), BigInt(input[key])) > BigInt(state.platform[key])) throw new EnterpriseError('PLATFORM_QUOTA_EXCEEDED', 409);
      } else if ((Object.keys(DEFAULT_SCHEDULING_LIMITS) as (keyof typeof DEFAULT_SCHEDULING_LIMITS)[]).some(key => input[key] > DEFAULT_SCHEDULING_LIMITS[key])
        && !/^sha256:[a-f0-9]{64}$/u.test(capacityEvidenceDigest ?? '')) throw new EnterpriseError('CAPACITY_EVIDENCE_REQUIRED', 409);
      const value: EnterpriseQuota = { ...structuredClone(input), tenantId, ...(workspaceId ? { workspaceId } : {}), streamVersion: expectedStreamVersion + 1,
        ...(capacityEvidenceDigest ? { capacityEvidenceDigest } : {}) };
      return { events: [this.event(workspaceId ? 'enterprise.quota.workspace_configured' : 'enterprise.quota.platform_configured', namespace, workspaceId ?? tenantId, expectedStreamVersion, actorId, { value }),
        this.event('enterprise.quota.command_recorded', 'enterprise.quota.command', id, 0, actorId, { requestDigest, response: value })], value };
    });
  }
  /** Trusted Host provisioning only. A digest is an operator attestation, not an automatically verified capacity result. */
  async provision(tenantId: string, key: string, expectedStreamVersion: number, input: EnterpriseQuotaLimits, capacityEvidenceDigest?: string): Promise<EnterpriseQuota> {
    return this.change(tenantId, key, expectedStreamVersion, input, undefined, undefined, capacityEvidenceDigest);
  }
  async configure(actor: EnterpriseActor, key: string, workspaceId: string, expectedStreamVersion: number, input: EnterpriseQuotaLimits): Promise<EnterpriseQuota> {
    return this.change(actor.tenantId, key, expectedStreamVersion, input, actor, workspaceId);
  }
  async configuration(actor: EnterpriseActor, workspaceId: string) {
    const records = await this.options.repository.read(actor.tenantId), identity = reduceIdentityEvents(records);
    if (!requireActor(identity, actor).organizationAdmin) throw new EnterpriseError('ORGANIZATION_ADMIN_REQUIRED');
    if (!identity.workspaces.has(workspaceId)) throw new EnterpriseError('WORKSPACE_NOT_FOUND', 404);
    const state = reduceQuotaEvents(records);
    return { platform: state.platform ?? null, workspace: state.workspaces.get(workspaceId) ?? null };
  }
}
