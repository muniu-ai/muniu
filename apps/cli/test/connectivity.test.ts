// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/index.js";

test("doctor workspace reports Agent checks independently of Host health", async () => {
  const output: string[] = [], paths: string[] = [];
  const result = await runCli(["doctor", "--workspace", "w1", "--json"], { io: { stdout: line => output.push(line), stderr: line => output.push(line) },
    fetch: async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname; paths.push(path);
      const data = path.endsWith("agent-readiness") ? { workspaceId: "w1", checkedAt: "2026-10-09T00:00:00.000Z", agents: [{ agentId: "workbuddy", displayName: "WorkBuddy", scope: "workspace", support: "not_supported", status: "blocked", checks: [{ id: "adapter", status: "blocked", message: "尚未接入" }] }] }
        : path.endsWith("health") ? { core: { status: "healthy" }, plugins: [] } : { ready: true, issues: [] };
      return Response.json({ data, traceId: "test" });
    },
  });
  assert.equal(result, 0, output.join("\n"));
  assert.equal(paths.includes("/v2/workspaces/w1/agent-readiness"), true);
  assert.equal(JSON.parse(output[0]!).data.agents.agents[0].status, "blocked");
});

test("model select uses a version and idempotency key", async () => {
  const output: string[] = [];
  const result = await runCli(["model", "select", "c1", "--model", "qwen-plus", "--version", "2", "--json"], {
    idempotencyKey: () => "select-model", io: { stdout: line => output.push(line), stderr: line => output.push(line) },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).pathname, "/v2/model-connections/c1/model");
      assert.equal(request.headers.get("Idempotency-Key"), "select-model");
      assert.deepEqual(await request.json(), { expectedStreamVersion: 2, modelName: "qwen-plus" });
      return Response.json({ data: { id: "new", tenantId: "local", presetId: "qwen", displayName: "通义千问", defaultModel: "qwen-plus", discoveredModels: ["qwen-plus"], modelOptions: [{ modelName: "qwen-plus", selectable: true }], status: "ready", streamVersion: 1, defaultForNewExecutions: true }, traceId: "test" });
    },
  });
  assert.equal(result, 0, output.join("\n"));
  assert.equal(JSON.parse(output[0]!).data.id, "new");
});
