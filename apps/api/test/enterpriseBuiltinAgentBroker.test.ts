// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentExecutionBindingV1,
  EnterpriseBuiltinExecutionStartV1,
  EnterpriseBuiltinExecutionViewV1
} from "@mn/core";
import {
  EnterpriseBuiltinAgentBroker,
  enterpriseBuiltinExecutionId
} from "../src/enterpriseBuiltinAgentBroker.js";

test("enterprise builtin broker binds one session and relays one tool result", async (t) => {
  const broker = new EnterpriseBuiltinAgentBroker();
  t.after(() => broker.dispose());
  const request = startRequest();
  const identity = {
    tenantId: "tenant-1",
    workerId: "worker-1",
    claimDigest: "c".repeat(64)
  };
  const writeTool = broker.toolsForTenant(identity.tenantId)
    .find((tool) => tool.name === "write_file")!;
  const started = await broker.start({
    ...identity,
    request,
    providerId: "provider-1",
    modelId: "model-1",
    executionBinding: request.executionBinding,
    humanApproval: "on-risk",
    execute: async () => {
      const result = await writeTool.execute(
        { path: "src/index.ts", content: "export const ok = true;\n" },
        {
          sessionId: request.sessionId,
          cwd: request.workspacePath
        }
      );
      assert.deepEqual(result, { path: "src/index.ts", bytes: 24 });
      return {
        reason: "completed",
        summary: "completed through broker",
        steps: 2,
        toolCalls: 1
      };
    }
  });
  assert.equal(started.state, "running");
  assert.equal(broker.shouldAutoApprove(identity.tenantId, request.sessionId, "read-only"), true);
  assert.equal(broker.shouldAutoApprove(identity.tenantId, request.sessionId, "side-effecting"), false);

  const delivered = await broker.poll(started.executionId, identity, started.revision, 1_000);
  assert.equal(delivered.toolCall?.name, "write_file");
  assert.equal(delivered.toolCall?.workspacePath, request.workspacePath);

  const redelivered = await broker.poll(started.executionId, identity, delivered.revision, 0);
  assert.equal(redelivered.toolCall?.callId, delivered.toolCall?.callId);
  assert.equal(redelivered.revision, delivered.revision);
  const toolResult = {
    schemaVersion: 1 as const,
    callId: delivered.toolCall!.callId,
    ok: true,
    result: { path: "src/index.ts", bytes: 24 }
  };
  await broker.submitToolResult(started.executionId, identity, toolResult);
  await assert.doesNotReject(
    broker.submitToolResult(started.executionId, identity, toolResult),
    "same committed tool result must be idempotent"
  );

  const completed = await waitForTerminal(broker, started.executionId, identity);
  assert.equal(completed.state, "completed");
  assert.equal(completed.output?.providerId, "provider-1");
  assert.equal(completed.output?.modelId, "model-1");
  assert.equal(completed.output?.toolCalls, 1);
  assert.equal(completed.output?.executionBinding.sessionId, request.sessionId);
});

test("enterprise builtin broker rejects claim rebind and cancels pending tools", async (t) => {
  const broker = new EnterpriseBuiltinAgentBroker();
  t.after(() => broker.dispose());
  const request = startRequest();
  const identity = {
    tenantId: "tenant-1",
    workerId: "worker-1",
    claimDigest: "c".repeat(64)
  };
  const readTool = broker.toolsForTenant(identity.tenantId)
    .find((tool) => tool.name === "read_file")!;
  const started = await broker.start({
    ...identity,
    request,
    providerId: "provider-1",
    modelId: "model-1",
    executionBinding: request.executionBinding,
    humanApproval: "never",
    execute: async () => {
      await readTool.execute(
        { path: "README.md" },
        { sessionId: request.sessionId, cwd: request.workspacePath }
      );
      return { reason: "completed", summary: "unexpected", steps: 1, toolCalls: 1 };
    }
  });
  assert.equal(broker.shouldAutoApprove(identity.tenantId, request.sessionId, "side-effecting"), true);
  const delivered = await broker.poll(started.executionId, identity, 0, 1_000);
  assert.ok(delivered.toolCall);
  await assert.rejects(
    broker.poll(started.executionId, {
      ...identity,
      claimDigest: "d".repeat(64)
    }, delivered.revision, 0),
    /claim binding changed/u
  );
  const cancelled = await broker.cancel(started.executionId, identity);
  assert.equal(cancelled.state, "cancelled");
  const terminal = await broker.poll(started.executionId, identity, cancelled.revision, 0);
  assert.equal(terminal.toolCall, undefined);
});

test("enterprise builtin broker lets a new active claim resume after the old execution stops", async (t) => {
  const broker = new EnterpriseBuiltinAgentBroker();
  t.after(() => broker.dispose());
  const request = startRequest();
  const oldIdentity = {
    tenantId: "tenant-1",
    workerId: "worker-old",
    claimDigest: "c".repeat(64)
  };
  let oldAborted = false;
  await broker.start({
    ...oldIdentity,
    request,
    providerId: "provider-1",
    modelId: "model-1",
    executionBinding: request.executionBinding,
    humanApproval: "never",
    execute: async (_input, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        oldAborted = true;
        resolve({ reason: "cancelled", summary: "reclaimed", steps: 0, toolCalls: 0 });
      }, { once: true });
    })
  });
  const newIdentity = {
    tenantId: "tenant-1",
    workerId: "worker-new",
    claimDigest: "d".repeat(64)
  };
  const reclaimedRequest = {
    ...request,
    sandboxAttestation: {
      ...request.sandboxAttestation,
      workerId: newIdentity.workerId,
      claimDigest: newIdentity.claimDigest
    }
  };
  const reclaimed = await broker.start({
    ...newIdentity,
    request: reclaimedRequest,
    providerId: "provider-1",
    modelId: "model-1",
    executionBinding: request.executionBinding,
    humanApproval: "never",
    execute: async () => ({
      reason: "completed",
      summary: "resumed",
      steps: 1,
      toolCalls: 0
    })
  });
  assert.equal(oldAborted, true);
  assert.equal(reclaimed.executionId, enterpriseExecutionIdForTest(request));
  assert.equal(
    (await waitForTerminal(broker, reclaimed.executionId, newIdentity)).state,
    "completed"
  );
});

async function waitForTerminal(
  broker: EnterpriseBuiltinAgentBroker,
  executionId: string,
  identity: { tenantId: string; workerId: string; claimDigest: string }
): Promise<EnterpriseBuiltinExecutionViewV1> {
  let revision = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const view = await broker.poll(executionId, identity, revision, 100);
    if (view.state !== "running") return view;
    revision = view.revision;
  }
  throw new Error("broker execution did not finish");
}

function startRequest(): EnterpriseBuiltinExecutionStartV1 {
  const binding: AgentExecutionBindingV1 = {
    schemaVersion: 1,
    runId: "run-1",
    candidateId: "builtin-1",
    sessionId: "agent-session-1",
    runtimeId: "builtin",
    providerId: "provider-1",
    modelId: "model-1",
    harnessDigest: "a".repeat(64),
    governanceDigest: "b".repeat(64),
    effectPolicyDigest: "e".repeat(64),
    sandboxCapabilityId: "isolated-worktree"
  };
  return {
    schemaVersion: 1,
    sessionId: binding.sessionId,
    runId: binding.runId,
    candidateId: binding.candidateId,
    workspacePath: "/workspace/scratch/candidates/builtin-1",
    prompt: "repair the fixture",
    providerId: "provider-1",
    modelId: "model-1",
    timeoutSeconds: 60,
    executionBinding: binding,
    sandboxAttestation: {
      schemaVersion: 1,
      leaseId: "sandbox-1",
      issuer: "mn-api",
      issuedAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-21T00:00:00.000Z",
      runId: binding.runId,
      tenantId: "tenant-1",
      workerId: "worker-1",
      harnessDigest: binding.harnessDigest,
      requirementsDigest: "f".repeat(64),
      workerCapabilityDigest: "1".repeat(64),
      claimDigest: "c".repeat(64),
      backend: { id: "enterprise-container", version: "1" },
      policy: {
        mounts: [],
        network: { mode: "deny", allowlist: [] },
        resources: { cpu: 1, memoryMb: 512, pids: 64, timeoutSeconds: 60 },
        secretNames: [],
        allowedTools: ["node"],
        readOnlyRootFilesystem: true,
        runtimeImage: { reference: "example.invalid/muniu", digest: "2".repeat(64) }
      },
      policyDigest: "3".repeat(64),
      digest: "4".repeat(64),
      signature: "5".repeat(64)
    },
    sandboxExecution: {
      backendId: "enterprise-container",
      backendVersion: "1",
      leaseId: "sandbox-1",
      attestationDigest: "4".repeat(64),
      runtimeId: "6".repeat(64),
      runtimeDigest: "7".repeat(64),
      imageDigest: "2".repeat(64),
      runtimeProof: {
        schemaVersion: 1,
        issuer: "mn-api",
        issuedAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2026-08-21T00:00:00.000Z",
        tenantId: "tenant-1",
        runId: binding.runId,
        workerId: "worker-1",
        claimDigest: "c".repeat(64),
        attestationDigest: "4".repeat(64),
        runtimeId: "6".repeat(64),
        runtimeDigest: "7".repeat(64),
        imageDigest: "2".repeat(64),
        digest: "8".repeat(64),
        signature: "9".repeat(64)
      }
    }
  };
}

function enterpriseExecutionIdForTest(request: EnterpriseBuiltinExecutionStartV1): string {
  return enterpriseBuiltinExecutionId("tenant-1", request);
}
