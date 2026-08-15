import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GateArtifactV2, GateResultV2 } from "@mn/core";
import {
  issueAuthoritativeGateReceipt,
  reconcileAuthoritativeGateResults,
  verifyAuthoritativeGateReceipt
} from "../src/authoritativeGateVerification.js";

const key = "authoritative-gate-key-0123456789abcdef0123456789abcdef";
const runtimeProofDigest = "9".repeat(64);

test("authoritative Gate reconciliation accepts exact result semantics and CAS bytes", async (t) => {
  const workspace = await workspaceFixture(t);
  const authority = [
    gate("protected_path", "pass", 0, "protected paths passed", workspace),
    gate("unit", "pass", 0, "unit output", workspace)
  ];
  const reported = authority.map((result, index) => externalize(result, index));
  const result = await reconcileAuthoritativeGateResults({
    reported,
    authoritative: authority,
    resolveReportedArtifact: artifactResolver(reported),
    resolveReportedWorkingDirectory: (value) =>
      value.replace("mn://sandbox/lease-a/workspace", workspace)
  });
  assert.equal(result.valid, true);
  assert.match(result.reportedResultsDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.match(result.authoritativeResultsDigest ?? "", /^[a-f0-9]{64}$/u);
});

test("valid runtime evidence cannot authorize a forged pass, exit code or log", async (t) => {
  const workspace = await workspaceFixture(t);
  const authoritative = [gate("unit", "fail", 1, "real failing test", workspace)];
  const base = externalize(authoritative[0]!, 0);

  const forgedPass = withArtifact({ ...base, status: "pass", exitCode: 0 }, "real failing test");
  assert.match(
    (await reconcile([forgedPass], authoritative, workspace)).reason ?? "",
    /status does not match authoritative/u
  );

  const forgedExit = withArtifact({ ...base, exitCode: 2 }, "real failing test");
  assert.match(
    (await reconcile([forgedExit], authoritative, workspace)).reason ?? "",
    /exitCode does not match authoritative/u
  );

  const forgedLog = withArtifact(base, "fabricated passing log");
  assert.match(
    (await reconcile([forgedLog], authoritative, workspace)).reason ?? "",
    /digest does not match authoritative bytes/u
  );
});

test("worker cannot omit a policy Gate from the complete authoritative plan", async (t) => {
  const workspace = await workspaceFixture(t);
  const authoritative = [
    gate("protected_path", "pass", 0, "protected paths passed", workspace),
    gate("unit", "pass", 0, "unit output", workspace)
  ];
  const reported = [externalize(authoritative[1]!, 1)];
  assert.match(
    (await reconcile(reported, authoritative, workspace)).reason ?? "",
    /result count/u
  );
});

test("authoritative Gate receipt is domain signed, chain-bound and tamper evident", () => {
  const receipt = issueAuthoritativeGateReceipt(
    receiptBinding(),
    key,
    "2026-07-12T01:00:00.000Z"
  );
  const verified = verifyAuthoritativeGateReceipt(receipt, key);
  assert.equal(verified.valid, true);
  assert.equal(verified.receipt?.stageAttemptId, "run-a:verification:1");

  const forged = { ...receipt, passed: false };
  assert.match(
    verifyAuthoritativeGateReceipt(forged, key).reason ?? "",
    /content digest mismatch/u
  );
  assert.match(
    verifyAuthoritativeGateReceipt(receipt, `${key}-different`).reason ?? "",
    /signature mismatch/u
  );
});

async function reconcile(
  reported: readonly GateResultV2[],
  authoritative: readonly GateResultV2[],
  workspace: string
) {
  return reconcileAuthoritativeGateResults({
    reported,
    authoritative,
    resolveReportedArtifact: artifactResolver(reported),
    resolveReportedWorkingDirectory: () => workspace
  });
}

function artifactResolver(results: readonly GateResultV2[]) {
  const content = new Map<string, Buffer>();
  for (const result of results) {
    for (const artifact of result.artifacts) {
      // Tests use the log text in summary only for convenience. A forged
      // artifact explicitly replaces the hidden byte fixture below.
      const bytes = Buffer.from(
        (artifact as GateArtifactV2 & { __testContent?: string }).__testContent ??
          (result.gateId === "unit" && result.status === "fail"
            ? "real failing test"
            : result.gateId === "unit"
              ? "unit output"
              : "protected paths passed"),
        "utf8"
      );
      content.set(artifact.handle ?? artifact.id, bytes);
    }
  }
  return async (_gate: GateResultV2, artifact: GateArtifactV2) =>
    content.get(artifact.handle ?? artifact.id);
}

function gate(
  gateId: string,
  status: GateResultV2["status"],
  exitCode: number | null,
  log: string,
  workingDirectory = "/tmp/scratch/workspace"
): GateResultV2 {
  const artifact = gateArtifact(`${gateId}-log`, log);
  return {
    schemaVersion: 2,
    id: `authority-${gateId}`,
    runId: "run-a",
    candidateId: "candidate-a",
    gateId,
    runnerId: gateId,
    runnerVersion: "1",
    required: true,
    status,
    summary: status === "pass" ? `${gateId} passed.` : `${gateId} failed.`,
    specClauseIds: ["acceptance-a"],
    ...(gateId === "unit"
      ? {
          command: { executable: "node", args: ["--test"], display: "node --test" },
          tool: { id: "node", version: "v22.0.0" }
        }
      : { tool: { id: gateId, version: "1" } }),
    workingDirectory,
    exitCode,
    inputDigest: "7".repeat(64),
    outputDigest: "8".repeat(64),
    artifacts: [artifact],
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:00:01.000Z",
    freshUntil: "2026-07-12T01:00:01.000Z",
    sandboxExecution: sandboxExecution()
  };
}

function externalize(value: GateResultV2, index: number): GateResultV2 {
  return {
    ...structuredClone(value),
    id: `reported-${value.gateId}-${index}`,
    workingDirectory: "mn://sandbox/lease-a/workspace",
    artifacts: value.artifacts.map((artifact) => ({
      ...artifact,
      path: undefined,
      handle: `mn://cas/gate-artifacts/00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    }))
  };
}

function withArtifact(value: GateResultV2, content: string): GateResultV2 {
  const artifact = gateArtifact(value.artifacts[0]!.id, content) as GateArtifactV2 & {
    __testContent?: string;
  };
  artifact.handle = value.artifacts[0]!.handle;
  artifact.__testContent = content;
  return { ...value, artifacts: [artifact] };
}

function gateArtifact(id: string, content: string): GateArtifactV2 {
  const bytes = Buffer.from(content, "utf8");
  return {
    id,
    kind: "log",
    contentType: "text/plain; charset=utf-8",
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    path: `mn://authority/${id}`
  };
}

function sandboxExecution() {
  return {
    backendId: "enterprise-container",
    backendVersion: "1",
    leaseId: "lease-a",
    attestationDigest: "1".repeat(64),
    runtimeId: "2".repeat(64),
    runtimeDigest: "3".repeat(64),
    runtimeProof: {
      schemaVersion: 1 as const,
      issuer: "mn-api" as const,
      issuedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T02:00:00.000Z",
      tenantId: "tenant-a",
      runId: "run-a",
      workerId: "worker-a",
      claimDigest: "4".repeat(64),
      attestationDigest: "1".repeat(64),
      runtimeId: "2".repeat(64),
      runtimeDigest: "3".repeat(64),
      digest: runtimeProofDigest,
      signature: "5".repeat(64)
    }
  };
}

function receiptBinding() {
  return {
    tenantId: "tenant-a",
    projectId: "project-a",
    runId: "run-a",
    stageAttemptId: "run-a:verification:1",
    attempt: 1,
    workerId: "worker-a",
    claimDigest: "4".repeat(64),
    leaseId: "lease-a",
    runtimeId: "2".repeat(64),
    runtimeDigest: "3".repeat(64),
    runtimeProofDigest,
    candidateId: "candidate-a",
    workspaceUri: "mn://sandbox/lease-a/run-a--implementation-1-candidate-a",
    diffArtifactDigest: "6".repeat(64),
    projectSnapshotDigest: "7".repeat(64),
    candidateSnapshotDigest: "8".repeat(64),
    specDigest: "a".repeat(64),
    governanceDigest: "b".repeat(64),
    harnessDigest: "c".repeat(64),
    reportedResultsDigest: "d".repeat(64),
    authoritativeResultsDigest: "e".repeat(64),
    passed: true
  };
}

async function workspaceFixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mn-gate-reconcile-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(workspace);
}
