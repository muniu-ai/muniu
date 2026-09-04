export type CodingDomainErrorCode =
  | "ALREADY_EXISTS"
  | "DUPLICATE_ID"
  | "FAIL_CLOSED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IMMUTABLE_SNAPSHOT"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "MISSING_PREREQUISITE"
  | "NOT_FOUND"
  | "STREAM_VERSION_CONFLICT";

export class CodingDomainError extends Error {
  readonly code: CodingDomainErrorCode;
  readonly action: string;
  readonly field?: string;

  constructor(
    code: CodingDomainErrorCode,
    message: string,
    action: string,
    field?: string,
  ) {
    super(message);
    this.name = "CodingDomainError";
    this.code = code;
    this.action = action;
    this.field = field;
  }
}

export function requireCodingText(value: string, field: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CodingDomainError(
      "INVALID_INPUT",
      `${label}不能为空`,
      `填写${label}后重试`,
      field,
    );
  }
  return normalized;
}
