// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createSalesBusinessProvider } from "../src/business-provider.js";

test("人工回执核对调用专用归档核验接口，不重发出包", async () => {
  const paths: string[] = [];
  const operationKey = "a".repeat(64);
  const ports = createSalesBusinessProvider({ endpoint: "https://sales.example.test/api/v1/os-business", tokenResolver: async () => "fixture-secret",
    fetch: async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      assert.equal(init?.redirect, "error");
      return Response.json({ data: { schemaVersion: "1", actionId: "action", operationKey, status: "unknown", files: [], observedAt: "2026-09-18T00:00:00.000Z" } });
    },
  });
  await ports.receipts.reconcile({ schemaVersion: "1", scope: { tenantId: "tenant", workspaceId: "workspace", principalId: "reviewer", customerId: "customer" }, actionId: "action", operationKey });
  assert.deepEqual(paths, ["/api/v1/os-business/actions/reconcile"]);
});
