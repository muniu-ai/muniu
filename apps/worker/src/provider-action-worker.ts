// SPDX-License-Identifier: Apache-2.0
import type { ActionReceipt, BudgetAmountV1, Execution, JsonValue } from '@mn/contracts';
import { actionIntentView, parseEnterpriseContract } from '@mn/contracts';
import type { BusinessProviderContribution } from '@mn/plugin-sdk';
import type { ActionCoordinator, CoordinatedAction } from '@mn/business-execution';
import { KernelError, type KernelStore } from '@mn/kernel';
import { UnknownExternalSideEffectError, type WorkerJobHandler } from './index.js';

export function createProviderActionWorkerHandler(options: {
  readonly store: KernelStore;
  readonly coordinator: ActionCoordinator;
  readonly resolveProvider: (id: string) => Promise<BusinessProviderContribution>;
  /** Only a trusted, versioned meter may produce accounting facts. */
  readonly usageForReceipt: (receipt: ActionReceipt, action: CoordinatedAction) => BudgetAmountV1;
  readonly now?: () => string;
}): WorkerJobHandler {
  const now = options.now ?? (() => new Date().toISOString());
  return async (job, context): Promise<JsonValue> => {
    if (typeof job.payload.actionId !== 'string') throw new Error('ACTION_ID_REQUIRED');
    let action = await options.coordinator.get(job.tenantId, job.payload.actionId);
    if (!action || action.executionId !== job.payload.executionId || action.workspaceId !== job.workspaceId || action.jobId !== job.id) throw new Error('ACTION_SCOPE_INVALID');
    const lease = () => ({ jobId: job.id, workerId: context.workerId, fencingToken: context.fencingToken, occurredAt: now() });
    let committed = ['committed', 'needs_reconciliation'].includes(action.status);
    try {
      if (committed) throw new UnknownExternalSideEffectError(action.executionId);
      if (context.signal.aborted) throw new Error('ACTION_CANCELLED');
      const provider = await options.resolveProvider(action.provider);
      const bindings = provider.binding.bindings.filter(binding => binding.objectType === action!.target.objectType);
      if (provider.id !== action.provider || provider.version !== action.toolVersion || provider.binding.tenantId !== job.tenantId
        || provider.binding.workspaceId !== action.workspaceId || provider.binding.streamVersion !== action.providerBindingVersion
        || bindings.length !== 1 || bindings[0]!.provider !== action.provider || !bindings[0]!.allowedActions.includes(action.action)
        || !bindings[0]!.supportedPorts.includes('executeAction')) throw new KernelError('PROVIDER_BINDING_CHANGED', '连接能力或版本已变化', '重新准备当前动作');
      const execution = await options.store.transact(job.tenantId, tx => tx.getProjection<Execution>('execution', action!.executionId));
      if (!execution) throw new Error('EXECUTION_NOT_FOUND');
      if (context.signal.aborted) throw new Error('ACTION_CANCELLED');
      action = await options.coordinator.begin(job.tenantId, action.id, lease());
      committed = true;
      const response = await provider.executeAction({ ...actionIntentView(action), status: 'committed' }, {
        tenantId: job.tenantId, workspaceId: action.workspaceId, principalId: execution.initiatedBy,
        authorityRevisionId: action.authorityRevisionId, signal: context.signal,
      });
      if (response.status !== 'supported') throw new UnknownExternalSideEffectError(action.executionId);
      const receipt = parseEnterpriseContract('ActionReceipt', response.value);
      if (!['succeeded', 'not_executed'].includes(receipt.status)) throw new UnknownExternalSideEffectError(action.executionId);
      const settlement = await options.coordinator.complete(job.tenantId, action.id, receipt, options.usageForReceipt(receipt, action), lease());
      context.acknowledgeJobSettlement?.(settlement);
      return { actionId: action.id, operationKey: action.operationKey, receiptStatus: receipt.status };
    } catch (error) {
      if (committed) {
        try { await options.coordinator.markUnknown(job.tenantId, action.id, lease()); }
        catch (recordError) {
          if (!(recordError instanceof Error) || !('code' in recordError) || recordError.code !== 'STALE_FENCING_TOKEN') throw recordError;
        }
        throw new UnknownExternalSideEffectError(action.executionId);
      }
      const settlement = await options.coordinator.rejectBeforeDispatch(job.tenantId, action.id, lease());
      context.acknowledgeJobSettlement?.(settlement);
      return { actionId: action.id, status: 'rejected_before_dispatch' };
    }
  };
}
