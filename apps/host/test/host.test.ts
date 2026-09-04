import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { InMemoryKernelStore } from "@mn/kernel";
import type { PluginDefinitionV1 } from "@mn/plugin-sdk";
import { CursorExpiredError, SqliteStorage } from "@mn/storage";
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
  assert.match(await stream.text(), /^id: 2$/m);
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
  const body = await response.text();
  assert.match(body, /仅工作区 A 可见/);
  assert.doesNotMatch(body, /绝不能出现在 A 的流中/);
  assert.match(body, /"position":3/);
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
        ? { tenantId: token, principalId: `${token}-owner` }
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

test("同一 tenant 内仍按工作区成员隔离", async () => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({
    profile: "enterprise",
    store,
    secretStore: secrets,
    identityResolver(request) {
      const principalId = request.headers.get("authorization")?.replace(/^Bearer\s+/u, "") ?? "";
      return principalId ? { tenantId: "tenant-a", principalId } : { tenantId: "", principalId: "" };
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
    const opportunity = await first.dispatch(jsonRequest("/v2/plugins/opc/opportunities", {
      workspaceId: created.data.id,
      expectedStreamVersion: 0,
      input: "面向自由职业者，解决需求验证周期过长的问题",
    }, "sqlite-opportunity"));
    assert.equal(opportunity.status, 201);
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
    assert.match(await events.text(), /event: kernel/);
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
  } finally {
    await host.close();
  }
});
