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

export type AssetAttachmentUploadV2 = JsonObject & {
  readonly fileName: string;
  readonly mediaType:
    | "text/plain"
    | "text/markdown"
    | "application/json"
    | "text/csv"
    | "application/pdf"
    | "image/png"
    | "image/jpeg"
    | "image/webp";
  readonly contentBase64: string;
  readonly protected?: boolean;
};

export interface CreateAssetsMutationBodyV2 extends VersionedMutationBody {
  readonly expectedStreamVersion: 0;
  readonly workspaceId: string;
  readonly attachments: readonly AssetAttachmentUploadV2[];
}

export interface DeleteAssetMutationBodyV2 extends VersionedMutationBody {
  readonly reason: string;
}

export interface AgentCatalogAgentV2 {
  readonly pluginId: string;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
}

export interface AgentCatalogSkillV2 {
  readonly pluginId: string;
  readonly id: string;
  readonly title: string;
  readonly expectedOutcome: string;
  readonly exampleInput?: string;
  readonly source: string;
  readonly license: string;
  readonly version: string;
  readonly permissionIds: readonly string[];
  readonly installation: "active";
}

export interface AgentCatalogV2 {
  readonly agents: readonly AgentCatalogAgentV2[];
  readonly skills: readonly AgentCatalogSkillV2[];
}

export type CreateTurnMutationBodyV2 = VersionedMutationBody & {
  readonly message: string;
  readonly agentDefinitionId?: string;
  readonly modelBindingId?: string;
  readonly runnerId?: "builtin" | "claude-cli" | "codex-cli";
};

export interface InspectCodingRunnerMutationBodyV2 extends JsonObject {
  readonly workspaceId: string;
  readonly binaryPath: string;
}

export interface ConfirmCodingRunnerMutationBodyV2 extends VersionedMutationBody {
  readonly workspaceId: string;
  readonly binaryPath: string;
  readonly version: string;
  readonly sha256: string;
}

export const CORE_API_ROUTES = [
  "/v2/openapi.json",
  "/v2/health",
  "/v2/readiness",
  "/v2/setup",
  "/v2/workspaces",
  "/v2/workspaces/{workspaceId}",
  "/v2/workspaces/{workspaceId}/members",
  "/v2/workspaces/{workspaceId}/members/{principalId}",
  "/v2/workspaces/{workspaceId}/agent-catalog",
  "/v2/workspaces/{workspaceId}/home",
  "/v2/workspaces/{workspaceId}/threads",
  "/v2/workspaces/{workspaceId}/threads/{threadId}/turns",
  "/v2/workspaces/{workspaceId}/events",
  "/v2/executions/{executionId}/commands",
  "/v2/inbox",
  "/v2/activity",
  "/v2/approvals/{approvalId}/decisions",
  "/v2/deliverables",
  "/v2/assets",
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
  "/v2/plugins/installations/{pluginId}",
  "/v2/plugins/installations/{pluginId}/disable",
  "/v2/workspaces/{workspaceId}/plugin-activations",
  "/v2/workspaces/{workspaceId}/plugin-activations/{pluginId}",
  "/v2/plugins/opc/opportunities/{opportunityId}",
  "/v2/plugins/opc/opportunities/{opportunityId}/commands",
  "/v2/plugins/opc/opportunities/{opportunityId}/deliverables",
  "/v2/plugins/opc/opportunities/{opportunityId}/exports",
  "/v2/plugins/coding/runners",
  "/v2/plugins/coding/runners/{runnerId}/inspections",
  "/v2/plugins/coding/runners/{runnerId}/confirmations",
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
