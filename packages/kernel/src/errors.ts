export class KernelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "KernelError";
  }
}

export class StreamVersionConflictError extends KernelError {
  constructor(readonly expected: number, readonly actual: number) {
    super(
      "STREAM_VERSION_CONFLICT",
      `对象版本冲突：期望 ${expected}，实际 ${actual}`,
      "刷新对象后重试",
      true,
    );
    this.name = "StreamVersionConflictError";
  }
}
