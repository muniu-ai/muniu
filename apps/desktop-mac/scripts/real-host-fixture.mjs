// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { createAgentOsHost } from "../../host/dist/index.js";
import { InMemoryKernelStore } from "../../../packages/kernel/dist/index.js";

const port = Number(process.env.MN_FIXTURE_API_PORT);
const appOrigin = process.env.MN_FIXTURE_APP_ORIGIN;
const mode = process.env.MN_FIXTURE_MODE ?? "onboarding";
if (!Number.isSafeInteger(port) || port <= 0 || !appOrigin) throw new Error("缺少真实 Host fixture 配置");

const store = new InMemoryKernelStore();
const now = () => new Date().toISOString();
const id = (kind) => `${kind}-${randomUUID()}`;
const host = await createAgentOsHost({
  store,
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
    pluginIds: ["opc", "coding"],
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
    await mutate(`/v2/workspaces/${workspace.id}`, {
      expectedStreamVersion: workspace.streamVersion,
      viewMode: "business",
    }, "seed-view", "PATCH");
  }

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
