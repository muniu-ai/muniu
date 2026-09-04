// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createAgentOsHost } from "../../host/dist/index.js";
import { InMemoryKernelStore } from "../../../packages/kernel/dist/index.js";
import { InMemoryKeyProvider } from "../../../packages/storage/dist/index.js";

const port = Number(process.env.MN_FIXTURE_API_PORT);
const appOrigin = process.env.MN_FIXTURE_APP_ORIGIN;
const mode = process.env.MN_FIXTURE_MODE ?? "onboarding";
if (!Number.isSafeInteger(port) || port <= 0 || !appOrigin) throw new Error("缺少真实 Host fixture 配置");

const store = new InMemoryKernelStore();
const now = () => new Date().toISOString();
const id = (kind) => `${kind}-${randomUUID()}`;
const objects = new Map();
const cas = {
  async put(bytes) {
    const copy = Buffer.from(bytes);
    const digest = createHash("sha256").update(copy).digest("hex");
    const created = !objects.has(digest);
    objects.set(digest, copy);
    return { digest, byteLength: copy.byteLength, created };
  },
  async get(digest) {
    const value = objects.get(digest);
    if (!value) throw new Error("CAS object missing");
    return Buffer.from(value);
  },
  async has(digest) { return objects.has(digest); },
  async gcOrphans() { return []; },
};
const host = await createAgentOsHost({
  store,
  cas,
  protectedPayloadKeyProvider: new InMemoryKeyProvider(randomBytes(32)),
  now,
  id,
  allowedOrigins: [appOrigin],
  secretStore: {
    async save(account) { return `keychain://muniu.v2/${account}`; },
    async read() { return "fixture-key"; },
  },
  modelProbe: async ({ preset }) => ({
    models: preset.suggestedModels,
    defaultModel: preset.suggestedModels[0],
  }),
});

if (mode !== "onboarding") await seedWorkspace(mode);
await host.listen({ port });
process.stdout.write("READY\n");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { void host.close().finally(() => process.exit(0)); });
}

async function seedWorkspace(seedMode) {
  const workspace = await mutate("/v2/workspaces", {
    name: "设计师增长",
    viewMode: "business",
    pluginIds: seedMode === "coding"
      ? ["runner-codex-cli", "coding", "opc"]
      : ["opc", "coding"],
  }, "seed-workspace");
  const opportunity = await mutate("/v2/plugins/opc/opportunities", {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    input: "面向有 2–5 年经验的独立设计师，解决获客收入过度依赖转介绍的问题",
  }, "seed-opportunity");

  await mutate("/v2/plugins/coding/repositories", {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    input: "/workspace/muniu",
  }, "seed-repository");
  await mutate("/v2/plugins/coding/tasks", {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    input: "统一 Agent OS API",
  }, "seed-coding-task");

  await host.kernel.proposeMemory("local", "local-owner", "seed-memory", {
    workspaceId: workspace.id,
    scopeType: "resource",
    namespace: "opc",
    resourceId: opportunity.id,
    sourceEventId: "fixture-interview",
    confidence: 0.82,
    value: { summary: "目标客户重视可预测的获客节奏" },
  });
  await seedApproval(workspace.id);
  if (seedMode === "coding") {
    await seedFailure(workspace.id);
    await seedReconciliation(workspace.id);
    await mutate(`/v2/workspaces/${workspace.id}`, {
      expectedStreamVersion: workspace.streamVersion,
      viewMode: "business",
    }, "seed-view", "PATCH");
  }

}

async function seedFailure(workspaceId) {
  await store.transact("local", (transaction) => {
    transaction.putProjection("inbox", "fixture-credential", {
      id: "fixture-credential",
      tenantId: "local",
      workspaceId,
      kind: "credential",
      title: "模型凭据失效",
      summary: "重新连接模型后，等待中的任务才能继续。",
      risk: "credential_invalid",
      createdAt: now(),
      status: "open",
    });
  });
}

async function seedReconciliation(workspaceId) {
  const executionId = "fixture-reconciliation-execution";
  const taskId = "fixture-reconciliation-task";
  const repositoryId = "fixture-reconciliation-repository";
  const controlPlane = {
    protocol: "coding-v2",
    specDigest: digest("fixture-spec"),
    governanceDigest: digest("fixture-governance"),
    harnessDigest: digest("fixture-harness"),
    sandboxDigest: digest("fixture-sandbox"),
    repositoryIndexDigest: digest("fixture-index"),
  };
  const task = {
    id: taskId,
    workspaceId,
    repositoryId,
    title: "核对外部 Runner 结果",
    request: "确认未知结果后再决定",
    stage: "verify",
    status: "needs_reconciliation",
    streamVersion: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  await store.transact("local", (transaction) => {
    transaction.putProjection("execution", executionId, {
      id: executionId,
      tenantId: "local",
      workspaceId,
      threadId: "fixture-reconciliation-thread",
      pluginId: "coding",
      agentDefinitionId: "coding.builtin",
      modelBindingId: "fixture-model",
      initiatedBy: "local-owner",
      executionPrincipalId: "agent:coding",
      generation: 1,
      status: "needs_reconciliation",
      authorityId: "fixture-reconciliation-authority",
      runnerId: "codex-cli",
      failureCode: "UNKNOWN_EXTERNAL_SIDE_EFFECT",
      streamVersion: 1,
      createdAt: now(),
      updatedAt: now(),
    });
    transaction.putProjection("coding.task", taskId, task);
    transaction.putProjection("coding.execution", executionId, {
      executionId,
      generation: 1,
      taskId,
      repositoryId,
      status: "needs_reconciliation",
      controlPlane,
      baseRevision: digest("fixture-base"),
      runnerId: "codex-cli",
      externalInvocation: {
        runnerId: "codex-cli",
        attempt: 1,
        identityDigest: digest("fixture-runner"),
        sandboxPath: "/private/var/tmp/muniu/candidate-fixture/repository",
        runnerArtifactPath: "/private/var/tmp/muniu/runner-fixture/runner",
        status: "outcome_unknown",
        startedAt: now(),
        updatedAt: now(),
      },
      result: {
        task,
        runnerId: "codex-cli",
        status: "needs_reconciliation",
        candidates: [],
        gates: [],
        nextStep: "核对保留结果后终止旧调用或创建全新调用",
        limits: { maxRepairAttempts: 3, maxDurationMs: 3_600_000 },
        controlPlane,
      },
      streamVersion: 1,
      createdAt: now(),
      updatedAt: now(),
    });
    transaction.putProjection("inbox", `reconciliation:${executionId}:fixture-job`, {
      id: `reconciliation:${executionId}:fixture-job`,
      tenantId: "local",
      workspaceId,
      executionId,
      kind: "reconciliation",
      title: "外部 Runner 结果待核对",
      summary: "外部操作可能已经发生，系统不会自动重放。",
      risk: "unknown",
      createdAt: now(),
      status: "open",
    });
    for (const [aggregateType, aggregateId, type] of [
      ["execution", executionId, "execution.needs_reconciliation"],
      ["coding.task", taskId, "coding.execution_needs_reconciliation"],
      ["coding.execution", executionId, "coding.execution_result_persisted"],
    ]) {
      transaction.appendEvent({
        tenantId: "local",
        aggregateType,
        aggregateId,
        expectedStreamVersion: 0,
        type,
        actorId: "worker:fixture",
        executionId,
        generation: 1,
        correlationId: "fixture-reconciliation",
        publicPayload: { workspaceId },
      });
    }
  });
}

async function seedApproval(workspaceId) {
  const thread = await host.kernel.createThread("local", "local-owner", "seed-thread", {
    workspaceId,
    subject: "公开资料研究",
    pluginId: "opc",
  });
  const commitment = digest({ workspaceId, tools: ["opc.public-web.read"] });
  const execution = await host.kernel.createExecution("local", "local-owner", "seed-execution", {
    workspaceId,
    threadId: thread.id,
    pluginId: "opc",
    agentDefinitionId: "opc.opportunity-validator",
    modelBindingId: "fixture-model",
    executionPrincipalId: "agent:opc",
    authority: {
      workspaceId,
      principalId: "agent:opc",
      toolIds: ["opc.public-web.read"],
      dataScopes: [{ namespace: "web", resourceId: "https://example.com/case" }],
      autoAllowedEffects: ["local_read"],
      budget: {
        maxSubagentDepth: 1,
        maxSubagents: 2,
        maxTokens: 20_000,
        maxCostMinorUnits: "500",
        currency: "CNY",
        maxDurationMs: 3_600_000,
      },
      commitment,
    },
  });
  await host.kernel.requestToolApproval("local", "agent:opc", "seed-approval", {
    id: "fixture-tool-call",
    executionId: execution.id,
    generation: execution.generation,
    toolId: "opc.public-web.read",
    toolVersion: "0.2.0",
    effectClass: "external_read",
    intent: "读取客户公开案例并保存摘要",
    normalizedArguments: { url: "https://example.com/case" },
    argumentsDigest: digest({ url: "https://example.com/case" }),
    resourceRefs: [{ namespace: "web", resourceId: "https://example.com/case" }],
    resourcesDigest: digest(["https://example.com/case"]),
    authorityCommitment: commitment,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

async function mutate(path, body, key, method = "POST") {
  const response = await host.dispatch(new Request(`http://fixture.test${path}`, {
    method,
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  }));
  const value = await response.json();
  if (!response.ok) throw new Error(`fixture 请求失败 ${path}: ${JSON.stringify(value)}`);
  return value.data;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
