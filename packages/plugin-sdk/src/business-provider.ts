// SPDX-License-Identifier: Apache-2.0
import type { ActionIntent, ActionReceipt, BusinessObjectRef, ExternalObjectRef, ProviderBinding } from '@mn/contracts';

/** Supplied by the trusted Host/connector adapter; these fields do not themselves grant access. */
export interface BusinessProviderContext {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly authorityRevisionId?: string;
  readonly signal: AbortSignal;
}
export type ProviderObjectReference = BusinessObjectRef | ExternalObjectRef;
export interface ProviderSnapshot {
  readonly objectRef: ProviderObjectReference;
  readonly protectedContentRef: string;
  readonly observedAt: string;
}
export type ProviderResult<T> = { readonly status: 'supported'; readonly value: T }
  | { readonly status: 'not_supported'; readonly capability: 'readSnapshot' | 'listChanges' | 'prepareAction' | 'executeAction' | 'getReceipt' };

/** Contract for E5 registration. No provider is mounted or invoked by this declaration. */
export interface BusinessProviderContribution {
  readonly id: string;
  readonly version: string;
  readonly binding: ProviderBinding;
  readSnapshot(reference: ProviderObjectReference, context: BusinessProviderContext): Promise<ProviderResult<ProviderSnapshot>>;
  listChanges(cursor: string | null, context: BusinessProviderContext): Promise<ProviderResult<{
    readonly changes: readonly { readonly sourceEventId: string; readonly sourceEventType: string; readonly sourceOccurredAt: string; readonly snapshot: ProviderSnapshot }[];
    readonly nextCursor: string;
  }>>;
  prepareAction(intent: ActionIntent, context: BusinessProviderContext): Promise<ProviderResult<{
    readonly preparedInputRef: string; readonly inputDigest: string; readonly target: ProviderObjectReference; readonly expiresAt: string;
  }>>;
  executeAction(intent: ActionIntent & { readonly status: 'committed' }, context: BusinessProviderContext): Promise<ProviderResult<ActionReceipt>>;
  getReceipt(operationKey: string, context: BusinessProviderContext): Promise<ProviderResult<ActionReceipt>>;
}
