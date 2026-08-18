// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

export type HttpTransportErrorCode =
  | "aborted"
  | "timeout"
  | "dispatch_failed"
  | "invalid_response"
  | "response_read_failed";

export class HttpTransportError extends Error {
  constructor(readonly code: HttpTransportErrorCode) {
    super(code === "aborted"
      ? "HTTP transport was aborted"
      : code === "timeout"
        ? "HTTP transport timed out"
        : code === "dispatch_failed"
          ? "HTTP transport dispatch failed"
          : code === "invalid_response"
            ? "HTTP transport returned an invalid response"
            : "HTTP response body read failed");
    this.name = "HttpTransportError";
  }
}

export interface HttpUsageClassificationInputV1 {
  readonly observed: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface HttpUsageClassificationV1 {
  readonly state: "complete" | "partial" | "missing";
  readonly usage?: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
  }>;
}

export interface HttpResponseSnapshot {
  readonly status: number;
  readonly ok: boolean;
  readonly body: ReadableStream<Uint8Array> | null;
  header(name: string): string | undefined;
  forEachHeader(visitor: (value: string, name: string) => void): void;
  arrayBuffer(): Promise<ArrayBuffer>;
  withBody(body: BodyInit | null): HttpResponseSnapshot;
}

export interface HttpDispatchOptions {
  readonly request: Request;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface HttpDispatchResult {
  readonly response: HttpResponseSnapshot;
  readonly signal?: AbortSignal;
  dispose(): void;
}

const responseStatusGetter = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;
const responseBodyGetter = Object.getOwnPropertyDescriptor(Response.prototype, "body")?.get;
const responseHeadersGetter = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get;
const requestUrlGetter = Object.getOwnPropertyDescriptor(Request.prototype, "url")?.get;
const signalAbortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const nativeFetch = globalThis.fetch;
const MAX_HEADERS = 128;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_NAME_BYTES = 256;
const MAX_HEADER_VALUE_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1_000;
const DISPATCH_ABORTED = Symbol("http-dispatch-aborted");

function isHttpTransportError(value: unknown): value is HttpTransportError {
  return !utilTypes.isProxy(value) && value instanceof HttpTransportError;
}

function exactDataRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    throw new TypeError("HTTP transport options must be an exact data object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("HTTP transport options must be an exact data object");
  }
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => keys.includes(key))
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("HTTP transport options must be an exact data object");
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("HTTP transport options must be an exact data object");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function isAborted(signal: AbortSignal): boolean {
  if (signalAbortedGetter === undefined) return true;
  try {
    return Reflect.apply(signalAbortedGetter, signal, []) === true;
  } catch {
    return true;
  }
}

function snapshotSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)
    || signalAbortedGetter === undefined) {
    throw new TypeError("HTTP transport signal must be an AbortSignal");
  }
  try {
    Reflect.apply(signalAbortedGetter, value, []);
  } catch {
    throw new TypeError("HTTP transport signal must be an AbortSignal");
  }
  return value as AbortSignal;
}

function snapshotRequest(value: unknown): Request {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)
    || requestUrlGetter === undefined) {
    throw new TypeError("HTTP transport request must be a native Request");
  }
  try {
    Reflect.apply(requestUrlGetter, value, []);
  } catch {
    throw new TypeError("HTTP transport request must be a native Request");
  }
  return value as Request;
}

function snapshotFetch(value: unknown): typeof globalThis.fetch {
  if (typeof value !== "function" || utilTypes.isProxy(value)) {
    throw new TypeError("HTTP transport fetch must be a function");
  }
  return value as typeof globalThis.fetch;
}

function snapshotHeaders(value: unknown): readonly (readonly [string, string])[] {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new HttpTransportError("invalid_response");
  }
  const entries: Array<readonly [string, string]> = [];
  let totalBytes = 0;
  try {
    Headers.prototype.forEach.call(value, (headerValue: string, headerName: string) => {
      const nameBytes = Buffer.byteLength(headerName);
      const valueBytes = Buffer.byteLength(headerValue);
      totalBytes += nameBytes + valueBytes;
      if (entries.length >= MAX_HEADERS || nameBytes > MAX_HEADER_NAME_BYTES
        || valueBytes > MAX_HEADER_VALUE_BYTES || totalBytes > MAX_HEADER_BYTES) {
        throw new HttpTransportError("invalid_response");
      }
      entries.push(Object.freeze([headerName, headerValue] as const));
    });
  } catch (error) {
    if (isHttpTransportError(error)) throw error;
    throw new HttpTransportError("invalid_response");
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze(entries);
}

function responseFromParts(
  status: number,
  body: ReadableStream<Uint8Array> | null,
  headers: readonly (readonly [string, string])[]
): HttpResponseSnapshot {
  const headerMap = new Map(headers);
  const snapshot: HttpResponseSnapshot = {
    status,
    ok: status >= 200 && status <= 299,
    body,
    header(name) {
      if (typeof name !== "string" || name.length === 0 || name.length > MAX_HEADER_NAME_BYTES) {
        throw new TypeError("HTTP response header name is invalid");
      }
      return headerMap.get(name.toLowerCase());
    },
    forEachHeader(visitor) {
      if (typeof visitor !== "function" || utilTypes.isProxy(visitor)) {
        throw new TypeError("HTTP response header visitor must be a function");
      }
      for (const [name, value] of headers) visitor(value, name);
    },
    async arrayBuffer() {
      if (body === null) return new ArrayBuffer(0);
      try {
        return await new Response(body).arrayBuffer();
      } catch {
        throw new HttpTransportError("response_read_failed");
      }
    },
    withBody(nextBody) {
      try {
        const rebuilt = new Response(nextBody);
        const rebuiltBody = responseBodyGetter === undefined
          ? undefined
          : Reflect.apply(responseBodyGetter, rebuilt, []);
        if (rebuiltBody !== null && !(rebuiltBody instanceof ReadableStream)) {
          throw new Error("invalid body");
        }
        return responseFromParts(status, rebuiltBody as ReadableStream<Uint8Array> | null, headers);
      } catch {
        throw new HttpTransportError("invalid_response");
      }
    }
  };
  return Object.freeze(snapshot);
}

export function snapshotHttpResponse(value: unknown): HttpResponseSnapshot {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)
    || responseStatusGetter === undefined || responseBodyGetter === undefined
    || responseHeadersGetter === undefined) {
    throw new HttpTransportError("invalid_response");
  }
  let status: unknown;
  let body: unknown;
  let headers: unknown;
  try {
    status = Reflect.apply(responseStatusGetter, value, []);
    body = Reflect.apply(responseBodyGetter, value, []);
    headers = Reflect.apply(responseHeadersGetter, value, []);
  } catch {
    throw new HttpTransportError("invalid_response");
  }
  if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 100 || status > 599
    || (body !== null && (!(body instanceof ReadableStream) || utilTypes.isProxy(body)))) {
    throw new HttpTransportError("invalid_response");
  }
  return responseFromParts(status, body as ReadableStream<Uint8Array> | null, snapshotHeaders(headers));
}

export function classifyHttpUsageV1(input: HttpUsageClassificationInputV1): HttpUsageClassificationV1 {
  let source: Record<string, unknown>;
  try {
    source = exactDataRecord(input, ["observed"], ["inputTokens", "outputTokens"]);
  } catch {
    throw new TypeError("HTTP usage classification is invalid");
  }
  if (typeof source.observed !== "boolean") throw new TypeError("HTTP usage observation is invalid");
  const usage: { inputTokens?: number; outputTokens?: number } = {};
  for (const field of ["inputTokens", "outputTokens"] as const) {
    const count = source[field];
    if (count === undefined) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("HTTP usage counters are invalid");
    }
    usage[field] = count;
  }
  const hasUsage = usage.inputTokens !== undefined || usage.outputTokens !== undefined;
  if (!source.observed && !hasUsage) return Object.freeze({ state: "missing" });
  const frozenUsage = hasUsage ? Object.freeze(usage) : undefined;
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return Object.freeze({ state: "partial", ...(frozenUsage === undefined ? {} : { usage: frozenUsage }) });
  }
  return Object.freeze({ state: "complete", usage: frozenUsage });
}

export async function dispatchHttpRequest(options: HttpDispatchOptions): Promise<HttpDispatchResult> {
  const source = exactDataRecord(options, ["request"], ["signal", "timeoutMs", "fetch"]);
  const request = snapshotRequest(source.request);
  const signal = snapshotSignal(source.signal);
  const fetchImpl = snapshotFetch(source.fetch ?? nativeFetch);
  const timeoutMs = source.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)) {
    throw new TypeError("HTTP transport timeout is invalid");
  }
  if (signal !== undefined && isAborted(signal)) throw new HttpTransportError("aborted");

  const controller = new AbortController();
  let active = true;
  let abortReason: "aborted" | "timeout" | undefined;
  let settleAbort!: (value: typeof DISPATCH_ABORTED) => void;
  const aborted = new Promise<typeof DISPATCH_ABORTED>((resolve) => { settleAbort = resolve; });
  const onAbort = (): void => {
    if (abortReason !== undefined) return;
    abortReason = "aborted";
    controller.abort();
    settleAbort(DISPATCH_ABORTED);
  };
  if (signal !== undefined) EventTarget.prototype.addEventListener.call(signal, "abort", onAbort, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    if (abortReason !== undefined) return;
    abortReason = "timeout";
    controller.abort();
    settleAbort(DISPATCH_ABORTED);
  }, timeoutMs);
  const dispose = (): void => {
    if (!active) return;
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined) EventTarget.prototype.removeEventListener.call(signal, "abort", onAbort);
  };

  let operation: Promise<unknown>;
  try {
    operation = Promise.resolve(Reflect.apply(fetchImpl, undefined, [request, { signal: controller.signal }]));
  } catch {
    dispose();
    throw new HttpTransportError("dispatch_failed");
  }
  void operation.catch(() => undefined);
  try {
    if (signal !== undefined && isAborted(signal)) onAbort();
    const result = await Promise.race([operation, aborted]);
    if (result === DISPATCH_ABORTED || abortReason !== undefined) {
      dispose();
      throw new HttpTransportError(abortReason ?? "aborted");
    }
    const response = snapshotHttpResponse(result);
    return Object.freeze({ response, signal: controller.signal, dispose });
  } catch (error) {
    dispose();
    if (isHttpTransportError(error)) throw error;
    throw new HttpTransportError(abortReason ?? "dispatch_failed");
  }
}
