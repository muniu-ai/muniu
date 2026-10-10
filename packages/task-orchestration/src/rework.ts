// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, type GoalCoordinatedPlanProposalV2, type GoalDeliveryItemDecisionV2, type GoalDeliverySetV2,
  type GoalDeliverableSpecV2, type GoalOutputRefV2 } from '@mn/contracts';
import { TeamPlanValidationError } from './plans.js';

function fail(code: string, message: string): never { throw new TeamPlanValidationError(code, message); }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function validateDeliveryDecision(input: { readonly deliverySet: GoalDeliverySetV2; readonly specs: readonly GoalDeliverableSpecV2[];
  readonly criteriaVersion: string; readonly items: readonly GoalDeliveryItemDecisionV2[] }): {
  readonly acceptedKeys: readonly string[]; readonly changedKeys: readonly string[]; readonly deferredKeys: readonly string[]; readonly allRequiredAccepted: boolean;
} {
  const { deliverySet, specs, items } = input;
  if (input.criteriaVersion !== deliverySet.criteriaVersion || !Array.isArray(items) || items.length !== deliverySet.items.length
    || new Set(items.map(item => item?.key)).size !== items.length) fail('GOAL_DECISION_INVALID', '请逐项决定当前成果版本');
  const acceptedKeys: string[] = [], changedKeys: string[] = [], deferredKeys: string[] = [];
  for (const item of items) {
    const output = deliverySet.items.find(output => output.key === item?.key), spec = specs.find(spec => spec.key === item?.key);
    if (!output || !spec || item.digest !== output.digest || output.criteriaVersion !== input.criteriaVersion) fail('GOAL_DELIVERY_CHANGED', '成果或验收标准已变化');
    const validCriteria = (ids: readonly string[]) => Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length && ids.every(id => spec.criteria.some(criterion => criterion.id === id));
    if (item.decision === 'accept') {
      if (!output.checks.length || output.checks.some(check => check.status !== 'passed')) fail('GOAL_EVIDENCE_FAILED', '成果检查未通过，不能接收');
      if (!validCriteria(item.reviewedCriterionIds) || item.reviewedCriterionIds.length !== spec.criteria.length) fail('GOAL_CRITERIA_NOT_REVIEWED', '请逐条复核验收标准');
      acceptedKeys.push(item.key);
    } else if (item.decision === 'request_changes') {
      if (!validCriteria(item.failedCriterionIds) || typeof item.instruction !== 'string' || !item.instruction.trim() || item.instruction.length > 4000) fail('GOAL_REWORK_INVALID', '请选择未满足的验收项并填写修改说明');
      changedKeys.push(item.key);
    } else if (item.decision === 'defer') {
      if (item.reason !== undefined && (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 4000)) fail('GOAL_DECISION_INVALID', '暂缓说明无效');
      deferredKeys.push(item.key);
    } else fail('GOAL_DECISION_INVALID', '成果决定无效');
  }
  return { acceptedKeys, changedKeys, deferredKeys, allRequiredAccepted: specs.filter(spec => spec.required).every(spec => acceptedKeys.includes(spec.key)) };
}

/** Computes work only. Host must validate live permissions and evidence before recording any reuse. */
export function deriveReworkScope(plan: Pick<GoalCoordinatedPlanProposalV2, 'nodes' | 'deliverableBindings'>, changedKeys: readonly string[]): {
  readonly affectedNodeIds: readonly string[]; readonly reusableNodeIds: readonly string[];
} {
  if (!changedKeys.length || new Set(changedKeys).size !== changedKeys.length) fail('GOAL_REWORK_INVALID', '返工范围缺失或重复');
  const map = new Map(plan.nodes.map(node => [node.id, node])), visited = new Set<string>(), visiting = new Set<string>();
  if (map.size !== plan.nodes.length) fail('TEAM_DAG_INVALID', '节点重复');
  const visit = (id: string): void => {
    if (visiting.has(id) || !map.has(id)) fail('TEAM_DAG_INVALID', '节点依赖无效');
    if (visited.has(id)) return;
    visiting.add(id); map.get(id)!.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  };
  plan.nodes.forEach(node => visit(node.id));
  const affected = new Set<string>();
  const producer = (id: string, key: string): void => {
    const node = map.get(id);
    if (!node || !node.outputs.some(output => output.key === key)) fail('GOAL_REWORK_INVALID', '成果生产节点不存在');
    if (node.kind === 'join') {
      const mapping = node.mappings.find(mapping => mapping.outputKey === key);
      if (!mapping || !node.dependsOn.includes(mapping.fromNodeId)) fail('GOAL_REWORK_INVALID', '成果汇合映射无效');
      producer(mapping.fromNodeId, mapping.fromOutputKey);
    } else if (node.kind === 'agent') affected.add(node.id);
    else fail('GOAL_REWORK_INVALID', '人工决定不能作为成果生产者');
  };
  for (const key of changedKeys) {
    const binding = plan.deliverableBindings.find(binding => binding.deliverableKey === key);
    if (!binding) fail('GOAL_REWORK_INVALID', '返工成果不属于当前计划');
    producer(binding.nodeId, binding.outputKey);
  }
  for (;;) {
    const size = affected.size;
    for (const node of plan.nodes) if (node.dependsOn.some(id => affected.has(id))) affected.add(node.id);
    if (affected.size === size) break;
  }
  return { affectedNodeIds: plan.nodes.filter(node => affected.has(node.id)).map(node => node.id),
    reusableNodeIds: plan.nodes.filter(node => node.kind === 'agent' && !affected.has(node.id)).map(node => node.id) };
}

export function assertOutputReuse(input: { readonly original: GoalOutputRefV2; readonly proposed: GoalOutputRefV2;
  readonly originalInputDigest: string; readonly currentInputDigest: string; readonly criteriaVersion: string;
  readonly sourceAccessValid: boolean; readonly authorizationValid: boolean; readonly executionCompleted: boolean; readonly evidenceValid: boolean }): void {
  if (!input.sourceAccessValid || !input.authorizationValid || !input.executionCompleted || !input.evidenceValid
    || !/^[a-f0-9]{64}$/u.test(input.originalInputDigest) || input.originalInputDigest !== input.currentInputDigest
    || input.original.criteriaVersion !== input.criteriaVersion || !same(input.original, input.proposed)
    || !input.original.checks.length || input.original.checks.some(check => check.status !== 'passed')) fail('GOAL_REUSE_DENIED', '原成果的输入、来源、授权或验收证据已变化');
}
