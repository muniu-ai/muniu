import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { AgentTask, Project } from "@mn/core";
import {
  resolveGovernance,
  sha256Canonical,
  type ScopedGovernanceLayer
} from "@mn/governance";
import {
  CapabilityRegistry,
  compileHarnessManifest,
  digestHarnessProfile,
  type HarnessProfile,
  type SandboxBackend
} from "@mn/harness";
import { digestSpecRevision, type SpecRevision } from "@mn/specs";
import {
  DockerAuthoritativeGateAuthority
} from "../src/authoritativeGateVerification.js";
import { measureAuthoritativeLoopWorkspaceDiff } from "../src/loopDiffMeasurement.js";

test("Docker Gate authority executes an API-owned immutable snapshot during swap-and-restore", async (t) => {
  const image = process.env.MN_TEST_SANDBOX_IMAGE ?? "node:22-alpine";
  const imageDigest = await dockerImageDigest(image);
  if (!imageDigest) {
    t.skip("Docker daemon or sandbox image is unavailable");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "mn-authority-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const scratchRoot = join(root, "mn-docker-sandbox-test");
  const candidateRoot = join(scratchRoot, "candidate");
  const authorityRoot = join(root, "authority");
  await mkdir(join(projectRoot, "service"), { recursive: true });
  await mkdir(join(candidateRoot, "service"), { recursive: true });
  await mkdir(authorityRoot);
  await writeFile(join(projectRoot, "service", "a.js"), "export const value = 1;\n");
  await writeFile(join(candidateRoot, "service", "a.js"), "export const value = 2;\n");
  const contract = "openapi: 3.1.0\ninfo:\n  title: Test\n  version: 1.0.0\npaths: {}\n";
  await writeFile(join(projectRoot, "service", "openapi.yaml"), contract);
  await writeFile(join(candidateRoot, "service", "openapi.yaml"), contract);
  const packageJson = `${JSON.stringify({
    scripts: { test: "node --test authority.test.mjs" }
  })}\n`;
  const testSource = [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "test('authority reporter and tool provenance', () => assert.equal(2 + 2, 4));",
    ""
  ].join("\n");
  for (const rootPath of [projectRoot, candidateRoot]) {
    await writeFile(join(rootPath, "service", "package.json"), packageJson);
    await writeFile(join(rootPath, "service", "authority.test.mjs"), testSource);
  }
  const project = projectFixture(projectRoot);
  const spec = approvedSpec();
  const manifest = await harnessFixture({
    projectRoot,
    spec,
    image,
    imageDigest
  });
  const task = taskFixture(project.id, spec, manifest.profile);
  const measured = await measureAuthoritativeLoopWorkspaceDiff({
    projectRoot,
    candidateRoot
  });
  const attestation = leaseFixture(manifest.digest, image, imageDigest);
  const sandboxExecution = executionFixture(attestation, imageDigest);
  const authority = new DockerAuthoritativeGateAuthority({
    snapshotRootParent: authorityRoot
  });

  const execution = authority.execute({
    project,
    task,
    manifest,
    spec,
    candidateRoot: await realpath(candidateRoot),
    runId: "run-a",
    candidateId: "candidate-a",
    changedPaths: ["service/a.js"],
    projectSnapshotDigest: measured.projectSnapshotDigest,
    candidateSnapshotDigest: measured.candidateSnapshotDigest,
    diffArtifact: measured.content,
    sandboxExecution,
    runtime: {
      runtimeId: sandboxExecution.runtimeId,
      runtimeDigest: sandboxExecution.runtimeDigest,
      imageDigest,
      projectRoot: await realpath(projectRoot),
      scratchRoot: await realpath(scratchRoot),
      projectTarget: "/workspace/project",
      scratchTarget: "/workspace/scratch"
    },
    attestation
  });

  await waitForReadOnlyCandidateSnapshot(authorityRoot);
  await writeFile(
    join(candidateRoot, "service", "a.js"),
    "throw new Error('worker swap must not reach authority');\n"
  );
  await delay(100);
  await writeFile(join(candidateRoot, "service", "a.js"), "export const value = 2;\n");

  const result = await execution;
  assert.equal(result.successful, true, JSON.stringify(result.results, null, 2));
  assert.equal(result.results.length, 2);
  assert.equal(result.results.find((gate) => gate.gateId === "protected_path")?.status, "pass");
  const commandGate = result.results.find((gate) => gate.gateId === "unit_test");
  assert.equal(commandGate?.status, "pass", JSON.stringify(commandGate, null, 2));
  assert.equal(commandGate?.tool?.identitySchema, "container-executable-v1");
  assert.match(commandGate?.tool?.resolvedExecutable ?? "", /^\/(?:bin|sbin|usr|opt)\//u);
  assert.match(commandGate?.tool?.contentDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(commandGate?.tool?.imageDigest, imageDigest);
  assert.equal(commandGate?.artifacts[0]?.kind, "junit");
  assert.equal(
    commandGate?.workingDirectory,
    join(await realpath(candidateRoot), "service"),
    "evidence must retain the logical worker workspace without executing there"
  );
  assert.deepEqual(await readdir(authorityRoot), [], "authority snapshot/container must clean up");
});

async function dockerImageDigest(image: string): Promise<string | undefined> {
  return new Promise((resolveDigest) => {
    execFile(
      process.env.MN_DOCKER_BINARY ?? "docker",
      ["image", "inspect", image, "--format", "{{.Id}}"],
      { timeout: 10_000 },
      (error, stdout) => {
        const digest = stdout.trim().replace(/^sha256:/u, "");
        resolveDigest(!error && /^[a-f0-9]{64}$/u.test(digest) ? digest : undefined);
      }
    );
  });
}

async function waitForReadOnlyCandidateSnapshot(parent: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const roots = await readdir(parent);
    for (const root of roots) {
      try {
        const value = await stat(join(parent, root, "candidate"));
        if ((value.mode & 0o777) === 0o555) return;
      } catch {
        // The private copy is still being materialized.
      }
    }
    await delay(10);
  }
  throw new Error("authority did not materialize a read-only candidate snapshot");
}

function projectFixture(rootPath: string): Project {
  return {
    id: "project-a",
    tenantId: "tenant-a",
    name: "Authority isolation",
    rootPath,
    defaultBranch: "main",
    services: [{
      id: "service",
      name: "Service",
      path: "service",
      owners: ["team-a"],
      language: "javascript",
      contracts: [{
        type: "openapi",
        path: join(rootPath, "service", "openapi.yaml")
      }]
    }],
    policyId: "default"
  };
}

function approvedSpec(): SpecRevision {
  const unsigned: Omit<SpecRevision, "digest"> = {
    specSetId: "authority-isolation",
    revision: 1,
    status: "approved",
    source: "native",
    title: "Authority isolation",
    hypothesis: "An immutable authority snapshot prevents worker TOCTOU.",
    outcomes: ["Gate evidence is bound to the measured candidate bytes."],
    nonGoals: ["No production deployment."],
    targetServices: ["service"],
    contracts: {
      interface: {},
      data: { owner: "service" },
      state: { states: ["ready"] },
      permission: { roles: ["developer"] },
      exception: { failure: "fail closed" },
      quality: { deterministic: true },
      observability: { metrics: ["gate_authority_total"] }
    },
    acceptanceCases: [{
      id: "authority-bound",
      kind: "positive",
      title: "Measured bytes are executed",
      given: ["A measured candidate exists."],
      when: "The API executes the Gate plan.",
      then: ["Only the private immutable snapshot is read."],
      targetService: "service"
    }],
    risks: [],
    unknowns: [],
    createdAt: "2026-07-12T00:00:00.000Z",
    createdBy: "owner@example.test",
    approvedAt: "2026-07-12T00:01:00.000Z",
    approvedBy: "reviewer@example.test"
  };
  return { ...unsigned, digest: digestSpecRevision(unsigned) };
}

async function harnessFixture(input: {
  projectRoot: string;
  spec: SpecRevision;
  image: string;
  imageDigest: string;
}) {
  const profileUnsigned: Omit<HarnessProfile, "digest"> = {
    id: "enterprise",
    version: "1",
    sandboxBackendId: "enterprise-container",
    minimumSandboxEnforcement: "enforced",
    requiredSandboxCapabilities: ["filesystem", "network-policy"],
    maxContextBytes: 1024,
    maxContextTokens: 1024,
    failOnMissingRequiredGates: true,
    redactSensitiveContext: true,
    outputSchema: "mn.run-result.v2"
  };
  const profile = {
    ...profileUnsigned,
    digest: digestHarnessProfile(profileUnsigned)
  };
  const workflowRef = {
    id: "governed-increment-v1",
    version: "1",
    digest: "a".repeat(64)
  };
  const layers: ScopedGovernanceLayer[] = [{
    scope: "builtin",
    scopeId: "default",
    source: { id: "builtin/default", version: "1", digest: "b".repeat(64) },
    policy: {
      requiredGates: ["protected_path", "unit_test"],
      protectedPaths: ["protected/**"],
      allowedProviders: ["codex"],
      commandAllowlist: ["node"],
      networkAllowlist: ["proxy.example.test"],
      budgets: { maxDurationSeconds: 120, maxRepairAttempts: 1 },
      approvalMode: "before-merge"
    }
  }];
  const governance = resolveGovernance(layers, {
    now: "2026-07-12T00:02:00.000Z",
    specRef: {
      specSetId: input.spec.specSetId,
      revision: input.spec.revision,
      digest: input.spec.digest!
    },
    workflowRef,
    harnessProfileRef: {
      id: profile.id,
      version: profile.version,
      digest: profile.digest!
    }
  });
  const registry = new CapabilityRegistry();
  registry.registerGateRunner({
    id: "protected_path",
    version: "1",
    languages: ["javascript"],
    async run() {
      return { id: "protected_path", status: "pass", summary: "ok", evidence: [] };
    }
  });
  registry.registerGateRunner({
    id: "unit_test",
    version: "1",
    languages: ["javascript"],
    async run() {
      return { id: "unit_test", status: "pass", summary: "ok", evidence: [] };
    }
  });
  const sandbox: SandboxBackend = {
    id: "enterprise-container",
    version: "1",
    enforcement: "enforced",
    capabilities: ["filesystem", "network-policy", "resource-limits"],
    runtimeImage: { reference: input.image, digest: input.imageDigest },
    async prepare() {
      return { backendId: "enterprise-container", workspacePath: "/workspace" };
    }
  };
  registry.registerSandboxBackend(sandbox);
  return compileHarnessManifest({
    spec: input.spec,
    governance,
    registry,
    context: {
      taskId: "task-a",
      projectRoot: input.projectRoot,
      selectedServices: ["service"],
      languageByService: { service: "javascript" }
    },
    profile,
    now: "2026-07-12T00:03:00.000Z"
  });
}

function taskFixture(
  projectId: string,
  spec: SpecRevision,
  profile: { id: string; version: string; digest: string }
): AgentTask {
  return {
    id: "task-a",
    tenantId: "tenant-a",
    projectId,
    title: "Verify authority isolation",
    intent: "implement",
    targetServices: ["service"],
    prompt: "Apply the approved Spec.",
    acceptanceCriteria: ["Measured bytes are executed"],
    strategy: {
      providers: ["codex"],
      candidates: 1,
      sandbox: "isolated-worktree",
      requiredGates: ["protected_path", "unit_test"],
      humanApproval: "before-merge",
      timeoutSeconds: 120
    },
    createdAt: "2026-07-12T00:00:00.000Z",
    specRef: {
      specSetId: spec.specSetId,
      revision: spec.revision,
      digest: spec.digest!
    },
    workflowRef: {
      id: "governed-increment-v1",
      version: "1",
      digest: "a".repeat(64)
    },
    harnessProfileRef: profile
  };
}

function leaseFixture(harnessDigest: string, image: string, imageDigest: string) {
  return {
    schemaVersion: 1 as const,
    leaseId: "lease-a",
    issuer: "mn-api" as const,
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2099-07-12T00:00:00.000Z",
    runId: "run-a",
    tenantId: "tenant-a",
    workerId: "worker-a",
    harnessDigest,
    requirementsDigest: "4".repeat(64),
    workerCapabilityDigest: "5".repeat(64),
    claimDigest: "6".repeat(64),
    backend: { id: "enterprise-container", version: "1" },
    policy: {
      mounts: [
        { source: "project" as const, target: "/workspace/project", readOnly: true },
        { source: "scratch" as const, target: "/workspace/scratch", readOnly: false }
      ],
      network: { mode: "deny" as const, allowlist: [] },
      resources: { cpu: 1, memoryMb: 256, pids: 64, timeoutSeconds: 120 },
      secretNames: [],
      allowedTools: ["node"],
      readOnlyRootFilesystem: true as const,
      runtimeImage: { reference: image, digest: imageDigest }
    },
    policyDigest: "7".repeat(64),
    digest: "8".repeat(64),
    signature: "9".repeat(64)
  };
}

function executionFixture(
  attestation: ReturnType<typeof leaseFixture>,
  imageDigest: string
) {
  const proofSemantic = {
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
    imageDigest
  };
  return {
    backendId: attestation.backend.id,
    backendVersion: attestation.backend.version,
    leaseId: attestation.leaseId,
    attestationDigest: attestation.digest,
    runtimeId: "2".repeat(64),
    runtimeDigest: "3".repeat(64),
    imageDigest,
    runtimeProof: {
      ...proofSemantic,
      digest: sha256Canonical(proofSemantic),
      signature: "e".repeat(64)
    }
  };
}
