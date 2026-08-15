import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxExecutionEvidence } from "@mn/harness";
import { sha256Canonical } from "@mn/governance";
import {
  GateRegistryV2,
  runGateEngineV2,
  validateGateResultV2Integrity,
  type GateCommandExecutor
} from "../src/index.js";

test("Gate V2 uses the leased command executor and binds inspected sandbox evidence", async () => {
  const imageDigest = "9".repeat(64);
  const calls: Array<{ executable: string; cwd: string }> = [];
  const proofSemantic = {
    schemaVersion: 1 as const,
    issuer: "mn-api" as const,
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-12T00:05:00.000Z",
    tenantId: "tenant-1",
    runId: "run-1",
    workerId: "worker-1",
    claimDigest: "d".repeat(64),
    attestationDigest: "a".repeat(64),
    runtimeId: "b".repeat(64),
    runtimeDigest: "c".repeat(64),
    imageDigest
  };
  const execution: SandboxExecutionEvidence = {
    backendId: "enterprise-container",
    backendVersion: "1",
    leaseId: "sandbox-lease",
    attestationDigest: "a".repeat(64),
    runtimeId: "b".repeat(64),
    runtimeDigest: "c".repeat(64),
    imageDigest,
    runtimeProof: {
      ...proofSemantic,
      digest: sha256Canonical(proofSemantic),
      signature: "f".repeat(64)
    }
  };
  const executor: GateCommandExecutor = {
    id: "docker/exec",
    version: "1",
    sandboxExecution: execution,
    async resolveToolIdentity(executable) {
      return {
        schemaVersion: 1,
        requestedExecutable: executable,
        resolvedExecutable: "/opt/mn/tools/container-only-tool",
        contentDigest: "e".repeat(64),
        imageDigest
      };
    },
    async execute(request) {
      calls.push({ executable: request.executable, cwd: request.cwd });
      return { exitCode: 0, stdout: "inside-container\n", stderr: "" };
    },
    async probeVersion() {
      return "container-only-tool 1.2.3";
    }
  };
  const registry = new GateRegistryV2();
  registry.register({
    id: "container-runner",
    version: "1",
    gateIds: ["unit_test"],
    languages: ["javascript"],
    resolveCommand() {
      return {
        executable: "container-only-tool",
        args: ["test"],
        display: "container-only-tool test",
        versionArgs: ["--version"]
      };
    }
  });

  const [result] = await runGateEngineV2({
    cwd: "/host/project/service",
    gates: [{ id: "unit_test", required: true, language: "javascript" }],
    registry,
    runId: "run-1",
    candidateId: "candidate-1",
    failClosed: true,
    commandAllowlist: ["container-only-tool"],
    commandExecutor: executor
  });

  assert.deepEqual(calls, [{
    executable: "/opt/mn/tools/container-only-tool",
    cwd: "/host/project/service"
  }]);
  assert.equal(result?.status, "pass");
  assert.deepEqual(result?.sandboxExecution, execution);
  assert.equal(result?.tool?.version, "container-only-tool 1.2.3");
  assert.equal(result?.tool?.contentDigest, "e".repeat(64));
  assert.deepEqual(validateGateResultV2Integrity(result), []);
  assert.ok(validateGateResultV2Integrity({
    ...result!,
    tool: { id: result!.tool!.id, version: result!.tool!.version }
  }).some((issue) => /executable content identity/u.test(issue)));
});
