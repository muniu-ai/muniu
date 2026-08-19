// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentExecutionBindingV1,
  EnterpriseBuiltinExecutionStartV1,
  EnterpriseBuiltinExecutionViewV1
} from "@mn/core";
import {
  CallId,
  CandidateId,
  Digest,
  EventId,
  RunId,
  SessionId,
  createAgentSessionEvent,
  createProtectedTextV1,
  createRuntimeEffectCommitmentBinderV1,
  deriveToolEffectKindV1,
  protectAgentSessionPayloadV1
} from "@mn/agent-protocol";
import { AgentApprovalCoordinator } from "../src/agentApprovalCoordinator.js";
import { EnterprisePostgresRuntime } from "../src/enterprisePostgres.js";
import { EnterpriseBuiltinAgentBroker } from "../src/enterpriseBuiltinAgentBroker.js";
import { EnterpriseBuiltinAgentPersistence } from "../src/enterpriseBuiltinAgentPersistence.js";

const connectionString = process.env.MN_TEST_POSTGRES_URL;

test(
  "PostgreSQL relays one builtin tool call across API replicas and preserves idempotency",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    const persistenceA = new EnterpriseBuiltinAgentPersistence(runtime.pool);
    const persistenceB = new EnterpriseBuiltinAgentPersistence(runtime.pool);
    const brokerA = new EnterpriseBuiltinAgentBroker(persistenceA);
    const brokerB = new EnterpriseBuiltinAgentBroker(persistenceB);
    t.after(async () => {
      await Promise.allSettled([brokerA.dispose(), brokerB.dispose()]);
      await runtime.close();
    });
    await runtime.migrate();
    await persistenceA.migrate();
    await runtime.pool.query(
      "TRUNCATE mn_builtin_agent_approvals, mn_builtin_agent_tool_calls, mn_builtin_agent_executions"
    );

    const identity = {
      tenantId: "tenant-pg-broker",
      workerId: "worker-pg-broker",
      claimDigest: "c".repeat(64)
    };
    const request = startRequest(identity);
    const writeTool = brokerA.toolsForTenant(identity.tenantId)
      .find((tool) => tool.name === "write_file")!;
    let duplicateOwnerRan = false;
    const started = await brokerA.start({
      ...identity,
      request,
      providerId: "provider-pg",
      modelId: "model-pg",
      executionBinding: request.executionBinding,
      humanApproval: "never",
      execute: async () => {
        const result = await writeTool.execute(
          { path: "src/index.ts", content: "export const durable = true;\n" },
          { sessionId: request.sessionId, cwd: request.workspacePath }
        );
        assert.deepEqual(result, { path: "src/index.ts", bytes: 29 });
        return { reason: "completed", summary: "durable", steps: 2, toolCalls: 1 };
      }
    });
    const duplicate = await brokerB.start({
      ...identity,
      request,
      providerId: "provider-pg",
      modelId: "model-pg",
      executionBinding: request.executionBinding,
      humanApproval: "never",
      execute: async () => {
        duplicateOwnerRan = true;
        return { reason: "completed", summary: "wrong owner", steps: 0, toolCalls: 0 };
      }
    });
    assert.equal(duplicate.executionId, started.executionId);
    assert.equal(duplicateOwnerRan, false);

    const delivered = await brokerB.poll(started.executionId, identity, 0, 2_000);
    assert.equal(delivered.toolCall?.name, "write_file");
    const result = {
      schemaVersion: 1 as const,
      callId: delivered.toolCall!.callId,
      ok: true,
      result: { path: "src/index.ts", bytes: 29 }
    };
    await brokerB.submitToolResult(started.executionId, identity, result);
    await brokerB.submitToolResult(started.executionId, identity, result);
    await assert.rejects(
      brokerB.submitToolResult(started.executionId, identity, {
        ...result,
        result: { path: "src/index.ts", bytes: 1 }
      }),
      /conflicts/u
    );
    const completed = await waitForTerminal(brokerB, started.executionId, identity);
    assert.equal(completed.state, "completed");
    assert.equal(completed.output?.summary, "durable");

    const generations = await runtime.pool.query<{ generation: number; state: string }>(`
      SELECT generation,state FROM mn_builtin_agent_executions
      WHERE tenant_id=$1 AND execution_id=$2 ORDER BY generation
    `, [identity.tenantId, started.executionId]);
    assert.deepEqual(generations.rows, [{ generation: 1, state: "completed" }]);
    const retainedToolEvidence = await runtime.pool.query<{
      call_redacted: boolean;
      result_redacted: boolean;
      call_digest: string | null;
      result_digest: string | null;
    }>(`
      SELECT call IS NULL AS call_redacted,result IS NULL AS result_redacted,
             call_digest,result_digest
      FROM mn_builtin_agent_tool_calls
      WHERE tenant_id=$1 AND execution_id=$2 AND generation=1
    `, [identity.tenantId, started.executionId]);
    assert.equal(retainedToolEvidence.rows[0]?.call_redacted, true);
    assert.equal(retainedToolEvidence.rows[0]?.result_redacted, true);
    assert.match(retainedToolEvidence.rows[0]?.call_digest ?? "", /^[a-f0-9]{64}$/u);
    assert.match(retainedToolEvidence.rows[0]?.result_digest ?? "", /^[a-f0-9]{64}$/u);
  }
);

test(
  "PostgreSQL owner relinquish lets another API resume the same durable session",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    const brokerA = new EnterpriseBuiltinAgentBroker(
      new EnterpriseBuiltinAgentPersistence(runtime.pool)
    );
    const brokerB = new EnterpriseBuiltinAgentBroker(
      new EnterpriseBuiltinAgentPersistence(runtime.pool)
    );
    t.after(async () => {
      await Promise.allSettled([brokerA.dispose(), brokerB.dispose()]);
      await runtime.close();
    });
    await runtime.migrate();
    await brokerA.migrate();
    await runtime.pool.query(
      "TRUNCATE mn_builtin_agent_approvals, mn_builtin_agent_tool_calls, mn_builtin_agent_executions"
    );
    const identity = {
      tenantId: "tenant-pg-resume",
      workerId: "worker-pg-resume",
      claimDigest: "d".repeat(64)
    };
    const request = startRequest(identity);
    const writeTool = brokerA.toolsForTenant(identity.tenantId)
      .find((tool) => tool.name === "write_file")!;
    const started = await brokerA.start({
      ...identity,
      request,
      providerId: "provider-pg",
      modelId: "model-pg",
      executionBinding: request.executionBinding,
      humanApproval: "never",
      execute: async () => {
        await writeTool.execute(
          { path: "src/interrupted.ts", content: "unconfirmed\n" },
          { sessionId: request.sessionId, cwd: request.workspacePath }
        );
        return { reason: "completed", summary: "must not complete", steps: 1, toolCalls: 1 };
      }
    });
    const unconfirmed = await brokerB.poll(started.executionId, identity, 0, 2_000);
    assert.equal(unconfirmed.toolCall?.name, "write_file");
    await brokerA.dispose();

    let resumed = false;
    const acquired = await brokerB.start({
      ...identity,
      request,
      providerId: "provider-pg",
      modelId: "model-pg",
      executionBinding: request.executionBinding,
      humanApproval: "never",
      execute: async () => {
        resumed = true;
        return { reason: "completed", summary: "resumed", steps: 1, toolCalls: 0 };
      }
    });
    const terminal = await waitForTerminal(brokerB, acquired.executionId, identity);
    assert.equal(resumed, true);
    assert.equal(terminal.state, "completed");
    assert.equal(terminal.output?.summary, "resumed");
    const generations = await runtime.pool.query<{ generation: number; state: string }>(`
      SELECT generation,state FROM mn_builtin_agent_executions
      WHERE tenant_id=$1 AND execution_id=$2 ORDER BY generation
    `, [identity.tenantId, acquired.executionId]);
    assert.deepEqual(generations.rows, [
      { generation: 1, state: "cancelled" },
      { generation: 2, state: "completed" }
    ]);
    const oldTool = await runtime.pool.query<{
      call_redacted: boolean;
      result_redacted: boolean;
      call_digest: string | null;
      result_digest: string | null;
    }>(`
      SELECT call IS NULL AS call_redacted,result IS NULL AS result_redacted,
             call_digest,result_digest
      FROM mn_builtin_agent_tool_calls
      WHERE tenant_id=$1 AND execution_id=$2 AND generation=1
    `, [identity.tenantId, acquired.executionId]);
    assert.deepEqual(oldTool.rows.map((row) => ({
      callRedacted: row.call_redacted,
      resultRedacted: row.result_redacted,
      hasCallDigest: /^[a-f0-9]{64}$/u.test(row.call_digest ?? ""),
      resultDigest: row.result_digest
    })), [{
      callRedacted: true,
      resultRedacted: true,
      hasCallDigest: true,
      resultDigest: null
    }]);
  }
);

test(
  "PostgreSQL approval decision wakes the model owner from another API replica",
  { skip: !connectionString },
  async (t) => {
    const runtime = new EnterprisePostgresRuntime({ connectionString });
    const brokerA = new EnterpriseBuiltinAgentBroker(
      new EnterpriseBuiltinAgentPersistence(runtime.pool)
    );
    const brokerB = new EnterpriseBuiltinAgentBroker(
      new EnterpriseBuiltinAgentPersistence(runtime.pool)
    );
    t.after(async () => {
      await Promise.allSettled([brokerA.dispose(), brokerB.dispose()]);
      await runtime.close();
    });
    await runtime.migrate();
    await brokerA.migrate();
    await runtime.pool.query(
      "TRUNCATE mn_builtin_agent_approvals, mn_builtin_agent_tool_calls, mn_builtin_agent_executions"
    );
    const identity = {
      tenantId: "tenant-pg-approval",
      workerId: "worker-pg-approval",
      claimDigest: "f".repeat(64)
    };
    const request = startRequest(identity);
    const approval = approvalFixture(request);
    const ownerBridge = brokerA.approvalBridgeForTenant(identity.tenantId)!;
    const remoteBridge = brokerB.approvalBridgeForTenant(identity.tenantId)!;
    const ownerCoordinator = new AgentApprovalCoordinator({ durable: ownerBridge });
    const remoteCoordinator = new AgentApprovalCoordinator({ durable: remoteBridge });
    const started = await brokerA.start({
      ...identity,
      request,
      providerId: "provider-pg",
      modelId: "model-pg",
      executionBinding: request.executionBinding,
      humanApproval: "on-risk",
      execute: async (_input, signal) => {
        const result = await ownerCoordinator.authorize({
          name: "write_file",
          risk: "side-effecting",
          args: { path: "README.md", content: "approved" },
          context: {
            sessionId: request.sessionId,
            cwd: request.workspacePath,
            signal
          },
          approvalBinding: approval.binding,
          approvalRequest: approval.event
        });
        assert.equal(result.decision, "approve");
        assert.equal(result.approvalDecision, "approve_once");
        return { reason: "completed", summary: "approved remotely", steps: 1, toolCalls: 0 };
      }
    });
    await waitForApprovalRow(runtime, identity.tenantId, request.sessionId);
    assert.equal(await remoteCoordinator.decideDurable(
      approval.event,
      "remote-approval-request",
      "approve_once"
    ), true);
    assert.equal(await remoteCoordinator.decideDurable(
      approval.event,
      "remote-approval-replay",
      "approve_once"
    ), true);
    await assert.rejects(
      remoteCoordinator.decideDurable(
        approval.event,
        "remote-approval-conflict",
        "deny"
      ),
      /another decision/u
    );
    const terminal = await waitForTerminal(brokerB, started.executionId, identity);
    assert.equal(terminal.state, "completed");
    assert.equal(terminal.output?.summary, "approved remotely");
    assert.equal(await remoteCoordinator.decideDurable(
      approval.event,
      "remote-approval-after-terminal",
      "approve_once"
    ), true);
  }
);

async function waitForTerminal(
  broker: EnterpriseBuiltinAgentBroker,
  executionId: string,
  identity: { tenantId: string; workerId: string; claimDigest: string }
): Promise<EnterpriseBuiltinExecutionViewV1> {
  let revision = 0;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const view = await broker.poll(executionId, identity, revision, 200);
    if (view.state !== "running") return view;
    revision = view.revision;
  }
  throw new Error("durable broker execution did not finish");
}

function startRequest(identity: {
  tenantId: string;
  workerId: string;
  claimDigest: string;
}): EnterpriseBuiltinExecutionStartV1 {
  const binding: AgentExecutionBindingV1 = {
    schemaVersion: 1,
    runId: "run-pg",
    candidateId: "builtin-1",
    sessionId: "agent-session-pg",
    runtimeId: "builtin",
    providerId: "provider-pg",
    modelId: "model-pg",
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
    prompt: "repair the durable fixture",
    providerId: "provider-pg",
    modelId: "model-pg",
    timeoutSeconds: 60,
    executionBinding: binding,
    sandboxAttestation: {
      schemaVersion: 1,
      leaseId: "sandbox-pg",
      issuer: "mn-api",
      issuedAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-21T00:00:00.000Z",
      runId: binding.runId,
      tenantId: identity.tenantId,
      workerId: identity.workerId,
      harnessDigest: binding.harnessDigest,
      requirementsDigest: "f".repeat(64),
      workerCapabilityDigest: "1".repeat(64),
      claimDigest: identity.claimDigest,
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
      leaseId: "sandbox-pg",
      attestationDigest: "4".repeat(64),
      runtimeId: "6".repeat(64),
      runtimeDigest: "7".repeat(64),
      imageDigest: "2".repeat(64),
      runtimeProof: {
        schemaVersion: 1,
        issuer: "mn-api",
        issuedAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2026-08-21T00:00:00.000Z",
        tenantId: identity.tenantId,
        runId: binding.runId,
        workerId: identity.workerId,
        claimDigest: identity.claimDigest,
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

function approvalFixture(request: EnterpriseBuiltinExecutionStartV1) {
  const binder = createRuntimeEffectCommitmentBinderV1({
    governanceDigest: Digest(request.executionBinding.governanceDigest),
    harnessDigest: Digest(request.executionBinding.harnessDigest)
  });
  const callId = CallId("approval-pg-call");
  const handle = binder.bind({
    effectKind: deriveToolEffectKindV1("write_file"),
    sessionId: SessionId(request.sessionId),
    runId: RunId(request.runId),
    candidateId: CandidateId(request.candidateId),
    turn: 1,
    step: 1,
    internalEffectId: callId,
    protectedInput: createProtectedTextV1("{}"),
    raw: { kind: "text", value: "{}" }
  });
  const binding = {
    schemaVersion: 1 as const,
    approvalId: "approval-pg",
    scope: handle.commitment.effectKind,
    risk: "side-effecting" as const,
    callId,
    name: "write_file",
    commitment: handle.commitment
  };
  const event = createAgentSessionEvent({
    eventId: EventId("approval-pg-event"),
    sessionId: SessionId(request.sessionId),
    seq: 0,
    occurredAt: "2026-08-20T00:00:00.000Z",
    type: "approval/requested",
    runId: RunId(request.runId),
    candidateId: CandidateId(request.candidateId),
    payload: protectAgentSessionPayloadV1("approval/requested", { binding })
  });
  binder.dispose();
  return { binding, event };
}

async function waitForApprovalRow(
  runtime: EnterprisePostgresRuntime,
  tenantId: string,
  sessionId: string
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await runtime.pool.query(
      "SELECT 1 FROM mn_builtin_agent_approvals WHERE tenant_id=$1 AND session_id=$2",
      [tenantId, sessionId]
    );
    if ((result.rowCount ?? 0) === 1) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  }
  throw new Error("durable approval row was not registered");
}
