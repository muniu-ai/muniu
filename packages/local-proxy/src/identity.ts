import { createHash } from "node:crypto";

/** Stable append identity for one terminal/non-terminal provider attempt. */
export function providerUsageAttemptLogId(
  logicalRequestId: string,
  attemptIndex: number
): string {
  return `mn-usage-${sha256(JSON.stringify({
    domain: "mn-provider-usage-attempt-v1",
    logicalRequestId,
    attemptIndex
  }))}`;
}

export function providerUsageResolutionLogId(
  logicalRequestId: string,
  resolution: "pre-dispatch-zero" | "reconciliation"
): string {
  return `mn-usage-${sha256(JSON.stringify({
    domain: "mn-provider-usage-resolution-v1",
    logicalRequestId,
    resolution
  }))}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
