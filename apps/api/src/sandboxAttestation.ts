import { createHmac, timingSafeEqual } from "node:crypto";
import type { RunRecord } from "@mn/core";
import type {
  SandboxLeaseAttestation,
  SandboxLeasePolicy
} from "@mn/harness";
import { sha256Canonical } from "@mn/governance";

export interface SandboxAttestationBinding {
  readonly run: RunRecord;
  readonly tenantId: string;
  readonly workerId: string;
  readonly requirementsDigest: string;
  readonly workerCapabilityDigest: string;
  readonly claimDigest: string;
  readonly signingKey: string;
}

export interface SandboxAttestationVerification {
  readonly valid: boolean;
  readonly reason?: string;
}

export interface SandboxAttestationTrustBinding {
  readonly run: RunRecord;
  readonly tenantId: string;
  readonly requirementsDigest: string;
  readonly signingKey: string;
}

export function issueSandboxAttestation(
  input: SandboxAttestationBinding,
  now = new Date().toISOString()
): SandboxLeaseAttestation {
  const manifest = requireGovernedManifest(input.run);
  const tenantId = requireIdentity(input.tenantId, "tenantId");
  const workerId = requireIdentity(input.workerId, "workerId");
  const requirementsDigest = requireDigest(input.requirementsDigest, "requirementsDigest");
  const workerCapabilityDigest = requireDigest(
    input.workerCapabilityDigest,
    "workerCapabilityDigest"
  );
  const claimDigest = requireDigest(input.claimDigest, "claimDigest");
  const signingKey = requireSigningKey(input.signingKey);
  if (input.run.tenantId && input.run.tenantId !== tenantId) {
    throw new TypeError("sandbox attestation tenant does not match run");
  }
  if (manifest.sandbox.enforcement !== "enforced") {
    throw new TypeError("sandbox attestation requires an enforced Harness backend");
  }
  const policy = policyFromRun(input.run);
  const policyDigest = sha256Canonical(policy);
  const durationSeconds = Math.max(
    86_400,
    (manifest.stopConditions.maxDurationSeconds ?? 3_600) + 3_600
  );
  const issuedAt = normalizeTimestamp(now, "claim time");
  const semantic = {
    schemaVersion: 1 as const,
    leaseId: `sandbox-${sha256Canonical({
      runId: input.run.id,
      tenantId,
      workerId,
      harnessDigest: manifest.digest,
      requirementsDigest,
      workerCapabilityDigest,
      claimDigest,
      issuedAt
    }).slice(0, 40)}`,
    issuer: "mn-api" as const,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + durationSeconds * 1_000).toISOString(),
    runId: requireIdentity(input.run.id, "runId"),
    tenantId,
    workerId,
    harnessDigest: requireDigest(manifest.digest, "harnessDigest"),
    requirementsDigest,
    workerCapabilityDigest,
    claimDigest,
    backend: {
      id: requireIdentity(manifest.sandbox.backendId, "sandbox backend id"),
      version: requireIdentity(manifest.sandbox.backendVersion, "sandbox backend version")
    },
    policy,
    policyDigest
  };
  const digest = sha256Canonical(semantic);
  return deepFreeze({
    ...semantic,
    digest,
    signature: signDigest(digest, signingKey)
  });
}

export function verifySandboxAttestation(
  value: unknown,
  input: SandboxAttestationBinding,
  now = new Date().toISOString()
): SandboxAttestationVerification {
  const trusted = verifyIssuedSandboxAttestation(value, input, now, true);
  if (!trusted.valid) return trusted;
  try {
    const candidate = value as SandboxLeaseAttestation;
    if (
      candidate.workerId !== input.workerId ||
      candidate.workerCapabilityDigest !== input.workerCapabilityDigest ||
      candidate.claimDigest !== input.claimDigest
    ) {
      return { valid: false, reason: "sandbox attestation active claim binding mismatch" };
    }
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "invalid sandbox attestation"
    };
  }
}

/** Verifies historical API-issued evidence without requiring the old worker
 * claim to still be active. Expired leases remain valid audit evidence, while
 * their HMAC, run, tenant, Harness, requirements and policy bindings remain
 * fully checked. */
export function verifyIssuedSandboxAttestation(
  value: unknown,
  input: SandboxAttestationTrustBinding,
  now = new Date().toISOString(),
  requireFresh = false
): SandboxAttestationVerification {
  try {
    const candidate = value as SandboxLeaseAttestation;
    if (!candidate || typeof candidate !== "object" || candidate.schemaVersion !== 1) {
      return { valid: false, reason: "sandbox attestation is not a v1 object" };
    }
    requireDigest(candidate.digest, "sandbox attestation digest");
    requireDigest(candidate.signature, "sandbox attestation signature");
    requireDigest(candidate.claimDigest, "sandbox attestation claimDigest");
    const { digest, signature, ...semantic } = candidate;
    if (!safeEqual(sha256Canonical(semantic), digest)) {
      return { valid: false, reason: "sandbox attestation content digest mismatch" };
    }
    if (!safeEqual(signDigest(digest, requireSigningKey(input.signingKey)), signature)) {
      return { valid: false, reason: "sandbox attestation signature mismatch" };
    }
    const manifest = requireGovernedManifest(input.run);
    if (
      candidate.runId !== input.run.id ||
      candidate.tenantId !== input.tenantId ||
      candidate.harnessDigest !== manifest.digest ||
      candidate.requirementsDigest !== input.requirementsDigest
    ) {
      return { valid: false, reason: "sandbox attestation immutable binding mismatch" };
    }
    if (
      candidate.policyDigest !== sha256Canonical(candidate.policy) ||
      sha256Canonical(candidate.policy) !== sha256Canonical(policyFromRun(input.run))
    ) {
      return { valid: false, reason: "sandbox attestation policy binding mismatch" };
    }
    const issuedAt = Date.parse(normalizeTimestamp(candidate.issuedAt, "sandbox attestation issuedAt"));
    const expiresAt = Date.parse(normalizeTimestamp(candidate.expiresAt, "sandbox attestation expiresAt"));
    if (expiresAt <= issuedAt) {
      return { valid: false, reason: "sandbox attestation expiry is not after issuance" };
    }
    const current = Date.parse(normalizeTimestamp(now, "verification time"));
    if (requireFresh && (current < issuedAt || current > expiresAt)) {
      return {
        valid: false,
        reason: current < issuedAt
          ? "sandbox attestation is not active yet"
          : "sandbox attestation expired"
      };
    }
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "invalid sandbox attestation"
    };
  }
}

function policyFromRun(run: RunRecord): SandboxLeasePolicy {
  const manifest = requireGovernedManifest(run);
  const runtimeImage = manifest.sandbox.runtimeImage;
  if (
    !runtimeImage ||
    typeof runtimeImage.reference !== "string" ||
    !/^[a-f0-9]{64}$/u.test(runtimeImage.digest)
  ) {
    throw new TypeError(
      "enterprise sandbox requires a Harness-bound content-addressed runtime image"
    );
  }
  const allowedTools = uniqueSorted(
    (manifest.executionPolicy.commandAllowlist ?? []).map((command) => {
      if (
        typeof command !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(command)
      ) {
        throw new TypeError(
          "enterprise command allowlist entries must be bare trusted-runtime executable names"
        );
      }
      return command;
    })
  );
  if (allowedTools.length === 0) {
    throw new TypeError("enterprise sandbox requires a non-empty tool allowlist");
  }
  // Governance defines the maximum reachable set. A claim does not itself
  // prove that a Gate needs egress, so the API issues the strictly narrower
  // deny-all lease. A future policy-aware remote broker may issue a reviewed
  // subset, but a worker can never widen this value by self-reporting it.
  const networkAllowlist: string[] = [];
  return deepFreeze({
    mounts: [
      { source: "project", target: "/workspace/project", readOnly: true },
      { source: "scratch", target: "/workspace/scratch", readOnly: false }
    ],
    network: {
      mode: networkAllowlist.length === 0 ? "deny" : "allowlist",
      allowlist: networkAllowlist
    },
    resources: {
      cpu: 1,
      memoryMb: 512,
      pids: 64,
      timeoutSeconds: Math.max(
        1,
        Math.min(manifest.stopConditions.maxDurationSeconds ?? 600, 3_600)
      )
    },
    secretNames: [],
    allowedTools,
    readOnlyRootFilesystem: true,
    runtimeImage: { ...runtimeImage }
  });
}

function requireGovernedManifest(run: RunRecord) {
  if (!run.harnessManifest) {
    throw new TypeError("sandbox attestation requires a governed HarnessManifest");
  }
  return run.harnessManifest;
}

function requireIdentity(value: string, field: string): string {
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

function requireDigest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 digest`);
  }
  return value;
}

function requireSigningKey(value: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) < 32) {
    throw new TypeError("sandbox attestation signing key must contain at least 32 bytes");
  }
  return value;
}

function normalizeTimestamp(value: string, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function signDigest(digest: string, key: string): string {
  return createHmac("sha256", key).update(digest, "utf8").digest("hex");
}

function safeEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
