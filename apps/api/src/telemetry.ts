import { randomBytes } from "node:crypto";

export interface OtlpHttpTelemetryOptions {
  readonly endpoint: string;
  readonly serviceName?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}

export interface HttpServerSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly startedAtUnixNano: string;
  readonly method: string;
  readonly route: string;
}

const TRACEPARENT = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/u;

function nonEmpty(value: string, field: string): string {
  if (!value || value !== value.trim()) throw new TypeError(`${field} must be non-empty and trimmed`);
  return value;
}

function tracesEndpoint(value: string): string {
  const endpoint = new URL(nonEmpty(value, "telemetry.endpoint"));
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("telemetry.endpoint must use http or https");
  }
  const path = endpoint.pathname.replace(/\/$/u, "");
  endpoint.pathname = path.endsWith("/v1/traces") ? path : `${path}/v1/traces`;
  return endpoint.toString();
}

function unixNano(now = Date.now()): string {
  return (BigInt(now) * 1_000_000n).toString();
}

function traceIdFromHeader(traceparent: string | undefined): string | undefined {
  const match = TRACEPARENT.exec(traceparent ?? "");
  if (!match?.[1] || /^0{32}$/u.test(match[1])) return undefined;
  return match[1];
}

/** Minimal OTLP/HTTP JSON exporter for API server spans. */
export class OtlpHttpTelemetry {
  readonly endpoint: string;
  readonly serviceName: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: typeof fetch;

  constructor(options: OtlpHttpTelemetryOptions) {
    this.endpoint = tracesEndpoint(options.endpoint);
    this.serviceName = nonEmpty(options.serviceName ?? "mn-api", "telemetry.serviceName");
    this.#headers = Object.freeze({ ...(options.headers ?? {}) });
    this.#fetch = options.fetchImpl ?? fetch;
  }

  startHttpSpan(input: {
    method: string;
    route: string;
    traceparent?: string;
    now?: number;
  }): HttpServerSpan {
    return Object.freeze({
      traceId: traceIdFromHeader(input.traceparent) ?? randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      name: `${input.method} ${input.route}`,
      startedAtUnixNano: unixNano(input.now),
      method: input.method,
      route: input.route
    });
  }

  async finishHttpSpan(
    span: HttpServerSpan,
    input: { statusCode: number; tenantId?: string; actorId?: string; now?: number }
  ): Promise<void> {
    const attributes = [
      attribute("http.request.method", span.method),
      attribute("http.route", span.route),
      attribute("http.response.status_code", input.statusCode),
      ...(input.tenantId ? [attribute("mn.tenant.id", input.tenantId)] : []),
      ...(input.actorId ? [attribute("enduser.id", input.actorId)] : [])
    ];
    const payload = {
      resourceSpans: [{
        resource: {
          attributes: [attribute("service.name", this.serviceName)]
        },
        scopeSpans: [{
          scope: { name: "@mn/api", version: "0.1.0" },
          spans: [{
            traceId: span.traceId,
            spanId: span.spanId,
            name: span.name,
            kind: 2,
            startTimeUnixNano: span.startedAtUnixNano,
            endTimeUnixNano: unixNano(input.now),
            attributes,
            status: input.statusCode >= 500
              ? { code: 2, message: `HTTP ${input.statusCode}` }
              : { code: 1 }
          }]
        }]
      }]
    };
    const response = await this.#fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.#headers
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      await response.arrayBuffer();
      throw new Error(`OTLP trace exporter returned HTTP ${response.status}`);
    }
    await response.arrayBuffer();
  }
}

function attribute(key: string, value: string | number) {
  return {
    key,
    value: typeof value === "number"
      ? { intValue: String(value) }
      : { stringValue: value }
  };
}

