import type { JsonObject, JsonValue } from "./json.js";

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

export interface ApiErrorV2 {
  readonly code: string;
  readonly message: string;
  readonly action: string;
  readonly fieldIssues: readonly FieldIssue[];
  readonly traceId: string;
  readonly retryable: boolean;
}

export interface ApiEnvelope<T extends JsonValue = JsonValue> {
  readonly data: T;
  readonly traceId: string;
}

export interface MutationHeaders {
  readonly "idempotency-key": string;
}

export interface VersionedMutationBody extends JsonObject {
  readonly expectedStreamVersion: number;
}

export const CORE_API_ROUTES = [
  "/v2/openapi.json",
  "/v2/health",
  "/v2/readiness",
  "/v2/setup",
  "/v2/workspaces",
  "/v2/workspaces/{workspaceId}",
  "/v2/workspaces/{workspaceId}/home",
  "/v2/workspaces/{workspaceId}/threads",
  "/v2/workspaces/{workspaceId}/threads/{threadId}/turns",
  "/v2/workspaces/{workspaceId}/events",
  "/v2/executions/{executionId}/commands",
  "/v2/inbox",
  "/v2/activity",
  "/v2/approvals/{approvalId}/decisions",
  "/v2/deliverables",
  "/v2/assets/{assetId}",
  "/v2/memories",
  "/v2/memories/{memoryId}",
  "/v2/memories/{memoryId}/decisions",
  "/v2/share-grants",
  "/v2/share-grants/{grantId}",
  "/v2/model-connections/presets",
  "/v2/model-connections",
  "/v2/model-connections/{connectionId}/probe",
  "/v2/plugins/installations",
  "/v2/workspaces/{workspaceId}/plugin-activations",
  "/v2/plugins/{pluginId}/{path}",
] as const;

export function apiError(
  code: string,
  message: string,
  action: string,
  traceId: string,
  options: { readonly retryable?: boolean; readonly fieldIssues?: readonly FieldIssue[] } = {},
): ApiErrorV2 {
  return {
    code,
    message,
    action,
    fieldIssues: options.fieldIssues ?? [],
    traceId,
    retryable: options.retryable ?? false,
  };
}
