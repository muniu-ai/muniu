#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ApiErrorV2 } from "@mn/contracts";

const DEFAULT_API_URL = "http://127.0.0.1:7318";

const HELP = `木牛 Agent OS 0.2

用法：mn <命令> [参数]

命令：
  setup             完成视图、插件、模型和工作区设置
  ask               在当前工作区提交问题
  inbox             查看审批、问题、失败和人工核对
  resume            恢复暂停或中断的执行
  doctor --fix      检查并修复本地连接
  plugin            查看或启用插件
  opc               管理机会验证工作
  code              管理 Coding 任务
  backup            创建或校验加密备份

全局参数：
  --json            输出稳定 JSON
  --help            显示帮助
`;

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliDependencies {
  readonly io?: CliIo;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiUrl?: string;
  readonly idempotencyKey?: () => string;
}

interface ParsedArguments {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

interface CliResult {
  readonly command: string;
  readonly data: unknown;
  readonly human: string;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

class ApiRequestError extends Error {
  constructor(readonly detail: ApiErrorV2, readonly status: number) {
    super(detail.message);
    this.name = "ApiRequestError";
  }
}

class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImplementation: typeof globalThis.fetch,
    private readonly nextIdempotencyKey: () => string,
  ) {}

  async get(path: string): Promise<unknown> {
    return this.request(path, { method: "GET" });
  }

  async mutate(path: string, body: unknown): Promise<unknown> {
    return this.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": this.nextIdempotencyKey(),
      },
      body: JSON.stringify(body),
    });
  }

  async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, init);
    const value = await response.json() as { data?: unknown } | ApiErrorV2;
    if (!response.ok) {
      const fallback: ApiErrorV2 = {
        code: "HTTP_ERROR", message: `请求失败（${response.status}）`, action: "运行 mn doctor",
        fieldIssues: [], traceId: response.headers.get("X-Trace-Id") ?? "unknown", retryable: response.status >= 500,
      };
      throw new ApiRequestError(isApiError(value) ? value : fallback, response.status);
    }
    return "data" in value ? value.data : value;
  }
}

function isApiError(value: unknown): value is ApiErrorV2 {
  return typeof value === "object" && value !== null
    && "code" in value && typeof value.code === "string"
    && "message" in value && typeof value.message === "string"
    && "action" in value && typeof value.action === "string";
}

function parseArguments(arguments_: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const booleanFlags = new Set(["json", "help", "fix", "verify"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index]!;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals > 2) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const name = value.slice(2);
    if (booleanFlags.has(name)) {
      flags.set(name, true);
      continue;
    }
    const next = arguments_[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function assertAllowedFlags(parsed: ParsedArguments, allowed: readonly string[]): void {
  const accepted = new Set([...allowed, "json", "help"]);
  for (const name of parsed.flags.keys()) {
    if (!accepted.has(name)) throw new CliUsageError(`不支持的参数：--${name}`);
  }
}

function flag(parsed: ParsedArguments, name: string, required = false): string | undefined {
  const value = parsed.flags.get(name);
  if (typeof value === "string" && value.trim()) return value;
  if (required) throw new CliUsageError(`缺少参数：--${name}`);
  return undefined;
}

function integerFlag(parsed: ParsedArguments, name: string, fallback: number): number {
  const raw = flag(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new CliUsageError(`--${name} 必须是非负整数`);
  return value;
}

async function setup(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["view", "plugins", "provider", "key", "workspace", "first"]);
  const view = flag(parsed, "view") ?? "business";
  if (view !== "business" && view !== "professional") throw new CliUsageError("--view 只能是 business 或 professional");
  const pluginIds = (flag(parsed, "plugins") ?? "opc,coding").split(",").map((item) => item.trim()).filter(Boolean);
  if (pluginIds.some((plugin) => plugin !== "opc" && plugin !== "coding")) {
    throw new CliUsageError("--plugins 只能包含 opc 和 coding");
  }
  const workspaceName = flag(parsed, "workspace") ?? "我的工作区";
  const workspace = await api.mutate("/v2/workspaces", { name: workspaceName, viewMode: view, pluginIds }) as { id?: string };
  const provider = flag(parsed, "provider");
  const apiKey = flag(parsed, "key");
  let modelConnection: unknown;
  if (provider || apiKey) {
    if (!provider || !apiKey) throw new CliUsageError("连接模型时必须同时提供 --provider 和 --key");
    const connection = await api.mutate("/v2/model-connections", {
      presetId: provider, apiKey, displayName: provider,
    }) as { id?: string; streamVersion?: number };
    if (!connection.id) throw new CliUsageError("Host 未返回模型连接 ID");
    modelConnection = await api.mutate(`/v2/model-connections/${encodeURIComponent(connection.id)}/probe`, {
      expectedStreamVersion: connection.streamVersion ?? 1,
    });
  }
  const first = flag(parsed, "first");
  return {
    command: "setup",
    data: { workspace, ...(modelConnection ? { modelConnection } : {}), ...(first ? { first } : {}) },
    human: `设置完成：${workspaceName}`,
  };
}

async function ask(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["workspace", "thread", "version"]);
  const message = parsed.positional.join(" ").trim();
  if (!message) throw new CliUsageError("请提供要提交的内容");
  const workspaceId = flag(parsed, "workspace", true)!;
  const threadId = flag(parsed, "thread", true)!;
  const data = await api.mutate(
    `/v2/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/turns`,
    { expectedStreamVersion: integerFlag(parsed, "version", 1), message },
  );
  return { command: "ask", data, human: "已提交，结果会进入当前会话和成果页" };
}

async function inbox(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["workspace"]);
  const workspaceId = flag(parsed, "workspace");
  const data = await api.get(`/v2/inbox${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`);
  const count = Array.isArray(data) ? data.length : 0;
  return { command: "inbox", data, human: count ? `收件箱有 ${count} 项待处理` : "收件箱暂无待处理事项" };
}

async function resume(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["version"]);
  const executionId = parsed.positional[0];
  if (!executionId) throw new CliUsageError("请提供执行 ID");
  const data = await api.mutate(`/v2/executions/${encodeURIComponent(executionId)}/commands`, {
    expectedStreamVersion: integerFlag(parsed, "version", 1), command: "resume",
  });
  return { command: "resume", data, human: "执行已恢复" };
}

async function doctor(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["fix"]);
  const [health, readiness] = await Promise.all([api.get("/v2/health"), api.get("/v2/readiness")]);
  const data = { health, readiness, fixRequested: parsed.flags.has("fix") };
  return { command: "doctor", data, human: "Host 连接正常，已完成运行检查" };
}

async function plugin(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["workspace", "version"]);
  const operation = parsed.positional[0] ?? "list";
  if (operation === "list") {
    return { command: "plugin", data: await api.get("/v2/plugins/installations"), human: "已列出可用插件" };
  }
  if (operation !== "enable") throw new CliUsageError("plugin 仅支持 list 或 enable");
  const pluginId = parsed.positional[1];
  if (!pluginId) throw new CliUsageError("请提供插件 ID");
  const workspaceId = flag(parsed, "workspace", true)!;
  const data = await api.mutate(`/v2/workspaces/${encodeURIComponent(workspaceId)}/plugin-activations`, {
    expectedStreamVersion: integerFlag(parsed, "version", 1), pluginId,
  });
  return { command: "plugin", data, human: `已启用 ${pluginId}` };
}

async function productCommand(
  product: "opc" | "coding",
  command: "opc" | "code",
  parsed: ParsedArguments,
  api: ApiClient,
): Promise<CliResult> {
  assertAllowedFlags(parsed, ["workspace", "version", "input"]);
  const operation = parsed.positional[0] ?? (product === "opc" ? "capture" : "task");
  const workspaceId = flag(parsed, "workspace", true)!;
  const text = flag(parsed, "input") ?? parsed.positional.slice(1).join(" ");
  const data = await api.mutate(`/v2/plugins/${product}/${encodeURIComponent(operation)}`, {
    workspaceId, expectedStreamVersion: integerFlag(parsed, "version", 0), text,
  });
  return { command, data, human: product === "opc" ? "机会工作已更新" : "Coding 任务已更新" };
}

async function backup(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["output", "verify"]);
  const data = await api.mutate("/v2/backups", {
    output: flag(parsed, "output") ?? "muniu-v2-backup.mnbackup",
    verify: parsed.flags.has("verify"),
  });
  return { command: "backup", data, human: "加密备份已创建并校验" };
}

export async function runCli(arguments_: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? {
    stdout: (line: string) => process.stdout.write(`${line}\n`),
    stderr: (line: string) => process.stderr.write(`${line}\n`),
  };
  const parsedAll = parseArguments(arguments_);
  if (parsedAll.flags.has("help") || parsedAll.positional[0] === "help" || arguments_.length === 0) {
    io.stdout(HELP.trimEnd());
    return 0;
  }
  const command = parsedAll.positional[0]!;
  const parsed: ParsedArguments = {
    positional: parsedAll.positional.slice(1),
    flags: parsedAll.flags,
  };
  const api = new ApiClient(
    dependencies.apiUrl ?? process.env.MN_API_URL ?? DEFAULT_API_URL,
    dependencies.fetch ?? globalThis.fetch,
    dependencies.idempotencyKey ?? randomUUID,
  );
  try {
    let result: CliResult;
    switch (command) {
      case "setup": result = await setup(parsed, api); break;
      case "ask": result = await ask(parsed, api); break;
      case "inbox": result = await inbox(parsed, api); break;
      case "resume": result = await resume(parsed, api); break;
      case "doctor": result = await doctor(parsed, api); break;
      case "plugin": result = await plugin(parsed, api); break;
      case "opc": result = await productCommand("opc", "opc", parsed, api); break;
      case "code": result = await productCommand("coding", "code", parsed, api); break;
      case "backup": result = await backup(parsed, api); break;
      default: throw new CliUsageError(`未知命令：${command}`);
    }
    if (parsedAll.flags.has("json")) {
      io.stdout(JSON.stringify({ ok: true, command: result.command, data: result.data }));
    } else {
      io.stdout(result.human);
    }
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(error.message);
      return 2;
    }
    if (error instanceof ApiRequestError) {
      if (parsedAll.flags.has("json")) {
        const { traceId: _traceId, fieldIssues: _fieldIssues, ...detail } = error.detail;
        io.stdout(JSON.stringify({ ok: false, command, error: detail }));
      } else {
        io.stderr(`${error.detail.message}。${error.detail.action}`);
      }
      return error.detail.retryable ? 1 : 2;
    }
    io.stderr("命令执行失败。请运行 mn doctor 后重试");
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
