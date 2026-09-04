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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await host.dispatch(new Request(`http://host.test${path}`));
    assert.equal(response.status, 200);
    const view = (await body(response)).data;
    if (view.turns[0]?.execution.status === "completed") return view;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Execution 未在测试时限内完成");
}

test("本地组合根执行 BYOK Agent turn，结果在 SQLite 重启后仍可读取", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-local-runtime-"));
  const secrets = new FixtureSecrets();
  const requests: ModelRequest[] = [];
  const invoke: ByokModelInvoker = async (input) => {
    assert.equal(input.presetId, "deepseek");
    assert.equal(input.model, "deepseek-chat");
    assert.equal(input.apiKey, "fixture-byok-key");
    assert.equal(input.request.availableToolIds.length, 0);
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
