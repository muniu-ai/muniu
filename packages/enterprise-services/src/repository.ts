// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from '@mn/contracts';
export interface EnterpriseRecord {
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly expectedStreamVersion: number;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly payload: JsonObject;
}
export interface EnterpriseChange<T> { readonly events: readonly EnterpriseRecord[]; readonly value: T; }
export interface EnterpriseRepository {
  read(tenantId: string): Promise<readonly EnterpriseRecord[]>;
  /** Work is pure and may be recalculated after a known transaction conflict. */
  transact<T>(tenantId: string, work: (records: readonly EnterpriseRecord[]) => EnterpriseChange<T>): Promise<T>;
}
