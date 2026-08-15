import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxLeaseAttestation } from "@mn/harness";
import { sha256Canonical } from "@mn/governance";
import {
  issueSandboxRuntimeProof,
  verifyIssuedSandboxRuntimeProof,
  verifySandboxRuntimeProof
} from "../src/sandboxRuntimeProof.js";

const key = "runtime-proof-key-0123456789abcdef0123456789abcdef";
const now = "2026-07-12T00:00:00.000Z";

test("API runtime proof is HMAC-authenticated and bound to the active claim and inspected runtime", () => {
  const attestation = lease("1".repeat(64));
  const input = {
    attestation,
    tenantId: "tenant-a",
    runId: "run-a",
    workerId: "worker-a",
    claimDigest: attestation.claimDigest,
    runtimeId: "a".repeat(64),
    runtimeDigest: "b".repeat(64),
    imageDigest: "9".repeat(64),
    signingKey: key
  };
  const proof = issueSandboxRuntimeProof(input, now);

  assert.equal(proof.issuer, "mn-api");
  assert.equal(proof.attestationDigest, attestation.digest);
  assert.equal(proof.claimDigest, attestation.claimDigest);
  assert.equal(proof.runtimeId, input.runtimeId);
  assert.equal(proof.runtimeDigest, input.runtimeDigest);
  assert.equal(proof.imageDigest, input.imageDigest);
  assert.deepEqual(verifySandboxRuntimeProof(proof, input, now), { valid: true });
});

test("forged runtime values or proof signatures are rejected", () => {
  const attestation = lease("1".repeat(64));
  const input = {
    attestation,
    tenantId: "tenant-a",
    runId: "run-a",
    workerId: "worker-a",
    claimDigest: attestation.claimDigest,
    runtimeId: "a".repeat(64),
    runtimeDigest: "b".repeat(64),
    imageDigest: "9".repeat(64),
    signingKey: key
  };
  const proof = issueSandboxRuntimeProof(input, now);
  const changedRuntime = { ...proof, runtimeId: "c".repeat(64) };
  assert.equal(verifySandboxRuntimeProof(changedRuntime, input, now).valid, false);

  const { digest: _oldDigest, signature: _signature, ...oldSemantic } = proof;
  const semantic = { ...oldSemantic, runtimeDigest: "d".repeat(64) };
  const selfSigned = {
    ...semantic,
    digest: sha256Canonical(semantic),
    signature: proof.signature
  };
  assert.equal(verifySandboxRuntimeProof(selfSigned, input, now).valid, false);
});

test("old proof remains valid history but cannot authorize a reclaimed queue claim", () => {
  const oldAttestation = lease("1".repeat(64));
  const oldInput = {
    attestation: oldAttestation,
    tenantId: "tenant-a",
    runId: "run-a",
    workerId: "worker-a",
    claimDigest: oldAttestation.claimDigest,
    runtimeId: "a".repeat(64),
    runtimeDigest: "b".repeat(64),
    imageDigest: "9".repeat(64),
    signingKey: key
  };
  const oldProof = issueSandboxRuntimeProof(oldInput, now);
  const reclaimedAttestation = lease("2".repeat(64));
  const reclaimedInput = {
    ...oldInput,
    attestation: reclaimedAttestation,
    claimDigest: reclaimedAttestation.claimDigest
  };

  assert.equal(
    verifySandboxRuntimeProof(oldProof, reclaimedInput, "2026-07-12T00:01:00.000Z").valid,
    false
  );
  assert.deepEqual(
    verifyIssuedSandboxRuntimeProof(
      oldProof,
      { attestation: oldAttestation, tenantId: "tenant-a", runId: "run-a", signingKey: key },
      "2027-07-12T00:00:00.000Z"
    ),
    { valid: true }
  );
});

function lease(claimDigest: string): SandboxLeaseAttestation {
  return {
    schemaVersion: 1,
    leaseId: `lease-${claimDigest.slice(0, 8)}`,
    issuer: "mn-api",
    issuedAt: now,
    expiresAt: "2026-07-13T00:00:00.000Z",
    runId: "run-a",
    tenantId: "tenant-a",
    workerId: "worker-a",
    harnessDigest: "3".repeat(64),
    requirementsDigest: "4".repeat(64),
    workerCapabilityDigest: "5".repeat(64),
    claimDigest,
    backend: { id: "enterprise-container", version: "1" },
    policy: {
      mounts: [
        { source: "project", target: "/workspace/project", readOnly: true },
        { source: "scratch", target: "/workspace/scratch", readOnly: false }
      ],
      network: { mode: "deny", allowlist: [] },
      resources: { cpu: 1, memoryMb: 512, pids: 64, timeoutSeconds: 600 },
      secretNames: [],
      allowedTools: ["node"],
      readOnlyRootFilesystem: true,
      runtimeImage: {
        reference: "node:22-alpine",
        digest: "9".repeat(64)
      }
    },
    policyDigest: "6".repeat(64),
    digest: "7".repeat(64),
    signature: "8".repeat(64)
  };
}
