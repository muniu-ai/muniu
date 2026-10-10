// SPDX-License-Identifier: Apache-2.0
import type { Asset, Execution, ExecutionContextV2, GoalResourceRefV2, MemoryRecord, ShareGrant } from '@mn/contracts';
import { appendKernelEvent, KernelError, sha256, type KernelTransaction } from '@mn/kernel';

export type ContextSourceValidator = (tx: KernelTransaction, scope: { tenantId: string; workspaceId: string }, ref: GoalResourceRefV2) => boolean;

export const EXECUTION_CONTEXT_NAMESPACE = 'execution.context';
export function assertMemoryOriginExecution(tx: KernelTransaction, scope: { tenantId: string; workspaceId: string }, binding: { executionId: string; generation: number }): Execution {
  const source = tx.getProjection<Execution>('execution', binding.executionId);
  const runtime = source && tx.getProjection<{ records: readonly { type: string; protectedPayloadRef?: string }[] }>('agent-runtime', source.id);
  if (!source || source.tenantId !== scope.tenantId || source.workspaceId !== scope.workspaceId || source.status !== 'completed'
    || source.generation !== binding.generation || !runtime
    || !['model/request', 'model/response'].every(type => runtime.records.some(record => record.type === type && record.protectedPayloadRef))
    || runtime.records.some(record => record.protectedPayloadRef && !tx.getProjection('protectedPayloadKey', record.protectedPayloadRef)))
    throw new KernelError('CONTEXT_SOURCE_REVOKED', '记忆的原执行已失效', '重新选择原始来源');
  return source;
}
// A leaf Host validator may re-enter this public function for memory or skill sources.
const nestedSourceChecks = new WeakMap<KernelTransaction, Set<string>>();
const sourceValidatorIds = new WeakMap<ContextSourceValidator, number>();
let nextSourceValidatorId = 0;
export function assertContextSource(tx: KernelTransaction, scope: { tenantId: string; workspaceId: string }, ref: GoalResourceRefV2, validateSource?: ContextSourceValidator): void {
  if (validateSource && !sourceValidatorIds.has(validateSource)) sourceValidatorIds.set(validateSource, ++nextSourceValidatorId);
  const key = JSON.stringify([scope.tenantId, scope.workspaceId, ref.namespace, ref.resourceId, ref.streamVersion, ref.digest, validateSource ? sourceValidatorIds.get(validateSource) : 0]);
  const active = nestedSourceChecks.get(tx) ?? new Set<string>();
  if (active.has(key) || active.size >= 32) throw new KernelError('CONTEXT_INVALID', '跨模块资料来源形成循环或过深', '重新选择原始来源');
  nestedSourceChecks.set(tx, active); active.add(key);
  try { assertSource(tx, scope, ref, validateSource, new Set(), new Set()); }
  finally { active.delete(key); if (!active.size) nestedSourceChecks.delete(tx); }
}
function assertSource(tx: KernelTransaction, scope: { tenantId: string; workspaceId: string }, ref: GoalResourceRefV2,
  validateSource: ContextSourceValidator | undefined, ancestors: ReadonlySet<string>, checked: Set<string>): void {
  const identity = JSON.stringify(["source", ref.namespace, ref.resourceId, ref.streamVersion, ref.digest]);
  if (checked.has(identity)) return;
  if (checked.size >= 1024) throw new KernelError('CONTEXT_INVALID', '资料来源数量超过限额', '缩小资料范围');
  if (validateSource?.(tx, scope, ref)) { checked.add(identity); return; }
  const tombstone = ref.namespace === 'asset' || ref.namespace === 'memory'
    ? tx.getProjection<{workspaceId:string}>(`${ref.namespace}Tombstone`, ref.resourceId) : undefined;
  if (tombstone?.workspaceId === scope.workspaceId) throw new KernelError('CONTEXT_SOURCE_REVOKED', '资料或记忆已删除', '重新选择有效来源');
  const value = tx.getProjection<{ tenantId?: string; workspaceId: string; streamVersion: number; digest?: string; protected?: boolean; protectedPayloadRef?: string }>(ref.namespace, ref.resourceId);
  if (ref.namespace === 'coding.execution') {
    const execution = tx.getProjection<Execution>('execution', ref.resourceId);
    const run = value as unknown as { executionId?: string; generation?: number } | undefined;
    if (!value || !execution || execution.id !== ref.resourceId || execution.tenantId !== scope.tenantId || execution.workspaceId !== scope.workspaceId
      || run?.executionId !== execution.id || run.generation !== execution.generation || value.streamVersion !== ref.streamVersion || !ref.digest || ref.digest !== sha256(value)) {
      throw new KernelError('CONTEXT_SOURCE_CHANGED', '代码成果来源或版本已变化', '重新核对原执行与成果');
    }
    assertSources(tx, execution, validateSource, ancestors, checked);
    checked.add(identity);
    return;
  }
  const domain = ['opc.opportunity', 'coding.repository'].includes(ref.namespace);
  if (!value || value.workspaceId !== scope.workspaceId || (value.tenantId !== scope.tenantId && !(domain && value.tenantId === undefined))
    || value.streamVersion !== ref.streamVersion || !ref.digest || ref.digest !== (value.digest ?? sha256(value))) {
    throw new KernelError('CONTEXT_SOURCE_CHANGED', '资料来源或版本已变化', '重新选择有效资料并规划任务');
  }
  if (ref.namespace === 'execution.context') {
    const source = tx.getProjection<Execution>('execution', ref.resourceId);
    if (!source || source.tenantId !== scope.tenantId || source.workspaceId !== scope.workspaceId) throw new KernelError('CONTEXT_SOURCE_CHANGED', '原执行来源不可用', '重新核对来源');
    assertSources(tx, source, validateSource, ancestors, checked);
  }
  if (ref.namespace === 'memory') {
    const memory = value as MemoryRecord;
    const key = `memory:${ref.resourceId}`;
    if (ancestors.has(key) || ancestors.size >= 32) throw new KernelError('CONTEXT_INVALID', '记忆来源引用形成循环或过深', '重新选择原始来源');
    if (memory.status !== 'accepted' || (memory.expiresAt && (!Number.isFinite(Date.parse(memory.expiresAt)) || Date.parse(memory.expiresAt) <= Date.now()))
      || !memory.protectedPayloadRef || !tx.getProjection('protectedPayloadKey', memory.protectedPayloadRef))
      throw new KernelError('CONTEXT_SOURCE_REVOKED', '已采用的记忆失效或已撤回', '重新确认有效记忆后开始新任务');
    const path = new Set([...ancestors, key]);
    for (const source of memory.provenance?.sourceRefs ?? []) assertSource(tx, scope, source, validateSource, path, checked);
    if (memory.provenance?.sourceExecution) {
      const source = assertMemoryOriginExecution(tx, scope, memory.provenance.sourceExecution);
      assertSources(tx, source, validateSource, path, checked);
    }
  }
  if (ref.namespace === 'shareGrant' && (value as ShareGrant).revokedAt) throw new KernelError('CONTEXT_SOURCE_REVOKED', '记忆共享授权已撤回', '重新取得授权后开始新任务');
  if (ref.namespace === 'asset' && (tx.getProjection('assetTombstone', ref.resourceId)
    || (value.protected && (!value.protectedPayloadRef || !tx.getProjection('protectedPayloadKey', value.protectedPayloadRef))))) {
    throw new KernelError('CONTEXT_SOURCE_REVOKED', '资料已删除或撤权', '移除旧资料及依赖它的历史后重新委派');
  }
  if (ref.namespace === 'asset' && (value as Asset).provenance) {
    const asset = value as Asset, provenance = asset.provenance!, key = `asset:${ref.resourceId}`;
    if (!asset.protected || provenance.version !== 1 || !['goal_export','mcp_resource'].includes(provenance.kind)
      || provenance.producer?.namespace !== (provenance.kind === 'goal_export' ? 'goal.export' : 'mcp.resourceRead')
      || !provenance.producer.resourceId || !Array.isArray(provenance.sourceRefs) || !provenance.sourceRefs.length
      || provenance.sourceRefs.length > 256 || ancestors.has(key) || ancestors.size >= 32) {
      throw new KernelError('CONTEXT_INVALID', '派生资料来源无效、形成循环或超过限额', '重新生成资料');
    }
    const path = new Set([...ancestors, key]);
    for (const source of provenance.sourceRefs) assertSource(tx, scope, source, validateSource, path, checked);
    const proof = provenance.proof;
    if (proof) {
      if (!Array.isArray(proof.projections) || proof.projections.length > 256 || !Array.isArray(proof.protectedPayloadRefs) || proof.protectedPayloadRefs.length > 256)
        throw new KernelError('CONTEXT_INVALID', '派生资料证据超过限额', '重新生成资料');
      for (const evidence of proof.projections) {
        const record = tx.getProjection(evidence.namespace, evidence.resourceId);
        if (!record || !/^[a-f0-9]{64}$/u.test(evidence.digest) || sha256(record) !== evidence.digest)
          throw new KernelError('CONTEXT_SOURCE_CHANGED', '成果权威证据已变化', '重新核对原成果');
      }
      for (const id of proof.protectedPayloadRefs) if (!tx.getProjection('protectedPayloadKey', id))
        throw new KernelError('CONTEXT_SOURCE_REVOKED', '成果原始内容已撤权', '重新核对原成果授权');
    }
  }
  checked.add(identity);
}
export function assertExecutionContextSources(tx: KernelTransaction, execution: Execution, validateSource?: ContextSourceValidator): ExecutionContextV2 | undefined {
  return assertSources(tx, execution, validateSource, new Set(), new Set());
}
function assertSources(tx: KernelTransaction, execution: Execution, validateSource: ContextSourceValidator | undefined,
  ancestors: ReadonlySet<string>, checked: Set<string>): ExecutionContextV2 | undefined {
  if (ancestors.has(execution.id) || ancestors.size >= 32) throw new KernelError('CONTEXT_INVALID', '执行来源引用形成循环或过深', '检查原执行来源记录');
  const context = tx.getProjection<ExecutionContextV2>(EXECUTION_CONTEXT_NAMESPACE, execution.id);
  if (!context) return undefined;
  const { digest, ...body } = context;
  if (context.executionId !== execution.id || context.tenantId !== execution.tenantId || context.workspaceId !== execution.workspaceId || sha256(body) !== digest) {
    throw new KernelError('CONTEXT_INVALID', '执行来源记录无效', '停止执行并检查受保护事件记录');
  }
  const identity = JSON.stringify(["execution", execution.id, context.digest]);
  if (checked.has(identity)) return context;
  const path = new Set([...ancestors, execution.id]);
  for (const ref of context.sourceRefs) assertSource(tx, execution, ref, validateSource, path, checked);
  checked.add(identity);
  return context;
}
export function saveExecutionContext(tx: KernelTransaction, execution: Execution,
  input: Pick<ExecutionContextV2, 'sourceRefs' | 'materials' | 'inheritedExecutionIds'>, validateSource?: ContextSourceValidator): ExecutionContextV2 {
  const previous = assertExecutionContextSources(tx, execution, validateSource);
  for (const ref of input.sourceRefs) assertContextSource(tx, execution, ref, validateSource);
  if (previous && sha256({ sourceRefs: previous.sourceRefs, materials: previous.materials, inheritedExecutionIds: previous.inheritedExecutionIds }) === sha256(input)) return previous;
  const body = { version: 1 as const, executionId: execution.id, tenantId: execution.tenantId, workspaceId: execution.workspaceId,
    streamVersion: (previous?.streamVersion ?? 0) + 1, ...input };
  const value = { ...body, digest: sha256(body) };
  tx.putProjection(EXECUTION_CONTEXT_NAMESPACE, execution.id, value);
  appendKernelEvent(tx, { tenantId: execution.tenantId, aggregateType: EXECUTION_CONTEXT_NAMESPACE, aggregateId: execution.id,
    expectedStreamVersion: previous?.streamVersion ?? 0, type: 'execution.context_bound', actorId: execution.initiatedBy,
    generation: execution.generation, correlationId: execution.id, publicPayload: { workspaceId: execution.workspaceId, sourceCount: input.sourceRefs.length } });
  return value;
}
export function inheritExecutionContext(tx: KernelTransaction, execution: Execution, previous: Execution, validateSource?: ContextSourceValidator): void {
  const source = assertExecutionContextSources(tx, previous, validateSource);
  if (!source) return;
  const current = assertExecutionContextSources(tx, execution, validateSource);
  const refs = new Map((current?.sourceRefs ?? []).map(ref => [`${ref.namespace}:${ref.resourceId}`, ref]));
  for (const ref of source.sourceRefs) {
    const key = `${ref.namespace}:${ref.resourceId}`, existing = refs.get(key);
    if (existing && sha256(existing) !== sha256(ref)) throw new KernelError('CONTEXT_SOURCE_CHANGED', '历史资料版本与当前目标不一致', '使用新会话重新委派');
    refs.set(key, ref);
  }
  saveExecutionContext(tx, execution, { sourceRefs: [...refs.values()], materials: current?.materials ?? [],
    inheritedExecutionIds: [...new Set([...(current?.inheritedExecutionIds ?? []), previous.id, ...source.inheritedExecutionIds])] }, validateSource);
}
