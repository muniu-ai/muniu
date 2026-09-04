// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ModelRequest } from "@mn/agent-runtime";
import { SqliteStorage } from "@mn/storage";
import type { ByokModelInvoker } from "@mn/worker";

import {
  startLocalAgentOsHost,
  type AgentOsHost,
  type LocalAgentOsSecretStore,
} from "../src/index.js";

class FixtureSecrets implements LocalAgentOsSecretStore {
  readonly #values = new Map<string, string>();

  async save(connectionId: string, apiKey: string): Promise<string> {
    const reference = `keychain://muniu.v2/model-${connectionId}`;
    this.#values.set(reference, apiKey);
    return reference;
  }

  async read(secretRef: string): Promise<string> {
    const value = this.#values.get(secretRef);
    if (!value) throw new Error("fixture secret missing");
    return value;
  }

  async getOrCreateBytes(): Promise<Buffer> {
    return Buffer.alloc(32, 17);
  }
}

function jsonRequest(path: string, body: unknown, key: string): Request {
  return new Request(`http://host.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

async function body(response: Response): Promise<any> {
  return response.json();
}

async function waitForCompletedTurn(host: AgentOsHost, path: string): Promise<any> {
  let latest: any;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await host.dispatch(new Request(`http://host.test${path}`));
    assert.equal(response.status, 200);
    const view = (await body(response)).data;
    latest = view;
    if (view.turns[0]?.execution.status === "completed") return view;
    if (["failed", "cancelled", "needs_reconciliation"].includes(view.turns[0]?.execution.status)) {
      throw new Error(`Execution 提前终止：${JSON.stringify(view.turns[0]?.execution)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Execution 未在测试时限内完成：${JSON.stringify(latest?.turns?.[0]?.execution)}`);
}

test("本地组合根执行 BYOK Agent turn，结果在 SQLite 重启后仍可读取", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-local-runtime-"));
  const secrets = new FixtureSecrets();
  const requests: ModelRequest[] = [];
  const invoke: ByokModelInvoker = async (input) => {
    assert.equal(input.presetId, "deepseek");
    assert.equal(input.model, "deepseek-chat");
    assert.equal(input.apiKey, "fixture-byok-key");
    assert.deepEqual(input.request.availableToolIds, ["opc.public-web.read"]);
    assert.match(input.request.messages[0]?.content ?? "", /反证/u);
    assert.equal(input.request.messages.at(-1)?.content, "整理当前证据缺口");
    requests.push(input.request);
    return { text: "支持证据不足；反证待补充。下一步由人工安排访谈。", toolCalls: [] };
  };
  let first: AgentOsHost | undefined;
  let second: AgentOsHost | undefined;
  try {
    first = await startLocalAgentOsHost({
      stateRoot: directory,
      port: 0,
      secretStore: secrets,
      modelInvoker: invoke,
      workerIdleDelayMs: 1,
      modelProbe: async ({ preset }) => ({
        models: preset.suggestedModels,
        defaultModel: preset.suggestedModels[0]!,
      }),
    });
    const workspace = (await body(await first.dispatch(jsonRequest("/v2/workspaces", {
      name: "本地执行", viewMode: "business", pluginIds: ["opc"],
    }, "runtime-workspace")))).data;
    const pendingModel = (await body(await first.dispatch(jsonRequest("/v2/model-connections", {
      presetId: "deepseek", apiKey: "fixture-byok-key", displayName: "DeepSeek",
    }, "runtime-model")))).data;
    const model = (await body(await first.dispatch(jsonRequest(
      `/v2/model-connections/${pendingModel.id}/probe`,
      { expectedStreamVersion: pendingModel.streamVersion },
      "runtime-model-probe",
    )))).data;
    const thread = (await body(await first.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads`,
      { subject: "验证访谈需求", pluginId: "opc" },
      "runtime-thread",
    )))).data;
    const submitted = await first.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
      {
        expectedStreamVersion: thread.streamVersion,
        message: "整理当前证据缺口",
        agentDefinitionId: "opc.opportunity-validator",
        modelBindingId: model.id,
      },
      "runtime-turn",
    ));
    assert.equal(submitted.status, 202, JSON.stringify(await submitted.clone().json()));
    const path = `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`;
    const completed = await waitForCompletedTurn(first, path);
    assert.equal(requests.length, 1);
    assert.equal(completed.turns.length, 1);
    assert.equal(completed.turns[0].entries.filter((entry: any) => entry.role === "user").length, 1);
    assert.deepEqual(completed.turns[0].entries.map((entry: any) => entry.role), ["user", "assistant"]);
    assert.match(completed.turns[0].entries[1].content, /下一步由人工安排访谈/u);
    await first.close();
    first = undefined;
    assert.doesNotMatch((await readFile(join(directory, "state.sqlite3"))).toString("utf8"), /fixture-byok-key/u);

    second = await startLocalAgentOsHost({
      stateRoot: directory,
      port: 0,
      secretStore: secrets,
      modelInvoker: invoke,
      workerIdleDelayMs: 1,
    });
    const restored = await waitForCompletedTurn(second, path);
    assert.equal(restored.turns[0].execution.status, "completed");
    assert.deepEqual(restored.turns[0].entries.map((entry: any) => entry.role), ["user", "assistant"]);
    assert.equal(requests.length, 1);
  } finally {
    await first?.close();
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("OPC Agent 通过统一 Runtime 和内核权限读取公开网页", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-local-runtime-web-"));
  const secrets = new FixtureSecrets();
  const requests: ModelRequest[] = [];
  const reads: string[] = [];
  const invoke: ByokModelInvoker = async ({ request }) => {
    requests.push(request);
    if (requests.length === 1) {
      assert.deepEqual(request.availableToolIds, ["opc.public-web.read"]);
      return {
        text: "",
        toolCalls: [{
          id: "web-call-1",
          toolId: "opc.public-web.read",
          arguments: { url: "https://example.com/research" },
          intent: "读取公开研究资料",
        }],
      };
    }
    assert.ok(request.messages.some((message) =>
      message.role === "tool"
      && message.name === "opc.public-web.read"
      && message.content.includes("公开访谈证据")));
    return { text: "已记录公开来源，并标记为支持信号。", toolCalls: [] };
  };
  let host: AgentOsHost | undefined;
  try {
    host = await startLocalAgentOsHost({
      stateRoot: directory,
      port: 0,
      secretStore: secrets,
      modelInvoker: invoke,
      workerIdleDelayMs: 1,
      opcPublicWebReader: {
        async read(url) {
          reads.push(url);
          return {
            finalUrl: url, status: 200, mediaType: "text/plain",
            body: "公开访谈证据", byteLength: 24, redirects: 0,
          };
        },
      },
      modelProbe: async ({ preset }) => ({
        models: preset.suggestedModels,
        defaultModel: preset.suggestedModels[0]!,
      }),
    });
    const workspace = (await body(await host.dispatch(jsonRequest("/v2/workspaces", {
      name: "公开资料研究", viewMode: "professional", pluginIds: ["opc"],
    }, "web-workspace")))).data;
    const pendingModel = (await body(await host.dispatch(jsonRequest("/v2/model-connections", {
      presetId: "deepseek", apiKey: "fixture-byok-key", displayName: "DeepSeek",
    }, "web-model")))).data;
    const model = (await body(await host.dispatch(jsonRequest(
      `/v2/model-connections/${pendingModel.id}/probe`,
      { expectedStreamVersion: pendingModel.streamVersion },
      "web-model-probe",
    )))).data;
    const thread = (await body(await host.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads`,
      { subject: "公开资料", pluginId: "opc" },
      "web-thread",
    )))).data;
    const submitted = await host.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
      {
        expectedStreamVersion: thread.streamVersion,
        message: "读取公开资料并整理信号",
        agentDefinitionId: "opc.opportunity-validator",
        modelBindingId: model.id,
      },
      "web-turn",
    ));
    assert.equal(submitted.status, 202, JSON.stringify(await submitted.clone().json()));
    const completed = await waitForCompletedTurn(
      host,
      `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
    );
    assert.deepEqual(reads, ["https://example.com/research"]);
    assert.equal(requests.length, 2);
    assert.deepEqual(completed.turns[0].entries.map((entry: any) => entry.role), [
      "user", "tool", "assistant",
    ]);
  } finally {
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("follow_up 按 FIFO 进入下一 turn，steer 只在下一模型边界注入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-local-runtime-inbox-"));
  const secrets = new FixtureSecrets();
  const requests: ModelRequest[] = [];
  let firstModelStarted!: () => void;
  let releaseFirstModel!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstModelStarted = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirstModel = resolve; });
  const invoke: ByokModelInvoker = async ({ request }) => {
    requests.push(request);
    if (requests.length === 1) {
      firstModelStarted();
      await firstRelease;
      return { text: "第一轮完成", toolCalls: [] };
    }
    return { text: "第二轮已按引导处理", toolCalls: [] };
  };
  let host: AgentOsHost | undefined;
  try {
    host = await startLocalAgentOsHost({
      stateRoot: directory,
      port: 0,
      secretStore: secrets,
      modelInvoker: invoke,
      workerIdleDelayMs: 1,
      modelProbe: async ({ preset }) => ({
        models: preset.suggestedModels,
        defaultModel: preset.suggestedModels[0]!,
      }),
    });
    const workspace = (await body(await host.dispatch(jsonRequest("/v2/workspaces", {
      name: "持久收件箱", viewMode: "professional", pluginIds: ["opc"],
    }, "inbox-workspace")))).data;
    const pendingModel = (await body(await host.dispatch(jsonRequest("/v2/model-connections", {
      presetId: "deepseek", apiKey: "fixture-byok-key", displayName: "DeepSeek",
    }, "inbox-model")))).data;
    const model = (await body(await host.dispatch(jsonRequest(
      `/v2/model-connections/${pendingModel.id}/probe`,
      { expectedStreamVersion: pendingModel.streamVersion },
      "inbox-model-probe",
    )))).data;
    const thread = (await body(await host.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads`,
      { subject: "验证后续指令", pluginId: "opc" },
      "inbox-thread",
    )))).data;
    const execution = (await body(await host.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
      {
        expectedStreamVersion: thread.streamVersion,
        message: "先整理支持证据",
        agentDefinitionId: "opc.opportunity-validator",
        modelBindingId: model.id,
      },
      "inbox-turn",
    )))).data;
    await firstStarted;

    const turnsPath = `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`;
    const running = (await body(await host.dispatch(new Request(`http://host.test${turnsPath}`))))
      .data.turns[0].execution;
    assert.equal(running.status, "running");
    const followed = await host.dispatch(jsonRequest(
      `/v2/executions/${execution.id}/commands`,
      {
        expectedStreamVersion: running.streamVersion,
        command: "follow_up",
        message: "再整理反证",
      },
      "inbox-follow-up",
    ));
    assert.equal(followed.status, 202, JSON.stringify(await followed.clone().json()));
    const followedExecution = (await body(followed)).data;
    const steered = await host.dispatch(jsonRequest(
      `/v2/executions/${execution.id}/commands`,
      {
        expectedStreamVersion: followedExecution.streamVersion,
        command: "steer",
        message: "优先指出证据缺口",
      },
      "inbox-steer",
    ));
    assert.equal(steered.status, 202, JSON.stringify(await steered.clone().json()));
    releaseFirstModel();

    const completed = await waitForCompletedTurn(host, turnsPath);
    assert.equal(completed.turns[0].execution.status, "completed");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.messages.at(-1)?.content, "先整理支持证据");
    assert.equal(requests[0]?.messages.some((message) => message.content.startsWith("[steer]")), false);
    assert.equal(requests[1]?.messages.filter((message) => message.role === "user").at(-1)?.content, "再整理反证");
    assert.ok(requests[1]?.messages.some((message) =>
      message.role === "system" && message.content === "[steer] 优先指出证据缺口"));
  } finally {
    releaseFirstModel?.();
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("关闭本地 Host 会中断在途模型后再关闭 SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-local-runtime-stop-"));
  const secrets = new FixtureSecrets();
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const invoke: ByokModelInvoker = async ({ signal }) => {
    modelStarted();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return { text: "不可达", toolCalls: [] };
  };
  let host: AgentOsHost | undefined;
  let executionId = "";
  try {
    host = await startLocalAgentOsHost({
      stateRoot: directory,
      port: 0,
      secretStore: secrets,
      modelInvoker: invoke,
      workerIdleDelayMs: 1,
      modelProbe: async ({ preset }) => ({
        models: preset.suggestedModels,
        defaultModel: preset.suggestedModels[0]!,
      }),
    });
    const workspace = (await body(await host.dispatch(jsonRequest("/v2/workspaces", {
      name: "停止测试", viewMode: "business", pluginIds: ["opc"],
    }, "stop-workspace")))).data;
    const pendingModel = (await body(await host.dispatch(jsonRequest("/v2/model-connections", {
      presetId: "deepseek", apiKey: "fixture-byok-key", displayName: "DeepSeek",
    }, "stop-model")))).data;
    const model = (await body(await host.dispatch(jsonRequest(
      `/v2/model-connections/${pendingModel.id}/probe`,
      { expectedStreamVersion: pendingModel.streamVersion },
      "stop-model-probe",
    )))).data;
    const thread = (await body(await host.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads`,
      { subject: "停止中的任务", pluginId: "opc" },
      "stop-thread",
    )))).data;
    const submitted = await host.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
      {
        expectedStreamVersion: thread.streamVersion,
        message: "开始长任务",
        agentDefinitionId: "opc.opportunity-validator",
        modelBindingId: model.id,
      },
      "stop-turn",
    ));
    executionId = (await body(submitted)).data.id;
    await started;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        host.close(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Host 关闭超时")), 1_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    host = undefined;
    const inspected = new SqliteStorage({
      databaseFile: join(directory, "state.sqlite3"),
      hmacKey: Buffer.alloc(32, 17),
    });
    const state = await inspected.transact("local", (transaction) => ({
      execution: transaction.getProjection<any>("execution", executionId),
      runtime: transaction.getProjection<any>("agent-runtime", executionId),
      job: transaction.listProjections<any>("job")
        .find((candidate) => candidate.payload.executionId === executionId),
    }));
    assert.equal(state.runtime.records.at(-1).payload.status, "interrupted");
    assert.equal(state.execution.status, "interrupted");
    assert.equal(state.execution.finishedAt, undefined);
    assert.equal(state.job.status, "failed");
    assert.equal(state.job.failure.code, "EXECUTION_INTERRUPTED");
    await inspected.close();
  } finally {
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("取消在途 Execution 会中止模型并终结 Job，重启后不再认领", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-local-runtime-cancel-"));
  const secrets = new FixtureSecrets();
  let modelStarted!: () => void;
  let modelAborted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { modelAborted = resolve; });
  let invocations = 0;
  const invoke: ByokModelInvoker = async ({ signal }) => {
    invocations += 1;
    modelStarted();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        modelAborted();
        reject(new Error("aborted"));
      }, { once: true });
    });
    return { text: "不可达", toolCalls: [] };
  };
  let first: AgentOsHost | undefined;
  let second: AgentOsHost | undefined;
  let executionId = "";
  try {
    first = await startLocalAgentOsHost({
      stateRoot: directory, port: 0, secretStore: secrets, modelInvoker: invoke,
      workerIdleDelayMs: 1,
      modelProbe: async ({ preset }) => ({
        models: preset.suggestedModels, defaultModel: preset.suggestedModels[0]!,
      }),
    });
    const workspace = (await body(await first.dispatch(jsonRequest("/v2/workspaces", {
      name: "取消执行", viewMode: "business", pluginIds: ["opc"],
    }, "cancel-workspace")))).data;
    const pendingModel = (await body(await first.dispatch(jsonRequest("/v2/model-connections", {
      presetId: "deepseek", apiKey: "fixture-byok-key", displayName: "DeepSeek",
    }, "cancel-model")))).data;
    const model = (await body(await first.dispatch(jsonRequest(
      `/v2/model-connections/${pendingModel.id}/probe`,
      { expectedStreamVersion: pendingModel.streamVersion },
      "cancel-model-probe",
    )))).data;
    const thread = (await body(await first.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads`,
      { subject: "取消中的任务", pluginId: "opc" },
      "cancel-thread",
    )))).data;
    const execution = (await body(await first.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
      {
        expectedStreamVersion: thread.streamVersion,
        message: "开始长任务后取消",
        agentDefinitionId: "opc.opportunity-validator",
        modelBindingId: model.id,
      },
      "cancel-turn",
    )))).data;
    executionId = execution.id;
    await started;

    const turnsPath = `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`;
    const running = (await body(await first.dispatch(new Request(`http://host.test${turnsPath}`))))
      .data.turns[0].execution;
    assert.equal(running.status, "running");
    const cancelledResponse = await first.dispatch(jsonRequest(
      `/v2/executions/${execution.id}/commands`,
      { expectedStreamVersion: running.streamVersion, command: "cancel" },
      "cancel-command",
    ));
    assert.equal(cancelledResponse.status, 200, JSON.stringify(await cancelledResponse.clone().json()));
    assert.equal((await body(cancelledResponse)).data.status, "cancelled");
    await aborted;
    await first.close();
    first = undefined;

    const inspected = new SqliteStorage({
      databaseFile: join(directory, "state.sqlite3"),
      hmacKey: Buffer.alloc(32, 17),
    });
    const state = await inspected.transact("local", (transaction) => ({
      execution: transaction.getProjection<any>("execution", executionId),
      job: transaction.listProjections<any>("job")
        .find((candidate) => candidate.payload.executionId === executionId),
    }));
    const physicalJob = await inspected.getJob(state.job.id);
    assert.equal(state.execution.status, "cancelled");
    assert.equal(state.job.status, "failed");
    assert.equal(state.job.failure.code, "EXECUTION_CANCELLED");
    assert.equal(physicalJob?.status, "failed");
    assert.equal(physicalJob?.failure?.code, "EXECUTION_CANCELLED");
    await inspected.close();

    second = await startLocalAgentOsHost({
      stateRoot: directory, port: 0, secretStore: secrets, modelInvoker: invoke,
      workerIdleDelayMs: 1,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const restored = (await body(await second.dispatch(new Request(`http://host.test${turnsPath}`))))
      .data.turns[0].execution;
    assert.equal(restored.status, "cancelled");
    assert.equal(invocations, 1);
  } finally {
    await first?.close();
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("中断后的 Execution 通过公开 resume 命令以新 generation 继续", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-local-runtime-resume-"));
  const secrets = new FixtureSecrets();
  const requests: ModelRequest[] = [];
  let firstModelStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstModelStarted = resolve; });
  const invoke: ByokModelInvoker = async ({ request, signal }) => {
    requests.push(request);
    if (requests.length === 1) {
      firstModelStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { text: "不可达", toolCalls: [] };
    }
    return { text: "已从中断处继续", toolCalls: [] };
  };
  let first: AgentOsHost | undefined;
  let second: AgentOsHost | undefined;
  try {
    first = await startLocalAgentOsHost({
      stateRoot: directory, port: 0, secretStore: secrets, modelInvoker: invoke,
      workerIdleDelayMs: 1,
      modelProbe: async ({ preset }) => ({
        models: preset.suggestedModels, defaultModel: preset.suggestedModels[0]!,
      }),
    });
    const workspace = (await body(await first.dispatch(jsonRequest("/v2/workspaces", {
      name: "恢复执行", viewMode: "professional", pluginIds: ["opc"],
    }, "resume-workspace")))).data;
    const pendingModel = (await body(await first.dispatch(jsonRequest("/v2/model-connections", {
      presetId: "deepseek", apiKey: "fixture-byok-key", displayName: "DeepSeek",
    }, "resume-model")))).data;
    const model = (await body(await first.dispatch(jsonRequest(
      `/v2/model-connections/${pendingModel.id}/probe`,
      { expectedStreamVersion: pendingModel.streamVersion },
      "resume-model-probe",
    )))).data;
    const thread = (await body(await first.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads`,
      { subject: "恢复机会验证", pluginId: "opc" },
      "resume-thread",
    )))).data;
    const execution = (await body(await first.dispatch(jsonRequest(
      `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
      {
        expectedStreamVersion: thread.streamVersion,
        message: "整理证据并在中断后继续",
        agentDefinitionId: "opc.opportunity-validator",
        modelBindingId: model.id,
      },
      "resume-turn",
    )))).data;
    await started;
    await first.close();
    first = undefined;

    second = await startLocalAgentOsHost({
      stateRoot: directory, port: 0, secretStore: secrets, modelInvoker: invoke,
      workerIdleDelayMs: 1,
    });
    const turnsPath = `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`;
    const interrupted = (await body(await second.dispatch(new Request(`http://host.test${turnsPath}`))))
      .data.turns[0].execution;
    assert.equal(interrupted.status, "interrupted");
    const resumed = await second.dispatch(jsonRequest(
      `/v2/executions/${execution.id}/commands`,
      { expectedStreamVersion: interrupted.streamVersion, command: "resume" },
      "resume-command",
    ));
    assert.equal(resumed.status, 200, JSON.stringify(await resumed.clone().json()));
    assert.equal((await body(resumed)).data.generation, 2);
    const completed = await waitForCompletedTurn(second, turnsPath);
    assert.equal(completed.turns[0].execution.status, "completed");
    assert.deepEqual(requests.map((request) => request.generation), [1, 2]);
    assert.ok(requests[1]?.messages.some((message) =>
      message.role === "system" && message.content.startsWith("[resume]")));
    assert.equal(completed.turns[0].entries.filter((entry: any) => entry.role === "user").length, 1);
  } finally {
    await first?.close();
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
