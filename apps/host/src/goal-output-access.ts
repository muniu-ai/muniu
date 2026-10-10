// SPDX-License-Identifier: Apache-2.0
import type { GoalDeliveryAcceptanceV2, GoalDeliveryDecisionV2, GoalDeliverySetV2, GoalOutputRefV2, GoalPlanV2, GoalReworkV2, GoalV2, WorkspaceMembership } from '@mn/contracts';
import { KernelError, sha256, type KernelTransaction } from '@mn/kernel';
import { assertBusinessAccess } from './business-management.js';
import { validateHostContextSource, validateHistoricalHostContextSource } from './context-source-validation.js';
import { assertGoalResource } from './goal-runtime.js';
import { freezeProducedGoalItems, GOAL_PRODUCED_OUTPUT_NAMESPACE, parseProducedGoalItems, type FrozenProducedGoalItem } from './goal-produced-output.js';
import type { OpcBusinessCandidateOptions } from './opc-business-candidates.js';
import type { GoalDeliveryHistoryRecord } from './goal-delivery-service.js';

export interface GoalOutputAccessContext { readonly goal: GoalV2; readonly plan: GoalPlanV2; readonly deliverySet: GoalDeliverySetV2 }
type Purpose = 'create' | 'read' | 'apply';
export interface GoalOutputAccessOptions {
  assertDelivery(tx: KernelTransaction, context: GoalOutputAccessContext, purpose: Purpose): void;
}
function invalid(code = 'GOAL_OUTPUT_INVALID'): never { throw new KernelError(code, '成果版本、来源或验收凭据无效', '刷新成果与经营候选后重新核对'); }
function accepted(tx: KernelTransaction, context: GoalOutputAccessContext, output: GoalOutputRefV2): boolean {
  const { goal, plan, deliverySet } = context;
  const criteria = plan.deliverables.find(spec => spec.key === output.key)?.criteria;
  if (!criteria || output.checks.some(check => check.status === 'failed')) return false;
  const decision = tx.listProjections<GoalDeliveryDecisionV2 & { tenantId: string; workspaceId: string }>('goal.deliveryDecision')
    .filter(item => item.tenantId === goal.tenantId && item.workspaceId === goal.workspaceId && item.goalId === goal.id
      && item.deliverySetId === deliverySet.id && item.criteriaVersion === deliverySet.criteriaVersion)
    .sort((a, b) => b.goalStreamVersion - a.goalStreamVersion)[0];
  const legacy = !decision && goal.acceptanceId ? tx.getProjection<GoalDeliveryAcceptanceV2>('goal.deliveryAcceptance', goal.acceptanceId) : undefined;
  const item = decision ? decision.items.find(value => value.key === output.key && value.decision === 'accept')
    : legacy?.goalId === goal.id && legacy.deliverySetId === deliverySet.id && legacy.criteriaVersion === deliverySet.criteriaVersion
      ? legacy.items.find(value => value.key === output.key) : undefined;
  if (!item || item.digest !== output.digest || !('reviewedCriterionIds' in item)) return false;
  return item.reviewedCriterionIds.length === criteria.length && new Set(item.reviewedCriterionIds).size === criteria.length
    && criteria.every(criterion => item.reviewedCriterionIds.includes(criterion.id));
}

/** Reads fixed output proof without creating projections, decisions, or derived artifacts. */
export function createGoalOutputAccess(options: GoalOutputAccessOptions): OpcBusinessCandidateOptions['ports'] {
  return { readOutput(tx, scope, origin, purpose) {
    assertBusinessAccess(tx, scope, purpose !== 'read');
    const membership = tx.getProjection<WorkspaceMembership>('membership', `${scope.workspaceId}:${scope.principalId}`);
    if (!membership || membership.tenantId !== scope.tenantId || membership.workspaceId !== scope.workspaceId
      || membership.principalId !== scope.principalId || !['owner', 'operator'].includes(membership.workspaceRole)) invalid('WORKSPACE_ACCESS_DENIED');
    const current = tx.getProjection<GoalV2>('goal.state', origin.goalId);
    if (!current || current.tenantId !== scope.tenantId || current.workspaceId !== scope.workspaceId) invalid('GOAL_NOT_FOUND');
    if (purpose !== 'read' && (current.planRevisionId !== origin.planRevisionId || current.deliverySetId !== origin.deliverySetId
      || current.cancellationRequestedAt || ['cancelled', 'failed', 'needs_reconciliation'].includes(current.status))) invalid('OPC_CANDIDATE_STALE');
    const plan = tx.getProjection<GoalPlanV2>('goal.plan', origin.planRevisionId);
    const deliverySet = tx.getProjection<GoalDeliverySetV2>('goal.deliverySet', origin.deliverySetId);
    if (!plan || plan.id !== origin.planRevisionId || plan.goalId !== current.id || plan.threadId !== current.threadId) invalid();
    const { digest: planDigest, ...planBody } = plan;
    if (sha256(planBody) !== planDigest) invalid();
    if (!deliverySet || deliverySet.id !== origin.deliverySetId || deliverySet.goalId !== current.id
      || deliverySet.planRevisionId !== plan.id || deliverySet.criteriaVersion !== plan.criteriaVersion) invalid();
    const { id, digest, createdAt: _createdAt, ...deliveryBody } = deliverySet;
    if (sha256(deliveryBody) !== digest || id !== `goal-delivery-${digest}` || new Set(deliverySet.items.map(item => item.key)).size !== deliverySet.items.length) invalid();
    const output = deliverySet.items.find(item => item.key === origin.outputKey);
    if (!output || output.digest !== origin.outputDigest || output.resourceRef.digest !== output.digest || output.criteriaVersion !== plan.criteriaVersion) invalid();
    let goal = current;
    if (current.planRevisionId !== plan.id || current.deliverySetId !== deliverySet.id) {
      const history = tx.getProjection<GoalDeliveryHistoryRecord>('goal.deliveryHistory', `${current.id}:${plan.id}`);
      if (!history || history.id !== `${current.id}:${plan.id}` || history.tenantId !== scope.tenantId || history.workspaceId !== scope.workspaceId
        || history.planRevisionId !== plan.id || history.goal.id !== current.id || history.goal.tenantId !== scope.tenantId
        || history.goal.workspaceId !== scope.workspaceId || history.goal.threadId !== current.threadId || history.goal.planRevisionId !== plan.id
        || history.goal.deliverySetId !== deliverySet.id || sha256(history.deliverySet) !== sha256(deliverySet)) invalid();
      goal = history.goal;
    }
    const context = { goal, plan, deliverySet };
    const validator = purpose === 'read' ? validateHistoricalHostContextSource : validateHostContextSource;
    for (const ref of [...plan.resourceRefs, output.resourceRef, ...output.sourceRefs]) assertGoalResource(tx, scope, ref, validator);
    options.assertDelivery(tx, context, purpose);
    let proposals;
    if (output.resourceRef.namespace === GOAL_PRODUCED_OUTPUT_NAMESPACE) {
      const value = tx.getProjection<FrozenProducedGoalItem>(GOAL_PRODUCED_OUTPUT_NAMESPACE, output.resourceRef.resourceId);
      if (!value || value.tenantId !== scope.tenantId || value.workspaceId !== scope.workspaceId || value.goalId !== goal.id
        || value.key !== output.key || value.digest !== output.digest || value.streamVersion !== 1) invalid();
      const { digest: valueDigest, ...body } = value;
      if (sha256(body) !== valueDigest || plan.outputFormat !== 'items-v1') invalid();
      let fixed = context;
      const visited = new Set<string>();
      while (value.planRevisionId !== fixed.plan.id) {
        if (visited.has(fixed.plan.id) || visited.size >= 3) invalid();
        visited.add(fixed.plan.id);
        const rework = tx.listProjections<GoalReworkV2>('goal.rework').find(item => item.goalId === goal.id && item.planRevisionId === fixed.plan.id);
        const retained = rework?.retainedOutputs.find(item => item.key === output.key && item.outputDigest === output.digest && sha256(item.output) === sha256(output));
        const sourceSet = retained && tx.getProjection<GoalDeliverySetV2>('goal.deliverySet', retained.sourceDeliverySetId);
        const sourcePlan = sourceSet && tx.getProjection<GoalPlanV2>('goal.plan', sourceSet.planRevisionId);
        const history = sourcePlan && tx.getProjection<GoalDeliveryHistoryRecord>('goal.deliveryHistory', `${goal.id}:${sourcePlan.id}`);
        if (!retained || !sourceSet || sourceSet.goalId !== goal.id || !sourcePlan || sourcePlan.goalId !== goal.id
          || !history || history.id !== `${goal.id}:${sourcePlan.id}` || history.tenantId !== scope.tenantId || history.workspaceId !== scope.workspaceId
          || history.goal.id !== goal.id || history.goal.tenantId !== scope.tenantId || history.goal.workspaceId !== scope.workspaceId
          || history.planRevisionId !== sourcePlan.id || history.goal.planRevisionId !== sourcePlan.id || history.goal.deliverySetId !== sourceSet.id
          || history.goal.threadId !== goal.threadId || sourcePlan.threadId !== goal.threadId || sha256(history.deliverySet) !== sha256(sourceSet)
          || !sourceSet.items.some(item => sha256(item) === sha256(output))) invalid();
        const { digest: sourceDigest, ...sourcePlanBody } = sourcePlan;
        const { id: sourceSetId, digest: sourceSetDigest, createdAt: _created, ...sourceSetBody } = sourceSet;
        if (sha256(sourcePlanBody) !== sourceDigest || sha256(sourceSetBody) !== sourceSetDigest || sourceSetId !== `goal-delivery-${sourceSetDigest}`) invalid();
        fixed = { goal: history.goal, plan: sourcePlan, deliverySet: sourceSet };
        options.assertDelivery(tx, fixed, purpose);
      }
      const rework = tx.listProjections<GoalReworkV2>('goal.rework').find(item => item.goalId === goal.id && item.planRevisionId === fixed.plan.id);
      const specs = fixed.plan.deliverables.filter(spec => !rework?.retainedOutputs.some(item => item.key === spec.key));
      for (const ref of [value.source.resourceRef, ...value.source.sourceRefs]) assertGoalResource(tx, scope, ref, validator);
      const expected = freezeProducedGoalItems(tx, { goal: fixed.goal, planRevisionId: fixed.plan.id, specs,
        source: value.source, id: () => invalid(), mode: 'read' }).find(item => item.key === output.key);
      if (!expected || sha256(expected) !== sha256(output)) invalid();
      proposals = value.proposals;
    } else proposals = plan.outputFormat === 'items-v1'
      ? parseProducedGoalItems(output.preview, plan.deliverables, output.sourceRefs).find(item => item.key === output.key)?.proposals ?? [] : [];
    return { origin, sourceRefs: output.sourceRefs, proposals, accepted: accepted(tx, context, output) };
  } };
}
