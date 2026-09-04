import type { JsonObject } from "./json.js";
import type { IsoDateTime, TenantId } from "./models.js";

export interface KernelEventV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly tenantId: TenantId;
  readonly position: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly streamVersion: number;
  readonly type: string;
  readonly occurredAt: IsoDateTime;
  readonly actorId: string;
  readonly executionId?: string;
  readonly generation: number;
  readonly causationId?: string;
  readonly correlationId: string;
  readonly publicPayload: JsonObject;
  readonly protectedPayloadRef?: string;
  readonly previousDigest?: string;
  readonly digest: string;
  readonly hmac: string;
}

export interface EventAppendRequest {
  readonly tenantId: TenantId;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly expectedStreamVersion: number;
  readonly type: string;
  readonly actorId: string;
  readonly executionId?: string;
  readonly generation: number;
  readonly causationId?: string;
  readonly correlationId: string;
  readonly publicPayload: JsonObject;
  readonly protectedPayloadRef?: string;
}

export interface EventPage {
  readonly events: readonly KernelEventV1[];
  readonly nextPosition: number;
  readonly retentionFloor: number;
}
