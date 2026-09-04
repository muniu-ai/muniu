import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { InMemoryKernelStore } from "@mn/kernel";
import type { PluginDefinitionV1 } from "@mn/plugin-sdk";
import { CursorExpiredError, SqliteStorage, type ContentAddressedStorage } from "@mn/storage";
import {
  createAgentOsHost,
  defaultLocalStatePaths,
  type ModelSecretStore,
} from "../src/index.js";

const healthyPlugin: PluginDefinitionV1 = {
  id: "healthy",
  version: "0.2.0",
  official: true,
  trustBoundary: "process_equivalent",
  contributions: {
    routes: [{ id: "healthy.home", path: "/plugins/healthy" }],
    navigation: [], widgets: [], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [],
    commands: [{ id: "echo", title: "回显", async run(input) { return input; } }],
  },
  healthCheck() { return { status: "healthy" }; },
};

const failingPlugin: PluginDefinitionV1 = {
  id: "failing",
  version: "0.2.0",
  official: true,
  trustBoundary: "process_equivalent",
  contributions: {
    routes: [{ id: "failing.home", path: "/plugins/failing" }],
    navigation: [], widgets: [], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [],
    commands: [{ id: "explode", title: "失败", async run() { throw new Error("secret plugin detail"); } }],
  },
};

const secrets: ModelSecretStore = {
  async save(connectionId) { return `keychain://muniu.v2/${connectionId}`; },
  async read() { return "test-key"; },
};

function jsonRequest(path: string, body: unknown, key?: string, method = "POST") {
  const headers = new Headers({ "content-type": "application/json" });
  if (key) headers.set("Idempotency-Key", key);
  return new Request(`http://host.test${path}`, { method, headers, body: JSON.stringify(body) });
}

async function responseJson(response: Response): Promise<any> {
  return response.json();
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (body: string) => boolean,
  timeoutMs = 1_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let body = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(body)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`SSE read timed out: ${body}`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`SSE read timed out: ${body}`)), remaining);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    if (result.done) throw new Error(`SSE closed before expected data: ${body}`);
    body += decoder.decode(result.value, { stream: true });
  }
  return body;
}

test("Cordis 是唯一组合根，官方插件预装但默认不启用", async () => {
  const host = await createAgentOsHost({
    store: new InMemoryKernelStore(),
    officialPlugins: [healthyPlugin, failingPlugin],
    secretStore: secrets,
  });
  assert.equal(Context.is(host.context), true);
  const response = await host.dispatch(new Request("http://host.test/v2/plugins/installations"));
  const body = await responseJson(response);
  assert.deepEqual(body.data.map((entry: any) => [entry.pluginId, entry.activeByDefault]), [
    ["healthy", false], ["failing", false],
  ]);
  await host.close();
});

test("桌面首次向导与首页使用真实 0.2 接口和官方产品插件", async () => {
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(), secretStore: secrets });

  const setup = await host.dispatch(jsonRequest("/v2/setup", {}, "setup-onboarding"));
  assert.equal(setup.status, 200);
  assert.deepEqual((await responseJson(setup)).data, {
    tenantId: "local",
    principalId: "local-owner",
  });

  const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "独立设计师增长",
    viewMode: "business",
    pluginIds: ["opc", "coding"],
  }, "onboarding-workspace")))).data;

  const captured = await host.dispatch(jsonRequest("/v2/plugins/opc/opportunities", {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    input: "面向独立设计师，解决客户来源不稳定的问题",
  }, "onboarding-opportunity"));
  assert.equal(captured.status, 201);
  const capturedBody = await responseJson(captured);
  const replayedCapture = await responseJson(await host.dispatch(jsonRequest("/v2/plugins/opc/opportunities", {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    input: "面向独立设计师，解决客户来源不稳定的问题",
  }, "onboarding-opportunity")));
  assert.equal(replayedCapture.data.id, capturedBody.data.id);
  const reusedCaptureKey = await host.dispatch(jsonRequest("/v2/plugins/opc/opportunities", {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    input: "另一个不同机会",
  }, "onboarding-opportunity"));
  assert.equal(reusedCaptureKey.status, 409);

  const repository = await host.dispatch(jsonRequest("/v2/plugins/coding/repositories", {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    input: "/Users/tester/product",
  }, "onboarding-repository"));
  assert.equal(repository.status, 201);

  const sample = await host.dispatch(jsonRequest("/v2/plugins/opc/samples/read-only", {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
  }, "onboarding-sample"));
  assert.equal(sample.status, 200);
  assert.equal((await responseJson(sample)).data.effectClass, "external_read");

  const opportunities = await responseJson(await host.dispatch(new Request(
    `http://host.test/v2/plugins/opc/opportunities?workspaceId=${workspace.id}`,
  )));
  assert.equal(opportunities.data.length, 1);
  assert.equal(opportunities.data[0].status, "captured");
  assert.equal(opportunities.data[0].evidenceLevel, "none");
  assert.equal(opportunities.data[0].targetCustomer, "独立设计师");
  assert.equal(opportunities.data[0].nextAction, "界定目标客户、问题和可证伪假设");

  const home = await responseJson(await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${workspace.id}/home`,
  )));
  assert.equal(home.data.todayActions[0].pluginId, "opc");
  assert.deepEqual(home.data.approvals, []);

  const activity = await responseJson(await host.dispatch(new Request(
    `http://host.test/v2/activity?workspaceId=${workspace.id}`,
  )));
  assert.ok(activity.data.some((item: any) => item.title === "创建机会"));
  await host.close();
});

test("附件经校验和 CAS create-only 写入后才提交 Asset，幂等重放不重复写 CAS", async () => {
  const store = new InMemoryKernelStore();
  const objects = new Map<string, Buffer>();
  const eventCountsAtPut: number[] = [];
  let rejectPut = false;
  const cas: ContentAddressedStorage = {
    async put(bytes) {
      const events = await store.readEvents("local", 0, 1_000);
      eventCountsAtPut.push(events.events.filter((event) => event.type === "asset.created").length);
      if (rejectPut) throw new Error("S3 unavailable");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const created = !objects.has(digest);
      objects.set(digest, Buffer.from(bytes));
      return { digest, byteLength: bytes.byteLength, created };
    },
    async get(digest) {
      const value = objects.get(digest);
      if (!value) throw new Error("CAS object missing");
      return value;
    },
    async has(digest) { return objects.has(digest); },
    async gcOrphans() { return []; },
  };
  let id = 0;
  const host = await createAgentOsHost({
    store,
    cas,
    secretStore: secrets,
    now: () => "2026-09-04T09:00:00.000Z",
    id: (kind) => `${kind}-${++id}`,
  });
  const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "附件验证", viewMode: "business", pluginIds: ["opc"],
  }, "asset-workspace")))).data;
  const upload = {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    attachments: [{
      fileName: "访谈记录.md",
      mediaType: "text/markdown",
      contentBase64: Buffer.from("# 访谈记录\n\n保留原始事实。", "utf8").toString("base64"),
    }],
  };

  const createdResponse = await host.dispatch(jsonRequest("/v2/assets", upload, "asset-create"));
  assert.equal(createdResponse.status, 201, JSON.stringify(await createdResponse.clone().json()));
  const created = (await responseJson(createdResponse)).data;
  assert.equal(created.length, 1);
  assert.equal(created[0].fileName, "访谈记录.md");
  assert.equal(created[0].protected, false);
  assert.deepEqual(eventCountsAtPut, [0]);

  const metadata = await responseJson(await host.dispatch(new Request(
    `http://host.test/v2/assets/${created[0].id}`,
  )));
  assert.equal(metadata.data.digest, created[0].digest);
  const content = await host.dispatch(new Request(`http://host.test/v2/assets/${created[0].id}?content=1`));
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-type"), "text/markdown");
  assert.match(content.headers.get("content-disposition") ?? "", /UTF-8''%E8%AE%BF%E8%B0%88%E8%AE%B0%E5%BD%95\.md/u);
  assert.equal(await content.text(), "# 访谈记录\n\n保留原始事实。");

  const replayed = await responseJson(await host.dispatch(jsonRequest("/v2/assets", upload, "asset-create")));
  assert.deepEqual(replayed.data, created);
  assert.deepEqual(eventCountsAtPut, [0]);

  const reusedKey = await host.dispatch(jsonRequest("/v2/assets", {
    ...upload,
    attachments: [{
      ...upload.attachments[0],
      contentBase64: Buffer.from("不同内容", "utf8").toString("base64"),
    }],
  }, "asset-create"));
  assert.equal(reusedKey.status, 409);
  assert.deepEqual(eventCountsAtPut, [0]);

  const invalid = await host.dispatch(jsonRequest("/v2/assets", {
    ...upload,
    attachments: [{ ...upload.attachments[0], fileName: "../访谈记录.md" }],
  }, "asset-invalid"));
  assert.equal(invalid.status, 422);
  assert.deepEqual(eventCountsAtPut, [0]);

  const tooMany = await host.dispatch(jsonRequest("/v2/assets", {
    ...upload,
    attachments: Array.from({ length: 21 }, (_, index) => ({
      ...upload.attachments[0], fileName: `记录-${index}.md`,
    })),
  }, "asset-too-many"));
  assert.equal(tooMany.status, 422);
  assert.deepEqual(eventCountsAtPut, [0]);

  rejectPut = true;
  const failed = await host.dispatch(jsonRequest("/v2/assets", {
    ...upload,
    attachments: [{ ...upload.attachments[0], fileName: "另一份记录.md" }],
  }, "asset-cas-failure"));
  assert.equal(failed.status, 500);
  const events = await store.readEvents("local", 0, 1_000);
  assert.equal(events.events.filter((event) => event.type === "asset.created").length, 1);
  await host.close();
});

test("OPC /v2 完成证据、访谈、收费方案、人工决策与成果导出全流程", async () => {
  let id = 0;
  const host = await createAgentOsHost({
    store: new InMemoryKernelStore(),
    secretStore: secrets,
    now: () => "2026-09-04T09:00:00.000Z",
    id: (kind) => `${kind}-${++id}`,
  });
  const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "机会验证", viewMode: "business", pluginIds: ["opc"],
  }, "opc-workspace")))).data;
  let opportunity = (await responseJson(await host.dispatch(jsonRequest("/v2/plugins/opc/opportunities", {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    input: "目标客户：独立开发者；问题：不会做有效访谈；假设：五次访谈中至少一人承诺试用",
  }, "opc-capture")))).data;

  async function command(name: string, input: Record<string, unknown>, key = `opc-${name}`) {
    const response = await host.dispatch(jsonRequest(
      `/v2/plugins/opc/opportunities/${opportunity.id}/commands`,
      { workspaceId: workspace.id, expectedStreamVersion: opportunity.streamVersion, command: name, input },
      key,
    ));
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(await response.clone().json())}`);
    opportunity = (await responseJson(response)).data;
    return opportunity;
  }

  await command("frame", {
    targetCustomer: "独立开发者",
    problem: "不会做有效访谈",
    falsifiableHypothesis: "五次访谈中至少一人承诺试用",
  });
  await command("start_research", {});
  const supportVersion = opportunity.streamVersion;
  const supportBody = {
    workspaceId: workspace.id,
    expectedStreamVersion: supportVersion,
    command: "record_signal",
    input: {
      sourceKind: "public_web",
      sourceUrl: "https://example.com/research",
      observedAt: "2026-09-04T08:30:00.000Z",
      excerpt: "访谈准备耗时",
      summary: "目标群体会搜索访谈模板",
      relationship: "support",
      evidenceKind: "context",
    },
  };
  const support = await host.dispatch(jsonRequest(
    `/v2/plugins/opc/opportunities/${opportunity.id}/commands`, supportBody, "opc-support",
  ));
  assert.equal(support.status, 200);
  opportunity = (await responseJson(support)).data;
  const replayedSupport = await responseJson(await host.dispatch(jsonRequest(
    `/v2/plugins/opc/opportunities/${opportunity.id}/commands`, supportBody, "opc-support",
  )));
  assert.equal(replayedSupport.data.streamVersion, opportunity.streamVersion);
  const reusedKey = await host.dispatch(jsonRequest(
    `/v2/plugins/opc/opportunities/${opportunity.id}/commands`,
    { ...supportBody, input: { ...supportBody.input, summary: "不同内容" } },
    "opc-support",
  ));
  assert.equal(reusedKey.status, 409);

  await command("record_signal", {
    sourceKind: "pasted",
    observedAt: "2026-09-04T08:40:00.000Z",
    excerpt: "免费模板已经很多",
    summary: "免费替代方案降低付费意愿",
    relationship: "oppose",
    evidenceKind: "context",
  });
  await command("start_interviewing", {});
  await command("record_interview", {
    interviewId: "interview-a",
    participantRef: "受访者 A",
    occurredAt: "2026-09-03T10:00:00.000Z",
    rawRecord: "我下载过模板，但不知道问题是否带有诱导性。",
  });
  await command("annotate_interview", {
    interviewId: "interview-a",
    annotation: "问题集中在访谈质量，而不是模板数量",
  });
  await command("start_evaluation", {});
  await command("record_experiment", {
    question: "受访者是否会采取明确下一步",
    method: "提供七天试用方案并记录回应",
    successCriterion: "至少一人承诺试用",
    status: "planned",
  });

  const preview = await responseJson(await host.dispatch(new Request(
    `http://host.test/v2/plugins/opc/opportunities/${opportunity.id}/deliverables?workspaceId=${workspace.id}`,
  )));
  assert.equal(preview.data.length, 6);
  assert.match(JSON.stringify(preview.data), /方案待验证/u);
  assert.doesNotMatch(JSON.stringify(preview.data), /已验证/u);
  assert.match(JSON.stringify(preview.data), /免费替代方案降低付费意愿/u);
  const missing = await host.dispatch(new Request(
    `http://host.test/v2/plugins/opc/opportunities/missing?workspaceId=${workspace.id}`,
  ));
  assert.equal(missing.status, 404);

  await command("prepare_offer", {
    targetCustomer: "独立开发者",
    promisedOutcome: "七天内形成继续或停止的证据",
    inScope: ["访谈提纲", "证据账本"],
    outOfScope: ["代替访谈", "自动外联"],
    price: { amountMinor: "9900", currency: "CNY", assumption: "首批测试价" },
    deliveryFormat: "在线文档与复盘会",
    duration: "7 天",
    acceptanceMethod: "完成五次访谈并形成结论",
    nextCustomerAction: "确认参与试用",
    risks: ["样本招募不足"],
  });
  await command("propose_commitment", {
    level: "commitment",
    description: "客户确认愿意按测试价试用",
    sourceRef: "interview-a",
  });
  const evidenceId = opportunity.commitmentEvidence[0]?.id;
  assert.ok(evidenceId);
  await command("confirm_commitment", { evidenceId });
  assert.equal(opportunity.evidenceLevel, "commitment");
  await command("decide", {
    decision: "pursue",
    rationale: "有明确承诺，同时保留免费替代方案风险",
  });
  assert.equal(opportunity.decision.choice, "pursue");
  assert.equal(opportunity.interviews[0].rawRecord, "我下载过模板，但不知道问题是否带有诱导性。");

  const exported = await responseJson(await host.dispatch(jsonRequest(
    `/v2/plugins/opc/opportunities/${opportunity.id}/exports`,
    { workspaceId: workspace.id, expectedStreamVersion: opportunity.streamVersion },
    "opc-export",
  )));
  assert.equal(exported.data.length, 6);
  assert.match(JSON.stringify(exported.data), /人工确认的承诺证据/u);
  const listed = await responseJson(await host.dispatch(new Request(
    `http://host.test/v2/deliverables?workspaceId=${workspace.id}`,
  )));
  assert.equal(listed.data.length, 6);
  assert.deepEqual(new Set(listed.data.map((item: any) => item.pluginId)), new Set(["opc"]));
  await host.close();
});

test("thread turn 只接受插件 Agent 与已连接模型，并原子排入 Worker Job", async () => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    modelProbe: async ({ preset }) => ({ models: preset.suggestedModels, defaultModel: preset.suggestedModels[0]! }),
  });
  const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "验证工作区", viewMode: "business", pluginIds: ["opc"],
  }, "turn-workspace")))).data;
  const pendingConnection = (await responseJson(await host.dispatch(jsonRequest("/v2/model-connections", {
    presetId: "deepseek", apiKey: "fixture-key", displayName: "DeepSeek",
  }, "turn-model")))).data;
  const connection = (await responseJson(await host.dispatch(jsonRequest(
    `/v2/model-connections/${pendingConnection.id}/probe`,
    { expectedStreamVersion: pendingConnection.streamVersion },
    "turn-model-probe",
  )))).data;
  const thread = (await responseJson(await host.dispatch(jsonRequest(`/v2/workspaces/${workspace.id}/threads`, {
    subject: "验证设计师机会", pluginId: "opc",
  }, "turn-thread")))).data;

  const requestBody = {
    expectedStreamVersion: thread.streamVersion,
    message: "整理证据缺口",
    agentDefinitionId: "opc.opportunity-validator",
    modelBindingId: connection.id,
  };
  const response = await host.dispatch(jsonRequest(
    `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`, requestBody, "turn-submit",
  ));
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const execution = (await responseJson(response)).data;
  assert.equal(execution.status, "queued");
  const authority = await store.transact("local", (transaction) =>
    transaction.getProjection<any>("authority", execution.authorityId));
  assert.deepEqual(authority.toolIds, ["opc.public-web.read"]);
  assert.equal(authority.commitment.length, 64);
  assert.equal(store.readJobs("local")[0]?.payload.executionId, execution.id);
  assert.equal(store.readOutbox("local")[0]?.topic, "job.available");
  const turns = await responseJson(await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
  )));
  assert.equal(turns.data.turns[0].execution.status, "queued");
  assert.deepEqual(turns.data.turns[0].entries.map((entry: any) => [entry.role, entry.content]), [
    ["user", "整理证据缺口"],
  ]);

  const replay = await host.dispatch(jsonRequest(
    `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`, requestBody, "turn-submit",
  ));
  assert.equal((await responseJson(replay)).data.id, execution.id);
  assert.equal(store.readJobs("local").length, 1);

  const invalidAgent = await host.dispatch(jsonRequest(
    `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`, {
      ...requestBody, expectedStreamVersion: 2, agentDefinitionId: "coding.builtin",
    }, "turn-invalid-agent",
  ));
  assert.equal(invalidAgent.status, 422);
  assert.equal(store.readJobs("local").length, 1);

  const running = await host.kernel.commandExecution(
    "local", "local-owner", "turn-worker-start", execution.id, execution.streamVersion, "start",
  );
  const followUpBody = {
    expectedStreamVersion: running.streamVersion,
    command: "follow_up",
    message: "先核对反证，再进入下一轮",
  };
  const followed = await host.dispatch(jsonRequest(
    `/v2/executions/${execution.id}/commands`, followUpBody, "turn-follow-up",
  ));
  assert.equal(followed.status, 202, JSON.stringify(await followed.clone().json()));
  const followedExecution = (await responseJson(followed)).data;
  assert.equal(followedExecution.status, "running");
  assert.equal(followedExecution.streamVersion, running.streamVersion + 1);
  const runtime = await store.transact("local", (transaction) =>
    transaction.getProjection<any>("agent-runtime", execution.id));
  assert.deepEqual(runtime.records.map((record: any) => [record.type, record.payload.kind, record.payload.text]), [
    ["inbox/enqueued", "follow_up", "先核对反证，再进入下一轮"],
  ]);
  const replayedFollowUp = await host.dispatch(jsonRequest(
    `/v2/executions/${execution.id}/commands`, followUpBody, "turn-follow-up",
  ));
  assert.equal((await responseJson(replayedFollowUp)).data.streamVersion, followedExecution.streamVersion);
  assert.equal((await store.transact("local", (transaction) =>
    transaction.getProjection<any>("agent-runtime", execution.id))).records.length, 1);

  const steered = await host.dispatch(jsonRequest(
    `/v2/executions/${execution.id}/commands`,
    {
      expectedStreamVersion: followedExecution.streamVersion,
      command: "steer",
      message: "下一次模型边界优先列出证据缺口",
    },
    "turn-steer",
  ));
  assert.equal(steered.status, 202);
  const steeredExecution = (await responseJson(steered)).data;
  const queuedInbox = await store.transact("local", (transaction) =>
    transaction.getProjection<any>("agent-runtime", execution.id));
  assert.deepEqual(queuedInbox.records.map((record: any) => record.payload.kind), [
    "follow_up",
    "steer",
  ]);

  const internalCommand = await host.dispatch(jsonRequest(
    `/v2/executions/${execution.id}/commands`,
    { expectedStreamVersion: steeredExecution.streamVersion, command: "complete" },
    "turn-internal-command",
  ));
  assert.equal(internalCommand.status, 422);
  assert.equal((await responseJson(internalCommand)).code, "EXECUTION_COMMAND_FORBIDDEN");
  await host.close();
});

test("Coding 任务原子绑定 Thread，并通过通用 turns 提交 builtin Execution", async () => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    modelProbe: async ({ preset }) => ({
      models: preset.suggestedModels,
      defaultModel: preset.suggestedModels[0]!,
    }),
  });
  const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "Coding 工作区", viewMode: "professional", pluginIds: ["coding"],
  }, "coding-thread-workspace")))).data;
  await host.dispatch(jsonRequest("/v2/plugins/coding/repositories", {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    input: "/Users/tester/product",
  }, "coding-thread-repository"));
  const pendingConnection = (await responseJson(await host.dispatch(jsonRequest("/v2/model-connections", {
    presetId: "deepseek", apiKey: "fixture-key", displayName: "DeepSeek",
  }, "coding-thread-model")))).data;
  const connection = (await responseJson(await host.dispatch(jsonRequest(
    `/v2/model-connections/${pendingConnection.id}/probe`,
    { expectedStreamVersion: pendingConnection.streamVersion },
    "coding-thread-model-probe",
  )))).data;
  const captureBody = {
    workspaceId: workspace.id,
    expectedStreamVersion: 0,
    input: "修复已提交事件在重启后丢失的问题",
  };
  const task = (await responseJson(await host.dispatch(jsonRequest(
    "/v2/plugins/coding/tasks", captureBody, "coding-thread-task",
  )))).data;
  const replayedTask = (await responseJson(await host.dispatch(jsonRequest(
    "/v2/plugins/coding/tasks", captureBody, "coding-thread-task",
  )))).data;
  assert.equal(replayedTask.id, task.id);

  const threads = (await responseJson(await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${workspace.id}/threads`,
  )))).data;
  assert.equal(threads.length, 1);
  assert.equal(threads[0].pluginId, "coding");
  assert.deepEqual(threads[0].resourceRef, {
    namespace: "coding.task",
    resourceId: task.id,
  });
  assert.equal(threads[0].subject, task.title);
  const capturedEvents = (await store.readEvents("local", 0, 100)).events.filter((event) =>
    (event.aggregateType === "coding.task" && event.aggregateId === task.id)
    || (event.aggregateType === "thread" && event.aggregateId === threads[0].id));
  assert.deepEqual(capturedEvents.map((event) => event.type), [
    "coding.task_captured",
    "thread.created",
  ]);
  assert.equal(new Set(capturedEvents.map((event) => event.correlationId)).size, 1);

  const response = await host.dispatch(jsonRequest(
    `/v2/workspaces/${workspace.id}/threads/${threads[0].id}/turns`,
    {
      expectedStreamVersion: threads[0].streamVersion,
      message: task.request,
      agentDefinitionId: "coding.builtin",
      modelBindingId: connection.id,
    },
    "coding-thread-turn",
  ));
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const execution = (await responseJson(response)).data;
  assert.equal(execution.pluginId, "coding");
  assert.equal(execution.agentDefinitionId, "coding.builtin");
  assert.equal(execution.status, "queued");
  const authority = await store.transact("local", (transaction) =>
    transaction.getProjection<any>("authority", execution.authorityId));
  assert.deepEqual(authority.toolIds, [
    "coding.repository.read",
    "coding.sandbox.write",
    "coding.gate.verify",
    "coding.candidate.accept",
  ]);
  assert.equal(store.readJobs("local").length, 1);
  assert.equal(store.readJobs("local")[0]?.payload.executionId, execution.id);
  await host.close();
});

test("记忆可审阅修正，撤销共享会使派生记忆失效，删除写入 tombstone", async () => {
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(), secretStore: secrets });
  const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "记忆工作区", viewMode: "business", pluginIds: ["opc", "coding"],
  }, "memory-workspace")))).data;
  const proposed = (await responseJson(await host.dispatch(jsonRequest("/v2/memories", {
    workspaceId: workspace.id,
    scopeType: "resource",
    namespace: "opc",
    resourceId: "opportunity-1",
    sourceEventId: "event-interview",
    confidence: 0.5,
    value: { summary: "客户可能关注速度" },
  }, "memory-propose")))).data;
  const revised = (await responseJson(await host.dispatch(jsonRequest(`/v2/memories/${proposed.id}`, {
    expectedStreamVersion: proposed.streamVersion,
    confidence: 0.9,
    value: { summary: "客户明确关注恢复速度" },
  }, "memory-revise", "PATCH")))).data;
  assert.equal(revised.value.summary, "客户明确关注恢复速度");
  const accepted = (await responseJson(await host.dispatch(jsonRequest(
    `/v2/memories/${proposed.id}/decisions`,
    { expectedStreamVersion: revised.streamVersion, decision: "accept" },
    "memory-accept",
  )))).data;
  const grant = (await responseJson(await host.dispatch(jsonRequest("/v2/share-grants", {
    memoryId: accepted.id,
    expectedStreamVersion: accepted.streamVersion,
    toNamespace: "coding",
  }, "memory-share")))).data;
  const derived = (await responseJson(await host.dispatch(jsonRequest("/v2/memories", {
    workspaceId: workspace.id,
    scopeType: "resource",
    namespace: "coding",
    resourceId: "repository-1",
    sourceEventId: "event-derived",
    confidence: 0.7,
    value: { summary: "把恢复速度加入 Gate" },
    derivedFromMemoryId: accepted.id,
    derivedViaShareGrantId: grant.id,
  }, "memory-derived")))).data;
  const revoked = await host.dispatch(jsonRequest(`/v2/share-grants/${grant.id}`, {
    expectedStreamVersion: grant.streamVersion,
  }, "memory-revoke", "DELETE"));
  assert.equal(revoked.status, 200);
  const memoriesAfterRevoke = (await responseJson(await host.dispatch(
    new Request(`http://host.test/v2/memories?workspaceId=${workspace.id}`),
  ))).data;
  assert.equal(memoriesAfterRevoke.find((memory: any) => memory.id === derived.id).status, "invalidated");

  const sourceAfterShare = memoriesAfterRevoke.find((memory: any) => memory.id === accepted.id);
  const deleted = await host.dispatch(jsonRequest(`/v2/memories/${accepted.id}`, {
    expectedStreamVersion: sourceAfterShare.streamVersion,
    reason: "用户主动删除",
  }, "memory-delete", "DELETE"));
  assert.equal(deleted.status, 200);
  assert.equal((await responseJson(deleted)).data.status, "deleted");
  await host.close();
});

test("只提供 /v2，mutation 强制幂等键并稳定重放", async () => {
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(), secretStore: secrets });
  const old = await host.dispatch(new Request("http://host.test/v1/health"));
  assert.equal(old.status, 404);
  assert.equal((await responseJson(old)).code, "NOT_FOUND");

  const missing = await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "木牛", viewMode: "business", pluginIds: [],
  }));
  assert.equal(missing.status, 400);
  assert.equal((await responseJson(missing)).code, "IDEMPOTENCY_KEY_REQUIRED");

  const first = await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "木牛", viewMode: "business", pluginIds: [],
  }, "workspace-1"));
  const replay = await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "木牛", viewMode: "business", pluginIds: [],
  }, "workspace-1"));
  assert.equal(first.status, 201);
  const replayBody = await responseJson(replay);
  const firstBody = await responseJson(first);
  assert.deepEqual(replayBody.data, firstBody.data);
  assert.equal(typeof replayBody.traceId, "string");
  await host.close();
});

test("不可用插件不会留下幽灵工作区", async () => {
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(), secretStore: secrets });
  const rejected = await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "不应创建",
    viewMode: "business",
    pluginIds: ["unknown"],
  }, "unknown-plugin"));
  assert.equal(rejected.status, 422);
  const workspaces = await responseJson(await host.dispatch(new Request("http://host.test/v2/workspaces")));
  assert.deepEqual(workspaces.data, []);
  await host.close();
});

test("实体版本冲突返回统一 409 错误", async () => {
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(), secretStore: secrets });
  const created = await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "A", viewMode: "business", pluginIds: [],
  }, "create-a")));
  const response = await host.dispatch(jsonRequest(`/v2/workspaces/${created.data.id}`, {
    expectedStreamVersion: 0,
    name: "B",
  }, "update-a", "PATCH"));
  assert.equal(response.status, 409);
  assert.deepEqual(Object.keys(await responseJson(response)).sort(), [
    "action", "code", "fieldIssues", "message", "retryable", "traceId",
  ]);
  await host.close();
});

test("过期 SSE 游标返回 410，事件使用 tenant position 作为 id", async () => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({ store, secretStore: secrets });
  const workspace = await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "A", viewMode: "business", pluginIds: [],
  }, "create-events")));
  const stream = await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${workspace.data.id}/events`,
    { headers: { "Last-Event-ID": "0" } },
  ));
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  assert.match(await readSseUntil(reader, (body) => /^id: 2$/m.test(body)), /^id: 2$/m);
  await reader.cancel();
  await host.close();

  const expiredStore = {
    ...store,
    transact: store.transact.bind(store),
    async readEvents() { throw new CursorExpiredError("local", 9); },
  };
  const expiredHost = await createAgentOsHost({ store: expiredStore, secretStore: secrets });
  const expired = await expiredHost.dispatch(new Request(
    `http://host.test/v2/workspaces/${workspace.data.id}/events`,
    { headers: { "Last-Event-ID": "2" } },
  ));
  assert.equal(expired.status, 410);
  assert.match(expired.headers.get("content-type") ?? "", /^application\/json/u);
  assert.equal((await responseJson(expired)).code, "EVENT_CURSOR_EXPIRED");
  await expiredHost.close();
});

test("工作区 SSE 保持 tenant position 游标但不泄露其他工作区事件", async () => {
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(), secretStore: secrets });
  const first = await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "仅工作区 A 可见", viewMode: "business", pluginIds: [],
  }, "event-a")));
  await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "绝不能出现在 A 的流中", viewMode: "business", pluginIds: [],
  }, "event-b"));
  const response = await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${first.data.id}/events`,
    { headers: { "Last-Event-ID": "0" } },
  ));
  const reader = response.body!.getReader();
  const body = await readSseUntil(reader, (candidate) => /"position":3/.test(candidate));
  assert.match(body, /仅工作区 A 可见/);
  assert.doesNotMatch(body, /绝不能出现在 A 的流中/);
  assert.match(body, /"position":3/);
  assert.match(body, /^id: 3$/m);
  await reader.cancel();
  await host.close();
});

test("工作区 SSE 持续推送、过滤事件时推进 tenant 游标并支持 Last-Event-ID", async () => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    ssePollIntervalMs: 5,
    sseKeepAliveIntervalMs: 50,
  });
  const first = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "持续流 A", viewMode: "business", pluginIds: [],
  }, "continuous-a")))).data;
  const second = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "持续流 B", viewMode: "business", pluginIds: [],
  }, "continuous-b")))).data;

  const response = await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${first.id}/events`,
    { headers: { "Last-Event-ID": "0" } },
  ));
  const reader = response.body!.getReader();
  const initial = await readSseUntil(reader, (body) => /^id: 3$/m.test(body));
  assert.match(initial, /持续流 A/u);
  assert.doesNotMatch(initial, /持续流 B/u);

  const secondUpdate = await host.dispatch(jsonRequest(`/v2/workspaces/${second.id}`, {
    expectedStreamVersion: second.streamVersion,
    name: "不得泄露的 B 更新",
  }, "continuous-b-update", "PATCH"));
  assert.equal(secondUpdate.status, 200);
  const filtered = await readSseUntil(reader, (body) => /^id: 4$/m.test(body));
  assert.match(filtered, /event: cursor/u);
  assert.doesNotMatch(filtered, /不得泄露的 B 更新/u);

  const firstUpdate = await host.dispatch(jsonRequest(`/v2/workspaces/${first.id}`, {
    expectedStreamVersion: first.streamVersion,
    name: "持续流 A 已更新",
  }, "continuous-a-update", "PATCH"));
  assert.equal(firstUpdate.status, 200);
  const visible = await readSseUntil(reader, (body) => /持续流 A 已更新/u.test(body));
  assert.match(visible, /^id: 5$/m);
  await reader.cancel();

  const resumed = await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${first.id}/events`,
    { headers: { "Last-Event-ID": "4" } },
  ));
  const resumedReader = resumed.body!.getReader();
  const resumedBody = await readSseUntil(resumedReader, (body) => /持续流 A 已更新/u.test(body));
  assert.doesNotMatch(resumedBody, /name":"持续流 A"[,}]/u);
  assert.match(resumedBody, /^id: 5$/m);
  await resumedReader.cancel();
  await host.close();
});

test("工作区 SSE 空闲时发送 keepalive，客户端取消后停止轮询", async () => {
  const base = new InMemoryKernelStore();
  let reads = 0;
  const store = {
    transact: base.transact.bind(base),
    async readEvents(tenantId: string, afterPosition: number, limit: number) {
      reads += 1;
      return base.readEvents(tenantId, afterPosition, limit);
    },
  };
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    ssePollIntervalMs: 5,
    sseKeepAliveIntervalMs: 12,
  });
  const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "取消轮询", viewMode: "business", pluginIds: [],
  }, "cancel-poll")))).data;
  const response = await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${workspace.id}/events`,
    { headers: { "Last-Event-ID": "2" } },
  ));
  const reader = response.body!.getReader();
  assert.match(await readSseUntil(reader, (body) => /: keepalive/u.test(body)), /: keepalive/u);
  await reader.cancel();
  const readsAtCancel = reads;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads, readsAtCancel);
  await host.close();
});

test("插件故障只降级对应插件，核心与其他插件保持健康", async () => {
  const host = await createAgentOsHost({
    store: new InMemoryKernelStore(), officialPlugins: [healthyPlugin, failingPlugin], secretStore: secrets,
  });
  const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "插件测试", viewMode: "professional", pluginIds: [],
  }, "plugin-workspace")))).data;
  for (const [index, pluginId] of ["healthy", "failing"].entries()) {
    const activation = await host.dispatch(jsonRequest(`/v2/workspaces/${workspace.id}/plugin-activations`, {
      expectedStreamVersion: index + 1,
      pluginId,
    }, `activate-${pluginId}`));
    assert.equal(activation.status, 200);
  }
  const failure = await host.dispatch(jsonRequest("/v2/plugins/failing/explode", {
    expectedStreamVersion: 0, workspaceId: workspace.id,
  }, "explode"));
  assert.equal(failure.status, 502);
  assert.doesNotMatch(JSON.stringify(await responseJson(failure)), /secret plugin detail/);

  const health = await responseJson(await host.dispatch(new Request(
    `http://host.test/v2/health?workspaceId=${workspace.id}`,
  )));
  assert.equal(health.data.core.status, "healthy");
  assert.equal(health.data.plugins.find((item: any) => item.pluginId === "failing").status, "degraded");
  assert.equal(health.data.plugins.find((item: any) => item.pluginId === "healthy").status, "healthy");
  await host.close();
});

test("模型连接只接受厂商预设，密钥写入 v2 Keychain 后探测默认模型", async () => {
  const saved: string[] = [];
  let probeCount = 0;
  const host = await createAgentOsHost({
    store: new InMemoryKernelStore(),
    secretStore: {
      async save(id, value) { saved.push(value); return `keychain://muniu.v2/${id}`; },
      async read() { return "stored"; },
    },
    modelProbe: async ({ preset, apiKey }) => {
      probeCount += 1;
      assert.equal(preset.id, "deepseek");
      assert.equal(apiKey, "stored");
      return { models: ["deepseek-chat", "deepseek-reasoner"], defaultModel: "deepseek-chat" };
    },
  });
  const rejected = await host.dispatch(jsonRequest("/v2/model-connections", {
    presetId: "deepseek", apiKey: "secret", baseUrl: "https://evil.test",
  }, "model-invalid"));
  assert.equal(rejected.status, 422);
  const created = await responseJson(await host.dispatch(jsonRequest("/v2/model-connections", {
    presetId: "deepseek", apiKey: "secret", displayName: "DeepSeek",
  }, "model-create")));
  assert.deepEqual(saved, ["secret"]);
  assert.equal(JSON.stringify(created).includes("secret"), false);
  const probed = await responseJson(await host.dispatch(jsonRequest(
    `/v2/model-connections/${created.data.id}/probe`,
    { expectedStreamVersion: 1 },
    "model-probe",
  )));
  assert.equal(probed.data.defaultModel, "deepseek-chat");
  assert.equal(probed.data.status, "ready");
  const replayed = await responseJson(await host.dispatch(jsonRequest(
    `/v2/model-connections/${created.data.id}/probe`,
    { expectedStreamVersion: 1 },
    "model-probe",
  )));
  assert.deepEqual(replayed.data, probed.data);
  assert.equal(probeCount, 1);
  await host.close();
});

test("企业模型连接只接受组合根配置的 v2 Vault 引用", async () => {
  const host = await createAgentOsHost({
    profile: "enterprise",
    store: new InMemoryKernelStore(),
    secretStore: {
      async save(id) { return `vault://muniu/v2/${id}`; },
      async read() { return "stored"; },
    },
    identityResolver() { return { tenantId: "tenant-a", principalId: "owner" }; },
  });
  const response = await host.dispatch(new Request("http://host.test/v2/model-connections", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "enterprise-model",
      authorization: "Bearer enterprise",
    },
    body: JSON.stringify({ presetId: "openai", apiKey: "secret" }),
  }));
  assert.equal(response.status, 201);
  assert.equal(JSON.stringify(await responseJson(response)).includes("vault://"), false);
  await host.close();
});

test("本地权威状态固定在 ~/.muniu/v2，不触碰旧目录", () => {
  assert.deepEqual(defaultLocalStatePaths("/Users/tester"), {
    root: "/Users/tester/.muniu/v2",
    database: "/Users/tester/.muniu/v2/state.sqlite3",
    cas: "/Users/tester/.muniu/v2/cas",
  });
});

test("企业 profile 强制身份上下文并隔离 tenant", async () => {
  const host = await createAgentOsHost({
    profile: "enterprise", store: new InMemoryKernelStore(), secretStore: secrets,
    identityResolver(request) {
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/u, "") ?? "";
      return token.startsWith("tenant-")
        ? { tenantId: token, principalId: `${token}-owner`, organizationRoles: ["organization_admin"] as const }
        : { tenantId: "", principalId: "" };
    },
  });
  const missing = await host.dispatch(new Request("http://host.test/v2/workspaces"));
  assert.equal(missing.status, 401);

  const spoofed = await host.dispatch(new Request("http://host.test/v2/workspaces", {
    headers: { "X-Muniu-Tenant-Id": "tenant-a", "X-Muniu-Principal-Id": "tenant-a-owner" },
  }));
  assert.equal(spoofed.status, 401);

  const headers = (tenantId: string, mutation = false) => ({
    authorization: `Bearer ${tenantId}`,
    ...(mutation ? { "content-type": "application/json", "Idempotency-Key": "same-key" } : {}),
  });
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    const response = await host.dispatch(new Request("http://host.test/v2/workspaces", {
      method: "POST",
      headers: headers(tenantId, true),
      body: JSON.stringify({ name: tenantId, viewMode: "professional", pluginIds: [] }),
    }));
    assert.equal(response.status, 201);
  }
  const listA = await responseJson(await host.dispatch(new Request("http://host.test/v2/workspaces", {
    headers: headers("tenant-a"),
  })));
  const listB = await responseJson(await host.dispatch(new Request("http://host.test/v2/workspaces", {
    headers: headers("tenant-b"),
  })));
  assert.deepEqual(listA.data.map((workspace: any) => workspace.name), ["tenant-a"]);
  assert.deepEqual(listB.data.map((workspace: any) => workspace.name), ["tenant-b"]);
  await host.close();
});

test("企业工作区创建要求组织管理员并保留经验证的组织角色", async () => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({
    profile: "enterprise",
    store,
    secretStore: secrets,
    identityResolver(request) {
      const principalId = request.headers.get("authorization")?.replace(/^Bearer\s+/u, "") ?? "";
      return principalId === "owner"
        ? {
            tenantId: "tenant-a",
            principalId,
            organizationRoles: ["organization_admin", "auditor"] as const,
          }
        : principalId
          ? { tenantId: "tenant-a", principalId, organizationRoles: [] as const }
          : { tenantId: "", principalId: "", organizationRoles: [] as const };
    },
  });
  const create = (principalId: string, key: string) => host.dispatch(new Request("http://host.test/v2/workspaces", {
    method: "POST",
    headers: {
      authorization: `Bearer ${principalId}`,
      "content-type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ name: "受管工作区", viewMode: "professional", pluginIds: [] }),
  }));
  const denied = await create("member", "workspace-denied");
  assert.equal(denied.status, 403);
  assert.equal((await responseJson(denied)).code, "ORGANIZATION_ACCESS_DENIED");

  const allowed = await create("owner", "workspace-allowed");
  assert.equal(allowed.status, 201);
  const workspace = (await responseJson(allowed)).data;
  const membership = await store.transact("tenant-a", (transaction) =>
    transaction.getProjection<any>("membership", `${workspace.id}:owner`));
  assert.deepEqual(membership.organizationRoles, ["organization_admin", "auditor"]);
  await host.close();
});

test("企业插件供应链变更只允许组织管理员或治理管理员", async () => {
  let installCalls = 0;
  const host = await createAgentOsHost({
    profile: "enterprise",
    store: new InMemoryKernelStore(),
    secretStore: secrets,
    identityResolver(request) {
      const principalId = request.headers.get("authorization")?.replace(/^Bearer\s+/u, "") ?? "";
      const organizationRoles = principalId === "governance"
        ? ["governance_admin"] as const
        : principalId === "auditor" ? ["auditor"] as const : [] as const;
      return principalId ? { tenantId: "tenant-a", principalId, organizationRoles }
        : { tenantId: "", principalId: "", organizationRoles };
    },
    pluginInstaller: {
      async install() {
        installCalls += 1;
        return {
          id: "research",
          tenantId: "tenant-a",
          streamVersion: 1,
          createdAt: "2026-09-04T00:00:00.000Z",
          updatedAt: "2026-09-04T00:00:00.000Z",
          pluginId: "research",
          version: "0.2.0",
          packageSha256: "a".repeat(64),
          releaseSequence: 1,
          status: "installed",
          projectionNamespace: "research_v1",
          developmentMode: false,
        };
      },
    },
  });
  const install = (principalId: string, key: string) => host.dispatch(new Request(
    "http://host.test/v2/plugins/installations",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${principalId}`,
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ pluginId: "research", version: "0.2.0" }),
    },
  ));
  const denied = await install("auditor", "plugin-auditor-denied");
  assert.equal(denied.status, 403);
  assert.equal((await responseJson(denied)).code, "ORGANIZATION_ACCESS_DENIED");
  assert.equal(installCalls, 0);

  const allowed = await install("governance", "plugin-governance-allowed");
  assert.equal(allowed.status, 201);
  assert.equal(installCalls, 1);
  await host.close();
});

test("工作区所有者通过 v2 管理成员角色，移除后立即失去访问权", async () => {
  const host = await createAgentOsHost({
    profile: "enterprise",
    store: new InMemoryKernelStore(),
    secretStore: secrets,
    identityResolver(request) {
      const principalId = request.headers.get("authorization")?.replace(/^Bearer\s+/u, "") ?? "";
      return principalId
        ? {
            tenantId: "tenant-a",
            principalId,
            organizationRoles: principalId === "owner" ? ["organization_admin"] as const : [],
          }
        : { tenantId: "", principalId: "", organizationRoles: [] as const };
    },
  });
  const mutation = (principalId: string, path: string, key: string, method: string, body: unknown) =>
    host.dispatch(new Request(`http://host.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${principalId}`,
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    }));
  const created = (await responseJson(await mutation("owner", "/v2/workspaces", "members-workspace", "POST", {
    name: "成员工作区", viewMode: "professional", pluginIds: [],
  }))).data;
  const memberPath = `/v2/workspaces/${created.id}/members/reviewer-a`;
  const addedResponse = await mutation("owner", memberPath, "member-add", "PUT", {
    expectedStreamVersion: 0,
    workspaceRole: "reviewer",
  });
  assert.equal(addedResponse.status, 200);
  const added = (await responseJson(addedResponse)).data;
  assert.equal(added.workspaceRole, "reviewer");

  const membersResponse = await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${created.id}/members`,
    { headers: { authorization: "Bearer reviewer-a" } },
  ));
  assert.equal(membersResponse.status, 200);
  assert.deepEqual((await responseJson(membersResponse)).data.map((item: any) => item.principalId), [
    "owner",
    "reviewer-a",
  ]);
  const denied = await mutation("reviewer-a", memberPath, "member-self-promote", "PUT", {
    expectedStreamVersion: added.streamVersion,
    workspaceRole: "owner",
  });
  assert.equal(denied.status, 403);

  const removedResponse = await mutation("owner", memberPath, "member-remove", "DELETE", {
    expectedStreamVersion: added.streamVersion,
  });
  assert.equal(removedResponse.status, 200);
  const revokedAccess = await host.dispatch(new Request(`http://host.test/v2/workspaces/${created.id}`, {
    headers: { authorization: "Bearer reviewer-a" },
  }));
  assert.equal(revokedAccess.status, 403);
  const removeLastOwner = await mutation(
    "owner",
    `/v2/workspaces/${created.id}/members/owner`,
    "member-remove-last-owner",
    "DELETE",
    { expectedStreamVersion: 1 },
  );
  assert.equal(removeLastOwner.status, 422);
  assert.equal((await responseJson(removeLastOwner)).code, "LAST_WORKSPACE_OWNER");
  await host.close();
});

test("同一 tenant 内仍按工作区成员隔离", async () => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({
    profile: "enterprise",
    store,
    secretStore: secrets,
    identityResolver(request) {
      const principalId = request.headers.get("authorization")?.replace(/^Bearer\s+/u, "") ?? "";
      return principalId
        ? { tenantId: "tenant-a", principalId, organizationRoles: ["organization_admin"] as const }
        : { tenantId: "", principalId: "" };
    },
  });
  const ownerHeaders = {
    authorization: "Bearer owner",
    "content-type": "application/json",
    "Idempotency-Key": "workspace-private",
  };
  const created = await responseJson(await host.dispatch(new Request("http://host.test/v2/workspaces", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ name: "私有工作区", viewMode: "business", pluginIds: [] }),
  })));
  const viewerList = await responseJson(await host.dispatch(new Request("http://host.test/v2/workspaces", {
    headers: { authorization: "Bearer viewer" },
  })));
  assert.deepEqual(viewerList.data, []);
  const direct = await host.dispatch(new Request(`http://host.test/v2/workspaces/${created.data.id}`, {
    headers: { authorization: "Bearer viewer" },
  }));
  assert.equal(direct.status, 403);
  await store.transact("tenant-a", (transaction) => {
    transaction.putProjection("membership", `${created.data.id}:viewer`, {
      id: `${created.data.id}:viewer`,
      tenantId: "tenant-a",
      workspaceId: created.data.id,
      principalId: "viewer",
      organizationRoles: [],
      workspaceRole: "viewer",
      streamVersion: 1,
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
  });
  const canRead = await host.dispatch(new Request(`http://host.test/v2/workspaces/${created.data.id}`, {
    headers: { authorization: "Bearer viewer" },
  }));
  assert.equal(canRead.status, 200);
  const cannotMutate = await host.dispatch(new Request(`http://host.test/v2/workspaces/${created.data.id}`, {
    method: "PATCH",
    headers: {
      authorization: "Bearer viewer",
      "content-type": "application/json",
      "Idempotency-Key": "viewer-update",
    },
    body: JSON.stringify({ expectedStreamVersion: created.data.streamVersion, name: "越权修改" }),
  }));
  assert.equal(cannotMutate.status, 403);
  await host.close();
});

test("SQLite 重启后保留已提交事件与投影", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-host-v2-"));
  const databaseFile = join(directory, "state.sqlite3");
  const hmacKey = Buffer.alloc(32, 7);
  try {
    const first = await createAgentOsHost({
      store: new SqliteStorage({ databaseFile, hmacKey }), secretStore: secrets,
    });
    const created = await responseJson(await first.dispatch(jsonRequest("/v2/workspaces", {
      name: "可恢复工作区", viewMode: "business", pluginIds: ["opc"],
    }, "sqlite-create")));
    const opportunityResponse = await first.dispatch(jsonRequest("/v2/plugins/opc/opportunities", {
      workspaceId: created.data.id,
      expectedStreamVersion: 0,
      input: "面向自由职业者，解决需求验证周期过长的问题",
    }, "sqlite-opportunity"));
    assert.equal(opportunityResponse.status, 201);
    const opportunity = (await responseJson(opportunityResponse)).data;
    const frameBody = {
      workspaceId: created.data.id,
      expectedStreamVersion: opportunity.streamVersion,
      command: "frame",
      input: {
        targetCustomer: "自由职业者",
        problem: "需求验证周期过长",
        falsifiableHypothesis: "五次访谈内至少一人承诺采取下一步",
      },
    };
    const framed = await first.dispatch(jsonRequest(
      `/v2/plugins/opc/opportunities/${opportunity.id}/commands`, frameBody, "sqlite-frame",
    ));
    assert.equal(framed.status, 200);
    assert.equal((await responseJson(framed)).data.streamVersion, 2);
    await first.close();

    const second = await createAgentOsHost({
      store: new SqliteStorage({ databaseFile, hmacKey }), secretStore: secrets,
    });
    const listed = await responseJson(await second.dispatch(new Request("http://host.test/v2/workspaces")));
    assert.deepEqual(listed.data.map((workspace: any) => workspace.id), [created.data.id]);
    const opportunities = await responseJson(await second.dispatch(new Request(
      `http://host.test/v2/plugins/opc/opportunities?workspaceId=${created.data.id}`,
    )));
    assert.equal(opportunities.data.length, 1);
    const replayedFrame = await second.dispatch(jsonRequest(
      `/v2/plugins/opc/opportunities/${opportunity.id}/commands`, frameBody, "sqlite-frame",
    ));
    assert.equal(replayedFrame.status, 200);
    assert.equal((await responseJson(replayedFrame)).data.streamVersion, 2);
    const restored = await responseJson(await second.dispatch(new Request(
      `http://host.test/v2/plugins/opc/opportunities/${opportunity.id}?workspaceId=${created.data.id}`,
    )));
    assert.equal(restored.data.hypotheses[0].targetCustomer, "自由职业者");
    const captureAfterRestart = await second.dispatch(jsonRequest("/v2/plugins/opc/opportunities", {
      workspaceId: created.data.id,
      expectedStreamVersion: 0,
      input: "面向小团队，解决访谈证据分散的问题",
    }, "sqlite-opportunity-after-restart"));
    assert.equal(captureAfterRestart.status, 201);
    const events = await second.dispatch(new Request(
      `http://host.test/v2/workspaces/${created.data.id}/events`,
      { headers: { "Last-Event-ID": "0" } },
    ));
    const reader = events.body!.getReader();
    assert.match(await readSseUntil(reader, (body) => /event: kernel/u.test(body)), /event: kernel/u);
    await reader.cancel();
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node HTTP 适配器只转发同一 dispatch", async () => {
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(), secretStore: secrets });
  const address = await host.listen({ port: 0 });
  try {
    const health = await fetch(`http://${address.host}:${address.port}/v2/health`, {
      headers: { Origin: "tauri://localhost" },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), "tauri://localhost");
    assert.equal((await responseJson(health)).data.core.status, "healthy");
    const blocked = await fetch(`http://${address.host}:${address.port}/v2/health`, {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(blocked.status, 403);
    assert.equal((await responseJson(blocked)).code, "ORIGIN_NOT_ALLOWED");
    const legacy = await fetch(`http://${address.host}:${address.port}/v1/health`);
    assert.equal(legacy.status, 404);

    const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
      name: "HTTP 增量 SSE", viewMode: "business", pluginIds: [],
    }, "http-sse-workspace")))).data;
    const stream = await Promise.race([
      fetch(`http://${address.host}:${address.port}/v2/workspaces/${workspace.id}/events`, {
        headers: { Origin: "tauri://localhost", "Last-Event-ID": "2" },
      }),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("Node HTTP adapter buffered the SSE response")),
        500,
      )),
    ]);
    const reader = stream.body!.getReader();
    await host.dispatch(jsonRequest(`/v2/workspaces/${workspace.id}`, {
      expectedStreamVersion: workspace.streamVersion,
      name: "HTTP SSE 后续事件",
    }, "http-sse-update", "PATCH"));
    assert.match(
      await readSseUntil(reader, (body) => /HTTP SSE 后续事件/u.test(body)),
      /HTTP SSE 后续事件/u,
    );
    await reader.cancel();
  } finally {
    await host.close();
  }
});
