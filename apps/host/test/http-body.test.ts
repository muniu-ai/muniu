// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { InMemoryKernelStore } from "@mn/kernel";
import { createAgentOsHost } from "../src/index.js";
import { readBoundedJsonBody } from "../src/http-body.js";

const streaming = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => new Request("http://host.test/v2/workspaces", {
  method: "POST", body, headers: { "Idempotency-Key": "bounded", "Content-Type": "application/json", ...headers }, duplex: "half",
} as RequestInit & { duplex: "half" });

test("读取 JSON 时限制声明长度、流式字节数和总时间，并取消超限输入", async () => {
  let cancelled = 0;
  const endless = () => new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(Buffer.alloc(32)); }, cancel() { cancelled++; } });
  await assert.rejects(readBoundedJsonBody(streaming(endless()), { maxBytes: 64 }), { code: "REQUEST_BODY_TOO_LARGE" });
  await assert.rejects(readBoundedJsonBody(streaming(endless(), { "Content-Length": "1000" }), { maxBytes: 64 }), { code: "REQUEST_BODY_TOO_LARGE" });
  await assert.rejects(readBoundedJsonBody(streaming(new ReadableStream({ cancel() { cancelled++; } })), { timeoutMs: 20 }), { code: "REQUEST_BODY_TIMEOUT" });
  assert.equal(cancelled, 3);
  const value = await readBoundedJsonBody(new Request("http://host.test/v2/assets", { method: "POST", body: JSON.stringify({ content: "x".repeat(3 * 1024 * 1024) }) }));
  assert.equal((value.content as string).length, 3 * 1024 * 1024, "asset JSON needs room for the allowed base64 payload");
});

test("HTTP 服务在上传完成前拒绝超大正文，连接中断不影响核心健康接口", async t => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({ store, secretStore: { async save(id) { return `keychain://muniu.v2/${id}`; }, async read() { return "test"; } } });
  t.after(() => host.close());
  const address = await host.listen({ port: 0 });
  const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: address.host, port: address.port, method: "POST", path: "/v2/workspaces", headers: {
      "Idempotency-Key": "large", "Content-Type": "application/json", "Content-Length": String(3 * 1024 * 1024),
    } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => { clearTimeout(timer); req.destroy(); resolve({ status: response.statusCode!, text }); });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error("HTTP server buffered an incomplete oversized request")); }, 2000);
    req.on("error", error => { clearTimeout(timer); reject(error); });
    req.write("{");
  });
  assert.equal(result.status, 413);
  assert.equal(JSON.parse(result.text).code, "REQUEST_BODY_TOO_LARGE");
  assert.equal((await fetch(`http://${address.host}:${address.port}/v2/health`)).status, 200);
  assert.deepEqual(await host.kernel.listWorkspaces("local"), []);
});
