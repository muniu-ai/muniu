// SPDX-License-Identifier: Apache-2.0
import type { ActionIntent, ActionReceipt, BusinessObjectRef, ExternalObjectRef, EnterpriseContractTypes, ProviderBinding } from '@mn/contracts';

/** Supplied by the trusted Host/connector adapter; these fields do not themselves grant access. */
export interface BusinessProviderContext {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly authorityRevisionId?: string;
  readonly principalSessionEpoch?: number;
  readonly executionLease?: { readonly jobId: string; readonly workerId: string; readonly fencingToken: number };
  readonly signal: AbortSignal;
}
export type ProviderObjectReference = BusinessObjectRef | ExternalObjectRef;
export type ProviderSnapshot = EnterpriseContractTypes['EnterpriseProviderSnapshot'];
export type ProviderActionPreparation = EnterpriseContractTypes['EnterpriseProviderActionPreparation'];
export type ProviderResult<T> = { readonly status: 'supported'; readonly value: T }
  | { readonly status: 'not_supported'; readonly capability: 'readSnapshot' | 'listChanges' | 'prepareAction' | 'executeAction' | 'getReceipt' };

/** Contract for E5 registration. No provider is mounted or invoked by this declaration. */
export interface BusinessProviderContribution {
  readonly id: string;
  readonly version: string;
  readonly binding: ProviderBinding;
  readSnapshot(reference: ProviderObjectReference, context: BusinessProviderContext): Promise<ProviderResult<ProviderSnapshot>>;
  listChanges(cursor: string | null, context: BusinessProviderContext): Promise<ProviderResult<EnterpriseContractTypes['EnterpriseProviderChanges']>>;
  /** Preparation fixes input before an execution authority, reservation or execution approval exists. */
  prepareAction(request: ProviderActionPreparation, context: BusinessProviderContext): Promise<ProviderResult<EnterpriseContractTypes['EnterpriseProviderPreparedAction']>>;
  executeAction(intent: ActionIntent & { readonly status: 'committed' }, context: BusinessProviderContext): Promise<ProviderResult<ActionReceipt>>;
  getReceipt(operationKey: string, context: BusinessProviderContext): Promise<ProviderResult<ActionReceipt>>;
}
