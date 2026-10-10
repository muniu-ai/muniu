// SPDX-License-Identifier: Apache-2.0
import type { Execution, ExecutionContextV2, GoalResourceRefV2 } from '@mn/contracts';
import { appendKernelEvent, KernelError, sha256, type KernelTransaction } from '@mn/kernel';

export type ContextSourceValidator = (tx: KernelTransaction, scope: { tenantId: string; workspaceId: string }, ref: GoalResourceRefV2) => boolean;

export const EXECUTION_CONTEXT_NAMESPACE = 'execution.context';
export function assertContextSource(tx: KernelTransaction, scope: { tenantId: string; workspaceId: string }, ref: GoalResourceRefV2, validateSource?: ContextSourceValidator): void {
  assertSource(tx, scope, ref, validateSource, new Set());
}
function assertSource(tx: KernelTransaction, scope: { tenantId: string; workspaceId: string }, ref: GoalResourceRefV2,
  validateSource: ContextSourceValidator | undefined, ancestors: ReadonlySet<string>): void {
  if (validateSource?.(tx, scope, ref)) return;
  const value = tx.getProjection<{ tenantId?: string; workspaceId: string; streamVersion: number; digest?: string; protected?: boolean; protectedPayloadRef?: string }>(ref.namespace, ref.resourceId);
  if (ref.namespace === 'coding.execution') {
    const execution = tx.getProjection<Execution>('execution', ref.resourceId);
    const run = value as unknown as { executionId?: string; generation?: number } | undefined;
    if (!value || !execution || execution.id !== ref.resourceId || execution.tenantId !== scope.tenantId || execution.workspaceId !== scope.workspaceId
      || run?.executionId !== execution.id || run.generation !== execution.generation || value.streamVersion !== ref.streamVersion || !ref.digest || ref.digest !== sha256(value)) {
      throw new KernelError('CONTEXT_SOURCE_CHANGED', '代码成果来源或版本已变化', '重新核对原执行与成果');
    }
    assertSources(tx, execution, validateSource, ancestors);
    return;
  }
  const domain = ['opc.opportunity', 'coding.repository'].includes(ref.namespace);
  if (!value || value.workspaceId !== scope.workspaceId || (value.tenantId !== scope.tenantId && !(domain && value.tenantId === undefined))
    || value.streamVersion !== ref.streamVersion || !ref.digest || ref.digest !== (value.digest ?? sha256(value))) {
    throw new KernelError('CONTEXT_SOURCE_CHANGED', '资料来源或版本已变化', '重新选择有效资料并规划任务');
  }
  if (ref.namespace === 'asset' && (tx.getProjection('assetTombstone', ref.resourceId)
    || (value.protected && (!value.protectedPayloadRef || !tx.getProjection('protectedPayloadKey', value.protectedPayloadRef))))) {
    throw new KernelError('CONTEXT_SOURCE_REVOKED', '资料已删除或撤权', '移除旧资料及依赖它的历史后重新委派');
  }
}
export function assertExecutionContextSources(tx: KernelTransaction, execution: Execution, validateSource?: ContextSourceValidator): ExecutionContextV2 | undefined {
  return assertSources(tx, execution, validateSource, new Set());
}
function assertSources(tx: KernelTransaction, execution: Execution, validateSource: ContextSourceValidator | undefined,
  ancestors: ReadonlySet<string>): ExecutionContextV2 | undefined {
  if (ancestors.has(execution.id) || ancestors.size >= 32) throw new KernelError('CONTEXT_INVALID', '执行来源引用形成循环或过深', '检查原执行来源记录');
  const context = tx.getProjection<ExecutionContextV2>(EXECUTION_CONTEXT_NAMESPACE, execution.id);
  if (!context) return undefined;
  const { digest, ...body } = context;
  if (context.executionId !== execution.id || context.tenantId !== execution.tenantId || context.workspaceId !== execution.workspaceId || sha256(body) !== digest) {
    throw new KernelError('CONTEXT_INVALID', '执行来源记录无效', '停止执行并检查受保护事件记录');
  }
  const path = new Set([...ancestors, execution.id]);
  for (const ref of context.sourceRefs) assertSource(tx, execution, ref, validateSource, path);
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
