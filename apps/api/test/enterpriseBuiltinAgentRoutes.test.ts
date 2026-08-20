// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import Fastify from "fastify";
import type {
  AgentExecutionBindingV1,
  AgentTask,
  EnterpriseBuiltinExecutionViewV1,
  Project,
  RequestContext,
  RunRecord
} from "@mn/core";
import type { ProviderRecord } from "@mn/provider-catalog";

import { EnterpriseBuiltinAgentBroker } from "../src/enterpriseBuiltinAgentBroker.js";
import { registerEnterpriseBuiltinAgentRoutes } from "../src/enterpriseBuiltinAgentRoutes.js";
import { issueSandboxAttestation } from "../src/sandboxAttestation.js";
import { issueSandboxRuntimeProof } from "../src/sandboxRuntimeProof.js";

const signingKey = "builtin-route-signing-key-0123456789abcdef0123456789abcdef";
const claimDigest = "c".repeat(64);
const requirementsDigest = "1".repeat(64);
const workerCapabilityDigest = "2".repeat(64);

test("enterprise builtin routes resolve a tenant provider and bind execution to the inspected claim", async (t) => {
  const fixture = createFixture();
  const broker = new EnterpriseBuiltinAgentBroker();
  const app = Fastify();
  let captured: Record<string, unknown> | undefined;
  registerEnterpriseBuiltinAgentRoutes(app, {
    runtimeProfile: "enterprise",
    postgres: fixture.postgres,
    signingKey,
    store: fixture.store,
    providerStore: fixture.providerStore,
    broker,
    requestContext: () => fixture.context,
    getAgentSessionService: async () => ({
      executeCandidate: async (input: Record<string, unknown>) => {
        captured = input;
        return { reason: "completed", summary: "done", steps: 1, toolCalls: 0 };
      }
    }) as never
  });
  t.after(async () => {
    await app.close();
    await broker.dispose();
  });

  const started = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/run-1/builtin-executions",
    payload: {
      ownerId: "worker-1",
      claimToken: "claim-token-1",
      execution: fixture.execution
    }
  });
  assert.equal(started.statusCode, 202, started.body);
  const initial = started.json<EnterpriseBuiltinExecutionViewV1>();
  assert.equal(initial.providerId, "provider-1");
  assert.equal(initial.modelId, "model-1");
  assert.equal(initial.executionBinding.providerId, "provider-1");

  const polled = await app.inject({
    method: "POST",
    url: `/v1/run-jobs/queue/run-1/builtin-executions/${initial.executionId}/poll`,
    payload: {
      ownerId: "worker-1",
      claimToken: "claim-token-1",
      afterRevision: -1,
      waitMs: 100
    }
  });
  assert.equal(polled.statusCode, 200, polled.body);
  assert.equal(polled.json<EnterpriseBuiltinExecutionViewV1>().state, "completed");
  assert.equal(captured?.cwd, "/workspace/scratch/candidates/builtin-1");
  assert.equal(captured?.providerId, "provider-1");
  assert.equal(captured?.modelId, "model-1");
});

test("enterprise builtin routes reject a workspace outside the signed writable lease", async (t) => {
  const fixture = createFixture();
  const broker = new EnterpriseBuiltinAgentBroker();
  const app = Fastify();
  let executed = false;
  registerEnterpriseBuiltinAgentRoutes(app, {
    runtimeProfile: "enterprise",
    postgres: fixture.postgres,
    signingKey,
    store: fixture.store,
    providerStore: fixture.providerStore,
    broker,
    requestContext: () => fixture.context,
    getAgentSessionService: async () => ({
      executeCandidate: async () => {
        executed = true;
        return { reason: "completed", summary: "unexpected", steps: 1, toolCalls: 0 };
      }
    }) as never
  });
  t.after(async () => {
    await app.close();
    await broker.dispose();
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/run-jobs/queue/run-1/builtin-executions",
    payload: {
      ownerId: "worker-1",
      claimToken: "claim-token-1",
      execution: { ...fixture.execution, workspacePath: "/workspace/project" }
    }
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json<{ error: string }>().error, /writable sandbox lease/u);
  assert.equal(executed, false);
});

function createFixture() {
  const task = taskRecord();
  const project: Project = {
    id: "project-1",
    tenantId: "tenant-1",
    name: "fixture",
    rootPath: "/srv/repos/fixture",
    defaultBranch: "main",
    services: [],
    policyId: "default"
  };
  const run = runRecord();
  const now = new Date().toISOString();
  const attestation = issueSandboxAttestation({
    run,
    tenantId: "tenant-1",
    workerId: "worker-1",
    requirementsDigest,
    workerCapabilityDigest,
    claimDigest,
    signingKey
  }, now);
  const runtimeId = "a".repeat(64);
  const runtimeDigest = "b".repeat(64);
  const imageDigest = "9".repeat(64);
  const runtimeProof = issueSandboxRuntimeProof({
    attestation,
    tenantId: "tenant-1",
    runId: run.id,
    workerId: "worker-1",
    claimDigest,
    runtimeId,
    runtimeDigest,
    imageDigest,
    signingKey
  }, now);
  const binding = executionBinding(task);
  const execution = {
    schemaVersion: 1 as const,
    sessionId: binding.sessionId,
    runId: run.id,
    candidateId: "builtin-1",
    workspacePath: "/workspace/scratch/candidates/builtin-1",
    prompt: task.prompt,
    providerId: "default",
    modelId: "default",
    timeoutSeconds: 600,
    executionBinding: binding,
    sandboxAttestation: attestation,
    sandboxExecution: {
      backendId: attestation.backend.id,
      backendVersion: attestation.backend.version,
      leaseId: attestation.leaseId,
      attestationDigest: attestation.digest,
      runtimeId,
      runtimeDigest,
      imageDigest,
      runtimeProof
    }
  };
  const context: RequestContext = {
    tenantId: "tenant-1",
    actorId: "worker-1",
    roles: [],
    projectIds: [],
    principalType: "worker",
    scopes: ["run_jobs:checkpoint"],
    authentication: "jwt",
    traceId: "trace-1"
  };
  const provider: ProviderRecord = {
    id: "provider-1",
    app: "unified",
    name: "tenant provider",
    kind: "openai_compatible",
    apiFormat: "openai_responses",
    baseUrl: "https://provider.example/v1",
    defaultModel: "model-1",
    modelCatalog: [{ id: "model-1", displayName: "Model 1" }],
    config: { enterpriseScope: { tenantIds: ["tenant-1"], projectIds: ["project-1"] } },
    enabled: true,
    enabledConsumers: ["agent"],
    sortOrder: 1,
    createdAt: now,
    updatedAt: now
  };
  const item = {
    version: 2 as const,
    runId: run.id,
    projectId: project.id,
    taskId: task.id,
    status: "running" as const,
    priority: 0,
    attempt: 1,
    recovered: false,
    createdAt: now,
    updatedAt: now,
    ownerId: "worker-1",
    claimTokenHash: claimDigest,
    workerCapabilityDigest,
    tenantId: "tenant-1",
    requirementsDigest,
    claimedAt: now,
    claimExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  return {
    context,
    execution,
    store: {
      projects: new Map([[project.id, project]]),
      tasks: new Map([[task.id, task]]),
      runs: new Map([[run.id, run]])
    } as never,
    providerStore: { listProviders: async () => [provider] } as never,
    postgres: {
      inspectClaim: async (input: { runId: string; ownerId: string; claimToken: string }) =>
        input.runId === run.id && input.ownerId === "worker-1" && input.claimToken === "claim-token-1"
          ? {
              item,
              payload: {
                version: 2,
                run,
                executionContext: {
                  schemaVersion: 2,
                  project,
                  task,
                  bindings: {
                    tenantId: "tenant-1",
                    runId: run.id,
                    projectId: project.id,
                    taskId: task.id
                  }
                }
              },
              checkpointDigest: null
            }
          : undefined
    }
  };
}

function taskRecord(): AgentTask {
  return {
    id: "task-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    title: "repair fixture",
    intent: "repair",
    targetServices: [],
    prompt: "repair the fixture",
    acceptanceCriteria: ["tests pass"],
    strategy: {
      schemaVersion: 2,
      targets: [{ runtimeId: "builtin", providerId: "default", modelId: "default", candidates: 1 }],
      sandbox: "isolated-worktree",
      requiredGates: ["unit_test"],
      humanApproval: "on-risk",
      timeoutSeconds: 600
    },
    createdAt: "2026-08-20T00:00:00.000Z"
  };
}

function executionBinding(task: AgentTask): AgentExecutionBindingV1 {
  return {
    schemaVersion: 1,
    runId: "run-1",
    candidateId: "builtin-1",
    sessionId: "agent-session-1",
    runtimeId: "builtin",
    providerId: "default",
    modelId: "default",
    harnessDigest: semanticDigest({ harnessProfileRef: "classic" }),
    governanceDigest: semanticDigest({ workflowRef: "classic-v1", specRef: null }),
    effectPolicyDigest: semanticDigest({
      sandbox: task.strategy.sandbox,
      requiredGates: task.strategy.requiredGates,
      humanApproval: task.strategy.humanApproval,
      timeoutSeconds: task.strategy.timeoutSeconds
    }),
    sandboxCapabilityId: task.strategy.sandbox
  };
}

function semanticDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function runRecord(): RunRecord {
  return {
    id: "run-1",
    taskId: "task-1",
    projectId: "project-1",
    tenantId: "tenant-1",
    status: "running",
    candidates: [],
    gates: [],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    harnessManifest: {
      schemaVersion: 1,
      generatedAt: "2026-08-20T00:00:00.000Z",
      profile: { id: "enterprise", version: "1", digest: "3".repeat(64) },
      task: { taskId: "task-1", projectRoot: "/srv/repos/fixture" },
      specRef: { specSetId: "fixture", revision: 1, digest: "4".repeat(64) },
      governanceDigest: "5".repeat(64),
      selectedServices: [],
      languageByService: {},
      policy: {
        requiredGates: ["unit_test"],
        deny: [],
        protectedPaths: [],
        commandAllowlist: ["node"],
        networkAllowlist: [],
        budgets: { maxDurationSeconds: 600 },
        approvalMode: "before-merge"
      },
      executionPolicy: {
        commandAllowlist: ["node"],
        networkAllowlist: [],
        deny: [],
        protectedPaths: []
      },
      context: {
        fragments: [],
        omitted: [],
        usedBytes: 0,
        usedTokens: 0,
        maxBytes: 1,
        maxTokens: 1,
        tokenEstimator: { id: "utf8-byte-upper-bound", version: "1" },
        digest: "6".repeat(64)
      },
      gatePlan: [{
        id: "unit_test",
        runnerId: "unit_test",
        runnerVersion: "1",
        languages: ["javascript"],
        required: true
      }],
      sandbox: {
        backendId: "enterprise-container",
        backendVersion: "1",
        enforcement: "enforced",
        capabilities: ["mount-policy", "network-policy", "resource-limits", "tool-allowlist"],
        runtimeImage: { reference: "node:22-alpine", digest: "9".repeat(64) }
      },
      stopConditions: { maxDurationSeconds: 600 },
      outputSchema: "mn.run-result.v2",
      digest: "8".repeat(64)
    }
  };
}
