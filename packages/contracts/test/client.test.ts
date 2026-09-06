import assert from "node:assert/strict";
import test from "node:test";
import { apiPath, apiRequest, operationInputFields } from "../src/client.js";

test("客户端路径、请求和 CLI 字段来自同一 OpenAPI 契约", () => {
  assert.equal(apiPath("getWorkspace", { workspaceId: "a/b?#" }), "/v2/workspaces/a%2Fb%3F%23");
  assert.deepEqual(apiRequest("updateWorkspace", { path: { workspaceId: "a" }, body: { expectedStreamVersion: 1, name: "研究" } }), {
    path: "/v2/workspaces/a", method: "PATCH", body: { expectedStreamVersion: 1, name: "研究" }, mutation: true,
  });
  assert.ok(operationInputFields("updateWorkspace").some((field) => field.name === "expectedStreamVersion" && field.required));
  assert.throws(() => apiPath("getWorkspace", {} as never));
  assert.throws(() => apiPath("getWorkspace", { workspaceId: ".." }));
});
