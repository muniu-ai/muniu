// SPDX-License-Identifier: Apache-2.0
import { isCoordinatedGoalPlan, type CoordinationAttemptV2, type CoordinationGroupV2, type CoordinationInitialAccountingV2, type CoordinationNodeReuseInputV2, type CoordinationRunV2, type Execution, type ExecutionAuthority,
  type GoalCoordinatedPlanV2, type GoalDeliveryAcceptanceV2, type GoalDeliveryDecisionV2, type GoalDeliveryItemDecisionV2, type GoalDeliverySetV2, type GoalOutputRefV2, type GoalPlanV2, type GoalResponseV2, type GoalReworkPreviewV2, type GoalReworkV2, type GoalUsageV2, type GoalV2, type Job, type Principal, type Thread, type WorkspaceMembership } from '@mn/contracts';
import { appendKernelEvent, hasUnsettledToolCalls, KernelError, sha256, type KernelTransaction } from '@mn/kernel';
import { deriveReworkScope, TEAM_DEFAULT_LIMITS, validateDeliveryDecision } from '@mn/task-orchestration';
import { createProtectedRuntimeStore } from '@mn/worker';
import type { RuntimeRecord } from '@mn/agent-runtime';
import { executionMetering } from './execution-metering.js';
import type { TeamGoalContext, TeamGoalServiceOptions } from './team-goals.js';

export interface GoalReworkAdmission {
  readonly rework: GoalReworkV2;
  readonly deadlineAt: string;
  readonly initialAccounting?: CoordinationInitialAccountingV2;
  readonly reuses: readonly CoordinationNodeReuseInputV2[];
  readonly expectedGroupStreamVersion: number;
}
export interface GoalDeliveryApplicationPorts {
  readonly assertResources: TeamGoalServiceOptions['ports']['assertResources'];
  readonly assertPlan: TeamGoalServiceOptions['ports']['assertPlan'];
  assertHistorical(transaction: KernelTransaction, context: { readonly goal: GoalV2; readonly plan: GoalPlanV2; readonly deliverySet: GoalDeliverySetV2 }): void;
  preparePlan(transaction: KernelTransaction, context: { readonly goal: GoalV2; readonly sourcePlan: GoalPlanV2; readonly plan: GoalCoordinatedPlanV2 }): GoalCoordinatedPlanV2;
  resolveReuse(transaction: KernelTransaction, context: TeamGoalContext & { readonly nodeId: string }): {
    readonly sourceAttemptId: string; readonly inputDigest: string; readonly outputs: readonly GoalOutputRefV2[];
  };
  start(transaction: KernelTransaction, context: TeamGoalContext & { readonly reworkAdmission: GoalReworkAdmission }): CoordinationRunV2;
}
export interface GoalDeliveryServiceOptions extends Omit<TeamGoalServiceOptions, 'ports'> { readonly ports: GoalDeliveryApplicationPorts }
export interface GoalDeliveryMutationOptions extends GoalDeliveryServiceOptions {
  readonly goalId: string; readonly expectedStreamVersion: number; readonly idempotencyKey: string;
}
export interface GoalDeliveryHistoryRecord {
  readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly goal: GoalV2;
  readonly planRevisionId: string; readonly deliverySet: GoalDeliverySetV2; readonly usage: GoalUsageV2;
}
interface StoredPreview {
  readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly goalId: string;
  readonly preview: GoalReworkPreviewV2; readonly goalDigest: string; readonly admission: GoalReworkAdmission;
}
type Current = { goal: GoalV2; plan: GoalPlanV2 | null; deliverySet: GoalDeliverySetV2 | null };
const DECISION = 'goal.deliveryDecision', REWORK = 'goal.rework', PREVIEW = 'goal.reworkPreview', HISTORY = 'goal.deliveryHistory';
function fail(code: string, message: string): never { throw new KernelError(code, message, '刷新成果、来源和费用后重试'); }
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function membership(tx: KernelTransaction, options: GoalDeliveryServiceOptions): WorkspaceMembership {
  if (!options.protectedJournal || !options.cas || !options.keyProvider) fail('PROTECTED_PAYLOAD_UNAVAILABLE', '交付记录需要受保护的事件存储');
  const member = tx.getProjection<WorkspaceMembership>('membership', `${options.workspaceId}:${options.principalId}`), principal = tx.getProjection<Principal>('principal', options.principalId);
  if (!member || member.tenantId !== options.tenantId || member.workspaceId !== options.workspaceId || member.principalId !== options.principalId || member.removedAt
    || !['owner', 'operator'].includes(member.workspaceRole) || !principal || principal.tenantId !== options.tenantId || principal.disabledAt) fail('WORKSPACE_ACCESS_DENIED', '无权访问此工作区交付记录');
  return member;
}
function planAt(tx: KernelTransaction, goal: GoalV2, id: string): GoalPlanV2 {
  const plan = tx.getProjection<GoalPlanV2>('goal.plan', id);
  if (!plan || plan.goalId !== goal.id || plan.threadId !== goal.threadId) fail('GOAL_PLAN_INVALID', '交付计划引用无效');
  const { digest, ...body } = plan; if (sha256(body) !== digest) fail('GOAL_PLAN_CHANGED', '交付计划摘要已变化'); return plan;
}
function assertSet(tx: KernelTransaction, options: GoalDeliveryServiceOptions, goal: GoalV2, plan: GoalPlanV2, set: GoalDeliverySetV2): void {
  if (set.goalId !== goal.id || set.planRevisionId !== plan.id || set.criteriaVersion !== plan.criteriaVersion
    || set.digest !== sha256({ goalId: set.goalId, planRevisionId: set.planRevisionId, criteriaVersion: set.criteriaVersion, items: set.items })) fail('GOAL_DELIVERY_CHANGED', '成果集合版本已变化');
  options.ports.assertResources(tx, options, plan.resourceRefs);
  for (const item of set.items) options.ports.assertResources(tx, options, [item.resourceRef, ...item.sourceRefs, ...item.checks.flatMap(check => check.evidenceRefs)]);
  options.ports.assertHistorical(tx, { goal, plan, deliverySet: set });
}
function current(tx: KernelTransaction, options: GoalDeliveryServiceOptions & { goalId: string }): Current {
  membership(tx, options);
  const goal = tx.getProjection<GoalV2>('goal.state', options.goalId);
  if (!goal || goal.tenantId !== options.tenantId || goal.workspaceId !== options.workspaceId) fail('GOAL_NOT_FOUND', '目标不存在');
  options.ports.assertResources(tx, options, goal.resourceRefs);
  const plan = goal.planRevisionId ? planAt(tx, goal, goal.planRevisionId) : null;
  const set = goal.deliverySetId ? tx.getProjection<GoalDeliverySetV2>('goal.deliverySet', goal.deliverySetId) : undefined;
  if (goal.deliverySetId && (!set || !plan)) fail('GOAL_DELIVERY_CHANGED', '成果集合不存在');
  if (set && plan) assertSet(tx, options, goal, plan, set);
  return { goal, plan, deliverySet: set ?? null };
}
function decisions(tx: KernelTransaction, goal: GoalV2): GoalDeliveryDecisionV2[] {
  return tx.listProjections<GoalDeliveryDecisionV2 & { tenantId: string; workspaceId: string }>(DECISION)
    .filter(item => item.goalId === goal.id && item.tenantId === goal.tenantId && item.workspaceId === goal.workspaceId)
    .sort((a, b) => a.goalStreamVersion - b.goalStreamVersion).map(({ tenantId: _tenant, workspaceId: _workspace, ...item }) => item);
}
function response(tx: KernelTransaction, options: GoalDeliveryServiceOptions, detail: Current): GoalResponseV2 {
  const { goal } = detail;
  const history = tx.listProjections<GoalDeliveryHistoryRecord>(HISTORY).filter(item => item.goal.id === goal.id && item.tenantId === goal.tenantId && item.workspaceId === goal.workspaceId)
    .map(record => { if (record.goal.tenantId !== options.tenantId || record.goal.workspaceId !== options.workspaceId || record.goal.threadId !== goal.threadId) fail('GOAL_HISTORY_INVALID', '历史成果范围无效');
      const plan = planAt(tx, record.goal, record.planRevisionId); assertSet(tx, options, record.goal, plan, record.deliverySet);
      return { planRevisionId: plan.id, revision: plan.revision, deliverySet: record.deliverySet, usage: record.usage }; });
  if (detail.plan && !history.some(item => item.planRevisionId === detail.plan!.id)) history.push({ planRevisionId: detail.plan.id, revision: detail.plan.revision, deliverySet: detail.deliverySet!, ...(goal.reservation?.actual ? { usage: goal.reservation.actual } : {}) } as typeof history[number]);
  const reworks = tx.listProjections<GoalReworkV2 & { tenantId: string; workspaceId: string }>(REWORK)
    .filter(item => item.goalId === goal.id && item.tenantId === goal.tenantId && item.workspaceId === goal.workspaceId).sort((a, b) => a.round - b.round)
    .map(({ tenantId: _tenant, workspaceId: _workspace, ...item }) => item);
  return { ...detail, ...(isCoordinatedGoalPlan(detail.plan) && goal.coordinationRef ? { runId: goal.coordinationRef.runId } : {}),
    deliveryReview: { decisions: decisions(tx, goal), reworks, history: history.sort((a, b) => a.revision - b.revision) } } as GoalResponseV2;
}
function event(tx: KernelTransaction, options: GoalDeliveryServiceOptions, namespace: string, id: string, goalId: string, type: string): void {
  appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: namespace, aggregateId: id, expectedStreamVersion: 0, type,
    actorId: options.principalId, generation: 0, correlationId: options.id('delivery-event'), publicPayload: { workspaceId: options.workspaceId, goalId } });
}
function writeGoal(tx: KernelTransaction, options: GoalDeliveryServiceOptions, previous: GoalV2, next: GoalV2, type: string): GoalV2 {
  const value = { ...next, streamVersion: previous.streamVersion + 1, updatedAt: options.now() };
  tx.putProjection('goal.state', value.id, value);
  appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: 'goal', aggregateId: value.id, expectedStreamVersion: previous.streamVersion, type,
    actorId: options.principalId, generation: 0, correlationId: options.id('goal-event'), publicPayload: { workspaceId: value.workspaceId, goalId: value.id, status: value.status } });
  return value;
}
function mutation(options: GoalDeliveryMutationOptions, operation: string, input: unknown) {
  if (!options.idempotencyKey?.trim() || options.idempotencyKey.length > 200) fail('IDEMPOTENCY_KEY_REQUIRED', '交付变更需要有效幂等键');
  if (!Number.isSafeInteger(options.expectedStreamVersion) || options.expectedStreamVersion < 1) fail('STREAM_VERSION_CONFLICT', '目标版本无效');
  return { scope: `goal.delivery.${operation}:${options.workspaceId}:${options.principalId}:${options.goalId}`, digest: sha256({ input, expectedStreamVersion: options.expectedStreamVersion }) };
}
function writable(options: GoalDeliveryMutationOptions, goal: GoalV2): void {
  if (goal.streamVersion !== options.expectedStreamVersion) fail('STREAM_VERSION_CONFLICT', '目标版本已变化');
  if (goal.principalId !== options.principalId) fail('GOAL_CONTROLLER_REQUIRED', '只有目标创建者可以决定交付和返工');
  if (!['awaiting_acceptance', 'failed'].includes(goal.status) || goal.reservation?.status !== 'settled' || !goal.reservation.actual) fail('GOAL_REWORK_PENDING', '成果或费用仍需核对，不能进行交付决定');
}
function threadAvailable(tx: KernelTransaction, goal: GoalV2): void {
  if (tx.listProjections<Execution>('execution').some(execution => execution.tenantId === goal.tenantId && execution.workspaceId === goal.workspaceId && execution.threadId === goal.threadId
    && execution.id !== goal.executionRef?.executionId && !['completed', 'failed', 'cancelled'].includes(execution.status))
    || tx.listProjections<GoalV2>('goal.state').some(other => other.id !== goal.id && other.tenantId === goal.tenantId && other.workspaceId === goal.workspaceId && other.threadId === goal.threadId
      && (other.executionRef || other.coordinationRef) && other.reservation?.status !== 'settled')) fail('GOAL_THREAD_BUSY', '会话仍有其他活动执行或待核对费用');
}
function assertReworkCapacity(tx: KernelTransaction, goal: GoalV2, plan: GoalCoordinatedPlanV2, reusedNodeIds: readonly string[], round: number): void {
  const run = goal.coordinationRef && tx.getProjection<CoordinationRunV2>('coordination.run', goal.coordinationRef.runId);
  const group = run && tx.getProjection<CoordinationGroupV2>('coordination.group', run.groupId);
  const policy = tx.getProjection<{ limits?: { maxNodes?: number; maxAttempts?: number; maxReworkRounds?: number } }>('coordination.workspace-policy', goal.workspaceId)?.limits;
  const bound = (hard: number, ...values: (number | undefined)[]) => {
    if (values.some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) fail('GOAL_REWORK_LIMIT', '工作区返工上限无效');
    return Math.min(hard, ...values.filter((value): value is number => value !== undefined));
  };
  const original = group ? (group.initialAccounting ? 1 : 0) : goal.executionRef ? 1 : 0;
  const previousNodes = original + (group ? tx.listProjections<CoordinationRunV2>('coordination.run').filter(previous => previous.groupId === group.id)
    .reduce((sum, previous) => sum + previous.nodes.filter(node => !tx.getProjection('coordination.reuse', `${previous.id}:${node.id}`)).length, 0) : 0);
  const attempts = original + (group ? tx.listProjections<CoordinationAttemptV2>('coordination.attempt').filter(attempt => attempt.groupId === group.id).length : 0);
  if (previousNodes + plan.nodes.filter(node => !reusedNodeIds.includes(node.id)).length > bound(12, plan.limits.maxNodes, group?.limits.maxNodes, policy?.maxNodes)
    || attempts + plan.nodes.filter(node => node.kind === 'agent' && !reusedNodeIds.includes(node.id)).length > bound(24, plan.limits.maxAttempts, group?.limits.maxAttempts, policy?.maxAttempts)
    || round > bound(2, plan.limits.maxReworkRounds, group?.limits.maxReworkRounds, policy?.maxReworkRounds)) fail('GOAL_REWORK_LIMIT', '返工将超过累计节点、尝试或轮次上限');
}
function receipt<T>(tx: KernelTransaction, options: GoalDeliveryMutationOptions, meta: ReturnType<typeof mutation>, value: T): T {
  tx.putIdempotency({ tenantId: options.tenantId, scope: meta.scope, key: options.idempotencyKey, requestDigest: meta.digest, response: value, createdAt: options.now() }); return value;
}
function prior<T>(tx: KernelTransaction, options: GoalDeliveryMutationOptions, meta: ReturnType<typeof mutation>): T | undefined {
  const found = tx.getIdempotency(meta.scope, options.idempotencyKey); if (!found) return undefined;
  if (found.requestDigest !== meta.digest) fail('IDEMPOTENCY_KEY_REUSED', '幂等键已用于其他请求'); return found.response as T;
}
export async function getGoalDeliveryReview(options: GoalDeliveryServiceOptions & { readonly goalId: string }): Promise<GoalResponseV2> {
  return options.store.transact(options.tenantId, tx => response(tx, options, current(tx, options)));
}
export async function decideGoalDelivery(options: GoalDeliveryMutationOptions & { readonly deliverySetId: string; readonly criteriaVersion: string; readonly items: readonly GoalDeliveryItemDecisionV2[] }): Promise<GoalResponseV2> {
  const meta = mutation(options, 'decide', { deliverySetId: options.deliverySetId, criteriaVersion: options.criteriaVersion, items: options.items });
  return options.store.transact(options.tenantId, tx => {
    const detail = current(tx, options), known = prior<GoalResponseV2>(tx, options, meta); response(tx, options, detail);
    if (known) return known;
    writable(options, detail.goal);
    const set = detail.deliverySet;
    if (!set || set.id !== options.deliverySetId || options.criteriaVersion !== detail.goal.criteriaVersion) fail('GOAL_DELIVERY_CHANGED', '只能决定当前成果版本');
    if (!Array.isArray(options.items) || !options.items.length || new Set(options.items.map(item => item.key)).size !== options.items.length
      || options.items.some(item => !set.items.some(output => output.key === item.key))) fail('GOAL_DECISION_INVALID', '成果决定项无效');
    const previous = decisions(tx, detail.goal).filter(item => item.deliverySetId === set.id).at(-1);
    const items = set.items.map(output => options.items.find(item => item.key === output.key) ?? previous?.items.find(item => item.key === output.key) ?? { key: output.key, digest: output.digest, decision: 'defer' as const });
    const result = validateDeliveryDecision({ deliverySet: set, specs: detail.goal.deliverables, criteriaVersion: options.criteriaVersion, items });
    const decision: GoalDeliveryDecisionV2 = { id: options.id('goal-decision'), goalId: detail.goal.id, deliverySetId: set.id, criteriaVersion: options.criteriaVersion,
      principalId: options.principalId, decidedAt: options.now(), goalStreamVersion: detail.goal.streamVersion + 1, items: copy(items) };
    tx.putProjection(DECISION, decision.id, { ...decision, tenantId: options.tenantId, workspaceId: options.workspaceId });
    event(tx, options, DECISION, decision.id, detail.goal.id, 'goal.delivery_decided');
    let next = detail.goal;
    if (result.allRequiredAccepted) {
      const accepted: GoalDeliveryAcceptanceV2 = { id: options.id('goal-acceptance'), goalId: next.id, deliverySetId: set.id, criteriaVersion: next.criteriaVersion, principalId: options.principalId, acceptedAt: options.now(),
        items: items.filter((item): item is Extract<GoalDeliveryItemDecisionV2, { decision: 'accept' }> => item.decision === 'accept').map(({ key, digest, reviewedCriterionIds }) => ({ key, digest, reviewedCriterionIds })) };
      tx.putProjection('goal.deliveryAcceptance', accepted.id, accepted); next = { ...next, status: 'accepted', acceptanceId: accepted.id };
    }
    writeGoal(tx, options, detail.goal, next, 'goal.delivery_decision_recorded');
    return receipt(tx, options, meta, response(tx, options, current(tx, options)));
  });
}
function closed(tx: KernelTransaction, execution: Execution, job: Job): void {
  if (!['completed', 'failed', 'cancelled', 'interrupted', 'paused'].includes(execution.status) || !['completed', 'failed'].includes(job.status) || hasUnsettledToolCalls(tx, execution.id)) fail('GOAL_REWORK_PENDING', '原执行仍有结果需要核对');
  const records = tx.getProjection<{ records: readonly RuntimeRecord[] }>('agent-runtime', execution.id)?.records ?? [];
  let pending = 0;
  for (const record of records) { if (record.type === 'model/reserved') pending++; if (record.type === 'model/settled' && --pending < 0) fail('GOAL_USAGE_UNKNOWN', '模型计量顺序需要核对'); }
  if (pending) fail('GOAL_USAGE_UNKNOWN', '模型用量仍需核对');
}
function accounting(tx: KernelTransaction, options: GoalDeliveryServiceOptions, detail: Current, records: readonly RuntimeRecord[]) {
  const { goal, plan } = detail;
  if (!plan || goal.reservation?.status !== 'settled' || !goal.reservation.actual) fail('GOAL_USAGE_UNKNOWN', '返工前必须核对全部用量');
  if (goal.coordinationRef) {
    const run = tx.getProjection<CoordinationRunV2>('coordination.run', goal.coordinationRef.runId), group = run && tx.getProjection<CoordinationGroupV2>('coordination.group', run.groupId);
    if (!run || !group || group.currentRunId !== run.id || run.aggregateId !== goal.id || run.tenantId !== goal.tenantId || run.workspaceId !== goal.workspaceId || run.revisionId !== plan.id) fail('GOAL_EXECUTION_INVALID', '目标执行绑定无效');
    let tokens = group.initialAccounting?.usage.tokens ?? 0, cost = BigInt(group.initialAccounting?.usage.costMinorUnits ?? '0');
    for (const attempt of tx.listProjections<CoordinationAttemptV2>('coordination.attempt').filter(item => item.groupId === group.id)) {
      const execution = tx.getProjection<Execution>('execution', attempt.executionId), job = tx.getProjection<Job>('job', attempt.jobId);
      if (!execution || !job || execution.generation !== attempt.generation || attempt.reservation.status !== 'settled' || !attempt.reservation.usage || attempt.reservation.usage.currency !== goal.budget.currency) fail('GOAL_USAGE_UNKNOWN', '节点费用仍需核对');
      closed(tx, execution, job); tokens += attempt.reservation.usage.tokens; cost += BigInt(attempt.reservation.usage.costMinorUnits);
    }
    return { usage: { tokens, costMinorUnits: cost.toString(), currency: goal.budget.currency }, deadlineAt: group.deadlineAt, round: (group.reworkRounds ?? 0) + 1, expectedGroupStreamVersion: group.streamVersion };
  }
  const ref = goal.executionRef, execution = ref && tx.getProjection<Execution>('execution', ref.executionId), job = execution && tx.listProjections<Job>('job').find(item => item.payload.executionId === execution.id);
  const authority = execution && tx.getProjection<ExecutionAuthority>('authority', execution.authorityId);
  if (!ref || !execution || !job || !authority || execution.tenantId !== goal.tenantId || execution.workspaceId !== goal.workspaceId || execution.generation !== ref.generation
    || execution.threadId !== goal.threadId || ref.planRevisionId !== plan.id) fail('GOAL_EXECUTION_INVALID', '原单执行者绑定无效');
  closed(tx, execution, job);
  const snapshot = tx.getProjection<{ records: readonly RuntimeRecord[] }>('agent-runtime', execution.id)?.records ?? [];
  if ((snapshot.at(-1)?.sequence ?? 0) !== (records.at(-1)?.sequence ?? 0)) fail('STREAM_VERSION_CONFLICT', '原执行记录已变化');
  if (execution.runnerId && execution.runnerId !== 'builtin') {
    const external = tx.getProjection<{ goalId: string; tenantId: string; workspaceId: string; usage: GoalUsageV2 }>('goal.externalUsage', execution.id);
    if (!external || external.goalId !== goal.id || external.tenantId !== goal.tenantId || external.workspaceId !== goal.workspaceId || sha256(external.usage) !== sha256(goal.reservation.actual)) fail('GOAL_USAGE_UNKNOWN', '外部执行费用尚未核对');
  } else {
    const actual = executionMetering(execution, authority, records);
    if (actual.pendingRequests || actual.status === 'overrun' || actual.knownTokens !== goal.reservation.actual.tokens || actual.currency !== goal.reservation.actual.currency
      || ((BigInt(actual.estimatedCostNanoMinorUnits) + 999_999_999n) / 1_000_000_000n).toString() !== goal.reservation.actual.costMinorUnits) fail('GOAL_USAGE_UNKNOWN', '原执行的费用与实际计量不一致，仍需核对');
  }
  const deadlineAt = new Date(Date.parse(execution.createdAt) + authority.budget.maxDurationMs).toISOString();
  const initialAccounting: CoordinationInitialAccountingV2 = { executionId: execution.id, jobId: job.id, generation: execution.generation, revisionId: plan.id,
    executionStreamVersion: execution.streamVersion, jobStreamVersion: job.streamVersion, runtimeLastSequence: records.at(-1)?.sequence ?? 0,
    usage: goal.reservation.actual, usageEvidenceDigest: sha256({ goalId: goal.id, reservation: goal.reservation, records }), deadlineAt,
    counterReservations: records.filter(record => record.type === 'budget/reserved').map(record => {
      if (record.payload.kind !== 'coding_repair' || typeof record.payload.id !== 'string' || !Number.isSafeInteger(record.payload.limit)) fail('GOAL_USAGE_UNKNOWN', '修复累计记录无效');
      return { kind: 'coding_repair', id: record.payload.id, limit: Number(record.payload.limit) };
    }) };
  return { usage: goal.reservation.actual, deadlineAt, round: 1, expectedGroupStreamVersion: 0, initialAccounting };
}
function planSkeleton(options: GoalDeliveryServiceOptions, goal: GoalV2, source: GoalPlanV2, threadVersion: number): GoalCoordinatedPlanV2 {
  const common = { id: options.id('goal-plan'), goalId: goal.id, threadId: goal.threadId, revision: source.revision + 1, inputVersion: goal.inputVersion,
    criteriaVersion: goal.criteriaVersion, budget: goal.budget, resourceRefs: goal.resourceRefs, deliverables: goal.deliverables, createdAt: options.now(),
    threadStreamVersion: threadVersion, domainInputDigest: source.domainInputDigest, pluginId: source.pluginId };
  if (isCoordinatedGoalPlan(source)) {
    const { digest: _digest, ...body } = source;
    const next = { ...body, ...common, nodes: source.nodes.map(node => node.kind === 'agent' ? { ...node, executor: { ...node.executor, threadStreamVersion: threadVersion } } : node) };
    return { ...next, digest: sha256(next) };
  }
  const { id: _id, goalId: _goal, threadId: _thread, revision: _revision, inputVersion: _input, criteriaVersion: _criteria, budget: _budget, resourceRefs: _refs, deliverables: _deliverables, digest: _digest, createdAt: _created, ...executor } = source;
  const next = { ...common, kind: 'single-v2' as const, ...(source.outputFormat ? { outputFormat: source.outputFormat } : {}), limits: TEAM_DEFAULT_LIMITS,
    nodes: [{ id: 'execute', title: '修改指定缺陷', kind: 'agent' as const, roleId: 'execute', dependsOn: [], executor: { ...executor, threadStreamVersion: threadVersion },
      capabilityRef: { id: 'team.execute', version: '1', digest: '0'.repeat(64) }, budget: goal.budget,
      inputs: [{ key: 'goal', kind: 'goal' as const }, ...goal.resourceRefs.map((resourceRef, index) => ({ key: `source.${index}`, kind: 'source' as const, resourceRef }))],
      outputs: [{ key: 'result', kind: 'artifact' as const, description: '修订后的成果' }, { key: 'evidence', kind: 'evidence' as const, description: '成果证据' }] }],
    deliverableBindings: goal.deliverables.map(item => ({ deliverableKey: item.key, nodeId: 'execute', outputKey: 'result' })) };
  return { ...next, digest: sha256(next) };
}
async function legacyRecords(options: GoalDeliveryMutationOptions): Promise<readonly RuntimeRecord[]> {
  const executionId = await options.store.transact(options.tenantId, tx => current(tx, options).goal.executionRef?.executionId);
  if (!executionId) return [];
  return createProtectedRuntimeStore({ ...options }).readSettlementRecords!(executionId);
}
export async function previewGoalRework(options: GoalDeliveryMutationOptions & { readonly decisionId: string }): Promise<GoalReworkPreviewV2> {
  const meta = mutation(options, 'preview', { decisionId: options.decisionId }), records = await legacyRecords(options);
  return options.store.transact(options.tenantId, tx => {
    const detail = current(tx, options), known = prior<GoalReworkPreviewV2>(tx, options, meta); response(tx, options, detail);
    if (known) return known;
    writable(options, detail.goal);
    const { goal, plan: source, deliverySet: set } = detail;
    threadAvailable(tx, goal);
    const decision = decisions(tx, goal).filter(item => item.deliverySetId === set?.id).at(-1);
    if (!source || !set || !decision || decision.id !== options.decisionId) fail('GOAL_DECISION_CHANGED', '返工必须基于当前成果的最近决定');
    const reviewed = validateDeliveryDecision({ deliverySet: set, specs: goal.deliverables, criteriaVersion: goal.criteriaVersion, items: decision.items });
    if (!reviewed.changedKeys.length) fail('GOAL_REWORK_INVALID', '先选择未满足的验收项');
    const counted = accounting(tx, options, detail, records), policy = tx.getProjection<{ limits?: { maxReworkRounds?: number } }>('coordination.workspace-policy', options.workspaceId);
    if (counted.round > Math.min(2, isCoordinatedGoalPlan(source) ? source.limits.maxReworkRounds : 2, policy?.limits?.maxReworkRounds ?? 2)) fail('GOAL_REWORK_LIMIT', '累计返工已达到两轮或工作区限制');
    const duration = Date.parse(counted.deadlineAt) - Date.parse(options.now());
    if (duration <= 0 || counted.usage.tokens >= goal.budget.maxTokens || BigInt(counted.usage.costMinorUnits) >= BigInt(goal.budget.maxCostMinorUnits)) fail('GOAL_BUDGET_EXCEEDED', '剩余费用、用量或期限不足');
    const remainingBudget = { ...goal.budget, maxTokens: goal.budget.maxTokens - counted.usage.tokens, maxCostMinorUnits: (BigInt(goal.budget.maxCostMinorUnits) - BigInt(counted.usage.costMinorUnits)).toString(), maxDurationMs: duration };
    const thread = tx.getProjection<Thread>('thread', goal.threadId);
    if (!thread || thread.tenantId !== goal.tenantId || thread.workspaceId !== goal.workspaceId) fail('GOAL_THREAD_INVALID', '目标会话已变化');
    const skeleton = planSkeleton(options, goal, source, thread.streamVersion), scope = deriveReworkScope(skeleton, reviewed.changedKeys);
    const reuses: GoalReworkV2['reuses'][number][] = [];
    if (isCoordinatedGoalPlan(source)) for (const nodeId of scope.reusableNodeIds) {
      const resolved = options.ports.resolveReuse(tx, { goal, plan: source, nodeId });
      const inputDigest = sha256({ inputs: skeleton.nodes.find(node => node.id === nodeId)!.inputs, domainInputDigest: skeleton.domainInputDigest, criteriaVersion: skeleton.criteriaVersion });
      if (resolved.inputDigest !== inputDigest || !resolved.outputs.length) fail('GOAL_REUSE_DENIED', '沿用节点的输入或成果证据已变化');
      reuses.push({ nodeId, sourcePlanRevisionId: source.id, sourceNodeId: nodeId, sourceAttemptId: resolved.sourceAttemptId, inputDigest, outputs: copy(resolved.outputs) });
    }
    assertReworkCapacity(tx, goal, skeleton, reuses.map(item => item.nodeId), counted.round);
    const count = skeleton.nodes.filter(node => node.kind === 'agent' && !reuses.some(reuse => reuse.nodeId === node.id)).length;
    const adjusted = { ...skeleton, nodes: skeleton.nodes.map(node => node.kind !== 'agent' || reuses.some(reuse => reuse.nodeId === node.id) ? node : { ...node, budget: { ...goal.budget,
      maxTokens: Math.floor(remainingBudget.maxTokens / count), maxCostMinorUnits: (BigInt(remainingBudget.maxCostMinorUnits) / BigInt(count)).toString() } }) };
    const prepared = options.ports.preparePlan(tx, { goal, sourcePlan: source, plan: adjusted });
    if (prepared.nodes.length !== adjusted.nodes.length || prepared.nodes.some((node, index) => {
      const old = adjusted.nodes[index]; if (!old || node.kind !== old.kind || node.id !== old.id) return true;
      if (node.kind !== 'agent' || old.kind !== 'agent') return sha256(node) !== sha256(old);
      const clean = (value: typeof node) => { const { capabilityRef: _cap, executor, ...rest } = value; const { domainInputDigest: _domain, threadStreamVersion: _version, ...identity } = executor; return { ...rest, executor: identity }; };
      return sha256(clean(node)) !== sha256(clean(old));
    }) || sha256(prepared.budget) !== sha256(goal.budget) || sha256(prepared.resourceRefs) !== sha256(goal.resourceRefs) || sha256(prepared.deliverables) !== sha256(goal.deliverables)) fail('GOAL_REWORK_SCOPE_CHANGED', '返工不能扩大执行者、权限、资料或验收范围');
    const { digest: _oldDigest, ...body } = prepared, plan = { ...body, digest: sha256(body) } as GoalCoordinatedPlanV2;
    for (const reuse of reuses) if (reuse.inputDigest !== sha256({ inputs: plan.nodes.find(node => node.id === reuse.nodeId)!.inputs, domainInputDigest: plan.domainInputDigest, criteriaVersion: plan.criteriaVersion })) fail('GOAL_REUSE_DENIED', '任务输入已变化，不能沿用旧节点');
    options.ports.assertPlan(tx, { goal, plan, reusedNodeIds: reuses.map(item => item.nodeId) });
    const rework: GoalReworkV2 = { id: options.id('goal-rework'), goalId: goal.id, sourcePlanRevisionId: source.id, sourceDeliverySetId: set.id, decisionId: decision.id,
      planRevisionId: plan.id, round: counted.round, createdAt: options.now(), affectedNodeIds: scope.affectedNodeIds, reuses,
      retainedOutputs: set.items.filter(item => !reviewed.changedKeys.includes(item.key)).map(output => ({ sourceDeliverySetId: set.id, key: output.key, outputDigest: output.digest, output })) };
    const previewBody = { id: options.id('goal-rework-preview'), goalId: goal.id, sourcePlanRevisionId: source.id, sourceDeliverySetId: set.id, decisionId: decision.id,
      expectedGoalStreamVersion: goal.streamVersion, round: counted.round, affectedNodeIds: scope.affectedNodeIds, reusedNodeIds: reuses.map(item => item.nodeId), retainedDeliverableKeys: rework.retainedOutputs.map(item => item.key),
      remainingBudget, deadlineAt: counted.deadlineAt, additionalWork: decision.items.filter(item => item.decision === 'request_changes').map(item => item.instruction),
      authorization: { requiresApproval: false, reasons: [] }, plan, createdAt: options.now() };
    const preview = { ...previewBody, digest: sha256(previewBody) };
    const admission: GoalReworkAdmission = { rework, deadlineAt: counted.deadlineAt, expectedGroupStreamVersion: counted.expectedGroupStreamVersion,
      ...('initialAccounting' in counted ? { initialAccounting: counted.initialAccounting } : {}),
      reuses: reuses.map(item => ({ nodeId: item.nodeId, sourceAttemptId: item.sourceAttemptId, inputDigest: item.inputDigest, outputDigest: sha256(item.outputs) })) };
    tx.putProjection(PREVIEW, preview.id, { id: preview.id, tenantId: options.tenantId, workspaceId: options.workspaceId, goalId: goal.id, preview, goalDigest: sha256(goal), admission } satisfies StoredPreview);
    event(tx, options, PREVIEW, preview.id, goal.id, 'goal.rework_previewed');
    return receipt(tx, options, meta, preview);
  });
}
export async function confirmGoalRework(options: GoalDeliveryMutationOptions & { readonly previewId: string; readonly previewDigest: string }): Promise<GoalResponseV2> {
  const meta = mutation(options, 'confirm', { previewId: options.previewId, previewDigest: options.previewDigest }), records = await legacyRecords(options);
  return options.store.transact(options.tenantId, tx => {
    const detail = current(tx, options), known = prior<GoalResponseV2>(tx, options, meta); response(tx, options, detail);
    if (known) return known;
    writable(options, detail.goal);
    const stored = tx.getProjection<StoredPreview>(PREVIEW, options.previewId);
    if (!stored || stored.tenantId !== options.tenantId || stored.workspaceId !== options.workspaceId || stored.goalId !== detail.goal.id
      || stored.preview.digest !== options.previewDigest || stored.goalDigest !== sha256(detail.goal)) fail('GOAL_PREVIEW_CHANGED', '返工预览已变化');
    const { digest, ...previewBody } = stored.preview;
    if (sha256(previewBody) !== digest || stored.preview.expectedGoalStreamVersion !== detail.goal.streamVersion || Date.parse(options.now()) >= Date.parse(stored.preview.deadlineAt)) fail('GOAL_PREVIEW_CHANGED', '返工预览已过期');
    const counted = accounting(tx, options, detail, records);
    if (counted.expectedGroupStreamVersion !== stored.admission.expectedGroupStreamVersion || counted.round !== stored.preview.round || counted.deadlineAt !== stored.preview.deadlineAt
      || sha256('initialAccounting' in counted ? counted.initialAccounting : null) !== sha256(stored.admission.initialAccounting ?? null)) fail('GOAL_PREVIEW_CHANGED', '费用或原执行证据已变化');
    const { goal, plan: source, deliverySet: set } = detail;
    threadAvailable(tx, goal);
    if (!source || !set) fail('GOAL_DELIVERY_CHANGED', '原成果不存在');
    if (isCoordinatedGoalPlan(source)) for (const reuse of stored.admission.rework.reuses) {
      const resolved = options.ports.resolveReuse(tx, { goal, plan: source, nodeId: reuse.sourceNodeId });
      if (resolved.sourceAttemptId !== reuse.sourceAttemptId || resolved.inputDigest !== reuse.inputDigest || sha256(resolved.outputs) !== sha256(reuse.outputs)) fail('GOAL_REUSE_DENIED', '原节点成果已变化');
    }
    const plan = stored.preview.plan;
    assertReworkCapacity(tx, goal, plan, stored.admission.rework.reuses.map(item => item.nodeId), stored.preview.round);
    options.ports.assertPlan(tx, { goal, plan, reusedNodeIds: stored.admission.rework.reuses.map(item => item.nodeId) });
    const { executionRef: _execution, coordinationRef: _run, deliverySetId: _delivery, acceptanceId: _acceptance, cancellationRequestedAt: _cancel, reasonCode: _reason, ...clean } = goal;
    const next: GoalV2 = { ...clean, status: 'running', planRevisionId: plan.id, reservation: { status: 'reserved' },
      authorization: { planDigest: plan.digest, principalId: options.principalId, membershipStreamVersion: membership(tx, options).streamVersion } };
    const history: GoalDeliveryHistoryRecord = { id: `${goal.id}:${source.id}`, tenantId: goal.tenantId, workspaceId: goal.workspaceId, goal, planRevisionId: source.id, deliverySet: set, usage: goal.reservation!.actual! };
    if (tx.getProjection(HISTORY, history.id)) fail('GOAL_HISTORY_EXISTS', '该计划已记录返工');
    tx.putProjection(HISTORY, history.id, history); event(tx, options, HISTORY, history.id, goal.id, 'goal.delivery_archived');
    tx.putProjection('goal.plan', plan.id, plan);
    tx.putProjection(REWORK, stored.admission.rework.id, { ...stored.admission.rework, tenantId: options.tenantId, workspaceId: options.workspaceId });
    event(tx, options, REWORK, stored.admission.rework.id, goal.id, 'goal.rework_recorded');
    const run = options.ports.start(tx, { goal: next, plan, reworkAdmission: stored.admission });
    if (run.tenantId !== goal.tenantId || run.workspaceId !== goal.workspaceId || run.threadId !== goal.threadId || run.aggregateType !== 'goal' || run.aggregateId !== goal.id
      || run.revisionId !== plan.id || run.revisionDigest !== plan.digest || run.deadlineAt !== stored.preview.deadlineAt || run.initiatedBy !== options.principalId
      || sha256(tx.getProjection('coordination.run', run.id)) !== sha256(run)) fail('GOAL_EXECUTION_INVALID', '返工执行与已审阅计划不一致');
    writeGoal(tx, options, goal, { ...next, coordinationRef: { runId: run.id, planRevisionId: plan.id } }, 'goal.rework_started');
    return receipt(tx, options, meta, response(tx, options, current(tx, options)));
  });
}
