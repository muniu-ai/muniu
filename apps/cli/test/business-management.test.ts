// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BusinessManagementViewV1 } from "@mn/contracts";
import { runCli } from "../src/index.js";

const emptyBusiness: BusinessManagementViewV1 = {
  state: { schemaVersion: 1, workspaceId: "workspace-1", currency: "CNY", streamVersion: 0, plans: [], customers: [], services: [],
    quotes: [], orders: [], adjustments: [], deliveries: [], acceptances: [], payments: [], paymentReversals: [], refunds: [], expenses: [], reviews: [] },
  summary: { currency: "CNY", sourceStreamVersion: 0, period: { start: "2026-10-01", end: "2026-10-09" }, cashReceivedMinor: "0",
    cashRefundedMinor: "0", cashExpensesMinor: "0", netCashFlowMinor: "0", contractedMinor: "0", outstandingMinor: "0", overdueMinor: "0", orders: [] },
};

test("opc business show 使用经营契约读取指定期间并保留结构化台账", async () => {
  const output: string[] = [], requests: string[] = [];
  const result = await runCli(["opc", "business", "show", "--workspace", "workspace-1", "--period-start", "2026-10-01", "--period-end", "2026-10-09", "--json"], {
    io: { stdout: line => output.push(line), stderr: line => output.push(line) },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
      assert.equal(request.headers.get("Idempotency-Key"), null);
      return Response.json({ data: emptyBusiness, traceId: "business-read" });
    },
  });
  assert.equal(result, 0, output.join("\n"));
  assert.deepEqual(requests, ["GET /v2/plugins/opc/business?workspaceId=workspace-1&periodStart=2026-10-01&periodEnd=2026-10-09"]);
  assert.deepEqual(JSON.parse(output[0]!), { ok: true, command: "opc business show", data: emptyBusiness });
});

test("opc business command 通过同一 Host 契约提交文件，版本冲突不自动重试", async t => {
  const root = await mkdtemp(join(tmpdir(), "mn-business-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "command.json"), command = { type: "customer.record", customerId: "customer-1", name: "客户", source: "转介", need: "设计服务" };
  await writeFile(file, JSON.stringify(command));
  const requests: unknown[] = [], output: string[] = [];
  const result = await runCli(["opc", "business", "command", "--workspace", "workspace-1", "--version", "0", "--file", file, "--json"], {
    io: { stdout: line => output.push(line), stderr: line => output.push(line) }, idempotencyKey: () => "business-command",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ path: new URL(request.url).pathname, key: request.headers.get("Idempotency-Key"), body: await request.json() });
      return Response.json({ code: "STREAM_VERSION_CONFLICT", message: "版本已变化", action: "重新读取经营台账", fieldIssues: [], traceId: "test", retryable: true }, { status: 409 });
    },
  });
  assert.equal(result, 1);
  assert.deepEqual(requests, [{ path: "/v2/plugins/opc/business/commands", key: "business-command", body: {
    workspaceId: "workspace-1", expectedStreamVersion: 0, command,
  } }]);
  assert.equal(JSON.parse(output[0]!).error.code, "STREAM_VERSION_CONFLICT");
});

test("opc business command 要求显式版本和唯一 JSON 输入", async () => {
  for (const args of [[], ["--version", "0"], ["--version", "0", "--input", "[]"], ["--version", "0", "--input", "{}", "--file", "command.json"]]) {
    let calls = 0;
    const result = await runCli(["opc", "business", "command", "--workspace", "workspace-1", ...args, "--json"], {
      io: { stdout() {}, stderr() {} }, fetch: async () => { calls++; throw new Error("unexpected request"); },
    });
    assert.notEqual(result, 0);
    assert.equal(calls, 0);
  }
});
