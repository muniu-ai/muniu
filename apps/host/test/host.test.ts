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
  });
  const missing = await host.dispatch(new Request("http://host.test/v2/workspaces"));
  assert.equal(missing.status, 401);

  const headers = (tenantId: string, mutation = false) => ({
    "X-Muniu-Tenant-Id": tenantId,
    "X-Muniu-Principal-Id": `${tenantId}-owner`,
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

test("SQLite 重启后保留已提交事件与投影", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-host-v2-"));
  const databaseFile = join(directory, "state.sqlite3");
  const hmacKey = Buffer.alloc(32, 7);
  try {
    const first = await createAgentOsHost({
      store: new SqliteStorage({ databaseFile, hmacKey }), secretStore: secrets,
    });
    const created = await responseJson(await first.dispatch(jsonRequest("/v2/workspaces", {
      name: "可恢复工作区", viewMode: "business", pluginIds: [],
    }, "sqlite-create")));
    await first.close();

    const second = await createAgentOsHost({
      store: new SqliteStorage({ databaseFile, hmacKey }), secretStore: secrets,
    });
    const listed = await responseJson(await second.dispatch(new Request("http://host.test/v2/workspaces")));
    assert.deepEqual(listed.data.map((workspace: any) => workspace.id), [created.data.id]);
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
    const health = await fetch(`http://${address.host}:${address.port}/v2/health`);
    assert.equal(health.status, 200);
    assert.equal((await responseJson(health)).data.core.status, "healthy");
    const legacy = await fetch(`http://${address.host}:${address.port}/v1/health`);
    assert.equal(legacy.status, 404);
  } finally {
    await host.close();
  }
});
