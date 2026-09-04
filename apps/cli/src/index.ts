#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ApiErrorV2 } from "@mn/contracts";
import {
  LocalBackupError,
  LocalSqliteBackup,
  MacOsKeychainKeyProvider,
  type LocalBackupCheckResult,
  type LocalBackupCreateResult,
  type LocalBackupRestoreResult,
} from "@mn/storage";

const DEFAULT_API_URL = "http://127.0.0.1:7318";

const HELP = `木牛 Agent OS 0.2

用法：mn <命令> [参数]

命令：
  setup             完成视图、插件、模型和工作区设置
  ask               在当前工作区提交问题
  inbox             查看审批、问题、失败和人工核对
  resume            恢复暂停或中断的执行
  doctor --fix      检查连接与可安全修复项
  plugin            查看、启用、停用或清除插件
  opc               管理机会验证工作
  code              管理 Coding 任务
  backup            创建、校验或恢复本地加密备份

全局参数：
  --json            输出稳定 JSON
  --help            显示帮助

备份示例：
  mn backup create state.mnbackup --verify
  mn backup check state.mnbackup
  mn backup restore state.mnbackup --destination restored.sqlite3

外部 Coding Runner：
  生产 Worker 只接受官方原生安装的 macOS Mach-O CLI，不支持 npm/shebang wrapper
  mn code runners --workspace <工作区 ID>
  mn code runner inspect claude-cli --workspace <工作区 ID> --path /绝对路径/claude
  mn code runner confirm claude-cli --workspace <工作区 ID> --path /绝对路径/claude --binary-version <人工核实版本> --sha256 <摘要> --version <配置版本>
  mn ask <任务> --workspace <工作区 ID> --thread <会话 ID> --runner claude-cli
  mn code reconcile <执行 ID> terminate
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
  readonly backup?: CliBackup;
  readonly stateRoot?: string;
  readonly now?: () => Date;
}

export interface CliBackup {
  create(fileName: string): Promise<LocalBackupCreateResult>;
  check(fileName: string): Promise<LocalBackupCheckResult>;
  restore(fileName: string, destinationName: string): Promise<LocalBackupRestoreResult>;
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

class CliReportedError extends Error {
  constructor(readonly detail: ApiErrorV2, readonly status: number) {
    super(detail.message);
    this.name = "CliReportedError";
  }
}

class ApiRequestError extends CliReportedError {}

class CliCommandError extends CliReportedError {}

class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImplementation: typeof globalThis.fetch,
    private readonly nextIdempotencyKey: () => string,
  ) {}

  async get(path: string): Promise<unknown> {
    return this.request(path, { method: "GET" });
  }

  async readiness(): Promise<unknown> {
    return this.request("/v2/readiness", { method: "GET" }, new Set([503]));
  }

  async mutate(path: string, body: unknown, method: "POST" | "PATCH" | "DELETE" = "POST"): Promise<unknown> {
    return this.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": this.nextIdempotencyKey(),
      },
      body: JSON.stringify(body),
    });
  }

  async request(path: string, init: RequestInit, acceptedDataStatuses: ReadonlySet<number> = new Set()): Promise<unknown> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, init);
    let value: unknown;
    try {
      value = response.status === 204 ? undefined : await response.json();
    } catch {
      value = undefined;
    }
    if (!response.ok && !(acceptedDataStatuses.has(response.status) && hasData(value))) {
      const fallback: ApiErrorV2 = {
        code: "HTTP_ERROR", message: `请求失败（${response.status}）`, action: "运行 mn doctor",
        fieldIssues: [], traceId: response.headers.get("X-Trace-Id") ?? "unknown", retryable: response.status >= 500,
      };
      throw new ApiRequestError(isApiError(value) ? value : fallback, response.status);
    }
    return hasData(value) ? value.data : value;
  }
}

function isApiError(value: unknown): value is ApiErrorV2 {
  return typeof value === "object" && value !== null
    && "code" in value && typeof value.code === "string"
    && "message" in value && typeof value.message === "string"
    && "action" in value && typeof value.action === "string"
    && "fieldIssues" in value && Array.isArray(value.fieldIssues)
    && value.fieldIssues.every((issue) => typeof issue === "object" && issue !== null
      && "field" in issue && typeof issue.field === "string"
      && "message" in issue && typeof issue.message === "string")
    && "traceId" in value && typeof value.traceId === "string"
    && "retryable" in value && typeof value.retryable === "boolean";
}

function hasData(value: unknown): value is { readonly data: unknown } {
  return typeof value === "object" && value !== null && "data" in value;
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

function reconciliationVersions(
  value: unknown,
  executionId: string,
): { readonly expectedStreamVersion: number; readonly expectedCodingStreamVersion: number } {
  const detail = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
  const coreVersion = detail?.expectedStreamVersion;
  const codingVersion = detail?.expectedCodingStreamVersion;
  if (!detail || detail.executionId !== executionId
    || detail.status !== "needs_reconciliation"
    || typeof coreVersion !== "number" || !Number.isSafeInteger(coreVersion) || coreVersion < 1
    || typeof codingVersion !== "number" || !Number.isSafeInteger(codingVersion) || codingVersion < 1) {
    throw new CliUsageError("Host 未返回有效的人工核对版本，请刷新收件箱");
  }
  return {
    expectedStreamVersion: coreVersion,
    expectedCodingStreamVersion: codingVersion,
  };
}

async function setup(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["view", "plugins", "provider", "key", "workspace", "first"]);
  const view = flag(parsed, "view") ?? "business";
  if (view !== "business" && view !== "professional") throw new CliUsageError("--view 只能是 business 或 professional");
  const pluginIds = [...new Set(
    (flag(parsed, "plugins") ?? "opc,coding").split(",").map((item) => item.trim()).filter(Boolean),
  )];
  if (pluginIds.length === 0) throw new CliUsageError("--plugins 至少包含 opc 或 coding");
  if (pluginIds.some((plugin) => plugin !== "opc" && plugin !== "coding")) {
    throw new CliUsageError("--plugins 只能包含 opc 和 coding");
  }
  const workspaceName = (flag(parsed, "workspace") ?? "我的工作区").trim();
  const provider = flag(parsed, "provider")?.trim();
  const apiKey = flag(parsed, "key")?.trim();
  if ((provider && !apiKey) || (!provider && apiKey)) {
    throw new CliUsageError("连接模型时必须同时提供 --provider 和 --key");
  }
  const first = flag(parsed, "first")?.trim();
  const setupResult = await api.mutate("/v2/setup", {});
  let modelConnection: unknown;
  if (provider && apiKey) {
    const connection = await api.mutate("/v2/model-connections", {
      presetId: provider, apiKey, displayName: provider,
    }) as { id?: string; streamVersion?: number };
    if (!connection.id) throw new CliUsageError("Host 未返回模型连接 ID");
    modelConnection = await api.mutate(`/v2/model-connections/${encodeURIComponent(connection.id)}/probe`, {
      expectedStreamVersion: connection.streamVersion ?? 1,
    });
  }
  const workspace = await api.mutate("/v2/workspaces", { name: workspaceName, viewMode: view, pluginIds }) as { id?: string };
  let firstObject: unknown;
  let sample: unknown;
  if (first) {
    if (!workspace.id) throw new CliUsageError("Host 未返回工作区 ID");
    const primaryPlugin = pluginIds[0]!;
    const resource = primaryPlugin === "opc" ? "opportunities" : "repositories";
    firstObject = await api.mutate(`/v2/plugins/${primaryPlugin}/${resource}`, {
      workspaceId: workspace.id,
      expectedStreamVersion: 0,
      input: first,
    });
    sample = await api.mutate(`/v2/plugins/${primaryPlugin}/samples/read-only`, {
      workspaceId: workspace.id,
      expectedStreamVersion: 0,
    });
  }
  return {
    command: "setup",
    data: {
      setup: setupResult,
      workspace,
      ...(modelConnection ? { modelConnection } : {}),
      ...(firstObject ? { firstObject } : {}),
      ...(sample ? { sample } : {}),
    },
    human: `设置完成：${workspaceName}`,
  };
}

async function ask(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["workspace", "thread", "version", "runner"]);
  const message = parsed.positional.join(" ").trim();
  if (!message) throw new CliUsageError("请提供要提交的内容");
  const workspaceId = flag(parsed, "workspace", true)!;
  const threadId = flag(parsed, "thread", true)!;
  const runnerId = flag(parsed, "runner");
  if (runnerId !== undefined
    && runnerId !== "builtin" && runnerId !== "claude-cli" && runnerId !== "codex-cli") {
    throw new CliUsageError("--runner 只能是 builtin、claude-cli 或 codex-cli");
  }
  const data = await api.mutate(
    `/v2/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/turns`,
    {
      expectedStreamVersion: integerFlag(parsed, "version", 1),
      message,
      ...(runnerId ? { runnerId } : {}),
    },
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
  const [health, readiness] = await Promise.all([api.get("/v2/health"), api.readiness()]);
  const requested = parsed.flags.has("fix");
  const ready = typeof readiness === "object" && readiness !== null
    && "ready" in readiness && readiness.ready === true;
  const issues = readinessIssues(readiness);
  const fix = !requested
    ? { requested: false as const, status: "not_requested" as const, actions: [] as const }
    : ready && issues.length === 0
      ? { requested: true as const, status: "not_needed" as const, actions: [] as const }
      : {
          requested: true as const,
          status: "manual_action_required" as const,
          actions: [] as const,
          remainingIssues: issues,
        };
  const human = requested
    ? fix.status === "not_needed"
      ? "检查完成：未发现需要修复的项目"
      : `检查完成：发现 ${issues.length || "未识别"} 项问题；当前没有可安全自动修复的项目`
    : ready && issues.length === 0
      ? "Host 已就绪"
      : `Host 尚未就绪：${issues.length || "未识别"} 项问题`;
  return { command: "doctor", data: { health, readiness, fix }, human };
}

function readinessIssues(value: unknown): readonly unknown[] {
  if (typeof value !== "object" || value === null || !("issues" in value) || !Array.isArray(value.issues)) return [];
  return value.issues;
}

async function plugin(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["workspace", "version"]);
  const operation = parsed.positional[0] ?? "list";
  if (operation === "list") {
    return { command: "plugin", data: await api.get("/v2/plugins/installations"), human: "已列出可用插件" };
  }
  if (!["enable", "deactivate", "disable", "purge"].includes(operation)) {
    throw new CliUsageError("plugin 仅支持 list、enable、deactivate、disable 或 purge");
  }
  const pluginId = parsed.positional[1];
  if (!pluginId) throw new CliUsageError("请提供插件 ID");
  const expectedStreamVersion = integerFlag(parsed, "version", 1);
  if (operation === "enable") {
    const workspaceId = flag(parsed, "workspace", true)!;
    const data = await api.mutate(`/v2/workspaces/${encodeURIComponent(workspaceId)}/plugin-activations`, {
      expectedStreamVersion, pluginId,
    });
    return { command: "plugin", data, human: `已启用 ${pluginId}` };
  }
  if (operation === "deactivate") {
    const workspaceId = flag(parsed, "workspace", true)!;
    const data = await api.mutate(
      `/v2/workspaces/${encodeURIComponent(workspaceId)}/plugin-activations/${encodeURIComponent(pluginId)}`,
      { expectedStreamVersion },
      "DELETE",
    );
    return { command: "plugin", data, human: `已从工作区停用 ${pluginId}` };
  }
  if (parsed.flags.has("workspace")) {
    throw new CliUsageError(`plugin ${operation} 不接受 --workspace`);
  }
  if (operation === "disable") {
    const data = await api.mutate(
      `/v2/plugins/installations/${encodeURIComponent(pluginId)}/disable`,
      { expectedStreamVersion },
    );
    return { command: "plugin", data, human: `已全局停用 ${pluginId}` };
  }
  const data = await api.mutate(
    `/v2/plugins/installations/${encodeURIComponent(pluginId)}`,
    { expectedStreamVersion },
    "DELETE",
  );
  return { command: "plugin", data, human: `已清除 ${pluginId}` };
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
  const input = (flag(parsed, "input") ?? parsed.positional.slice(1).join(" ")).trim();
  let resource: "opportunities" | "repositories" | "tasks" | "samples/read-only";
  let human: string;
  if (product === "opc") {
    if (operation !== "capture" && operation !== "sample") {
      throw new CliUsageError("opc 仅支持 capture 或 sample");
    }
    resource = operation === "capture" ? "opportunities" : "samples/read-only";
    human = operation === "capture" ? "机会已生成，等待审阅" : "OPC 只读样例已完成";
  } else {
    if (operation !== "repository" && operation !== "task" && operation !== "sample") {
      throw new CliUsageError("code 仅支持 repository、task 或 sample");
    }
    resource = operation === "repository" ? "repositories"
      : operation === "task" ? "tasks" : "samples/read-only";
    human = operation === "repository" ? "仓库已登记，等待审阅"
      : operation === "task" ? "Coding 任务已生成，等待审阅" : "Coding 只读样例已完成";
  }
  if (resource !== "samples/read-only" && !input) throw new CliUsageError("请通过 --input 提供要捕获的内容");
  if (resource === "samples/read-only" && input) throw new CliUsageError("sample 不接受 --input 或额外文本");
  const data = await api.mutate(`/v2/plugins/${product}/${resource}`, {
    workspaceId,
    expectedStreamVersion: integerFlag(parsed, "version", 0),
    ...(input ? { input } : {}),
  });
  return { command, data, human };
}

function externalCodingRunnerId(value: string | undefined): "claude-cli" | "codex-cli" {
  if (value === "claude-cli" || value === "codex-cli") return value;
  throw new CliUsageError("Runner 只能是 claude-cli 或 codex-cli");
}

function absoluteRunnerPath(parsed: ParsedArguments): string {
  const binaryPath = flag(parsed, "path", true)!;
  if (!isAbsolute(binaryPath) || binaryPath.includes("\0")) {
    throw new CliUsageError("--path 必须是不含空字节的绝对路径");
  }
  return binaryPath;
}

async function code(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  const operation = parsed.positional[0] ?? "task";
  if (operation === "reconcile") {
    assertAllowedFlags(parsed, []);
    if (parsed.positional.length !== 3) {
      throw new CliUsageError("code reconcile 需要执行 ID 和决定");
    }
    const executionId = parsed.positional[1]!;
    const decision = parsed.positional[2];
    if (decision !== "terminate"
      && decision !== "mark_completed"
      && decision !== "create_new_call") {
      throw new CliUsageError(
        "核对决定只能是 terminate、mark_completed 或 create_new_call",
      );
    }
    const reconciliationPath =
      `/v2/plugins/coding/executions/${encodeURIComponent(executionId)}/reconciliation`;
    const versions = reconciliationVersions(await api.get(reconciliationPath), executionId);
    const data = await api.mutate(
      `${reconciliationPath}-decisions`,
      {
        ...versions,
        decision,
      },
    );
    const human = decision === "terminate"
      ? "未知外部调用已终止，清理任务已入队"
      : decision === "mark_completed"
        ? "已依据权威验证证据标记完成，清理任务已入队"
        : "旧调用已终止，新调用与清理任务已入队";
    return { command: "code", data, human };
  }
  if (operation !== "runner" && operation !== "runners") {
    return productCommand("coding", "code", parsed, api);
  }
  if (operation === "runners") {
    assertAllowedFlags(parsed, ["workspace"]);
    if (parsed.positional.length !== 1) throw new CliUsageError("code runners 不接受额外参数");
    const workspaceId = flag(parsed, "workspace", true)!;
    const data = await api.get(
      `/v2/plugins/coding/runners?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    return { command: "code", data, human: "已列出 Coding Runner" };
  }

  const action = parsed.positional[1];
  const runnerId = externalCodingRunnerId(parsed.positional[2]);
  const workspaceId = flag(parsed, "workspace", true)!;
  if (action === "inspect") {
    assertAllowedFlags(parsed, ["workspace", "path"]);
    if (parsed.positional.length !== 3) throw new CliUsageError("code runner inspect 不接受额外参数");
    const binaryPath = absoluteRunnerPath(parsed);
    const data = await api.mutate(
      `/v2/plugins/coding/runners/${encodeURIComponent(runnerId)}/inspections`,
      { workspaceId, binaryPath },
    );
    return {
      command: "code",
      data,
      human: `已被动检查 ${runnerId}；未执行该路径，请人工核实版本后确认 SHA-256`,
    };
  }
  if (action === "confirm") {
    assertAllowedFlags(parsed, ["workspace", "path", "binary-version", "sha256", "version"]);
    if (parsed.positional.length !== 3) throw new CliUsageError("code runner confirm 不接受额外参数");
    const binaryPath = absoluteRunnerPath(parsed);
    const version = flag(parsed, "binary-version", true)!;
    const sha256 = flag(parsed, "sha256", true)!;
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new CliUsageError("--sha256 必须是 64 位小写十六进制摘要");
    const data = await api.mutate(
      `/v2/plugins/coding/runners/${encodeURIComponent(runnerId)}/confirmations`,
      {
        workspaceId,
        expectedStreamVersion: integerFlag(parsed, "version", 0),
        binaryPath,
        version,
        sha256,
      },
    );
    return {
      command: "code",
      data,
      human: `已确认 ${runnerId}；二进制变化后需要重新确认`,
    };
  }
  throw new CliUsageError("code runner 仅支持 inspect 或 confirm");
}

const OPC_DOMAIN_COMMANDS = new Set([
  "frame",
  "start_research",
  "record_signal",
  "start_interviewing",
  "record_interview",
  "annotate_interview",
  "start_evaluation",
  "record_experiment",
  "propose_commitment",
  "confirm_commitment",
  "prepare_offer",
  "decide",
  "pause",
  "resume",
  "abandon",
]);

async function opc(parsed: ParsedArguments, api: ApiClient): Promise<CliResult> {
  assertAllowedFlags(parsed, ["workspace", "version", "input"]);
  const operation = parsed.positional[0] ?? "list";
  const workspaceId = flag(parsed, "workspace", true)!;
  if (operation === "list") {
    const data = await api.get(`/v2/plugins/opc/opportunities?workspaceId=${encodeURIComponent(workspaceId)}`);
    return { command: "opc", data, human: "已列出机会与下一步" };
  }
  if (operation === "capture" || operation === "sample") {
    return productCommand("opc", "opc", parsed, api);
  }
  if (!["show", "deliverables", "export"].includes(operation) && !OPC_DOMAIN_COMMANDS.has(operation)) {
    throw new CliUsageError("opc 支持 list、capture、show、deliverables、export、sample 或领域推进命令");
  }
  const opportunityId = parsed.positional[1];
  if (!opportunityId) throw new CliUsageError(`opc ${operation} 需要机会 ID`);
  const encodedId = encodeURIComponent(opportunityId);
  const workspaceQuery = `workspaceId=${encodeURIComponent(workspaceId)}`;
  if (operation === "show") {
    const data = await api.get(`/v2/plugins/opc/opportunities/${encodedId}?${workspaceQuery}`);
    return { command: "opc", data, human: "已读取机会档案" };
  }
  if (operation === "deliverables") {
    const data = await api.get(`/v2/plugins/opc/opportunities/${encodedId}/deliverables?${workspaceQuery}`);
    return { command: "opc", data, human: "已生成成果预览，结论会标明证据等级" };
  }
  if (operation === "export") {
    const data = await api.mutate(`/v2/plugins/opc/opportunities/${encodedId}/exports`, {
      workspaceId,
      expectedStreamVersion: integerFlag(parsed, "version", 1),
    });
    return { command: "opc", data, human: "六类 OPC 成果已写入成果页" };
  }
  const rawInput = flag(parsed, "input");
  let input: Record<string, unknown> = {};
  if (rawInput) {
    try {
      const parsedInput = JSON.parse(rawInput) as unknown;
      if (!parsedInput || typeof parsedInput !== "object" || Array.isArray(parsedInput)) throw new Error();
      input = parsedInput as Record<string, unknown>;
    } catch {
      throw new CliUsageError("OPC 领域命令的 --input 必须是 JSON 对象");
    }
  }
  const data = await api.mutate(`/v2/plugins/opc/opportunities/${encodedId}/commands`, {
    workspaceId,
    expectedStreamVersion: integerFlag(parsed, "version", 1),
    command: operation,
    input,
  });
  return { command: "opc", data, human: "机会已推进，证据、反证和下一步已更新" };
}

async function backup(
  parsed: ParsedArguments,
  getClient: () => CliBackup,
  now: () => Date,
): Promise<CliResult> {
  assertAllowedFlags(parsed, ["output", "file", "destination", "verify"]);
  const operation = parsed.positional[0] ?? "create";
  try {
    if (operation === "create") {
      const fileName = flag(parsed, "output") ?? parsed.positional[1]
        ?? `muniu-${now().toISOString().replace(/[:.]/gu, "-")}.mnbackup`;
      if (parsed.positional.length > 2) throw new CliUsageError("backup create 只接受一个备份文件名");
      const client = getClient();
      const created = await client.create(fileName);
      const checked = parsed.flags.has("verify") ? await client.check(fileName) : undefined;
      return {
        command: "backup",
        data: { operation, created, ...(checked ? { checked } : {}) },
        human: checked
          ? `加密备份已创建并校验：${created.file}`
          : `加密备份已创建：${created.file}`,
      };
    }
    if (operation === "check") {
      const fileName = flag(parsed, "file") ?? parsed.positional[1];
      if (!fileName || parsed.positional.length > 2) {
        throw new CliUsageError("用法：mn backup check <备份文件名>");
      }
      const checked = await getClient().check(fileName);
      return { command: "backup", data: { operation, checked }, human: `备份校验通过：${checked.file}` };
    }
    if (operation === "restore") {
      const fileName = flag(parsed, "file") ?? parsed.positional[1];
      if (!fileName || parsed.positional.length > 2) {
        throw new CliUsageError("用法：mn backup restore <备份文件名> --destination <新数据库文件名>");
      }
      const destination = flag(parsed, "destination", true)!;
      const restored = await getClient().restore(fileName, destination);
      return {
        command: "backup",
        data: { operation, restored },
        human: `备份已恢复到独立文件：${restored.file}；确认后再切换状态目录`,
      };
    }
    throw new CliUsageError("backup 仅支持 create、check 或 restore");
  } catch (error) {
    if (!(error instanceof LocalBackupError)) throw error;
    throw new CliCommandError({
      code: error.code,
      message: error.message,
      action: backupErrorAction(error.code),
      fieldIssues: [],
      traceId: "cli-local",
      retryable: error.code === "BACKUP_IO_FAILED",
    }, error.code === "BACKUP_DESTINATION_EXISTS" ? 409 : 422);
  }
}

function backupErrorAction(code: string): string {
  if (code === "BACKUP_DESTINATION_EXISTS") return "使用新的文件名；木牛不会覆盖已有备份或数据库";
  if (code === "BACKUP_DECRYPTION_FAILED") return "确认当前 Keychain 仍包含创建备份时使用的 v2 包装密钥";
  if (code === "BACKUP_SOURCE_NOT_FOUND") return "检查备份文件名或先创建备份";
  if (code === "BACKUP_INTEGRITY_FAILED" || code === "BACKUP_SQLITE_INVALID") return "不要恢复该文件，改用另一份已校验备份";
  return "检查本地 v2 状态目录与文件权限后重试";
}

function createDefaultBackup(dependencies: CliDependencies): CliBackup {
  const stateRoot = resolve(dependencies.stateRoot ?? process.env.MN_STATE_ROOT ?? join(homedir(), ".muniu", "v2"));
  return new LocalSqliteBackup({
    databaseFile: join(stateRoot, "state.sqlite3"),
    casDirectory: join(stateRoot, "cas"),
    backupDirectory: join(stateRoot, "backups"),
    restoreDirectory: join(stateRoot, "restore"),
    keyProvider: new MacOsKeychainKeyProvider({ account: "backup-wrapping-key" }),
  });
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
      case "opc": result = await opc(parsed, api); break;
      case "code": result = await code(parsed, api); break;
      case "backup": result = await backup(
        parsed,
        () => dependencies.backup ?? createDefaultBackup(dependencies),
        dependencies.now ?? (() => new Date()),
      ); break;
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
      if (parsedAll.flags.has("json")) {
        io.stdout(JSON.stringify({
          ok: false,
          command,
          error: {
            code: "CLI_USAGE_ERROR",
            message: error.message,
            action: "运行 mn --help 查看可用参数",
            fieldIssues: [],
            traceId: "cli-local",
            retryable: false,
          },
        }));
      } else {
        io.stderr(error.message);
      }
      return 2;
    }
    if (error instanceof CliReportedError) {
      if (parsedAll.flags.has("json")) {
        io.stdout(JSON.stringify({ ok: false, command, error: error.detail }));
      } else {
        io.stderr(`${error.detail.message}。${error.detail.action}`);
      }
      return error.detail.retryable ? 1 : 2;
    }
    const detail: ApiErrorV2 = {
      code: "CLI_UNEXPECTED_ERROR",
      message: "命令执行失败",
      action: "运行 mn doctor 后重试",
      fieldIssues: [],
      traceId: "cli-local",
      retryable: true,
    };
    if (parsedAll.flags.has("json")) {
      io.stdout(JSON.stringify({ ok: false, command, error: detail }));
    } else {
      io.stderr(`${detail.message}。${detail.action}`);
    }
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
