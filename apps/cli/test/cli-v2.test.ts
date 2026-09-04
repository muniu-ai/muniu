import assert from "node:assert/strict";
import test from "node:test";
import type {
  LocalBackupCheckResult,
  LocalBackupCreateResult,
  LocalBackupRestoreResult,
} from "@mn/storage";
import { runCli, type CliIo } from "../src/index.js";

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
  const fetch: typeof globalThis.fetch = async () => ok([{ id: "approval:1", title: "操作需要批准" }]);
  assert.equal(await runCli(["inbox", "--json"], { io: output, fetch }), 0);
  assert.deepEqual(JSON.parse(output.out[0] ?? ""), {
    ok: true,
    command: "inbox",
    data: [{ id: "approval:1", title: "操作需要批准" }],
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
      return ok({ id: "workspace-1", streamVersion: 1, activePluginIds: ["opc"] }, 201);
    }
    if (request.path === "/v2/plugins/opc/opportunities") return ok({ id: "opportunity-1", state: "captured" }, 201);
    if (request.path === "/v2/plugins/opc/samples/read-only") {
      return ok({ id: "sample-1", effectClass: "external_read", status: "completed" });
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
    workspace: { id: "workspace-1", streamVersion: 1, activePluginIds: ["opc"] },
    firstObject: { id: "opportunity-1", state: "captured" },
    sample: { id: "sample-1", effectClass: "external_read", status: "completed" },
  });
});

test("setup 为 Coding 创建真实仓库和本地只读样例", async () => {
  const output = io();
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);
    if (request.path === "/v2/setup") return ok({ tenantId: "local", principalId: "local-owner" });
    if (request.path === "/v2/workspaces") return ok({ id: "workspace-code", streamVersion: 1 }, 201);
    if (request.path === "/v2/plugins/coding/repositories") return ok({ id: "repository-1", name: "muniu" }, 201);
    if (request.path === "/v2/plugins/coding/samples/read-only") {
      return ok({ id: "sample-code", effectClass: "local_read", status: "completed" });
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
    if (request.path === "/v2/model-connections") return ok({ id: "connection-1", streamVersion: 1 }, 201);
    if (request.path === "/v2/model-connections/connection-1/probe") {
      return ok({ id: "connection-1", streamVersion: 2, defaultModel: "deepseek-chat", status: "ready" });
    }
    if (request.path === "/v2/workspaces") return ok({ id: "workspace-1", streamVersion: 1 }, 201);
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
    requests.push(await captureRequest(input, init));
    return ok({ pluginId: "research" });
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
      return ok({ id: "created" }, entry.path.includes("samples") ? 200 : 201);
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

test("ask 仅在显式指定时发送外部 Coding Runner", async () => {
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(await captureRequest(input, init));
    return ok({ id: "execution-1", runnerId: "claude-cli" }, 202);
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

test("code runner 提供检查、人工确认与状态查询", async () => {
  const output = io();
  const requests: Array<CapturedRequest & { readonly search: string }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({ ...request, search: url.search });
    if (request.path.endsWith("/inspections")) {
      return ok({
        requestedPath: "/opt/homebrew/bin/claude",
        realPath: "/opt/homebrew/bin/claude",
        sha256: "a".repeat(64),
      });
    }
    if (request.path.endsWith("/confirmations")) {
      return ok({ runnerId: "claude-cli", status: "confirmed", streamVersion: 3 });
    }
    return ok([{ runnerId: "builtin", status: "ready" }]);
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
        return ok({
          executionId: "execution/a",
          status: "needs_reconciliation",
          expectedStreamVersion: 4,
          expectedCodingStreamVersion: 7,
          evidence: {
            markCompletedAllowed: decision === "mark_completed",
            summary: "核对证据摘要",
          },
        });
      }
      return ok({ decision, cleanupJobId: "cleanup-1" });
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
  assert.match(output.err[1] ?? "", /人工核对版本/);
});

test("doctor --fix 明确报告无需修复且不发起写请求", async () => {
  const output = io();
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);
    if (request.path === "/v2/health") return ok({ core: { status: "healthy" }, plugins: [] });
    if (request.path === "/v2/readiness") return ok({ ready: true, issues: [] });
    return Response.json({}, { status: 404 });
  };
  assert.equal(await runCli(["doctor", "--fix", "--json"], { io: output, fetch }), 0);
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/v2/health" },
    { method: "GET", path: "/v2/readiness" },
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
    async restore(fileName: string, destinationName: string): Promise<LocalBackupRestoreResult> {
      calls.push(["restore", fileName, destinationName]);
      return {
        file: `/state/restore/${destinationName}`,
        casDirectory: `/state/restore/${destinationName}.cas`,
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
    "backup", "restore", "state.mnbackup", "--destination", "restored.sqlite3", "--json",
  ], { io: output, fetch, backup }), 0);
  assert.equal(called, false);
  assert.deepEqual(calls, [
    ["create", "state.mnbackup"],
    ["check", "state.mnbackup"],
    ["check", "state.mnbackup"],
    ["restore", "state.mnbackup", "restored.sqlite3"],
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
