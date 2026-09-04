import assert from "node:assert/strict";
import test from "node:test";
import {
  OpcWebReadError,
  SafePublicWebReader,
  type PinnedHttpRequest,
  type PinnedHttpResponse,
} from "../src/index.js";

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

function response(overrides: Partial<PinnedHttpResponse> = {}): PinnedHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: chunks("<title>公开资料</title>"),
    remoteAddress: "93.184.216.34",
    ...overrides,
  };
}

test("只读网页请求固定公开 DNS 结果并核对实际连接地址", async () => {
  const requests: PinnedHttpRequest[] = [];
  const reader = new SafePublicWebReader({
    dnsLookup: async (hostname) => {
      assert.equal(hostname, "example.com");
      return ["93.184.216.34"];
    },
    request: async (request) => {
      requests.push(request);
      return response({ body: chunks("公开", "证据") });
    },
  });

  const result = await reader.read("https://example.com/research");
  assert.equal(result.body, "公开证据");
  assert.equal(result.mediaType, "text/html");
  assert.deepEqual(requests[0]?.resolvedAddresses, ["93.184.216.34"]);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.headers["accept-encoding"], "identity");
});

test("拒绝非 HTTP、凭据、本机、私网、link-local 和 IPv4-mapped 地址", async () => {
  const reader = new SafePublicWebReader({
    dnsLookup: async () => ["93.184.216.34"],
    request: async () => response(),
  });
  const urls = [
    "file:///etc/passwd",
    "http://user:secret@example.com",
    "http://localhost/admin",
    "http://api.localhost/admin",
    "http://127.0.0.1/admin",
    "http://2130706433/admin",
    "http://10.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/admin",
    "http://[::ffff:127.0.0.1]/admin",
    "http://[64:ff9b::7f00:1]/admin",
  ];

  for (const url of urls) {
    await assert.rejects(
      reader.read(url),
      (error: unknown) => error instanceof OpcWebReadError
        && ["URL_FORBIDDEN", "PRIVATE_ADDRESS"].includes(error.code),
      url,
    );
  }
});

test("DNS 返回私网或实际连接地址漂移时拒绝请求", async () => {
  const privateDns = new SafePublicWebReader({
    dnsLookup: async () => ["192.168.1.20"],
    request: async () => response(),
  });
  await assert.rejects(
    privateDns.read("https://example.com"),
    (error: unknown) => error instanceof OpcWebReadError && error.code === "PRIVATE_ADDRESS",
  );

  const mixedDns = new SafePublicWebReader({
    dnsLookup: async () => ["93.184.216.34", "127.0.0.1"],
    request: async () => response(),
  });
  await assert.rejects(
    mixedDns.read("https://example.com"),
    (error: unknown) => error instanceof OpcWebReadError && error.code === "PRIVATE_ADDRESS",
  );

  const rebound = new SafePublicWebReader({
    dnsLookup: async () => ["93.184.216.34"],
    request: async () => response({ remoteAddress: "10.0.0.8" }),
  });
  await assert.rejects(
    rebound.read("https://example.com"),
    (error: unknown) => error instanceof OpcWebReadError && error.code === "DNS_REBINDING",
  );
});

test("同协议重定向重新解析目标域名并固定新的连接地址", async () => {
  const lookups: string[] = [];
  const reader = new SafePublicWebReader({
    dnsLookup: async (hostname) => {
      lookups.push(hostname);
      return hostname === "example.com" ? ["93.184.216.34"] : ["1.1.1.1"];
    },
    request: async (request) => {
      if (request.url === "https://example.com/start") {
        return response({
          status: 302,
          headers: { location: "https://research.example.net/final" },
          remoteAddress: "93.184.216.34",
        });
      }
      assert.deepEqual(request.resolvedAddresses, ["1.1.1.1"]);
      return response({ remoteAddress: "1.1.1.1" });
    },
  });

  const result = await reader.read("https://example.com/start");
  assert.equal(result.finalUrl, "https://research.example.net/final");
  assert.equal(result.redirects, 1);
  assert.deepEqual(lookups, ["example.com", "research.example.net"]);
});

test("重定向逐跳复核地址，并禁止跨协议重定向", async () => {
  let calls = 0;
  const reader = new SafePublicWebReader({
    dnsLookup: async () => ["93.184.216.34"],
    request: async () => {
      calls += 1;
      if (calls === 1) {
        return response({
          status: 302,
          headers: { location: "http://example.com/downgrade", "content-type": "text/plain" },
        });
      }
      return response();
    },
  });
  await assert.rejects(
    reader.read("https://example.com/start"),
    (error: unknown) => error instanceof OpcWebReadError && error.code === "CROSS_PROTOCOL_REDIRECT",
  );
  assert.equal(calls, 1);
});

test("限制响应 MIME、解码后大小、重定向次数和请求时间", async () => {
  const badMime = new SafePublicWebReader({
    dnsLookup: async () => ["93.184.216.34"],
    request: async () => response({ headers: { "content-type": "application/octet-stream" } }),
  });
  await assert.rejects(
    badMime.read("https://example.com/file"),
    (error: unknown) => error instanceof OpcWebReadError && error.code === "MIME_FORBIDDEN",
  );

  const oversized = new SafePublicWebReader({
    dnsLookup: async () => ["93.184.216.34"],
    request: async () => response({ body: chunks("12345", "67890") }),
    maxBytes: 8,
  });
  await assert.rejects(
    oversized.read("https://example.com/large"),
    (error: unknown) => error instanceof OpcWebReadError && error.code === "RESPONSE_TOO_LARGE",
  );

  const redirectLoop = new SafePublicWebReader({
    dnsLookup: async () => ["93.184.216.34"],
    request: async () => response({ status: 302, headers: { location: "/again" } }),
    maxRedirects: 1,
  });
  await assert.rejects(
    redirectLoop.read("https://example.com/start"),
    (error: unknown) => error instanceof OpcWebReadError && error.code === "REDIRECT_LIMIT",
  );

  const timedOut = new SafePublicWebReader({
    dnsLookup: async () => ["93.184.216.34"],
    request: async () => new Promise<PinnedHttpResponse>(() => undefined),
    timeoutMs: 5,
  });
  await assert.rejects(
    timedOut.read("https://example.com/slow"),
    (error: unknown) => error instanceof OpcWebReadError && error.code === "REQUEST_TIMEOUT",
  );
});
