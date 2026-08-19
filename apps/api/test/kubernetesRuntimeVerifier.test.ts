import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { V1Pod } from "@kubernetes/client-node";
import type { SandboxLeaseAttestation } from "@mn/harness";
import { sha256Canonical } from "@mn/governance";
import {
  buildKubernetesSandboxPod,
  createWorkspaceSnapshot,
  kubernetesLeaseDirectoryName,
  kubernetesSandboxRuntimeId,
  materializeWorkspaceSnapshot
} from "@mn/worker";
import { KubernetesRuntimeVerifier } from "../src/kubernetesRuntimeVerifier.js";

test("Kubernetes runtime verifier resolves Pod and PVC paths through API authority", async (t) => {
  const shared = await mkdtemp(join(tmpdir(), "mn-kube-authority-"));
  t.after(() => rm(shared, { recursive: true, force: true }));
  const lease = attestation();
  const source = join(shared, "source");
  await mkdir(source);
  await writeFile(join(source, "index.mjs"), "export default 1;\n");
  const snapshot = await createWorkspaceSnapshot(source);
  const sourceDigest = snapshot.digest;
  const leaseRoot = join(shared, kubernetesLeaseDirectoryName(lease));
  await mkdir(leaseRoot, { recursive: true });
  await materializeWorkspaceSnapshot(snapshot.content, join(leaseRoot, "project"), sourceDigest);
  await mkdir(join(leaseRoot, "scratch"));
  const configuration = {
    namespace: "muniu-system",
    sharedVolumeClaimName: "muniu-sandbox-workspaces",
    sharedWorkspaceRoot: shared,
    serviceAccountName: "muniu-candidate",
    runtimeClassName: "muniu-sandbox"
  };
  const pod = readyPod(buildKubernetesSandboxPod({
    attestation: lease,
    configuration,
    sourceSnapshotDigest: sourceDigest
  }), lease.policy.runtimeImage!.digest);
  const verifier = new KubernetesRuntimeVerifier({
    ...configuration,
    reader: { read: async () => structuredClone(pod) }
  });
  const runtimeId = kubernetesSandboxRuntimeId(
    configuration.namespace,
    pod.metadata!.name!
  );
  const verified = await verifier.verify({
    runtimeId,
    attestation: lease,
    projectRoot: "/untrusted-worker-path",
    sourceSnapshotDigest: sourceDigest
  });
  assert.equal(verified.runtimeId, runtimeId);
  assert.equal(verified.projectRoot, await realpath(join(leaseRoot, "project")));
  assert.equal(verified.scratchRoot, await realpath(join(leaseRoot, "scratch")));
  assert.equal(verified.imageDigest, lease.policy.runtimeImage!.digest);
  assert.match(verified.runtimeDigest, /^[a-f0-9]{64}$/u);

  await assert.rejects(
    verifier.verify({
      runtimeId,
      attestation: lease,
      projectRoot: "/ignored",
      sourceSnapshotDigest: "8".repeat(64)
    }),
    /does not match the queue binding/u
  );

  await writeFile(join(leaseRoot, "project", "index.mjs"), "export default 2;\n");
  await assert.rejects(
    verifier.verify({
      runtimeId,
      attestation: lease,
      projectRoot: "/ignored",
      sourceSnapshotDigest: sourceDigest
    }),
    /source bytes do not match/u
  );
});

function readyPod(pod: V1Pod, digest: string): V1Pod {
  pod.metadata = { ...pod.metadata, uid: "00000000-0000-4000-8000-000000000001" };
  pod.spec = { ...pod.spec, nodeName: "kind-control-plane" } as V1Pod["spec"];
  pod.status = {
    phase: "Running",
    containerStatuses: [{
      name: "candidate",
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

function attestation(): SandboxLeaseAttestation {
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
    runtimeImage: { reference: "ghcr.io/muniu-ai/muniu-sandbox:0.1.0", digest: "7".repeat(64) }
  };
  const semantic = {
    schemaVersion: 1 as const,
    leaseId: "sandbox-lease-kubernetes-api-1",
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
