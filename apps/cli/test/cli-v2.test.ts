import { inboxFixture, workspaceFixture, opportunityFixture, sampleFixture, repositoryFixture, modelFixture, executionFixture, codingTaskFixture, installationFixture, runnerInspectionFixture, runnerConfigurationFixture, reconciliationFixture, reconciliationDecisionFixture } from "./api-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  LocalBackupCheckResult,
  LocalBackupCreateResult,
  LocalStateRestoreResult,
} from "@mn/storage";
import { LocalBackupError } from "@mn/storage";
import { runCli, resolveCliStateRoot, type CliIo } from "../src/index.js";

test("CLI 备份使用与 Host 相同的 v2 状态根，忽略旧环境变量", () => {
  assert.equal(resolveCliStateRoot(undefined, { MN_V2_STATE_ROOT: "/state/custom-v2", MN_STATE_ROOT: "/state/old" }, "/fixture"), "/state/custom-v2");
  assert.equal(resolveCliStateRoot(undefined, { MN_STATE_ROOT: "/state/old" }, "/fixture"), "/fixture/.muniu/v2");
  assert.equal(resolveCliStateRoot("/state/explicit-v2", { MN_V2_STATE_ROOT: "/state/custom-v2" }, "/fixture"), "/state/explicit-v2");
});

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

function io(): CliIo & { out: string[]; err: string[] } {
  const value = {
    out: [] as string[], err: [] as string[],
    stdout(line: string) { value.out.push(line); },
    stderr(line: string) { value.err.push(line); },
  };
  return value;
}

async function captureRequest(input: string | URL | Request, init?: RequestInit): Promise<CapturedRequest> {
  const request = new Request(input, init);
  return {
    method: request.method,
    path: new URL(request.url).pathname,
    ...(request.body ? { body: await request.json() } : {}),
    ...(request.headers.get("Idempotency-Key")
      ? { idempotencyKey: request.headers.get("Idempotency-Key")! }
      : {}),
  };
}

function ok(data: unknown, status = 200): Response {
  return Response.json({ data, traceId: "trace-server" }, { status });
}

test("帮助只暴露 0.2 命令", async () => {
  const output = io();
  assert.equal(await runCli(["--help"], { io: output }), 0);
  const help = output.out.join("\n");
  for (const command of ["setup", "ask", "inbox", "resume", "doctor", "plugin", "opc", "code", "backup"]) {
    assert.match(help, new RegExp(`^  ${command}(?: |$)`, "m"));
  }
  for (const removed of ["run", "provider", "profile", "project", "task", "spec", "config"]) {
    assert.doesNotMatch(help, new RegExp(`^  ${removed}(?: |$)`, "m"));
  }
});

test("--json 输出固定成功 envelope", async () => {
  const output = io();
  const fetch: typeof globalThis.fetch = async () => ok([inboxFixture({ id: "approval:1", title: "操作需要批准" })]);
  assert.equal(await runCli(["inbox", "--json"], { io: output, fetch }), 0);
  assert.deepEqual(JSON.parse(output.out[0] ?? ""), {
    ok: true,
    command: "inbox",
    data: [inboxFixture({ id: "approval:1", title: "操作需要批准" })],
  });
});

test("全局 --json 可以写在命令前", async () => {
  const output = io();
  const fetch: typeof globalThis.fetch = async () => ok([]);
  assert.equal(await runCli(["--json", "inbox"], { io: output, fetch }), 0);
  assert.deepEqual(JSON.parse(output.out[0] ?? ""), { ok: true, command: "inbox", data: [] });
});

test("setup 完成引导初始化、OPC 首对象和只读样例", async () => {
  const output = io();
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);
    if (request.path === "/v2/setup") return ok({ tenantId: "local", principalId: "local-owner" });
    if (request.path === "/v2/workspaces") {
      return ok(workspaceFixture({ id: "workspace-1", streamVersion: 1, activePluginIds: ["opc"] }), 201);
    }
    if (request.path === "/v2/plugins/opc/opportunities") return ok(opportunityFixture({ id: "opportunity-1", state: "captured" }), 201);
    if (request.path === "/v2/plugins/opc/samples/read-only") {
      return ok(sampleFixture({ id: "sample-1", effectClass: "external_read", status: "completed" }));
    }
    return Response.json({}, { status: 404 });
  };

  assert.equal(await runCli([
    "setup", "--view", "business", "--plugins", "opc", "--workspace", "木牛",
    "--first", "面向独立顾问，减少访谈证据整理时间", "--json",
  ], { io: output, fetch, idempotencyKey: (() => { let id = 0; return () => `key-${++id}`; })() }), 0);

  assert.deepEqual(requests, [
    { method: "POST", path: "/v2/setup", body: {}, idempotencyKey: "key-1" },
    {
      method: "POST", path: "/v2/workspaces", idempotencyKey: "key-2",
      body: { name: "木牛", viewMode: "business", pluginIds: ["opc"] },
    },
    {
      method: "POST", path: "/v2/plugins/opc/opportunities", idempotencyKey: "key-3",
      body: {
        workspaceId: "workspace-1", expectedStreamVersion: 0,
        input: "面向独立顾问，减少访谈证据整理时间",
      },
    },
    {
      method: "POST", path: "/v2/plugins/opc/samples/read-only", idempotencyKey: "key-4",
      body: { workspaceId: "workspace-1", expectedStreamVersion: 0 },
    },
  ]);
  assert.deepEqual(JSON.parse(output.out[0] ?? "").data, {
    setup: { tenantId: "local", principalId: "local-owner" },
    workspace: workspaceFixture({ id: "workspace-1", streamVersion: 1, activePluginIds: ["opc"] }),
    firstObject: opportunityFixture({ id: "opportunity-1", state: "captured" }),
    sample: sampleFixture({ id: "sample-1", effectClass: "external_read", status: "completed" }),
  });
});

test("setup 为 Coding 创建真实仓库和本地只读样例", async () => {
  const output = io();
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);
    if (request.path === "/v2/setup") return ok({ tenantId: "local", principalId: "local-owner" });
    if (request.path === "/v2/workspaces") return ok(workspaceFixture({ id: "workspace-code", streamVersion: 1 }), 201);
    if (request.path === "/v2/plugins/coding/repositories") return ok(repositoryFixture({ id: "repository-1", name: "muniu" }), 201);
    if (request.path === "/v2/plugins/coding/samples/read-only") {
      return ok(sampleFixture({ id: "sample-code", effectClass: "local_read", status: "completed" }));
    }
    return Response.json({}, { status: 404 });
  };

  assert.equal(await runCli([
    "setup", "--plugins", "coding", "--workspace", "研发", "--first", "/work/muniu",
  ], { io: output, fetch }), 0);
  assert.deepEqual(requests.map((request) => request.path), [
    "/v2/setup",
    "/v2/workspaces",
    "/v2/plugins/coding/repositories",
    "/v2/plugins/coding/samples/read-only",
  ]);
  assert.deepEqual(requests[2]?.body, {
    workspaceId: "workspace-code", expectedStreamVersion: 0, input: "/work/muniu",
  });
});

test("setup 模型连接使用厂商预设并探测默认模型", async () => {
  const output = io();
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);
    if (request.path === "/v2/setup") return ok({ tenantId: "local", principalId: "local-owner" });
    if (request.path === "/v2/model-connections") return ok(modelFixture({ id: "connection-1", streamVersion: 1 }), 201);
    if (request.path === "/v2/model-connections/connection-1/probe") {
      return ok(modelFixture({ id: "connection-1", streamVersion: 2, defaultModel: "deepseek-chat", status: "ready" }));
    }
    if (request.path === "/v2/workspaces") return ok(workspaceFixture({ id: "workspace-1", streamVersion: 1 }), 201);
    return Response.json({}, { status: 404 });
  };

  assert.equal(await runCli([
    "setup", "--provider", "deepseek", "--key", "test-secret", "--workspace", "木牛",
  ], { io: output, fetch }), 0);
  assert.deepEqual(requests.map((request) => request.path), [
    "/v2/setup",
    "/v2/model-connections",
    "/v2/model-connections/connection-1/probe",
    "/v2/workspaces",
  ]);
  assert.deepEqual(requests[1]?.body, {
    presetId: "deepseek", apiKey: "test-secret", displayName: "deepseek",
  });

  assert.equal(await runCli(["setup", "--base-url", "https://example.test"], { io: output, fetch }), 2);
  assert.match(output.err.at(-1) ?? "", /不支持的参数/);
});

test("setup 在模型凭据不完整时不产生部分写入", async () => {
  const output = io();
  let called = false;
  const fetch: typeof globalThis.fetch = async () => {
    called = true;
    return ok({});
  };

  assert.equal(await runCli(["setup", "--provider", "deepseek"], { io: output, fetch }), 2);
  assert.equal(called, false);
  assert.match(output.err[0] ?? "", /必须同时提供 --provider 和 --key/);
});

test("plugin 命令映射工作区停用、全局停用与清除接口", async () => {
  const output = io();
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);
    if (request.path.includes("/plugin-activations/")) return ok(workspaceFixture({ activePluginIds: [] }));
    if (request.path.endsWith("/disable")) return ok(installationFixture({ status: "disabled", streamVersion: 4 }));
    return ok({ pluginId: "research", purged: true, streamVersion: 5, purgedAt: "2026-09-04T08:00:00.000Z" });
  };
  const nextKey = (() => { let id = 0; return () => `plugin-key-${++id}`; })();

  assert.equal(await runCli([
    "plugin", "deactivate", "research", "--workspace", "workspace-1", "--version", "2",
  ], { io: output, fetch, idempotencyKey: nextKey }), 0);
  assert.equal(await runCli([
    "plugin", "disable", "research", "--version", "3",
  ], { io: output, fetch, idempotencyKey: nextKey }), 0);
  assert.equal(await runCli([
    "plugin", "purge", "research", "--version", "4",
  ], { io: output, fetch, idempotencyKey: nextKey }), 0);

  assert.deepEqual(requests, [
    {
      method: "DELETE",
      path: "/v2/workspaces/workspace-1/plugin-activations/research",
      body: { expectedStreamVersion: 2 },
      idempotencyKey: "plugin-key-1",
    },
    {
      method: "POST",
      path: "/v2/plugins/installations/research/disable",
      body: { expectedStreamVersion: 3 },
      idempotencyKey: "plugin-key-2",
    },
    {
      method: "DELETE",
      path: "/v2/plugins/installations/research",
      body: { expectedStreamVersion: 4 },
      idempotencyKey: "plugin-key-3",
    },
  ]);
  assert.deepEqual(output.out, ["已从工作区停用 research", "已全局停用 research", "已清除 research"]);
});

test("OPC 与 Coding 命令只映射已实现的插件资源", async () => {
  const cases = [
    {
      arguments: ["opc", "capture", "--workspace", "w-1", "--input", "验证访谈整理需求"],
      path: "/v2/plugins/opc/opportunities",
      body: { workspaceId: "w-1", expectedStreamVersion: 0, input: "验证访谈整理需求" },
    },
    {
      arguments: ["code", "repository", "--workspace", "w-1", "--input", "/work/muniu"],
      path: "/v2/plugins/coding/repositories",
      body: { workspaceId: "w-1", expectedStreamVersion: 0, input: "/work/muniu" },
    },
    {
      arguments: ["code", "task", "--workspace", "w-1", "--input", "修复事件游标"],
      path: "/v2/plugins/coding/tasks",
      body: { workspaceId: "w-1", expectedStreamVersion: 0, input: "修复事件游标" },
    },
    {
      arguments: ["opc", "sample", "--workspace", "w-1"],
      path: "/v2/plugins/opc/samples/read-only",
      body: { workspaceId: "w-1", expectedStreamVersion: 0 },
    },
    {
      arguments: [
        "opc", "frame", "opportunity-1", "--workspace", "w-1", "--version", "1",
        "--input", JSON.stringify({
          targetCustomer: "独立开发者",
          problem: "访谈质量不稳定",
          falsifiableHypothesis: "五次访谈至少一人承诺下一步",
        }),
      ],
      path: "/v2/plugins/opc/opportunities/opportunity-1/commands",
      body: {
        workspaceId: "w-1",
        expectedStreamVersion: 1,
        command: "frame",
        input: {
          targetCustomer: "独立开发者",
          problem: "访谈质量不稳定",
          falsifiableHypothesis: "五次访谈至少一人承诺下一步",
        },
      },
    },
  ] as const;

  for (const entry of cases) {
    const output = io();
    let request: CapturedRequest | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = await captureRequest(input, init);
      const data = entry.path.includes("samples") ? sampleFixture({ id: "created" })
        : entry.path.endsWith("repositories") ? repositoryFixture({ id: "created" })
          : entry.path.endsWith("tasks") ? codingTaskFixture({ id: "created" })
            : opportunityFixture({ id: "created" });
      return ok(data, entry.path.includes("samples") ? 200 : 201);
    };
    assert.equal(await runCli(entry.arguments, { io: output, fetch }), 0);
    assert.equal(request?.path, entry.path);
    assert.deepEqual(request?.body, entry.body);
  }

  const output = io();
  let called = false;
  const fetch: typeof globalThis.fetch = async () => { called = true; return ok({}); };
  assert.equal(await runCli(["opc", "publish", "--workspace", "w-1"], { io: output, fetch }), 2);
  assert.equal(called, false);
  assert.match(output.err[0] ?? "", /opc 支持/);
});

test("Coding 按仓库名称或路径选择，不在重名时任意绑定", async () => {
  const repositories = [repositoryFixture(), repositoryFixture({ id: "repository-2", name: "service", rootRealPath: "/work/service" })];
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init); requests.push(request);
    return ok(request.method === "GET" ? repositories : codingTaskFixture({ repositoryId: "repository-2" }));
  };
  for (const selection of ["service", "/work/service", "repository-2"]) {
    const output = io(); requests.length = 0;
    assert.equal(await runCli(["code", "task", "--workspace", "workspace-1", "--repository", selection, "--input", "修复错误处理"], { io: output, fetch }), 0, output.err.join("\n"));
    assert.equal(requests[0]?.path, "/v2/plugins/coding/repositories");
    assert.equal((requests[1]?.body as { repositoryId?: string }).repositoryId, "repository-2");
  }
  repositories.push(repositoryFixture({ id: "repository-3", name: "service", rootRealPath: "/other/service" }));
  for (const selection of ["service", "不存在的仓库"]) {
    const output = io(); requests.length = 0;
    assert.equal(await runCli(["code", "task", "--workspace", "workspace-1", "--repository", selection, "--input", "修复错误处理"], { io: output, fetch }), 2);
    assert.equal(requests.length, 1);
    assert.match(output.err.join("\n"), /仓库/);
  }
  const output = io();
  assert.equal(await runCli(["code", "repositories", "--workspace", "workspace-1"], { io: output, fetch }), 0);
  assert.match(output.out.join("\n"), /service.*\/work\/service/);
});

test("ask 仅在显式指定时发送外部 Coding Runner", async () => {
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(await captureRequest(input, init));
    return ok(executionFixture({ id: "execution-1", runnerId: "claude-cli" }), 202);
  };

  assert.equal(await runCli([
    "ask", "修复事件游标", "--workspace", "w-1", "--thread", "thread-1",
    "--version", "4", "--runner", "claude-cli",
  ], { io: io(), fetch, idempotencyKey: () => "ask-runner-key" }), 0);
  assert.deepEqual(requests, [{
    method: "POST",
    path: "/v2/workspaces/w-1/threads/thread-1/turns",
    body: {
      expectedStreamVersion: 4,
      message: "修复事件游标",
      runnerId: "claude-cli",
    },
    idempotencyKey: "ask-runner-key",
  }]);

  requests.length = 0;
  assert.equal(await runCli([
    "ask", "使用默认执行器", "--workspace", "w-1", "--thread", "thread-1",
  ], { io: io(), fetch }), 0);
  assert.deepEqual(requests[0]?.body, {
    expectedStreamVersion: 1,
    message: "使用默认执行器",
  });
});

test("ask 不需要会话 ID，自动使用工作区最近的业务会话", async () => {
  const output = io();
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);
    if (request.method === "GET") {
      return ok([
        { tenantId: "local", workspaceId: "workspace-1",
          id: "thread-old",
          subject: "旧机会",
          pluginId: "opc",
          resourceRef: { namespace: "opc.opportunity", resourceId: "opportunity-old" },
          streamVersion: 3,
          createdAt: "2026-09-01T08:00:00.000Z",
          updatedAt: "2026-09-01T08:00:00.000Z",
        },
        { tenantId: "local", workspaceId: "workspace-1",
          id: "thread-current",
          subject: "设计师访谈整理",
          pluginId: "opc",
          resourceRef: { namespace: "opc.opportunity", resourceId: "opportunity-current" },
          streamVersion: 7,
          createdAt: "2026-09-02T08:00:00.000Z",
          updatedAt: "2026-09-04T08:00:00.000Z",
        },
      ]);
    }
    return ok(executionFixture({ id: "execution-1", status: "queued" }), 202);
  };

  assert.equal(await runCli([
    "ask", "帮我列出当前证据缺口", "--workspace", "workspace-1",
  ], { io: output, fetch, idempotencyKey: () => "ask-auto-key" }), 0);

  assert.deepEqual(requests, [
    { method: "GET", path: "/v2/workspaces/workspace-1/threads" },
    {
      method: "POST",
      path: "/v2/workspaces/workspace-1/threads/thread-current/turns",
      body: { expectedStreamVersion: 7, message: "帮我列出当前证据缺口" },
      idempotencyKey: "ask-auto-key",
    },
  ]);
  assert.deepEqual(output.out, ["已提交到 设计师访谈整理，结果会进入当前会话和成果页"]);
});

test("ask 可用机会标题选择 OPC 上下文，不暴露会话 ID", async () => {
  const output = io();
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);
    if (request.method === "GET") {
      return ok([
        { tenantId: "local", workspaceId: "workspace-1",
          id: "thread-opc",
          subject: "设计师增长机会",
          pluginId: "opc",
          resourceRef: { namespace: "opc.opportunity", resourceId: "opportunity-1" },
          streamVersion: 4,
          createdAt: "2026-09-01T08:00:00.000Z",
          updatedAt: "2026-09-01T08:00:00.000Z",
        },
        { tenantId: "local", workspaceId: "workspace-1",
          id: "thread-code",
          subject: "设计师增长页面",
          pluginId: "coding",
          resourceRef: { namespace: "coding.task", resourceId: "task-1" },
          streamVersion: 9,
          createdAt: "2026-09-03T08:00:00.000Z",
          updatedAt: "2026-09-04T08:00:00.000Z",
        },
      ]);
    }
    return ok(executionFixture({ id: "execution-1", status: "queued" }), 202);
  };

  assert.equal(await runCli([
    "ask", "生成访谈提纲", "--workspace", "workspace-1", "--opportunity", "增长机会",
  ], { io: output, fetch }), 0);
  assert.equal(requests[1]?.path, "/v2/workspaces/workspace-1/threads/thread-opc/turns");
  assert.deepEqual(requests[1]?.body, { expectedStreamVersion: 4, message: "生成访谈提纲" });
});

test("ask 在机会标题不唯一时要求缩小范围，且不提交 turn", async () => {
  const output = io();
  let mutationCount = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    if (request.method !== "GET") mutationCount += 1;
    return ok([
      { tenantId: "local", workspaceId: "workspace-1",
        id: "thread-1", subject: "设计师增长 A", pluginId: "opc",
        resourceRef: { namespace: "opc.opportunity", resourceId: "opportunity-1" },
        streamVersion: 2, createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z",
      },
      { tenantId: "local", workspaceId: "workspace-1",
        id: "thread-2", subject: "设计师增长 B", pluginId: "opc",
        resourceRef: { namespace: "opc.opportunity", resourceId: "opportunity-2" },
        streamVersion: 3, createdAt: "2026-09-02T08:00:00.000Z", updatedAt: "2026-09-02T08:00:00.000Z",
      },
    ]);
  };

  assert.equal(await runCli([
    "ask", "继续验证", "--workspace", "workspace-1", "--opportunity", "设计师增长",
  ], { io: output, fetch }), 2);
  assert.equal(mutationCount, 0);
  assert.match(output.err[0] ?? "", /匹配到多个机会：设计师增长 A、设计师增长 B/u);
  assert.doesNotMatch(output.err[0] ?? "", /thread-/u);
});

test("ask 指定 Runner 时自动选择最近的 Coding 会话", async () => {
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);
    if (request.method === "GET") {
      return ok([
        { tenantId: "local", workspaceId: "workspace-1",
          id: "thread-opc", subject: "更新的机会", pluginId: "opc",
          resourceRef: { namespace: "opc.opportunity", resourceId: "opportunity-1" },
          streamVersion: 8, createdAt: "2026-09-04T08:00:00.000Z", updatedAt: "2026-09-04T08:00:00.000Z",
        },
        { tenantId: "local", workspaceId: "workspace-1",
          id: "thread-code", subject: "修复事件游标", pluginId: "coding",
          resourceRef: { namespace: "coding.task", resourceId: "task-1" },
          streamVersion: 5, createdAt: "2026-09-02T08:00:00.000Z", updatedAt: "2026-09-02T08:00:00.000Z",
        },
      ]);
    }
    return ok(executionFixture({ id: "execution-code", status: "queued" }), 202);
  };

  assert.equal(await runCli([
    "ask", "继续修复", "--workspace", "workspace-1", "--runner", "codex-cli",
  ], { io: io(), fetch }), 0);
  assert.equal(requests[1]?.path, "/v2/workspaces/workspace-1/threads/thread-code/turns");
  assert.deepEqual(requests[1]?.body, {
    expectedStreamVersion: 5,
    message: "继续修复",
    runnerId: "codex-cli",
  });
});

test("ask 在工作区没有业务会话时给出可执行提示", async () => {
  const output = io();
  let mutationCount = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    if (request.method !== "GET") mutationCount += 1;
    return ok([]);
  };
  assert.equal(await runCli([
    "ask", "从哪里开始", "--workspace", "workspace-empty",
  ], { io: output, fetch }), 2);
  assert.equal(mutationCount, 0);
  assert.match(output.err[0] ?? "", /先捕获机会或创建 Coding 任务/u);
});

test("code runner 提供检查、人工确认与状态查询", async () => {
  const output = io();
  const requests: Array<CapturedRequest & { readonly search: string }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({ ...request, search: url.search });
    if (request.path.endsWith("/inspections")) {
      return ok(runnerInspectionFixture());
    }
    if (request.path.endsWith("/confirmations")) {
      return ok(runnerConfigurationFixture());
    }
    return ok([{ runnerId: "builtin", external: false, status: "ready" }]);
  };
  const nextKey = (() => { let id = 0; return () => `runner-key-${++id}`; })();

  assert.equal(await runCli([
    "code", "runners", "--workspace", "w-1",
  ], { io: output, fetch, idempotencyKey: nextKey }), 0);
  assert.equal(await runCli([
    "code", "runner", "inspect", "claude-cli", "--workspace", "w-1",
    "--path", "/opt/homebrew/bin/claude",
  ], { io: output, fetch, idempotencyKey: nextKey }), 0);
  assert.equal(await runCli([
    "code", "runner", "confirm", "claude-cli", "--workspace", "w-1",
    "--path", "/opt/homebrew/bin/claude", "--binary-version", "2.1.0",
    "--sha256", "a".repeat(64), "--version", "2",
  ], { io: output, fetch, idempotencyKey: nextKey }), 0);

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/v2/plugins/coding/runners",
      search: "?workspaceId=w-1",
    },
    {
      method: "POST",
      path: "/v2/plugins/coding/runners/claude-cli/inspections",
      search: "",
      body: { workspaceId: "w-1", binaryPath: "/opt/homebrew/bin/claude" },
      idempotencyKey: "runner-key-1",
    },
    {
      method: "POST",
      path: "/v2/plugins/coding/runners/claude-cli/confirmations",
      search: "",
      body: {
        workspaceId: "w-1",
        expectedStreamVersion: 2,
        binaryPath: "/opt/homebrew/bin/claude",
        version: "2.1.0",
        sha256: "a".repeat(64),
      },
      idempotencyKey: "runner-key-2",
    },
  ]);
  assert.deepEqual(output.out, [
    "已列出 Coding Runner",
    "已被动检查 claude-cli；未执行该路径，请人工核实版本后确认 SHA-256",
    "已确认 claude-cli；二进制变化后需要重新确认",
  ]);
});

test("code runner 在本地拒绝相对路径和未知 Runner", async () => {
  const output = io();
  let called = false;
  const fetch: typeof globalThis.fetch = async () => { called = true; return ok({}); };

  assert.equal(await runCli([
    "code", "runner", "inspect", "claude-cli", "--workspace", "w-1", "--path", "claude",
  ], { io: output, fetch }), 2);
  assert.equal(await runCli([
    "code", "runner", "confirm", "builtin", "--workspace", "w-1", "--path", "/usr/bin/true",
    "--binary-version", "1", "--sha256", "a".repeat(64),
  ], { io: output, fetch }), 2);
  assert.equal(called, false);
  assert.match(output.err[0] ?? "", /绝对路径/);
  assert.match(output.err[1] ?? "", /claude-cli 或 codex-cli/);
});

test("code reconcile 自动读取两个流版本并提交三种人工核对决定", async () => {
  const decisions = ["terminate", "mark_completed", "create_new_call"] as const;
  for (const decision of decisions) {
    const output = io();
    const requests: CapturedRequest[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = await captureRequest(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return ok(reconciliationFixture(decision));
      }
      return ok(reconciliationDecisionFixture(decision));
    };
    assert.equal(await runCli([
      "code", "reconcile", "execution/a", decision,
    ], {
      io: output,
      fetch,
      idempotencyKey: () => `reconcile-${decision}`,
    }), 0);
    assert.deepEqual(requests, [
      {
        method: "GET",
        path: "/v2/plugins/coding/executions/execution%2Fa/reconciliation",
      },
      {
        method: "POST",
        path: "/v2/plugins/coding/executions/execution%2Fa/reconciliation-decisions",
        body: {
          expectedStreamVersion: 4,
          expectedCodingStreamVersion: 7,
          decision,
        },
        idempotencyKey: `reconcile-${decision}`,
      },
    ]);
    assert.match(
      output.out[0] ?? "",
      decision === "mark_completed" ? /权威验证已入队/u : /清理任务已入队/u,
    );
  }
});

test("code reconcile 拒绝未知决定或无效的 Host 版本快照", async () => {
  const output = io();
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls += 1;
    return ok({});
  };
  assert.equal(await runCli([
    "code", "reconcile", "execution-1", "retry",
  ], { io: output, fetch }), 2);
  assert.equal(calls, 0);
  assert.equal(await runCli([
    "code", "reconcile", "execution-1", "terminate",
  ], { io: output, fetch }), 2);
  assert.equal(calls, 1);
  assert.match(output.err[0] ?? "", /核对决定/);
  assert.match(output.err[1] ?? "", /公共契约/);
});

test("畸形 Host 响应不作为成功结果输出，也不泄漏原始字段", async () => {
  const output = io();
  const fetch: typeof globalThis.fetch = async () => ok([{ id: "bad", apiKey: "do-not-expose" }]);
  assert.equal(await runCli(["inbox", "--json"], { io: output, fetch }), 2);
  const result = JSON.parse(output.out[0]!);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "RESPONSE_CONTRACT_INVALID");
  assert.equal(result.error.retryable, false);
  assert.doesNotMatch(JSON.stringify(output), /do-not-expose/);
});

test("doctor --fix 明确报告无需修复且不发起写请求", async () => {
  const output = io();
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);
    if (request.path === "/v2/health") return ok({ core: { status: "healthy" }, plugins: [] });
    if (request.path === "/v2/readiness") return ok({ ready: true, issues: [] });
    if (request.path === "/v2/model-connections") return ok([]);
    return Response.json({}, { status: 404 });
  };
  assert.equal(await runCli(["doctor", "--fix", "--json"], { io: output, fetch }), 0);
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/v2/health" },
    { method: "GET", path: "/v2/readiness" },
    { method: "GET", path: "/v2/model-connections" },
  ]);
  assert.deepEqual(JSON.parse(output.out[0] ?? "").data.fix, {
    requested: true,
    status: "not_needed",
    actions: [],
  });
});

test("doctor --fix 不把需人工处理的问题报告为已修复", async () => {
  const output = io();
  const issue = {
    code: "PLUGIN_LOCK_MISMATCH",
    message: "Host 与 Worker 的 plugin lock 不一致",
    action: "同步 plugin lock 后重新部署",
  };
  const fetch: typeof globalThis.fetch = async (input) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path === "/v2/model-connections") return ok([]);
    return path === "/v2/readiness"
      ? ok({ ready: false, issues: [issue] }, 503)
      : ok({ core: { status: "healthy" }, plugins: [] });
  };
  assert.equal(await runCli(["doctor", "--fix", "--json"], { io: output, fetch }), 0);
  assert.deepEqual(JSON.parse(output.out[0] ?? "").data.fix, {
    requested: true,
    status: "manual_action_required",
    actions: [],
    remainingIssues: [issue],
  });
});

test("doctor --fix 仅重探测未就绪连接，保留人工核对和 lock 故障", async () => {
  const requests: CapturedRequest[] = [];
  const output = io();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init); requests.push(request);
    if (request.path === "/v2/model-connections") return ok([modelFixture({ id: "pending-model", status: "pending", streamVersion: 3 }), modelFixture({ id: "ready-model", status: "ready", streamVersion: 2 })]);
    if (request.path.endsWith("/probe")) return ok(modelFixture({ id: "pending-model", status: "ready", streamVersion: 4 }));
    if (request.path === "/v2/health") return ok({ core: { status: "healthy" }, plugins: [] });
    return ok({ ready: true, issues: [] });
  };
  assert.equal(await runCli(["doctor", "--fix", "--json"], { io: output, fetch }), 0);
  assert.deepEqual(requests.filter((request) => request.method !== "GET").map(({ path, body }) => ({ path, body })), [
    { path: "/v2/model-connections/pending-model/probe", body: { expectedStreamVersion: 3 } },
  ]);
  assert.equal(JSON.parse(output.out[0]!).data.fix.status, "repaired");
});

test("backup 在本地创建、校验并恢复 SQLite 与 CAS 加密快照", async () => {
  const output = io();
  let called = false;
  const fetch: typeof globalThis.fetch = async () => { called = true; return ok({}); };
  const manifest = {
    format: "muniu-agent-os-local-backup",
    manifestVersion: 1,
    createdAt: "2026-09-04T08:00:00.000Z",
    capabilities: { sqlite: true, cas: true },
    payload: {
      mediaType: "application/vnd.muniu.agent-os-local-state+json",
      bytes: 4096,
      sha256: "a".repeat(64),
      sqliteSchemaVersion: "2",
      sqliteBytes: 2048,
      sqliteSha256: "b".repeat(64),
      casObjects: 1,
      casBytes: 2048,
    },
    encryption: { algorithm: "AES-256-GCM", keyManagement: "external-key-provider" },
  } as const;
  const calls: unknown[] = [];
  const backup = {
    async create(fileName: string): Promise<LocalBackupCreateResult> {
      calls.push(["create", fileName]);
      return { file: `/state/backups/${fileName}`, manifest };
    },
    async check(fileName: string): Promise<LocalBackupCheckResult> {
      calls.push(["check", fileName]);
      return { file: `/state/backups/${fileName}`, manifest, verified: true };
    },
    async restore(fileName: string, destinationName: string, options?: { upgradeCoreProtection?: boolean }): Promise<LocalStateRestoreResult> {
      calls.push(["restore", fileName, destinationName, ...(options ? [options] : [])]);
      return {
        stateRoot: `/state/restore/${destinationName}`,
        verified: true,
        file: `/state/restore/${destinationName}/state.sqlite3`,
        casDirectory: `/state/restore/${destinationName}/cas`,
        manifest,
      };
    },
  };
  assert.equal(await runCli([
    "backup", "create", "state.mnbackup", "--verify", "--json",
  ], { io: output, fetch, backup }), 0);
  assert.equal(await runCli([
    "backup", "check", "state.mnbackup", "--json",
  ], { io: output, fetch, backup }), 0);
  assert.equal(await runCli([
    "backup", "restore", "state.mnbackup", "--destination", "restored-v2", "--json",
  ], { io: output, fetch, backup }), 0);
  assert.equal(called, false);
  assert.equal(await runCli([
    "backup", "restore", "state.mnbackup", "--destination", "upgraded-v2", "--upgrade-core-protection", "--json",
  ], { io: output, fetch, backup }), 0);
  assert.deepEqual(calls, [
    ["create", "state.mnbackup"],
    ["check", "state.mnbackup"],
    ["check", "state.mnbackup"],
    ["restore", "state.mnbackup", "restored-v2"],
    ["restore", "state.mnbackup", "upgraded-v2", { upgradeCoreProtection: true }],
  ]);
  assert.deepEqual(JSON.parse(output.out[0] ?? "").data.created.manifest.capabilities, {
    sqlite: true,
    cas: true,
  });
});

test("--json 原样保留 Host 错误字段", async () => {
  const output = io();
  const detail = {
    code: "STREAM_VERSION_CONFLICT",
    message: "对象版本已变化",
    action: "刷新对象后重试",
    fieldIssues: [{ field: "expectedStreamVersion", message: "预期 1，实际 2" }],
    traceId: "trace-conflict",
    retryable: true,
  };
  const fetch: typeof globalThis.fetch = async () => Response.json(detail, { status: 409 });
  assert.equal(await runCli(["resume", "execution-1", "--json"], { io: output, fetch }), 1);
  assert.deepEqual(JSON.parse(output.out[0] ?? ""), {
    ok: false,
    command: "resume",
    error: detail,
  });
});
test("签名插件安装需确认宿主权限，更新带精确版本和乐观版本", async () => {
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => { requests.push(await captureRequest(input, init)); return ok(installationFixture()); };
  assert.equal(await runCli(["plugin", "install", "research", "--release", "1.2.3"], { io: io(), fetch }), 2);
  assert.equal(requests.length, 0);
  assert.equal(await runCli(["plugin", "install", "research", "--release", "1.2.3", "--trust-process"], { io: io(), fetch }), 0);
  assert.equal(await runCli(["plugin", "update", "research", "--release", "1.2.4", "--version", "2", "--trust-process"], { io: io(), fetch }), 0);
  assert.deepEqual(requests.map(({ method, path, body }) => ({ method, path, body })), [
    { method: "POST", path: "/v2/plugins/installations", body: { pluginId: "research", version: "1.2.3" } },
    { method: "PATCH", path: "/v2/plugins/installations/research", body: { version: "1.2.4", expectedStreamVersion: 2 } },
  ]);
});

test("插件 CLI 从签名字段定义验证参数并调用统一领域接口", async () => {
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init); requests.push(request);
    if (request.method === "GET") return ok([{ pluginId: "research", version: "1.0.0", navigation: [], cli: { commands: [{
      name: "summarize", commandId: "summarize", description: "整理资料", fields: [
        { name: "topic", type: "string", required: true },
        { name: "limit", type: "number" }, { name: "brief", type: "boolean" },
      ],
    }] } }]);
    return ok({ outcome: "资料摘要" });
  };
  const args = ["plugin", "run", "research", "summarize", "--workspace", "space", "--version", "4"];
  assert.equal(await runCli([...args, "--topic", "研究", "--limit", "5", "--brief", "true"], { io: io(), fetch }), 0);
  assert.equal(await runCli([...args, "--limit", "5"], { io: io(), fetch }), 2);
  assert.equal(await runCli([...args, "--topic", "研究", "--limit", "NaN"], { io: io(), fetch }), 2);
  assert.equal(await runCli([...args, "--topic", "研究", "--brief", "yes"], { io: io(), fetch }), 2);
  assert.equal(await runCli([...args, "--topic", "研究", "--unlisted", "yes"], { io: io(), fetch }), 2);
  const mutations = requests.filter((request) => request.method !== "GET");
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0]?.body, { workspaceId: "space", expectedStreamVersion: 4, topic: "研究", limit: 5, brief: true });
  assert.equal(mutations[0]?.path, "/v2/plugins/research/summarize");
  assert.ok(mutations[0]?.idempotencyKey);
});


test("备份升级缺少幂等事实时保留诊断且不建议丢弃承诺", async () => {
  const output = io();
  const backup = {
    async create(): Promise<never> { throw new Error("unexpected create"); },
    async check(): Promise<never> { throw new Error("unexpected check"); },
    async restore(): Promise<never> {
      throw new LocalBackupError("IDEMPOTENCY_PROTECTION_EVIDENCE_REQUIRED", "幂等回执缺少受保护事实");
    },
  };
  assert.equal(await runCli(["backup", "restore", "old.mnbackup", "--destination", "upgraded", "--upgrade-core-protection", "--json"],
    { io: output, backup }), 2);
  const error = JSON.parse(output.out[0]!).error;
  assert.equal(error.code, "IDEMPOTENCY_PROTECTION_EVIDENCE_REQUIRED");
  assert.match(error.action, /保留.*幂等/u);
  assert.match(error.action, /核对原操作/u);
  assert.doesNotMatch(error.action, /另一份|删除|重新发起|重试/u);
});
