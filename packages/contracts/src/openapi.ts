import { CORE_API_ROUTES } from "./api.js";
import type { JsonObject } from "./json.js";

type HttpMethod = "get" | "post" | "patch" | "delete";

export interface ApiOperationV2 {
  readonly method: HttpMethod;
  readonly path: (typeof CORE_API_ROUTES)[number];
  readonly operationId: string;
  readonly mutation: boolean;
  readonly versioned: boolean;
}

export const API_OPERATIONS_V2: readonly ApiOperationV2[] = [
  { method: "get", path: "/v2/workspaces", operationId: "listWorkspaces", mutation: false, versioned: false },
  { method: "post", path: "/v2/workspaces", operationId: "createWorkspace", mutation: true, versioned: false },
  { method: "patch", path: "/v2/workspaces/{workspaceId}", operationId: "updateWorkspace", mutation: true, versioned: true },
  { method: "get", path: "/v2/workspaces/{workspaceId}/threads", operationId: "listThreads", mutation: false, versioned: false },
  { method: "post", path: "/v2/workspaces/{workspaceId}/threads", operationId: "createThread", mutation: true, versioned: false },
  { method: "post", path: "/v2/workspaces/{workspaceId}/threads/{threadId}/turns", operationId: "createTurn", mutation: true, versioned: true },
  { method: "get", path: "/v2/workspaces/{workspaceId}/events", operationId: "streamWorkspaceEvents", mutation: false, versioned: false },
  { method: "post", path: "/v2/executions/{executionId}/commands", operationId: "commandExecution", mutation: true, versioned: true },
  { method: "get", path: "/v2/inbox", operationId: "listInbox", mutation: false, versioned: false },
  { method: "post", path: "/v2/approvals/{approvalId}/decisions", operationId: "decideApproval", mutation: true, versioned: true },
  { method: "get", path: "/v2/deliverables", operationId: "listDeliverables", mutation: false, versioned: false },
  { method: "get", path: "/v2/assets/{assetId}", operationId: "getAsset", mutation: false, versioned: false },
  { method: "get", path: "/v2/memories", operationId: "listMemories", mutation: false, versioned: false },
  { method: "post", path: "/v2/memories", operationId: "proposeMemory", mutation: true, versioned: false },
  { method: "post", path: "/v2/share-grants", operationId: "createShareGrant", mutation: true, versioned: true },
  { method: "post", path: "/v2/model-connections", operationId: "createModelConnection", mutation: true, versioned: false },
  { method: "post", path: "/v2/model-connections/{connectionId}/probe", operationId: "probeModelConnection", mutation: true, versioned: true },
  { method: "post", path: "/v2/plugins/installations", operationId: "installPlugin", mutation: true, versioned: false },
  { method: "post", path: "/v2/workspaces/{workspaceId}/plugin-activations", operationId: "activatePlugin", mutation: true, versioned: true },
  { method: "get", path: "/v2/plugins/{pluginId}/{path}", operationId: "getPluginResource", mutation: false, versioned: false },
  { method: "post", path: "/v2/plugins/{pluginId}/{path}", operationId: "mutatePluginResource", mutation: true, versioned: true },
] as const;

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
      responses: {
        "200": { description: "成功" },
        "409": { description: "流版本冲突" },
        "410": { description: "事件游标已过保留期" },
      },
      "x-muniu-versioned": operation.versioned,
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Muniu Agent OS API", version: "0.2.0" },
    paths,
  };
}
