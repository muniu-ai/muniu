// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, parseEnterpriseContract, type BusinessObjectRef, type EnterpriseExecutionBudget, type PlanRevision, type TaskNode } from '@mn/contracts';
export class EnterprisePlanError extends Error { constructor(readonly code: string) { super(code); this.name = 'EnterprisePlanError'; } }
export interface EnterpriseNodeAttempt {
  readonly node: TaskNode;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'needs_reconciliation';
  readonly executionId: string;
  readonly planRevision?: number; readonly retryable?: boolean; readonly activeScope?: boolean;
}
export interface EnterprisePlanContext {
  readonly tenantId: string; readonly workspaceId: string; readonly goalId: string; readonly authorityRevisionId: string;
  readonly inputRefs: readonly BusinessObjectRef[]; readonly budget: EnterpriseExecutionBudget; readonly acceptanceCriteria: readonly string[];
  readonly capabilities: readonly { readonly id: string; readonly version: string; readonly effect: TaskNode['effect']; readonly modelRequired: boolean }[];
  readonly modelBindingIds: readonly string[]; readonly now: string;
  readonly limits: { readonly parallelNodes: number; readonly totalNodes: number; readonly totalAttempts: number; readonly automaticReplans: number };
  readonly history: readonly PlanRevision[]; readonly attempts: readonly EnterpriseNodeAttempt[]; readonly automaticReplans: number;
  readonly otherAttempts?: number; readonly otherNodes?: number;
  readonly spent: { readonly tokens: number; readonly costMinorUnits: string }; readonly automatic: boolean;
}
function fail(code: string): never { throw new EnterprisePlanError(code); }
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const locked = (a: EnterpriseNodeAttempt) => a.activeScope !== false && ['running', 'completed', 'needs_reconciliation'].includes(a.status);
const write = (n: TaskNode) => n.effect === 'internal_write' || n.effect === 'formal_action';
const actionKey = (n: TaskNode) => canonicalJson([n.capabilityId, n.capabilityVersion, [...n.inputRefs].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))]);
const within = (a: EnterpriseExecutionBudget, b: EnterpriseExecutionBudget) => a.currency === b.currency && a.maxTokens <= b.maxTokens && a.maxCostMinor <= b.maxCostMinor && Date.parse(a.deadline) <= Date.parse(b.deadline);
export function validateEnterprisePlan(raw: PlanRevision, context: EnterprisePlanContext): { topologicalOrder: readonly string[]; newNodeIds: readonly string[] } {
  let plan: PlanRevision;
  try { plan = parseEnterpriseContract('PlanRevision', raw); } catch { return fail('PLAN_INVALID'); }
  if (!Number.isFinite(Date.parse(context.now)) || Date.parse(plan.budget.deadline) <= Date.parse(context.now)) fail('PLAN_EXPIRED');
  const identity = (r: BusinessObjectRef) => canonicalJson([r.tenantId, r.workspaceId, r.objectType, r.objectId]);
  const permitted = (r: BusinessObjectRef) => context.inputRefs.some(a => equal(a, r));
  if (plan.tenantId !== context.tenantId || plan.workspaceId !== context.workspaceId || plan.goalId !== context.goalId || plan.authorityRevisionId !== context.authorityRevisionId
    || !within(plan.budget, context.budget) || !equal(plan.acceptanceCriteria, context.acceptanceCriteria) || plan.inputRefs.some(r => !permitted(r))) fail('PLAN_AUTHORITY_EXPANSION');
  if (context.automatic && context.automaticReplans >= context.limits.automaticReplans) fail('PLAN_REPLAN_LIMIT');
  if (!Number.isSafeInteger(context.spent.tokens) || context.spent.tokens < 0 || !/^(0|[1-9][0-9]*)$/u.test(context.spent.costMinorUnits)) fail('PLAN_ACCOUNTING_INVALID');
  if (context.limits.parallelNodes < 1 || context.limits.totalNodes < 1 || context.limits.totalAttempts < 1) fail('PLAN_LIMIT_INVALID');
  const map = new Map(plan.nodes.map(n => [n.id, n]));
  if (map.size !== plan.nodes.length) fail('PLAN_DUPLICATE_NODE');
  for (const attempt of context.attempts.filter(locked)) {
    if (!equal(map.get(attempt.node.id) ?? null, attempt.node)) fail('PLAN_STARTED_NODE_CHANGED');
  }
  const priorIds = new Set(context.history.flatMap(p => p.nodes.map(n => p.authorityRevisionId + ':' + n.id))), newIds = plan.nodes.filter(n => !priorIds.has(plan.authorityRevisionId + ':' + n.id)).map(n => n.id);
  if (new Set([...priorIds, ...newIds.map(id => plan.authorityRevisionId + ':' + id)]).size + (context.otherNodes ?? 0) > context.limits.totalNodes) fail('PLAN_NODE_LIMIT');
  const terminal = new Set(context.attempts.filter(a => a.activeScope !== false && a.status === 'completed').map(a => a.node.id));
  const held = new Set(context.attempts.filter(a => a.activeScope !== false && ['queued', 'running', 'needs_reconciliation'].includes(a.status) && equal(map.get(a.node.id) ?? null, a.node)).map(a => a.node.id));
  if (context.attempts.length + (context.otherAttempts ?? 0) + plan.nodes.filter(n => !terminal.has(n.id) && !held.has(n.id)).length > context.limits.totalAttempts) fail('PLAN_ATTEMPT_LIMIT');
  let tokens = BigInt(context.spent.tokens), cost = BigInt(context.spent.costMinorUnits);
  const actions = new Set<string>();
  for (const node of plan.nodes) {
    const capability = context.capabilities.find(c => c.id === node.capabilityId && c.version === node.capabilityVersion);
    if (!capability || capability.effect !== node.effect || (!capability.modelRequired && node.modelBindingId !== undefined)) fail('PLAN_CAPABILITY_INVALID');
    if (capability.modelRequired && (node.budget.maxTokens <= 0 || node.budget.maxCostMinor <= 0)) fail('PLAN_BUDGET_EXCEEDED');
    const prior = context.attempts.find(a => a.node.id === node.id && locked(a));
    if (capability.modelRequired && (!node.modelBindingId || (!prior && !context.modelBindingIds.includes(node.modelBindingId)))) fail('PLAN_MODEL_UNAVAILABLE');
    if (node.inputRefs.some(r => !(prior ? context.inputRefs.some(a => identity(a) === identity(r)) : permitted(r)))) fail('PLAN_AUTHORITY_EXPANSION');
    if (node.inputRefs.some(r => !plan.inputRefs.some(a => identity(a) === identity(r)))) fail('PLAN_INPUT_MISSING');
    if (!within(node.budget, plan.budget) || (Date.parse(node.budget.deadline) <= Date.parse(context.now) && !terminal.has(node.id))) fail('PLAN_BUDGET_EXCEEDED');
    if (!terminal.has(node.id)) { tokens += BigInt(node.budget.maxTokens); cost += BigInt(node.budget.maxCostMinor); }
    if (write(node)) {
      const key = actionKey(node);
      if (actions.has(key) || context.attempts.some(a => a.node.id !== node.id && write(a.node) && a.status !== 'cancelled' && actionKey(a.node) === key)) fail('PLAN_DUPLICATE_ACTION');
      actions.add(key);
      if (context.automatic && !context.history.some(p => p.nodes.some(previous => previous.id === node.id && write(previous) && actionKey(previous) === key))) fail('PLAN_AUTHORITY_EXPANSION');
    }
    if (node.dependsOn.some(id => id === node.id || !map.has(id))) fail('PLAN_DEPENDENCY_INVALID');
  }
  if (tokens > BigInt(plan.budget.maxTokens) || cost > BigInt(plan.budget.maxCostMinor)) fail('PLAN_BUDGET_EXCEEDED');
  const order: string[] = [], remaining = new Set(map.keys());
  while (remaining.size) {
    const ready = [...remaining].filter(id => map.get(id)!.dependsOn.every(parent => !remaining.has(parent))).sort();
    if (!ready.length) fail('PLAN_CYCLE');
    for (const id of ready) { order.push(id); remaining.delete(id); }
  }
  return { topologicalOrder: order, newNodeIds: newIds };
}
export function readyEnterpriseNodes(plan: PlanRevision, attempts: readonly EnterpriseNodeAttempt[], control: 'running' | 'paused' | 'cancelled' = 'running'): readonly string[] {
  if (control !== 'running') return [];
  const latest = new Map(attempts.map(a => [a.node.id, a]));
  return plan.nodes.filter(node => (!latest.has(node.id) || latest.get(node.id)?.status === 'cancelled' || (latest.get(node.id)?.status === 'failed' && latest.get(node.id)?.retryable === true && (latest.get(node.id)?.planRevision ?? plan.revision) < plan.revision)) && node.dependsOn.every(id => latest.get(id)?.status === 'completed')).map(n => n.id);
}
