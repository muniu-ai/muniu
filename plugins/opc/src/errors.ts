export type OpcDomainErrorCode =
  | "ALREADY_EXISTS"
  | "DUPLICATE_ID"
  | "HUMAN_REQUIRED"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "NOT_FOUND"
  | "REQUIRED_FIELD"
  | "STREAM_VERSION_CONFLICT";

export class OpcDomainError extends Error {
  constructor(
    readonly code: OpcDomainErrorCode,
    message: string,
    readonly action: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "OpcDomainError";
  }
}

export function requireText(value: string, field: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new OpcDomainError(
      "REQUIRED_FIELD",
      `${label}不能为空`,
      `填写${label}后重试`,
      field,
    );
  }
  return normalized;
}

export function requireNonEmpty<T>(
  values: readonly T[],
  field: string,
  label: string,
): readonly T[] {
  if (values.length === 0) {
    throw new OpcDomainError(
      "REQUIRED_FIELD",
      `${label}不能为空`,
      `补充${label}后重试`,
      field,
    );
  }
  return values;
}
