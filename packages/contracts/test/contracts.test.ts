import assert from "node:assert/strict";
import test from "node:test";
import {
  API_OPERATIONS_V2,
  applyWorkflowTransition,
  approvalStillMatches,
  assertPluginManifestShape,
  createOpenApiDocument,
  isPotentiallyAutoApprovable,
  type PluginManifestV1,
  type ToolCallIntent,
  type WorkflowDefinitionV1,
} from "../src/index.js";

const workflow: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  id: "review",
  version: "1.0.0",
  initialState: "draft",
  states: [{ id: "draft" }, { id: "ready" }, { id: "decided", terminal: true }],
  transitions: [
    { from: "draft", event: "prepare", to: "ready", requiredFields: ["title"] },
    { from: "ready", event: "decide", to: "decided", humanOnly: true },
  ],
};

test("声明式工作流检查字段和人工决策", () => {
  assert.throws(
    () => applyWorkflowTransition(workflow, "draft", "prepare", {}, "agent"),
    /title/,
  );
  assert.equal(
    applyWorkflowTransition(workflow, "draft", "prepare", { title: "方案" }, "agent"),
    "ready",
  );
  assert.throws(
    () => applyWorkflowTransition(workflow, "ready", "decide", {}, "agent"),
    /人工确认/,
  );
  assert.equal(applyWorkflowTransition(workflow, "ready", "decide", {}, "human"), "decided");
});

test("批准只匹配同一代、工具、参数、资源和权限承诺", () => {
  const intent: ToolCallIntent = {
    id: "call-1",
    executionId: "execution-1",
    generation: 2,
    toolId: "web.read",
    toolVersion: "1.0.0",
    effectClass: "external_read",
    intent: "读取公开网页",
    normalizedArguments: { url: "https://example.com" },
    argumentsDigest: "args",
    resourceRefs: [{ namespace: "web", resourceId: "https://example.com" }],
    resourcesDigest: "resources",
    authorityCommitment: "authority",
    expiresAt: "2026-09-04T00:00:00Z",
  };
  assert.equal(approvalStillMatches(intent, { ...intent }), true);
  assert.equal(approvalStillMatches(intent, { ...intent, generation: 3 }), false);
  assert.equal(approvalStillMatches(intent, { ...intent, resourcesDigest: "changed" }), false);
  assert.equal(isPotentiallyAutoApprovable("local_reversible_write"), true);
  assert.equal(isPotentiallyAutoApprovable("external_side_effect"), false);
  assert.equal(isPotentiallyAutoApprovable("unknown"), false);
});

test("插件清单拒绝浮动依赖和远程入口", () => {
  const manifest: PluginManifestV1 = {
    schemaVersion: 1,
    id: "opc",
    version: "0.2.0",
    engineApi: "0.2.0",
    displayName: "OPC",
    description: "机会验证",
    entrypoints: { host: "./dist/host.js", ui: "./dist/ui.js" },
    contributes: {
      routes: [], navigation: [], widgets: [], commands: [], agents: [], skills: [],
      workflows: [], tools: [], memorySchemas: [], healthCheck: "health",
    },
    permissions: [],
    dataNamespace: "opc",
    eventSchemas: {},
    projections: [],
    dependencies: [{ id: "base", version: "1.2.3", sha256: "a".repeat(64) }],
    packageSha256: "b".repeat(64),
    signature: { algorithm: "Ed25519", keyId: "official-1", value: "signature" },
    release: {
      sequence: 1,
      publishedAt: "2026-09-04T00:00:00Z",
      expiresAt: "2026-09-05T00:00:00Z",
      source: "https://plugins.muniu.example/opc",
    },
    license: "Apache-2.0",
  };
  assert.doesNotThrow(() => assertPluginManifestShape(manifest));
  assert.throws(
    () => assertPluginManifestShape({
      ...manifest,
      dependencies: [{ ...manifest.dependencies[0]!, version: "^1.2.3" }],
    }),
    /固定版本/,
  );
  assert.throws(
    () => assertPluginManifestShape({ ...manifest, entrypoints: { host: "https://bad.example/a.js" } }),
    /本地资源/,
  );
});

test("OpenAPI 目录只有 v2，所有写操作要求幂等键", () => {
  assert.ok(API_OPERATIONS_V2.every((operation) => operation.path.startsWith("/v2/")));
  assert.ok(API_OPERATIONS_V2.filter((operation) => operation.mutation).length > 0);
  const document = createOpenApiDocument();
  const serialized = JSON.stringify(document);
  assert.doesNotMatch(serialized, /\/v1(?:\/|\")/);
  assert.match(serialized, /\/v2\/setup/);
  assert.match(serialized, /\/v2\/workspaces\/\{workspaceId\}\/home/);
  assert.equal(
    (document.paths as Record<string, Record<string, unknown>>)[
      "/v2/workspaces/{workspaceId}/threads/{threadId}/turns"
    ]?.get !== undefined,
    true,
  );
  assert.match(serialized, /\/v2\/memories\/\{memoryId\}\/decisions/);
  assert.match(serialized, /\/v2\/plugins\/opc\/opportunities\/\{opportunityId\}\/commands/);
  assert.match(serialized, /\/v2\/plugins\/opc\/opportunities\/\{opportunityId\}\/exports/);
  const assetUpload = (document.paths as Record<string, Record<string, {
    requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
    responses?: Record<string, unknown>;
  }>>)["/v2/assets"]?.post;
  assert.equal(
    assetUpload?.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CreateAssetsMutation",
  );
  assert.equal(assetUpload?.responses?.["201"] !== undefined, true);
  const assetSchema = (document.components as { schemas: Record<string, any> })
    .schemas.CreateAssetsMutation;
  assert.equal(assetSchema.properties.expectedStreamVersion.const, 0);
  assert.equal(assetSchema.properties.attachments.maxItems, 20);
  assert.equal(
    (document.components as { schemas: Record<string, unknown> }).schemas.ApiError !== undefined,
    true,
  );
  for (const operation of API_OPERATIONS_V2.filter((entry) => entry.mutation)) {
    const paths = document.paths as Record<string, Record<string, { parameters?: Array<{ name: string }> }>>;
    assert.equal(paths[operation.path]?.[operation.method]?.parameters?.[0]?.name, "Idempotency-Key");
  }
});
