// SPDX-License-Identifier: Apache-2.0

import type { SpecJsonValue } from "@mn/specs";

export type OpcAggregateKind =
  | "record"
  | "operation_run"
  | "operation_event"
  | "attention_item"
  | "action_intent"
  | "authority_decision"
  | "effect_receipt"
  | "settlement_record"
  | "publication_outbox"
  | "publication_receipt"
  | "business_pack_binding";

export interface OpcStoredEntry<T extends SpecJsonValue = SpecJsonValue> {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly kind: OpcAggregateKind;
  readonly id: string;
  readonly revision: number;
  readonly requestId: string;
  readonly value: T;
  readonly valueDigest: string;
  readonly previousDigest?: string;
  readonly digest: string;
  readonly createdAt: string;
}

export interface OpcAppendInput<T extends SpecJsonValue = SpecJsonValue> {
  readonly tenantId: string;
  readonly kind: OpcAggregateKind;
  readonly id: string;
  readonly expectedRevision: number;
  readonly requestId: string;
  readonly value: T;
  readonly createdAt: string;
}

export interface OpcAppendStore {
  migrate?(): Promise<void>;
  append<T extends SpecJsonValue>(input: OpcAppendInput<T>): Promise<OpcStoredEntry<T>>;
  read<T extends SpecJsonValue = SpecJsonValue>(
    tenantId: string,
    kind: OpcAggregateKind,
    id: string
  ): Promise<OpcStoredEntry<T> | undefined>;
  history<T extends SpecJsonValue = SpecJsonValue>(
    tenantId: string,
    kind: OpcAggregateKind,
    id: string
  ): Promise<readonly OpcStoredEntry<T>[]>;
  list<T extends SpecJsonValue = SpecJsonValue>(
    tenantId: string,
    kind: OpcAggregateKind
  ): Promise<readonly OpcStoredEntry<T>[]>;
  close(): Promise<void>;
}

export class OpcRevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`expected revision ${expectedRevision}, current revision is ${actualRevision}`);
    this.name = "OpcRevisionConflictError";
  }
}

export class OpcIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(readonly requestId: string) {
    super(`requestId ${requestId} was already used with different input`);
    this.name = "OpcIdempotencyConflictError";
  }
}
