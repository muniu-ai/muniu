import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  SandboxExecutionEvidence,
  SandboxLeaseAttestation,
  SandboxRuntimeProof
} from "@mn/harness";
import { sha256Canonical } from "@mn/governance";

export interface SandboxRuntimeProofBinding {
  readonly attestation: SandboxLeaseAttestation;
  readonly tenantId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly claimDigest: string;
  readonly runtimeId: string;
  readonly runtimeDigest: string;
  readonly imageDigest?: string;
  readonly signingKey: string;
}

export interface SandboxRuntimeProofTrustBinding {
  readonly attestation: SandboxLeaseAttestation;
  readonly tenantId: string;
  readonly runId: string;
  readonly signingKey: string;
}

export interface SandboxRuntimeProofVerification {
  readonly valid: boolean;
  readonly reason?: string;
}

const PROOF_TTL_MS = 60 * 60 * 1_000;
const SIGNATURE_DOMAIN = "mn-sandbox-runtime-proof-v1\0";

export function issueSandboxRuntimeProof(
  input: SandboxRuntimeProofBinding,
  now = new Date().toISOString()
): SandboxRuntimeProof {
  const issuedAt = timestamp(now, "runtime proof issuance time");
  const attestation = input.attestation;
  const attestationExpiry = Date.parse(timestamp(attestation.expiresAt, "attestation expiresAt"));
  if (Date.parse(issuedAt) > attestationExpiry) {
    throw new TypeError("cannot issue runtime proof for an expired sandbox attestation");
  }
  const tenantId = identity(input.tenantId, "tenantId");
  const runId = identity(input.runId, "runId");
  const workerId = identity(input.workerId, "workerId");
  const claimDigest = digest(input.claimDigest, "claimDigest");
  const imageDigest = digest(
    input.imageDigest ?? attestation.policy.runtimeImage?.digest ?? "",
    "imageDigest"
  );
  if (
    attestation.tenantId !== tenantId ||
    attestation.runId !== runId ||
    attestation.workerId !== workerId ||
    attestation.claimDigest !== claimDigest
  ) {
    throw new TypeError("runtime proof binding does not match sandbox attestation");
  }
  const semantic = {
    schemaVersion: 1 as const,
    issuer: "mn-api" as const,
    issuedAt,
    expiresAt: new Date(
      Math.min(Date.parse(issuedAt) + PROOF_TTL_MS, attestationExpiry)
    ).toISOString(),
    tenantId,
    runId,
    workerId,
    claimDigest,
    attestationDigest: digest(attestation.digest, "attestationDigest"),
    runtimeId: digest(input.runtimeId, "runtimeId"),
    runtimeDigest: digest(input.runtimeDigest, "runtimeDigest"),
    imageDigest
  };
  const proofDigest = sha256Canonical(semantic);
  return deepFreeze({
    ...semantic,
    digest: proofDigest,
    signature: sign(proofDigest, key(input.signingKey))
  });
}

export function verifySandboxRuntimeProof(
  value: unknown,
  input: SandboxRuntimeProofBinding,
  now = new Date().toISOString()
): SandboxRuntimeProofVerification {
  const trusted = verifyIssuedSandboxRuntimeProof(value, input, now, true);
  if (!trusted.valid) return trusted;
  const candidate = value as SandboxRuntimeProof;
  if (
    candidate.workerId !== input.workerId ||
    candidate.claimDigest !== input.claimDigest ||
    candidate.runtimeId !== input.runtimeId ||
    candidate.runtimeDigest !== input.runtimeDigest ||
    candidate.imageDigest !== (input.imageDigest ?? input.attestation.policy.runtimeImage?.digest)
  ) {
    return { valid: false, reason: "runtime proof active claim or runtime binding mismatch" };
  }
  return { valid: true };
}

/** Structural binding shared by every API boundary that accepts inspected
 * runtime evidence. Signature and freshness are verified separately. */
export function sandboxExecutionMatchesAttestation(
  execution: SandboxExecutionEvidence | undefined,
  attestation: SandboxLeaseAttestation | undefined
): boolean {
  return Boolean(
    execution &&
    attestation &&
    execution.backendId === attestation.backend.id &&
    execution.backendVersion === attestation.backend.version &&
    execution.leaseId === attestation.leaseId &&
    execution.attestationDigest === attestation.digest &&
    /^[a-f0-9]{64}$/u.test(execution.runtimeId) &&
    /^[a-f0-9]{64}$/u.test(execution.runtimeDigest) &&
    typeof execution.imageDigest === "string" &&
    execution.imageDigest === attestation.policy.runtimeImage?.digest &&
    execution.runtimeProof?.attestationDigest === execution.attestationDigest &&
    execution.runtimeProof?.runtimeId === execution.runtimeId &&
    execution.runtimeProof?.runtimeDigest === execution.runtimeDigest &&
    execution.runtimeProof?.imageDigest === execution.imageDigest &&
    execution.runtimeProof?.claimDigest === attestation.claimDigest
  );
}

/** Verifies append-only historical runtime evidence without requiring its old
 * claim or freshness window to remain active. */
export function verifyIssuedSandboxRuntimeProof(
  value: unknown,
  input: SandboxRuntimeProofTrustBinding,
  now = new Date().toISOString(),
  requireFresh = false
): SandboxRuntimeProofVerification {
  try {
    const candidate = value as SandboxRuntimeProof;
    if (!candidate || typeof candidate !== "object" || candidate.schemaVersion !== 1) {
      return { valid: false, reason: "sandbox runtime proof is not a v1 object" };
    }
    digest(candidate.digest, "runtime proof digest");
    digest(candidate.signature, "runtime proof signature");
    digest(candidate.claimDigest, "runtime proof claimDigest");
    digest(candidate.attestationDigest, "runtime proof attestationDigest");
    digest(candidate.runtimeId, "runtime proof runtimeId");
    digest(candidate.runtimeDigest, "runtime proof runtimeDigest");
    if (candidate.imageDigest !== undefined) {
      digest(candidate.imageDigest, "runtime proof imageDigest");
    }
    const { digest: proofDigest, signature, ...semantic } = candidate;
    if (!safeEqual(sha256Canonical(semantic), proofDigest)) {
      return { valid: false, reason: "sandbox runtime proof content digest mismatch" };
    }
    if (!safeEqual(sign(proofDigest, key(input.signingKey)), signature)) {
      return { valid: false, reason: "sandbox runtime proof signature mismatch" };
    }
    const attestation = input.attestation;
    if (
      candidate.tenantId !== input.tenantId ||
      candidate.runId !== input.runId ||
      candidate.workerId !== attestation.workerId ||
      candidate.claimDigest !== attestation.claimDigest ||
      candidate.attestationDigest !== attestation.digest ||
      candidate.imageDigest !== attestation.policy.runtimeImage?.digest
    ) {
      return { valid: false, reason: "sandbox runtime proof immutable binding mismatch" };
    }
    const issuedAt = Date.parse(timestamp(candidate.issuedAt, "runtime proof issuedAt"));
    const expiresAt = Date.parse(timestamp(candidate.expiresAt, "runtime proof expiresAt"));
    const attestationIssuedAt = Date.parse(timestamp(attestation.issuedAt, "attestation issuedAt"));
    const attestationExpiresAt = Date.parse(timestamp(attestation.expiresAt, "attestation expiresAt"));
    if (
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > PROOF_TTL_MS ||
      issuedAt < attestationIssuedAt ||
      expiresAt > attestationExpiresAt
    ) {
      return { valid: false, reason: "sandbox runtime proof freshness bounds are invalid" };
    }
    const current = Date.parse(timestamp(now, "runtime proof verification time"));
    if (requireFresh && (current < issuedAt || current > expiresAt)) {
      return {
        valid: false,
        reason: current < issuedAt
          ? "sandbox runtime proof is not active yet"
          : "sandbox runtime proof expired"
      };
    }
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "invalid sandbox runtime proof"
    };
  }
}

function sign(value: string, signingKey: string): string {
  return createHmac("sha256", signingKey)
    .update(SIGNATURE_DOMAIN, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function identity(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a non-empty safe identifier`);
  }
  return value;
}

function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 digest`);
  }
  return value;
}

function timestamp(value: string, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function key(value: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) < 32) {
    throw new TypeError("sandbox runtime proof signing key must contain at least 32 bytes");
  }
  return value;
}

function safeEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
