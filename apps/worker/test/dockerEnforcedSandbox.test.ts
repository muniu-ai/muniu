import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SandboxLeaseAttestation } from "@mn/harness";
import { DockerEnforcedSandboxBackend } from "../src/index.js";

test("Docker backend refuses to self-certify without a runtime proof authority", () => {
  const leaseAttestation = attestation(
    "node:22-alpine",
    "1".repeat(64)
  );
  assert.throws(
    () => new DockerEnforcedSandboxBackend({
      image: "node:22-alpine",
      attestation: leaseAttestation,
      expected: {
        runId: "run-1",
        tenantId: "tenant-1",
        workerId: "worker-1",
        harnessDigest: "a".repeat(64)
      }
    }),
    /runtime proof authority/u
  );
});

test("Docker backend executes inside a read-only, resource-limited, network-denied lease", async (t) => {
  if (!(await dockerAvailable())) {
    t.skip("Docker daemon is unavailable");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "mn-docker-sandbox-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "probe.mjs"), [
    "import { writeFile } from 'node:fs/promises';",
    "await writeFile('/workspace/project/forbidden.txt', 'x').then(",
    "  () => process.exit(91),",
    "  () => console.log(JSON.stringify({ cwd: process.cwd(), marker: process.env.MN_ALLOWED }))",
    ");"
  ].join("\n"), "utf8");

  const authorityCalls: string[] = [];
  const image = process.env.MN_TEST_SANDBOX_IMAGE ?? "node:22-alpine";
  const imageDigest = await inspectImageDigest(image);
  const leaseAttestation = attestation(image, imageDigest);
  const backend = new DockerEnforcedSandboxBackend({
    image,
    attestation: leaseAttestation,
    expected: {
      runId: "run-1",
      tenantId: "tenant-1",
      workerId: "worker-1",
      harnessDigest: "a".repeat(64)
    },
    runtimeProofAuthority: async ({ attestation: value, runtimeId }) => {
      authorityCalls.push(runtimeId);
      assert.equal(value.digest, leaseAttestation.digest);
      return runtimeProof(value, runtimeId);
    }
  });
  const prepared = await backend.prepare({
    projectRoot: root,
    taskId: "task-1",
    commandAllowlist: ["node"]
  });
  t.after(() => backend.release(prepared.leaseId!));

  const evidence = backend.executionEvidence(prepared.leaseId!);
  assert.equal(evidence.attestationDigest, leaseAttestation.digest);
  assert.equal(evidence.imageDigest, imageDigest);
  assert.match(evidence.runtimeDigest, /^[a-f0-9]{64}$/u);
  assert.match(evidence.runtimeId, /^[a-f0-9]{64}$/u);
  assert.equal(authorityCalls.length, 1);
  assert.equal(evidence.runtimeProof.runtimeId, evidence.runtimeId);
  assert.equal(evidence.runtimeProof.runtimeDigest, evidence.runtimeDigest);

  const gateExecutor = backend.gateCommandExecutor(prepared.leaseId!);
  const toolIdentity = await gateExecutor.resolveToolIdentity!("node", root);
  assert.equal(toolIdentity.requestedExecutable, "node");
  assert.match(toolIdentity.resolvedExecutable, /^\/(?:bin|sbin|usr|opt)\//u);
  assert.match(toolIdentity.contentDigest, /^[a-f0-9]{64}$/u);
  assert.equal(toolIdentity.imageDigest, imageDigest);
  const identityBoundExecution = await gateExecutor.execute({
    executable: toolIdentity.resolvedExecutable,
    args: ["--version"],
    cwd: root,
    timeoutSeconds: 30,
    runId: "run-1",
    candidateId: "candidate-1"
  });
  assert.equal(identityBoundExecution.exitCode, 0, identityBoundExecution.stderr);
  assert.match(identityBoundExecution.stdout, /^v\d+/u);

  await assert.rejects(
    backend.execute(prepared.leaseId!, {
      executable: "/workspace/scratch/node",
      args: ["--version"],
      cwd: root,
      timeoutSeconds: 30
    }),
    /bare executable|trusted runtime|resolved/u
  );

  const result = await backend.execute(prepared.leaseId!, {
    executable: "node",
    args: ["probe.mjs"],
    cwd: root,
    timeoutSeconds: 30,
    env: { MN_ALLOWED: "yes" }
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /"cwd":"\/workspace\/project"/u);
  assert.match(result.stdout, /"marker":"yes"/u);

  const scratchRoot = backend.workspaceRoot(prepared.leaseId!);
  assert.equal(
    backend.containerPath(prepared.leaseId!, scratchRoot),
    "/workspace/scratch"
  );
  const writable = await backend.execute(prepared.leaseId!, {
    executable: "node",
    args: [
      "-e",
      "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('node:fs').writeFileSync('candidate.txt',s);console.log(process.cwd())})"
    ],
    cwd: scratchRoot,
    timeoutSeconds: 30,
    stdin: "sandbox candidate bytes"
  });
  assert.equal(writable.exitCode, 0, writable.stderr);
  assert.match(writable.stdout, /\/workspace\/scratch/u);
  assert.equal(
    await readFile(join(scratchRoot, "candidate.txt"), "utf8"),
    "sandbox candidate bytes"
  );

  const deniedNetwork = await backend.execute(prepared.leaseId!, {
    executable: "node",
    args: [
      "-e",
      "fetch('http://example.com').then(()=>process.exit(90)).catch(()=>process.exit(42))"
    ],
    cwd: root,
    timeoutSeconds: 30
  });
  assert.equal(deniedNetwork.exitCode, 42, deniedNetwork.stderr);

  await assert.rejects(
    backend.execute(prepared.leaseId!, {
      executable: "sh",
      args: ["-c", "true"],
      cwd: root,
      timeoutSeconds: 30
    }),
    /not allowed by sandbox lease/u
  );
  await assert.rejects(
    backend.execute(prepared.leaseId!, {
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: "/etc",
      timeoutSeconds: 30
    }),
    /outside the leased project mount/u
  );
  await assert.rejects(
    backend.execute(prepared.leaseId!, {
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: root,
      timeoutSeconds: 30,
      env: { UNAUTHORIZED_SECRET: "do-not-inject" },
      secretNames: ["UNAUTHORIZED_SECRET"]
    }),
    /secret UNAUTHORIZED_SECRET is not allowed/u
  );
});

function attestation(
  imageReference: string,
  imageDigest: string
): SandboxLeaseAttestation {
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
      reference: imageReference,
      digest: imageDigest
    }
  };
  const semantic = {
    schemaVersion: 1 as const,
    leaseId: "sandbox-lease-1",
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
  return {
    ...semantic,
    digest: sha256Canonical(semantic),
    signature: "f".repeat(64)
  };
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
  return {
    ...semantic,
    digest: sha256Canonical(semantic),
    signature: "f".repeat(64)
  };
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

async function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5_000 }, (error) => {
      resolve(!error);
    });
  });
}

async function inspectImageDigest(image: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["image", "inspect", image, "--format", "{{.Id}}"],
      { timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`docker image inspect failed: ${stderr || error.message}`));
          return;
        }
        const digest = stdout.trim().replace(/^sha256:/u, "");
        if (!/^[a-f0-9]{64}$/u.test(digest)) {
          reject(new Error("docker image inspect returned an invalid content digest"));
          return;
        }
        resolve(digest);
      }
    );
  });
}
