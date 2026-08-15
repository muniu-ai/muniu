import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject
} from "node:crypto";
import { canonicalJson, deepFreeze } from "@mn/governance";
import { z } from "zod";

const INVALID_MESSAGE = "Provider usage evidence is invalid";
const UNAVAILABLE_MESSAGE = "Provider usage evidence verification is unavailable";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

const boundedText = (max: number) => z.string()
  .min(1)
  .max(max)
  .refine((value) => value === value.trim())
  .refine((value) => !CONTROL_PATTERN.test(value));
const identifierSchema = boundedText(512);
const digestSchema = z.string().regex(DIGEST_PATTERN);
const tokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const tokenClaimsSchema = z.object({
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cachedInputTokens: tokenCountSchema,
  cacheCreationInputTokens: tokenCountSchema,
  cacheReadInputTokens: tokenCountSchema,
  reasoningOutputTokens: tokenCountSchema
}).strict();

const claimsSchema = z.object({
  kind: z.enum(["provider", "invoice"]),
  app: z.enum(["claude", "codex"]),
  tenantId: identifierSchema,
  runId: identifierSchema,
  logicalRequestId: identifierSchema,
  providerId: identifierSchema,
  providerAccountId: identifierSchema,
  providerRequestId: identifierSchema,
  dispatchRequestDigest: digestSchema,
  outboundRequestKeyDigest: digestSchema.optional(),
  model: identifierSchema,
  statusCode: z.number().int().nonnegative().max(999),
  tokens: tokenClaimsSchema,
  authoritativeCostUsd: z.number().finite().nonnegative(),
  sourceReference: boundedText(4_096),
  issuedAt: z.string()
}).strict();

const unsignedEnvelopeSchema = z.object({
  schemaVersion: z.literal(2),
  claims: claimsSchema,
  algorithm: z.literal("ed25519"),
  keyId: identifierSchema,
  issuer: identifierSchema
}).strict();

const envelopeSchema = unsignedEnvelopeSchema.extend({
  signature: boundedText(512)
}).strict();

const trustKeySchema = z.object({
  keyId: identifierSchema,
  publicKey: z.string().min(1).max(32_768),
  status: z.enum(["active", "retired", "revoked"]),
  retiredAt: z.string().optional()
}).strict();

const trustedIssuerSchema = z.object({
  issuer: identifierSchema,
  providerIds: z.array(identifierSchema).min(1),
  providerAccountIds: z.array(identifierSchema).min(1),
  keys: z.array(trustKeySchema).min(1)
}).strict();

const trustProfileSchema = z.object({
  schemaVersion: z.literal(1),
  issuers: z.array(trustedIssuerSchema).min(1),
  maxFutureSkewSeconds: z.number().int().nonnegative().max(86_400).optional(),
  maxEvidenceAgeSeconds: z.number().int().positive().max(10 * 365 * 24 * 60 * 60).optional()
}).strict();

const expectedBindingsSchema = z.object({
  kind: z.enum(["provider", "invoice"]),
  app: z.enum(["claude", "codex"]),
  tenantId: identifierSchema,
  runId: identifierSchema,
  logicalRequestId: identifierSchema,
  providerId: identifierSchema,
  providerAccountId: identifierSchema,
  providerRequestId: identifierSchema,
  dispatchRequestDigest: digestSchema,
  outboundRequestKeyDigest: digestSchema.optional(),
  model: identifierSchema,
  statusCode: z.number().int().nonnegative().max(999),
  tokens: tokenClaimsSchema,
  authoritativeCostUsd: z.number().finite().nonnegative(),
  sourceReference: boundedText(4_096).optional(),
  issuer: identifierSchema.optional(),
  verificationTime: z.string().optional()
}).strict();

export type ProviderUsageEvidenceKeyStatus = "active" | "retired" | "revoked";

export interface ProviderUsageEvidenceTokenClaims {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly reasoningOutputTokens: number;
}

export interface ProviderUsageEvidenceClaims {
  readonly kind: "provider" | "invoice";
  readonly app: "claude" | "codex";
  readonly tenantId: string;
  readonly runId: string;
  readonly logicalRequestId: string;
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly providerRequestId: string;
  /** Digest of the durable dispatch semantics, present even without a wire key. */
  readonly dispatchRequestDigest: string;
  /** Exact wire idempotency-key digest when the provider declares one. */
  readonly outboundRequestKeyDigest?: string;
  readonly model: string;
  readonly statusCode: number;
  readonly tokens: ProviderUsageEvidenceTokenClaims;
  readonly authoritativeCostUsd: number;
  readonly sourceReference: string;
  readonly issuedAt: string;
}

export interface UnsignedProviderUsageEvidenceEnvelope {
  readonly schemaVersion: 2;
  readonly claims: ProviderUsageEvidenceClaims;
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly issuer: string;
}

export interface ProviderUsageEvidenceEnvelope
  extends UnsignedProviderUsageEvidenceEnvelope {
  /** Canonical, unpadded base64url Ed25519 detached signature. */
  readonly signature: string;
}

export interface ProviderUsageEvidenceTrustKey {
  readonly keyId: string;
  /** Ed25519 SPKI public key encoded as PEM or canonical DER base64. */
  readonly publicKey: string;
  readonly status: ProviderUsageEvidenceKeyStatus;
  /** Retired keys may verify only evidence issued no later than this instant. */
  readonly retiredAt?: string;
}

export interface ProviderUsageEvidenceTrustedIssuer {
  readonly issuer: string;
  readonly providerIds: readonly string[];
  readonly providerAccountIds: readonly string[];
  readonly keys: readonly ProviderUsageEvidenceTrustKey[];
}

export interface ProviderUsageEvidenceTrustProfile {
  readonly schemaVersion: 1;
  readonly issuers: readonly ProviderUsageEvidenceTrustedIssuer[];
  /** Defaults to 60 seconds. */
  readonly maxFutureSkewSeconds?: number;
  /** Omit to allow old invoices; when set, evidence older than this is rejected. */
  readonly maxEvidenceAgeSeconds?: number;
}

export interface ExpectedProviderUsageEvidenceBindings {
  readonly kind: "provider" | "invoice";
  readonly app: "claude" | "codex";
  readonly tenantId: string;
  readonly runId: string;
  readonly logicalRequestId: string;
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly providerRequestId: string;
  readonly dispatchRequestDigest: string;
  readonly outboundRequestKeyDigest?: string;
  readonly model: string;
  readonly statusCode: number;
  readonly tokens: ProviderUsageEvidenceTokenClaims;
  readonly authoritativeCostUsd: number;
  readonly sourceReference?: string;
  readonly issuer?: string;
  /** Deterministic verification clock; defaults to the current wall clock. */
  readonly verificationTime?: string;
}

export interface VerifiedProviderUsageEvidence {
  readonly claims: ProviderUsageEvidenceClaims;
  readonly issuer: string;
  readonly keyId: string;
  /** SHA-256 of the decoded signature bytes. */
  readonly signatureDigest: string;
}

export interface ProviderUsageEvidenceVerifier {
  verify(
    envelope: unknown,
    expected: ExpectedProviderUsageEvidenceBindings
  ): VerifiedProviderUsageEvidence;
}

export class ProviderUsageEvidenceInvalidError extends Error {
  readonly code = "provider_usage_evidence_invalid" as const;

  constructor() {
    super(INVALID_MESSAGE);
    this.name = "ProviderUsageEvidenceInvalidError";
  }
}

export class ProviderUsageEvidenceVerificationUnavailableError extends Error {
  readonly code = "provider_usage_evidence_verification_unavailable" as const;

  constructor() {
    super(UNAVAILABLE_MESSAGE);
    this.name = "ProviderUsageEvidenceVerificationUnavailableError";
  }
}

interface CompiledTrustKey {
  readonly keyId: string;
  readonly key: KeyObject;
  readonly status: ProviderUsageEvidenceKeyStatus;
  readonly retiredAt?: number;
}

interface CompiledTrustedIssuer {
  readonly providerIds: ReadonlySet<string>;
  readonly providerAccountIds: ReadonlySet<string>;
  readonly keys: ReadonlyMap<string, CompiledTrustKey>;
}

interface CompiledTrustProfile {
  readonly issuers: ReadonlyMap<string, CompiledTrustedIssuer>;
  readonly maxFutureSkewSeconds: number;
  readonly maxEvidenceAgeSeconds?: number;
}

/**
 * Returns the exact canonical bytes covered by the detached signature. The
 * signer metadata is covered as well as claims, preventing issuer/key header
 * substitution when organizations reuse key material.
 */
export function providerUsageEvidenceSigningPayload(
  envelope: UnsignedProviderUsageEvidenceEnvelope
): string {
  const parsed = unsignedEnvelopeSchema.safeParse(envelope);
  if (!parsed.success || canonicalInstant(parsed.data.claims.issuedAt) === undefined) {
    throw new ProviderUsageEvidenceInvalidError();
  }
  return canonicalJson(parsed.data);
}

/**
 * Compiles a trust profile once. Missing or malformed trust configuration is
 * represented as an unavailable verifier so conservative reconciliation can
 * remain available without weakening exact reconciliation.
 */
export function createProviderUsageEvidenceVerifier(
  profile: ProviderUsageEvidenceTrustProfile | undefined
): ProviderUsageEvidenceVerifier {
  const compiled = compileTrustProfile(profile);
  return Object.freeze({
    verify(
      envelope: unknown,
      expected: ExpectedProviderUsageEvidenceBindings
    ): VerifiedProviderUsageEvidence {
      if (!compiled) {
        throw new ProviderUsageEvidenceVerificationUnavailableError();
      }
      return verifyEnvelope(compiled, envelope, expected);
    }
  });
}

export function verifyProviderUsageEvidence(
  profile: ProviderUsageEvidenceTrustProfile | undefined,
  envelope: unknown,
  expected: ExpectedProviderUsageEvidenceBindings
): VerifiedProviderUsageEvidence {
  return createProviderUsageEvidenceVerifier(profile).verify(envelope, expected);
}

function compileTrustProfile(
  input: ProviderUsageEvidenceTrustProfile | undefined
): CompiledTrustProfile | undefined {
  const parsed = trustProfileSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const issuers = new Map<string, CompiledTrustedIssuer>();
  try {
    for (const declaration of parsed.data.issuers) {
      if (
        issuers.has(declaration.issuer) ||
        hasDuplicates(declaration.providerIds) ||
        hasDuplicates(declaration.providerAccountIds)
      ) {
        return undefined;
      }
      const keys = new Map<string, CompiledTrustKey>();
      for (const declarationKey of declaration.keys) {
        if (keys.has(declarationKey.keyId)) return undefined;
        if (
          declarationKey.status === "retired" &&
          canonicalInstant(declarationKey.retiredAt) === undefined
        ) {
          return undefined;
        }
        if (
          declarationKey.status !== "retired" &&
          declarationKey.retiredAt !== undefined
        ) {
          return undefined;
        }
        const key = cryptoPublicKey(declarationKey.publicKey);
        if (key.asymmetricKeyType !== "ed25519") return undefined;
        keys.set(declarationKey.keyId, Object.freeze({
          keyId: declarationKey.keyId,
          key,
          status: declarationKey.status,
          ...(declarationKey.retiredAt
            ? { retiredAt: canonicalInstant(declarationKey.retiredAt)! }
            : {})
        }));
      }
      issuers.set(declaration.issuer, Object.freeze({
        providerIds: new Set(declaration.providerIds),
        providerAccountIds: new Set(declaration.providerAccountIds),
        keys
      }));
    }
  } catch {
    return undefined;
  }
  return Object.freeze({
    issuers,
    maxFutureSkewSeconds: parsed.data.maxFutureSkewSeconds ?? 60,
    ...(parsed.data.maxEvidenceAgeSeconds !== undefined
      ? { maxEvidenceAgeSeconds: parsed.data.maxEvidenceAgeSeconds }
      : {})
  });
}

function verifyEnvelope(
  trust: CompiledTrustProfile,
  rawEnvelope: unknown,
  rawExpected: ExpectedProviderUsageEvidenceBindings
): VerifiedProviderUsageEvidence {
  const expectedResult = expectedBindingsSchema.safeParse(rawExpected);
  if (!expectedResult.success) {
    throw new ProviderUsageEvidenceVerificationUnavailableError();
  }
  const verificationTime = canonicalInstant(
    expectedResult.data.verificationTime ?? new Date().toISOString()
  );
  if (verificationTime === undefined) {
    throw new ProviderUsageEvidenceVerificationUnavailableError();
  }
  const envelopeResult = envelopeSchema.safeParse(rawEnvelope);
  if (!envelopeResult.success) throw new ProviderUsageEvidenceInvalidError();
  const envelope = envelopeResult.data;
  const issuedAt = canonicalInstant(envelope.claims.issuedAt);
  if (issuedAt === undefined) throw new ProviderUsageEvidenceInvalidError();

  const issuer = trust.issuers.get(envelope.issuer);
  const key = issuer?.keys.get(envelope.keyId);
  if (!issuer || !key || key.status === "revoked") {
    throw new ProviderUsageEvidenceInvalidError();
  }
  if (
    !issuer.providerIds.has(envelope.claims.providerId) ||
    !issuer.providerAccountIds.has(envelope.claims.providerAccountId) ||
    (key.status === "retired" && issuedAt > key.retiredAt!)
  ) {
    throw new ProviderUsageEvidenceInvalidError();
  }
  if (
    issuedAt > verificationTime + trust.maxFutureSkewSeconds * 1_000 ||
    (trust.maxEvidenceAgeSeconds !== undefined &&
      verificationTime - issuedAt > trust.maxEvidenceAgeSeconds * 1_000)
  ) {
    throw new ProviderUsageEvidenceInvalidError();
  }
  if (!bindingsMatch(envelope, expectedResult.data)) {
    throw new ProviderUsageEvidenceInvalidError();
  }

  const signature = canonicalBase64Url(envelope.signature);
  if (!signature || signature.byteLength !== 64) {
    throw new ProviderUsageEvidenceInvalidError();
  }
  const { signature: _signature, ...unsigned } = envelope;
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(canonicalJson(unsigned), "utf8"),
      key.key,
      signature
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new ProviderUsageEvidenceInvalidError();

  const claims = deepFreeze(
    JSON.parse(canonicalJson(envelope.claims)) as ProviderUsageEvidenceClaims
  );
  return deepFreeze({
    claims,
    issuer: envelope.issuer,
    keyId: envelope.keyId,
    signatureDigest: createHash("sha256").update(signature).digest("hex")
  });
}

function bindingsMatch(
  envelope: z.infer<typeof envelopeSchema>,
  expected: z.infer<typeof expectedBindingsSchema>
): boolean {
  const claims = envelope.claims;
  const required = {
    kind: expected.kind,
    app: expected.app,
    tenantId: expected.tenantId,
    runId: expected.runId,
    logicalRequestId: expected.logicalRequestId,
    providerId: expected.providerId,
    providerAccountId: expected.providerAccountId,
    providerRequestId: expected.providerRequestId,
    dispatchRequestDigest: expected.dispatchRequestDigest,
    ...(expected.outboundRequestKeyDigest
      ? { outboundRequestKeyDigest: expected.outboundRequestKeyDigest }
      : {}),
    model: expected.model,
    statusCode: expected.statusCode,
    tokens: expected.tokens,
    authoritativeCostUsd: expected.authoritativeCostUsd
  };
  const actual = {
    kind: claims.kind,
    app: claims.app,
    tenantId: claims.tenantId,
    runId: claims.runId,
    logicalRequestId: claims.logicalRequestId,
    providerId: claims.providerId,
    providerAccountId: claims.providerAccountId,
    providerRequestId: claims.providerRequestId,
    dispatchRequestDigest: claims.dispatchRequestDigest,
    ...(claims.outboundRequestKeyDigest
      ? { outboundRequestKeyDigest: claims.outboundRequestKeyDigest }
      : {}),
    model: claims.model,
    statusCode: claims.statusCode,
    tokens: claims.tokens,
    authoritativeCostUsd: claims.authoritativeCostUsd
  };
  return (
    canonicalJson(actual) === canonicalJson(required) &&
    (expected.sourceReference === undefined ||
      expected.sourceReference === claims.sourceReference) &&
    (expected.issuer === undefined || expected.issuer === envelope.issuer)
  );
}

function cryptoPublicKey(value: string): KeyObject {
  if (value.includes("BEGIN")) return createPublicKey(value);
  const der = canonicalBase64(value);
  if (!der) throw new TypeError("invalid key");
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

function canonicalBase64(value: string): Buffer | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

function canonicalBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

function canonicalInstant(value: unknown): number | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return undefined;
  }
  return milliseconds;
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}
