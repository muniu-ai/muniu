import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  HttpTransportError,
  classifyHttpUsageV1,
  dispatchHttpRequest
} from "../src/index.js";

test("HTTP transport snapshots a native response and exposes bounded header access", async () => {
  const source = new Response("payload", {
    status: 201,
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-safe"
    }
  });
  const dispatched = await dispatchHttpRequest({
    request: new Request("https://provider.invalid/v1/responses", { method: "POST" }),
    fetch: async () => source
  });

  source.headers.set("content-type", "text/plain");
  assert.equal(dispatched.response.status, 201);
  assert.equal(dispatched.response.ok, true);
  assert.equal(dispatched.response.header("content-type"), "application/json");
  const headers: Array<readonly [string, string]> = [];
  dispatched.response.forEachHeader((value, name) => { headers.push([name, value]); });
  assert.deepEqual(headers, [
    ["content-type", "application/json"],
    ["x-request-id", "request-safe"]
  ]);
  assert.equal(Buffer.from(await dispatched.response.arrayBuffer()).toString("utf8"), "payload");
  dispatched.dispose();
  dispatched.dispose();
});

test("HTTP transport aborts promptly and absorbs a late fetch rejection", async () => {
  const controller = new AbortController();
  let rejectLate!: (error: Error) => void;
  const late = new Promise<Response>((_resolve, reject) => { rejectLate = reject; });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const operation = dispatchHttpRequest({
      request: new Request("https://provider.invalid/v1/responses"),
      signal: controller.signal,
      fetch: async () => late
    });
    controller.abort();
    await assert.rejects(operation, (error: unknown) =>
      error instanceof HttpTransportError
      && error.code === "aborted"
      && error.message === "HTTP transport was aborted");
    rejectLate(new Error("Authorization: Bearer late-credential"));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("HTTP transport rejects pre-abort and hostile option accessors before dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  await assert.rejects(dispatchHttpRequest({
    request: new Request("https://provider.invalid/v1/responses"),
    signal: controller.signal,
    fetch: async () => {
      fetchCalls += 1;
      return new Response("must-not-run");
    }
  }), (error: unknown) => error instanceof HttpTransportError && error.code === "aborted");
  assert.equal(fetchCalls, 0);

  let getterReads = 0;
  const hostile = Object.defineProperty({
    request: new Request("https://provider.invalid/v1/responses")
  }, "signal", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("RAW-OPTIONS-SECRET");
    }
  });
  await assert.rejects(dispatchHttpRequest(hostile as never), (error: unknown) =>
    error instanceof TypeError && !error.message.includes("RAW-"));
  assert.equal(getterReads, 0);
});

test("HTTP transport enforces a bounded timeout independently of fetch cooperation", async () => {
  const startedAt = Date.now();
  await assert.rejects(dispatchHttpRequest({
    request: new Request("https://provider.invalid/v1/responses"),
    timeoutMs: 20,
    fetch: async () => new Promise<Response>(() => undefined)
  }), (error: unknown) => error instanceof HttpTransportError && error.code === "timeout");
  assert.ok(Date.now() - startedAt < 1_000);
});

test("HTTP transport rejects hostile and cross-realm response values without leaking failures", async () => {
  let traps = 0;
  const hostile = new Proxy(new Response("x"), {
    getPrototypeOf() {
      traps += 1;
      throw new Error("RAW-RESPONSE-SECRET");
    }
  });
  const revoked = Proxy.revocable(new Response("x"), {});
  revoked.revoke();
  const crossRealm = runInNewContext("({ status: 200, body: null })") as unknown;

  for (const value of [hostile, revoked.proxy, crossRealm]) {
    await assert.rejects(dispatchHttpRequest({
      request: new Request("https://provider.invalid/v1/responses"),
      fetch: async () => value as Response
    }), (error: unknown) => error instanceof HttpTransportError
      && (error.code === "invalid_response" || error.code === "dispatch_failed")
      && !error.message.includes("RAW-"));
  }
  assert.equal(traps, 0);

  const excessiveHeaders = new Headers();
  for (let index = 0; index < 129; index += 1) excessiveHeaders.set(`x-bounded-${index}`, "value");
  await assert.rejects(dispatchHttpRequest({
    request: new Request("https://provider.invalid/v1/responses"),
    fetch: async () => new Response("x", { headers: excessiveHeaders })
  }), (error: unknown) => error instanceof HttpTransportError && error.code === "invalid_response");

  const rejected = Proxy.revocable({}, {});
  rejected.revoke();
  await assert.rejects(dispatchHttpRequest({
    request: new Request("https://provider.invalid/v1/responses"),
    fetch: () => Promise.reject(rejected.proxy)
  }), (error: unknown) => error instanceof HttpTransportError && error.code === "dispatch_failed");
});

test("HTTP transport normalizes response body read failures", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("RAW-BODY-SECRET"));
    }
  }));
  const dispatched = await dispatchHttpRequest({
    request: new Request("https://provider.invalid/v1/responses"),
    fetch: async () => response
  });
  await assert.rejects(dispatched.response.arrayBuffer(), (error: unknown) =>
    error instanceof HttpTransportError
    && error.code === "response_read_failed"
    && !error.message.includes("RAW-"));
  dispatched.dispose();
});

test("HTTP usage classification distinguishes complete, partial, and missing", () => {
  assert.deepEqual(classifyHttpUsageV1({ observed: false }), { state: "missing" });
  assert.deepEqual(classifyHttpUsageV1({ observed: true, inputTokens: 3 }), {
    state: "partial",
    usage: { inputTokens: 3 }
  });
  assert.deepEqual(classifyHttpUsageV1({ observed: true, inputTokens: 3, outputTokens: 2 }), {
    state: "complete",
    usage: { inputTokens: 3, outputTokens: 2 }
  });
  assert.throws(() => classifyHttpUsageV1({ observed: true, inputTokens: -1 }), /usage/i);
  assert.throws(() => classifyHttpUsageV1(new Proxy({ observed: false }, {}) as never), /usage/i);
});
