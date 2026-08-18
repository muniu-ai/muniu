// SPDX-License-Identifier: Apache-2.0

export type SseErrorCode =
  | "SSE_ABORTED"
  | "SSE_BUFFER_LIMIT_EXCEEDED"
  | "SSE_EVENT_COUNT_LIMIT_EXCEEDED"
  | "SSE_EVENT_LIMIT_EXCEEDED"
  | "SSE_INVALID_CHUNK"
  | "SSE_INVALID_LIMIT"
  | "SSE_INVALID_UTF8"
  | "SSE_LINE_LIMIT_EXCEEDED"
  | "SSE_SOURCE_FAILED"
  | "SSE_TRUNCATED";

export class SseParseError extends Error {
  override readonly name = "SseParseError";

  constructor(readonly code: SseErrorCode, message: string) {
    super(message);
  }
}

export class ModelOutcomePersistenceError extends Error {
  override readonly name = "ModelOutcomePersistenceError";

  constructor() {
    super("Model attempt audit persistence failed");
  }
}
