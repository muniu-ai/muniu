import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  parseSse,
  SseParseError,
  type ParseSseOptions,
  type SseErrorCode,
  type SseEvent
} from "../src/index.js";

const encoder = new TextEncoder();

async function collect(source: AsyncIterable<Uint8Array>, options?: ParseSseOptions): Promise<SseEvent[]> {
  return collectEvents(parseSse(source, options));
}

async function collectEvents(source: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function* bytes(...parts: readonly string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield encoder.encode(part);
}

async function* chunks(...parts: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield part;
}

function uncheckedChunks(...parts: readonly unknown[]): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let index = 0;
      return {
        async next() {
          if (index >= parts.length) return { done: true, value: undefined };
          const value = parts[index] as Uint8Array;
          index += 1;
          return { done: false, value };
        }
      };
    }
  };
}

async function expectSseError(
  promise: Promise<unknown>,
  code: SseErrorCode,
  message: string
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof SseParseError, true);
    const actual = error as SseParseError;
    assert.deepEqual(
      { name: actual.name, code: actual.code, message: actual.message },
      { name: "SseParseError", code, message }
    );
    return true;
  });
}

test("parseSse reassembles UTF-8 split across byte chunks", async () => {
  const encoded = encoder.encode("data: 你好\n\n");
  async function* split(): AsyncIterable<Uint8Array> {
    for (const byte of encoded) yield Uint8Array.of(byte);
  }

  assert.deepEqual(await collect(split()), [{ data: "你好", byteLength: encoded.byteLength }]);
});

test("parseSse accepts BOM and LF, CR, or CRLF framing with exact raw frame bytes", async () => {
  const frames = [
    "\uFEFFdata: bom\r\r",
    "data: cr\r\r",
    "data: crlf\r\n\r\n",
    "data: lf\n\n"
  ] as const;
  const result = await collect(bytes(frames.join("")));

  assert.deepEqual(result, [
    { data: "bom", byteLength: encoder.encode(frames[0]).byteLength },
    { data: "cr", byteLength: encoder.encode(frames[1]).byteLength },
    { data: "crlf", byteLength: encoder.encode(frames[2]).byteLength },
    { data: "lf", byteLength: encoder.encode(frames[3]).byteLength }
  ]);
});

test("parseSse joins data and snapshots the final valid same-frame metadata", async () => {
  const frame = [
    ": keep-alive",
    "unknown: ignored",
    "data:first",
    "data: second",
    "event: update",
    "event: final",
    "id: old",
    "id: next",
    "id: invalid\0value",
    "retry: ١٢",
    "retry: 9007199254740992",
    "retry: 0042",
    "",
    ""
  ].join("\n");
  const [event] = await collect(bytes(frame));

  assert.deepEqual(event, {
    data: "first\nsecond",
    event: "final",
    id: "next",
    retryMs: 42,
    byteLength: encoder.encode(frame).byteLength
  });
  assert.equal(Object.isFrozen(event), true);
  assert.throws(() => { (event as { data: string }).data = "mutated"; }, TypeError);
});

test("parseSse does not carry id, event, or retry metadata across frames", async () => {
  const first = "id: one\nevent: first\nretry: 12\ndata: alpha\n\n";
  const second = "data:\n\n";
  assert.deepEqual(await collect(bytes(first + second)), [
    { data: "alpha", event: "first", id: "one", retryMs: 12, byteLength: encoder.encode(first).byteLength },
    { data: "", byteLength: encoder.encode(second).byteLength }
  ]);
});

test("parseSse rejects fatal UTF-8 without exposing input bytes", async () => {
  const invalid = Uint8Array.from([...encoder.encode("data: "), 0xc3, 0x0a, 0x0a]);
  await expectSseError(
    collect(chunks(invalid)),
    "SSE_INVALID_UTF8",
    "SSE stream contains invalid UTF-8"
  );
});

test("parseSse never flushes an unterminated event at EOF", async () => {
  const iterator = parseSse(bytes("data: complete\n\ndata: must-not-flush\n"))[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { data: "complete", byteLength: encoder.encode("data: complete\n\n").byteLength }
  });
  await expectSseError(
    iterator.next(),
    "SSE_TRUNCATED",
    "SSE stream ended before an event delimiter"
  );

  await expectSseError(
    collect(bytes(": unterminated comment\n")),
    "SSE_TRUNCATED",
    "SSE stream ended before an event delimiter"
  );
  assert.deepEqual(await collect(bytes("data: complete\n\n")), [
    { data: "complete", byteLength: encoder.encode("data: complete\n\n").byteLength }
  ]);
});

test("parseSse yields completed frames before a later same-chunk failure", async () => {
  const complete = "data: ok\n\n";
  const iterator = parseSse(bytes(`${complete}data: ${"x".repeat(20)}`), {
    limits: { maxLineBytes: 10 }
  })[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { data: "ok", byteLength: encoder.encode(complete).byteLength }
  });
  await expectSseError(
    iterator.next(),
    "SSE_LINE_LIMIT_EXCEEDED",
    "SSE line byte limit exceeded"
  );
});

test("parseSse snapshots the complete source chunk before yielding any event", async () => {
  const text = "data: first\n\ndata: second\n\n";
  const mutable = encoder.encode(text);
  const mutationIterator = parseSse(chunks(mutable))[Symbol.asyncIterator]();
  assert.equal((await mutationIterator.next()).value?.data, "first");
  mutable.set(encoder.encode("hacked"), text.indexOf("second"));
  assert.deepEqual(await mutationIterator.next(), {
    done: false,
    value: { data: "second", byteLength: encoder.encode("data: second\n\n").byteLength }
  });

  const detachable = encoder.encode(text);
  const detachIterator = parseSse(chunks(detachable))[Symbol.asyncIterator]();
  assert.equal((await detachIterator.next()).value?.data, "first");
  structuredClone(detachable.buffer, { transfer: [detachable.buffer] });
  assert.equal(detachable.byteLength, 0);
  assert.deepEqual(await detachIterator.next(), {
    done: false,
    value: { data: "second", byteLength: encoder.encode("data: second\n\n").byteLength }
  });
});

test("parseSse accepts cross-realm Uint8Array and Buffer but rejects typed-array proxies", async () => {
  const frame = "data: safe\n\n";
  const raw = encoder.encode(frame);
  const foreign = runInNewContext(`new Uint8Array(${JSON.stringify([...raw])})`) as Uint8Array;
  assert.deepEqual(await collect(chunks(foreign)), [{ data: "safe", byteLength: raw.byteLength }]);
  assert.deepEqual(await collect(chunks(Buffer.from(raw))), [{ data: "safe", byteLength: raw.byteLength }]);

  const proxied = new Proxy(raw, {});
  await expectSseError(
    collect(uncheckedChunks(proxied)),
    "SSE_INVALID_CHUNK",
    "SSE source yielded an invalid byte chunk"
  );

  const revocable = Proxy.revocable(raw, {});
  revocable.revoke();
  await expectSseError(
    collect(uncheckedChunks(revocable.proxy)),
    "SSE_INVALID_CHUNK",
    "SSE source yielded an invalid byte chunk"
  );
});

test("parseSse validates and snapshots all parser limits", async () => {
  assert.throws(
    () => parseSse(bytes(""), { limits: { maxLineBytes: 0 } }),
    (error: unknown) => error instanceof SseParseError && error.code === "SSE_INVALID_LIMIT"
  );

  const mutableLimits = { maxEventCount: 1 };
  const parsed = parseSse(bytes("data: one\n\ndata: two\n\n"), { limits: mutableLimits });
  mutableLimits.maxEventCount = 2;
  await expectSseError(
    collectEvents(parsed),
    "SSE_EVENT_COUNT_LIMIT_EXCEEDED",
    "SSE event count limit exceeded"
  );
});

test("parseSse enforces line, event, buffer, and event-count limits independently", async () => {
  await expectSseError(
    collect(bytes("data: too-long\n\n"), { limits: { maxLineBytes: 5 } }),
    "SSE_LINE_LIMIT_EXCEEDED",
    "SSE line byte limit exceeded"
  );
  await expectSseError(
    collect(bytes("data: a\ndata: b\n\n"), {
      limits: { maxLineBytes: 100, maxEventBytes: 15, maxBufferBytes: 100 }
    }),
    "SSE_EVENT_LIMIT_EXCEEDED",
    "SSE event byte limit exceeded"
  );
  await expectSseError(
    collect(bytes("data: a\ndata: b\n\n"), {
      limits: { maxLineBytes: 100, maxEventBytes: 100, maxBufferBytes: 10 }
    }),
    "SSE_BUFFER_LIMIT_EXCEEDED",
    "SSE parser buffer byte limit exceeded"
  );
  await expectSseError(
    collect(bytes("data: one\n\ndata: two\n\n"), { limits: { maxEventCount: 1 } }),
    "SSE_EVENT_COUNT_LIMIT_EXCEEDED",
    "SSE event count limit exceeded"
  );
});

test("parseSse aborts promptly and closes a pending upstream iterator", async () => {
  const controller = new AbortController();
  let nextStarted!: () => void;
  const started = new Promise<void>((resolve) => { nextStarted = resolve; });
  let closes = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next() {
          nextStarted();
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        },
        async return() {
          closes += 1;
          return { done: true, value: undefined };
        }
      };
    }
  };

  const collecting = collect(source, { signal: controller.signal });
  await started;
  controller.abort();
  await expectSseError(collecting, "SSE_ABORTED", "SSE parsing aborted");
  assert.equal(closes, 1);
});

test("parseSse delivers a primary abort without awaiting a stuck iterator close", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const nextStarted = new Promise<void>((resolve) => { started = resolve; });
  let closes = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next() {
          started();
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        },
        return() {
          closes += 1;
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        }
      };
    }
  };

  const parsing = collect(source, { signal: controller.signal });
  await nextStarted;
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    parsing.then(
      () => "unexpected-success" as const,
      (error: unknown) => error
    ),
    new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 100); })
  ]);
  if (timer !== undefined) clearTimeout(timer);
  assert.equal(outcome instanceof SseParseError, true);
  assert.equal((outcome as SseParseError).code, "SSE_ABORTED");
  assert.equal(closes, 1);
});

test("parseSse never lets iterator cleanup replace a primary parser failure", async () => {
  const closeCases: readonly (() => AsyncIterable<Uint8Array>)[] = [
    () => ({
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          async next() { return { done: false, value: {} as Uint8Array }; },
          get return(): AsyncIterator<Uint8Array>["return"] {
            throw new Error("Authorization: Bearer must-not-leak");
          }
        };
      }
    }),
    () => ({
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          async next() { return { done: false, value: {} as Uint8Array }; },
          return() { throw new Error("sync cleanup must-not-leak"); }
        };
      }
    }),
    () => ({
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          async next() { return { done: false, value: {} as Uint8Array }; },
          async return() { throw new Error("async cleanup must-not-leak"); }
        };
      }
    })
  ];

  for (const createSource of closeCases) {
    await expectSseError(
      collect(createSource()),
      "SSE_INVALID_CHUNK",
      "SSE source yielded an invalid byte chunk"
    );
  }

  let getterReads = 0;
  const singleReadSource: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        async next() { return { done: false, value: {} as Uint8Array }; },
        get return(): AsyncIterator<Uint8Array>["return"] {
          getterReads += 1;
          if (getterReads > 1) throw new Error("second cleanup getter read must-not-leak");
          return async () => { throw new Error("cleanup rejection must-not-leak"); };
        }
      };
    }
  };
  await expectSseError(
    collect(singleReadSource),
    "SSE_INVALID_CHUNK",
    "SSE source yielded an invalid byte chunk"
  );
  assert.equal(getterReads, 1);
});

test("parseSse normalizes untrusted source-next and iterator-result failures", async () => {
  const forged = new SseParseError("SSE_ABORTED", "Authorization: Bearer source-must-not-leak");
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const failures: readonly (() => AsyncIterable<Uint8Array>)[] = [
    () => ({
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          async next() { throw forged; }
        };
      }
    }),
    () => ({
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next() { throw revoked.proxy; }
        };
      }
    }),
    () => ({
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          async next() {
            return Object.defineProperty({}, "done", {
              get() { throw forged; }
            }) as IteratorResult<Uint8Array>;
          }
        };
      }
    }),
    () => ({
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          async next() {
            return Object.defineProperties({}, {
              done: { value: false },
              value: { get() { throw revoked.proxy; } }
            }) as IteratorResult<Uint8Array>;
          }
        };
      }
    })
  ];

  for (const createSource of failures) {
    await expectSseError(
      collect(createSource()),
      "SSE_SOURCE_FAILED",
      "SSE source iteration failed"
    );
  }
});

test("parseSse does not read a pre-aborted source and still closes it", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  let closes = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        async next() {
          reads += 1;
          return { done: true, value: undefined };
        },
        async return() {
          closes += 1;
          return { done: true, value: undefined };
        }
      };
    }
  };

  await expectSseError(collect(source, { signal: controller.signal }), "SSE_ABORTED", "SSE parsing aborted");
  assert.equal(reads, 0);
  assert.equal(closes, 1);
});

test("parseSse observes abort between events already present in one source chunk", async () => {
  const controller = new AbortController();
  const first = "data: first\n\n";
  const iterator = parseSse(bytes(`${first}data: must-drop\n\n`), {
    signal: controller.signal
  })[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { data: "first", byteLength: encoder.encode(first).byteLength }
  });
  controller.abort();
  await expectSseError(iterator.next(), "SSE_ABORTED", "SSE parsing aborted");
});

test("parseSse gives abort precedence before processing a resolved source result", async () => {
  const controller = new AbortController();
  let closes = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next() {
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            queueMicrotask(() => {
              resolve({ done: true, value: undefined });
              queueMicrotask(() => controller.abort());
            });
          });
        },
        async return() {
          closes += 1;
          return { done: true, value: undefined };
        }
      };
    }
  };

  await expectSseError(collect(source, { signal: controller.signal }), "SSE_ABORTED", "SSE parsing aborted");
  assert.equal(closes, 1);
});

test("parseSse closes upstream when its consumer stops after one event", async () => {
  let closes = 0;
  let reads = 0;
  const payload = encoder.encode("data: one\n\ndata: two\n\n");
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        async next() {
          reads += 1;
          if (reads === 1) return { done: false, value: payload };
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        },
        async return() {
          closes += 1;
          return { done: true, value: undefined };
        }
      };
    }
  };

  for await (const event of parseSse(source)) {
    assert.equal(event.data, "one");
    break;
  }
  assert.equal(closes, 1);
});

test("parseSse remains linear for many single-byte reads and a one-MiB frame", async () => {
  const manyBytes = encoder.encode(`data: ${"x".repeat(50_000)}\n\n`);
  async function* oneByteAtATime(): AsyncIterable<Uint8Array> {
    for (const byte of manyBytes) yield Uint8Array.of(byte);
  }
  const singleByteStart = performance.now();
  const [singleByteEvent] = await collect(oneByteAtATime());
  assert.equal(singleByteEvent?.data.length, 50_000);
  assert.ok(performance.now() - singleByteStart < 5_000);

  const oneMiB = `data: ${"y".repeat(1024 * 1024)}\n\n`;
  const oneMiBStart = performance.now();
  const [largeEvent] = await collect(bytes(oneMiB));
  assert.equal(largeEvent?.data.length, 1024 * 1024);
  assert.equal(largeEvent?.byteLength, encoder.encode(oneMiB).byteLength);
  assert.ok(performance.now() - oneMiBStart < 5_000);
});

test("parseSse handles delimiter splits, field edge cases, and exact byte boundaries", async () => {
  const frame = "data\r\ndata:  kept-space\r\nid:\r\nretry: 0\r\n\r\n";
  const raw = encoder.encode(frame);
  async function* splitEveryByte(): AsyncIterable<Uint8Array> {
    for (const byte of raw) yield Uint8Array.of(byte);
  }
  assert.deepEqual(await collect(splitEveryByte(), {
    limits: {
      maxLineBytes: encoder.encode("data:  kept-space").byteLength,
      maxEventBytes: raw.byteLength,
      maxBufferBytes: 100,
      maxEventCount: 1
    }
  }), [{ data: "\n kept-space", id: "", retryMs: 0, byteLength: raw.byteLength }]);

  assert.deepEqual(await collect(bytes("\n: comment\n\nunknown\n\ndata: kept\n\n")), [
    { data: "kept", byteLength: encoder.encode("data: kept\n\n").byteLength }
  ]);
  assert.deepEqual(await collect(bytes("")), []);
});

test("parseSse reports fatal trailing UTF-8 before truncation", async () => {
  await expectSseError(
    collect(chunks(Uint8Array.from([...encoder.encode("data: "), 0xf0, 0x9f]))),
    "SSE_INVALID_UTF8",
    "SSE stream contains invalid UTF-8"
  );
});
