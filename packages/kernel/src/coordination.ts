// SPDX-License-Identifier: Apache-2.0
import type { CoordinationAttemptV2, CoordinationAuthorityV2, CoordinationBindingV2, CoordinationBudgetV2,
  CoordinationControlV2, CoordinationGroupV2, CoordinationLimitsV2, CoordinationNodeV2, CoordinationRunV2,
  Execution, ExecutionAuthority, Job, Principal, ResourceRef, Thread, VersionedEntity, Workspace, WorkspaceMembership } from '@mn/contracts';
import { assertCurrentExecutionAuthorization, hasUnsettledToolCalls } from './authority.js';
import { sha256 } from './canonical.js';
import { KernelError, StreamVersionConflictError } from './errors.js';
import { appendKernelEvent } from './projections.js';
import type { SubmitTurnInput } from './kernel.js';
import type { KernelJobSettlement, KernelJobSettlementReceipt, KernelTransaction } from './store.js';

export const COORDINATION_RUN_NAMESPACE = 'coordination.run';
export const COORDINATION_GROUP_NAMESPACE = 'coordination.group';
export const COORDINATION_ATTEMPT_NAMESPACE = 'coordination.attempt';
export const COORDINATION_CONTROL_NAMESPACE = 'coordination.control';
export const COORDINATION_POLICY_NAMESPACE = 'coordination.workspace-policy';
export function coordinationThreadId(runId: string, nodeId: string, attempt: number): string {
  return `coordination-thread:${sha256({ runId, nodeId, attempt })}`;
}
const HARD_LIMITS: CoordinationLimitsV2 = { maxParallel: 3, maxNodes: 12, maxAttempts: 24, maxDepth: 1 };
type Namespace = typeof COORDINATION_RUN_NAMESPACE | typeof COORDINATION_GROUP_NAMESPACE | typeof COORDINATION_ATTEMPT_NAMESPACE | typeof COORDINATION_CONTROL_NAMESPACE;
export type CreateCoordinationRunInput = Omit<CoordinationRunV2, keyof VersionedEntity | 'groupId' | 'initiatedBy' | 'membershipStreamVersion' | 'status'> & { readonly id: string };
export interface AdmitCoordinatedTurnInput {
  readonly runId: string; readonly expectedStreamVersion: number; readonly nodeId: string; readonly attempt: number;
  readonly message: string; readonly preparedMessage?: SubmitTurnInput['preparedMessage']; readonly threadResourceRef?: ResourceRef;
}
export interface CoordinationAdmission { readonly run: CoordinationRunV2; readonly attempt: CoordinationAttemptV2; readonly execution: Execution; readonly thread: Thread }
export interface CompleteCoordinationControlInput {
  readonly runId: string; readonly expectedStreamVersion: number; readonly nodeId: string;
  readonly decision: 'approved' | 'rejected'; readonly evidenceDigest: string;
}
export interface CoordinationKernelPorts {
  readonly now: () => string;
  readonly createThread: (tx: KernelTransaction, tenantId: string, actorId: string, key: string, input: { id?: string; workspaceId: string; subject: string; pluginId: string; resourceRef?: ResourceRef }) => Thread;
  readonly submitTurn: (tx: KernelTransaction, tenantId: string, actorId: string, key: string, input: SubmitTurnInput) => Execution;
  readonly cancelExecution: (tx: KernelTransaction, tenantId: string, actorId: string, key: string, execution: Execution) => void;
}
function fail(code: string, message: string): never { throw new KernelError(code, message, '刷新计划、授权和执行状态后重试'); }
function copy<T>(value: T): T { return structuredClone(value); }
function assertText(value: string): void { if (typeof value !== 'string' || !value.trim() || value.length > 500) fail('COORDINATION_INVALID', '协调标识无效'); }
function checkBudget(value: CoordinationBudgetV2): void {
  if (!/^[A-Z]{3}$/.test(value.currency) || !Number.isSafeInteger(value.maxTokens) || value.maxTokens < 0
    || !/^(0|[1-9]\d{0,29})$/.test(value.maxCostMinorUnits)) fail('COORDINATION_BUDGET_INVALID', '协调预算无效');
}
function limits(input: CoordinationLimitsV2, ...stricter: (Partial<CoordinationLimitsV2> | undefined)[]): CoordinationLimitsV2 {
  const result = { ...HARD_LIMITS };
  for (const key of Object.keys(result) as (keyof CoordinationLimitsV2)[]) {
    for (const value of [input, ...stricter]) if (value?.[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || value[key]! < 1) fail('COORDINATION_LIMIT_INVALID', '协调限额无效');
      result[key] = Math.min(result[key], value[key]!);
    }
  }
  return result;
}
function member(tx: KernelTransaction, tenantId: string, workspaceId: string, actorId: string): WorkspaceMembership {
  const principal = tx.getProjection<Principal>('principal', actorId);
  const value = tx.getProjection<WorkspaceMembership>('membership', `${workspaceId}:${actorId}`);
  if (!principal || principal.tenantId !== tenantId || principal.disabledAt || !value || value.tenantId !== tenantId || value.workspaceId !== workspaceId
    || value.principalId !== actorId || value.removedAt || !['owner', 'operator'].includes(value.workspaceRole)) fail('COORDINATION_AUTHORIZATION_REVOKED', '协调授权已撤销');
  return value;
}
function write<T extends VersionedEntity & { readonly workspaceId: string }>(tx: KernelTransaction, namespace: Namespace, value: T, actorId: string, type: string): T {
  tx.putProjection(namespace, value.id, value);
  appendKernelEvent(tx, { tenantId: value.tenantId, aggregateType: namespace, aggregateId: value.id,
    expectedStreamVersion: value.streamVersion - 1, type, actorId, generation: 1, correlationId: `${value.id}:${value.streamVersion}`,
    publicPayload: { workspaceId: value.workspaceId } });
  return value;
}
function bumpRun(tx: KernelTransaction, run: CoordinationRunV2, actorId: string, now: string, status = run.status): CoordinationRunV2 {
  return write(tx, COORDINATION_RUN_NAMESPACE, { ...run, status, streamVersion: run.streamVersion + 1, updatedAt: now }, actorId, 'coordination.run_updated');
}
function attempts(tx: KernelTransaction, groupId: string): readonly CoordinationAttemptV2[] {
  return tx.listProjections<CoordinationAttemptV2>(COORDINATION_ATTEMPT_NAMESPACE).filter(item => item.groupId === groupId);
}
function current(tx: KernelTransaction, tenantId: string, actorId: string, runId: string, version?: number, allowPaused = false): { run: CoordinationRunV2; group: CoordinationGroupV2 } {
  const run = tx.getProjection<CoordinationRunV2>(COORDINATION_RUN_NAMESPACE, runId);
  if (!run || run.tenantId !== tenantId) fail('COORDINATION_NOT_FOUND', '协调计划不存在');
  const membership = member(tx, tenantId, run.workspaceId, actorId);
  if (actorId !== run.initiatedBy || membership.streamVersion !== run.membershipStreamVersion) fail('COORDINATION_AUTHORIZATION_CHANGED', '协调授权版本已变化');
  if (version !== undefined && run.streamVersion !== version) throw new StreamVersionConflictError(version, run.streamVersion);
  const group = tx.getProjection<CoordinationGroupV2>(COORDINATION_GROUP_NAMESPACE, run.groupId);
  if (!group || group.tenantId !== tenantId || group.workspaceId !== run.workspaceId || group.currentRunId !== run.id
    || (run.status !== 'active' && !(allowPaused && run.status === 'paused'))) fail('COORDINATION_STALE', '协调计划已停止或修订已失效');
  return { run, group };
}
function dependencyComplete(tx: KernelTransaction, run: CoordinationRunV2, id: string): boolean {
  const node = run.nodes.find(item => item.id === id);
  if (!node) return false;
  if (node.kind && node.kind !== 'agent') return tx.getProjection<CoordinationControlV2>(COORDINATION_CONTROL_NAMESPACE, `${run.id}:${id}`)?.decision === 'approved';
  const latest = attempts(tx, run.groupId).filter(item => item.runId === run.id && item.nodeId === id).sort((a, b) => b.ordinal - a.ordinal)[0];
  const execution = latest && tx.getProjection<Execution>('execution', latest.executionId);
  return latest?.status === 'completed' && latest.reservation.status === 'settled' && execution?.status === 'completed'
    && execution.generation === latest.generation && !hasUnsettledToolCalls(tx, execution.id);
}
function assertDependencies(tx: KernelTransaction, run: CoordinationRunV2, node: CoordinationNodeV2): void {
  if (!node.dependsOn.every(id => dependencyComplete(tx, run, id))) fail('COORDINATION_DEPENDENCY_PENDING', '节点依赖尚未完成或费用待核对');
}
function intersectScopes(parent: readonly ResourceRef[], role: readonly ResourceRef[]): ResourceRef[] {
  const matches: ResourceRef[] = [];
  for (const p of parent) for (const r of role) {
    if (p.namespace !== r.namespace || (p.resourceId !== '*' && r.resourceId !== '*' && p.resourceId !== r.resourceId)
      || (p.digest && r.digest && p.digest !== r.digest)) continue;
    const candidate = { namespace: p.namespace, resourceId: p.resourceId === '*' ? r.resourceId : p.resourceId, ...(p.digest || r.digest ? { digest: p.digest ?? r.digest } : {}) };
    if (!matches.some(item => sha256(item) === sha256(candidate))) matches.push(candidate);
  }
  return matches;
}
function intersect(parent: CoordinationAuthorityV2, role: CoordinationAuthorityV2): CoordinationAuthorityV2 {
  return { toolIds: [...new Set(role.toolIds.filter(id => parent.toolIds.includes(id)))], dataScopes: intersectScopes(parent.dataScopes, role.dataScopes),
    autoAllowedEffects: [...new Set(role.autoAllowedEffects.filter(effect => parent.autoAllowedEffects.includes(effect)))] };
}
function wake(tx: KernelTransaction, run: CoordinationRunV2, causeId: string, actorId: string, now: string): void {
  const group = tx.getProjection<CoordinationGroupV2>(COORDINATION_GROUP_NAMESPACE, run.groupId);
  if (group?.currentRunId !== run.id || !['active', 'paused'].includes(run.status)) return;
  const id = `coordination-wake:${causeId}`;
  appendKernelEvent(tx, { tenantId: run.tenantId, aggregateType: 'coordination.wake', aggregateId: id, expectedStreamVersion: 0,
    type: 'coordination.wake_requested', actorId, generation: 1, correlationId: id,
    publicPayload: { workspaceId: run.workspaceId, runId: run.id, revisionId: run.revisionId } });
  tx.putOutbox({ id, tenantId: run.tenantId, topic: 'coordination.wake', availableAt: now,
    payload: { workspaceId: run.workspaceId, runId: run.id, revisionId: run.revisionId } });
}

export class KernelCoordination {
  constructor(private readonly ports: CoordinationKernelPorts) {}
  create(tx: KernelTransaction, tenantId: string, actorId: string, input: CreateCoordinationRunInput): CoordinationRunV2 {
    const now = this.ports.now();
    for (const text of [input.id, input.workspaceId, input.threadId, input.aggregateType, input.aggregateId, input.revisionId, input.revisionDigest]) assertText(text);
    const membership = member(tx, tenantId, input.workspaceId, actorId);
    const workspace = tx.getProjection<Workspace>('workspace', input.workspaceId), thread = tx.getProjection<Thread>('thread', input.threadId);
    if (!workspace || workspace.tenantId !== tenantId || !thread || thread.tenantId !== tenantId || thread.workspaceId !== input.workspaceId) fail('COORDINATION_SCOPE_INVALID', '协调会话不属于当前工作区');
    if (tx.getProjection(COORDINATION_RUN_NAMESPACE, input.id)) fail('COORDINATION_EXISTS', '协调计划已存在');
    if (!Number.isFinite(Date.parse(input.deadlineAt)) || Date.parse(input.deadlineAt) <= Date.parse(now)) fail('COORDINATION_DEADLINE_INVALID', '协调期限无效或已到期');
    if (!input.budgets.length || input.budgets.length > 10 || new Set(input.budgets.map(b => b.currency)).size !== input.budgets.length) fail('COORDINATION_BUDGET_INVALID', '协调预算币种重复或缺失');
    input.budgets.forEach(checkBudget);
    const groupId = `coordination-group:${sha256({ tenantId, workspaceId: input.workspaceId, aggregateType: input.aggregateType, aggregateId: input.aggregateId })}`;
    const previous = tx.getProjection<CoordinationGroupV2>(COORDINATION_GROUP_NAMESPACE, groupId);
    const policy = tx.getProjection<{ limits: Partial<CoordinationLimitsV2> }>(COORDINATION_POLICY_NAMESPACE, input.workspaceId);
    const bound = limits(input.limits, previous?.limits, policy?.limits);
    if (!input.nodes.length || input.nodes.length > bound.maxNodes || new Set(input.nodes.map(n => n.id)).size !== input.nodes.length) fail('COORDINATION_NODES_INVALID', '协调节点缺失、重复或超过限额');
    const nodeIds = [...new Set([...(previous?.nodeIds ?? []), ...input.nodes.map(n => n.id)])];
    if (nodeIds.length > bound.maxNodes) fail('COORDINATION_NODE_LIMIT', '累计协调节点超过限额');
    for (const node of input.nodes) {
      assertText(node.id); checkBudget(node.budget);
      if (node.kind !== undefined && !['agent', 'human_decision', 'join'].includes(node.kind)) fail('COORDINATION_NODE_INVALID', '协调节点类型无效');
      if (!workspace.activePluginIds.includes(node.pluginId) || !input.budgets.some(b => b.currency === node.budget.currency)
        || node.dependsOn.some(id => id === node.id || !input.nodes.some(n => n.id === id)) || new Set(node.dependsOn).size !== node.dependsOn.length) fail('COORDINATION_NODE_INVALID', '节点配置、币种或依赖无效');
    }
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string): void => { if (visiting.has(id)) fail('COORDINATION_CYCLE', '协调计划存在循环依赖'); if (visited.has(id)) return;
      visiting.add(id); input.nodes.find(n => n.id === id)!.dependsOn.forEach(visit); visiting.delete(id); visited.add(id); };
    input.nodes.forEach(n => visit(n.id));
    if (previous) {
      if (Date.parse(input.deadlineAt) > Date.parse(previous.deadlineAt)) fail('COORDINATION_DEADLINE_EXTENDED', '新修订不能延长累计期限');
      if (input.budgets.length !== previous.budgets.length || input.budgets.some(b => { const prior = previous.budgets.find(p => p.currency === b.currency); return !prior || b.maxTokens > prior.maxTokens || BigInt(b.maxCostMinorUnits) > BigInt(prior.maxCostMinorUnits); })) fail('COORDINATION_BUDGET_EXPANDED', '新修订不能重置或扩大累计预算');
      const old = tx.getProjection<CoordinationRunV2>(COORDINATION_RUN_NAMESPACE, previous.currentRunId);
      if (!old || old.initiatedBy !== actorId) fail('COORDINATION_AUTHORIZATION_CHANGED', '协调计划需要原发起人重新授权');
      if (old.status !== 'superseded') this.command(tx, tenantId, actorId, old.id, old.streamVersion, 'superseded');
    }
    const group: CoordinationGroupV2 = { id: groupId, tenantId, workspaceId: input.workspaceId, aggregateType: input.aggregateType, aggregateId: input.aggregateId,
      currentRunId: input.id, budgets: copy(input.budgets), limits: bound, nodeIds, deadlineAt: input.deadlineAt, streamVersion: (previous?.streamVersion ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
    write(tx, COORDINATION_GROUP_NAMESPACE, group, actorId, 'coordination.group_updated');
    return write(tx, COORDINATION_RUN_NAMESPACE, { ...copy(input), groupId, tenantId, limits: bound, initiatedBy: actorId, membershipStreamVersion: membership.streamVersion,
      status: 'active', streamVersion: 1, createdAt: now, updatedAt: now }, actorId, 'coordination.run_created');
  }

  admit(tx: KernelTransaction, tenantId: string, actorId: string, input: AdmitCoordinatedTurnInput): CoordinationAdmission {
    const { run, group } = current(tx, tenantId, actorId, input.runId, input.expectedStreamVersion);
    const now = this.ports.now();
    if (Date.parse(now) >= Date.parse(group.deadlineAt)) fail('COORDINATION_EXPIRED', '协调期限已到期');
    const node = run.nodes.find(n => n.id === input.nodeId);
    if (!node || (node.kind && node.kind !== 'agent')) fail('COORDINATION_NODE_INVALID', '该节点需要人工决定或控制节点完成操作');
    const records = attempts(tx, group.id);
    if (records.some(a => { const e = tx.getProjection<Execution>('execution', a.executionId); return !e || e.status === 'needs_reconciliation' || hasUnsettledToolCalls(tx, a.executionId); })) fail('COORDINATION_RECONCILIATION_REQUIRED', '原执行结果未知，须先核对');
    const prior = records.filter(a => a.runId === run.id && a.nodeId === node.id).sort((a, b) => b.ordinal - a.ordinal)[0];
    if (!Number.isSafeInteger(input.attempt) || input.attempt !== (prior?.ordinal ?? 0) + 1
      || (prior && (prior.status !== 'failed' || prior.reservation.status !== 'settled'))) fail('COORDINATION_ATTEMPT_EXISTS', '节点已派发、已完成或仍需核对，不能重复尝试');
    assertDependencies(tx, run, node);
    const policy = tx.getProjection<{ limits: Partial<CoordinationLimitsV2> }>(COORDINATION_POLICY_NAMESPACE, run.workspaceId);
    const bound = limits(run.limits, group.limits, policy?.limits);
    if (records.length >= bound.maxAttempts) fail('COORDINATION_ATTEMPT_LIMIT', '累计节点尝试超过限额');
    const active = records.filter(a => { const e = tx.getProjection<Execution>('execution', a.executionId); return e && !['completed', 'failed', 'cancelled'].includes(e.status); });
    if (active.length >= bound.maxParallel) fail('COORDINATION_PARALLEL_LIMIT', '并行节点达到限额');
    const cap = group.budgets.find(b => b.currency === node.budget.currency)!;
    let tokens = 0n, cost = 0n;
    for (const a of records.filter(a => a.reservation.budget.currency === cap.currency)) {
      tokens += BigInt(a.reservation.usage?.tokens ?? a.reservation.budget.maxTokens);
      cost += BigInt(a.reservation.usage?.costMinorUnits ?? a.reservation.budget.maxCostMinorUnits);
    }
    if (tokens + BigInt(node.budget.maxTokens) > BigInt(cap.maxTokens) || cost + BigInt(node.budget.maxCostMinorUnits) > BigInt(cap.maxCostMinorUnits)) fail('COORDINATION_BUDGET_EXCEEDED', '累计预算不足，未知费用仍保留预留');
    const attemptId = `coordination-attempt:${sha256({ runId: run.id, revisionId: run.revisionId, nodeId: node.id, ordinal: input.attempt })}`;
    if (tx.getProjection(COORDINATION_ATTEMPT_NAMESPACE, attemptId)) fail('COORDINATION_ATTEMPT_EXISTS', '节点尝试已存在');
    const threadId = coordinationThreadId(run.id, node.id, input.attempt);
    if (input.preparedMessage) {
      const key = input.preparedMessage.keyRecord as { id?: string; workspaceId?: string; ownerType?: string; ownerId?: string; context?: { tenantId?: string; purpose?: string } };
      if (key.id !== input.preparedMessage.protectedPayloadRef || key.workspaceId !== run.workspaceId || key.ownerType !== 'thread' || key.ownerId !== threadId
        || key.context?.tenantId !== tenantId || key.context.purpose !== `thread:${threadId}`) fail('COORDINATION_INPUT_INVALID', '节点受保护输入不属于当前成员会话');
    }
    const thread = this.ports.createThread(tx, tenantId, actorId, attemptId, { id: threadId, workspaceId: run.workspaceId, subject: node.id, pluginId: node.pluginId,
      ...(input.threadResourceRef ? { resourceRef: input.threadResourceRef } : {}) });
    const authority = intersect(run.grant, node.role);
    const binding: CoordinationBindingV2 = { aggregateType: run.aggregateType, aggregateId: run.aggregateId, revisionId: run.revisionId, runId: run.id, nodeId: node.id, attemptId };
    const execution = this.ports.submitTurn(tx, tenantId, actorId, attemptId, { coordination: binding, workspaceId: run.workspaceId, threadId: thread.id, expectedStreamVersion: thread.streamVersion,
      message: input.message, ...(input.preparedMessage ? { preparedMessage: input.preparedMessage } : {}), agentDefinitionId: node.agentDefinitionId, modelBindingId: node.modelBindingId,
      executionPrincipalId: `agent:${node.pluginId}`, ...(node.runnerId ? { runnerId: node.runnerId } : {}), ...(node.pluginPackageSha256 ? { pluginPackageSha256: node.pluginPackageSha256 } : {}),
      authority: { ...authority, workspaceId: run.workspaceId, principalId: `agent:${node.pluginId}`, budget: { ...node.budget, maxSubagents: 0, maxSubagentDepth: 0, maxDurationMs: Date.parse(group.deadlineAt) - Date.parse(now) } } });
    const job = tx.listProjections<Job>('job').find(j => j.payload.executionId === execution.id);
    if (!job) fail('COORDINATION_JOB_MISSING', '节点执行缺少持久任务');
    const { preparedMessage: _prepared, ...digestInput } = input;
    const attempt: CoordinationAttemptV2 = { id: attemptId, tenantId, workspaceId: run.workspaceId, groupId: group.id, runId: run.id, revisionId: run.revisionId, nodeId: node.id, ordinal: input.attempt,
      executionId: execution.id, generation: execution.generation, threadId: thread.id, jobId: job.id, requestDigest: sha256(digestInput), status: 'queued',
      reservation: { budget: copy(node.budget), status: 'reserved' }, streamVersion: 1, createdAt: now, updatedAt: now };
    write(tx, COORDINATION_ATTEMPT_NAMESPACE, attempt, actorId, 'coordination.attempt_admitted');
    return { run: bumpRun(tx, run, actorId, now), attempt, execution, thread };
  }

  control(tx: KernelTransaction, tenantId: string, actorId: string, input: CompleteCoordinationControlInput): CoordinationControlV2 {
    const { run, group } = current(tx, tenantId, actorId, input.runId, input.expectedStreamVersion);
    const now = this.ports.now(), node = run.nodes.find(n => n.id === input.nodeId);
    if (Date.parse(now) >= Date.parse(group.deadlineAt)) fail('COORDINATION_EXPIRED', '协调期限已到期');
    if (!node || !node.kind || node.kind === 'agent') fail('COORDINATION_CONTROL_INVALID', '该节点不是控制节点');
    assertDependencies(tx, run, node);
    if (!['approved', 'rejected'].includes(input.decision) || !/^[a-f\d]{64}$/.test(input.evidenceDigest)) fail('COORDINATION_CONTROL_INVALID', '控制决定缺少有效证据摘要');
    const id = `${run.id}:${node.id}`;
    if (tx.getProjection(COORDINATION_CONTROL_NAMESPACE, id)) fail('COORDINATION_CONTROL_EXISTS', '该控制节点已有固定决定');
    const evidenceDigest = node.kind === 'join' ? sha256(node.dependsOn.map(dep => ({ nodeId: dep, complete: dependencyComplete(tx, run, dep) }))) : input.evidenceDigest;
    if (node.kind === 'join' && input.decision !== 'approved') fail('COORDINATION_CONTROL_INVALID', '汇合节点只能由完成的依赖推进');
    const result = write(tx, COORDINATION_CONTROL_NAMESPACE, { id, tenantId, workspaceId: run.workspaceId, runId: run.id, revisionId: run.revisionId, nodeId: node.id,
      kind: node.kind, decision: input.decision, decidedBy: actorId, evidenceDigest, streamVersion: 1, createdAt: now, updatedAt: now }, actorId, 'coordination.control_completed');
    bumpRun(tx, run, actorId, now); wake(tx, run, `${id}:1`, actorId, now); return result;
  }

  command(tx: KernelTransaction, tenantId: string, actorId: string, runId: string, version: number, status: 'active' | 'paused' | 'cancelled' | 'superseded'): CoordinationRunV2 {
    const { run } = current(tx, tenantId, actorId, runId, version, true);
    const now = this.ports.now();
    if (status === 'cancelled' || status === 'superseded') for (const attempt of attempts(tx, run.groupId).filter(a => a.runId === run.id)) {
      const execution = tx.getProjection<Execution>('execution', attempt.executionId);
      if (execution && !['completed', 'failed', 'cancelled'].includes(execution.status)) this.ports.cancelExecution(tx, tenantId, actorId, `${run.id}:${status}:${attempt.id}`, execution);
    }
    return bumpRun(tx, run, actorId, now, status);
  }
}

export function assertCurrentCoordinationAuthorization(tx: KernelTransaction, execution: Execution, now?: string): void {
  const attempt = tx.listProjections<CoordinationAttemptV2>(COORDINATION_ATTEMPT_NAMESPACE).find(a => a.executionId === execution.id);
  const jobs = tx.listProjections<Job>('job').filter(j => j.payload.executionId === execution.id);
  const binding = jobs.map(j => j.payload.coordination as unknown as CoordinationBindingV2 | undefined).find(b => b?.runId);
  if (!attempt && !binding) return;
  if (!attempt || !binding || attempt.id !== binding.attemptId || attempt.runId !== binding.runId || attempt.nodeId !== binding.nodeId || attempt.revisionId !== binding.revisionId
    || attempt.tenantId !== execution.tenantId || attempt.workspaceId !== execution.workspaceId || attempt.threadId !== execution.threadId || attempt.generation !== execution.generation) fail('COORDINATION_BINDING_INVALID', '节点执行绑定不完整');
  const { run, group } = current(tx, execution.tenantId, execution.initiatedBy, attempt.runId, undefined, true);
  if (now && Date.parse(now) >= Date.parse(group.deadlineAt)) fail('COORDINATION_EXPIRED', '协调期限已到期');
  const node = run.nodes.find(n => n.id === attempt.nodeId), authority = tx.getProjection<ExecutionAuthority>('authority', execution.authorityId);
  const workspace = tx.getProjection<Workspace>('workspace', execution.workspaceId);
  if (!node || !authority || execution.agentDefinitionId !== node.agentDefinitionId || execution.modelBindingId !== node.modelBindingId || execution.pluginId !== node.pluginId
    || !workspace || workspace.tenantId !== execution.tenantId || !workspace.activePluginIds.includes(node.pluginId)
    || execution.runnerId !== node.runnerId || execution.pluginPackageSha256 !== node.pluginPackageSha256
    || sha256(intersect(run.grant, node.role)) !== sha256({ toolIds: authority.toolIds, dataScopes: authority.dataScopes, autoAllowedEffects: authority.autoAllowedEffects })
    || sha256(attempt.reservation.budget) !== sha256(node.budget)
    || authority.budget.currency !== node.budget.currency || authority.budget.maxTokens !== node.budget.maxTokens
    || authority.budget.maxCostMinorUnits !== node.budget.maxCostMinorUnits || authority.budget.maxSubagents !== 0 || authority.budget.maxSubagentDepth !== 0
    || authority.budget.maxDurationMs !== Date.parse(run.deadlineAt) - Date.parse(attempt.createdAt)) fail('COORDINATION_AUTHORITY_CHANGED', '节点配置、预算或权限与固定计划不一致');
  assertCurrentExecutionAuthorization(tx, execution);
}

export function settleCoordinatedTurnInTransaction(tx: KernelTransaction, tenantId: string, input: KernelJobSettlement): KernelJobSettlementReceipt {
  if (!tx.settleJob) fail('COORDINATION_SETTLEMENT_UNAVAILABLE', '存储不支持事务内任务终结');
  const job = tx.getProjection<Job>('job', input.jobId);
  if (!job || job.tenantId !== tenantId) fail('COORDINATION_JOB_MISSING', '节点任务不存在');
  const binding = job.payload.coordination as unknown as CoordinationBindingV2 | undefined;
  if (!binding?.runId) return tx.settleJob(input);
  const attempt = binding.attemptId && tx.getProjection<CoordinationAttemptV2>(COORDINATION_ATTEMPT_NAMESPACE, binding.attemptId);
  const run = tx.getProjection<CoordinationRunV2>(COORDINATION_RUN_NAMESPACE, binding.runId);
  const execution = attempt && tx.getProjection<Execution>('execution', attempt.executionId);
  if (!attempt || !run || !execution || attempt.tenantId !== tenantId || run.tenantId !== tenantId || attempt.runId !== run.id || attempt.jobId !== job.id
    || attempt.executionId !== job.payload.executionId || execution.generation !== attempt.generation || attempt.revisionId !== binding.revisionId) fail('COORDINATION_BINDING_INVALID', '节点终结绑定无效');
  if (!tx.assertJobLease) fail('COORDINATION_SETTLEMENT_UNAVAILABLE', '存储不支持事务内租约校验');
  tx.assertJobLease(input);
  const value = typeof input.value === 'object' && input.value !== null && !Array.isArray(input.value) ? input.value as Record<string, unknown> : undefined;
  const code = execution.status === 'cancelled' ? 'EXECUTION_CANCELLED' : execution.status === 'needs_reconciliation' ? 'UNKNOWN_EXTERNAL_SIDE_EFFECT'
    : execution.status === 'interrupted' ? 'EXECUTION_INTERRUPTED' : ['EXECUTION_CANCELLED', 'UNKNOWN_EXTERNAL_SIDE_EFFECT', 'EXECUTION_INTERRUPTED'].includes(String(value?.code)) ? String(value!.code) : 'JOB_EXECUTION_FAILED';
  const outcome = ['cancelled', 'interrupted', 'needs_reconciliation'].includes(execution.status) ? 'failed' : input.outcome;
  input = { ...input, outcome, value: outcome === 'completed' ? { executionId: execution.id, status: value?.status === 'paused' ? 'paused' : 'completed' }
    : { executionId: execution.id, code, retryable: false } };
  if (hasUnsettledToolCalls(tx, execution.id) && execution.status !== 'needs_reconciliation') {
    interruptCoordinatedExecutionInTransaction(tx, tenantId, input, 'needs_reconciliation');
    input = { ...input, outcome: 'failed', value: { code: 'UNKNOWN_EXTERNAL_SIDE_EFFECT', retryable: false, executionId: execution.id } };
  }
  const receipt = tx.settleJob(input);
  const live = tx.getProjection<Execution>('execution', execution.id)!;
  const status = live.status === 'needs_reconciliation' || hasUnsettledToolCalls(tx, live.id) ? 'needs_reconciliation'
    : live.status === 'cancelled' ? 'cancelled' : live.status === 'paused' ? 'paused' : live.status === 'interrupted' ? 'interrupted' : input.outcome;
  const next = write(tx, COORDINATION_ATTEMPT_NAMESPACE, { ...attempt, status, streamVersion: attempt.streamVersion + 1, updatedAt: input.occurredAt }, `worker:${input.workerId}`, `coordination.attempt_${status}`);
  bumpRun(tx, run, `worker:${input.workerId}`, input.occurredAt);
  wake(tx, run, `${next.id}:${next.streamVersion}`, `worker:${input.workerId}`, input.occurredAt);
  return receipt;
}

/** Called only while the physical lease is held; no output content enters the receipt. */
export function interruptCoordinatedExecutionInTransaction(tx: KernelTransaction, tenantId: string, input: Pick<KernelJobSettlement, 'jobId' | 'workerId' | 'fencingToken' | 'occurredAt'>,
  status: 'interrupted' | 'needs_reconciliation'): void {
  if (!tx.assertJobLease) fail('COORDINATION_SETTLEMENT_UNAVAILABLE', '存储不支持事务内租约校验');
  tx.assertJobLease(input);
  const job = tx.getProjection<Job>('job', input.jobId);
  const binding = job?.payload.coordination as unknown as CoordinationBindingV2 | undefined;
  const execution = typeof job?.payload.executionId === 'string' ? tx.getProjection<Execution>('execution', job.payload.executionId) : undefined;
  if (!job || job.tenantId !== tenantId || !binding?.runId || !execution || execution.tenantId !== tenantId || execution.workspaceId !== job.workspaceId) fail('COORDINATION_BINDING_INVALID', '节点中断绑定无效');
  if (execution.status === status) return;
  if (status === 'interrupted' && (execution.status === 'needs_reconciliation' || hasUnsettledToolCalls(tx, execution.id))) status = 'needs_reconciliation';
  if (status === 'interrupted' && ['completed', 'failed', 'cancelled', 'paused'].includes(execution.status)) return;
  tx.putProjection('execution', execution.id, { ...execution, status, ...(status === 'needs_reconciliation' ? { failureCode: 'UNKNOWN_EXTERNAL_SIDE_EFFECT' } : {}),
    streamVersion: execution.streamVersion + 1, updatedAt: input.occurredAt });
  if (status === 'needs_reconciliation') {
    const id = `reconciliation:${execution.id}:${job.id}`;
    tx.putProjection('inbox', id, { id, tenantId, workspaceId: execution.workspaceId, executionId: execution.id, kind: 'reconciliation',
      title: '外部操作结果需要人工核对', summary: '核对现有证据后处理，禁止自动重试。', risk: 'unknown', resourceSummary: job.id, status: 'open', createdAt: input.occurredAt });
  }
  appendKernelEvent(tx, { tenantId, aggregateType: 'execution', aggregateId: execution.id, expectedStreamVersion: execution.streamVersion,
    type: `execution.${status}`, actorId: `worker:${input.workerId}`, executionId: execution.id, generation: execution.generation,
    correlationId: `coordination:${job.id}:${input.fencingToken}`, publicPayload: { workspaceId: execution.workspaceId, jobId: job.id, status } });
}

export function settleCoordinationUsageInTransaction(tx: KernelTransaction, tenantId: string, actorId: string, input: {
  readonly attemptId: string; readonly expectedStreamVersion: number; readonly usage: { readonly currency: string; readonly tokens: number; readonly costMinorUnits: string }; readonly occurredAt: string;
}): CoordinationAttemptV2 {
  const attempt = tx.getProjection<CoordinationAttemptV2>(COORDINATION_ATTEMPT_NAMESPACE, input.attemptId);
  if (!attempt || attempt.tenantId !== tenantId) fail('COORDINATION_ATTEMPT_MISSING', '节点尝试不存在');
  if (attempt.streamVersion !== input.expectedStreamVersion) throw new StreamVersionConflictError(input.expectedStreamVersion, attempt.streamVersion);
  checkBudget({ currency: input.usage.currency, maxTokens: input.usage.tokens, maxCostMinorUnits: input.usage.costMinorUnits });
  if (attempt.reservation.budget.currency !== input.usage.currency) fail('COORDINATION_CURRENCY_CHANGED', '节点费用币种不一致');
  const execution = tx.getProjection<Execution>('execution', attempt.executionId);
  const job = tx.getProjection<Job>('job', attempt.jobId), run = tx.getProjection<CoordinationRunV2>(COORDINATION_RUN_NAMESPACE, attempt.runId);
  const binding = job?.payload.coordination as unknown as CoordinationBindingV2 | undefined;
  if (!execution || !job || !run || execution.tenantId !== tenantId || job.tenantId !== tenantId || run.tenantId !== tenantId
    || execution.workspaceId !== attempt.workspaceId || job.workspaceId !== attempt.workspaceId || run.workspaceId !== attempt.workspaceId
    || execution.threadId !== attempt.threadId || execution.generation !== attempt.generation || job.payload.executionId !== execution.id
    || attempt.revisionId !== run.revisionId || binding?.attemptId !== attempt.id || binding.runId !== run.id || binding.nodeId !== attempt.nodeId
    || binding.revisionId !== run.revisionId || binding.aggregateType !== run.aggregateType || binding.aggregateId !== run.aggregateId) fail('COORDINATION_BINDING_INVALID', '节点计量绑定或执行版本无效');
  if (!['completed', 'failed'].includes(job.status) || !['completed', 'failed', 'cancelled', 'interrupted', 'paused'].includes(execution.status)
    || hasUnsettledToolCalls(tx, execution.id)) fail('COORDINATION_USAGE_PENDING', '节点物理任务未终结或结果仍需核对');
  let pendingModels = 0;
  for (const record of tx.getProjection<{ records: readonly { type: string }[] }>('agent-runtime', execution.id)?.records ?? []) {
    if (record.type === 'model/reserved') pendingModels++;
    if (record.type === 'model/settled' && --pendingModels < 0) fail('COORDINATION_USAGE_PENDING', '节点模型计量顺序无效，仍需核对');
  }
  if (pendingModels) fail('COORDINATION_USAGE_PENDING', '节点模型计量未知，仍需核对');
  if (attempt.reservation.status === 'settled') {
    if (sha256(attempt.reservation.usage) !== sha256(input.usage)) fail('COORDINATION_USAGE_CONFLICT', '节点已有不同费用结算');
    return attempt;
  }
  const next = write(tx, COORDINATION_ATTEMPT_NAMESPACE, { ...attempt, reservation: { ...attempt.reservation, status: 'settled' as const, usage: copy(input.usage) }, streamVersion: attempt.streamVersion + 1, updatedAt: input.occurredAt }, actorId, 'coordination.usage_settled');
  bumpRun(tx, run, actorId, input.occurredAt); wake(tx, run, `${next.id}:${next.streamVersion}`, actorId, input.occurredAt);
  return next;
}

/** Recover metadata after the storage lease sweeper has already settled a Job. */
export function reconcileCoordinationAttemptInTransaction(tx: KernelTransaction, tenantId: string, actorId: string, input: {
  readonly attemptId: string; readonly expectedStreamVersion: number; readonly occurredAt: string;
}): CoordinationAttemptV2 {
  const attempt = tx.getProjection<CoordinationAttemptV2>(COORDINATION_ATTEMPT_NAMESPACE, input.attemptId);
  if (!attempt || attempt.tenantId !== tenantId) fail('COORDINATION_ATTEMPT_MISSING', '节点尝试不存在');
  if (attempt.streamVersion !== input.expectedStreamVersion) throw new StreamVersionConflictError(input.expectedStreamVersion, attempt.streamVersion);
  const execution = tx.getProjection<Execution>('execution', attempt.executionId), job = tx.getProjection<Job>('job', attempt.jobId);
  const run = tx.getProjection<CoordinationRunV2>(COORDINATION_RUN_NAMESPACE, attempt.runId);
  const binding = job?.payload.coordination as unknown as CoordinationBindingV2 | undefined;
  if (!run || run.tenantId !== tenantId || !execution || execution.tenantId !== tenantId || !job || job.tenantId !== tenantId
    || run.workspaceId !== attempt.workspaceId || execution.workspaceId !== attempt.workspaceId || job.workspaceId !== attempt.workspaceId
    || binding?.attemptId !== attempt.id || binding.runId !== run.id || binding.revisionId !== attempt.revisionId
    || job.payload.executionId !== execution.id || execution.generation !== attempt.generation) fail('COORDINATION_BINDING_INVALID', '节点恢复绑定无效');
  if (job.status === 'available' || job.status === 'leased') return attempt;
  if (!['completed', 'failed', 'cancelled', 'paused', 'interrupted', 'needs_reconciliation'].includes(execution.status)) fail('COORDINATION_RECOVERY_PENDING', '节点执行与任务终态不一致，须先核对');
  const status = hasUnsettledToolCalls(tx, execution.id) ? 'needs_reconciliation' : execution.status as Exclude<CoordinationAttemptV2['status'], 'queued'>;
  if (attempt.status === status) return attempt;
  const next = write(tx, COORDINATION_ATTEMPT_NAMESPACE, { ...attempt, status, streamVersion: attempt.streamVersion + 1, updatedAt: input.occurredAt }, actorId, `coordination.attempt_${status}`);
  bumpRun(tx, run, actorId, input.occurredAt); wake(tx, run, `${next.id}:${next.streamVersion}`, actorId, input.occurredAt);
  return next;
}
