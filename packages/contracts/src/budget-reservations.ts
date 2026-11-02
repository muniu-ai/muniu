// SPDX-License-Identifier: Apache-2.0
import type { VersionedEntity } from './models.js';
export interface BudgetAmountV1 { readonly tokens: number; readonly costMinorUnits: string; readonly currency: string; }
export interface BudgetAccountV1 extends VersionedEntity {
  readonly workspaceId: string; readonly principalId: string; readonly scope: { readonly namespace: string; readonly resourceId: string };
  readonly parentAccountId?: string; readonly limit: BudgetAmountV1; readonly expiresAt: string; readonly configurationDigest: string;
  readonly heldTokens: number; readonly heldCostMinorUnits: string; readonly spentTokens: number; readonly spentCostMinorUnits: string;
  readonly status: 'active' | 'closed'; readonly overrun: boolean;
}
export interface BudgetReservationV1 extends VersionedEntity {
  readonly workspaceId: string; readonly accountId: string; readonly accountChain: readonly string[]; readonly operationKey: string;
  readonly amount: BudgetAmountV1; readonly status: 'reserved' | 'committed' | 'unknown' | 'settled' | 'released';
  readonly usage?: BudgetAmountV1; readonly evidenceDigest?: string;
}
