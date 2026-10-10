// SPDX-License-Identifier: Apache-2.0
import type { Execution, FollowupPolicyV2, FollowupRunV2, GoalPlanRevisionV2, GoalResourceRefV2, GoalV2, Job, Principal, Workspace, WorkspaceMembership } from '@mn/contracts';
import { KernelError, sha256, type KernelTransaction, type ModelConnection } from '@mn/kernel';
import { assertAssetReader } from './asset-context.js';
import { isBusinessContextRef, readBusinessContext } from './business-context.js';
export interface FollowupStoredPolicy extends FollowupPolicyV2 { readonly tenantId: string; readonly parentPlanId: string }
export interface FollowupGoalBinding { readonly id: string; readonly tenantId: string; readonly workspaceId: string; readonly goalId: string; readonly policyId: string; readonly runId: string; readonly goalInputDigest: string; readonly authorizationDigest: string; readonly digest: string }
export const FOLLOWUP_POLICY = 'followup.policy', FOLLOWUP_RUN = 'followup.run', FOLLOWUP_BINDING = 'followup.goalBinding';
export function followupFail(code: string, message: string): never { throw new KernelError(code, message, '核对跟进授权、资料、期限和剩余额度'); }
export function followupMember(tx: KernelTransaction, tenantId: string, workspaceId: string, principalId: string): WorkspaceMembership {
  const member = tx.getProjection<WorkspaceMembership>('membership', `${workspaceId}:${principalId}`), principal = tx.getProjection<Principal>('principal', principalId), workspace = tx.getProjection<Workspace>('workspace', workspaceId);
  if (!member || member.tenantId !== tenantId || member.workspaceId !== workspaceId || member.principalId !== principalId || member.removedAt || !['owner', 'operator'].includes(member.workspaceRole) || !principal || principal.disabledAt
    || !workspace || workspace.tenantId !== tenantId || !workspace.activePluginIds.includes('opc')) followupFail('WORKSPACE_ACCESS_DENIED', '无权访问此工作区跟进');
  return member;
}
export function followupGrantDigest(tx: KernelTransaction, policy: FollowupStoredPolicy): string {
  const { tenantId, workspaceId, principalId, definition } = policy;
  const member = followupMember(tx, tenantId, workspaceId, principalId);
  const parent = tx.getProjection<GoalV2>('goal.state', definition.parentGoalId), plan = parent?.planRevisionId && tx.getProjection<GoalPlanRevisionV2>('goal.plan', parent.planRevisionId);
  if (!parent || parent.tenantId !== tenantId || parent.workspaceId !== workspaceId || parent.principalId !== principalId || !plan || parent.planRevisionId !== policy.parentPlanId
    || plan.digest !== definition.parentPlanDigest || parent.authorization?.planDigest !== plan.digest || parent.authorization.principalId !== principalId || parent.authorization.membershipStreamVersion !== member.streamVersion
    || ['accepted', 'cancelled'].includes(parent.status) || parent.cancellationRequestedAt) followupFail('FOLLOWUP_PARENT_CLOSED', '原目标已结束或原计划授权已失效');
  const { digest, ...body } = plan; if (sha256(body) !== digest) followupFail('FOLLOWUP_PARENT_CHANGED', '原目标计划已变化');
  const model = tx.getProjection<ModelConnection>('modelConnection', definition.modelBindingId);
  if (!model || model.tenantId !== tenantId || model.status !== 'ready' || plan.modelBindingId !== model.id || plan.modelConnectionStreamVersion !== model.streamVersion
    || definition.perRunBudget.currency !== plan.budget.currency || plan.model !== model.defaultModel || plan.runnerId !== 'builtin' || plan.pluginId !== 'opc' || plan.toolIds.length || plan.dataScopes.length) followupFail('FOLLOWUP_EXECUTOR_INVALID', '跟进需要原计划中可控制费用的只读内置执行者');
  return sha256({ tenantId, workspaceId, principalId, membershipVersion: member.streamVersion, parentPlanDigest: plan.digest, modelVersion: model.streamVersion,
    definition, pluginVersion: plan.pluginVersion, pluginPackageSha256: plan.pluginPackageSha256 ?? null });
}
export function followupResources(tx: KernelTransaction, policy: FollowupStoredPolicy, selected?: readonly GoalResourceRefV2[]): void {
  const scope = { tenantId: policy.tenantId, workspaceId: policy.workspaceId, principalId: policy.principalId }, watch = policy.definition.trigger.sourceRef;
  for (const ref of selected ?? policy.definition.resourceRefs) {
    if (ref.namespace === 'asset') assertAssetReader(tx, scope, ref);
    else if (isBusinessContextRef(ref)) {
      const dynamic = !selected && ref.namespace === watch.namespace && ref.resourceId === watch.resourceId;
      readBusinessContext(tx, scope, dynamic ? { kind: ref.namespace.slice('opc.business.'.length) as 'customer', resourceId: ref.resourceId } : ref);
    } else followupFail('FOLLOWUP_RESOURCE_DENIED', '跟进资料只能来自原目标中的业务对象和受保护资料');
  }
}
export function assertFollowupPolicy(tx: KernelTransaction, policy: FollowupStoredPolicy, now: string, dispatch = false): void {
  if (!(dispatch ? policy.status === 'active' : ['active', 'paused', 'exhausted'].includes(policy.status))) followupFail('FOLLOWUP_STOPPED', '跟进已停止');
  if (Date.parse(policy.definition.expiresAt) <= Date.parse(now)) followupFail('FOLLOWUP_EXPIRED', '跟进授权已到期');
  if (followupGrantDigest(tx, policy) !== policy.authorizationDigest) followupFail('FOLLOWUP_AUTHORIZATION_STALE', '跟进授权已失效');
  followupResources(tx, policy);
}
export function followupGoalDigest(goal: GoalV2): string {
  return sha256({ id: goal.id, tenantId: goal.tenantId, workspaceId: goal.workspaceId, principalId: goal.principalId, threadId: goal.threadId,
    objective: goal.objective, inputVersion: goal.inputVersion, criteriaVersion: goal.criteriaVersion, deliverables: goal.deliverables, resourceRefs: goal.resourceRefs, budget: goal.budget });
}
function bound(tx: KernelTransaction, goal: GoalV2, now: string): { policy: FollowupStoredPolicy; run: FollowupRunV2 } | undefined {
  const binding = tx.getProjection<FollowupGoalBinding>(FOLLOWUP_BINDING, goal.id); if (!binding) return undefined;
  const { digest, ...body } = binding;
  const policy = tx.getProjection<FollowupStoredPolicy>(FOLLOWUP_POLICY, binding.policyId), run = tx.getProjection<FollowupRunV2>(FOLLOWUP_RUN, binding.runId);
  if (sha256(body) !== digest || !policy || !run || binding.goalId !== goal.id || binding.tenantId !== goal.tenantId || binding.workspaceId !== goal.workspaceId
    || run.workspaceId !== goal.workspaceId || run.goalId !== goal.id || run.policyId !== policy.id || binding.authorizationDigest !== policy.authorizationDigest || followupGoalDigest(goal) !== binding.goalInputDigest
    || sha256(goal.budget) !== sha256(policy.definition.perRunBudget)) followupFail('FOLLOWUP_BINDING_INVALID', '跟进执行与授权绑定不一致');
  assertFollowupPolicy(tx, policy, now); followupResources(tx, policy, goal.resourceRefs); return { policy, run };
}
export function assertFollowupGoalStart(tx: KernelTransaction, goal: GoalV2, trustedRunId: string | undefined, now: string): void {
  const state = bound(tx, goal, now); if (!state) return;
  if (state.run.status !== 'pending' || state.run.id !== trustedRunId) followupFail('FOLLOWUP_DISPATCH_REQUIRED', '跟进目标需要通过持久调度派发');
  const plan = goal.planRevisionId && tx.getProjection<GoalPlanRevisionV2>('goal.plan', goal.planRevisionId);
  if (!plan || 'kind' in plan || plan.runnerId !== 'builtin' || plan.pluginId !== 'opc' || plan.modelBindingId !== state.policy.definition.modelBindingId
    || plan.toolIds.length || plan.dataScopes.length || sha256(plan.budget) !== sha256(state.policy.definition.perRunBudget))
    followupFail('FOLLOWUP_EXECUTOR_INVALID', '跟进首次执行必须使用已授权的只读计划');
  assertFollowupPolicy(tx, state.policy, now, true);
}
export function assertFollowupContinuation(tx: KernelTransaction, goal: GoalV2, now: string, dispatch = false): void {
  const state = bound(tx, goal, now); if (!state) return;
  if (state.run.status === 'pending') followupFail('FOLLOWUP_DISPATCH_REQUIRED', '跟进首次执行需要通过持久调度派发');
  if (dispatch && state.policy.status === 'paused') followupFail('FOLLOWUP_STOPPED', '跟进已暂停，不能派发返工');
}
export function assertFollowupExecutionAuthorization(tx: KernelTransaction, execution: Execution, now = new Date().toISOString()): void {
  const jobs = tx.listProjections<Job>('job');
  const job = jobs.find(value => value.payload.executionId === execution.id);
  const coordination = job?.payload.coordination as { aggregateType?: string; aggregateId?: string } | undefined;
  const coordinatedGoal = coordination?.aggregateType === 'goal' && coordination.aggregateId
    ? tx.getProjection<GoalV2>('goal.state', coordination.aggregateId) : undefined;
  const relatedIds = new Set(tx.listProjections<Execution>('execution').filter(value => value.threadId === execution.threadId).map(value => value.id));
  const relatedGoals = new Set(jobs.filter(value => relatedIds.has(String(value.payload.executionId))).map(value => {
    const ref = value.payload.coordination as { aggregateType?: string; aggregateId?: string } | undefined;
    return ref?.aggregateType === 'goal' ? ref.aggregateId : undefined;
  }));
  const goal = coordinatedGoal && tx.getProjection(FOLLOWUP_BINDING, coordinatedGoal.id) ? coordinatedGoal
    : tx.listProjections<GoalV2>('goal.state').find(value => (value.threadId === execution.threadId || relatedGoals.has(value.id)) && tx.getProjection(FOLLOWUP_BINDING, value.id));
  if (!goal) return;
  const state = bound(tx, goal, now)!;
  if (!coordination || coordination.aggregateType !== 'goal' || coordination.aggregateId !== goal.id || !['running', 'awaiting_acceptance', 'failed', 'needs_reconciliation'].includes(state.run.status))
    followupFail('FOLLOWUP_EXECUTION_INVALID', '跟进会话不允许绕过目标创建执行');
}
