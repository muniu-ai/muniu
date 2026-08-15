import assert from "node:assert/strict";
import test from "node:test";
import type { RunRecord } from "@mn/core";
import {
  issueSandboxAttestation,
  verifyIssuedSandboxAttestation,
  verifySandboxAttestation
} from "../src/sandboxAttestation.js";

const key = "0123456789abcdef0123456789abcdef";

test("server-issued sandbox attestation is deterministic for one claim and bound to run, tenant, worker and Harness", () => {
  const run = governedRun();
  const input = {
    run,
    tenantId: "tenant-a",
    workerId: "worker-a",
    requirementsDigest: "1".repeat(64),
    workerCapabilityDigest: "2".repeat(64),
    claimDigest: "3".repeat(64),
    signingKey: key
  };
  const now = "2026-08-12T00:00:00.000Z";
  const first = issueSandboxAttestation(input, now);
  const second = issueSandboxAttestation(input, now);

  assert.deepEqual(first, second);
  assert.equal(first.issuedAt, now);
  assert.equal(first.claimDigest, input.claimDigest);
  assert.match(first.digest, /^[a-f0-9]{64}$/u);
  assert.match(first.signature, /^[a-f0-9]{64}$/u);
  assert.equal(first.backend.id, "enterprise-container");
  assert.equal(first.backend.version, "1");
  assert.equal(first.policy.network.mode, "deny");
  assert.deepEqual(first.policy.allowedTools, ["node"]);
  assert.equal(first.policy.mounts[0]?.readOnly, true);
  assert.equal(first.policy.readOnlyRootFilesystem, true);
  assert.deepEqual(first.policy.runtimeImage, {
    reference: "node:22-alpine",
    digest: "9".repeat(64)
  });
  assert.deepEqual(verifySandboxAttestation(first, input, now), { valid: true });
});

test("sandbox attestation rejects policy tampering and cross-worker replay", () => {
  const run = governedRun();
  const input = {
    run,
    tenantId: "tenant-a",
    workerId: "worker-a",
    requirementsDigest: "1".repeat(64),
    workerCapabilityDigest: "2".repeat(64),
    claimDigest: "3".repeat(64),
    signingKey: key
  };
  const now = "2026-07-12T00:00:00.000Z";
  const attestation = issueSandboxAttestation(input, now);
  const tampered = structuredClone(attestation) as unknown as {
    policy: { resources: { memoryMb: number } };
  };
  tampered.policy.resources.memoryMb = 65_536;

  assert.equal(verifySandboxAttestation(tampered, input, now).valid, false);
  assert.equal(
    verifySandboxAttestation(attestation, { ...input, workerId: "worker-b" }, now).valid,
    false
  );
  assert.equal(
    verifySandboxAttestation(attestation, {
      ...input,
      run: { ...run, harnessManifest: { ...run.harnessManifest!, digest: "3".repeat(64) } }
    }, now).valid,
    false
  );
});

test("sandbox attestation rejects candidate-relative and command-line allowlist aliases", () => {
  for (const command of ["./node", "/workspace/scratch/node", "node --test"]) {
    const run = governedRun();
    run.harnessManifest = {
      ...run.harnessManifest!,
      executionPolicy: {
        ...run.harnessManifest!.executionPolicy,
        commandAllowlist: [command]
      }
    };
    assert.throws(
      () => issueSandboxAttestation({
        run,
        tenantId: "tenant-a",
        workerId: "worker-a",
        requirementsDigest: "1".repeat(64),
        workerCapabilityDigest: "2".repeat(64),
        claimDigest: "3".repeat(64),
        signingKey: key
      }, "2026-07-12T00:00:00.000Z"),
      /bare trusted-runtime executable names/u
    );
  }
});

test("an old run receives a fresh lease at claim time instead of an already-expired creation-time lease", () => {
  const run = governedRun();
  const input = {
    run: { ...run, createdAt: "2020-01-01T00:00:00.000Z" },
    tenantId: "tenant-a",
    workerId: "worker-a",
    requirementsDigest: "1".repeat(64),
    workerCapabilityDigest: "2".repeat(64),
    claimDigest: "3".repeat(64),
    signingKey: key
  };
  const claimTime = "2026-07-12T12:34:56.000Z";
  const attestation = issueSandboxAttestation(input, claimTime);

  assert.equal(attestation.issuedAt, claimTime);
  assert.ok(Date.parse(attestation.expiresAt) > Date.parse(claimTime));
  assert.deepEqual(verifySandboxAttestation(attestation, input, claimTime), { valid: true });
});

test("release and reclaim rejects the old claim lease while preserving it as historical signed evidence", () => {
  const run = governedRun();
  const firstClaim = {
    run,
    tenantId: "tenant-a",
    workerId: "worker-a",
    requirementsDigest: "1".repeat(64),
    workerCapabilityDigest: "2".repeat(64),
    claimDigest: "3".repeat(64),
    signingKey: key
  };
  const reclaimed = { ...firstClaim, claimDigest: "4".repeat(64) };
  const oldLease = issueSandboxAttestation(firstClaim, "2026-07-12T00:00:00.000Z");
  const newLease = issueSandboxAttestation(reclaimed, "2026-07-12T00:05:00.000Z");

  assert.notEqual(oldLease.leaseId, newLease.leaseId);
  assert.notEqual(oldLease.digest, newLease.digest);
  assert.equal(
    verifySandboxAttestation(oldLease, reclaimed, "2026-07-12T00:05:01.000Z").valid,
    false
  );
  assert.deepEqual(
    verifyIssuedSandboxAttestation(oldLease, firstClaim, "2027-07-12T00:00:00.000Z"),
    { valid: true }
  );
  assert.deepEqual(
    verifySandboxAttestation(newLease, reclaimed, "2026-07-12T00:05:01.000Z"),
    { valid: true }
  );
});

function governedRun(): RunRecord {
  return {
    id: "run-a",
    taskId: "task-a",
    projectId: "project-a",
    tenantId: "tenant-a",
    status: "queued",
    candidates: [],
    gates: [],
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    harnessManifest: {
      schemaVersion: 1,
      generatedAt: "2026-07-12T00:00:00.000Z",
      profile: { id: "enterprise", version: "1", digest: "4".repeat(64) },
      task: { taskId: "task-a", projectRoot: "/bound/by-server" },
      specRef: { specSetId: "orders", revision: 1, digest: "5".repeat(64) },
      governanceDigest: "6".repeat(64),
      selectedServices: ["orders"],
      languageByService: { orders: "javascript" },
      policy: {
        requiredGates: ["unit_test"],
        deny: [],
        protectedPaths: [],
        commandAllowlist: ["node"],
        networkAllowlist: [],
        budgets: { maxDurationSeconds: 600 },
        approvalMode: "before-merge"
      },
      executionPolicy: {
        commandAllowlist: ["node"],
        networkAllowlist: [],
        deny: [],
        protectedPaths: []
      },
      context: {
        fragments: [],
        omitted: [],
        usedBytes: 0,
        usedTokens: 0,
        maxBytes: 1,
        maxTokens: 1,
        tokenEstimator: { id: "utf8-byte-upper-bound", version: "1" },
        digest: "7".repeat(64)
      },
      gatePlan: [{
        id: "unit_test",
        runnerId: "unit_test",
        runnerVersion: "1",
        languages: ["javascript"],
        required: true
      }],
      sandbox: {
        backendId: "enterprise-container",
        backendVersion: "1",
        enforcement: "enforced",
        capabilities: [
          "mount-policy",
          "network-policy",
          "resource-limits",
          "secret-injection",
          "tool-allowlist",
          "read-only-root-filesystem"
        ],
        runtimeImage: {
          reference: "node:22-alpine",
          digest: "9".repeat(64)
        }
      },
      stopConditions: { maxDurationSeconds: 600 },
      outputSchema: "mn.run-result.v2",
      digest: "8".repeat(64)
    }
  };
}
