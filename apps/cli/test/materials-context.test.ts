// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Asset, AssetExtractionV2, BusinessObjectContextV2 } from "@mn/contracts";
import { runCli } from "../src/index.js";

const sourceRef = { namespace: "asset", resourceId: "asset-1", streamVersion: 1, digest: "server-protected-digest" };
const asset: Asset = { id: "asset-1", tenantId: "local", workspaceId: "workspace-1", streamVersion: 1,
  createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", digest: sourceRef.digest,
  fileName: "notes.md", mediaType: "text/markdown", byteLength: 6, protected: true };

test("asset upload sends protected bytes and returns the server version reference with a reusable key", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mn-material-cli-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "notes.md"); await writeFile(file, "sample");
  const requests: { path: string; key: string | null; body: unknown }[] = [];
  const outputs: string[] = [];
  const execute = () => runCli(["asset", "upload", "--workspace", "workspace-1", "--file", file, "--key", "upload-retry-1", "--json"], {
    io: { stdout: line => outputs.push(line), stderr: line => outputs.push(line) },
    fetch: async (input, init) => {
      const request = new Request(input, init); requests.push({ path: new URL(request.url).pathname, key: request.headers.get("Idempotency-Key"), body: await request.json() });
      if (requests.length === 1) throw new TypeError("response lost");
      return Response.json({ data: [asset], traceId: "material-fixture" }, { status: 201 });
    },
  });
  assert.equal(await execute(), 1); assert.equal(requests.length, 1, "响应未知时不自动重发");
  assert.equal(await execute(), 0);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[0], { path: "/v2/assets", key: "upload-retry-1", body: { workspaceId: "workspace-1", expectedStreamVersion: 0,
    attachments: [{ fileName: "notes.md", mediaType: "text/markdown", contentBase64: Buffer.from("sample").toString("base64"), protected: true }] } });
  assert.deepEqual(JSON.parse(outputs[1]!).data, { asset, sourceRef });
});

test("asset extraction preserves partial coverage, issues and cell locators", async () => {
  const extraction: AssetExtractionV2 = { assetRef: sourceRef, fileName: "budget.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    status: "partial", blocks: [{ id: "cell-1", text: "120", locator: { sheet: "预算", cell: "B2", row: 2, column: 2 } }],
    issues: [{ code: "FORMULA_NOT_EVALUATED", message: "保留公式缓存值" }], extractorVersion: "1", textDigest: "text-digest" };
  const output: string[] = [];
  assert.equal(await runCli(["asset", "extract", "asset-1", "--json"], { io: { stdout: line => output.push(line), stderr() {} }, fetch: async (input, init) => {
    const request = new Request(input, init); assert.equal(request.method, "GET"); assert.equal(new URL(request.url).pathname, "/v2/assets/asset-1/extraction");
    assert.equal(request.headers.has("Idempotency-Key"), false); return Response.json({ data: extraction, traceId: "fixture" });
  } }), 0);
  assert.deepEqual(JSON.parse(output[0]!).data, extraction);
});

test("business context reads each typed source through Host and does not issue domain commands", async () => {
  for (const kind of ["customer", "order", "delivery", "review"] as const) {
    const output: string[] = [];
    const context: BusinessObjectContextV2 = { kind, resourceId: "record/a", title: "业务来源", content: "合成事实", sourceRef: { namespace: `opc.business.${kind}`, resourceId: "record/a", streamVersion: 9, digest: "server-fact-digest" } };
    assert.equal(await runCli(["business", "context", kind, "record/a", "--workspace", "workspace-1", "--json"], { io: { stdout: line => output.push(line), stderr() {} }, fetch: async (input, init) => {
      const request = new Request(input, init); assert.equal(request.method, "GET"); assert.equal(new URL(request.url).pathname, `/v2/workspaces/workspace-1/business-context/${kind}/record%2Fa`);
      return Response.json({ data: context, traceId: "fixture" });
    } }), 0);
    assert.deepEqual(JSON.parse(output[0]!).data, context);
  }
});

test("material commands reject incomplete or unsupported arguments before network access", async () => {
  for (const args of [["asset", "upload", "--workspace", "w"], ["asset", "upload", "--workspace", "w", "--file", "/missing.txt", "--key"],
    ["asset", "extract"], ["asset", "extract", "a", "extra"], ["business", "context", "quote", "a", "--workspace", "w"], ["business", "context", "customer", "a"]]) {
    let requests = 0;
    assert.equal(await runCli([...args, "--json"], { io: { stdout() {}, stderr() {} }, fetch: async () => { requests++; throw new Error("unexpected"); } }), 2);
    assert.equal(requests, 0);
  }
});
