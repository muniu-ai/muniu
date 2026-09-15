import { CORE_API_ROUTES } from "./api.js";
import type { JsonObject } from "./json.js";
import { API_OUTPUT_COMPONENTS_V2, API_OUTPUT_SCHEMAS_V2 } from "./generated-responses.js";
import type { ApiOutputsV2 } from "./api-outputs.js";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface ApiOperationV2 {
  readonly method: HttpMethod;
  readonly path: (typeof CORE_API_ROUTES)[number];
  readonly operationId: string;
  readonly mutation: boolean;
  readonly versioned: boolean;
}

export const API_OPERATIONS_V2 = [
  { method: "post", path: "/v2/plugins/{pluginId}/{commandId}", operationId: "runPluginCommand", mutation: true, versioned: true },
  { method: "get", path: "/v2/workspaces/{workspaceId}/plugin-surfaces", operationId: "getPluginSurfaces", mutation: false, versioned: false },
  { method: "get", path: "/v2/plugins/catalog", operationId: "listPluginCatalog", mutation: false, versioned: false },
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
  { method: "post", path: "/v2/key-revocations/{revocationId}/decisions", operationId: "retryKeyRevocation", mutation: true, versioned: true },
  { method: "get", path: "/v2/activity", operationId: "listActivity", mutation: false, versioned: false },
  { method: "post", path: "/v2/approvals/{approvalId}/decisions", operationId: "decideApproval", mutation: true, versioned: true },
  { method: "get", path: "/v2/deliverables", operationId: "listDeliverables", mutation: false, versioned: false },
  { method: "post", path: "/v2/assets", operationId: "createAssets", mutation: true, versioned: true },
  { method: "get", path: "/v2/assets/{assetId}", operationId: "getAsset", mutation: false, versioned: false },
  { method: "get", path: "/v2/assets/{assetId}/content", operationId: "downloadAsset", mutation: false, versioned: false },
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
  { method: "get", path: "/v2/plugins/opc/opportunities", operationId: "listOpcOpportunities", mutation: false, versioned: false },
  { method: "post", path: "/v2/plugins/opc/opportunities", operationId: "createOpcOpportunity", mutation: true, versioned: true },
  { method: "get", path: "/v2/plugins/opc/opportunities/{opportunityId}", operationId: "getOpcOpportunity", mutation: false, versioned: false },
  { method: "post", path: "/v2/plugins/opc/opportunities/{opportunityId}/commands", operationId: "commandOpcOpportunity", mutation: true, versioned: true },
  { method: "get", path: "/v2/plugins/opc/opportunities/{opportunityId}/deliverables", operationId: "previewOpcDeliverables", mutation: false, versioned: false },
  { method: "post", path: "/v2/plugins/opc/opportunities/{opportunityId}/exports", operationId: "exportOpcDeliverables", mutation: true, versioned: true },
  { method: "post", path: "/v2/plugins/opc/samples/read-only", operationId: "runOpcReadOnlySample", mutation: true, versioned: true },
  { method: "post", path: "/v2/plugins/coding/repositories", operationId: "createCodingRepository", mutation: true, versioned: true },
  { method: "get", path: "/v2/plugins/coding/repositories", operationId: "listCodingRepositories", mutation: false, versioned: false },
  { method: "get", path: "/v2/plugins/coding/tasks", operationId: "listCodingTasks", mutation: false, versioned: false },
  { method: "post", path: "/v2/plugins/coding/tasks", operationId: "createCodingTask", mutation: true, versioned: true },
  { method: "post", path: "/v2/plugins/coding/samples/read-only", operationId: "runCodingReadOnlySample", mutation: true, versioned: true },
  { method: "get", path: "/v2/plugins/coding/runners", operationId: "listCodingRunners", mutation: false, versioned: false },
  { method: "post", path: "/v2/plugins/coding/runners/{runnerId}/inspections", operationId: "inspectCodingRunner", mutation: true, versioned: false },
  { method: "post", path: "/v2/plugins/coding/runners/{runnerId}/confirmations", operationId: "confirmCodingRunner", mutation: true, versioned: true },
  { method: "get", path: "/v2/plugins/coding/executions/{executionId}/reconciliation", operationId: "getCodingReconciliation", mutation: false, versioned: false },
  { method: "post", path: "/v2/plugins/coding/executions/{executionId}/reconciliation-decisions", operationId: "decideCodingReconciliation", mutation: true, versioned: true },
] as const satisfies readonly ApiOperationV2[];

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
    "createOpcOpportunity",
    "createCodingRepository",
    "createCodingTask",
    "exportOpcDeliverables",
  ].includes(operationId)) return "201";
  return "200";
}

function successResponseSchema(operationId: string): JsonObject {
  if (operationId === "inspectCodingRunner") return { $ref: "#/components/schemas/RunnerBinaryInspectionEnvelope" };
  if (operationId === "getCodingReconciliation") return { $ref: "#/components/schemas/CodingReconciliationEnvelope" };
  const data = API_OUTPUT_SCHEMAS_V2[operationId];
  if (!data) throw new Error(`缺少响应契约：${operationId}`);
  return { type: "object", additionalProperties: false, required: ["data", "traceId"],
    properties: { data, traceId: { type: "string" } } };
}

type ContractOperation = (typeof API_OPERATIONS_V2)[number]["operationId"];
const outputCoverage: Exclude<ContractOperation, keyof ApiOutputsV2> extends never
  ? Exclude<keyof ApiOutputsV2, ContractOperation> extends never ? true : never : never = true;
void outputCoverage;

export function createOpenApiDocument(): JsonObject {
  const paths: Record<string, Record<string, JsonObject>> = {};
  for (const operation of API_OPERATIONS_V2) {
    const parameters: JsonObject[] = operation.mutation
      ? [{ in: "header", name: "Idempotency-Key", required: true, schema: { type: "string" } }]
      : [];
    for (const match of operation.path.matchAll(/\{([^}]+)\}/gu)) {
      parameters.push({
        in: "path",
        name: match[1]!,
        required: true,
        schema: match[1] === "runnerId"
          ? { type: "string", enum: ["claude-cli", "codex-cli"] }
          : { type: "string" },
      });
    }
    if (operation.operationId === "streamWorkspaceEvents") {
      parameters.push(
        { in: "header", name: "Last-Event-ID", required: false, schema: { type: "integer", minimum: 0 } },
        { in: "query", name: "after", required: false, schema: { type: "integer", minimum: 0 } },
      );
    }
    if (["listInbox", "listMemories", "listDeliverables", "getHealth"].includes(operation.operationId)) parameters.push({ in: "query", name: "workspaceId", required: false, schema: { type: "string" } });
    if (operation.operationId === "listActivity") parameters.push({ in: "query", name: "workspaceId", required: true, schema: { type: "string" } });
    if (operation.operationId === "listMemories") parameters.push({ in: "query", name: "namespace", required: false, schema: { type: "string" } });
    if ([
      "listCodingRunners",
      "listOpcOpportunities",
      "getOpcOpportunity",
      "previewOpcDeliverables",
      "listCodingTasks",
      "listCodingRepositories",
    ].includes(operation.operationId)) {
      parameters.push({
        in: "query",
        name: "workspaceId",
        required: true,
        schema: { type: "string" },
      });
    }
    paths[operation.path] ??= {};
    paths[operation.path]![operation.method] = {
      operationId: operation.operationId,
      parameters,
      ...(operation.mutation ? {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: mutationSchema(operation.operationId, operation.versioned),
            },
          },
        },
      } : {}),
      responses: {
        [successStatus(operation.operationId)]: {
          description: operation.operationId === "downloadAsset" ? "经授权的原始文件；Content-Type 使用 Asset.mediaType，不使用 JSON 信封" : "成功",
          content: operation.operationId === "streamWorkspaceEvents"
            ? { "text/event-stream": { schema: { type: "string" } } }
            : operation.operationId === "downloadAsset" ? {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
              "*/*": { schema: { type: "string", format: "binary" } },
            }
            : { "application/json": { schema: successResponseSchema(operation.operationId) } },
        },
        ...(operation.operationId === "decideCodingReconciliation" ? {
          "202": {
            description: "已接受标记完成意图，等待受控 Worker 执行权威 Gate",
            content: { "application/json": { schema: successResponseSchema(operation.operationId) } },
          },
        } : {}),
        ...(operation.operationId === "commandExecution" ? {
          "202": { description: "后续输入已持久化入队", content: { "application/json": { schema: successResponseSchema(operation.operationId) } } },
        } : {}),
        ...(operation.operationId === "getReadiness" ? {
          "503": { description: "尚未就绪", content: { "application/json": { schema: successResponseSchema(operation.operationId) } } },
        } : {}),
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
        ...API_OUTPUT_COMPONENTS_V2,
        RunnerBinaryInspectionEnvelope: {
          type: "object",
          additionalProperties: false,
          required: ["data", "traceId"],
          properties: {
            data: { $ref: "#/components/schemas/RunnerBinaryInspection" },
            traceId: { type: "string" },
          },
        },
        RunnerBinaryInspection: {
          type: "object",
          additionalProperties: false,
          required: [
            "requestedPath", "realPath", "sha256", "device", "inode", "byteLength", "modifiedAtMs",
          ],
          properties: {
            requestedPath: { type: "string", minLength: 1 },
            realPath: { type: "string", minLength: 1 },
            sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            device: { type: "string", minLength: 1 },
            inode: { type: "string", minLength: 1 },
            byteLength: { type: "integer", minimum: 1 },
            modifiedAtMs: { type: "number", minimum: 0 },
          },
        },
        CodingReconciliationEnvelope: {
          type: "object",
          additionalProperties: false,
          required: ["data", "traceId"],
          properties: {
            data: { $ref: "#/components/schemas/CodingReconciliation" },
            traceId: { type: "string" },
          },
        },
        CodingReconciliation: {
          type: "object",
          additionalProperties: false,
          required: [
            "executionId", "workspaceId", "taskTitle", "nextStep", "runnerId", "status",
            "expectedStreamVersion", "expectedCodingStreamVersion", "evidence", "newCall",
            "availableDecisions",
          ],
          properties: {
            executionId: { type: "string", minLength: 1 },
            workspaceId: { type: "string", minLength: 1 },
            taskTitle: { type: "string", minLength: 1 },
            nextStep: { type: "string", minLength: 1 },
            runnerId: { type: "string", enum: ["claude-cli", "codex-cli"] },
            status: { type: "string", const: "needs_reconciliation" },
            expectedStreamVersion: { type: "integer", minimum: 1 },
            expectedCodingStreamVersion: { type: "integer", minimum: 1 },
            evidence: {
              type: "object",
              additionalProperties: false,
              required: ["candidateCount", "gateCount", "markCompletedAllowed", "summary"],
              properties: {
                candidateCount: { type: "integer", minimum: 0 },
                gateCount: { type: "integer", minimum: 0 },
                markCompletedAllowed: { type: "boolean" },
                codeEvidenceDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
                summary: { type: "string", minLength: 1 },
              },
            },
            newCall: {
              type: "object",
              additionalProperties: false,
              required: ["allowed", "summary"],
              properties: {
                allowed: { type: "boolean" },
                summary: { type: "string", minLength: 1 },
              },
            },
            availableDecisions: {
              type: "array",
              minItems: 0,
              uniqueItems: true,
              items: {
                type: "string",
                enum: ["terminate", "mark_completed", "create_new_call"],
              },
            },
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
        CreateTurnMutation: {
          type: "object",
          additionalProperties: false,
          required: ["expectedStreamVersion", "message"],
          properties: {
            expectedStreamVersion: { type: "integer", minimum: 0 },
            message: { type: "string", minLength: 1 },
            agentDefinitionId: { type: "string", minLength: 1 },
            modelBindingId: { type: "string", minLength: 1 },
            runnerId: { type: "string", enum: ["builtin", "claude-cli", "codex-cli"] },
          },
        },
        InspectCodingRunnerMutation: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "binaryPath"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            binaryPath: { type: "string", minLength: 1, pattern: "^/" },
          },
        },
        ConfirmCodingRunnerMutation: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "expectedStreamVersion", "binaryPath", "version", "sha256"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            expectedStreamVersion: { type: "integer", minimum: 0 },
            binaryPath: { type: "string", minLength: 1, pattern: "^/" },
            version: { type: "string", minLength: 1, maxLength: 256 },
            sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
        },
        DecideCodingReconciliationMutation: {
          type: "object",
          additionalProperties: false,
          required: ["expectedStreamVersion", "expectedCodingStreamVersion", "decision"],
          properties: {
            expectedStreamVersion: { type: "integer", minimum: 1 },
            expectedCodingStreamVersion: { type: "integer", minimum: 1 },
            decision: {
              type: "string",
              enum: ["terminate", "mark_completed", "create_new_call"],
            },
          },
        },
        CreateProductObjectMutation: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "expectedStreamVersion", "input"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            expectedStreamVersion: { type: "integer", const: 0 },
            input: { type: "string", minLength: 1 },
          },
        },
        CreateCodingTaskMutation: {
          type: "object", additionalProperties: false,
          required: ["workspaceId", "expectedStreamVersion", "input"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            expectedStreamVersion: { type: "integer", const: 0 },
            input: { type: "string", minLength: 1 },
            repositoryId: { type: "string", minLength: 1 },
          },
        },
        RunReadOnlySampleMutation: {
          type: "object",
          additionalProperties: false,
          required: ["workspaceId", "expectedStreamVersion"],
          properties: {
            workspaceId: { type: "string", minLength: 1 },
            expectedStreamVersion: { type: "integer", const: 0 },
          },
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

function mutationSchema(operationId: string, versioned: boolean): JsonObject {
  const string = { type: "string", minLength: 1 };
  const version = { type: "integer", minimum: 0 };
  const strings = { type: "array", items: string };
  const object = (required: readonly string[], properties: JsonObject, additionalProperties = false): JsonObject => ({ type: "object", required: [...required], properties, additionalProperties });
  const core: Readonly<Record<string, JsonObject>> = {
    setup: object([], {}),
    createWorkspace: object(["name", "viewMode", "pluginIds"], { name: string, viewMode: { enum: ["business", "professional"] }, pluginIds: strings }),
    updateWorkspace: object(["expectedStreamVersion"], { expectedStreamVersion: version, name: string, viewMode: { enum: ["business", "professional"] } }),
    createThread: object(["subject", "pluginId"], { subject: string, pluginId: string, resourceRef: object(["namespace", "resourceId"], { namespace: string, resourceId: string }) }),
    commandExecution: object(["expectedStreamVersion", "command"], { expectedStreamVersion: version, command: { enum: ["follow_up", "steer", "cancel", "resume"] }, message: string }),
    decideApproval: object(["expectedStreamVersion", "decision"], { expectedStreamVersion: version, decision: { enum: ["approve_once", "deny"] } }),
    createModelConnection: object(["presetId", "apiKey"], { presetId: { enum: ["openai", "deepseek", "anthropic"] }, apiKey: string, displayName: string }),
    probeModelConnection: object(["expectedStreamVersion"], { expectedStreamVersion: version, makeDefault: { type: "boolean" } }),
    installPlugin: object(["pluginId", "version"], { pluginId: string, version: string }),
    updatePlugin: object(["expectedStreamVersion", "version"], { expectedStreamVersion: version, version: string }),
    activatePlugin: object(["expectedStreamVersion", "pluginId"], { expectedStreamVersion: version, pluginId: string }),
    deactivatePlugin: object(["expectedStreamVersion"], { expectedStreamVersion: version }),
    disablePlugin: object(["expectedStreamVersion"], { expectedStreamVersion: version }),
    purgePlugin: object(["expectedStreamVersion"], { expectedStreamVersion: version }),
    runPluginCommand: object(["workspaceId", "expectedStreamVersion"], { workspaceId: string, expectedStreamVersion: version }, true),
    decideMemory: object(["expectedStreamVersion", "decision"], { expectedStreamVersion: version, decision: { enum: ["accept", "reject"] } }),
    retryKeyRevocation: object(["expectedStreamVersion", "decision"], { expectedStreamVersion: version, decision: { const: "retry" } }),
    deleteMemory: object(["expectedStreamVersion", "reason"], { expectedStreamVersion: version, reason: string }),
    proposeMemory: object(["workspaceId", "namespace", "resourceId", "sourceEventId", "value"], {
      workspaceId: string, namespace: string, resourceId: string, sourceEventId: string,
      scopeType: { enum: ["workspace", "thread", "resource", "principal"] }, confidence: { type: "number", minimum: 0, maximum: 1 },
      value: { type: "object", additionalProperties: true }, expiresAt: string, derivedFromMemoryId: string, derivedViaShareGrantId: string,
    }),
    reviseMemoryProposal: object(["expectedStreamVersion", "confidence", "value"], {
      expectedStreamVersion: version, confidence: { type: "number", minimum: 0, maximum: 1 }, value: { type: "object", additionalProperties: true },
    }),
    createShareGrant: object(["memoryId", "toNamespace", "expectedStreamVersion"], { memoryId: string, toNamespace: string, expectedStreamVersion: version }),
    revokeShareGrant: object(["expectedStreamVersion"], { expectedStreamVersion: version }),
    setWorkspaceMember: object(["expectedStreamVersion", "workspaceRole"], { expectedStreamVersion: version, workspaceRole: { enum: ["owner", "operator", "reviewer", "viewer"] } }),
    removeWorkspaceMember: object(["expectedStreamVersion"], { expectedStreamVersion: version }),
  };
  if (core[operationId]) return core[operationId]!;
  const schemas: Readonly<Record<string, string>> = {
    createAssets: "CreateAssetsMutation",
    deleteAsset: "DeleteAssetMutation",
    createTurn: "CreateTurnMutation",
    commandOpcOpportunity: "OpcOpportunityCommandMutation",
    inspectCodingRunner: "InspectCodingRunnerMutation",
    confirmCodingRunner: "ConfirmCodingRunnerMutation",
    decideCodingReconciliation: "DecideCodingReconciliationMutation",
    createOpcOpportunity: "CreateProductObjectMutation",
    createCodingRepository: "CreateProductObjectMutation",
    createCodingTask: "CreateCodingTaskMutation",
    runOpcReadOnlySample: "RunReadOnlySampleMutation",
    runCodingReadOnlySample: "RunReadOnlySampleMutation",
  };
  const schema = schemas[operationId];
  if (schema) return { $ref: `#/components/schemas/${schema}` };
  return versioned
    ? { $ref: "#/components/schemas/VersionedMutation" }
    : { type: "object", additionalProperties: true };
}

function errorResponse(description: string): JsonObject {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
  };
}
