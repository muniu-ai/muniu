import assert from "node:assert/strict";
import test from "node:test";

import type { RunnerBinaryIdentityV1, RunnerBinaryInspectionV1 } from "@mn/contracts";
import { InMemoryKernelStore } from "@mn/kernel";
import { codingPlugin } from "@mn/plugin-coding";
import { claudeCliPluginDefinition } from "@mn/runner-claude-cli";

import {
  createAgentOsHost,
  type ModelSecretStore,
} from "../src/index.js";

const VERSION = "1.2.3";
const INSPECTION: RunnerBinaryInspectionV1 = {
  requestedPath: "/opt/muniu/bin/claude",
  realPath: "/opt/muniu/bin/claude",
  sha256: "a".repeat(64),
  device: "1",
  inode: "2",
  byteLength: 123,
  modifiedAtMs: 456,
};
const IDENTITY: RunnerBinaryIdentityV1 = { ...INSPECTION, version: VERSION };

const secrets: ModelSecretStore = {
  async save(connectionId) { return `keychain://muniu.v2/${connectionId}`; },
  async read() { return "fixture-key"; },
};

function mutation(path: string, body: unknown, key: string) {
  return new Request(`http://host.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

function deletion(path: string, body: unknown, key: string) {
  return new Request(`http://host.test${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

async function body(response: Response): Promise<any> {
  return response.json();
}

test("Coding Runner 先检查并确认绝对路径、版本与摘要，才允许显式选择", async () => {
  const store = new InMemoryKernelStore();
  let inspections = 0;
  let runnerHealthy = true;
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    officialPlugins: [codingPlugin, {
      ...claudeCliPluginDefinition,
      healthCheck() {
        return runnerHealthy
          ? { status: "healthy" as const }
          : { status: "degraded" as const, message: "fixture unavailable" };
      },
    }],
    modelProbe: async ({ preset }) => ({
      models: preset.suggestedModels,
      defaultModel: preset.suggestedModels[0]!,
    }),
    runnerIdentityInspector: {
      async inspect(runnerId, binaryPath) {
        inspections += 1;
        assert.equal(runnerId, "claude-cli");
        assert.equal(binaryPath, INSPECTION.requestedPath);
        return { ...INSPECTION, version: "untrusted-inspector-version" };
      },
    },
  });
  const workspace = (await body(await host.dispatch(mutation("/v2/workspaces", {
    name: "Runner 工作区",
    viewMode: "professional",
    pluginIds: ["coding", "runner-claude-cli"],
  }, "workspace")))).data;
  const pendingModel = (await body(await host.dispatch(mutation("/v2/model-connections", {
    presetId: "deepseek", apiKey: "fixture", displayName: "DeepSeek",
  }, "model")))).data;
  const model = (await body(await host.dispatch(mutation(
    `/v2/model-connections/${pendingModel.id}/probe`,
    { expectedStreamVersion: pendingModel.streamVersion },
    "model-probe",
  )))).data;
  const repository = (await body(await host.dispatch(mutation("/v2/plugins/coding/repositories", {
    workspaceId: workspace.id, expectedStreamVersion: 0, input: "/work/repository",
  }, "repository")))).data;
  const task = (await body(await host.dispatch(mutation("/v2/plugins/coding/tasks", {
    workspaceId: workspace.id, expectedStreamVersion: 0, input: "修复问题",
  }, "task")))).data;
  assert.equal(task.repositoryId, repository.id);
  const thread = (await body(await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${workspace.id}/threads`,
  )))).data[0];

  const beforeConfirmation = await host.dispatch(mutation(
    `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
    {
      expectedStreamVersion: thread.streamVersion,
      message: task.request,
      agentDefinitionId: "coding.builtin",
      modelBindingId: model.id,
      runnerId: "claude-cli",
    },
    "turn-before-confirmation",
  ));
  assert.equal(beforeConfirmation.status, 422);
  const beforeConfirmationError = await body(beforeConfirmation);
  assert.equal(beforeConfirmationError.code, "CODING_RUNNER_CONFIRMATION_REQUIRED");
  assert.match(beforeConfirmationError.action, /原生 macOS Mach-O CLI/u);

  const relativePath = await host.dispatch(mutation(
    "/v2/plugins/coding/runners/claude-cli/inspections",
    { workspaceId: workspace.id, binaryPath: "bin/claude" },
    "relative-inspection",
  ));
  assert.equal(relativePath.status, 422);
  assert.equal(inspections, 0);

  const inspected = await host.dispatch(mutation(
    "/v2/plugins/coding/runners/claude-cli/inspections",
    { workspaceId: workspace.id, binaryPath: INSPECTION.requestedPath },
    "inspection",
  ));
  assert.equal(inspected.status, 200);
  assert.deepEqual((await body(inspected)).data, INSPECTION);

  const wrongConfirmation = await host.dispatch(mutation(
    "/v2/plugins/coding/runners/claude-cli/confirmations",
    {
      workspaceId: workspace.id,
      expectedStreamVersion: 0,
      binaryPath: INSPECTION.requestedPath,
      version: VERSION,
      sha256: "b".repeat(64),
    },
    "wrong-confirmation",
  ));
  assert.equal(wrongConfirmation.status, 422);
  assert.equal((await body(wrongConfirmation)).code, "RUNNER_RECONFIRMATION_REQUIRED");

  const confirmed = await host.dispatch(mutation(
    "/v2/plugins/coding/runners/claude-cli/confirmations",
    {
      workspaceId: workspace.id,
      expectedStreamVersion: 0,
      binaryPath: INSPECTION.requestedPath,
      version: VERSION,
      sha256: INSPECTION.sha256,
    },
    "confirmation",
  ));
  assert.equal(confirmed.status, 200);
  const configuration = (await body(confirmed)).data;
  assert.equal(configuration.status, "confirmed");
  assert.deepEqual(configuration.identity, IDENTITY);

  const listed = await host.dispatch(new Request(
    `http://host.test/v2/plugins/coding/runners?workspaceId=${workspace.id}`,
  ));
  assert.deepEqual((await body(listed)).data.map((entry: any) => [entry.runnerId, entry.status]), [
    ["builtin", "ready"],
    ["claude-cli", "confirmed"],
    ["codex-cli", "not_configured"],
  ]);

  const deactivatedResponse = await host.dispatch(deletion(
    `/v2/workspaces/${workspace.id}/plugin-activations/runner-claude-cli`,
    { expectedStreamVersion: workspace.streamVersion },
    "deactivate-runner",
  ));
  assert.equal(deactivatedResponse.status, 200);
  const deactivated = (await body(deactivatedResponse)).data;

  for (const [suffix, path, requestBody] of [
    ["inspect", "/v2/plugins/coding/runners/claude-cli/inspections", {
      workspaceId: workspace.id,
      binaryPath: INSPECTION.requestedPath,
    }],
    ["confirm", "/v2/plugins/coding/runners/claude-cli/confirmations", {
      workspaceId: workspace.id,
      expectedStreamVersion: configuration.streamVersion,
      binaryPath: INSPECTION.requestedPath,
      version: VERSION,
      sha256: INSPECTION.sha256,
    }],
  ] as const) {
    const inactive = await host.dispatch(mutation(path, requestBody, `inactive-${suffix}`));
    assert.equal(inactive.status, 422);
    assert.equal((await body(inactive)).code, "PLUGIN_NOT_ACTIVE");
  }

  const inactiveTurn = await host.dispatch(mutation(
    `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
    {
      expectedStreamVersion: thread.streamVersion,
      message: task.request,
      modelBindingId: model.id,
      runnerId: "claude-cli",
    },
    "inactive-external-turn",
  ));
  assert.equal(inactiveTurn.status, 422);
  assert.equal((await body(inactiveTurn)).code, "PLUGIN_NOT_ACTIVE");

  const reactivated = await host.dispatch(mutation(
    `/v2/workspaces/${workspace.id}/plugin-activations`,
    {
      expectedStreamVersion: deactivated.streamVersion,
      pluginId: "runner-claude-cli",
    },
    "reactivate-runner",
  ));
  assert.equal(reactivated.status, 200);

  runnerHealthy = false;
  const degradedTurn = await host.dispatch(mutation(
    `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
    {
      expectedStreamVersion: thread.streamVersion,
      message: task.request,
      modelBindingId: model.id,
      runnerId: "claude-cli",
    },
    "degraded-external-turn",
  ));
  assert.equal(degradedTurn.status, 502);
  assert.equal((await body(degradedTurn)).code, "PLUGIN_DEGRADED");
  runnerHealthy = true;

  const externalTurn = await host.dispatch(mutation(
    `/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`,
    {
      expectedStreamVersion: thread.streamVersion,
      message: task.request,
      agentDefinitionId: "coding.builtin",
      modelBindingId: model.id,
      runnerId: "claude-cli",
    },
    "external-turn",
  ));
  assert.equal(externalTurn.status, 202, JSON.stringify(await externalTurn.clone().json()));
  const execution = (await body(externalTurn)).data;
  assert.equal(execution.runnerId, "claude-cli");
  const authority = await store.transact("local", (transaction) =>
    transaction.getProjection<any>("authority", execution.authorityId));
  assert.ok(authority.toolIds.includes("runner.claude.execute"));
  assert.equal(inspections, 3);

  await host.close();
});

test("Coding builtin 仍为默认 Runner，非 Coding turn 不接受 runnerId", async () => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    modelProbe: async ({ preset }) => ({
      models: preset.suggestedModels,
      defaultModel: preset.suggestedModels[0]!,
    }),
    runnerIdentityInspector: { async inspect() { return IDENTITY; } },
  });
  const workspace = (await body(await host.dispatch(mutation("/v2/workspaces", {
    name: "默认 Runner", viewMode: "business", pluginIds: ["coding", "opc"],
  }, "workspace-default")))).data;
  const pendingModel = (await body(await host.dispatch(mutation("/v2/model-connections", {
    presetId: "deepseek", apiKey: "fixture", displayName: "DeepSeek",
  }, "model-default")))).data;
  const model = (await body(await host.dispatch(mutation(
    `/v2/model-connections/${pendingModel.id}/probe`,
    { expectedStreamVersion: pendingModel.streamVersion },
    "model-probe-default",
  )))).data;
  await host.dispatch(mutation("/v2/plugins/coding/repositories", {
    workspaceId: workspace.id, expectedStreamVersion: 0, input: "/work/repository",
  }, "repository-default"));
  await host.dispatch(mutation("/v2/plugins/coding/tasks", {
    workspaceId: workspace.id, expectedStreamVersion: 0, input: "修复默认路径",
  }, "task-default"));
  const threads = (await body(await host.dispatch(new Request(
    `http://host.test/v2/workspaces/${workspace.id}/threads`,
  )))).data;
  const codingThread = threads.find((entry: any) => entry.pluginId === "coding");
  const turn = await host.dispatch(mutation(
    `/v2/workspaces/${workspace.id}/threads/${codingThread.id}/turns`,
    {
      expectedStreamVersion: codingThread.streamVersion,
      message: "执行任务",
      modelBindingId: model.id,
    },
    "builtin-turn",
  ));
  assert.equal(turn.status, 202);
  assert.equal((await body(turn)).data.runnerId, "builtin");

  const opcThread = (await body(await host.dispatch(mutation(
    `/v2/workspaces/${workspace.id}/threads`,
    { subject: "OPC", pluginId: "opc" },
    "opc-thread",
  )))).data;
  const rejected = await host.dispatch(mutation(
    `/v2/workspaces/${workspace.id}/threads/${opcThread.id}/turns`,
    {
      expectedStreamVersion: opcThread.streamVersion,
      message: "整理证据",
      modelBindingId: model.id,
      runnerId: "codex-cli",
    },
    "opc-runner",
  ));
  assert.equal(rejected.status, 422);
  assert.equal((await body(rejected)).code, "CODING_RUNNER_NOT_APPLICABLE");
  await host.close();
});

test("企业 Host 没有受信的同节点身份检查器时拒绝外部 Runner", async () => {
  const host = await createAgentOsHost({
    profile: "enterprise",
    store: new InMemoryKernelStore(),
    secretStore: secrets,
    identityResolver: () => ({
      tenantId: "tenant-a",
      principalId: "owner-a",
      organizationRoles: ["organization_admin"],
    }),
  });
  const workspaceResponse = await host.dispatch(mutation("/v2/workspaces", {
    name: "企业 Runner", viewMode: "professional", pluginIds: ["coding", "runner-codex-cli"],
  }, "enterprise-runner-workspace"));
  const workspace = (await body(workspaceResponse)).data;

  const response = await host.dispatch(mutation(
    "/v2/plugins/coding/runners/codex-cli/inspections",
    { workspaceId: workspace.id, binaryPath: "/usr/local/bin/codex" },
    "enterprise-runner-inspection",
  ));
  assert.equal(response.status, 422);
  const error = await body(response);
  assert.equal(error.code, "RUNNER_INSPECTION_UNAVAILABLE");
  assert.match(error.action, /官方原生安装/u);
  await host.close();
});

test("Runner 插件降级或缺少工具贡献时拒绝被动检查", async () => {
  for (const [expectedCode, definition] of [
    ["PLUGIN_DEGRADED", {
      ...claudeCliPluginDefinition,
      healthCheck() { return { status: "degraded" as const, message: "fixture unavailable" }; },
    }],
    ["PLUGIN_CONTRIBUTION_INVALID", {
      ...claudeCliPluginDefinition,
      contributions: { ...claudeCliPluginDefinition.contributions, tools: [] },
    }],
  ] as const) {
    let inspected = false;
    const host = await createAgentOsHost({
      store: new InMemoryKernelStore(),
      secretStore: secrets,
      officialPlugins: [codingPlugin, definition],
      runnerIdentityInspector: {
        async inspect() { inspected = true; return INSPECTION; },
      },
    });
    const workspace = (await body(await host.dispatch(mutation("/v2/workspaces", {
      name: `Runner ${expectedCode}`,
      viewMode: "professional",
      pluginIds: ["coding", "runner-claude-cli"],
    }, `workspace-${expectedCode}`)))).data;

    for (const [action, path, requestBody] of [
      ["inspect", "/v2/plugins/coding/runners/claude-cli/inspections", {
        workspaceId: workspace.id,
        binaryPath: INSPECTION.requestedPath,
      }],
      ["confirm", "/v2/plugins/coding/runners/claude-cli/confirmations", {
        workspaceId: workspace.id,
        expectedStreamVersion: 0,
        binaryPath: INSPECTION.requestedPath,
        version: VERSION,
        sha256: INSPECTION.sha256,
      }],
    ] as const) {
      const response = await host.dispatch(mutation(path, requestBody, `${action}-${expectedCode}`));
      assert.equal(response.status, expectedCode === "PLUGIN_DEGRADED" ? 502 : 422);
      assert.equal((await body(response)).code, expectedCode);
    }
    assert.equal(inspected, false);
    await host.close();
  }
});

test("并发异步 mutation 立即拒绝同一幂等键的不同请求", async () => {
  const store = new InMemoryKernelStore();
  let releaseInspection!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseInspection = resolve; });
  let inspectionStarted!: () => void;
  const started = new Promise<void>((resolve) => { inspectionStarted = resolve; });
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    runnerIdentityInspector: {
      async inspect(_runnerId, binaryPath) {
        inspectionStarted();
        await blocked;
        return { ...INSPECTION, requestedPath: binaryPath, realPath: binaryPath };
      },
    },
  });
  const workspace = (await body(await host.dispatch(mutation("/v2/workspaces", {
    name: "并发幂等检查",
    viewMode: "professional",
    pluginIds: ["coding", "runner-claude-cli"],
  }, "workspace-concurrent-idempotency")))).data;
  const path = "/v2/plugins/coding/runners/claude-cli/inspections";
  const first = host.dispatch(mutation(path, {
    workspaceId: workspace.id,
    binaryPath: "/opt/muniu/bin/claude-a",
  }, "shared-inspection-key"));
  await started;
  const conflicting = host.dispatch(mutation(path, {
    workspaceId: workspace.id,
    binaryPath: "/opt/muniu/bin/claude-b",
  }, "shared-inspection-key"));

  releaseInspection();
  const [firstResponse, conflictingResponse] = await Promise.all([first, conflicting]);
  assert.equal(firstResponse.status, 200);
  assert.equal(conflictingResponse.status, 409);
  assert.equal((await body(conflictingResponse)).code, "IDEMPOTENCY_KEY_REUSED");
  await host.close();
});
