// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/index.js";

test("goal list uses the workspace Goal contract", async () => {
  const requests: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const result = await runCli(["goal", "list", "--workspace", "workspace-1", "--json"], {
    io: { stdout: line => out.push(line), stderr: line => err.push(line) },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ data: [], traceId: "goal-test" });
    },
  });
  assert.equal(result, 0, err.join("\n"));
  assert.deepEqual(requests, ["GET /v2/workspaces/workspace-1/goals"]);
  assert.deepEqual(JSON.parse(out[0]!), { ok: true, command: "goal list", data: [] });
});

test("goal mutations require an explicit reviewed version", async () => {
  let calls = 0;
  const err: string[] = [];
  const result = await runCli(["goal", "start", "goal-1", "--json"], {
    io: { stdout: line => err.push(line), stderr: line => err.push(line) },
    fetch: async () => { calls++; throw new Error("unexpected request"); },
  });
  assert.notEqual(result, 0);
  assert.equal(calls, 0);
  assert.match(err.join("\n"), /version/u);
});

test("goal start binds the reviewed plan and propagates a version conflict without retry", async () => {
  const requests: { path: string; key: string | null; body: unknown }[] = [];
  const output: string[] = [];
  const result = await runCli(["goal", "start", "goal-1", "--workspace", "workspace-1", "--version", "3", "--plan", "plan-2", "--plan-digest", "fixed-digest", "--json"], {
    io: { stdout: line => output.push(line), stderr: line => output.push(line) }, idempotencyKey: () => "goal-start",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ path: new URL(request.url).pathname, key: request.headers.get("Idempotency-Key"), body: await request.json() });
      return Response.json({ code: "STREAM_VERSION_CONFLICT", message: "目标版本已变化", action: "重新读取目标", fieldIssues: [], traceId: "goal-test", retryable: false }, { status: 409 });
    },
  });
  assert.notEqual(result, 0);
  assert.deepEqual(requests, [{ path: "/v2/goals/goal-1/commands", key: "goal-start", body: {
    workspaceId: "workspace-1", expectedStreamVersion: 3, command: "start", planRevisionId: "plan-2", planDigest: "fixed-digest",
  } }]);
  assert.equal(JSON.parse(output[0]!).error.code, "STREAM_VERSION_CONFLICT");
});

test("goal acceptance preserves item digests and reviewed criteria from the input file", async t => {
  const root = await mkdtemp(join(tmpdir(), "mn-goal-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "acceptance.json");
  const payload = { deliverySetId: "delivery-1", criteriaVersion: "criteria-1", items: [{ key: "result", digest: "artifact-digest", reviewedCriterionIds: ["sources", "limits"] }] };
  await writeFile(file, JSON.stringify(payload));
  let body: unknown;
  await runCli(["goal", "accept", "goal-1", "--workspace", "workspace-1", "--version", "8", "--file", file, "--json"], {
    io: { stdout() {}, stderr() {} }, fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).pathname, "/v2/goals/goal-1/acceptances");
      assert.ok(request.headers.get("Idempotency-Key"));
      body = await request.json();
      return Response.json({}, { status: 409 });
    },
  });
  assert.deepEqual(body, { ...payload, workspaceId: "workspace-1", expectedStreamVersion: 8 });
});
