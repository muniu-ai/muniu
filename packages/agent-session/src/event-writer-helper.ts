// SPDX-License-Identifier: Apache-2.0

import { close, fsync, ftruncate, write } from "node:fs";

const EVENT_FD = 3;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_FRAMES = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface WriterRequest {
  readonly nonce: string;
  readonly requestId: string;
  readonly operation: "append" | "flush" | "truncate" | "close";
  readonly line?: string;
  readonly length?: number;
}

function ownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const permitted = new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key));
}

function parseRequest(line: string, nonce: string): WriterRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("invalid writer request JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid writer request envelope");
  }
  const request = value as Record<string, unknown>;
  if (request.nonce !== nonce
    || typeof request.requestId !== "string"
    || !UUID_PATTERN.test(request.requestId)
    || typeof request.operation !== "string"
    || !["append", "flush", "truncate", "close"].includes(request.operation)) {
    throw new Error("invalid writer request envelope");
  }
  if (request.operation === "append") {
    if (!ownKeys(request, ["nonce", "requestId", "operation", "line"])
      || typeof request.line !== "string"
      || !request.line.endsWith("\n")
      || request.line.slice(0, -1).includes("\n")
      || Buffer.byteLength(request.line, "utf8") > MAX_FRAME_BYTES) {
      throw new Error("invalid append request");
    }
  } else if (request.operation === "truncate") {
    if (!ownKeys(request, ["nonce", "requestId", "operation", "length"])
      || !Number.isSafeInteger(request.length)
      || (request.length as number) < 0) {
      throw new Error("invalid truncate request");
    }
  } else if (!ownKeys(request, ["nonce", "requestId", "operation"])) {
    throw new Error("invalid writer request fields");
  }
  return request as unknown as WriterRequest;
}

function writeFd(buffer: Buffer, offset: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    write(EVENT_FD, buffer, offset, buffer.length - offset, null, (error, bytesWritten) => {
      if (error !== null) reject(error);
      else resolve(bytesWritten);
    });
  });
}

async function writeAll(buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const written = await writeFd(buffer, offset);
    if (written <= 0) throw new Error("event writer made no write progress");
    offset += written;
  }
}

function syncFd(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    fsync(EVENT_FD, (error) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
}

function truncateFd(length: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ftruncate(EVENT_FD, length, (error) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
}

function closeFd(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    close(EVENT_FD, (error) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
}

function send(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const [fdArgument, nonce] = process.argv.slice(2);
if (fdArgument !== String(EVENT_FD) || nonce === undefined || !UUID_PATTERN.test(nonce)) {
  process.exitCode = 64;
} else {
  let input = Buffer.alloc(0);
  let pendingFrames = 0;
  let closed = false;
  let failed = false;
  let queue = Promise.resolve();

  const fail = (): void => {
    if (failed) return;
    failed = true;
    process.exitCode = 70;
    process.stdin.destroy();
  };

  const handle = async (frame: Buffer): Promise<void> => {
    try {
      const request = parseRequest(frame.toString("utf8"), nonce);
      if (closed) throw new Error("event writer is closed");
      if (request.operation === "append") {
        await writeAll(Buffer.from(request.line as string, "utf8"));
        await syncFd();
      } else if (request.operation === "truncate") {
        await truncateFd(request.length as number);
        await syncFd();
      } else if (request.operation === "flush") {
        await syncFd();
      } else {
        await syncFd();
        await closeFd();
        closed = true;
      }
      send({ nonce, requestId: request.requestId, status: "ok" });
      if (closed) process.stdin.destroy();
    } catch {
      fail();
    } finally {
      pendingFrames -= 1;
    }
  };

  process.stdin.on("data", (chunk: Buffer) => {
    if (failed || closed) return;
    input = Buffer.concat([input, chunk]);
    if (input.length > MAX_FRAME_BYTES + 1) {
      fail();
      return;
    }
    let newline = input.indexOf(0x0a);
    while (newline >= 0) {
      const frame = input.subarray(0, newline);
      input = input.subarray(newline + 1);
      pendingFrames += 1;
      if (pendingFrames > MAX_PENDING_FRAMES || frame.length === 0 || frame.length > MAX_FRAME_BYTES) {
        fail();
        return;
      }
      queue = queue.then(() => handle(frame));
      newline = input.indexOf(0x0a);
    }
  });
  process.stdin.on("end", () => {
    if (!closed || input.length !== 0 || pendingFrames !== 0) fail();
  });
  process.stdin.on("error", fail);
  process.stdout.on("error", fail);
  send({ nonce, status: "ready", pid: process.pid });
  process.stdin.resume();
}
