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
  assert.match(serialized, /\/v2\/plugins\/opc\/opportunities/);
  assert.match(serialized, /\/v2\/plugins\/opc\/samples\/read-only/);
  assert.match(serialized, /\/v2\/plugins\/coding\/repositories/);
  assert.match(serialized, /\/v2\/plugins\/coding\/tasks/);
  assert.match(serialized, /\/v2\/plugins\/coding\/samples\/read-only/);
  assert.match(serialized, /\/v2\/plugins\/opc\/opportunities\/\{opportunityId\}\/exports/);
  assert.match(serialized, /\/v2\/plugins\/coding\/executions\/\{executionId\}\/reconciliation/);
  assert.match(serialized, /\/v2\/plugins\/coding\/executions\/\{executionId\}\/reconciliation-decisions/);
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
  assert.equal(assetSchema.properties.attachments.items.properties.protected.type, "boolean");
  const assetDelete = (document.paths as Record<string, Record<string, {
    requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
  }>>)["/v2/assets/{assetId}"]?.delete;
  assert.equal(
    assetDelete?.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/DeleteAssetMutation",
  );
  const opcCommand = (document.paths as Record<string, Record<string, {
    requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
  }>>)["/v2/plugins/opc/opportunities/{opportunityId}/commands"]?.post;
  assert.equal(
    opcCommand?.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/OpcOpportunityCommandMutation",
  );
  const opcCommandSchema = (document.components as { schemas: Record<string, any> })
    .schemas.OpcOpportunityCommandMutation;
  assert.deepEqual(opcCommandSchema.allOf[0].then.properties.input.required, [
    "interviewId", "participantRef", "occurredAt", "rawRecordAssetId",
  ]);
  assert.deepEqual(opcCommandSchema.allOf[0].then.properties.input.not.required, ["rawRecord"]);
  assert.deepEqual(opcCommandSchema.allOf[1].then.properties.input.required, ["sourceAssetId"]);
  assert.equal(
    (document.components as { schemas: Record<string, unknown> }).schemas.ApiError !== undefined,
    true,
  );
  const reconciliation = (document.paths as Record<string, Record<string, {
    requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
    responses?: Record<string, unknown>;
  }>>)["/v2/plugins/coding/executions/{executionId}/reconciliation-decisions"]?.post;
  assert.equal(
    reconciliation?.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/DecideCodingReconciliationMutation",
  );
  const reconciliationSchema = (document.components as { schemas: Record<string, any> })
    .schemas.DecideCodingReconciliationMutation;
  assert.deepEqual(reconciliationSchema.properties.decision.enum, [
    "terminate", "mark_completed", "create_new_call",
  ]);
  assert.ok(reconciliation?.responses?.["202"]);
  const reconciliationView = (document.paths as Record<string, Record<string, {
    parameters?: Array<{ name: string }>;
    responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
  }>>)["/v2/plugins/coding/executions/{executionId}/reconciliation"]?.get;
  assert.equal(reconciliationView?.parameters?.some(({ name }) => name === "Idempotency-Key"), false);
  assert.equal(
    reconciliationView?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodingReconciliationEnvelope",
  );
  const reconciliationViewSchema = (document.components as { schemas: Record<string, any> })
    .schemas.CodingReconciliation;
  assert.ok(reconciliationViewSchema.required.includes("taskTitle"));
  assert.ok(reconciliationViewSchema.required.includes("nextStep"));
  assert.equal(reconciliationViewSchema.properties.expectedStreamVersion.minimum, 1);
  assert.equal(reconciliationViewSchema.properties.expectedCodingStreamVersion.minimum, 1);
  assert.equal(reconciliationViewSchema.properties.evidence.properties.summary.minLength, 1);
  assert.ok(reconciliationViewSchema.required.includes("newCall"));
  assert.equal(reconciliationViewSchema.properties.newCall.properties.allowed.type, "boolean");
  assert.equal(reconciliationViewSchema.properties.availableDecisions.minItems, 0);
  for (const operation of API_OPERATIONS_V2.filter((entry) => entry.mutation)) {
    const paths = document.paths as Record<string, Record<string, { parameters?: Array<{ name: string }> }>>;
    assert.equal(paths[operation.path]?.[operation.method]?.parameters?.[0]?.name, "Idempotency-Key");
  }
  assert.equal(
    API_OPERATIONS_V2.some((operation) => String(operation.path) === "/v2/plugins/{pluginId}/{path}"),
    false,
    "OpenAPI path 参数不能伪装成跨斜杠通配符",
  );
  const officialProductMutations = {
    createOpcOpportunity: "CreateProductObjectMutation",
    createCodingRepository: "CreateProductObjectMutation",
    createCodingTask: "CreateProductObjectMutation",
    runOpcReadOnlySample: "RunReadOnlySampleMutation",
    runCodingReadOnlySample: "RunReadOnlySampleMutation",
  };
  for (const [operationId, schemaName] of Object.entries(officialProductMutations)) {
    const operation = API_OPERATIONS_V2.find((candidate) => candidate.operationId === operationId)!;
    const operationDocument = (document.paths as Record<string, Record<string, any>>)
      [operation.path]?.[operation.method];
    assert.equal(
      operationDocument.requestBody.content["application/json"].schema.$ref,
      `#/components/schemas/${schemaName}`,
    );
    assert.equal(
      (document.components as { schemas: Record<string, any> }).schemas[schemaName]
        .additionalProperties,
      false,
    );
  }
});

test("OpenAPI 声明插件局部停用、全局停用与清除操作", () => {
  assert.deepEqual(
    API_OPERATIONS_V2
      .filter((operation) => ["deactivatePlugin", "disablePlugin", "purgePlugin"].includes(operation.operationId))
      .map(({ method, path, operationId, versioned }) => ({ method, path, operationId, versioned })),
    [
      {
        method: "post",
        path: "/v2/plugins/installations/{pluginId}/disable",
        operationId: "disablePlugin",
        versioned: true,
      },
      {
        method: "delete",
        path: "/v2/plugins/installations/{pluginId}",
        operationId: "purgePlugin",
        versioned: true,
      },
      {
        method: "delete",
        path: "/v2/workspaces/{workspaceId}/plugin-activations/{pluginId}",
        operationId: "deactivatePlugin",
        versioned: true,
      },
    ],
  );
});

test("OpenAPI 声明 Coding Runner 检查、确认与显式选择", () => {
  const operations = Object.fromEntries(API_OPERATIONS_V2.map((operation) => [
    operation.operationId,
    `${operation.method} ${operation.path}`,
  ]));
  assert.equal(operations.listCodingRunners, "get /v2/plugins/coding/runners");
  assert.equal(
    operations.inspectCodingRunner,
    "post /v2/plugins/coding/runners/{runnerId}/inspections",
  );
  assert.equal(
    operations.confirmCodingRunner,
    "post /v2/plugins/coding/runners/{runnerId}/confirmations",
  );

  const document = createOpenApiDocument();
  const schemas = (document.components as { schemas: Record<string, any> }).schemas;
  assert.deepEqual(schemas.RunnerBinaryInspection.required, [
    "requestedPath", "realPath", "sha256", "device", "inode", "byteLength", "modifiedAtMs",
  ]);
  assert.equal(schemas.RunnerBinaryInspection.properties.version, undefined);
  assert.deepEqual(schemas.CreateTurnMutation.properties.runnerId.enum, [
    "builtin", "claude-cli", "codex-cli",
  ]);
  assert.deepEqual(schemas.ConfirmCodingRunnerMutation.required, [
    "workspaceId", "expectedStreamVersion", "binaryPath", "version", "sha256",
  ]);
  assert.equal(schemas.ConfirmCodingRunnerMutation.properties.binaryPath.pattern, "^/");
  assert.equal(schemas.ConfirmCodingRunnerMutation.properties.sha256.pattern, "^[0-9a-f]{64}$");
  const paths = document.paths as Record<string, Record<string, {
    parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
    responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
  }>>;
  assert.deepEqual(
    paths["/v2/plugins/coding/runners"]?.get?.parameters,
    [{ name: "workspaceId", in: "query", required: true, schema: { type: "string" } }],
  );
  assert.equal(
    paths["/v2/plugins/coding/runners/{runnerId}/confirmations"]?.post?.parameters
      ?.some((parameter) => parameter.name === "runnerId" && parameter.in === "path" && parameter.required),
    true,
  );
  const runnerParameter = paths[
    "/v2/plugins/coding/runners/{runnerId}/confirmations"
  ]?.post?.parameters?.find((parameter) => parameter.name === "runnerId") as
    | { schema?: { enum?: string[] } }
    | undefined;
  assert.deepEqual(runnerParameter?.schema?.enum, ["claude-cli", "codex-cli"]);
  assert.equal(
    paths["/v2/plugins/coding/runners/{runnerId}/inspections"]?.post
      ?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RunnerBinaryInspectionEnvelope",
  );
});
