// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { SseParseError } from "./errors.js";

export interface SseEvent {
  readonly data: string;
  readonly event?: string;
  readonly id?: string;
  readonly retryMs?: number;
  /** Raw frame bytes from its first field through the terminating blank line. */
  readonly byteLength: number;
}

export interface SseLimits {
  /** Raw bytes in one line, excluding its CR/LF delimiter. */
  readonly maxLineBytes: number;
  /** Raw bytes in one frame, including its terminating blank line. */
  readonly maxEventBytes: number;
  /** Raw input chunk snapshot, or pending field bytes plus the current line. */
  readonly maxBufferBytes: number;
  /** Data-bearing events emitted over the lifetime of this parser. */
  readonly maxEventCount: number;
}

export interface ParseSseOptions {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<SseLimits>;
}

export const DEFAULT_SSE_LIMITS: Readonly<SseLimits> = Object.freeze({
  maxLineBytes: 2 * 1024 * 1024,
  maxEventBytes: 8 * 1024 * 1024,
  maxBufferBytes: 4 * 1024 * 1024,
  maxEventCount: 10_000
});

const INVALID_LIMIT_MESSAGE = "SSE limits must be positive safe integers";
const INVALID_CHUNK_MESSAGE = "SSE source yielded an invalid byte chunk";
const SOURCE_FAILURE_MESSAGE = "SSE source iteration failed";
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength"
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const ABORT_SIGNAL_ABORTED = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const EVENT_TARGET_ADD = EventTarget.prototype.addEventListener;
const EVENT_TARGET_REMOVE = EventTarget.prototype.removeEventListener;

function limit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new SseParseError("SSE_INVALID_LIMIT", INVALID_LIMIT_MESSAGE);
  }
  return resolved;
}

function snapshotLimits(input: Partial<SseLimits> | undefined): Readonly<SseLimits> {
  return Object.freeze({
    maxLineBytes: limit(input?.maxLineBytes, DEFAULT_SSE_LIMITS.maxLineBytes),
    maxEventBytes: limit(input?.maxEventBytes, DEFAULT_SSE_LIMITS.maxEventBytes),
    maxBufferBytes: limit(input?.maxBufferBytes, DEFAULT_SSE_LIMITS.maxBufferBytes),
    maxEventCount: limit(input?.maxEventCount, DEFAULT_SSE_LIMITS.maxEventCount)
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (ABORT_SIGNAL_ABORTED === undefined) return true;
  try {
    return Reflect.apply(ABORT_SIGNAL_ABORTED, signal, []) === true;
  } catch {
    return true;
  }
}

function isSseParseError(error: unknown): error is SseParseError {
  try {
    return error instanceof SseParseError;
  } catch {
    return false;
  }
}

function sourceFailure(): SseParseError {
  return new SseParseError("SSE_SOURCE_FAILED", SOURCE_FAILURE_MESSAGE);
}

function snapshotChunk(value: unknown, maximum: number): Uint8Array {
  if (!utilTypes.isUint8Array(value) || TYPED_ARRAY_BYTE_LENGTH === undefined) {
    throw new SseParseError("SSE_INVALID_CHUNK", INVALID_CHUNK_MESSAGE);
  }
  try {
    const length = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as number;
    if (length > maximum) {
      throw new SseParseError("SSE_BUFFER_LIMIT_EXCEEDED", "SSE parser buffer byte limit exceeded");
    }
    const snapshot = new Uint8Array(length);
    Reflect.apply(TYPED_ARRAY_SET, snapshot, [value]);
    return snapshot;
  } catch (error) {
    if (isSseParseError(error)) throw error;
    throw new SseParseError("SSE_INVALID_CHUNK", INVALID_CHUNK_MESSAGE);
  }
}

class ByteAccumulator {
  private storage: Uint8Array;
  private currentLength = 0;

  constructor(private readonly maximum: number) {
    this.storage = new Uint8Array(Math.min(256, maximum));
  }

  get length(): number {
    return this.currentLength;
  }

  append(value: number): void {
    if (this.currentLength === this.storage.byteLength) this.grow();
    this.storage[this.currentLength] = value;
    this.currentLength += 1;
  }

  view(): Uint8Array {
    return this.storage.subarray(0, this.currentLength);
  }

  reset(): void {
    this.currentLength = 0;
  }

  private grow(): void {
    const nextLength = Math.min(this.maximum, Math.max(1, this.storage.byteLength * 2));
    const replacement = new Uint8Array(nextLength);
    replacement.set(this.storage);
    this.storage = replacement;
  }
}

interface RetainedField {
  readonly value: string;
  readonly bytes: number;
}

class SseFramer {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private readonly line: ByteAccumulator;
  private frameBytes = 0;
  private retainedBytes = 0;
  private dataParts: string[] = [];
  private eventField: RetainedField | undefined;
  private idField: RetainedField | undefined;
  private retryField: { readonly value: number; readonly bytes: number } | undefined;
  private atStreamStart = true;
  private pendingCarriageReturn = false;
  private emittedEvents = 0;

  constructor(private readonly limits: Readonly<SseLimits>) {
    this.line = new ByteAccumulator(Math.min(limits.maxLineBytes, limits.maxBufferBytes));
  }

  *push(chunk: Uint8Array, signal: AbortSignal | undefined): Iterable<SseEvent> {
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (isAborted(signal)) {
        throw new SseParseError("SSE_ABORTED", "SSE parsing aborted");
      }
      const byte = chunk[index] as number;
      const event = this.pushByte(byte);
      if (event !== undefined) yield event;
    }
  }

  *finish(): Iterable<SseEvent> {
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      const event = this.finishLine();
      if (event !== undefined) yield event;
    }

    if (this.line.length > 0) this.decodeLine(this.line.view());
    if (this.line.length > 0 || this.frameBytes > 0) {
      throw new SseParseError("SSE_TRUNCATED", "SSE stream ended before an event delimiter");
    }
  }

  private pushByte(byte: number): SseEvent | undefined {
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      if (byte === 0x0a) {
        this.addFrameByte();
        return this.finishLine();
      }
      const event = this.finishLine();
      this.acceptFreshByte(byte);
      return event;
    }
    return this.acceptFreshByte(byte);
  }

  private acceptFreshByte(byte: number): SseEvent | undefined {
    this.addFrameByte();
    if (byte === 0x0d) {
      this.pendingCarriageReturn = true;
      return undefined;
    }
    if (byte === 0x0a) return this.finishLine();

    if (this.line.length >= this.limits.maxLineBytes) {
      throw new SseParseError("SSE_LINE_LIMIT_EXCEEDED", "SSE line byte limit exceeded");
    }
    if (this.retainedBytes + this.line.length + 1 > this.limits.maxBufferBytes) {
      throw new SseParseError("SSE_BUFFER_LIMIT_EXCEEDED", "SSE parser buffer byte limit exceeded");
    }
    this.line.append(byte);
    return undefined;
  }

  private addFrameByte(): void {
    this.frameBytes += 1;
    if (this.frameBytes > this.limits.maxEventBytes) {
      throw new SseParseError("SSE_EVENT_LIMIT_EXCEEDED", "SSE event byte limit exceeded");
    }
  }

  private finishLine(): SseEvent | undefined {
    const rawLength = this.line.length;
    let decoded = this.decodeLine(this.line.view());
    this.line.reset();
    if (this.atStreamStart) {
      this.atStreamStart = false;
      if (decoded.startsWith("\uFEFF")) decoded = decoded.slice(1);
    }

    if (decoded.length === 0) {
      const event = this.dataParts.length === 0 ? undefined : this.dispatch();
      this.resetFrame();
      return event;
    }
    if (decoded.startsWith(":")) return undefined;

    const colon = decoded.indexOf(":");
    const field = colon < 0 ? decoded : decoded.slice(0, colon);
    let value = colon < 0 ? "" : decoded.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.dataParts.push(value);
        this.retainedBytes += rawLength;
        return undefined;
      case "event":
        this.replaceEvent(value, rawLength);
        return undefined;
      case "id":
        if (!value.includes("\0")) this.replaceId(value, rawLength);
        return undefined;
      case "retry":
        if (/^[0-9]+$/.test(value)) {
          const parsed = Number(value);
          if (Number.isSafeInteger(parsed)) this.replaceRetry(parsed, rawLength);
        }
        return undefined;
      default:
        return undefined;
    }
  }

  private decodeLine(bytes: Uint8Array): string {
    try {
      return this.decoder.decode(bytes);
    } catch {
      throw new SseParseError("SSE_INVALID_UTF8", "SSE stream contains invalid UTF-8");
    }
  }

  private replaceEvent(value: string, bytes: number): void {
    this.retainedBytes -= this.eventField?.bytes ?? 0;
    this.eventField = value.length === 0 ? undefined : { value, bytes };
    if (this.eventField !== undefined) this.retainedBytes += bytes;
  }

  private replaceId(value: string, bytes: number): void {
    this.retainedBytes -= this.idField?.bytes ?? 0;
    this.idField = { value, bytes };
    this.retainedBytes += bytes;
  }

  private replaceRetry(value: number, bytes: number): void {
    this.retainedBytes -= this.retryField?.bytes ?? 0;
    this.retryField = { value, bytes };
    this.retainedBytes += bytes;
  }

  private dispatch(): SseEvent {
    this.emittedEvents += 1;
    if (this.emittedEvents > this.limits.maxEventCount) {
      throw new SseParseError("SSE_EVENT_COUNT_LIMIT_EXCEEDED", "SSE event count limit exceeded");
    }
    const event: SseEvent = {
      data: this.dataParts.join("\n"),
      ...(this.eventField === undefined ? {} : { event: this.eventField.value }),
      ...(this.idField === undefined ? {} : { id: this.idField.value }),
      ...(this.retryField === undefined ? {} : { retryMs: this.retryField.value }),
      byteLength: this.frameBytes
    };
    return Object.freeze(event);
  }

  private resetFrame(): void {
    this.frameBytes = 0;
    this.retainedBytes = 0;
    this.dataParts = [];
    this.eventField = undefined;
    this.idField = undefined;
    this.retryField = undefined;
  }
}

type SseChunkOutcome =
  | Readonly<{ readonly kind: "event"; readonly event: SseEvent }>
  | Readonly<{ readonly kind: "error"; readonly error: SseParseError }>;

function safeParserFailure(error: unknown): SseParseError {
  return isSseParseError(error)
    ? error
    : sourceFailure();
}

function parseChunk(
  framer: SseFramer,
  chunk: Uint8Array,
  signal: AbortSignal | undefined
): readonly SseChunkOutcome[] {
  const outcomes: SseChunkOutcome[] = [];
  try {
    for (const event of framer.push(chunk, signal)) {
      outcomes.push(Object.freeze({ kind: "event", event }));
    }
  } catch (error) {
    outcomes.push(Object.freeze({ kind: "error", error: safeParserFailure(error) }));
  }
  return outcomes;
}

async function nextWithAbort<T>(
  next: () => Promise<IteratorResult<T>>,
  signal: AbortSignal | undefined
): Promise<IteratorResult<T>> {
  if (isAborted(signal)) throw new SseParseError("SSE_ABORTED", "SSE parsing aborted");
  const pending = readSourceResult(next);
  if (signal === undefined) return pending;

  let rejectAbort: ((reason: SseParseError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort?.(new SseParseError("SSE_ABORTED", "SSE parsing aborted"));
  Reflect.apply(EVENT_TARGET_ADD, signal, ["abort", onAbort, { once: true }]);
  if (isAborted(signal)) onAbort();
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    Reflect.apply(EVENT_TARGET_REMOVE, signal, ["abort", onAbort]);
  }
}

async function readSourceResult<T>(
  next: () => Promise<IteratorResult<T>>
): Promise<IteratorResult<T>> {
  try {
    const result: unknown = await next();
    if ((typeof result !== "object" && typeof result !== "function") || result === null) {
      throw new TypeError("invalid async iterator result");
    }
    const done = Boolean((result as IteratorResult<T>).done);
    if (done) return Object.freeze({ done: true, value: undefined }) as IteratorResult<T>;
    const value = (result as IteratorYieldResult<T>).value;
    return Object.freeze({ done: false, value });
  } catch {
    throw sourceFailure();
  }
}

function openIterator<T>(source: AsyncIterable<T>): Readonly<{
  iterator: AsyncIterator<T>;
  next: () => Promise<IteratorResult<T>>;
}> {
  try {
    const open = source[Symbol.asyncIterator];
    if (typeof open !== "function") throw new TypeError("missing async iterator");
    const iterator = Reflect.apply(open, source, []) as AsyncIterator<T>;
    const next = iterator.next;
    if (typeof next !== "function") throw new TypeError("missing async iterator next");
    return Object.freeze({ iterator, next: next.bind(iterator) });
  } catch {
    throw sourceFailure();
  }
}

async function closeIterator<T>(iterator: AsyncIterator<T>, hasPrimaryFailure: boolean): Promise<void> {
  let closing: unknown;
  try {
    const close = iterator.return;
    if (close === undefined) return;
    if (typeof close !== "function") throw new TypeError("invalid async iterator return");
    closing = Reflect.apply(close, iterator, []);
  } catch {
    if (!hasPrimaryFailure) {
      throw new SseParseError("SSE_SOURCE_FAILED", "SSE source cleanup failed");
    }
    return;
  }

  if (hasPrimaryFailure) {
    try {
      void Promise.resolve(closing).catch(() => undefined);
    } catch {
      // A primary parser error always wins over hostile cleanup thenables.
    }
    return;
  }

  try {
    await closing;
  } catch {
    throw new SseParseError("SSE_SOURCE_FAILED", "SSE source cleanup failed");
  }
}

async function* parseSseIterator(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
  limits: Readonly<SseLimits>
): AsyncIterable<SseEvent> {
  const { iterator, next } = openIterator(source);
  const framer = new SseFramer(limits);
  let sourceDone = false;
  let primaryFailure: SseParseError | undefined;
  try {
    while (true) {
      const result = await nextWithAbort(next, signal);
      if (isAborted(signal)) {
        throw new SseParseError("SSE_ABORTED", "SSE parsing aborted");
      }
      if (result.done) {
        sourceDone = true;
        for (const event of framer.finish()) yield event;
        return;
      }
      const snapshot = snapshotChunk(result.value, limits.maxBufferBytes);
      const outcomes = parseChunk(framer, snapshot, signal);
      for (const outcome of outcomes) {
        if (isAborted(signal)) {
          throw new SseParseError("SSE_ABORTED", "SSE parsing aborted");
        }
        if (outcome.kind === "error") throw outcome.error;
        yield outcome.event;
      }
    }
  } catch (error) {
    primaryFailure = safeParserFailure(error);
    throw primaryFailure;
  } finally {
    if (!sourceDone) await closeIterator(iterator, primaryFailure !== undefined);
  }
}

/**
 * Parses a strict, bounded SSE byte stream. Comments and unknown fields are
 * ignored, while `data`, `event`, `id`, and ASCII-decimal `retry` fields are
 * captured per frame. A frame is emitted only after its blank-line delimiter;
 * a non-empty tail at EOF is reported as truncation.
 */
export function parseSse(
  source: AsyncIterable<Uint8Array>,
  options: ParseSseOptions = {}
): AsyncIterable<SseEvent> {
  const limits = snapshotLimits(options.limits);
  return parseSseIterator(source, options.signal, limits);
}
