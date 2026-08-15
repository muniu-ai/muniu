import assert from "node:assert/strict";
import test from "node:test";
import { OtlpHttpTelemetry } from "../src/telemetry.js";

test("OTLP HTTP exporter preserves W3C trace context and emits server span JSON", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const telemetry = new OtlpHttpTelemetry({
    endpoint: "http://collector.example.test/otlp",
    serviceName: "mn-api-test",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as unknown
      });
      return new Response("{}", { status: 200 });
    }
  });
  const span = telemetry.startHttpSpan({
    method: "POST",
    route: "/v1/tasks",
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    now: 1_000
  });
  assert.equal(span.traceId, "0123456789abcdef0123456789abcdef");
  await telemetry.finishHttpSpan(span, {
    statusCode: 201,
    tenantId: "tenant-a",
    actorId: "developer@example.com",
    now: 1_001
  });
  assert.equal(requests[0]?.url, "http://collector.example.test/otlp/v1/traces");
  const body = requests[0]?.body as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
  };
  const exported = body.resourceSpans[0]?.scopeSpans[0]?.spans[0];
  assert.equal(exported?.traceId, span.traceId);
  assert.equal(exported?.spanId, span.spanId);
  assert.equal(exported?.startTimeUnixNano, "1000000000");
  assert.equal(exported?.endTimeUnixNano, "1001000000");
});

test("OTLP exporter rejects unsafe endpoints and fails visibly on collector errors", async () => {
  assert.throws(
    () => new OtlpHttpTelemetry({ endpoint: "file:///tmp/traces" }),
    /http or https/u
  );
  const telemetry = new OtlpHttpTelemetry({
    endpoint: "https://collector.example.test/v1/traces",
    fetchImpl: async () => new Response("no", { status: 503 })
  });
  const span = telemetry.startHttpSpan({ method: "GET", route: "/healthz" });
  await assert.rejects(
    telemetry.finishHttpSpan(span, { statusCode: 200 }),
    /HTTP 503/u
  );
});

