/** Stable public response text for a temporarily unavailable receipt authority. */
export const PROVIDER_USAGE_RECEIPT_AUTHORITY_UNAVAILABLE_MESSAGE =
  "provider usage receipt authority is unavailable";

/** Stable public response text for every untrusted receipt/binding failure. */
export const INVALID_PROVIDER_USAGE_RECEIPT_MESSAGE =
  "provider usage receipt is invalid";

/**
 * Explicit boundary error used when a trusted receipt cannot be verified
 * because its authority is unavailable. Invalid, expired or unbound receipts
 * must not use this class: those remain authentication failures.
 */
export class ProviderUsageReceiptVerificationUnavailableError extends Error {
  readonly code = "MN_PROVIDER_USAGE_RECEIPT_VERIFICATION_UNAVAILABLE" as const;

  constructor(cause?: unknown) {
    super(PROVIDER_USAGE_RECEIPT_AUTHORITY_UNAVAILABLE_MESSAGE, { cause });
    this.name = "ProviderUsageReceiptVerificationUnavailableError";
  }
}

export function isProviderUsageReceiptVerificationUnavailableError(
  error: unknown
): error is ProviderUsageReceiptVerificationUnavailableError {
  return error instanceof ProviderUsageReceiptVerificationUnavailableError;
}
