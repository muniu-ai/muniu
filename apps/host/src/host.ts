import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { KernelProjectionRuntimeStore, type RuntimeRecord } from "@mn/agent-runtime";
import {
  apiError,
  createOpenApiDocument,
  type Approval,
  type Asset,
  type Deliverable,
  type Execution,
  type JsonObject,
  type JsonValue,
  type MemoryRecord,
  type Thread,
  type ThreadTurnSessionEntry,
  type ThreadTurnsView,
  type Workspace,
  type WorkspaceMembership,
} from "@mn/contracts";
import {
  AgentOsKernel,
  KernelError,
  PROVIDER_PRESETS,
  sha256,
  StreamVersionConflictError as KernelStreamVersionConflictError,
  type InboxItem,
  type KernelStore,
  type KernelTransaction,
  type ModelConnection,
  type ProtectedPayloadKeyDestroyer,
  type ProviderPreset,
} from "@mn/kernel";
import {
  PluginBoundaryError,
  PluginContributionHost,
  PluginPolicyError,
  type PluginDefinitionV1,
  type PluginExecutionControl,
} from "@mn/plugin-sdk";
import {
  CursorExpiredError,
  IdempotencyConflictError,
  StreamVersionConflictError as StorageStreamVersionConflictError,
  type ContentAddressedStorage,
} from "@mn/storage";
import { codingPlugin } from "@mn/plugin-coding";
import { createOpcPluginDefinition, exportOpportunityDeliverables, OpcService } from "@mn/plugin-opc";
import type { EnterpriseReadiness } from "./config.js";
import { createAssets } from "./assets.js";
import {
  KernelOpcRepository,
  captureCodingRepository,
  captureCodingTask,
  captureOpportunity,
  deliverableSummary,
  encodePluginWorkspace,
  exportOpcOpportunity,
  listCodingTaskSummaries,
  listOpportunitySummaries,
  runReadOnlySample,
  workspaceActivity,
  workspaceHome,
} from "./product-state.js";
import { executeOpcCommand } from "./opc-api.js";
import {
  LocalProductionPluginInstaller,
  LocalSignedPluginRepository,
  type PluginInstallerPort,
  type ProductionPluginProjectionManager,
  type TrustedRegistryRoot,
} from "./plugin-installation.js";
import type { ModelSecretStore } from "./secrets.js";

const LOCAL_TENANT_ID = "local";
const LOCAL_ACTOR_ID = "local-owner";
const DESKTOP_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);

export interface ModelProbeResult {
  readonly models: readonly string[];
  readonly defaultModel: string;
}

export type ModelProbe = (input: {
  readonly preset: ProviderPreset;
  readonly apiKey: string;
}) => Promise<ModelProbeResult>;

export interface AgentOsHostOptions {
  readonly store: KernelStore;
  readonly profile?: "local" | "enterprise";
  readonly cas?: ContentAddressedStorage;
  readonly secretStore: ModelSecretStore;
  readonly modelProbe?: ModelProbe;
  readonly officialPlugins?: readonly PluginDefinitionV1[];
  readonly pluginInstaller?: PluginInstallerPort;
  /** 本地生产仓库只暴露组合根已经加载的签名制品，不访问远程 JavaScript。 */
  readonly pluginRepository?: LocalSignedPluginRepository;
  readonly trustedPluginRoots?: readonly TrustedRegistryRoot[];
  /** 生产更新先通过此端口排空该插件的 Execution。 */
  readonly pluginExecutionControl?: PluginExecutionControl;
  /** 投影先在独立命名空间重放；activate 在 Kernel 事务内原子切换。 */
  readonly pluginProjections?: ProductionPluginProjectionManager;
  readonly readiness?: () => EnterpriseReadiness | Promise<EnterpriseReadiness>;
  readonly now?: () => string;
  readonly id?: (kind: string) => string;
  readonly identityResolver?: (request: Request) => {
    readonly tenantId: string;
    readonly principalId: string;
  } | Promise<{ readonly tenantId: string; readonly principalId: string }>;
  /** 仅用于本地开发或测试宿主附加受信 WebView 来源。 */
  readonly allowedOrigins?: readonly string[];
  readonly protectedPayloadKeys?: ProtectedPayloadKeyDestroyer;
  /** 默认由 profile 决定：本地 Keychain，企业 Vault/KMS。 */
  readonly acceptsModelSecretReference?: (reference: string) => boolean;
  /** 组合根用于先停止共享同一 Store 的 Worker。 */
  readonly beforeStoreClose?: () => Promise<void>;
  /** 测试与部署可按负载调节；生产默认每 250 ms 读取一次新事件。 */
  readonly ssePollIntervalMs?: number;
  /** 测试与代理配置可调节；生产默认每 15 秒发送一次空闲保活。 */
  readonly sseKeepAliveIntervalMs?: number;
}

export interface ListenOptions {
  readonly host?: string;
  readonly port: number;
}

export interface AgentOsHost {
  readonly context: Context;
  readonly kernel: AgentOsKernel;
  readonly plugins: PluginContributionHost;
  dispatch(request: Request): Promise<Response>;
  listen(options: ListenOptions): Promise<{ readonly host: string; readonly port: number }>;
  close(): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new KernelError("INVALID_BODY", "请求体必须是 JSON 对象", "检查请求格式");
  return value as JsonObject;
}

function stringField(body: Record<string, unknown>, field: string, required = true): string | undefined {
  const value = body[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new KernelError("INVALID_BODY", `${field} 必须是非空字符串`, `填写 ${field}`);
  }
  return value;
}

function expectedVersion(body: Record<string, unknown>): number {
  const value = body.expectedStreamVersion;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new KernelError("EXPECTED_STREAM_VERSION_REQUIRED", "缺少有效的 expectedStreamVersion", "刷新对象后重试");
  }
  return Number(value);
}

function json(value: unknown, status = 200, traceId: string = randomUUID()): Response {
  return Response.json({ data: value as JsonValue, traceId }, { status });
}

function safeError(error: unknown, traceId: string): Response {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "服务暂时不可用";
  let action = "稍后重试；若问题持续，请运行 mn doctor";
  let retryable = true;
  if (error instanceof CursorExpiredError || (isObject(error) && error.code === "EVENT_CURSOR_EXPIRED")) {
    status = 410; code = "EVENT_CURSOR_EXPIRED"; message = "事件游标已过保留期";
    action = "重新读取工作区快照和最新游标"; retryable = false;
  } else if (error instanceof KernelStreamVersionConflictError
    || error instanceof StorageStreamVersionConflictError
    || (isObject(error) && error.code === "STREAM_VERSION_CONFLICT")) {
    status = 409; code = "STREAM_VERSION_CONFLICT"; message = "对象版本已变化";
    action = "刷新对象后重试"; retryable = true;
  } else if (error instanceof IdempotencyConflictError
    || (error instanceof KernelError && error.code === "IDEMPOTENCY_KEY_REUSED")) {
    status = 409; code = "IDEMPOTENCY_KEY_REUSED"; message = "幂等键已用于不同请求";
    action = "使用新的 Idempotency-Key"; retryable = false;
  } else if (error instanceof PluginBoundaryError) {
    status = 502; code = "PLUGIN_DEGRADED"; message = "插件执行失败，已隔离该故障";
    action = "查看插件状态或停用该插件"; retryable = true;
  } else if (error instanceof PluginPolicyError) {
    status = 422; code = error.code; message = error.message; action = error.action; retryable = false;
  } else if (error instanceof KernelError) {
    status = error.code === "STREAM_VERSION_CONFLICT" ? 409
      : error.code === "AUTHENTICATION_REQUIRED" ? 401
        : error.code === "WORKSPACE_ACCESS_DENIED" ? 403
          : error.code === "NOT_FOUND" || error.code.endsWith("_NOT_FOUND") ? 404
            : 422;
    code = error.code; message = error.message; action = error.action; retryable = error.retryable;
  } else if (isObject(error)
    && typeof error.code === "string"
    && typeof error.message === "string"
    && typeof error.action === "string") {
    status = error.code === "NOT_FOUND" ? 404
      : error.code === "IDEMPOTENCY_KEY_REUSED" ? 409
        : 422;
    code = error.code;
    message = error.message;
    action = error.action;
    retryable = Boolean(error.retryable);
    const field = typeof error.field === "string" ? error.field : undefined;
    return Response.json(apiError(code, message, action, traceId, {
      retryable,
      ...(field ? { fieldIssues: [{ field, message }] } : {}),
    }), { status });
  } else if (error instanceof SyntaxError) {
    status = 400; code = "INVALID_JSON"; message = "请求体不是有效 JSON"; action = "检查 JSON 格式"; retryable = false;
  }
  return Response.json(apiError(code, message, action, traceId, { retryable }), { status });
}

function notFound(traceId: string): Response {
  return Response.json(apiError("NOT_FOUND", "接口不存在", "检查请求路径", traceId), { status: 404 });
}

async function readBody(request: Request): Promise<JsonObject> {
  if (!request.body) return {};
  return asJsonObject(await request.json());
}

function requireMutationKey(request: Request, traceId: string): Response | string {
  const key = request.headers.get("Idempotency-Key")?.trim();
  if (key) return key;
  return Response.json(apiError(
    "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key", "为本次写操作提供唯一键", traceId,
  ), { status: 400 });
}

function positiveInterval(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function workspaceOwnsEvent(
  workspaceId: string,
  event: Awaited<ReturnType<KernelStore["readEvents"]>>["events"][number],
): boolean {
  return (event.aggregateType === "workspace" && event.aggregateId === workspaceId)
    || event.publicPayload.workspaceId === workspaceId;
}

function eventStream(input: {
  readonly initialPage: Awaited<ReturnType<KernelStore["readEvents"]>>;
  readonly readPage: (afterPosition: number) => Promise<Awaited<ReturnType<KernelStore["readEvents"]>>>;
  readonly workspaceId: string;
  readonly traceId: string;
  readonly signal: AbortSignal;
  readonly pollIntervalMs: number;
  readonly keepAliveIntervalMs: number;
  readonly activeStreams: Set<() => void>;
}): Response {
  const encoder = new TextEncoder();
  let cancelStream: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = input.initialPage.nextPosition;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let nextPollAt = Date.now() + input.pollIntervalMs;
      let nextKeepAliveAt = Date.now() + input.keepAliveIntervalMs;

      const enqueue = (value: string) => {
        if (!stopped) controller.enqueue(encoder.encode(value));
      };
      const emitPage = (
        page: Awaited<ReturnType<KernelStore["readEvents"]>>,
        emitCursor: boolean,
      ) => {
        const lines: string[] = [];
        for (const event of page.events) {
          if (!workspaceOwnsEvent(input.workspaceId, event)) continue;
          lines.push(`id: ${event.position}`, "event: kernel", `data: ${JSON.stringify(event)}`, "");
        }
        if (emitCursor) {
          lines.push(
            `id: ${page.nextPosition}`,
            "event: cursor",
            `data: ${JSON.stringify({ position: page.nextPosition, traceId: input.traceId })}`,
            "",
          );
        }
        if (lines.length > 0) {
          enqueue(`${lines.join("\n")}\n`);
          nextKeepAliveAt = Date.now() + input.keepAliveIntervalMs;
        }
      };
      const cleanup = (closeController: boolean) => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
        input.activeStreams.delete(closeFromHost);
        if (closeController) controller.close();
      };
      const closeFromHost = () => cleanup(true);
      const onAbort = () => cleanup(true);
      cancelStream = () => cleanup(false);

      const schedule = () => {
        if (stopped) return;
        const dueAt = Math.min(nextPollAt, nextKeepAliveAt);
        timer = setTimeout(() => void tick(), Math.max(0, dueAt - Date.now()));
        timer.unref?.();
      };
      const poll = async () => {
        let pageCount = 0;
        while (!stopped && pageCount < 10) {
          const previousCursor = cursor;
          const page = await input.readPage(cursor);
          if (stopped) return;
          cursor = page.nextPosition;
          if (cursor > previousCursor) emitPage(page, true);
          pageCount += 1;
          if (page.events.length < 200 || cursor === previousCursor) return;
        }
        if (!stopped && pageCount === 10) nextPollAt = Date.now();
      };
      const tick = async () => {
        if (stopped) return;
        try {
          const beforePoll = Date.now();
          if (beforePoll >= nextPollAt) {
            nextPollAt = beforePoll + input.pollIntervalMs;
            await poll();
          }
          if (stopped) return;
          const afterPoll = Date.now();
          if (afterPoll >= nextKeepAliveAt) {
            enqueue(": keepalive\n\n");
            nextKeepAliveAt = afterPoll + input.keepAliveIntervalMs;
          }
          schedule();
        } catch (error) {
          if (stopped) return;
          cleanup(false);
          controller.error(error);
        }
      };

      input.activeStreams.add(closeFromHost);
      input.signal.addEventListener("abort", onAbort, { once: true });
      emitPage(input.initialPage, true);
      if (input.signal.aborted) {
        cleanup(true);
      } else {
        schedule();
      }
    },
    cancel() {
      cancelStream();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function waitForDrainOrClose(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}

async function pipeResponseBody(response: Response, outgoing: ServerResponse): Promise<void> {
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  let disconnected = outgoing.destroyed;
  const cancel = () => {
    disconnected = true;
    void reader.cancel().catch(() => undefined);
  };
  outgoing.once("close", cancel);
  try {
    while (!disconnected) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!outgoing.write(Buffer.from(chunk.value))) await waitForDrainOrClose(outgoing);
    }
    if (!disconnected) outgoing.end();
  } catch (error) {
    if (!disconnected) {
      outgoing.destroy(error instanceof Error ? error : new Error("Response stream failed"));
    }
  } finally {
    outgoing.off("close", cancel);
    reader.releaseLock();
  }
}

function projectionList<T>(store: KernelStore, tenantId: string, namespace: string): Promise<readonly T[]> {
  return store.transact(tenantId, (transaction) => transaction.listProjections<T>(namespace));
}

function projectionGet<T>(store: KernelStore, tenantId: string, namespace: string, id: string): Promise<T | undefined> {
  return store.transact(tenantId, (transaction) => transaction.getProjection<T>(namespace, id));
}

interface SubmittedSessionEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly executionId: string;
  readonly role: "user";
  readonly message: string;
  readonly generation: number;
  readonly createdAt: string;
}

interface DurableRuntimeProjection {
  readonly executionId: string;
  readonly streamVersion: number;
  readonly nextSequence: number;
  readonly records: readonly RuntimeRecord[];
}

function enqueueRuntimeInbox(
  transaction: KernelTransaction,
  input: {
    readonly executionId: string;
    readonly kind: "follow_up" | "steer";
    readonly text: string;
    readonly occurredAt: string;
    readonly recordId: string;
    readonly itemId: string;
  },
): RuntimeRecord {
  const current = transaction.getProjection<DurableRuntimeProjection>(
    "agent-runtime",
    input.executionId,
  ) ?? {
    executionId: input.executionId,
    streamVersion: 0,
    nextSequence: 1,
    records: [],
  };
  if (current.executionId !== input.executionId
    || !Number.isSafeInteger(current.streamVersion) || current.streamVersion < 0
    || !Number.isSafeInteger(current.nextSequence) || current.nextSequence < 1
    || !Array.isArray(current.records)) {
    throw new KernelError(
      "AGENT_RUNTIME_CORRUPT",
      "Agent Runtime 持久状态无效",
      "停止执行并检查事件与投影",
    );
  }
  const record: RuntimeRecord = {
    sequence: current.nextSequence,
    id: input.recordId,
    executionId: input.executionId,
    type: "inbox/enqueued",
    occurredAt: input.occurredAt,
    payload: {
      id: input.itemId,
      kind: input.kind,
      text: input.text,
    },
  };
  transaction.putProjection<DurableRuntimeProjection>("agent-runtime", input.executionId, {
    executionId: input.executionId,
    streamVersion: current.streamVersion + 1,
    nextSequence: current.nextSequence + 1,
    records: [...current.records, record],
  });
  return record;
}

async function threadTurns(
  store: KernelStore,
  tenantId: string,
  threadId: string,
): Promise<ThreadTurnsView> {
  const executions = (await projectionList<Execution>(store, tenantId, "execution"))
    .filter((execution) => execution.threadId === threadId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const submittedEntries = await projectionList<SubmittedSessionEntry>(store, tenantId, "session-log-entry");
  const runtime = new KernelProjectionRuntimeStore({ tenantId, store });
  return {
    threadId,
    turns: await Promise.all(executions.map(async (execution) => {
      const runtimeEntries = (await runtime.readExecution(execution.id))
        .filter((record) => record.type === "session/entry")
        .map(runtimeSessionEntry)
        .filter((entry): entry is ThreadTurnSessionEntry => entry !== undefined);
      const submitted = submittedEntries
        .filter((entry) => entry.executionId === execution.id && entry.threadId === threadId)
        .filter((entry) => !runtimeEntries.some((runtimeEntry) =>
          runtimeEntry.role === "user" && runtimeEntry.content === entry.message))
        .map((entry): ThreadTurnSessionEntry => ({
          id: entry.id,
          executionId: entry.executionId,
          role: "user",
          content: entry.message,
          turn: 1,
          sequence: 0,
          occurredAt: entry.createdAt,
        }));
      return {
        execution,
        entries: [...submitted, ...runtimeEntries]
          .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)),
      };
    })),
  };
}

function runtimeSessionEntry(record: RuntimeRecord): ThreadTurnSessionEntry | undefined {
  const role = record.payload.role;
  if (role !== "user" && role !== "assistant" && role !== "tool") return undefined;
  const content = record.payload.content;
  const turn = record.payload.turn;
  if (typeof content !== "string" || !Number.isSafeInteger(turn)) {
    throw new Error("Session Log 记录无效");
  }
  return {
    id: record.id,
    executionId: record.executionId,
    role,
    content,
    turn: turn as number,
    sequence: record.sequence,
    occurredAt: record.occurredAt,
  };
}

async function authorizedWorkspace(
  store: KernelStore,
  tenantId: string,
  principalId: string,
  workspaceId: string,
  access: "view" | "operate" | "review" | "owner" = "view",
): Promise<Workspace> {
  return store.transact(tenantId, (transaction) => {
    const workspace = transaction.getProjection<Workspace>("workspace", workspaceId);
    if (!workspace) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
    const membership = transaction.getProjection<WorkspaceMembership>("membership", `${workspaceId}:${principalId}`);
    const allowedRoles = access === "view" ? ["owner", "operator", "reviewer", "viewer"]
      : access === "operate" ? ["owner", "operator"]
        : access === "review" ? ["owner", "operator", "reviewer"]
          : ["owner"];
    if (!membership || !allowedRoles.includes(membership.workspaceRole)) {
      throw new KernelError("WORKSPACE_ACCESS_DENIED", "无权访问此工作区", "联系工作区所有者授予权限");
    }
    return workspace;
  });
}

function idempotentProjectionMutation<T>(input: {
  readonly store: KernelStore;
  readonly tenantId: string;
  readonly key: string;
  readonly scope: string;
  readonly request: unknown;
  readonly work: (transaction: KernelTransaction) => T;
  readonly now: () => string;
}): Promise<T> {
  return input.store.transact(input.tenantId, (transaction) => {
    const digest = sha256(input.request);
    const previous = transaction.getIdempotency(input.scope, input.key);
    if (previous) {
      if (previous.requestDigest !== digest) {
        throw new KernelError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求", "使用新的 Idempotency-Key");
      }
      return previous.response as T;
    }
    const response = input.work(transaction);
    transaction.putIdempotency({
      tenantId: input.tenantId, scope: input.scope, key: input.key,
      requestDigest: digest, response, createdAt: input.now(),
    });
    return response;
  });
}

async function idempotentAsyncOperation<T>(input: {
  readonly store: KernelStore;
  readonly tenantId: string;
  readonly key: string;
  readonly scope: string;
  readonly request: unknown;
  readonly work: () => Promise<T>;
  readonly now: () => string;
  readonly inFlight: Map<string, Promise<unknown>>;
}): Promise<T> {
  const flightKey = `${input.tenantId.length}:${input.tenantId}${input.scope.length}:${input.scope}${input.key}`;
  const active = input.inFlight.get(flightKey);
  if (active) return active as Promise<T>;
  const operation = (async () => {
    const requestDigest = sha256(input.request);
    const previous = await input.store.transact(input.tenantId, (transaction) =>
      transaction.getIdempotency(input.scope, input.key));
    if (previous) {
      if (previous.requestDigest !== requestDigest) {
        throw new KernelError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求", "使用新的 Idempotency-Key");
      }
      return previous.response as T;
    }
    const result = await input.work();
    return input.store.transact(input.tenantId, (transaction) => {
      const raced = transaction.getIdempotency(input.scope, input.key);
      if (raced) {
        if (raced.requestDigest !== requestDigest) {
          throw new KernelError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求", "使用新的 Idempotency-Key");
        }
        return raced.response as T;
      }
      transaction.putIdempotency({
        tenantId: input.tenantId, scope: input.scope, key: input.key,
        requestDigest, response: result, createdAt: input.now(),
      });
      return result;
    });
  })();
  input.inFlight.set(flightKey, operation);
  try {
    return await operation;
  } finally {
    input.inFlight.delete(flightKey);
  }
}

export async function createAgentOsHost(options: AgentOsHostOptions): Promise<AgentOsHost> {
  const profile = options.profile ?? "local";
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.id ?? ((kind: string) => `${kind}-${randomUUID()}`);
  const acceptsModelSecretReference = options.acceptsModelSecretReference
    ?? (options.profile === "enterprise"
      ? (reference: string) => reference.startsWith("vault://muniu/v2/")
      : (reference: string) => reference.startsWith("keychain://muniu.v2/"));
  const kernel = new AgentOsKernel(options.store, {
    now,
    id: nextId,
    acceptsModelSecretReference,
  });
  if (profile === "local") await kernel.bootstrapLocal("agent-os-v2-local-bootstrap");
  const officialPluginIds = new Set<string>();
  let pluginInstaller: PluginInstallerPort | undefined;
  const plugins = new PluginContributionHost({
    isAvailable: (pluginId) => officialPluginIds.has(pluginId)
      || Boolean(pluginInstaller?.isInstalled?.(pluginId)),
  });
  const opcRepository = new KernelOpcRepository({ store: options.store, now, id: nextId });
  const opcService = new OpcService({
    repository: opcRepository,
    clock: now,
    createId: nextId,
  });
  const officialPlugins = options.officialPlugins ?? [
    createOpcPluginDefinition({ service: opcService }),
    codingPlugin,
  ];
  for (const plugin of officialPlugins) {
    plugins.registerOfficial(plugin);
    officialPluginIds.add(plugin.id);
  }
  pluginInstaller = options.pluginInstaller ?? (profile === "local"
    ? new LocalProductionPluginInstaller({
      store: options.store,
      repository: options.pluginRepository ?? new LocalSignedPluginRepository(),
      trustedRoots: options.trustedPluginRoots ?? [],
      contributions: plugins,
      now,
      ...(options.pluginExecutionControl ? { executionControl: options.pluginExecutionControl } : {}),
      ...(options.pluginProjections ? { projections: options.pluginProjections } : {}),
    })
    : undefined);
  await pluginInstaller?.initialize?.();
  const activatedWorkspaceScopes = new Set<string>();

  const context = new Context().extend(Object.freeze({
    agentOsKernel: kernel,
    agentOsPlugins: plugins,
    agentOsProfile: profile,
  }));
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  const inFlightAsyncMutations = new Map<string, Promise<unknown>>();
  const allowedOrigins = new Set([...DESKTOP_ORIGINS, ...(options.allowedOrigins ?? [])]);
  const activeEventStreams = new Set<() => void>();
  const ssePollIntervalMs = positiveInterval(options.ssePollIntervalMs, 250);
  const sseKeepAliveIntervalMs = positiveInterval(options.sseKeepAliveIntervalMs, 15_000);

  const ensurePluginsActive = async (tenantId: string, workspace: Workspace): Promise<string> => {
    const scope = encodePluginWorkspace(tenantId, workspace.id);
    if (!activatedWorkspaceScopes.has(scope)) {
      for (const pluginId of workspace.activePluginIds) {
        if (!officialPluginIds.has(pluginId)) await pluginInstaller?.activate?.(pluginId);
        await plugins.activate(scope, pluginId);
      }
      activatedWorkspaceScopes.add(scope);
    }
    return scope;
  };

  const dispatch = async (request: Request): Promise<Response> => {
    const traceId = request.headers.get("X-Trace-Id")?.trim() || randomUUID();
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v2")) return notFound(traceId);
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    const mutation = !["GET", "HEAD"].includes(request.method);
    const mutationKey = mutation ? requireMutationKey(request, traceId) : undefined;
    if (mutationKey instanceof Response) return mutationKey;

    try {
      if (request.method === "GET" && url.pathname === "/v2/openapi.json") {
        return json(createOpenApiDocument(), 200, traceId);
      }
      if (request.method === "GET" && url.pathname === "/v2/readiness") {
        const readiness = await options.readiness?.() ?? { ready: true, issues: [] };
        return json(readiness, readiness.ready ? 200 : 503, traceId);
      }
      if (request.method === "GET" && url.pathname === "/v2/health" && !url.searchParams.has("workspaceId")) {
        return json(await plugins.health("__core__"), 200, traceId);
      }
      const identity = options.identityResolver
        ? await options.identityResolver(request)
        : profile === "local"
          ? { tenantId: LOCAL_TENANT_ID, principalId: LOCAL_ACTOR_ID }
          : { tenantId: "", principalId: "" };
      if (!identity.tenantId || !identity.principalId) {
        throw new KernelError("AUTHENTICATION_REQUIRED", "缺少企业身份上下文", "重新登录后重试");
      }
      const TENANT_ID = identity.tenantId;
      const ACTOR_ID = identity.principalId;
      const pluginWorkspaceKey = (workspaceId: string) => encodePluginWorkspace(TENANT_ID, workspaceId);
      const accessibleWorkspaceIds = async () => new Set(
        (await projectionList<WorkspaceMembership>(options.store, TENANT_ID, "membership"))
          .filter((membership) => membership.principalId === ACTOR_ID)
          .map((membership) => membership.workspaceId),
      );
      if (request.method === "POST" && url.pathname === "/v2/setup") {
        const body = await readBody(request);
        const result = await idempotentProjectionMutation({
          store: options.store,
          tenantId: TENANT_ID,
          key: mutationKey as string,
          scope: "http.setup",
          request: body,
          now,
          work: () => ({ tenantId: TENANT_ID, principalId: ACTOR_ID }),
        });
        return json(result, 200, traceId);
      }
      if (request.method === "GET" && url.pathname === "/v2/health") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) return json(await plugins.health("__core__"), 200, traceId);
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        const scope = await ensurePluginsActive(TENANT_ID, workspace);
        return json(await plugins.health(scope), 200, traceId);
      }
      if (request.method === "GET" && url.pathname === "/v2/workspaces") {
        const workspaces = await kernel.listWorkspaces(TENANT_ID);
        const memberships = await projectionList<WorkspaceMembership>(options.store, TENANT_ID, "membership");
        const allowed = new Set(memberships
          .filter((membership) => membership.principalId === ACTOR_ID)
          .map((membership) => membership.workspaceId));
        return json(workspaces.filter((workspace) => allowed.has(workspace.id)), 200, traceId);
      }
      if (request.method === "POST" && url.pathname === "/v2/workspaces") {
        const body = await readBody(request);
        const pluginsInput = Array.isArray(body.pluginIds) && body.pluginIds.every((id) => typeof id === "string")
          ? body.pluginIds as string[] : [];
        const knownPlugins = new Set(plugins.listRegistered().map((plugin) => plugin.pluginId));
        const unknownPlugin = pluginsInput.find((pluginId) => !knownPlugins.has(pluginId));
        if (unknownPlugin) {
          throw new PluginPolicyError(
            "PLUGIN_NOT_INSTALLED",
            `插件 ${unknownPlugin} 不可用`,
            "安装插件后再创建工作区",
          );
        }
        const viewMode = body.viewMode === "professional" ? "professional" : "business";
        const workspace = await kernel.createWorkspace(TENANT_ID, ACTOR_ID, mutationKey as string, {
          name: stringField(body, "name")!, viewMode, pluginIds: pluginsInput,
        });
        for (const pluginId of pluginsInput) {
          if (!officialPluginIds.has(pluginId)) await pluginInstaller?.activate?.(pluginId);
          await plugins.activate(pluginWorkspaceKey(workspace.id), pluginId);
        }
        activatedWorkspaceScopes.add(pluginWorkspaceKey(workspace.id));
        return json(workspace, 201, traceId);
      }
      const workspaceMatch = url.pathname.match(/^\/v2\/workspaces\/([^/]+)$/u);
      if (workspaceMatch && request.method === "GET") {
        const workspace = await authorizedWorkspace(
          options.store, TENANT_ID, ACTOR_ID, decodeURIComponent(workspaceMatch[1]!),
        );
        return json(workspace, 200, traceId);
      }
      if (workspaceMatch && request.method === "PATCH") {
        const id = decodeURIComponent(workspaceMatch[1]!);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, id, "owner");
        const body = await readBody(request);
        const expected = expectedVersion(body);
        const workspace = await idempotentProjectionMutation({
          store: options.store, tenantId: TENANT_ID, key: mutationKey as string, scope: `workspace.update:${id}`, request: body, now,
          work: (transaction) => {
            const current = transaction.getProjection<Workspace>("workspace", id);
            if (!current) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
            if (current.streamVersion !== expected) throw new KernelStreamVersionConflictError(expected, current.streamVersion);
            const next: Workspace = {
              ...current,
              ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
              ...(body.viewMode === "business" || body.viewMode === "professional" ? { viewMode: body.viewMode } : {}),
              streamVersion: current.streamVersion + 1,
              updatedAt: now(),
            };
            transaction.putProjection("workspace", id, next);
            transaction.appendEvent({
              tenantId: TENANT_ID, aggregateType: "workspace", aggregateId: id,
              expectedStreamVersion: expected, type: "workspace.updated", actorId: ACTOR_ID,
              generation: 0, correlationId: nextId("correlation"), publicPayload: { name: next.name, viewMode: next.viewMode },
            });
            return next;
          },
        });
        return json(workspace, 200, traceId);
      }
      const homeMatch = url.pathname.match(/^\/v2\/workspaces\/([^/]+)\/home$/u);
      if (homeMatch && request.method === "GET") {
        const workspaceId = decodeURIComponent(homeMatch[1]!);
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace);
        return json(await workspaceHome(options.store, TENANT_ID, workspaceId), 200, traceId);
      }
      const threadsMatch = url.pathname.match(/^\/v2\/workspaces\/([^/]+)\/threads$/u);
      if (threadsMatch && request.method === "GET") {
        const workspaceId = decodeURIComponent(threadsMatch[1]!);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        return json(await kernel.listThreads(TENANT_ID, workspaceId), 200, traceId);
      }
      if (threadsMatch && request.method === "POST") {
        const body = await readBody(request);
        const workspaceId = decodeURIComponent(threadsMatch[1]!);
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace);
        const thread = await kernel.createThread(TENANT_ID, ACTOR_ID, mutationKey as string, {
          workspaceId,
          subject: stringField(body, "subject")!, pluginId: stringField(body, "pluginId")!,
        });
        return json(thread, 201, traceId);
      }
      const turnMatch = url.pathname.match(/^\/v2\/workspaces\/([^/]+)\/threads\/([^/]+)\/turns$/u);
      if (turnMatch && request.method === "GET") {
        const workspaceId = decodeURIComponent(turnMatch[1]!);
        const threadId = decodeURIComponent(turnMatch[2]!);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        const thread = await projectionGet<Thread>(options.store, TENANT_ID, "thread", threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          throw new KernelError("THREAD_NOT_FOUND", "会话不存在", "刷新工作区会话");
        }
        return json(await threadTurns(options.store, TENANT_ID, threadId), 200, traceId);
      }
      if (turnMatch && request.method === "POST") {
        const body = await readBody(request);
        const workspaceId = decodeURIComponent(turnMatch[1]!);
        const threadId = decodeURIComponent(turnMatch[2]!);
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace);
        const expected = expectedVersion(body);
        const thread = await projectionGet<Thread>(options.store, TENANT_ID, "thread", threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          throw new KernelError("THREAD_NOT_FOUND", "会话不存在", "刷新工作区会话");
        }
        const definition = plugins.definition(thread.pluginId);
        if (!definition) {
          throw new PluginPolicyError("PLUGIN_NOT_INSTALLED", `插件 ${thread.pluginId} 不可用`, "安装插件后重试");
        }
        pluginInstaller?.assertCanStartExecution?.(thread.pluginId);
        const requestedAgent = stringField(body, "agentDefinitionId", false);
        const agentDefinition = requestedAgent
          ? definition.contributions.agents.find((agent) => agent.id === requestedAgent)
          : definition.contributions.agents[0];
        if (!agentDefinition) {
          throw new PluginPolicyError(
            "PLUGIN_CONTRIBUTION_INVALID",
            requestedAgent ? `插件未提供 Agent ${requestedAgent}` : "插件未提供可用 Agent",
            "选择该插件声明的 Agent",
          );
        }
        const requestedModel = stringField(body, "modelBindingId", false);
        const connections = await projectionList<ModelConnection>(options.store, TENANT_ID, "modelConnection");
        const modelConnection = requestedModel
          ? connections.find((connection) => connection.id === requestedModel && connection.status === "ready")
          : connections.find((connection) => connection.status === "ready");
        if (!modelConnection) {
          throw new KernelError(
            "MODEL_CONNECTION_REQUIRED",
            requestedModel ? "所选模型连接不可用" : "尚未连接可用模型",
            "在集成设置中连接模型后重试",
          );
        }
        const toolIds = definition.contributions.tools.map((tool) => tool.id);
        const dataNamespaces = new Set([thread.pluginId]);
        if (toolIds.some((toolId) => toolId.includes("web"))) dataNamespaces.add("web");
        if (toolIds.some((toolId) => toolId.includes("repository") || toolId.includes("sandbox"))) {
          dataNamespaces.add("repository");
        }
        const execution = await kernel.submitTurn(TENANT_ID, ACTOR_ID, mutationKey as string, {
          workspaceId,
          threadId,
          expectedStreamVersion: expected,
          message: stringField(body, "message")!,
          agentDefinitionId: agentDefinition.id,
          modelBindingId: modelConnection.id,
          executionPrincipalId: `agent:${thread.pluginId}`,
          authority: {
            workspaceId,
            principalId: `agent:${thread.pluginId}`,
            toolIds,
            dataScopes: [...dataNamespaces].map((namespace) => ({ namespace, resourceId: "*" })),
            autoAllowedEffects: ["local_read", "external_read", "local_reversible_write"],
            budget: {
              maxSubagentDepth: 2,
              maxSubagents: 4,
              maxTokens: 100_000,
              maxCostMinorUnits: "5000",
              currency: "CNY",
              maxDurationMs: 3_600_000,
            },
          },
        });
        return json(execution, 202, traceId);
      }
      const eventsMatch = url.pathname.match(/^\/v2\/workspaces\/([^/]+)\/events$/u);
      if (eventsMatch && request.method === "GET") {
        const workspaceId = decodeURIComponent(eventsMatch[1]!);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        const cursorRaw = request.headers.get("Last-Event-ID") ?? url.searchParams.get("after") ?? "0";
        const cursor = Number(cursorRaw);
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
          throw new KernelError("INVALID_CURSOR", "事件游标无效", "使用非负 tenant position");
        }
        const page = await options.store.readEvents(TENANT_ID, cursor, 200);
        return eventStream({
          initialPage: page,
          readPage: (afterPosition) => options.store.readEvents(TENANT_ID, afterPosition, 200),
          workspaceId,
          traceId,
          signal: request.signal,
          pollIntervalMs: ssePollIntervalMs,
          keepAliveIntervalMs: sseKeepAliveIntervalMs,
          activeStreams: activeEventStreams,
        });
      }
      const executionCommand = url.pathname.match(/^\/v2\/executions\/([^/]+)\/commands$/u);
      if (executionCommand && request.method === "POST") {
        const body = await readBody(request);
        const executionId = decodeURIComponent(executionCommand[1]!);
        const execution = await projectionGet<Execution>(options.store, TENANT_ID, "execution", executionId);
        if (!execution) throw new KernelError("EXECUTION_NOT_FOUND", "执行不存在", "刷新执行列表");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, execution.workspaceId, "operate");
        const command = stringField(body, "command")!;
        if (command === "follow_up" || command === "steer") {
          const text = stringField(body, "message")!;
          const expected = expectedVersion(body);
          const result = await idempotentProjectionMutation({
            store: options.store,
            tenantId: TENANT_ID,
            key: mutationKey as string,
            scope: `http.execution.command:${executionId}`,
            request: body,
            now,
            work: (transaction) => {
              const current = transaction.getProjection<Execution>("execution", executionId);
              if (!current) throw new KernelError("EXECUTION_NOT_FOUND", "执行不存在", "刷新执行列表");
              if (current.streamVersion !== expected) {
                throw new KernelStreamVersionConflictError(expected, current.streamVersion);
              }
              if (current.status !== "running" && current.status !== "waiting_approval") {
                throw new KernelError(
                  "INVALID_EXECUTION_TRANSITION",
                  `执行处于 ${current.status}，不能接收 ${command}`,
                  "刷新执行状态；已结束的执行请提交新的 turn",
                );
              }
              const timestamp = now();
              const inboxItemId = nextId("inbox-item");
              enqueueRuntimeInbox(transaction, {
                executionId,
                kind: command,
                text,
                occurredAt: timestamp,
                recordId: nextId("runtime"),
                itemId: inboxItemId,
              });
              const next: Execution = {
                ...current,
                streamVersion: current.streamVersion + 1,
                updatedAt: timestamp,
              };
              transaction.putProjection("execution", executionId, next);
              transaction.appendEvent({
                tenantId: TENANT_ID,
                aggregateType: "execution",
                aggregateId: executionId,
                expectedStreamVersion: current.streamVersion,
                type: command === "follow_up" ? "execution.follow_up_queued" : "execution.steer_queued",
                actorId: ACTOR_ID,
                executionId,
                generation: current.generation,
                correlationId: nextId("correlation"),
                publicPayload: {
                  workspaceId: current.workspaceId,
                  command,
                  inboxItemId,
                },
              });
              return next;
            },
          });
          return json(result, 202, traceId);
        }
        if (command !== "cancel" && command !== "resume") {
          throw new KernelError(
            "EXECUTION_COMMAND_FORBIDDEN",
            "该执行命令仅供内核和 Worker 使用",
            "使用 follow_up、steer、cancel 或 resume",
          );
        }
        const result = await kernel.commandExecution(
          TENANT_ID, ACTOR_ID, mutationKey as string, executionId,
          expectedVersion(body), command,
        );
        return json(result, 200, traceId);
      }
      if (url.pathname === "/v2/inbox" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
        if (workspaceId) await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        const inbox = await kernel.listInbox(TENANT_ID, workspaceId);
        const allowed = workspaceId ? undefined : await accessibleWorkspaceIds();
        return json(allowed ? inbox.filter((item) => allowed.has(item.workspaceId)) : inbox, 200, traceId);
      }
      const approvalMatch = url.pathname.match(/^\/v2\/approvals\/([^/]+)\/decisions$/u);
      if (approvalMatch && request.method === "POST") {
        const body = await readBody(request);
        const approvalId = decodeURIComponent(approvalMatch[1]!);
        const approval = await projectionGet<Approval>(options.store, TENANT_ID, "approval", approvalId);
        if (!approval) throw new KernelError("APPROVAL_NOT_FOUND", "批准请求不存在", "刷新收件箱");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, approval.workspaceId, "review");
        const decision = stringField(body, "decision");
        if (decision !== "approve_once" && decision !== "deny") {
          throw new KernelError("INVALID_DECISION", "批准决定无效", "选择 approve_once 或 deny");
        }
        return json(await kernel.decideApproval(
          TENANT_ID, ACTOR_ID, mutationKey as string, approvalId,
          expectedVersion(body), decision,
        ), 200, traceId);
      }
      if (url.pathname === "/v2/deliverables" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
        if (workspaceId) await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        const allowed = workspaceId ? undefined : await accessibleWorkspaceIds();
        const values = await projectionList<Deliverable>(options.store, TENANT_ID, "deliverable");
        return json(values
          .filter((item) => workspaceId ? item.workspaceId === workspaceId : allowed!.has(item.workspaceId))
          .map(deliverableSummary), 200, traceId);
      }
      if (url.pathname === "/v2/assets" && request.method === "POST") {
        const body = await readBody(request);
        if (Object.keys(body).some((field) => ![
          "workspaceId", "expectedStreamVersion", "attachments",
        ].includes(field))) {
          throw new KernelError("INVALID_BODY", "附件请求包含不支持的字段", "删除未在 OpenAPI 中声明的字段");
        }
        const workspaceId = stringField(body, "workspaceId")!;
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        if (!options.cas) {
          throw new KernelError("ASSET_STORE_UNAVAILABLE", "附件存储暂不可用", "检查对象存储连接后重试");
        }
        return json(await createAssets({
          store: options.store,
          cas: options.cas,
          tenantId: TENANT_ID,
          workspaceId,
          actorId: ACTOR_ID,
          idempotencyKey: mutationKey as string,
          expectedStreamVersion: expectedVersion(body),
          attachments: body.attachments,
          now,
          id: nextId,
        }), 201, traceId);
      }
      if (url.pathname === "/v2/activity" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        return json(await workspaceActivity(options.store, TENANT_ID, workspaceId), 200, traceId);
      }
      const assetMatch = url.pathname.match(/^\/v2\/assets\/([^/]+)$/u);
      if (assetMatch && request.method === "GET") {
        const asset = await projectionGet<Asset>(options.store, TENANT_ID, "asset", decodeURIComponent(assetMatch[1]!));
        if (!asset) return notFound(traceId);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, asset.workspaceId);
        if (url.searchParams.get("content") !== "1") return json(asset, 200, traceId);
        if (!options.cas) throw new KernelError("ASSET_STORE_UNAVAILABLE", "成果文件暂不可用", "检查对象存储连接");
        return new Response(await options.cas.get(asset.digest), {
          headers: {
            "content-type": asset.mediaType,
            "content-length": String(asset.byteLength),
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`,
          },
        });
      }
      if (url.pathname === "/v2/memories" && request.method === "GET") {
        const namespace = url.searchParams.get("namespace");
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
        if (workspaceId) await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        const allowed = workspaceId ? undefined : await accessibleWorkspaceIds();
        const values = await projectionList<MemoryRecord>(options.store, TENANT_ID, "memory");
        return json(values
          .filter((value) => workspaceId ? value.workspaceId === workspaceId : allowed!.has(value.workspaceId))
          .filter((value) => !namespace || value.namespace === namespace)
          .map((value) => ({
            id: value.id,
            namespace: value.namespace,
            resourceId: value.resourceId,
            summary: typeof value.value?.summary === "string" ? value.value.summary : "待审阅的记忆提案",
            source: value.sourceEventId,
            confidence: value.confidence,
            status: value.status === "deleted" ? "invalidated" : value.status,
            streamVersion: value.streamVersion,
          })), 200, traceId);
      }
      if (url.pathname === "/v2/memories" && request.method === "POST") {
        const body = await readBody(request);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, stringField(body, "workspaceId")!, "operate");
        const memory = await kernel.proposeMemory(TENANT_ID, ACTOR_ID, mutationKey as string, {
          workspaceId: stringField(body, "workspaceId")!,
          scopeType: body.scopeType === "thread" || body.scopeType === "resource" || body.scopeType === "principal"
            ? body.scopeType : "workspace",
          namespace: stringField(body, "namespace")!, resourceId: stringField(body, "resourceId")!,
          sourceEventId: stringField(body, "sourceEventId")!,
          confidence: typeof body.confidence === "number" ? body.confidence : 0,
          ...(isObject(body.value) ? { value: body.value as JsonObject } : {}),
          ...(typeof body.protectedPayloadRef === "string" ? { protectedPayloadRef: body.protectedPayloadRef } : {}),
          ...(typeof body.derivedFromMemoryId === "string"
            ? { derivedFromMemoryId: body.derivedFromMemoryId } : {}),
          ...(typeof body.derivedViaShareGrantId === "string"
            ? { derivedViaShareGrantId: body.derivedViaShareGrantId } : {}),
        });
        return json(memory, 201, traceId);
      }
      const memoryDecisionMatch = url.pathname.match(/^\/v2\/memories\/([^/]+)\/decisions$/u);
      if (memoryDecisionMatch && request.method === "POST") {
        const body = await readBody(request);
        const memoryId = decodeURIComponent(memoryDecisionMatch[1]!);
        const memory = await projectionGet<MemoryRecord>(options.store, TENANT_ID, "memory", memoryId);
        if (!memory) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, memory.workspaceId, "review");
        const decision = stringField(body, "decision");
        if (decision !== "accept" && decision !== "reject") {
          throw new KernelError("INVALID_DECISION", "记忆决定无效", "选择 accept 或 reject");
        }
        return json(await kernel.decideMemory(
          TENANT_ID,
          ACTOR_ID,
          mutationKey as string,
          memoryId,
          expectedVersion(body),
          decision,
        ), 200, traceId);
      }
      const memoryMatch = url.pathname.match(/^\/v2\/memories\/([^/]+)$/u);
      if (memoryMatch && request.method === "PATCH") {
        const body = await readBody(request);
        const memoryId = decodeURIComponent(memoryMatch[1]!);
        const memory = await projectionGet<MemoryRecord>(options.store, TENANT_ID, "memory", memoryId);
        if (!memory) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, memory.workspaceId, "operate");
        if (!isObject(body.value) || typeof body.confidence !== "number") {
          throw new KernelError("INVALID_BODY", "修改记忆需要 value 和 confidence", "填写修正后的内容与置信度");
        }
        return json(await kernel.reviseMemoryProposal(
          TENANT_ID,
          ACTOR_ID,
          mutationKey as string,
          memoryId,
          expectedVersion(body),
          { confidence: body.confidence, value: body.value as JsonObject },
        ), 200, traceId);
      }
      if (memoryMatch && request.method === "DELETE") {
        const body = await readBody(request);
        const memoryId = decodeURIComponent(memoryMatch[1]!);
        const memory = await projectionGet<MemoryRecord>(options.store, TENANT_ID, "memory", memoryId);
        if (!memory) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, memory.workspaceId, "owner");
        if (memory.protectedPayloadRef && !options.protectedPayloadKeys) {
          throw new KernelError(
            "KEY_DESTROYER_UNAVAILABLE",
            "敏感记忆暂时无法安全删除",
            "修复 Keychain 或 KMS 连接后重试",
            true,
          );
        }
        return json(await kernel.deleteMemory(
          TENANT_ID,
          ACTOR_ID,
          mutationKey as string,
          memoryId,
          expectedVersion(body),
          stringField(body, "reason")!,
          options.protectedPayloadKeys ?? { async destroy() { /* 非敏感记忆没有数据密钥。 */ } },
        ), 200, traceId);
      }
      if (url.pathname === "/v2/share-grants" && request.method === "GET") {
        const allowed = await accessibleWorkspaceIds();
        const grants = await projectionList<{ readonly workspaceId: string }>(options.store, TENANT_ID, "shareGrant");
        return json(grants.filter((grant) => allowed.has(grant.workspaceId)), 200, traceId);
      }
      if (url.pathname === "/v2/share-grants" && request.method === "POST") {
        const body = await readBody(request);
        const memory = await projectionGet<MemoryRecord>(options.store, TENANT_ID, "memory", stringField(body, "memoryId")!);
        if (!memory) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, memory.workspaceId, "operate");
        return json(await kernel.createShareGrant(
          TENANT_ID, ACTOR_ID, mutationKey as string, stringField(body, "memoryId")!,
          expectedVersion(body), stringField(body, "toNamespace")!,
        ), 201, traceId);
      }
      const shareGrantMatch = url.pathname.match(/^\/v2\/share-grants\/([^/]+)$/u);
      if (shareGrantMatch && request.method === "DELETE") {
        const body = await readBody(request);
        const grantId = decodeURIComponent(shareGrantMatch[1]!);
        const grant = await projectionGet<{ readonly workspaceId: string }>(
          options.store, TENANT_ID, "shareGrant", grantId,
        );
        if (!grant) throw new KernelError("SHARE_GRANT_NOT_FOUND", "共享授权不存在", "刷新授权列表");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, grant.workspaceId, "owner");
        return json(await kernel.revokeShareGrant(
          TENANT_ID,
          ACTOR_ID,
          mutationKey as string,
          grantId,
          expectedVersion(body),
        ), 200, traceId);
      }
      if (url.pathname === "/v2/model-connections/presets" && request.method === "GET") {
        return json(PROVIDER_PRESETS.map(({ endpoint: _endpoint, probeKind: _probeKind, ...preset }) => preset), 200, traceId);
      }
      if (url.pathname === "/v2/model-connections" && request.method === "GET") {
        const values = await projectionList<ModelConnection>(options.store, TENANT_ID, "modelConnection");
        return json(values.map(({ secretRef: _secretRef, ...value }) => value), 200, traceId);
      }
      if (url.pathname === "/v2/model-connections" && request.method === "POST") {
        const body = await readBody(request);
        if ("baseUrl" in body || "wireFormat" in body || "providerId" in body || "modelId" in body) {
          throw new KernelError(
            "UNSUPPORTED_MODEL_CONFIGURATION", "请使用厂商预设，不要填写底层连接参数", "移除 Base URL、wire format、provider ID 和 model ID",
          );
        }
        const presetId = stringField(body, "presetId")!;
        const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === presetId);
        if (!preset) throw new KernelError("MODEL_PRESET_NOT_FOUND", "厂商预设不存在", "刷新厂商列表");
        const connection = await idempotentAsyncOperation<ModelConnection>({
          store: options.store, tenantId: TENANT_ID, key: mutationKey as string,
          scope: "http.modelConnection.create", request: body, now, inFlight: inFlightAsyncMutations,
          work: async () => {
            const apiKey = stringField(body, "apiKey")!;
            const secretAccount = sha256({ tenantId: TENANT_ID, idempotencyKey: mutationKey }).slice(0, 32);
            const secretRef = await options.secretStore.save(secretAccount, apiKey);
            return kernel.saveModelConnection(TENANT_ID, ACTOR_ID, `kernel:${mutationKey as string}`, {
              presetId, displayName: typeof body.displayName === "string" ? body.displayName : preset.displayName,
              secretRef, defaultModel: "", discoveredModels: [],
            });
          },
        });
        const { secretRef: _secretRef, ...publicConnection } = connection;
        return json(publicConnection, 201, traceId);
      }
      const probeMatch = url.pathname.match(/^\/v2\/model-connections\/([^/]+)\/probe$/u);
      if (probeMatch && request.method === "POST") {
        const body = await readBody(request);
        const id = decodeURIComponent(probeMatch[1]!);
        const expected = expectedVersion(body);
        const connection = await idempotentAsyncOperation<ModelConnection>({
          store: options.store, tenantId: TENANT_ID, key: mutationKey as string,
          scope: `http.modelConnection.probe:${id}`, request: body, now, inFlight: inFlightAsyncMutations,
          work: async () => {
            const current = await projectionGet<ModelConnection>(options.store, TENANT_ID, "modelConnection", id);
            if (!current) throw new KernelError("MODEL_CONNECTION_NOT_FOUND", "模型连接不存在", "刷新模型连接列表");
            if (current.streamVersion !== expected) throw new KernelStreamVersionConflictError(expected, current.streamVersion);
            const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === current.presetId);
            if (!preset) throw new KernelError("MODEL_PRESET_NOT_FOUND", "厂商预设不存在", "重新创建模型连接");
            const apiKey = await options.secretStore.read(current.secretRef);
            const discovered = await (options.modelProbe ?? defaultModelProbe)({ preset, apiKey });
            return options.store.transact(TENANT_ID, (transaction) => {
              const value = transaction.getProjection<ModelConnection>("modelConnection", id);
              if (!value) throw new KernelError("MODEL_CONNECTION_NOT_FOUND", "模型连接不存在", "刷新模型连接列表");
              if (value.streamVersion !== expected) throw new KernelStreamVersionConflictError(expected, value.streamVersion);
              const next = {
                ...value, discoveredModels: [...discovered.models], defaultModel: discovered.defaultModel,
                status: "ready" as const, streamVersion: value.streamVersion + 1,
              };
              transaction.putProjection("modelConnection", id, next);
              transaction.appendEvent({
                tenantId: TENANT_ID, aggregateType: "modelConnection", aggregateId: id,
                expectedStreamVersion: expected, type: "model_connection.probed", actorId: ACTOR_ID,
                generation: 0, correlationId: nextId("correlation"),
                publicPayload: { defaultModel: next.defaultModel, modelCount: next.discoveredModels.length },
              });
              return next;
            });
          },
        });
        const { secretRef: _secretRef, ...publicConnection } = connection;
        return json(publicConnection, 200, traceId);
      }
      if (url.pathname === "/v2/plugins/installations" && request.method === "GET") {
        const installed = await pluginInstaller?.list?.() ?? [];
        return json([...plugins.listOfficial(), ...installed], 200, traceId);
      }
      if (url.pathname === "/v2/plugins/installations" && request.method === "POST") {
        if (!pluginInstaller) {
          throw new KernelError("PLUGIN_REGISTRY_UNAVAILABLE", "插件仓库暂不可用", "检查签名仓库连接");
        }
        const body = await readBody(request);
        const result = await idempotentAsyncOperation({
          store: options.store, tenantId: TENANT_ID, key: mutationKey as string,
          scope: "http.plugin.install", request: body, now, inFlight: inFlightAsyncMutations,
          work: () => pluginInstaller!.install(body, {
            idempotencyKey: mutationKey as string,
            idempotencyScope: "http.plugin.install",
          }),
        });
        return json(result, 201, traceId);
      }
      const pluginInstallationMatch = url.pathname.match(/^\/v2\/plugins\/installations\/([^/]+)$/u);
      if (pluginInstallationMatch && request.method === "PATCH") {
        if (!pluginInstaller?.update) {
          throw new KernelError("PLUGIN_REGISTRY_UNAVAILABLE", "插件更新暂不可用", "检查签名仓库连接");
        }
        const pluginId = decodeURIComponent(pluginInstallationMatch[1]!);
        const body = await readBody(request);
        const result = await idempotentAsyncOperation({
          store: options.store,
          tenantId: TENANT_ID,
          key: mutationKey as string,
          scope: `http.plugin.update:${pluginId}`,
          request: body,
          now,
          inFlight: inFlightAsyncMutations,
          work: () => pluginInstaller!.update!(pluginId, body, {
            idempotencyKey: mutationKey as string,
            idempotencyScope: `http.plugin.update:${pluginId}`,
          }),
        });
        return json(result, 200, traceId);
      }
      const activationMatch = url.pathname.match(/^\/v2\/workspaces\/([^/]+)\/plugin-activations$/u);
      if (activationMatch && request.method === "POST") {
        const body = await readBody(request);
        const workspaceId = decodeURIComponent(activationMatch[1]!);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "owner");
        const pluginId = stringField(body, "pluginId")!;
        const expected = expectedVersion(body);
        const workspace = await idempotentAsyncOperation<Workspace>({
          store: options.store, tenantId: TENANT_ID, key: mutationKey as string,
          scope: `http.plugin.activate:${workspaceId}`, request: body, now, inFlight: inFlightAsyncMutations,
          work: async () => {
            const current = await projectionGet<Workspace>(options.store, TENANT_ID, "workspace", workspaceId);
            if (!current) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
            if (current.streamVersion !== expected) throw new KernelStreamVersionConflictError(expected, current.streamVersion);
            try {
              if (!officialPluginIds.has(pluginId)) await pluginInstaller?.activate?.(pluginId);
              await plugins.activate(pluginWorkspaceKey(workspaceId), pluginId);
              return await options.store.transact(TENANT_ID, (transaction) => {
              const value = transaction.getProjection<Workspace>("workspace", workspaceId)!;
              if (value.streamVersion !== expected) throw new KernelStreamVersionConflictError(expected, value.streamVersion);
              const activePluginIds = value.activePluginIds.includes(pluginId)
                ? value.activePluginIds : [...value.activePluginIds, pluginId];
              const next = { ...value, activePluginIds, streamVersion: value.streamVersion + 1, updatedAt: now() };
              transaction.putProjection("workspace", workspaceId, next);
              transaction.appendEvent({
                tenantId: TENANT_ID, aggregateType: "workspace", aggregateId: workspaceId,
                expectedStreamVersion: expected, type: "workspace.plugin_activated", actorId: ACTOR_ID,
                generation: 0, correlationId: nextId("correlation"), publicPayload: { pluginId },
              });
              return next;
              });
            } catch (error) {
              await plugins.deactivate(pluginWorkspaceKey(workspaceId), pluginId);
              throw error;
            }
          },
        });
        return json(workspace, 200, traceId);
      }
      if (url.pathname === "/v2/plugins/opc/opportunities" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace);
        return json(await listOpportunitySummaries(options.store, TENANT_ID, workspaceId), 200, traceId);
      }
      const opcOpportunityMatch = url.pathname.match(/^\/v2\/plugins\/opc\/opportunities\/([^/]+)$/u);
      if (opcOpportunityMatch && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace);
        const opportunity = await opcService.get(
          encodePluginWorkspace(TENANT_ID, workspaceId),
          decodeURIComponent(opcOpportunityMatch[1]!),
        );
        if (!opportunity) throw new KernelError("NOT_FOUND", "机会不存在", "刷新机会列表");
        return json(opportunity, 200, traceId);
      }
      const opcCommandMatch = url.pathname.match(/^\/v2\/plugins\/opc\/opportunities\/([^/]+)\/commands$/u);
      if (opcCommandMatch && request.method === "POST") {
        const body = await readBody(request);
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace);
        return json(await executeOpcCommand({
          service: opcService,
          scopedWorkspaceId: encodePluginWorkspace(TENANT_ID, workspaceId),
          opportunityId: decodeURIComponent(opcCommandMatch[1]!),
          expectedStreamVersion: expectedVersion(body),
          actorId: ACTOR_ID,
          command: stringField(body, "command")!,
          input: body.input,
          idempotencyKey: mutationKey as string,
          idempotencyRequest: body,
        }), 200, traceId);
      }
      const opcDeliverablesMatch = url.pathname.match(
        /^\/v2\/plugins\/opc\/opportunities\/([^/]+)\/deliverables$/u,
      );
      if (opcDeliverablesMatch && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace);
        const opportunity = await opcService.get(
          encodePluginWorkspace(TENANT_ID, workspaceId),
          decodeURIComponent(opcDeliverablesMatch[1]!),
        );
        if (!opportunity) throw new KernelError("NOT_FOUND", "机会不存在", "刷新机会列表");
        return json(exportOpportunityDeliverables(opportunity), 200, traceId);
      }
      const opcExportMatch = url.pathname.match(/^\/v2\/plugins\/opc\/opportunities\/([^/]+)\/exports$/u);
      if (opcExportMatch && request.method === "POST") {
        const body = await readBody(request);
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace);
        return json(await exportOpcOpportunity({
          store: options.store,
          tenantId: TENANT_ID,
          workspaceId,
          opportunityId: decodeURIComponent(opcExportMatch[1]!),
          actorId: ACTOR_ID,
          idempotencyKey: mutationKey as string,
          expectedStreamVersion: expectedVersion(body),
          now,
          id: nextId,
        }), 201, traceId);
      }
      if (url.pathname === "/v2/plugins/coding/tasks" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace);
        return json(await listCodingTaskSummaries(options.store, TENANT_ID, workspaceId), 200, traceId);
      }
      const productCapture = url.pathname.match(/^\/v2\/plugins\/(opc|coding)\/(opportunities|repositories|tasks)$/u);
      if (productCapture && request.method === "POST") {
        const body = await readBody(request);
        const pluginId = productCapture[1] as "opc" | "coding";
        const resource = productCapture[2]!;
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace);
        const common = {
          store: options.store,
          tenantId: TENANT_ID,
          workspaceId,
          actorId: ACTOR_ID,
          idempotencyKey: mutationKey as string,
          expectedStreamVersion: expectedVersion(body),
          input: stringField(body, "input")!,
          now,
          id: nextId,
        };
        const result = pluginId === "opc"
          ? await captureOpportunity(common)
          : resource === "repositories"
            ? await captureCodingRepository(common)
            : await captureCodingTask(common);
        return json(result, 201, traceId);
      }
      const sampleMatch = url.pathname.match(/^\/v2\/plugins\/(opc|coding)\/samples\/read-only$/u);
      if (sampleMatch && request.method === "POST") {
        const body = await readBody(request);
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace);
        return json(await runReadOnlySample({
          store: options.store,
          tenantId: TENANT_ID,
          workspaceId,
          actorId: ACTOR_ID,
          idempotencyKey: mutationKey as string,
          expectedStreamVersion: expectedVersion(body),
          now,
          id: nextId,
        }, sampleMatch[1] as "opc" | "coding"), 200, traceId);
      }
      const pluginMatch = url.pathname.match(/^\/v2\/plugins\/([^/]+)\/(.+)$/u);
      if (pluginMatch && request.method === "POST") {
        const body = await readBody(request);
        expectedVersion(body);
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace);
        const pluginId = decodeURIComponent(pluginMatch[1]!);
        const commandId = decodeURIComponent(pluginMatch[2]!);
        pluginInstaller?.assertCanStartExecution?.(pluginId);
        const commandInput = Object.fromEntries(Object.entries(body)
          .filter(([key]) => key !== "workspaceId")) as JsonObject;
        const result = await idempotentAsyncOperation({
          store: options.store, tenantId: TENANT_ID, key: mutationKey as string,
          scope: `http.plugin.command:${workspaceId}:${pluginId}:${commandId}`, request: body, now,
          inFlight: inFlightAsyncMutations,
          work: () => plugins.runCommand(pluginWorkspaceKey(workspaceId), pluginId, commandId, commandInput, ACTOR_ID),
        });
        return json(result, 200, traceId);
      }
      return notFound(traceId);
    } catch (error) {
      return safeError(error, traceId);
    }
  };

  return {
    context,
    kernel,
    plugins,
    dispatch,
    async listen({ host = "127.0.0.1", port }) {
      if (server) throw new Error("Host 已启动");
      server = createServer(async (incoming, outgoing) => {
        const origin = typeof incoming.headers.origin === "string" ? incoming.headers.origin : undefined;
        if (origin && !allowedOrigins.has(origin)) {
          outgoing.writeHead(403, { "content-type": "application/json; charset=utf-8" });
          outgoing.end(JSON.stringify(apiError(
            "ORIGIN_NOT_ALLOWED",
            "请求来源不受信任",
            "从木牛桌面应用发起请求",
            randomUUID(),
          )));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const address = `http://${incoming.headers.host ?? `${host}:${port}`}${incoming.url ?? "/"}`;
        const request = new Request(address, {
          method: incoming.method,
          headers: incoming.headers as HeadersInit,
          ...(["GET", "HEAD"].includes(incoming.method ?? "GET")
            ? {} : { body: Buffer.concat(chunks) }),
        });
        const response = await dispatch(request);
        const headers: Record<string, string> = Object.fromEntries(response.headers);
        if (origin) {
          headers["access-control-allow-origin"] = origin;
          headers["access-control-allow-methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
          headers["access-control-allow-headers"] = "Content-Type,Idempotency-Key,Last-Event-ID,X-Trace-Id";
          headers.vary = "Origin";
        }
        outgoing.writeHead(response.status, headers);
        await pipeResponseBody(response, outgoing);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, host, resolve);
      });
      const address = server.address();
      return { host, port: typeof address === "object" && address ? address.port : port };
    },
    async close() {
      closePromise ??= (async () => {
        for (const closeStream of [...activeEventStreams]) closeStream();
        if (server) {
          await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
          server = undefined;
        }
        await options.beforeStoreClose?.();
        await context.fiber.dispose();
        const close = (options.store as { close?: () => Promise<void> }).close;
        if (close) await close.call(options.store);
      })();
      await closePromise;
    },
  };
}

async function defaultModelProbe({
  preset,
  apiKey,
}: {
  readonly preset: ProviderPreset;
  readonly apiKey: string;
}): Promise<ModelProbeResult> {
  const endpoint = `${preset.endpoint.replace(/\/$/u, "")}${preset.id === "openai" ? "" : "/v1"}/models`;
  const headers: Record<string, string> = preset.probeKind === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${apiKey}` };
  let response: Response;
  try {
    response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new KernelError("MODEL_PROBE_FAILED", "无法连接模型厂商", "检查网络和 API Key 后重试", true);
  }
  if (!response.ok) {
    throw new KernelError(
      "MODEL_PROBE_FAILED",
      response.status === 401 || response.status === 403 ? "模型密钥无效" : "模型厂商探测失败",
      "检查 API Key 和厂商服务状态后重试",
      response.status >= 500,
    );
  }
  const body = await response.json() as { readonly data?: readonly { readonly id?: unknown }[] };
  const models = (body.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && Boolean(id.trim()));
  if (models.length === 0) {
    throw new KernelError("MODEL_PROBE_FAILED", "厂商未返回可用模型", "检查账号权限后重试");
  }
  const defaultModel = preset.suggestedModels.find((model) => models.includes(model)) ?? models[0]!;
  return { models, defaultModel };
}

export type { InboxItem };
