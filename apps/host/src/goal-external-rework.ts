// SPDX-License-Identifier: Apache-2.0
import { CODING_RUNNER_CONFIGURATION_NAMESPACE, type CodingRunnerConfigurationV1, type CoordinationAttemptV2, type Execution,
  type GoalCoordinatedPlanV2, type GoalPlanProposalV2, type GoalUsageV2, type GoalV2, type Job, type Workspace } from '@mn/contracts';
import { appendKernelEvent, hasUnsettledToolCalls, KernelError, sha256, type KernelTransaction } from '@mn/kernel';
import { GoalRuleError, validateGoalUsage } from '@mn/task-orchestration';
import { runnerPluginId, runnerToolId } from './coding-runners.js';
import type { GoalScope } from './goals.js';

function fail(code: string, message: string): never { throw new KernelError(code, message, '核对原 CLI 身份、执行结果和厂商账单'); }
export function externalGoalRunnerBindingValid(tx: KernelTransaction, scope: Pick<GoalScope, 'tenantId' | 'workspaceId'>, executor: GoalPlanProposalV2): boolean {
  if (executor.runnerId !== 'codex-cli' && executor.runnerId !== 'claude-cli') return false;
  const runner = tx.getProjection<CodingRunnerConfigurationV1>(CODING_RUNNER_CONFIGURATION_NAMESPACE, `${scope.workspaceId}:${executor.runnerId}`);
  const workspace = tx.getProjection<Workspace>('workspace', scope.workspaceId);
  return Boolean(workspace?.tenantId === scope.tenantId && workspace.activePluginIds.includes(executor.pluginId)
    && workspace.activePluginIds.includes(runnerPluginId(executor.runnerId)) && executor.toolIds.includes(runnerToolId(executor.runnerId))
    && executor.modelBindingId === `runner:${executor.runnerId}` && executor.model === 'CLI 自有模型'
    && runner?.tenantId === scope.tenantId && runner.workspaceId === scope.workspaceId && runner.status === 'confirmed'
    && runner.streamVersion === executor.runnerBinding?.configurationStreamVersion && runner.streamVersion === executor.modelConnectionStreamVersion
    && runner.identityDigest === executor.runnerBinding.identityDigest && runner.identityDigest === sha256(runner.identity));
}
interface ExternalUsageRecord {
  readonly tenantId: string; readonly workspaceId: string; readonly executionId: string; readonly generation: number;
  readonly attemptId: string; readonly runId: string; readonly usage: GoalUsageV2;
}
function validateUsage(value: GoalUsageV2): void {
  try { validateGoalUsage(value); } catch (error) { if (error instanceof GoalRuleError) fail(error.code, error.message); throw error; }
}
export function readCoordinatedExternalUsage(tx: KernelTransaction, attempt: CoordinationAttemptV2, execution: Execution): GoalUsageV2 | undefined {
  const record = tx.getProjection<ExternalUsageRecord>('goal.externalUsage', execution.id);
  if (!record) return undefined;
  if (record.tenantId !== execution.tenantId || record.workspaceId !== execution.workspaceId || record.executionId !== execution.id
    || attempt.tenantId !== execution.tenantId || attempt.workspaceId !== execution.workspaceId || attempt.executionId !== execution.id
    || record.generation !== execution.generation || attempt.generation !== execution.generation || record.attemptId !== attempt.id
    || record.runId !== attempt.runId || record.usage.currency !== attempt.reservation.budget.currency) fail('GOAL_USAGE_CONFLICT', '外部账单与节点执行不一致');
  validateUsage(record.usage);
  return record.usage;
}
export function recordCoordinatedExternalUsage(tx: KernelTransaction, options: GoalScope & {
  readonly goal: GoalV2; readonly plan: GoalCoordinatedPlanV2; readonly usage: GoalUsageV2; readonly source: string;
  readonly now: () => string; readonly id: (kind: string) => string;
}): void {
  const { goal, plan } = options;
  validateUsage(options.usage);
  if (!options.source?.trim() || options.source.length > 2000) fail('GOAL_USAGE_SOURCE_REQUIRED', '填写账单或订阅分摊依据');
  const node = plan.nodes[0];
  if (plan.kind !== 'single-v2' || plan.nodes.length !== 1 || node?.kind !== 'agent' || node.executor.runnerId === 'builtin'
    || !goal.coordinationRef || goal.coordinationRef.planRevisionId !== plan.id) fail('GOAL_EXTERNAL_USAGE_INVALID', '此目标没有唯一的外部 CLI 返工执行');
  const attempts = tx.listProjections<CoordinationAttemptV2>('coordination.attempt').filter(value => value.runId === goal.coordinationRef!.runId && value.nodeId === node.id);
  if (attempts.length !== 1) fail('GOAL_EXTERNAL_USAGE_INVALID', '外部 CLI 执行尚未派发或无法唯一确定');
  const attempt = attempts[0]!, execution = tx.getProjection<Execution>('execution', attempt.executionId), job = tx.getProjection<Job>('job', attempt.jobId);
  if (!execution || execution.tenantId !== options.tenantId || execution.workspaceId !== options.workspaceId
    || execution.runnerId !== node.executor.runnerId || attempt.revisionId !== plan.id || execution.generation !== attempt.generation)
    fail('GOAL_EXTERNAL_USAGE_INVALID', '外部执行绑定无效');
  if (!job || job.payload.executionId !== execution.id || !['completed', 'failed'].includes(job.status)
    || !['completed', 'failed', 'cancelled'].includes(execution.status) || hasUnsettledToolCalls(tx, execution.id))
    fail('GOAL_EXECUTION_PENDING', '先核对外部执行结果，再登记用量');
  if (options.usage.currency !== goal.budget.currency || options.usage.currency !== attempt.reservation.budget.currency) fail('GOAL_BUDGET_CURRENCY_MISMATCH', '账单币种与目标预算不一致');
  if (tx.getProjection('goal.externalUsage', execution.id) || attempt.reservation.status === 'settled') fail('GOAL_USAGE_CONFLICT', '本次执行的用量已固定，不能覆盖');
  tx.putProjection('goal.externalUsage', execution.id, { tenantId: options.tenantId, workspaceId: options.workspaceId, goalId: goal.id,
    executionId: execution.id, generation: execution.generation, attemptId: attempt.id, runId: attempt.runId, usage: options.usage,
    source: options.source, recordedBy: options.principalId, createdAt: options.now(), streamVersion: 1 });
  appendKernelEvent(tx, { tenantId: options.tenantId, aggregateType: 'goal.externalUsage', aggregateId: execution.id, expectedStreamVersion: 0,
    type: 'goal.external_usage_recorded', actorId: options.principalId, generation: execution.generation, correlationId: options.id('goal-usage'),
    publicPayload: { workspaceId: options.workspaceId, goalId: goal.id } });
}
