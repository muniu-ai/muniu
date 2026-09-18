import assert from "node:assert/strict";
import test from "node:test";
import { apiPath, apiRequest, operationInputFields, parseApiResponse } from "../src/client.js";
import { API_OPERATIONS_V2, createOpenApiDocument } from "../src/openapi.js";
import { computeBusinessActionDigest, computeBusinessOperationKey, type IssueQuotePackageInputV1 } from "../src/business-effects.js";

test("asset metadata and binary downloads have separate typed operations", () => {
  const document = createOpenApiDocument() as any;
  const download = document.paths["/v2/assets/{assetId}/content"]?.get;
  assert.equal(download?.operationId, "downloadAsset");
  assert.deepEqual(download.responses["200"].content["application/octet-stream"].schema, { type: "string", format: "binary" });
  assert.equal(download.responses["200"].content["application/json"], undefined);
  assert.equal(document.paths["/v2/assets/{assetId}"].get.parameters.some((parameter: any) => parameter.name === "content"), false);
});

test("JSON 响应解析器不能接收下载或事件流操作", () => {
  assert.throws(() => {
    // @ts-expect-error 二进制响应必须使用下载客户端。
    parseApiResponse("downloadAsset", new ArrayBuffer(0));
  });
  assert.throws(() => {
    // @ts-expect-error SSE 必须使用事件流客户端。
    parseApiResponse("streamWorkspaceEvents", "data: {}");
  });
});

test("每个 JSON 响应都有独立输出契约，不允许空 data schema", () => {
  const document = createOpenApiDocument() as any;
  const resolve = (schema: any): any => schema.$ref
    ? resolve(document.components.schemas[schema.$ref.split("/").at(-1)]) : schema;
  for (const operation of API_OPERATIONS_V2) {
    const responses = document.paths[operation.path][operation.method].responses;
    for (const [status, response] of Object.entries(responses) as [string, any][]) {
      if (!status.startsWith("2")) continue;
      const schema = response.content?.["application/json"]?.schema;
      if (!schema) continue;
      const envelope = resolve(schema);
      assert.ok(envelope.properties?.data, operation.operationId);
      assert.ok(Object.keys(resolve(envelope.properties.data)).length > 0, operation.operationId);
      assert.notEqual(schema.$ref, "#/components/schemas/ApiEnvelope", operation.operationId);
    }
  }
});

test("客户端拒绝嵌套字段漂移、密钥泄漏和非 JSON 结果，错误不包含业务内容", () => {
  assert.deepEqual(parseApiResponse("getHealth", {
    data: { core: { status: "healthy" }, plugins: [] }, traceId: "trace",
  }), { core: { status: "healthy" }, plugins: [] });
  for (const data of [
    { core: { status: "broken" }, plugins: [] },
    { core: { status: "healthy" }, plugins: [{ pluginId: "example", status: 2 }] },
    { core: { status: "healthy", apiKey: "do-not-expose" }, plugins: [] },
  ]) assert.throws(() => parseApiResponse("getHealth", { data, traceId: "trace" }), (error: unknown) => {
    assert.match(String(error), /getHealth/);
    assert.doesNotMatch(String(error), /do-not-expose/);
    return true;
  });
  assert.deepEqual(parseApiResponse("runPluginCommand", { data: { nested: [1, null, true] }, traceId: "trace" }), { nested: [1, null, true] });
  assert.throws(() => parseApiResponse("runPluginCommand", { data: { invalid: Infinity }, traceId: "trace" }));
  assert.throws(() => parseApiResponse("getHealth", { data: { core: { status: "healthy" }, plugins: [] } }));
});

test("客户端路径、请求和 CLI 字段来自同一 OpenAPI 契约", () => {
  assert.equal(apiPath("getWorkspace", { workspaceId: "a/b?#" }), "/v2/workspaces/a%2Fb%3F%23");
  assert.deepEqual(apiRequest("updateWorkspace", { path: { workspaceId: "a" }, body: { expectedStreamVersion: 1, name: "研究" } }), {
    path: "/v2/workspaces/a", method: "PATCH", body: { expectedStreamVersion: 1, name: "研究" }, mutation: true,
  });
  assert.ok(operationInputFields("updateWorkspace").some((field) => field.name === "expectedStreamVersion" && field.required));
  assert.throws(() => apiPath("getWorkspace", {} as never));
  assert.throws(() => apiPath("getWorkspace", { workspaceId: ".." }));
  assert.deepEqual(apiRequest("listCodingTasks", { query: { workspaceId: "workspace/a" } }), {
    path: "/v2/plugins/coding/tasks?workspaceId=workspace%2Fa", method: "GET", mutation: false,
  });
});

test("业务出包 API 固定精确输入，不公开执行身份或通用发送入口", () => {
  const document = createOpenApiDocument() as any;
  const create = document.paths["/v2/business-actions"]?.post;
  assert.equal(create?.operationId, "createBusinessAction");
  assert.equal(document.paths["/v2/business-actions/{actionId}"]?.get?.operationId, "getBusinessAction");
  const body = document.components.schemas.CreateBusinessActionMutation;
  assert.equal(body?.additionalProperties, false);
  assert.equal(body?.properties.action.const, "issueQuotePackage");
  assert.equal(body?.properties.expectedStreamVersion.const, 0);
  for (const key of ["tenantId", "principalId", "workerId", "fencingToken", "operationKey", "quoteDigest"]) {
    assert.equal(body?.properties[key], undefined);
  }
  assert.equal(document.paths["/v2/business-actions/{actionId}/reconciliation-decisions"]?.post?.operationId, "reconcileBusinessAction");
  assert.deepEqual(document.components.schemas.ReconcileBusinessActionMutation.properties.decision.enum, ["mark_completed", "terminate"]);
});

test("业务 API 客户端复核摘要格式和回执语义，不把缺少回执的完成状态当成成果", () => {
  let action: IssueQuotePackageInputV1 = { schemaVersion: "1", action: "issueQuotePackage", actionId: "action-a", operationKey: "pending",
    scope: { tenantId: "tenant-a", workspaceId: "workspace-a", principalId: "person-a", customerId: "customer-a" },
    quote: { id: "quote-a", version: "1", digest: "a".repeat(64) }, businessDecision: { id: "decision-a", digest: "b".repeat(64) },
    template: { id: "template-a", version: "1", digest: "c".repeat(64) }, renderVersion: "1", exportFormat: "pdf", issueDate: "2026-09-18" };
  action = { ...action, operationKey: computeBusinessOperationKey(action) };
  const data = { schemaVersion: "1", id: action.actionId, tenantId: action.scope.tenantId, workspaceId: action.scope.workspaceId,
    executionId: "execution-a", jobId: "job-a", operationKey: action.operationKey, actionDigest: computeBusinessActionDigest(action),
    action, status: "queued", streamVersion: 1, createdAt: "2026-09-18T01:00:00.000Z", updatedAt: "2026-09-18T01:00:00.000Z" };
  assert.deepEqual(parseApiResponse("getBusinessAction", { data, traceId: "trace" }), data);
  for (const invalid of [{ ...data, actionDigest: "invalid" }, { ...data, status: "completed" },
    { ...data, tenantId: "tenant-b" }, { ...data, action: { ...action, issueDate: "2026-02-30" } }]) {
    assert.throws(() => parseApiResponse("getBusinessAction", { data: invalid, traceId: "trace" }), /公共契约/u);
  }
});
