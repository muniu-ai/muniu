// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Canonical } from "../packages/governance/dist/index.js";
import {
  DefaultKubernetesPodControl,
  KubernetesSandboxPodBackend,
  createWorkspaceSnapshot,
  kubernetesSandboxPodName,
  verifyKubernetesSandboxPod
} from "../apps/worker/dist/index.js";

const imageDigest = requiredDigest(process.env.MN_KIND_IMAGE_DIGEST);
const image = process.env.MN_KIND_IMAGE ?? "muniu-kind:ci";
const imagePullPolicy = process.env.MN_KIND_IMAGE_PULL_POLICY ?? "IfNotPresent";
assert.ok(
  ["Always", "IfNotPresent", "Never"].includes(imagePullPolicy),
  "MN_KIND_IMAGE_PULL_POLICY must be Always, IfNotPresent, or Never"
);
const namespace = process.env.MN_KIND_NAMESPACE ?? "muniu-kind";
const sharedWorkspaceRoot = process.env.MN_KIND_SHARED_ROOT ?? "/work/sandboxes";
const sharedVolumeClaimName = process.env.MN_KIND_SHARED_PVC ?? "muniu-kind-sandboxes";
const serviceAccountName = process.env.MN_KIND_CANDIDATE_SERVICE_ACCOUNT ?? "muniu-candidate";
const runtimeClassName = process.env.MN_KIND_RUNTIME_CLASS ?? "muniu-sandbox";
const kubernetesApiHost = requiredHost(process.env.KUBERNETES_SERVICE_HOST);
const source = await mkdtemp(join(tmpdir(), "mn-kind-source-"));
const control = new DefaultKubernetesPodControl();

try {
  await mkdir(join(source, "src"));
  await writeFile(join(source, "src", "index.mjs"), "export const probe = true;\n");
  const snapshot = await createWorkspaceSnapshot(source);
  const attestation = lease(image, imageDigest);
  const configuration = {
    namespace,
    sharedVolumeClaimName,
    sharedWorkspaceRoot,
    serviceAccountName,
    runtimeClassName,
    imagePullPolicy
  };
  const backend = new KubernetesSandboxPodBackend({
    image,
    attestation,
    expected: {
      runId: attestation.runId,
      tenantId: attestation.tenantId,
      workerId: attestation.workerId,
      harnessDigest: attestation.harnessDigest
    },
    sourceSnapshot: snapshot,
    ...configuration,
    control,
    runtimeProofAuthority: async ({ runtimeId }) => {
      const pod = await control.read(namespace, kubernetesSandboxPodName(attestation));
      const verified = verifyKubernetesSandboxPod(pod, {
        attestation,
        configuration,
        sourceSnapshotDigest: snapshot.digest
      });
      assert.equal(runtimeId, verified.runtimeId);
      const issuedAt = new Date().toISOString();
      const semantic = {
        schemaVersion: 1,
        issuer: "mn-api",
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + 300_000).toISOString(),
        tenantId: attestation.tenantId,
        runId: attestation.runId,
        workerId: attestation.workerId,
        claimDigest: attestation.claimDigest,
        attestationDigest: attestation.digest,
        runtimeId,
        runtimeDigest: verified.runtimeDigest,
        imageDigest
      };
      return {
        ...semantic,
        digest: sha256Canonical(semantic),
        signature: "f".repeat(64)
      };
    }
  });

  let leaseId;
  try {
    const prepared = await backend.prepare({
      projectRoot: "/untrusted-host-path",
      taskId: "kind-sandbox-probe",
      commandAllowlist: ["node"],
      networkAllowlist: []
    });
    leaseId = prepared.leaseId;
    assert.ok(leaseId);
    assert.equal(
      await readFile(join(backend.sourceRoot(leaseId), "src", "index.mjs"), "utf8"),
      "export const probe = true;\n"
    );

    const write = await backend.execute(leaseId, {
      executable: "node",
      args: ["-e", "require('node:fs').writeFileSync('probe.txt','sandbox-ok\\n')"],
      cwd: backend.workspaceRoot(leaseId),
      timeoutSeconds: 10
    });
    assert.equal(write.exitCode, 0, write.stderr);
    assert.equal(
      await readFile(join(backend.workspaceRoot(leaseId), "probe.txt"), "utf8"),
      "sandbox-ok\n"
    );

    const token = await backend.execute(leaseId, {
      executable: "node",
      args: [
        "-e",
        "process.exit(require('node:fs').existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')?9:0)"
      ],
      cwd: backend.workspaceRoot(leaseId),
      timeoutSeconds: 10
    });
    assert.equal(token.exitCode, 0, "candidate Pod unexpectedly received a Kubernetes token");

    const pids = await backend.execute(leaseId, {
      executable: "node",
      args: [
        "-e",
        "process.stdout.write(require('node:fs').readFileSync('/sys/fs/cgroup/pids.max','utf8'))"
      ],
      cwd: backend.workspaceRoot(leaseId),
      timeoutSeconds: 10
    });
    assert.equal(pids.exitCode, 0, pids.stderr);
    assert.equal(
      pids.stdout.trim(),
      String(attestation.policy.resources.pids),
      "candidate Pod cgroup PID limit does not match its attestation"
    );

    const network = await backend.execute(leaseId, {
      executable: "node",
      args: [
        "-e",
        [
          `const socket=require('node:net').connect(443,${JSON.stringify(kubernetesApiHost)});`,
          "socket.setTimeout(3000);",
          "socket.on('connect',()=>process.exit(9));",
          "socket.on('error',()=>process.exit(0));",
          "socket.on('timeout',()=>process.exit(0));"
        ].join("")
      ],
      cwd: backend.workspaceRoot(leaseId),
      timeoutSeconds: 8
    });
    assert.equal(network.exitCode, 0, "candidate Pod unexpectedly reached the Kubernetes API");

    console.log(JSON.stringify({
      kindSandboxProbe: "passed",
      runtimeId: backend.executionEvidence(leaseId).runtimeId,
      sourceSnapshotDigest: snapshot.digest,
      tokenMounted: false,
      pidsLimit: attestation.policy.resources.pids,
      kubernetesApiReachable: false
    }));
  } finally {
    if (leaseId) await backend.release(leaseId);
  }
} finally {
  await rm(source, { recursive: true, force: true });
}

function lease(reference, digest) {
  const policy = {
    mounts: [
      { source: "project", target: "/workspace/project", readOnly: true },
      { source: "scratch", target: "/workspace/scratch", readOnly: false }
    ],
    network: { mode: "deny", allowlist: [] },
    resources: { cpu: 1, memoryMb: 512, pids: 256, timeoutSeconds: 120 },
    secretNames: [],
    allowedTools: ["node"],
    readOnlyRootFilesystem: true,
    runtimeImage: { reference, digest }
  };
  const semantic = {
    schemaVersion: 1,
    leaseId: "kind-sandbox-probe-lease",
    issuer: "mn-api",
    issuedAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2099-08-20T00:00:00.000Z",
    runId: "kind-sandbox-probe-run",
    tenantId: "kind-sandbox-probe-tenant",
    workerId: "kind-sandbox-probe-worker",
    harnessDigest: "a".repeat(64),
    requirementsDigest: "b".repeat(64),
    workerCapabilityDigest: "c".repeat(64),
    claimDigest: "d".repeat(64),
    backend: { id: "enterprise-container", version: "1" },
    policy,
    policyDigest: sha256Canonical(policy)
  };
  return { ...semantic, digest: sha256Canonical(semantic), signature: "e".repeat(64) };
}

function requiredDigest(value) {
  const normalized = value?.replace(/^sha256:/u, "");
  if (!normalized || !/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error("MN_KIND_IMAGE_DIGEST must be a sha256 digest");
  }
  return normalized;
}

function requiredHost(value) {
  if (!value || !/^[A-Za-z0-9.:-]+$/u.test(value)) {
    throw new Error("KUBERNETES_SERVICE_HOST must be a literal API host");
  }
  return value;
}
