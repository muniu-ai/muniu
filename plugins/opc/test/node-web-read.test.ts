import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { requestPinnedNodeHttp } from "../src/index.js";

test("Node 网页传输只连接给定地址，同时保留原始 Host", async (t) => {
  let observedHost = "";
  const server = createServer((request, response) => {
    observedHost = request.headers.host ?? "";
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("pinned");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await requestPinnedNodeHttp({
    url: `http://public.example:${address.port}/evidence?q=1`,
    method: "GET",
    resolvedAddresses: ["127.0.0.1"],
    headers: { accept: "text/plain" },
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString("utf8"), "pinned");
  assert.equal(response.remoteAddress, "127.0.0.1");
  assert.equal(observedHost, `public.example:${address.port}`);
});
