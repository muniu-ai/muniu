import assert from "node:assert/strict";
import test from "node:test";
import type { V1Pod } from "@kubernetes/client-node";
import { sha256Canonical } from "@mn/governance";
import type { SandboxExecutionEvidence, SandboxLeaseAttestation } from "@mn/harness";
import type { AuthoritativeGateExecutionInput } from "../src/authoritativeGateVerification.js";
import {
  buildKubernetesAuthoritativeGatePod,
  verifyKubernetesAuthoritativeGatePod
} from "../src/kubernetesAuthoritativeGateAuthority.js";

test("Kubernetes Gate authority Pod is immutable, tokenless and digest-pinned", () => {
  const attestation = lease();
  const sandboxExecution = execution(attestation);
  const input = {
    attestation,
    sandboxExecution,
    candidateSnapshotDigest: "9".repeat(64)
  } as unknown as AuthoritativeGateExecutionInput;
  const configuration = {
    namespace: "muniu-system",
    sharedVolumeClaimName: "muniu-sandbox-workspaces",
    sharedWorkspaceRoot: "/work/sandboxes",
    serviceAccountName: "muniu-candidate",
    runtimeClassName: "muniu-sandbox"
  };
  const manifest = buildKubernetesAuthoritativeGatePod({
    input,
    configuration,
    directoryName: "authority-" + "a".repeat(40),
    podName: "mn-gate-" + "a".repeat(32)
  });
  const pod = ready(structuredClone(manifest), attestation.policy.runtimeImage!.digest);

  assert.equal(pod.spec?.automountServiceAccountToken, false);
  assert.equal(pod.spec?.containers.length, 1);
  assert.equal(pod.spec?.containers[0]?.securityContext?.readOnlyRootFilesystem, true);
  assert.equal(pod.spec?.containers[0]?.resources?.requests?.cpu, "250m");
  assert.equal(pod.spec?.containers[0]?.resources?.limits?.cpu, "1");
  assert.deepEqual(pod.spec?.containers[0]?.securityContext?.capabilities?.drop, ["ALL"]);
  assert.equal(pod.spec?.containers[0]?.volumeMounts?.filter((mount) => mount.name === "workspace").every((mount) => mount.readOnly), true);
  assert.equal(pod.spec?.volumes?.some((volume) => volume.hostPath), false);
  assert.doesNotThrow(() => verifyKubernetesAuthoritativeGatePod(pod, manifest, input));

  pod.spec!.containers.push({ name: "sidecar", image: "busybox:latest" });
  assert.throws(
    () => verifyKubernetesAuthoritativeGatePod(pod, manifest, input),
    /security inspection|specification drifted/u
  );
});

function ready(pod: V1Pod, digest: string): V1Pod {
  pod.spec = { ...pod.spec, nodeName: "kind-control-plane" } as V1Pod["spec"];
  pod.status = {
    phase: "Running",
    containerStatuses: [{
      name: "authority",
      image: pod.spec?.containers[0]?.image ?? "",
      imageID: `containerd://sandbox@sha256:${digest}`,
      containerID: "containerd://" + "8".repeat(64),
      ready: true,
      restartCount: 0,
      started: true,
      state: { running: { startedAt: new Date() } }
    }]
  };
  return pod;
}

function lease(): SandboxLeaseAttestation {
  const policy = {
    mounts: [
      { source: "project" as const, target: "/workspace/project", readOnly: true as const },
      { source: "scratch" as const, target: "/workspace/scratch", readOnly: false as const }
    ],
    network: { mode: "deny" as const, allowlist: [] },
    resources: { cpu: 1, memoryMb: 512, pids: 64, timeoutSeconds: 120 },
    secretNames: [],
    allowedTools: ["node"],
    readOnlyRootFilesystem: true as const,
    runtimeImage: {
      reference: "ghcr.io/muniu-ai/muniu-sandbox:0.1.0",
      digest: "7".repeat(64)
    }
  };
  const semantic = {
    schemaVersion: 1 as const,
    leaseId: "sandbox-lease-kubernetes-authority-1",
    issuer: "mn-api" as const,
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2099-07-12T00:00:00.000Z",
    runId: "run-1",
    tenantId: "tenant-1",
    workerId: "worker-1",
    harnessDigest: "a".repeat(64),
    requirementsDigest: "b".repeat(64),
    workerCapabilityDigest: "c".repeat(64),
    claimDigest: "d".repeat(64),
    backend: { id: "enterprise-container", version: "1" },
    policy,
    policyDigest: sha256Canonical(policy)
  };
  return { ...semantic, digest: sha256Canonical(semantic), signature: "f".repeat(64) };
}

function execution(attestation: SandboxLeaseAttestation): SandboxExecutionEvidence {
  const semantic = {
    schemaVersion: 1 as const,
    issuer: "mn-api" as const,
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2099-07-12T00:00:00.000Z",
    tenantId: attestation.tenantId,
    runId: attestation.runId,
    workerId: attestation.workerId,
    claimDigest: attestation.claimDigest,
    attestationDigest: attestation.digest,
    runtimeId: "2".repeat(64),
    runtimeDigest: "3".repeat(64),
    imageDigest: attestation.policy.runtimeImage!.digest
  };
  return {
    backendId: attestation.backend.id,
    backendVersion: attestation.backend.version,
    leaseId: attestation.leaseId,
    attestationDigest: attestation.digest,
    runtimeId: semantic.runtimeId,
    runtimeDigest: semantic.runtimeDigest,
    imageDigest: semantic.imageDigest,
    runtimeProof: {
      ...semantic,
      digest: sha256Canonical(semantic),
      signature: "e".repeat(64)
    }
  };
}
