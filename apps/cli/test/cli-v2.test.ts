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

test("backup 在本地创建、校验并恢复加密 SQLite 快照", async () => {
  const output = io();
  let called = false;
  const fetch: typeof globalThis.fetch = async () => { called = true; return ok({}); };
  const manifest = {
    format: "muniu-agent-os-local-backup",
    manifestVersion: 1,
    createdAt: "2026-09-04T08:00:00.000Z",
    capabilities: { sqlite: true, cas: false },
    payload: {
      mediaType: "application/vnd.sqlite3",
      bytes: 4096,
      sha256: "a".repeat(64),
      sqliteSchemaVersion: "2",
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
      return { file: `/state/restore/${destinationName}`, manifest };
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
    cas: false,
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
