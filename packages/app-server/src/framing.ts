// SPDX-License-Identifier: Apache-2.0

import { MAX_FRAME_BYTES } from "./outbound-queue.js";

export class FrameTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`JSONL frame exceeds ${limit} bytes`);
    this.name = "FrameTooLargeError";
  }
}

export class JsonlFrameDecoder {
  readonly #maxFrameBytes: number;
  #buffer = Buffer.alloc(0);

  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer | string): string[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.#buffer = this.#buffer.length === 0 ? incoming : Buffer.concat([this.#buffer, incoming]);
    const frames: string[] = [];
    let newline = this.#buffer.indexOf(0x0a);
    while (newline !== -1) {
      let end = newline;
      if (end > 0 && this.#buffer[end - 1] === 0x0d) end -= 1;
      if (end > this.#maxFrameBytes) throw new FrameTooLargeError(this.#maxFrameBytes);
      if (end > 0) frames.push(this.#buffer.subarray(0, end).toString("utf8"));
      this.#buffer = this.#buffer.subarray(newline + 1);
      newline = this.#buffer.indexOf(0x0a);
    }
    if (this.#buffer.length > this.#maxFrameBytes) throw new FrameTooLargeError(this.#maxFrameBytes);
    return frames;
  }
}

export function encodeJsonLine(value: unknown, maxFrameBytes = MAX_FRAME_BYTES): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > maxFrameBytes) throw new FrameTooLargeError(maxFrameBytes);
  return `${json}\n`;
}
