import { CORE_API_ROUTES } from "./api.js";
import type { JsonObject } from "./json.js";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface ApiOperationV2 {
  readonly method: HttpMethod;
  readonly path: (typeof CORE_API_ROUTES)[number];
  readonly operationId: string;
  readonly mutation: boolean;
  readonly versioned: boolean;
}

export const API_OPERATIONS_V2: readonly ApiOperationV2[] = [
  { method: "get", path: "/v2/openapi.json", operationId: "getOpenApi", mutation: false, versioned: false },
  { method: "get", path: "/v2/health", operationId: "getHealth", mutation: false, versioned: false },
  { method: "get", path: "/v2/readiness", operationId: "getReadiness", mutation: false, versioned: false },
  { method: "post", path: "/v2/setup", operationId: "setup", mutation: true, versioned: false },
  { method: "get", path: "/v2/workspaces", operationId: "listWorkspaces", mutation: false, versioned: false },
  { method: "post", path: "/v2/workspaces", operationId: "createWorkspace", mutation: true, versioned: false },
  { method: "get", path: "/v2/workspaces/{workspaceId}", operationId: "getWorkspace", mutation: false, versioned: false },
  { method: "patch", path: "/v2/workspaces/{workspaceId}", operationId: "updateWorkspace", mutation: true, versioned: true },
  { method: "get", path: "/v2/workspaces/{workspaceId}/members", operationId: "listWorkspaceMembers", mutation: false, versioned: false },
  { method: "put", path: "/v2/workspaces/{workspaceId}/members/{principalId}", operationId: "setWorkspaceMember", mutation: true, versioned: true },
  { method: "delete", path: "/v2/workspaces/{workspaceId}/members/{principalId}", operationId: "removeWorkspaceMember", mutation: true, versioned: true },
  { method: "get", path: "/v2/workspaces/{workspaceId}/agent-catalog", operationId: "getWorkspaceAgentCatalog", mutation: false, versioned: false },
  { method: "get", path: "/v2/workspaces/{workspaceId}/home", operationId: "getWorkspaceHome", mutation: false, versioned: false },
  { method: "get", path: "/v2/workspaces/{workspaceId}/threads", operationId: "listThreads", mutation: false, versioned: false },
  { method: "post", path: "/v2/workspaces/{workspaceId}/threads", operationId: "createThread", mutation: true, versioned: false },
  { method: "get", path: "/v2/workspaces/{workspaceId}/threads/{threadId}/turns", operationId: "listThreadTurns", mutation: false, versioned: false },
  { method: "post", path: "/v2/workspaces/{workspaceId}/threads/{threadId}/turns", operationId: "createTurn", mutation: true, versioned: true },
  { method: "get", path: "/v2/workspaces/{workspaceId}/events", operationId: "streamWorkspaceEvents", mutation: false, versioned: false },
  { method: "post", path: "/v2/executions/{executionId}/commands", operationId: "commandExecution", mutation: true, versioned: true },
  { method: "get", path: "/v2/inbox", operationId: "listInbox", mutation: false, versioned: false },
  { method: "get", path: "/v2/activity", operationId: "listActivity", mutation: false, versioned: false },
  { method: "post", path: "/v2/approvals/{approvalId}/decisions", operationId: "decideApproval", mutation: true, versioned: true },
  { method: "get", path: "/v2/deliverables", operationId: "listDeliverables", mutation: false, versioned: false },
  { method: "post", path: "/v2/assets", operationId: "createAssets", mutation: true, versioned: true },
  { method: "get", path: "/v2/assets/{assetId}", operationId: "getAsset", mutation: false, versioned: false },
  { method: "delete", path: "/v2/assets/{assetId}", operationId: "deleteAsset", mutation: true, versioned: true },
  { method: "get", path: "/v2/memories", operationId: "listMemories", mutation: false, versioned: false },
  { method: "post", path: "/v2/memories", operationId: "proposeMemory", mutation: true, versioned: false },
  { method: "patch", path: "/v2/memories/{memoryId}", operationId: "reviseMemoryProposal", mutation: true, versioned: true },
  { method: "delete", path: "/v2/memories/{memoryId}", operationId: "deleteMemory", mutation: true, versioned: true },
  { method: "post", path: "/v2/memories/{memoryId}/decisions", operationId: "decideMemory", mutation: true, versioned: true },
  { method: "get", path: "/v2/share-grants", operationId: "listShareGrants", mutation: false, versioned: false },
  { method: "post", path: "/v2/share-grants", operationId: "createShareGrant", mutation: true, versioned: true },
  { method: "delete", path: "/v2/share-grants/{grantId}", operationId: "revokeShareGrant", mutation: true, versioned: true },
  { method: "get", path: "/v2/model-connections/presets", operationId: "listModelPresets", mutation: false, versioned: false },
  { method: "get", path: "/v2/model-connections", operationId: "listModelConnections", mutation: false, versioned: false },
  { method: "post", path: "/v2/model-connections", operationId: "createModelConnection", mutation: true, versioned: false },
  { method: "post", path: "/v2/model-connections/{connectionId}/probe", operationId: "probeModelConnection", mutation: true, versioned: true },
  { method: "post", path: "/v2/plugins/installations", operationId: "installPlugin", mutation: true, versioned: false },
  { method: "get", path: "/v2/plugins/installations", operationId: "listPluginInstallations", mutation: false, versioned: false },
  { method: "patch", path: "/v2/plugins/installations/{pluginId}", operationId: "updatePlugin", mutation: true, versioned: true },
  { method: "post", path: "/v2/plugins/installations/{pluginId}/disable", operationId: "disablePlugin", mutation: true, versioned: true },
  { method: "delete", path: "/v2/plugins/installations/{pluginId}", operationId: "purgePlugin", mutation: true, versioned: true },
  { method: "post", path: "/v2/workspaces/{workspaceId}/plugin-activations", operationId: "activatePlugin", mutation: true, versioned: true },
  { method: "delete", path: "/v2/workspaces/{workspaceId}/plugin-activations/{pluginId}", operationId: "deactivatePlugin", mutation: true, versioned: true },
  { method: "get", path: "/v2/plugins/opc/opportunities/{opportunityId}", operationId: "getOpcOpportunity", mutation: false, versioned: false },
  { method: "post", path: "/v2/plugins/opc/opportunities/{opportunityId}/commands", operationId: "commandOpcOpportunity", mutation: true, versioned: true },
  { method: "get", path: "/v2/plugins/opc/opportunities/{opportunityId}/deliverables", operationId: "previewOpcDeliverables", mutation: false, versioned: false },
  { method: "post", path: "/v2/plugins/opc/opportunities/{opportunityId}/exports", operationId: "exportOpcDeliverables", mutation: true, versioned: true },
  { method: "get", path: "/v2/plugins/{pluginId}/{path}", operationId: "getPluginResource", mutation: false, versioned: false },
  { method: "post", path: "/v2/plugins/{pluginId}/{path}", operationId: "mutatePluginResource", mutation: true, versioned: true },
] as const;

function successStatus(operationId: string): "200" | "201" | "202" {
  if (operationId === "createTurn") return "202";
  if ([
    "createWorkspace",
    "createThread",
    "createAssets",
    "proposeMemory",
    "createShareGrant",
    "createModelConnection",
    "installPlugin",
  ].includes(operationId)) return "201";
  return "200";
}

export function createOpenApiDocument(): JsonObject {
  const paths: Record<string, Record<string, JsonObject>> = {};
  for (const operation of API_OPERATIONS_V2) {
    const parameters = operation.mutation
      ? [{ in: "header", name: "Idempotency-Key", required: true, schema: { type: "string" } }]
      : [];
    paths[operation.path] ??= {};
    paths[operation.path]![operation.method] = {
      operationId: operation.operationId,
      parameters,
      ...(operation.mutation ? {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: operation.operationId === "createAssets"
                ? { $ref: "#/components/schemas/CreateAssetsMutation" }
                : operation.operationId === "deleteAsset"
                  ? { $ref: "#/components/schemas/DeleteAssetMutation" }
                : operation.operationId === "commandOpcOpportunity"
                  ? { $ref: "#/components/schemas/OpcOpportunityCommandMutation" }
                : operation.versioned
                ? { $ref: "#/components/schemas/VersionedMutation" }
                : { type: "object", additionalProperties: true },
            },
          },
        },
      } : {}),
      responses: {
        [successStatus(operation.operationId)]: {
          description: "成功",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiEnvelope" } } },
        },
        "400": { $ref: "#/components/responses/BadRequest" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "409": { $ref: "#/components/responses/Conflict" },
        "410": { $ref: "#/components/responses/CursorExpired" },
        "422": { $ref: "#/components/responses/Unprocessable" },
      },
      "x-muniu-versioned": operation.versioned,
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Muniu Agent OS API", version: "0.2.0" },
    paths,
    components: {
      schemas: {
        ApiEnvelope: {
          type: "object",
          required: ["data", "traceId"],
          properties: {
            data: {},
            traceId: { type: "string" },
          },
        },
        ApiError: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message", "action", "fieldIssues", "traceId", "retryable"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            action: { type: "string" },
            fieldIssues: {
              type: "array",
              items: {
                type: "object",
                required: ["field", "message"],
                properties: { field: { type: "string" }, message: { type: "string" } },
              },
            },
            traceId: { type: "string" },
            retryable: { type: "boolean" },
          },
        },
        VersionedMutation: {
          type: "object",
          required: ["expectedStreamVersion"],
          properties: { expectedStreamVersion: { type: "integer", minimum: 0 } },
          additionalProperties: true,
        },
        CreateAssetsMutation: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "expectedStreamVersion", "attachments"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            expectedStreamVersion: { type: "integer", const: 0 },
            attachments: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["fileName", "mediaType", "contentBase64"],
                properties: {
                  fileName: { type: "string", minLength: 1 },
                  mediaType: {
                    type: "string",
                    enum: [
                      "text/plain", "text/markdown", "application/json", "text/csv",
                      "application/pdf", "image/png", "image/jpeg", "image/webp",
                    ],
                  },
                  contentBase64: { type: "string", contentEncoding: "base64" },
                  protected: { type: "boolean", default: false },
                },
              },
            },
          },
        },
        DeleteAssetMutation: {
          type: "object",
          additionalProperties: false,
          required: ["expectedStreamVersion", "reason"],
          properties: {
            expectedStreamVersion: { type: "integer", minimum: 1 },
            reason: { type: "string", minLength: 1 },
          },
        },
        OpcOpportunityCommandMutation: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "expectedStreamVersion", "command", "input"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            expectedStreamVersion: { type: "integer", minimum: 1 },
            command: { type: "string", minLength: 1 },
            input: { type: "object", additionalProperties: true },
          },
          allOf: [
            {
              if: { required: ["command"], properties: { command: { const: "record_interview" } } },
              then: {
                properties: {
                  input: {
                    type: "object",
                    required: ["interviewId", "participantRef", "occurredAt", "rawRecordAssetId"],
                    not: { required: ["rawRecord"] },
                  },
                },
              },
            },
            {
              if: {
                required: ["command", "input"],
                properties: {
                  command: { const: "record_signal" },
                  input: {
                    type: "object",
                    required: ["sourceKind"],
                    properties: { sourceKind: { const: "file" } },
                  },
                },
              },
              then: {
                properties: {
                  input: { type: "object", required: ["sourceAssetId"] },
                },
              },
            },
          ],
        },
      },
      responses: {
        BadRequest: errorResponse("请求无效"),
        Unauthorized: errorResponse("需要认证"),
        Conflict: errorResponse("流版本或幂等键冲突"),
        CursorExpired: errorResponse("事件游标已过保留期"),
        Unprocessable: errorResponse("请求不符合领域约束"),
      },
    },
  };
}

function errorResponse(description: string): JsonObject {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
  };
}
