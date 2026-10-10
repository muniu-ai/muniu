// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/index.js";

async function command(args: string[]) {
  const requests: { path: string; query: string; method: string; key: string | null; body?: unknown }[] = [], output: string[] = [];
  const code = await runCli(["goal", ...args, "--json"], {
    io: { stdout: line => output.push(line), stderr: line => output.push(line) }, idempotencyKey: () => "team-operation",
    fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      requests.push({ path: url.pathname, query: url.search, method: request.method, key: request.headers.get("Idempotency-Key"),
        ...(request.method === "POST" ? { body: await request.json() } : {}) });
      return Response.json({ code: "STREAM_VERSION_CONFLICT", message: "需要重新读取状态", action: "读取后重试", fieldIssues: [], traceId: "team-test", retryable: false }, { status: 409 });
    },
  });
  return { requests, code, output };
}
test("团队计划仅显式选择并发送固定模板版本与内置模型", async () => {
  const result = await command(["plan", "goal", "--workspace", "workspace", "--version", "2", "--team", "research-summary", "--model", "model", "--key", "stable-plan"]);
  assert.deepEqual(result.requests, [{ path: "/v2/goals/goal/plan-revisions", query: "", method: "POST", key: "stable-plan", body: {
    workspaceId: "workspace", expectedStreamVersion: 2, kind: "team-v1", templateId: "research-summary", templateVersion: "1", modelBindingId: "model",
  } }]);
  assert.notEqual(result.code, 0); assert.equal(result.requests.length, 1);
});
test("团队参数错误或与单 Agent 调度混用时拒绝发送", async () => {
  for (const extra of [["--team", "unknown", "--model", "model"], ["--team", "research-summary"],
    ["--team", "research-summary", "--model", "model", "--runner", "codex-cli"],
    ["--team", "research-summary", "--model", "model", "--strategy", "quality"]]) {
    const result = await command(["plan", "goal", "--workspace", "workspace", "--version", "2", ...extra]);
    assert.equal(result.requests.length, 0); assert.notEqual(result.code, 0);
  }
});
test("节点与模板目录是带工作区的只读接口", async () => {
  const nodes = await command(["nodes", "goal", "--workspace", "workspace"]);
  assert.deepEqual(nodes.requests, [{ path: "/v2/goals/goal/nodes", query: "?workspaceId=workspace", method: "GET", key: null }]);
  const templates = await command(["templates", "--workspace", "workspace"]);
  assert.deepEqual(templates.requests, [{ path: "/v2/workspaces/workspace/team-templates", query: "", method: "GET", key: null }]);
});
test("暂停恢复和人工决定携带版本与幂等身份，不自动重试", async () => {
  for (const action of ["pause", "resume", "decide"]) {
    const extra = action === "decide" ? ["--node", "confirm", "--decision", "continue"] : [];
    const result = await command([action, "goal", "--workspace", "workspace", "--version", "3", "--key", "stable-command", ...extra]);
    assert.deepEqual(result.requests, [{ path: "/v2/goals/goal/commands", query: "", method: "POST", key: "stable-command", body: {
      workspaceId: "workspace", expectedStreamVersion: 3, command: action,
      ...(action === "decide" ? { nodeId: "confirm", decision: "continue" } : {}),
    } }]);
  }
  for (const extra of [[], ["--node", "confirm"], ["--node", "confirm", "--decision", "retry"]]) {
    const result = await command(["decide", "goal", "--workspace", "workspace", "--version", "3", ...extra]);
    assert.equal(result.requests.length, 0); assert.notEqual(result.code, 0);
  }
});
