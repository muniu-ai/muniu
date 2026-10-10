// SPDX-License-Identifier: Apache-2.0
import type { CommandFollowupV2, CreateFollowupV2, FollowupDetailV2, FollowupRunV2, GoalResourceRefV2, GoalUsageV2, GoalV2 } from '@mn/contracts';
import { appendKernelEvent, sha256, type KernelTransaction } from '@mn/kernel';
import { validateGoalBudget } from '@mn/task-orchestration';
import type { GoalScope } from './goals.js';
import type { HostGoalRuntimeOptions } from './goal-runtime.js';
import { isBusinessContextRef, readBusinessContext } from './business-context.js';
import { FOLLOWUP_POLICY, FOLLOWUP_RUN, assertFollowupPolicy, followupFail, followupGrantDigest, followupMember, followupResources, type FollowupStoredPolicy } from './followup-authority.js';
export type FollowupOptions = HostGoalRuntimeOptions & GoalScope;
export interface FollowupCursor { readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly streamVersion: number; readonly sourceRef: GoalResourceRefV2; readonly contentDigest: string }
export const FOLLOWUP_CURSOR = 'followup.cursor';
export function followupEvent(tx: KernelTransaction, options: Pick<FollowupOptions, 'tenantId' | 'workspaceId' | 'principalId' | 'id'>, namespace: string, id: string, previous: number, type: string): void {
  appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: namespace, aggregateId: id, expectedStreamVersion: previous, type,
    actorId: options.principalId, generation: 0, correlationId: options.id('followup-event'), publicPayload: { workspaceId: options.workspaceId } });
}
function protect(options: FollowupOptions): void { if (!options.protectedJournal || !options.cas || !options.keyProvider) followupFail('PROTECTED_PAYLOAD_UNAVAILABLE', '跟进需要受保护的事件存储'); }
function fields(value: unknown, allowed: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) followupFail('FOLLOWUP_REQUEST_INVALID', '跟进请求包含无效字段');
  return value as Record<string, any>;
}
function text(value: unknown, limit = 200): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > limit) followupFail('FOLLOWUP_REQUEST_INVALID', '跟进文字字段无效'); }
function number(value: unknown, maximum = 10000): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) followupFail('FOLLOWUP_REQUEST_INVALID', '跟进额度或版本无效'); }
function resource(value: unknown): asserts value is GoalResourceRefV2 {
  const ref = fields(value, ['namespace', 'resourceId', 'streamVersion', 'digest']); text(ref.namespace); text(ref.resourceId); number(ref.streamVersion, Number.MAX_SAFE_INTEGER);
  if (typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.digest)) followupFail('FOLLOWUP_REQUEST_INVALID', '跟进资料必须包含版本摘要');
}
export function parseFollowup(input: unknown, now: string): CreateFollowupV2 {
  const value = fields(input, ['expectedStreamVersion', 'parentGoalId', 'expectedGoalStreamVersion', 'parentPlanDigest', 'title', 'instruction', 'enabled', 'trigger', 'resourceRefs', 'modelBindingId', 'perRunBudget', 'periodBudget', 'maxRuns', 'expiresAt']);
  if (value.expectedStreamVersion !== 0 || value.enabled !== true) followupFail('FOLLOWUP_EXPLICIT_ENABLE_REQUIRED', '请显式启用跟进并确认额度');
  for (const key of ['parentGoalId', 'parentPlanDigest', 'title', 'modelBindingId', 'expiresAt']) text(value[key]); text(value.instruction, 4000); number(value.expectedGoalStreamVersion, Number.MAX_SAFE_INTEGER); number(value.maxRuns, 1000);
  const trigger = fields(value.trigger, ['kind', 'sourceRef']); if (trigger.kind !== 'business_changed') followupFail('FOLLOWUP_TRIGGER_INVALID', '跟进仅支持已授权业务对象变化'); resource(trigger.sourceRef);
  if (!isBusinessContextRef(trigger.sourceRef)) followupFail('FOLLOWUP_TRIGGER_INVALID', '请选择业务对象');
  if (!Array.isArray(value.resourceRefs) || !value.resourceRefs.length || value.resourceRefs.length > 100) followupFail('FOLLOWUP_RESOURCE_DENIED', '请选择原目标资料');
  value.resourceRefs.forEach(resource); if (new Set(value.resourceRefs.map((ref: GoalResourceRefV2) => `${ref.namespace}:${ref.resourceId}`)).size !== value.resourceRefs.length) followupFail('FOLLOWUP_RESOURCE_DENIED', '跟进资料不能重复');
  const budget = fields(value.perRunBudget, ['maxTokens', 'maxCostMinorUnits', 'currency', 'maxDurationMs']);
  try { validateGoalBudget(budget as CreateFollowupV2['perRunBudget']); } catch { followupFail('FOLLOWUP_BUDGET_INVALID', '单次执行额度无效'); }
  const period = fields(value.periodBudget, ['periodMs', 'maxRuns', 'maxTokens', 'maxCostMinorUnits', 'currency']); number(period.maxRuns, 1000); number(period.maxTokens, Number.MAX_SAFE_INTEGER);
  if (![86400000, 604800000].includes(period.periodMs) || typeof period.maxCostMinorUnits !== 'string' || !/^(0|[1-9][0-9]{0,15})$/u.test(period.maxCostMinorUnits)
    || period.currency !== budget.currency || period.maxTokens < budget.maxTokens || BigInt(period.maxCostMinorUnits) < BigInt(budget.maxCostMinorUnits)) followupFail('FOLLOWUP_BUDGET_INVALID', '周期额度必须覆盖一次执行，且币种一致');
  const expires = Date.parse(value.expiresAt); if (!Number.isFinite(expires) || expires <= Date.parse(now) || expires > Date.parse(now) + 366 * 86400000) followupFail('FOLLOWUP_EXPIRY_INVALID', '跟进有效期须在一年以内');
  return JSON.parse(JSON.stringify(value)) as CreateFollowupV2;
}
export function readFollowup(tx: KernelTransaction, options: GoalScope, id: string): FollowupStoredPolicy {
  followupMember(tx, options.tenantId, options.workspaceId, options.principalId);
  const policy = tx.getProjection<FollowupStoredPolicy>(FOLLOWUP_POLICY, id);
  if (!policy || policy.tenantId !== options.tenantId || policy.workspaceId !== options.workspaceId || policy.principalId !== options.principalId) followupFail('FOLLOWUP_NOT_FOUND', '跟进不存在'); return policy;
}
export function followupSource(tx: KernelTransaction, policy: FollowupStoredPolicy) {
  const ref = policy.definition.trigger.sourceRef;
  return readBusinessContext(tx, policy, { kind: ref.namespace.slice('opc.business.'.length) as 'customer', resourceId: ref.resourceId });
}
export function followupRuns(tx: KernelTransaction, policy: FollowupStoredPolicy): FollowupRunV2[] {
  return tx.listProjections<FollowupRunV2>(FOLLOWUP_RUN).filter(run => run.policyId === policy.id && run.workspaceId === policy.workspaceId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function cancelPendingFollowups(tx: KernelTransaction, options: FollowupOptions, policy: FollowupStoredPolicy, reasonCode: string): void {
  for (const run of followupRuns(tx, policy).filter(item => item.status === 'pending' && !item.executionId)) {
    tx.putProjection(FOLLOWUP_RUN, run.id, { ...run, streamVersion: run.streamVersion + 1, updatedAt: options.now(),
      status: 'cancelled', actual: { tokens: 0, costMinorUnits: '0', currency: run.reserved.currency }, reasonCode });
    followupEvent(tx, options, FOLLOWUP_RUN, run.id, run.streamVersion, 'followup.pending_cancelled');
  }
}
export function followupPeriod(policy: FollowupStoredPolicy, now: string): { startedAt: string; endsAt: string } {
  const period = policy.definition.periodBudget.periodMs, start = Date.parse(policy.createdAt) + Math.max(0, Math.floor((Date.parse(now) - Date.parse(policy.createdAt)) / period)) * period;
  return { startedAt: new Date(start).toISOString(), endsAt: new Date(start + period).toISOString() };
}
const zero = (currency: string): GoalUsageV2 => ({ currency, tokens: 0, costMinorUnits: '0' });
function add(a: GoalUsageV2, b: GoalUsageV2): GoalUsageV2 {
  if (a.currency !== b.currency || !Number.isSafeInteger(a.tokens + b.tokens)) followupFail('FOLLOWUP_USAGE_INVALID', '跟进用量币种或精度无效');
  return { currency: a.currency, tokens: a.tokens + b.tokens, costMinorUnits: (BigInt(a.costMinorUnits) + BigInt(b.costMinorUnits)).toString() };
}
function remaining(run: FollowupRunV2): GoalUsageV2 {
  return { currency: run.reserved.currency, tokens: Math.max(0, run.reserved.tokens - (run.actual?.tokens ?? 0)),
    costMinorUnits: (BigInt(run.reserved.costMinorUnits) > BigInt(run.actual?.costMinorUnits ?? '0') ? BigInt(run.reserved.costMinorUnits) - BigInt(run.actual?.costMinorUnits ?? '0') : 0n).toString() };
}
export function followupDetail(tx: KernelTransaction, policy: FollowupStoredPolicy, now: string): FollowupDetailV2 {
  const runs = followupRuns(tx, policy), period = followupPeriod(policy, now), current = runs.filter(run => run.periodStartedAt === period.startedAt), currency = policy.definition.periodBudget.currency;
  let settled = zero(currency), reserved = zero(currency), unknown = zero(currency);
  for (const run of current) {
    if (run.actual) settled = add(settled, run.actual);
    const closedGrant = ['stopped', 'expired', 'invalidated'].includes(policy.status);
    const finishedKnown = run.actual && ['failed', 'awaiting_acceptance'].includes(run.status);
    if (!['accepted', 'cancelled'].includes(run.status) && !(closedGrant && finishedKnown)) {
      if (run.status === 'needs_reconciliation') unknown = add(unknown, remaining(run)); else reserved = add(reserved, remaining(run));
    }
  }
  const { tenantId: _tenant, parentPlanId: _parent, ...publicPolicy } = policy;
  return { policy: publicPolicy, runs, currentPeriod: { ...period, runCount: current.length, settled, reserved, unknown },
    allowedActions: { pause: policy.status === 'active', resume: policy.status === 'paused', stop: ['active', 'paused', 'exhausted'].includes(policy.status) } };
}
function receipt(tx: KernelTransaction, options: FollowupOptions, operation: string, key: string, input: unknown) {
  text(key); const scope = `followup:${options.workspaceId}:${options.principalId}:${operation}`, digest = sha256(input), prior = tx.getIdempotency(scope, key);
  if (prior && prior.requestDigest !== digest) followupFail('IDEMPOTENCY_KEY_REUSED', '幂等键已用于其他请求');
  return { prior: prior?.response as { id: string } | undefined, save(id: string) { tx.putIdempotency({ tenantId: options.tenantId, scope, key, requestDigest: digest, response: { id }, createdAt: options.now() }); } };
}
export async function createFollowup(options: FollowupOptions, raw: unknown, key: string): Promise<FollowupDetailV2> {
  protect(options);
  return options.store.transact(options.tenantId, tx => {
    followupMember(tx, options.tenantId, options.workspaceId, options.principalId);
    const known = receipt(tx, options, 'create', key, raw); if (known.prior) return followupDetail(tx, readFollowup(tx, options, known.prior.id), options.now());
    const definition = parseFollowup(raw, options.now()), parent = tx.getProjection<GoalV2>('goal.state', definition.parentGoalId);
    if (!parent || parent.streamVersion !== definition.expectedGoalStreamVersion) followupFail('STREAM_VERSION_CONFLICT', '原目标版本已变化');
    if (!parent.planRevisionId || !parent.authorization || parent.status === 'needs_reconciliation') followupFail('FOLLOWUP_PARENT_INVALID', '原目标需要已授权计划且没有未知执行结果');
    if (definition.resourceRefs.some(ref => !parent.resourceRefs.some(original => original.namespace === ref.namespace && original.resourceId === ref.resourceId))
      || !definition.resourceRefs.some(ref => sha256(ref) === sha256(definition.trigger.sourceRef))) followupFail('FOLLOWUP_RESOURCE_DENIED', '跟进资料必须在原目标的授权范围内');
    if (tx.listProjections<FollowupStoredPolicy>(FOLLOWUP_POLICY).filter(value => value.workspaceId === options.workspaceId && ['active', 'paused'].includes(value.status)).length >= 100) followupFail('FOLLOWUP_LIMIT_REACHED', '工作区跟进数量已达上限');
    const draft: FollowupStoredPolicy = { id: options.id('followup'), tenantId: options.tenantId, workspaceId: options.workspaceId, principalId: options.principalId,
      streamVersion: 1, status: 'active', definition, parentPlanId: parent.planRevisionId, authorizationDigest: '', createdAt: options.now(), updatedAt: options.now(), stopConditions: ['goal_closed', 'permission_revoked', 'expired', 'max_runs'] };
    followupResources(tx, draft, definition.resourceRefs); const policy = { ...draft, authorizationDigest: followupGrantDigest(tx, draft) };
    const source = followupSource(tx, policy), cursor: FollowupCursor = { id: policy.id, tenantId: options.tenantId, workspaceId: options.workspaceId, streamVersion: 1, sourceRef: source.sourceRef, contentDigest: sha256(source.content) };
    tx.putProjection(FOLLOWUP_POLICY, policy.id, policy); followupEvent(tx, options, FOLLOWUP_POLICY, policy.id, 0, 'followup.enabled');
    tx.putProjection(FOLLOWUP_CURSOR, policy.id, cursor); followupEvent(tx, options, FOLLOWUP_CURSOR, policy.id, 0, 'followup.baseline_recorded');
    known.save(policy.id); return followupDetail(tx, policy, options.now());
  });
}
export async function getFollowup(options: FollowupOptions, id: string): Promise<FollowupDetailV2> {
  protect(options); return options.store.transact(options.tenantId, tx => followupDetail(tx, readFollowup(tx, options, id), options.now()));
}
export async function listFollowups(options: FollowupOptions): Promise<readonly FollowupDetailV2[]> {
  protect(options); return options.store.transact(options.tenantId, tx => { followupMember(tx, options.tenantId, options.workspaceId, options.principalId);
    return tx.listProjections<FollowupStoredPolicy>(FOLLOWUP_POLICY).filter(policy => policy.tenantId === options.tenantId && policy.workspaceId === options.workspaceId && policy.principalId === options.principalId).map(policy => followupDetail(tx, policy, options.now())); });
}
export async function commandFollowup(options: FollowupOptions, id: string, raw: unknown, key: string): Promise<FollowupDetailV2> {
  protect(options); const value = fields(raw, ['expectedStreamVersion', 'command']); number(value.expectedStreamVersion, Number.MAX_SAFE_INTEGER);
  if (!['pause', 'resume', 'stop'].includes(value.command)) followupFail('FOLLOWUP_REQUEST_INVALID', '跟进命令无效'); const input = value as CommandFollowupV2;
  return options.store.transact(options.tenantId, tx => {
    const policy = readFollowup(tx, options, id), known = receipt(tx, options, `command:${id}`, key, input); if (known.prior) return followupDetail(tx, policy, options.now());
    if (policy.streamVersion !== input.expectedStreamVersion) followupFail('STREAM_VERSION_CONFLICT', '跟进状态已变化');
    if (!(input.command === 'stop' ? ['active', 'paused', 'exhausted'].includes(policy.status) : input.command === 'pause' ? policy.status === 'active' : policy.status === 'paused')) followupFail('FOLLOWUP_COMMAND_INVALID', '当前跟进状态不允许此操作');
    if (input.command === 'resume') assertFollowupPolicy(tx, policy, options.now());
    const next: FollowupStoredPolicy = { ...policy, status: input.command === 'stop' ? 'stopped' : input.command === 'pause' ? 'paused' : 'active', streamVersion: policy.streamVersion + 1, updatedAt: options.now() };
    tx.putProjection(FOLLOWUP_POLICY, id, next); followupEvent(tx, options, FOLLOWUP_POLICY, id, policy.streamVersion, `followup.${input.command}`);
    if (input.command === 'stop') cancelPendingFollowups(tx, options, next, 'FOLLOWUP_STOPPED');
    known.save(id); return followupDetail(tx, next, options.now());
  });
}
