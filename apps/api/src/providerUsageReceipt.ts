import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { ProviderUsageReceiptVerificationUnavailableError } from "@mn/local-proxy";
import type { TrustedProxyUsageAssociation } from "@mn/provider-catalog";
import type { RunJobQueueItem } from "./runJobQueue.js";

const SIGNATURE_DOMAIN = "mn-provider-usage-receipt-v1\0";
const MAX_RECEIPT_BYTES = 8 * 1024;

export interface ProviderUsageReceiptClaims {
  readonly schemaVersion: 1;
  readonly issuer: "mn-api";
  readonly receiptId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly workerId: string;
  readonly claimDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly providerPlan?: NonNullable<TrustedProxyUsageAssociation["providerPlan"]>;
}

export interface IssueProviderUsageReceiptInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly workerId: string;
  readonly claimDigest: string;
  /** Upper bound of the API-issued sandbox/Loop authority for this claim. */
  readonly authorityExpiresAt: string;
  readonly signingKey: string;
  readonly now?: string;
  readonly receiptId?: string;
  readonly providerPlan?: NonNullable<TrustedProxyUsageAssociation["providerPlan"]>;
}

export interface IssuedProviderUsageReceipt {
  readonly receipt: string;
  readonly receiptDigest: string;
  readonly claims: ProviderUsageReceiptClaims;
}

export interface ProviderUsageReceiptAuthority {
  readRunJob(
    runId: string
  ): Promise<Pick<
    RunJobQueueItem,
    | "tenantId"
    | "status"
    | "ownerId"
    | "claimTokenHash"
    | "claimedAt"
    | "claimExpiresAt"
  > | undefined>;
}

/**
 * Production verification boundary shared by the API and LocalProxy. Receipt
 * authentication/binding failures remain ordinary errors (generic 401 at the
 * proxy); only missing or failed authority infrastructure gets the explicit
 * unavailable classification (generic 503 at the proxy).
 */
export function createEnterpriseProviderUsageReceiptVerifier(input: {
  readonly signingKey?: string;
  readonly authority?: ProviderUsageReceiptAuthority;
  readonly now?: () => string;
}): (receipt: string) => Promise<TrustedProxyUsageAssociation> {
  return async (receipt: string): Promise<TrustedProxyUsageAssociation> => {
    if (!input.signingKey || !input.authority) {
      throw new ProviderUsageReceiptVerificationUnavailableError();
    }
    let now: string;
    try {
      now = (input.now ?? (() => new Date().toISOString()))();
    } catch (cause) {
      throw new ProviderUsageReceiptVerificationUnavailableError(cause);
    }
    const association = verifyProviderUsageReceipt({
      receipt,
      signingKey: input.signingKey,
      now
    });
    let current: Awaited<ReturnType<ProviderUsageReceiptAuthority["readRunJob"]>>;
    try {
      current = await input.authority.readRunJob(association.runId);
    } catch (cause) {
      throw new ProviderUsageReceiptVerificationUnavailableError(cause);
    }
    if (
      !current ||
      current.tenantId !== association.tenantId ||
      current.status !== "running" ||
      current.ownerId !== association.workerId ||
      current.claimTokenHash !== association.claimDigest ||
      !current.claimedAt ||
      !current.claimExpiresAt ||
      current.claimedAt > now ||
      current.claimExpiresAt <= now
    ) {
      throw new TypeError("provider usage receipt is not bound to the current active claim");
    }
    return association;
  };
}

export function issueProviderUsageReceipt(
  input: IssueProviderUsageReceiptInput
): IssuedProviderUsageReceipt {
  const issuedAt = timestamp(input.now ?? new Date().toISOString(), "now");
  const expiresAt = timestamp(input.authorityExpiresAt, "authorityExpiresAt");
  if (expiresAt <= issuedAt) {
    throw new TypeError("provider usage receipt cannot outlive an expired claim");
  }
  const claims: ProviderUsageReceiptClaims = Object.freeze({
    schemaVersion: 1,
    issuer: "mn-api",
    receiptId: identifier(input.receiptId ?? randomUUID(), "receiptId"),
    tenantId: identifier(input.tenantId, "tenantId"),
    runId: identifier(input.runId, "runId"),
    candidateId: identifier(input.candidateId, "candidateId"),
    workerId: identifier(input.workerId, "workerId"),
    claimDigest: digest(input.claimDigest, "claimDigest"),
    issuedAt,
    expiresAt,
    ...(input.providerPlan ? { providerPlan: exactProviderPlan(input.providerPlan) } : {})
  });
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = sign(payload, signingKey(input.signingKey));
  const receipt = `${payload}.${signature}`;
  if (Buffer.byteLength(receipt) > MAX_RECEIPT_BYTES) {
    throw new TypeError("provider usage receipt exceeds the safe size limit");
  }
  return Object.freeze({
    receipt,
    receiptDigest: sha256(receipt),
    claims
  });
}

export function verifyProviderUsageReceipt(input: {
  readonly receipt: string;
  readonly signingKey: string;
  readonly now?: string;
}): TrustedProxyUsageAssociation {
  if (
    typeof input.receipt !== "string" ||
    input.receipt.length === 0 ||
    Buffer.byteLength(input.receipt) > MAX_RECEIPT_BYTES
  ) {
    throw new TypeError("provider usage receipt is missing or oversized");
  }
  const segments = input.receipt.split(".");
  if (
    segments.length !== 2 ||
    !segments[0] ||
    !segments[1] ||
    !/^[A-Za-z0-9_-]+$/u.test(segments[0]) ||
    !/^[a-f0-9]{64}$/u.test(segments[1])
  ) {
    throw new TypeError("provider usage receipt has an invalid envelope");
  }
  let payloadBytes: Buffer;
  try {
    payloadBytes = Buffer.from(segments[0], "base64url");
    if (payloadBytes.toString("base64url") !== segments[0]) {
      throw new TypeError("provider usage receipt payload encoding is not canonical");
    }
  } catch (error) {
    throw new TypeError("provider usage receipt has an invalid envelope", { cause: error });
  }
  const expected = sign(segments[0], signingKey(input.signingKey));
  if (!safeEqual(segments[1], expected)) {
    throw new TypeError("provider usage receipt signature is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(payloadBytes.toString("utf8"));
  } catch (error) {
    throw new TypeError("provider usage receipt payload is invalid", { cause: error });
  }
  const claims = exactClaims(value);
  const verifiedAt = timestamp(input.now ?? new Date().toISOString(), "now");
  if (verifiedAt < claims.issuedAt) {
    throw new TypeError("provider usage receipt is not active yet");
  }
  if (verifiedAt >= claims.expiresAt) {
    throw new TypeError("provider usage receipt is expired");
  }
  return Object.freeze({
    schemaVersion: 1,
    issuer: "mn-api",
    tenantId: claims.tenantId,
    runId: claims.runId,
    candidateId: claims.candidateId,
    workerId: claims.workerId,
    claimDigest: claims.claimDigest,
    receiptDigest: sha256(input.receipt),
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    verifiedAt,
    ...(claims.providerPlan ? { providerPlan: claims.providerPlan } : {})
  });
}

function exactClaims(value: unknown): ProviderUsageReceiptClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("provider usage receipt claims must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "schemaVersion",
    "issuer",
    "receiptId",
    "tenantId",
    "runId",
    "candidateId",
    "workerId",
    "claimDigest",
    "issuedAt",
    "expiresAt"
  ];
  const actualKeys = Object.keys(record).sort().join("\0");
  const legacyKeys = [...expected].sort().join("\0");
  const plannedKeys = [...expected, "providerPlan"].sort().join("\0");
  if (
    (actualKeys !== legacyKeys && actualKeys !== plannedKeys) ||
    record.schemaVersion !== 1 ||
    record.issuer !== "mn-api"
  ) {
    throw new TypeError("provider usage receipt claims are not canonical");
  }
  const claims: ProviderUsageReceiptClaims = {
    schemaVersion: 1,
    issuer: "mn-api",
    receiptId: identifier(record.receiptId, "receiptId"),
    tenantId: identifier(record.tenantId, "tenantId"),
    runId: identifier(record.runId, "runId"),
    candidateId: identifier(record.candidateId, "candidateId"),
    workerId: identifier(record.workerId, "workerId"),
    claimDigest: digest(record.claimDigest, "claimDigest"),
    issuedAt: timestamp(record.issuedAt, "issuedAt"),
    expiresAt: timestamp(record.expiresAt, "expiresAt"),
    ...(record.providerPlan === undefined
      ? {}
      : { providerPlan: exactProviderPlan(record.providerPlan) })
  };
  if (claims.expiresAt <= claims.issuedAt) {
    throw new TypeError("provider usage receipt expiry is invalid");
  }
  return Object.freeze(claims);
}

function exactProviderPlan(
  value: unknown
): NonNullable<TrustedProxyUsageAssociation["providerPlan"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("providerPlan must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = ["schemaVersion", "projectId", "app", "providerIds", "digest"];
  if (
    Object.keys(record).sort().join("\0") !== expected.sort().join("\0") ||
    record.schemaVersion !== 1 ||
    (record.app !== "claude" && record.app !== "codex") ||
    !Array.isArray(record.providerIds) ||
    record.providerIds.length === 0 ||
    record.providerIds.some((providerId) => typeof providerId !== "string")
  ) {
    throw new TypeError("providerPlan is not canonical");
  }
  const providerIds = record.providerIds.map((providerId, index) =>
    identifier(providerId, `providerPlan.providerIds[${index}]`)
  );
  if (new Set(providerIds).size !== providerIds.length) {
    throw new TypeError("providerPlan providerIds must be unique");
  }
  return Object.freeze({
    schemaVersion: 1,
    projectId: identifier(record.projectId, "providerPlan.projectId"),
    app: record.app,
    providerIds: Object.freeze(providerIds),
    digest: digest(record.digest, "providerPlan.digest")
  });
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a non-empty safe identifier`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 digest`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function signingKey(value: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) < 32) {
    throw new TypeError("provider usage receipt signing key must contain at least 32 bytes");
  }
  return value;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key)
    .update(SIGNATURE_DOMAIN, "utf8")
    .update(payload, "utf8")
    .digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const actual = Buffer.from(left, "hex");
  const expected = Buffer.from(right, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
