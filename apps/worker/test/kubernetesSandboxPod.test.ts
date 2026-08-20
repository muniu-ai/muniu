import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  V1Capabilities,
  V1Container,
  V1PodSecurityContext,
  V1ResourceRequirements,
  V1SecurityContext,
  V1Volume,
  V1VolumeMount,
  type V1Pod
} from "@kubernetes/client-node";
import type { SandboxLeaseAttestation } from "@mn/harness";
import { sha256Canonical } from "@mn/governance";
import {
  KubernetesSandboxPodBackend,
  buildKubernetesSandboxPod,
  createWorkspaceSnapshot,
  kubernetesSandboxRuntimeId,
  verifyKubernetesSandboxPod,
  type KubernetesPodControl
} from "../src/index.js";

test("Kubernetes backend provisions a digest-pinned, tokenless, network-denied Pod", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "mn-kube-source-"));
  const shared = await mkdtemp(join(tmpdir(), "mn-kube-shared-"));
  t.after(() => Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(shared, { recursive: true, force: true })
  ]));
  await writeFile(join(source, "index.mjs"), "export default 1;\n");
  const snapshot = await createWorkspaceSnapshot(source);
  const lease = attestation();
  const control = new FakePodControl(lease.policy.runtimeImage!.digest);
  const backend = new KubernetesSandboxPodBackend({
    image: lease.policy.runtimeImage!.reference,
    attestation: lease,
    expected: {
      runId: lease.runId,
      tenantId: lease.tenantId,
      workerId: lease.workerId,
      harnessDigest: lease.harnessDigest
    },
    sourceSnapshot: snapshot,
    namespace: "muniu-system",
    sharedVolumeClaimName: "muniu-sandbox-workspaces",
    sharedWorkspaceRoot: shared,
    serviceAccountName: "muniu-candidate",
    runtimeClassName: "muniu-sandbox",
    control,
    runtimeProofAuthority: async ({ runtimeId }) => runtimeProof(lease, runtimeId)
  });

  const prepared = await backend.prepare({
    projectRoot: "/not-mounted-on-the-worker",
    taskId: "task-1",
    commandAllowlist: ["node"]
  });
  assert.equal(prepared.leaseId, lease.leaseId);
  assert.equal(
    await readFile(join(backend.sourceRoot(lease.leaseId), "index.mjs"), "utf8"),
    "export default 1;\n"
  );
  assert.equal(
    await readFile(join(backend.sourceRoot(lease.leaseId), ".mn-source-digest"), "utf8"),
    `${snapshot.digest}\n`
  );
  assert.equal(
    (await stat(join(backend.sourceRoot(lease.leaseId), ".."))).mode & 0o777,
    0o755,
    "candidate uid must be able to traverse the lease directory"
  );

  const pod = control.created!;
  assert.equal(pod.spec?.automountServiceAccountToken, false);
  assert.equal(pod.spec?.serviceAccountName, "muniu-candidate");
  assert.equal(pod.spec?.runtimeClassName, "muniu-sandbox");
  assert.equal(pod.spec?.hostNetwork, false);
  assert.equal(pod.spec?.containers.length, 1);
  assert.equal(pod.spec?.containers[0]?.env?.length, 0);
  assert.equal(pod.spec?.containers[0]?.envFrom?.length, 0);
  assert.equal(pod.spec?.containers[0]?.securityContext?.readOnlyRootFilesystem, true);
  assert.equal(pod.spec?.containers[0]?.resources?.requests?.cpu, "250m");
  assert.equal(pod.spec?.containers[0]?.resources?.limits?.cpu, "1");
  assert.deepEqual(pod.spec?.containers[0]?.securityContext?.capabilities?.drop, ["ALL"]);
  assert.match(pod.spec?.containers[0]?.image ?? "", /@sha256:[a-f0-9]{64}$/u);
  assert.equal(
    pod.spec?.volumes?.some((volume) => volume.hostPath !== undefined),
    false
  );
  assert.equal(
    pod.metadata?.annotations?.["muniu.ai/network-policy"],
    "default-deny"
  );
  assert.equal(
    backend.executionEvidence(lease.leaseId).runtimeId,
    kubernetesSandboxRuntimeId("muniu-system", pod.metadata!.name!)
  );

  const contender = new KubernetesSandboxPodBackend({
    image: lease.policy.runtimeImage!.reference,
    attestation: lease,
    expected: {
      runId: lease.runId,
      tenantId: lease.tenantId,
      workerId: lease.workerId,
      harnessDigest: lease.harnessDigest
    },
    sourceSnapshot: snapshot,
    namespace: "muniu-system",
    sharedVolumeClaimName: "muniu-sandbox-workspaces",
    sharedWorkspaceRoot: shared,
    serviceAccountName: "muniu-candidate",
    runtimeClassName: "muniu-sandbox",
    control,
    runtimeProofAuthority: async ({ runtimeId }) => runtimeProof(lease, runtimeId)
  });
  await assert.rejects(
    contender.prepare({
      projectRoot: "/not-mounted-on-the-worker",
      taskId: "task-1-retry",
      commandAllowlist: ["node"]
    }),
    /EEXIST/u
  );
  assert.equal(
    await readFile(join(backend.sourceRoot(lease.leaseId), "index.mjs"), "utf8"),
    "export default 1;\n",
    "a colliding retry must not delete the active lease directory"
  );

  await backend.release(lease.leaseId);
  assert.deepEqual(control.deleted, [{ namespace: "muniu-system", name: pod.metadata!.name! }]);
});

test("Kubernetes Pod verification rejects hostPath, token and sidecar mutation", () => {
  const lease = attestation();
  const configuration = {
    namespace: "muniu-system",
    sharedVolumeClaimName: "muniu-sandbox-workspaces",
    sharedWorkspaceRoot: "/work/sandboxes",
    serviceAccountName: "muniu-candidate",
    runtimeClassName: "muniu-sandbox"
  };
  const pod = buildKubernetesSandboxPod({
    attestation: lease,
    configuration,
    sourceSnapshotDigest: "9".repeat(64)
  });
  pod.spec!.automountServiceAccountToken = true;
  pod.spec!.volumes!.push({ name: "host", hostPath: { path: "/" } });
  pod.spec!.containers.push({ name: "sidecar", image: "busybox" });

  const control = new FakePodControl(lease.policy.runtimeImage!.digest);
  control.created = readyPod(pod, lease.policy.runtimeImage!.digest);
  assert.throws(
    () => verifyKubernetesSandboxPod(control.created!, {
      attestation: lease,
      configuration,
      sourceSnapshotDigest: "9".repeat(64)
    }),
    /security specification drifted/u
  );
});

test("Kubernetes Pod verification accepts official client model instances", () => {
  const lease = attestation();
  const configuration = {
    namespace: "muniu-system",
    sharedVolumeClaimName: "muniu-sandbox-workspaces",
    sharedWorkspaceRoot: "/work/sandboxes",
    serviceAccountName: "muniu-candidate",
    runtimeClassName: "muniu-sandbox"
  };
  const sourceSnapshotDigest = "9".repeat(64);
  const pod = readyPod(buildKubernetesSandboxPod({
    attestation: lease,
    configuration,
    sourceSnapshotDigest
  }), lease.policy.runtimeImage!.digest);
  const original = pod.spec!.containers[0]!;
  const container = Object.assign(new V1Container(), original);
  container.securityContext = Object.assign(new V1SecurityContext(), original.securityContext);
  container.securityContext.capabilities = Object.assign(
    new V1Capabilities(),
    original.securityContext?.capabilities
  );
  container.resources = Object.assign(new V1ResourceRequirements(), original.resources);
  container.volumeMounts = original.volumeMounts?.map((mount) =>
    Object.assign(new V1VolumeMount(), mount)
  );
  for (const mount of container.volumeMounts ?? []) {
    if (mount.readOnly === false) delete mount.readOnly;
  }
  delete container.env;
  delete container.envFrom;
  delete container.stdin;
  delete container.stdinOnce;
  delete container.tty;
  pod.spec!.containers = [container];
  pod.spec!.securityContext = Object.assign(
    new V1PodSecurityContext(),
    pod.spec!.securityContext
  );
  pod.spec!.volumes = pod.spec!.volumes?.map((volume) => Object.assign(new V1Volume(), volume));
  for (const volume of pod.spec!.volumes ?? []) {
    if (volume.persistentVolumeClaim?.readOnly === false) {
      delete volume.persistentVolumeClaim.readOnly;
    }
  }

  assert.doesNotThrow(() => verifyKubernetesSandboxPod(pod, {
    attestation: lease,
    configuration,
    sourceSnapshotDigest
  }));
});

test("Kubernetes backend preserves bounded Pod readiness diagnostics before cleanup", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "mn-kube-diagnostic-source-"));
  const shared = await mkdtemp(join(tmpdir(), "mn-kube-diagnostic-shared-"));
  t.after(() => Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(shared, { recursive: true, force: true })
  ]));
  await writeFile(join(source, "index.mjs"), "export default 1;\n");
  const snapshot = await createWorkspaceSnapshot(source);
  const lease = attestation();
  const control = new FakePodControl(lease.policy.runtimeImage!.digest, {
    reason: "ContainerCannotRun",
    message: "runtime handler rejected the candidate\nwith a second line"
  });
  const backend = new KubernetesSandboxPodBackend({
    image: lease.policy.runtimeImage!.reference,
    attestation: lease,
    expected: {
      runId: lease.runId,
      tenantId: lease.tenantId,
      workerId: lease.workerId,
      harnessDigest: lease.harnessDigest
    },
    sourceSnapshot: snapshot,
    namespace: "muniu-system",
    sharedVolumeClaimName: "muniu-sandbox-workspaces",
    sharedWorkspaceRoot: shared,
    serviceAccountName: "muniu-candidate",
    runtimeClassName: "muniu-sandbox",
    control,
    runtimeProofAuthority: async ({ runtimeId }) => runtimeProof(lease, runtimeId)
  });

  await assert.rejects(
    backend.prepare({
      projectRoot: "/not-mounted-on-the-worker",
      taskId: "task-diagnostic",
      commandAllowlist: ["node"]
    }),
    /terminal phase Failed: .*ContainerCannotRun.*runtime handler rejected the candidate with a second line/u
  );
  assert.equal(control.deleted.length, 1, "a failed candidate Pod must still be cleaned up");
});

class FakePodControl implements KubernetesPodControl {
  created?: V1Pod;
  readonly deleted: Array<{ namespace: string; name: string }> = [];

  constructor(
    private readonly imageDigest: string,
    private readonly failure?: { readonly reason: string; readonly message: string }
  ) {}

  async create(namespace: string, pod: V1Pod): Promise<V1Pod> {
    assert.equal(namespace, pod.metadata?.namespace);
    this.created = this.failure
      ? failedPod(structuredClone(pod), this.failure)
      : readyPod(structuredClone(pod), this.imageDigest);
    return this.created;
  }

  async read(namespace: string, name: string): Promise<V1Pod> {
    assert.equal(namespace, this.created?.metadata?.namespace);
    assert.equal(name, this.created?.metadata?.name);
    return structuredClone(this.created!);
  }

  async delete(namespace: string, name: string): Promise<void> {
    this.deleted.push({ namespace, name });
  }

  async exec(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

function failedPod(
  pod: V1Pod,
  failure: { readonly reason: string; readonly message: string }
): V1Pod {
  pod.metadata = { ...pod.metadata, uid: "00000000-0000-4000-8000-000000000002" };
  pod.status = {
    phase: "Failed",
    containerStatuses: [{
      name: "candidate",
      image: pod.spec?.containers[0]?.image ?? "",
      imageID: "",
      ready: false,
      restartCount: 0,
      started: false,
      state: {
        terminated: {
          containerID: "containerd://" + "9".repeat(64),
          exitCode: 127,
          finishedAt: new Date(),
          reason: failure.reason,
          message: failure.message,
          startedAt: new Date()
        }
      }
    }]
  };
  return pod;
}

function readyPod(pod: V1Pod, digest: string): V1Pod {
  pod.metadata = { ...pod.metadata, uid: "00000000-0000-4000-8000-000000000001" };
  pod.spec = { ...pod.spec, nodeName: "kind-control-plane" } as V1Pod["spec"];
  pod.status = {
    phase: "Running",
    containerStatuses: [{
      name: "candidate",
      image: pod.spec?.containers[0]?.image ?? "",
      imageID: `docker-pullable://sandbox@sha256:${digest}`,
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
    leaseId: "sandbox-lease-kubernetes-1",
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

function runtimeProof(attestation: SandboxLeaseAttestation, runtimeId: string) {
  const issuedAt = new Date().toISOString();
  const semantic = {
    schemaVersion: 1 as const,
    issuer: "mn-api" as const,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 300_000).toISOString(),
    tenantId: attestation.tenantId,
    runId: attestation.runId,
    workerId: attestation.workerId,
    claimDigest: attestation.claimDigest,
    attestationDigest: attestation.digest,
    runtimeId,
    runtimeDigest: "e".repeat(64),
    imageDigest: attestation.policy.runtimeImage!.digest
  };
  return { ...semantic, digest: sha256Canonical(semantic), signature: "f".repeat(64) };
}
