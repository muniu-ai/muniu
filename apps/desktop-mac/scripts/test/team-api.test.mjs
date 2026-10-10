// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
const bundled = await build({ entryPoints: [new URL("../../src/api.ts", import.meta.url).pathname], bundle: true,
  platform: "browser", format: "esm", write: false, define: { "import.meta.env.VITE_MN_API_URL": '"http://host.test"' } });
const { AgentOsClient } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

test("桌面团队接口保留计划、决定与重试的请求身份", async () => {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    requests.push({ path: url.pathname, query: url.search, method: request.method, key: request.headers.get("Idempotency-Key"),
      ...(request.method === "POST" ? { body: await request.json() } : {}) });
    return Response.json({ code: "STREAM_VERSION_CONFLICT", message: "版本变化", action: "重新读取", fieldIssues: [], traceId: "team", retryable: false }, { status: 409 });
  };
  try {
    const api = new AgentOsClient("http://host.test");
    const detail = { goal: { id: "goal", workspaceId: "workspace", streamVersion: 3 }, plan: { id: "plan", digest: "fixed-digest", kind: "team-v1" } };
    for (const work of [() => api.teamTemplates("workspace"), () => api.goalNodes("workspace", "goal"),
      () => api.planTeamGoal(detail, { templateId: "research-summary", templateVersion: "1", modelBindingId: "model" }, "stable-plan"),
      () => api.commandGoal(detail, "pause", "stable-pause"),
      () => api.decideGoal(detail, "confirm", "continue", "stable-decision")]) {
      try { await work(); } catch { /* Inspect requests independently of the deliberate conflict. */ }
    }
    assert.deepEqual(requests, [
      { path: "/v2/workspaces/workspace/team-templates", query: "", method: "GET", key: null },
      { path: "/v2/goals/goal/nodes", query: "?workspaceId=workspace", method: "GET", key: null },
      { path: "/v2/goals/goal/plan-revisions", query: "", method: "POST", key: "stable-plan", body: { workspaceId: "workspace", expectedStreamVersion: 3, kind: "team-v1", templateId: "research-summary", templateVersion: "1", modelBindingId: "model" } },
      { path: "/v2/goals/goal/commands", query: "", method: "POST", key: "stable-pause", body: { workspaceId: "workspace", expectedStreamVersion: 3, command: "pause" } },
      { path: "/v2/goals/goal/commands", query: "", method: "POST", key: "stable-decision", body: { workspaceId: "workspace", expectedStreamVersion: 3, command: "decide", nodeId: "confirm", decision: "continue" } },
    ]);
  } finally { globalThis.fetch = original; }
});
