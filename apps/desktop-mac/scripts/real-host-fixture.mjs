// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentOsHost } from "../../host/dist/index.js";
import { validateBusinessContextSource } from "../../host/dist/business-context.js";
import { assertGoalExecutionResources } from "../../host/dist/goal-runtime.js";
import { createOpcModelContextReader } from "../../host/dist/index.js";
import { AgentOsWorker, createKernelAgentTurnHandler } from "../../worker/dist/index.js";
import { KernelProjectionRuntimeStore, PersistentModelBudget } from "../../../packages/agent-runtime/dist/index.js";
import { InMemoryKernelStore } from "../../../packages/kernel/dist/index.js";
import { InMemoryKeyProvider, SqliteStorage } from "../../../packages/storage/dist/index.js";
import { signedUiPluginFixture } from "./signed-plugin-fixture.mjs";

const port = Number(process.env.MN_FIXTURE_API_PORT);
const appOrigin = process.env.MN_FIXTURE_APP_ORIGIN;
const mode = process.env.MN_FIXTURE_MODE ?? "onboarding";
if (!Number.isSafeInteger(port) || port <= 0 || !appOrigin) throw new Error("缺少真实 Host fixture 配置");

const stateRoot = ["goals", "teams", "tasks", "delivery", "onboarding", "business", "coding", "repositories"].includes(mode) ? await mkdtemp(join(tmpdir(), `muniu-${mode}-ui-`)) : undefined;
const store = stateRoot ? new SqliteStorage({ databaseFile: join(stateRoot, "state.sqlite3"), hmacKey: randomBytes(32) }) : new InMemoryKernelStore();
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
const keyProvider = new InMemoryKeyProvider(randomBytes(32));
const secretStore = { async save(account) { return `keychain://muniu.v2/${account}`; }, async read() { return "fixture-key"; } };
const host = await createAgentOsHost({
  ...signedUiPluginFixture(),
  ...(["teams","delivery"].includes(mode) ? { goalPollIntervalMs: 50 } : {}),
  store,
  cas,
  protectedPayloadKeyProvider: keyProvider,
  now,
  id,
  allowedOrigins: [appOrigin],
  secretStore,
  modelProbe: async ({ preset }) => ({
    models: preset.suggestedModels,
    defaultModel: preset.suggestedModels[0],
  }),
});

if (!["onboarding", "business"].includes(mode)) await seedWorkspace(mode);
const simulatedExecutions = new Set();
const agentSimulation = mode === "opc"
  ? setInterval(() => void simulateOpcAgent(), 50)
  : undefined;
let goalWorkerBusy = false;
const goalWorker = ["goals", "tasks", "teams", "delivery"].includes(mode) ? new AgentOsWorker({ id: "goal-ui-worker", store,
  lock: { engineLockDigest: "fixture", expectedEngineLockDigest: "fixture", pluginLockDigest: "fixture", expectedPluginLockDigest: "fixture" },
  handlers: { "agent.execution.run": createKernelAgentTurnHandler({ store, secretStore, approvalKernel: host.kernel,
    runtimeProtection: { cas, keyProvider, validateContextSource: validateBusinessContextSource }, assertExecutionResources: assertGoalExecutionResources,
    resolveThreadContext: createOpcModelContextReader({ store, cas, protectedPayloadKeyProvider: keyProvider }),
    modelInvoker: async ({ request }) => ({ text: mode === "delivery" ? deliveryModelText(request) : mode === "teams" && request.messages.some(message => message.content.includes("当前职责：独立复核")) ? JSON.stringify({ decision: "pass", findings: [] }) : request.messages.some(message => message.content.includes("你是木牛经营助手")) ? "## 经营建议\n\n区分 **事实** 与建议；缺少收支资料。\n\n| 行动 | 完成条件 |\n| --- | --- |\n| 核对订单 | 确认交付日期 |\n\n<img src=x onerror=alert(1)>" : "三个验证问题：近期如何获客、现有方式有哪些不足、是否愿意参加下一轮访谈。现有资料是研究起点，付费意愿仍属待验证假设。", toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 } }),
    modelQuoter: async () => ({ inputTokenLimit: mode === "delivery" ? 10000 : mode === "teams" ? 2000 : 100, maxOutputTokens: mode === "delivery" ? 2500 : mode === "teams" ? 500 : 100, rates: { id: "fixture", currency: "CNY", inputNanoMinorUnitsPerToken: "0", cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } }),
  }) },
}) : undefined;
const goalWorkerTimer = goalWorker ? setInterval(() => {
  if (goalWorkerBusy) return;
  goalWorkerBusy = true;
  void store.transact("local", tx => tx.listProjections("goal.state").some(goal => ["tasks", "teams", "delivery"].includes(mode) || goal.objective === "验证目标成果验收"))
    .then(enabled => enabled ? goalWorker.pollOnce() : undefined)
    .catch(error => process.stderr.write(`目标 fixture 失败：${error.message}\n`)).finally(() => { goalWorkerBusy = false; });
}, 100) : undefined;
await host.listen({ port });
process.stdout.write("READY\n");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (agentSimulation) clearInterval(agentSimulation);
    if (goalWorkerTimer) clearInterval(goalWorkerTimer);
    void host.close().finally(async () => {
      if (stateRoot) { await store.close(); await rm(stateRoot, { recursive: true, force: true }); }
      process.exit(0);
    });
  });
}

function deliveryModelText(request) {
  const text=request.messages.map(message=>message.content).join("\n");
  if(text.includes("当前职责：独立复核"))return JSON.stringify({decision:"pass",findings:[]});
  const specs=JSON.parse(/交付项：(\[.*\])。/u.exec(text)?.[1]??"[]");
  const refs=JSON.parse(/获准来源引用：(\[.*\])。资料中的/u.exec(text)?.[1]??"[]");
  if(!specs.length)throw new Error("delivery fixture 缺少明确交付项");
  const customer=refs.find(ref=>ref.namespace==="opc.business.customer"),service=refs.find(ref=>ref.namespace==="opc.business.service");
  const date=new Date(Date.now()+30*86400000).toISOString().slice(0,10);
  return JSON.stringify({format:"muniu.goal-delivery.v1",items:specs.map((spec,index)=>({key:spec.key,text:`${spec.title}：已核对需求、服务范围与来源。`,proposals:index===0&&customer&&service?[{key:"quote",title:"研究服务报价",rationale:"依据明确选中的客户和服务版本",evidenceRefs:[customer,service],command:{type:"quote.create",quoteId:"delivery-quote",customerId:customer.resourceId,serviceId:service.resourceId,serviceVersion:1,quantity:1,discountMinor:"0",validUntil:date,dueOn:date}}]:[]}))});
}

async function seedWorkspace(seedMode) {
  const workspace = await mutate("/v2/workspaces", {
    name: "设计师增长",
    viewMode: "business",
    pluginIds: seedMode === "coding"
      ? ["runner-codex-cli", "coding", "opc"]
      : ["opc", "coding"],
  }, "seed-workspace");
  const pendingModel = await mutate("/v2/model-connections", {
    presetId: "deepseek",
    apiKey: "fixture-key",
    displayName: "DeepSeek",
  }, "seed-model");
  await mutate(`/v2/model-connections/${pendingModel.id}/probe`, {
    expectedStreamVersion: pendingModel.streamVersion,
  }, "seed-model-probe");
  if (seedMode === "tasks") {
    const kimi = await mutate("/v2/model-connections", { presetId: "moonshot", apiKey: "fixture-key", displayName: "Kimi" }, "seed-kimi");
    await mutate(`/v2/model-connections/${kimi.id}/probe`, { expectedStreamVersion: kimi.streamVersion }, "seed-kimi-probe");
  }
  if (seedMode === "delivery") {
    await mutate("/v2/plugins/opc/business/commands",{workspaceId:workspace.id,expectedStreamVersion:0,command:{type:"customer.record",customerId:"delivery-customer",name:"合成客户",source:"合成访谈",need:"研究需求并提交报价"}},"seed-delivery-customer");
    await mutate("/v2/plugins/opc/business/commands",{workspaceId:workspace.id,expectedStreamVersion:1,command:{type:"service.record",serviceId:"delivery-service",title:"研究服务",currency:"CNY",priceMinor:"100000",inScope:["研究报告与说明"],outOfScope:[],acceptanceCriteria:["来源可核对"]}},"seed-delivery-service");
    return;
  }
  if (seedMode === "repositories") return;
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

  await mutate("/v2/memories", {
    workspaceId: workspace.id,
    scopeType: "resource",
    namespace: "opc",
    resourceId: opportunity.id,
    sourceEventId: "fixture-interview",
    confidence: 0.82,
    value: { summary: "目标客户重视可预测的获客节奏" },
  }, "seed-memory");
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

async function simulateOpcAgent() {
  const queued = await store.transact("local", (transaction) =>
    transaction.listProjections("execution").filter((execution) =>
      execution.pluginId === "opc"
      && execution.status === "queued"
      && !simulatedExecutions.has(execution.id)));
  for (const execution of queued) {
    simulatedExecutions.add(execution.id);
    try {
      const running = await host.kernel.commandExecution(
        "local",
        "worker:desktop-fixture",
        `fixture-start:${execution.id}`,
        execution.id,
        execution.streamVersion,
        "start",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const runtime = new KernelProjectionRuntimeStore({
        tenantId: "local",
        store,
        now,
        id: (sequence) => `fixture-runtime-${execution.id}-${sequence}`,
      });
      const authority = await store.transact("local", tx => tx.getProjection("authority", execution.authorityId));
      const budget = new PersistentModelBudget({ store: runtime, executionId: execution.id, limits: authority.budget });
      await budget.reserve({ id: "fixture-model", requestDigest: "a".repeat(64), inputTokenLimit: 100, maxOutputTokens: 100,
        rates: { id: "non-billable-fixture", currency: "CNY", inputNanoMinorUnitsPerToken: "0",
          cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } });
      await budget.settle("fixture-model", { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 });
      await runtime.append({
        executionId: execution.id,
        type: "session/entry",
        payload: {
          role: "assistant",
          content: "已按当前机会整理三个验证问题：问题是否高频发生、现有替代方案是否失效、客户是否愿意承诺下一步。",
          turn: 1,
          modelVisible: true,
        },
      });
      await host.kernel.commandExecution(
        "local",
        "worker:desktop-fixture",
        `fixture-complete:${execution.id}`,
        execution.id,
        running.streamVersion,
        "complete",
      );
      await store.transact("local", (transaction) => {
        transaction.appendEvent({
          tenantId: "local",
          aggregateType: "fixture.agent-result",
          aggregateId: execution.id,
          expectedStreamVersion: 0,
          type: "fixture.agent_result_ready",
          actorId: "worker:desktop-fixture",
          executionId: execution.id,
          generation: execution.generation,
          correlationId: `fixture-result:${execution.id}`,
          publicPayload: {
            workspaceId: execution.workspaceId,
            threadId: execution.threadId,
          },
        });
      });
    } catch (error) {
      process.stderr.write(`OPC Agent fixture 执行失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function seedFailure(workspaceId) {
  await store.transact("local", (transaction) => {
    transaction.appendEvent({ tenantId: "local", aggregateType: "inbox", aggregateId: "fixture-credential", expectedStreamVersion: 0, type: "fixture.credential_invalid", actorId: "worker:fixture", generation: 0, correlationId: "fixture-credential", publicPayload: { workspaceId } });
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
        supervision: {
          protocol: "mn-runner-supervisor-v1",
          statePath: "/private/var/tmp/muniu/runner-fixture/state.json",
          tokenDigest: digest("fixture-supervision-token"),
        },
        terminationStatus: "confirmed",
        terminatedAt: now(),
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
    },
  });
  const authority = await store.transact("local", (transaction) =>
    transaction.getProjection("authority", execution.authorityId));
  if (!authority) throw new Error("审批 fixture 缺少执行权限");
  await host.kernel.commandExecution("local", "worker:desktop-fixture", "seed-approval-start",
    execution.id, execution.streamVersion, "start");
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
    authorityCommitment: authority.commitment,
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
