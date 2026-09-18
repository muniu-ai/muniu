import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { KernelProjectionRuntimeStore, type RuntimeRecord } from "@mn/agent-runtime";
import { createProtectedRuntimeStore, readProtectedRuntimePayload, type RuntimeProtection, type BusinessProviderPorts } from "@mn/worker";
import {
  apiError,
  matchApiOperation,
  parseApiResponse,
  createOpenApiDocument,
  parseCreateBusinessActionV2,
  parseReconcileBusinessActionV2,
  parseCreateBusinessCandidateV2,
  type Approval,
  type Asset,
  type AssetTombstone,
  type Deliverable,
  type Execution,
  type ExecutionAuthority,
  type JsonObject,
  type JsonValue,
  type MemoryRecord,
  type MemoryTombstone,
  type OrganizationRole,
  type Thread,
  type ThreadTurnSessionEntry,
  type ThreadTurnsView,
  type Workspace,
  type WorkspaceMembership,
  type CodingRunnerId,
} from "@mn/contracts";
import {
  AgentOsKernel,
  BusinessActionLedger,
  BusinessCandidateLedger,
  appendKernelEvent,
  KernelError,
  PROVIDER_PRESETS,
  findModelPrice,
  sha256,
  StreamVersionConflictError as KernelStreamVersionConflictError,
  type InboxItem,
  type KernelStore,
  type KernelTransaction,
  type ModelConnection,
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
  storeProtectedJson,
  drainKeyRevocations,
  requestKeyRevocationRetry,
  KEY_REVOCATION_NAMESPACE,
  type KeyRevocation,
  type ContentAddressedStorage,
  type KeyProvider,
} from "@mn/storage";
import { codingPlugin } from "@mn/plugin-coding";
import { configureProductProjectionJournal } from "./projection-journal.js";
import { createAgentOsCompositionRoot } from "./composition.js";
import { businessExecutionAuthorityResponse, prepareBusinessAction, publicBusinessAction } from "./business-actions.js";
import { businessCandidateContentResponse, createBusinessCandidate, publicBusinessCandidate } from "./business-candidates.js";
import { CordisPluginActivationLifecycle } from "./plugin-lifecycle.js";
import { KernelPluginProjectionManager } from "./plugin-projections.js";
import { createPluginDataPort, readPluginDomainEvent } from "./plugin-data.js";
import { readBoundedJsonBody } from "./http-body.js";
import { executionMetering } from "./execution-metering.js";
import { defaultModelProbe, type ModelProbe } from "./model-probe.js";
export type { ModelProbe, ModelProbeResult } from "./model-probe.js";
import { createOpcPluginDefinition, exportOpportunityDeliverables, OpcService } from "@mn/plugin-opc";
import { claudeCliPluginDefinition } from "@mn/runner-claude-cli";
import { codexCliPluginDefinition } from "@mn/runner-codex-cli";
import type { EnterpriseReadiness } from "./config.js";
import {
  ASSET_TOMBSTONE_NAMESPACE,
  createAssets,
  deleteAsset,
  readAssetContent,
} from "./assets.js";
import {
  prepareMemoryPayload,
  publicMemory,
  readMemoryValue,
} from "./memories.js";
import {
  KernelOpcRepository,
  captureCodingRepository,
  captureCodingTask,
  captureOpportunity,
  deliverableSummary,
  encodePluginWorkspace,
  exportOpcOpportunity,
  listCodingTaskSummaries,
  listCodingRepositories,
  listOpportunitySummaries,
  runReadOnlySample,
  workspaceActivity,
  workspaceHome,
} from "./product-state.js";
import { executeOpcCommand } from "./opc-api.js";
import {
  hydrateOpcOpportunity,
  validateOpcCommandSources,
} from "./opc-protected-sources.js";
import {
  LocalProductionPluginInstaller,
  LocalSignedPluginRepository,
  PLUGIN_INSTALLATION_PROJECTION,
  type PluginInstallerPort,
  type ProductionPluginProjectionManager,
  type TrustedRegistryRoot,
} from "./plugin-installation.js";
import type { ModelSecretStore } from "./secrets.js";
import {
  CODING_RECONCILIATION_WORKER_JOB_KINDS,
  codingReconciliationVerificationReadiness,
  decideCodingReconciliation,
  getCodingReconciliation,
  type CodingNewCallReadinessResolver,
  type CodingReconciliationDecision,
} from "./coding-reconciliation.js";
import {
  confirmCodingRunner,
  inspectCodingRunner,
  listCodingRunners,
  localCodingRunnerIdentityInspector,
  parseExternalCodingRunnerId,
  requireConfirmedCodingRunner,
  runnerPluginId,
  runnerToolId,
  type CodingRunnerIdentityInspector,
} from "./coding-runners.js";

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

export interface TenantPluginInstallerFactoryInput {
  readonly tenantId: string;
  readonly contributions: PluginContributionHost;
}

export type TenantPluginInstallerFactory = (
  input: TenantPluginInstallerFactoryInput,
) => PluginInstallerPort | undefined | Promise<PluginInstallerPort | undefined>;

export interface AgentOsHostOptions {
  readonly businessProvider?: BusinessProviderPorts;
  readonly businessWorkspaceScopes?: readonly { readonly tenantId: string; readonly workspaceId: string }[];
  readonly businessAuthorityTokenResolver?: () => Promise<string>;
  readonly store: KernelStore;
  readonly profile?: "local" | "enterprise";
  readonly cas?: ContentAddressedStorage;
  readonly secretStore: ModelSecretStore;
  readonly modelProbe?: ModelProbe;
  readonly officialPlugins?: readonly PluginDefinitionV1[];
  /** 仅限 local profile 的单租户安装器；企业必须按租户创建实例。 */
  readonly pluginInstaller?: PluginInstallerPort;
  /** 企业插件安装态属于租户，工厂必须为每个 tenant 返回独立实例。 */
  readonly tenantPluginInstallerFactory?: TenantPluginInstallerFactory;
  /** 本地生产仓库只暴露组合根已经加载的签名制品，不访问远程 JavaScript。 */
  readonly pluginRepository?: LocalSignedPluginRepository;
  readonly trustedPluginRoots?: readonly TrustedRegistryRoot[];
  /** 生产更新先通过此端口排空该插件的 Execution。 */
  readonly pluginExecutionControl?: PluginExecutionControl;
  readonly tenantPluginExecutionControlFactory?: (tenantId: string) => PluginExecutionControl;
  /** 投影先在独立命名空间重放；activate 在 Kernel 事务内原子切换。 */
  readonly pluginProjections?: ProductionPluginProjectionManager;
  readonly tenantPluginProjectionsFactory?: (tenantId: string) => ProductionPluginProjectionManager;
  readonly readiness?: () => EnterpriseReadiness | Promise<EnterpriseReadiness>;
  readonly now?: () => string;
  readonly id?: (kind: string) => string;
  readonly identityResolver?: (request: Request) => {
    readonly tenantId: string;
    readonly principalId: string;
    readonly organizationRoles?: readonly OrganizationRole[];
  } | Promise<{
    readonly tenantId: string;
    readonly principalId: string;
    readonly organizationRoles?: readonly OrganizationRole[];
  }>;
  /** 仅用于本地开发或测试宿主附加受信 WebView 来源。 */
  readonly allowedOrigins?: readonly string[];
  /** 本地注入 Keychain provider；企业注入 Vault/KMS provider。 */
  readonly protectedPayloadKeyProvider?: KeyProvider;
  /** Local hosts passively inspect same-node binaries; enterprise hosts require an injected trusted inspector. */
  readonly runnerIdentityInspector?: CodingRunnerIdentityInspector;
  /**
   * 企业部署从受信发布配置注入，并与 Worker handler module 的 supportedKinds 逐项核对。
   * 未配置时人工核对仍可终止或新建调用，但不能把未知结果标记完成。
   */
  readonly trustedWorkerSupportedKinds?: readonly string[];
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

function expectedCodingVersion(body: Record<string, unknown>): number {
  const value = body.expectedCodingStreamVersion;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new KernelError(
      "EXPECTED_STREAM_VERSION_REQUIRED",
      "缺少有效的 expectedCodingStreamVersion",
      "刷新 Coding 执行后重试",
    );
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
      : error.code === "REQUEST_BODY_TOO_LARGE" ? 413
        : error.code === "REQUEST_BODY_TIMEOUT" ? 408
          : error.code === "REQUEST_JSON_INVALID" ? 400
      : error.code === "AUTHENTICATION_REQUIRED" ? 401
        : error.code.endsWith("_ACCESS_DENIED") ? 403
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
  return readBoundedJsonBody(request);
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
  readonly message?: string;
  readonly protectedPayloadRef?: string;
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
    readonly preparedPayload?: Awaited<ReturnType<typeof storeProtectedJson>>;
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
  const record: RuntimeRecord & { readonly protectedPayloadRef?: string } = {
    sequence: current.nextSequence,
    id: input.recordId,
    executionId: input.executionId,
    type: "inbox/enqueued",
    occurredAt: input.occurredAt,
    ...(input.preparedPayload ? { protectedPayloadRef: input.preparedPayload.protectedPayloadRef } : {}),
    payload: input.preparedPayload ? {} : {
      id: input.itemId,
      kind: input.kind,
      text: input.text,
    },
  };
  if (input.preparedPayload) {
    transaction.putProjection("protectedPayloadKey", input.preparedPayload.protectedPayloadRef,
      input.preparedPayload.keyRecord);
    const execution = transaction.getProjection<Execution>("execution", input.executionId)!;
    const { payload: _payload, protectedPayloadRef: _ref, ...metadata } = record;
    transaction.appendEvent({ tenantId: execution.tenantId, aggregateType: "runtimeRecord",
      aggregateId: record.id, expectedStreamVersion: 0, type: "agent.runtime_recorded",
      actorId: execution.initiatedBy, executionId: execution.id, generation: execution.generation,
      correlationId: execution.id, protectedPayloadRef: input.preparedPayload.protectedPayloadRef,
      publicPayload: { workspaceId: execution.workspaceId, record: metadata as unknown as JsonObject } });
  }
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
  protection?: RuntimeProtection,
): Promise<ThreadTurnsView> {
  const executions = (await projectionList<Execution>(store, tenantId, "execution"))
    .filter((execution) => execution.threadId === threadId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const storedEntries = await projectionList<SubmittedSessionEntry>(store, tenantId, "session-log-entry");
  const submittedEntries = await Promise.all(storedEntries.filter((entry) => entry.threadId === threadId)
    .map(async (entry) => {
      if (!entry.protectedPayloadRef) return { ...entry, message: entry.message ?? "" };
      if (!protection) throw new Error("会话缺少解密配置");
      const value = await readProtectedRuntimePayload({ ...protection, store, tenantId,
        workspaceId: entry.workspaceId, ownerType: "thread", ownerId: entry.threadId,
        protectedPayloadRef: entry.protectedPayloadRef });
      if (typeof value.message !== "string") throw new Error("会话内容无效");
      return { ...entry, message: value.message };
    }));
  return {
    threadId,
    turns: await Promise.all(executions.map(async (execution) => {
      const runtime = protection ? createProtectedRuntimeStore({ ...protection, tenantId,
        workspaceId: execution.workspaceId, store }) : new KernelProjectionRuntimeStore({ tenantId, store });
      const records = await runtime.readExecution(execution.id);
      const authority = await store.transact(tenantId, tx => tx.getProjection<ExecutionAuthority>("authority", execution.authorityId));
      const pauseReason = records.filter(record => record.type === "execution/status").at(-1)?.payload.reason;
      const runtimeEntries = records
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
        ...(authority ? { metering: executionMetering(execution, authority, records) } : {}),
        ...(execution.status === "paused" && typeof pauseReason === "string" ? { pauseReason } : {}),
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
    if (!membership || membership.removedAt || !allowedRoles.includes(membership.workspaceRole)) {
      throw new KernelError("WORKSPACE_ACCESS_DENIED", "无权访问此工作区", "联系工作区所有者授予权限");
    }
    return workspace;
  });
}

function requireOrganizationRole(
  profile: "local" | "enterprise",
  roles: readonly OrganizationRole[],
  allowed: readonly OrganizationRole[],
): void {
  if (profile === "local" || roles.some((role) => allowed.includes(role))) return;
  throw new KernelError(
    "ORGANIZATION_ACCESS_DENIED",
    "当前组织角色无权执行此操作",
    "联系组织管理员授予所需角色",
  );
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
  readonly actorId: string;
  readonly key: string;
  readonly scope: string;
  readonly request: unknown;
  readonly work: () => Promise<T>;
  readonly now: () => string;
  readonly inFlight: Map<string, InFlightAsyncMutation>;
}): Promise<T> {
  const flightKey = `${input.tenantId.length}:${input.tenantId}${input.scope.length}:${input.scope}${input.key}`;
  const requestDigest = sha256(input.request);
  const active = input.inFlight.get(flightKey);
  if (active) {
    if (active.requestDigest !== requestDigest) {
      throw new KernelError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求", "使用新的 Idempotency-Key");
    }
    return active.operation as Promise<T>;
  }
  const operation = (async () => {
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
      appendKernelEvent(transaction, { tenantId: input.tenantId, aggregateType: "apiMutation",
        aggregateId: sha256([input.scope, input.key]), expectedStreamVersion: 0, type: "api.mutation_completed",
        actorId: input.actorId, generation: 0, correlationId: sha256([input.scope, input.key]), publicPayload: { requestDigest } });
      transaction.putIdempotency({
        tenantId: input.tenantId, scope: input.scope, key: input.key,
        requestDigest, response: result, createdAt: input.now(),
      });
      return result;
    });
  })();
  input.inFlight.set(flightKey, { requestDigest, operation });
  try {
    return await operation;
  } finally {
    if (input.inFlight.get(flightKey)?.operation === operation) input.inFlight.delete(flightKey);
  }
}

interface InFlightAsyncMutation {
  readonly requestDigest: string;
  readonly operation: Promise<unknown>;
}

export async function createAgentOsHost(options: AgentOsHostOptions): Promise<AgentOsHost> {
  const protectedJournal = Boolean(options.cas && options.protectedPayloadKeyProvider
    && configureProductProjectionJournal(options.store, options.cas, options.protectedPayloadKeyProvider));
  const profile = options.profile ?? "local";
  const trustedWorkerSupportedKinds = Object.freeze(profile === "local"
    ? [...CODING_RECONCILIATION_WORKER_JOB_KINDS]
    : [...(options.trustedWorkerSupportedKinds ?? [])]);
  const reconciliationVerificationReadiness = () =>
    codingReconciliationVerificationReadiness(trustedWorkerSupportedKinds);
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.id ?? ((kind: string) => `${kind}-${randomUUID()}`);
  const acceptsModelSecretReference = options.acceptsModelSecretReference
    ?? (options.profile === "enterprise"
      ? (reference: string) => reference.startsWith("vault://muniu/v2/")
      : (reference: string) => reference.startsWith("keychain://muniu.v2/"));
  const runnerIdentityInspector = options.runnerIdentityInspector
    ?? (profile === "local" ? localCodingRunnerIdentityInspector : undefined);
  const { context, kernel } = await createAgentOsCompositionRoot({
    profile, store: options.store, kernelOptions: { now, id: nextId, acceptsModelSecretReference },
  });
  try {
  if (profile === "local") await kernel.bootstrapLocal("agent-os-v2-local-bootstrap");
  if (profile === "enterprise" && options.pluginInstaller) {
    throw new Error("企业 profile 必须使用租户化插件安装器工厂，不能复用单例安装器");
  }
  if (Boolean(options.pluginRepository) !== Boolean(options.trustedPluginRoots?.length)) {
    throw new Error("签名插件仓库与 Ed25519 受信根必须同时配置");
  }
  if (options.tenantPluginInstallerFactory && options.pluginRepository) {
    throw new Error("租户化插件安装器工厂与内置签名仓库不能同时配置");
  }
  if (profile === "enterprise" && (options.pluginExecutionControl || options.pluginProjections)) {
    throw new Error("企业插件执行排空和投影端口必须使用租户化工厂");
  }
  const officialPluginIds = new Set<string>();
  const opcRepository = new KernelOpcRepository({ store: options.store, now, id: nextId });
  const opcService = new OpcService({
    repository: opcRepository,
    clock: now,
    createId: nextId,
  });
  const officialPlugins = options.officialPlugins ?? [
    createOpcPluginDefinition({ service: opcService }),
    codingPlugin,
    claudeCliPluginDefinition,
    codexCliPluginDefinition,
  ];
  for (const plugin of officialPlugins) officialPluginIds.add(plugin.id);

  interface TenantPluginRuntime {
    readonly tenantId: string;
    readonly plugins: PluginContributionHost;
    readonly installer?: PluginInstallerPort;
    readonly dataManager?: KernelPluginProjectionManager;
  }
  const tenantRuntimes = new Map<string, Promise<TenantPluginRuntime>>();
  const tenantRuntimeFailures = new Set<string>();
  const tenantInstallerOwners = new WeakMap<object, string>();
  const createTenantRuntime = async (tenantId: string): Promise<TenantPluginRuntime> => {
    const tenantFiber = context.isolate("productTenant").plugin({
      name: "agent-os.tenant", apply(scope) { scope.provide("productTenant", tenantId); },
    });
    await tenantFiber;
    try {
    let installer: PluginInstallerPort | undefined;
    const protection = options.cas && options.protectedPayloadKeyProvider
      ? { cas: options.cas, keyProvider: options.protectedPayloadKeyProvider } : undefined;
    const dataManager = new KernelPluginProjectionManager({ store: options.store, tenantId,
      engine: profile === "local" ? "sqlite" : "postgresql", readEvent: event => readPluginDomainEvent(options.store, event, protection) });
    const plugins = new PluginContributionHost({
      lifecycle: new CordisPluginActivationLifecycle(tenantFiber.ctx),
      isExpectedCommandError: error => error instanceof KernelError || error instanceof StorageStreamVersionConflictError
        || error instanceof IdempotencyConflictError,
      isAvailable: (pluginId) => officialPluginIds.has(pluginId)
        || Boolean(installer?.isInstalled?.(pluginId)),
    });
    for (const plugin of officialPlugins) plugins.registerOfficial(plugin);
    if (profile === "local" && options.pluginInstaller) {
      installer = options.pluginInstaller;
    } else if (options.tenantPluginInstallerFactory) {
      installer = await options.tenantPluginInstallerFactory({ tenantId, contributions: plugins });
    } else if (options.pluginRepository || (options.trustedPluginRoots?.length ?? 0) > 0) {
      installer = new LocalProductionPluginInstaller({
        store: options.store,
        repository: options.pluginRepository ?? new LocalSignedPluginRepository(),
        trustedRoots: options.trustedPluginRoots ?? [],
        contributions: plugins,
        tenantId,
        actorId: profile === "enterprise" ? "system:plugin-runtime" : LOCAL_ACTOR_ID,
        now,
        ...(options.tenantPluginExecutionControlFactory
          ? { executionControl: options.tenantPluginExecutionControlFactory(tenantId) }
          : options.pluginExecutionControl ? { executionControl: options.pluginExecutionControl } : {}),
        ...(options.tenantPluginProjectionsFactory
          ? { projections: options.tenantPluginProjectionsFactory(tenantId) }
          : { projections: options.pluginProjections ?? dataManager }),
      });
    } else if (profile === "local") {
      installer = new LocalProductionPluginInstaller({
        store: options.store,
        repository: new LocalSignedPluginRepository(),
        trustedRoots: [],
        contributions: plugins,
        tenantId,
        actorId: LOCAL_ACTOR_ID,
        now,
        ...(options.pluginExecutionControl ? { executionControl: options.pluginExecutionControl } : {}),
        projections: options.pluginProjections ?? dataManager,
      });
    }
    if (profile === "enterprise" && installer) {
      const owner = tenantInstallerOwners.get(installer);
      if (owner && owner !== tenantId) {
        throw new Error(`企业租户 ${tenantId} 不能复用租户 ${owner} 的插件安装器实例`);
      }
      tenantInstallerOwners.set(installer, tenantId);
    }
    await installer?.initialize?.();
    return { tenantId, plugins, dataManager, ...(installer ? { installer } : {}) };
    } catch (error) { await tenantFiber.dispose(); throw error; }
  };
  const runtimeForTenant = (tenantId: string): Promise<TenantPluginRuntime> => {
    const existing = tenantRuntimes.get(tenantId);
    if (existing) return existing;
    const created = createTenantRuntime(tenantId);
    tenantRuntimes.set(tenantId, created);
    void created.then(
      () => tenantRuntimeFailures.delete(tenantId),
      () => {
        tenantRuntimeFailures.add(tenantId);
        tenantRuntimes.delete(tenantId);
      },
    );
    return created;
  };
  const defaultRuntime = profile === "local"
    ? await runtimeForTenant(LOCAL_TENANT_ID)
    : (() => {
      const corePlugins = new PluginContributionHost({
        lifecycle: new CordisPluginActivationLifecycle(context),
        isAvailable: (pluginId) => officialPluginIds.has(pluginId),
      });
      for (const plugin of officialPlugins) corePlugins.registerOfficial(plugin);
      return {
        tenantId: "__enterprise_core__",
        plugins: corePlugins,
      } satisfies TenantPluginRuntime;
    })();
  const plugins = defaultRuntime.plugins;
  if (profile === "enterprise") {
    if (!options.store.listTenantIds) {
      throw new Error("企业签名插件要求存储实现 listTenantIds，以便 readiness 校验全部租户 lock");
    }
    const tenantIds = await options.store.listTenantIds();
    await Promise.all(tenantIds.map((tenantId) => runtimeForTenant(tenantId)));
  }

  const tenantPluginReadiness = async (): Promise<EnterpriseReadiness> => {
    const issues: EnterpriseReadiness["issues"][number][] = [];
    if (profile === "enterprise") {
      try {
        const tenantIds = await options.store.listTenantIds!();
        await Promise.allSettled(tenantIds.map((tenantId) => runtimeForTenant(tenantId)));
      } catch {
        issues.push({
          code: "TENANT_PLUGIN_READINESS_FAILED",
          message: "无法列出需要校验插件 lock 的租户",
          action: "恢复 PostgreSQL 后重新检查插件状态",
        });
      }
    }
    if (tenantRuntimeFailures.size > 0) {
      issues.push({
        code: "TENANT_PLUGIN_RUNTIME_UNAVAILABLE",
        message: "至少一个租户的插件运行时无法创建",
        action: "检查镜像内签名插件仓库和租户插件配置",
      });
    }
    const settled = await Promise.allSettled([...tenantRuntimes.values()].map(async (runtimePromise) => {
      const runtime = await runtimePromise;
      const missingInstalledRuntime = !runtime.installer
        && await options.store.transact(runtime.tenantId, (transaction) =>
          transaction.listProjections(PLUGIN_INSTALLATION_PROJECTION).length > 0);
      if (missingInstalledRuntime) {
        return {
          ready: false,
          issues: [{
            code: "TENANT_PLUGIN_REPOSITORY_REQUIRED",
            message: "数据库存在租户插件 installation，但当前 Host 未配置对应签名仓库",
            action: "使用包含相同签名插件仓库的发布镜像重新部署",
          }],
        };
      }
      await runtime.installer?.synchronize?.();
      return runtime.installer?.readiness?.();
    }));
    for (const result of settled) {
      if (result.status === "rejected") {
        issues.push({
          code: "TENANT_PLUGIN_READINESS_FAILED",
          message: "至少一个租户的插件 lock 无法读取",
          action: "恢复 PostgreSQL 后重新检查插件状态",
        });
        continue;
      }
      for (const issue of result.value?.issues ?? []) issues.push(issue);
    }
    const unique = [...new Map(issues.map((issue) => [issue.code, issue])).values()];
    const isolatedIssues = new Set(["TENANT_PLUGIN_OPERATION_IN_PROGRESS", "TENANT_PLUGIN_RELEASE_UNAVAILABLE"]);
    return { ready: unique.every(issue => isolatedIssues.has(issue.code)), issues: unique };
  };
  await context.plugin({ name: "agent-os.plugins", apply(scope) { scope.provide("agentOsPlugins", plugins); } });
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  const inFlightAsyncMutations = new Map<string, InFlightAsyncMutation>();
  const allowedOrigins = new Set([...DESKTOP_ORIGINS, ...(options.allowedOrigins ?? [])]);
  const activeEventStreams = new Set<() => void>();
  const erasePayloadKeys = async (tenantId: string, actorId: string, purpose: string, requestId: string) => {
    if (!protectedJournal) return;
    const unresolved = await drainKeyRevocations({ store: options.store, tenantId, actorId, purpose,
      requestId, now, keyProvider: options.protectedPayloadKeyProvider! });
    if (unresolved) throw new KernelError("KEY_REVOCATION_PENDING", "数据已移除，但密钥删除尚未确认",
      "在收件箱核对密钥删除；历史备份可能仍可解密", false);
  };
  const ssePollIntervalMs = positiveInterval(options.ssePollIntervalMs, 250);
  const sseKeepAliveIntervalMs = positiveInterval(options.sseKeepAliveIntervalMs, 15_000);

  const withPluginUse = async <T>(
    runtime: TenantPluginRuntime,
    pluginId: string,
    purpose: "activation" | "execution",
    actorId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> => {
    if (officialPluginIds.has(pluginId)) return work();
    if (runtime.installer?.withPluginUse) {
      return runtime.installer.withPluginUse(pluginId, purpose, work, { actorId });
    }
    if (profile === "enterprise") {
      throw new PluginPolicyError(
        "PLUGIN_NOT_ACTIVE",
        `企业插件 ${pluginId} 的安装器不能证明跨 Host 互斥`,
        "配置支持持久化执行租约的租户安装器",
      );
    }
    if (purpose === "execution") runtime.installer?.assertCanStartExecution?.(pluginId);
    else runtime.installer?.assertCanActivate?.(pluginId);
    return work();
  };

  const withPluginUses = async <T>(
    runtime: TenantPluginRuntime,
    pluginIds: readonly string[],
    purpose: "activation" | "execution",
    actorId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> => {
    const pending = [...new Set(pluginIds.filter((pluginId) => !officialPluginIds.has(pluginId)))].sort();
    const run = async (index: number): Promise<T> => index === pending.length
      ? work()
      : withPluginUse(runtime, pending[index]!, purpose, actorId, () => run(index + 1));
    return run(0);
  };

  const ensurePluginsActive = async (
    tenantId: string,
    workspace: Workspace,
    runtime?: TenantPluginRuntime,
    actorId?: string,
  ): Promise<string> => {
    const tenantRuntime = runtime ?? await runtimeForTenant(tenantId);
    if (profile === "enterprise") await tenantRuntime.installer?.synchronize?.();
    const scope = encodePluginWorkspace(tenantId, workspace.id);
    const desired = new Set(workspace.activePluginIds);
    for (const registered of tenantRuntime.plugins.listRegistered()) {
      if (!desired.has(registered.pluginId)
        && tenantRuntime.plugins.activeWorkspaceIds(registered.pluginId).includes(scope)) {
        await tenantRuntime.plugins.deactivate(scope, registered.pluginId);
      }
    }
    for (const pluginId of desired) {
      if (!officialPluginIds.has(pluginId)) {
        await withPluginUse(tenantRuntime, pluginId, "activation", actorId, async () => {
          tenantRuntime.installer?.assertCanActivate?.(pluginId);
          if (!tenantRuntime.installer?.isActive?.(pluginId)) {
            await tenantRuntime.installer?.activate?.(pluginId, { actorId });
          }
          await tenantRuntime.plugins.activate(scope, pluginId);
        });
        continue;
      }
      await tenantRuntime.plugins.activate(scope, pluginId);
    }
    return scope;
  };

  const requireRunnerPluginTool = async (
    tenantId: string,
    workspace: Workspace,
    runnerId: Exclude<CodingRunnerId, "builtin">,
  ): Promise<string> => {
    const pluginId = runnerPluginId(runnerId);
    if (!workspace.activePluginIds.includes(pluginId)) {
      throw new PluginPolicyError(
        "PLUGIN_NOT_ACTIVE",
        `工作区未启用插件 ${pluginId}`,
        "先在工作区启用对应 Runner 插件",
      );
    }
    const runtime = await runtimeForTenant(tenantId);
    const scope = await ensurePluginsActive(tenantId, workspace, runtime);
    const health = (await runtime.plugins.health(scope)).plugins.find((entry) => entry.pluginId === pluginId);
    if (!health) {
      throw new PluginPolicyError(
        "PLUGIN_NOT_ACTIVE",
        `工作区未激活插件 ${pluginId}`,
        "重新启用对应 Runner 插件",
      );
    }
    if (health.status !== "healthy") {
      throw new PluginBoundaryError(pluginId, "health", new Error(health.message ?? "Runner 插件已降级"));
    }
    const expectedToolId = runnerToolId(runnerId);
    const declaredTool = runtime.plugins.definition(pluginId)?.contributions.tools
      .find((tool) => tool.id === expectedToolId && tool.effectClass === "external_side_effect");
    const activeTool = runtime.plugins.contributions(scope).tools
      .find((tool) => tool.id === expectedToolId && tool.effectClass === "external_side_effect");
    if (!declaredTool || !activeTool) {
      throw new PluginPolicyError(
        "PLUGIN_CONTRIBUTION_INVALID",
        `Runner 插件 ${pluginId} 未提供受控工具 ${expectedToolId}`,
        "修复并重新启用 Runner 插件",
      );
    }
    return activeTool.id;
  };

  const encodeJson = json;
  const dispatch = async (request: Request): Promise<Response> => {
    const json: typeof encodeJson = (value, status = 200, traceId) => {
      const operationId = matchApiOperation(request.method, new URL(request.url).pathname);
      if (operationId && status >= 200 && status < 300) {
        if (operationId === "downloadAsset" || operationId === "streamWorkspaceEvents") {
          throw new Error("流式响应不能使用 JSON 信封");
        }
        parseApiResponse(operationId, JSON.parse(JSON.stringify({ data: value, traceId })));
      }
      return encodeJson(value, status, traceId);
    };
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
        const base = await (options.readiness?.() ?? { ready: true, issues: [] });
        if (!base.ready) return json(base, 503, traceId);
        const pluginState = await tenantPluginReadiness();
        const readiness = {
          ready: base.ready && pluginState.ready,
          issues: [...base.issues, ...pluginState.issues],
        };
        return json(readiness, readiness.ready ? 200 : 503, traceId);
      }
      if (request.method === "GET" && url.pathname === "/v2/health" && !url.searchParams.has("workspaceId")) {
        return json(await plugins.health("__core__"), 200, traceId);
      }
      const authorityQuery = url.pathname.match(/^\/v2\/business-actions\/([^/]+)\/execution-authority$/u);
      if (authorityQuery && request.method === "GET") return json(await businessExecutionAuthorityResponse(request, decodeURIComponent(authorityQuery[1]!), {
        store: options.store, ...(options.businessAuthorityTokenResolver ? { tokenResolver: options.businessAuthorityTokenResolver } : {}),
        ...(options.businessWorkspaceScopes ? { allowedScopes: options.businessWorkspaceScopes } : {}), ...(options.now ? { now: options.now } : {}),
      }), 200, traceId);
      const candidateContent = url.pathname.match(/^\/v2\/business-candidates\/([^/]+)\/content$/u);
      if (candidateContent && request.method === "GET") {
        if (!options.cas || !options.protectedPayloadKeyProvider) throw new KernelError("PROTECTED_STORAGE_REQUIRED", "询价候选需要受保护存储", "配置对象存储和保护密钥");
        return json(await businessCandidateContentResponse(request, decodeURIComponent(candidateContent[1]!), {
          store: options.store, cas: options.cas, keyProvider: options.protectedPayloadKeyProvider,
          ...(options.businessAuthorityTokenResolver ? { tokenResolver: options.businessAuthorityTokenResolver } : {}),
          ...(options.businessWorkspaceScopes ? { allowedScopes: options.businessWorkspaceScopes } : {}), ...(options.now ? { now: options.now } : {}),
        }), 200, traceId);
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
      const ORGANIZATION_ROLES = identity.organizationRoles ?? [];
      const tenantRuntime = await runtimeForTenant(TENANT_ID);
      const tenantPlugins = tenantRuntime.plugins;
      const pluginInstaller = tenantRuntime.installer;
      await pluginInstaller?.synchronize?.();
      const pluginWorkspaceKey = (workspaceId: string) => encodePluginWorkspace(TENANT_ID, workspaceId);
      const resolveCodingNewCallRuntimeReadiness: CodingNewCallReadinessResolver = async ({
        workspaceId,
        runnerId,
      }) => {
        const unavailable = {
          allowed: false,
          summary: "Runner 插件未能完成激活、健康检查或受控工具校验，暂时不能创建新调用",
        } as const;
        const workspace = await projectionGet<Workspace>(
          options.store,
          TENANT_ID,
          "workspace",
          workspaceId,
        );
        if (!workspace || workspace.tenantId !== TENANT_ID) return unavailable;
        try {
          await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
          await requireRunnerPluginTool(TENANT_ID, workspace, runnerId);
          return {
            allowed: true,
            summary: "Coding 与 Runner 插件运行态已就绪",
          } as const;
        } catch {
          return unavailable;
        }
      };
      const accessibleWorkspaceIds = async () => new Set(
        (await projectionList<WorkspaceMembership>(options.store, TENANT_ID, "membership"))
          .filter((membership) => membership.principalId === ACTOR_ID && !membership.removedAt)
          .map((membership) => membership.workspaceId),
      );
      const businessActionMatch = url.pathname.match(/^\/v2\/business-actions\/([^/]+)(\/reconciliation-decisions)?$/u);
      const candidateMatch = url.pathname.match(/^\/v2\/business-candidates\/([^/]+)$/u);
      if ((url.pathname === "/v2/business-candidates" && request.method === "POST") || (candidateMatch && request.method === "GET")) {
        if (!options.businessProvider?.inquiries || !options.cas || !options.protectedPayloadKeyProvider)
          throw new KernelError("BUSINESS_PROVIDER_DISABLED", "询价候选服务尚未启用", "配置业务资料接口和受保护存储");
        const requireEnabled = (workspaceId: string) => {
          if (!options.businessWorkspaceScopes?.some(scope => scope.tenantId === TENANT_ID && scope.workspaceId === workspaceId))
            throw new KernelError("BUSINESS_PROVIDER_DISABLED", "此工作区未启用业务交付服务", "由管理员显式启用工作区");
        };
        if (!candidateMatch) {
          const input = parseCreateBusinessCandidateV2(await readBody(request));
          await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, input.workspaceId, "operate");
          requireEnabled(input.workspaceId);
          const state = await createBusinessCandidate(input, { tenantId: TENANT_ID, workspaceId: input.workspaceId, principalId: ACTOR_ID, customerId: input.customerId }, mutationKey as string, {
            store: options.store, cas: options.cas, keyProvider: options.protectedPayloadKeyProvider, sourcePort: options.businessProvider.inquiries,
            ...(options.now ? { now: options.now } : {}),
          });
          return json(publicBusinessCandidate(state), 201, traceId);
        }
        const state = await new BusinessCandidateLedger(options.store).get(TENANT_ID, decodeURIComponent(candidateMatch[1]!));
        if (!state) throw new KernelError("BUSINESS_CANDIDATE_NOT_FOUND", "询价候选不存在", "刷新当前询价");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, state.workspaceId, "view");
        requireEnabled(state.workspaceId);
        return json(publicBusinessCandidate(state), 200, traceId);
      }
      if ((url.pathname === "/v2/business-actions" && request.method === "POST") || businessActionMatch) {
        if (!options.businessProvider) throw new KernelError("BUSINESS_PROVIDER_DISABLED", "当前未启用业务交付服务", "配置受信业务服务后再试");
        const ledger = new BusinessActionLedger(options.store, { ...(options.now ? { now: options.now } : {}) });
        const actionView = async (action: Awaited<ReturnType<typeof ledger.create>>) => {
          const approval = action.approvalId ? await projectionGet<Approval>(options.store, TENANT_ID, "approval", action.approvalId) : undefined;
          return { ...publicBusinessAction(action), ...(approval ? { approval } : {}) };
        };
        const requireEnabled = (workspaceId: string) => {
          if (!options.businessWorkspaceScopes?.some(scope => scope.tenantId === TENANT_ID && scope.workspaceId === workspaceId))
            throw new KernelError("BUSINESS_PROVIDER_DISABLED", "此工作区未启用业务交付服务", "由管理员显式启用工作区");
        };
        if (!businessActionMatch) {
          const input = parseCreateBusinessActionV2(await readBody(request));
          await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, input.workspaceId, "operate");
          requireEnabled(input.workspaceId);
          const scope = { tenantId: TENANT_ID, workspaceId: input.workspaceId, principalId: ACTOR_ID, customerId: input.customerId };
          const action = await prepareBusinessAction(input, scope, options.businessProvider, options.now?.() ?? new Date().toISOString());
          return json(await actionView(await ledger.create(action, mutationKey as string)), 201, traceId);
        }
        const action = await ledger.get(TENANT_ID, decodeURIComponent(businessActionMatch[1]!));
        if (!action) throw new KernelError("BUSINESS_ACTION_NOT_FOUND", "业务动作不存在", "刷新业务操作列表");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, action.workspaceId, request.method === "GET" ? "view" : "review");
        requireEnabled(action.workspaceId);
        if (request.method === "GET" && !businessActionMatch[2]) return json(await actionView(action), 200, traceId);
        if (request.method === "POST" && businessActionMatch[2]) {
          const input = parseReconcileBusinessActionV2(await readBody(request));
          const receipt = await options.businessProvider.receipts.lookup({ schemaVersion: "1", scope: { ...action.action.scope, principalId: ACTOR_ID },
            actionId: action.id, operationKey: action.operationKey });
          return json(await actionView(await ledger.reconcile(TENANT_ID, action.id, input.expectedStreamVersion, input.decision, receipt,
            { actorId: ACTOR_ID, idempotencyKey: mutationKey as string })), 200, traceId);
        }
        return notFound(traceId);
      }
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
        if (!workspaceId) return json(await tenantPlugins.health("__core__"), 200, traceId);
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        const scope = await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        return json(await tenantPlugins.health(scope), 200, traceId);
      }
      if (request.method === "GET" && url.pathname === "/v2/workspaces") {
        const workspaces = await kernel.listWorkspaces(TENANT_ID);
        const memberships = await projectionList<WorkspaceMembership>(options.store, TENANT_ID, "membership");
        const allowed = new Set(memberships
          .filter((membership) => membership.principalId === ACTOR_ID && !membership.removedAt)
          .map((membership) => membership.workspaceId));
        return json(workspaces.filter((workspace) => allowed.has(workspace.id)), 200, traceId);
      }
      if (request.method === "POST" && url.pathname === "/v2/workspaces") {
        requireOrganizationRole(profile, ORGANIZATION_ROLES, ["organization_admin"]);
        if (profile === "enterprise") await pluginInstaller?.synchronize?.();
        const body = await readBody(request);
        const pluginsInput = Array.isArray(body.pluginIds) && body.pluginIds.every((id) => typeof id === "string")
          ? body.pluginIds as string[] : [];
        const knownPlugins = new Set(
          tenantPlugins.listRegistered().map((plugin) => plugin.pluginId),
        );
        const unknownPlugin = pluginsInput.find((pluginId) => !knownPlugins.has(pluginId));
        if (unknownPlugin) {
          throw new PluginPolicyError(
            "PLUGIN_NOT_INSTALLED",
            `插件 ${unknownPlugin} 不可用`,
            "安装插件后再创建工作区",
          );
        }
        const viewMode = body.viewMode === "professional" ? "professional" : "business";
        const workspace = await withPluginUses(
          tenantRuntime,
          pluginsInput,
          "activation",
          ACTOR_ID,
          async () => {
            const created = await kernel.createWorkspace(TENANT_ID, ACTOR_ID, mutationKey as string, {
              name: stringField(body, "name")!, viewMode, pluginIds: pluginsInput,
              organizationRoles: ORGANIZATION_ROLES,
            });
            for (const pluginId of pluginsInput) {
              if (!officialPluginIds.has(pluginId)) {
                await pluginInstaller?.activate?.(pluginId, { actorId: ACTOR_ID });
              }
              await tenantPlugins.activate(pluginWorkspaceKey(created.id), pluginId);
            }
            return created;
          },
        );
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
            appendKernelEvent(transaction, {
              tenantId: TENANT_ID, aggregateType: "workspace", aggregateId: id,
              expectedStreamVersion: expected, type: "workspace.updated", actorId: ACTOR_ID,
              generation: 0, correlationId: nextId("correlation"), publicPayload: { name: next.name, viewMode: next.viewMode },
            });
            return next;
          },
        });
        return json(workspace, 200, traceId);
      }
      const workspaceMembersMatch = url.pathname.match(/^\/v2\/workspaces\/([^/]+)\/members$/u);
      if (workspaceMembersMatch && request.method === "GET") {
        const workspaceId = decodeURIComponent(workspaceMembersMatch[1]!);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        return json(await kernel.listWorkspaceMemberships(TENANT_ID, workspaceId), 200, traceId);
      }
      const workspaceMemberMatch = url.pathname.match(
        /^\/v2\/workspaces\/([^/]+)\/members\/([^/]+)$/u,
      );
      if (workspaceMemberMatch && request.method === "PUT") {
        const workspaceId = decodeURIComponent(workspaceMemberMatch[1]!);
        const principalId = decodeURIComponent(workspaceMemberMatch[2]!);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "owner");
        const body = await readBody(request);
        const workspaceRole = stringField(body, "workspaceRole");
        if (workspaceRole !== "owner" && workspaceRole !== "operator"
          && workspaceRole !== "reviewer" && workspaceRole !== "viewer") {
          throw new KernelError(
            "WORKSPACE_ROLE_INVALID",
            "工作区角色无效",
            "选择 owner、operator、reviewer 或 viewer",
          );
        }
        return json(await kernel.setWorkspaceMembership(
          TENANT_ID,
          ACTOR_ID,
          mutationKey as string,
          workspaceId,
          principalId,
          expectedVersion(body),
          workspaceRole,
        ), 200, traceId);
      }
      if (workspaceMemberMatch && request.method === "DELETE") {
        const workspaceId = decodeURIComponent(workspaceMemberMatch[1]!);
        const principalId = decodeURIComponent(workspaceMemberMatch[2]!);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "owner");
        const body = await readBody(request);
        return json(await kernel.removeWorkspaceMembership(
          TENANT_ID,
          ACTOR_ID,
          mutationKey as string,
          workspaceId,
          principalId,
          expectedVersion(body),
        ), 200, traceId);
      }
      if (url.pathname === "/v2/plugins/catalog" && request.method === "GET") {
        const snapshot = await options.pluginRepository?.read();
        return json((snapshot?.releases ?? []).map(({ manifest }) => ({
          pluginId: manifest.id, version: manifest.version, displayName: manifest.displayName,
          description: manifest.description, license: manifest.license,
          permissions: manifest.permissions, packageSha256: manifest.packageSha256,
          trustBoundary: "process_equivalent", release: manifest.release,
        })), 200, traceId);
      }
      const surfacesMatch = url.pathname.match(/^\/v2\/workspaces\/([^/]+)\/plugin-surfaces$/u);
      if (surfacesMatch && request.method === "GET") {
        const workspaceId = decodeURIComponent(surfacesMatch[1]!);
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        return json(workspace.activePluginIds.flatMap((pluginId) => {
          const definition = tenantPlugins.definition(pluginId);
          return definition?.surfaces ? [{ pluginId, version: definition.version,
            navigation: definition.contributions.navigation, ...definition.surfaces }] : [];
        }), 200, traceId);
      }
      const agentCatalogMatch = url.pathname.match(/^\/v2\/workspaces\/([^/]+)\/agent-catalog$/u);
      if (agentCatalogMatch && request.method === "GET") {
        const workspaceId = decodeURIComponent(agentCatalogMatch[1]!);
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        const agents = [];
        const skills = [];
        for (const pluginId of workspace.activePluginIds) {
          const definition = tenantPlugins.definition(pluginId);
          if (!definition) continue;
          agents.push(...definition.contributions.agents.map((agent) => ({
            pluginId,
            id: agent.id,
            displayName: agent.displayName,
            description: agent.description,
          })));
          skills.push(...definition.contributions.skills.map((skill) => ({
            pluginId,
            id: skill.id,
            title: skill.title,
            expectedOutcome: skill.expectedOutcome,
            ...(skill.exampleInput ? { exampleInput: skill.exampleInput } : {}),
            source: skill.source,
            license: skill.license,
            version: skill.version,
            permissionIds: skill.permissionIds,
            installation: "active" as const,
          })));
        }
        return json({ agents, skills }, 200, traceId);
      }
      const homeMatch = url.pathname.match(/^\/v2\/workspaces\/([^/]+)\/home$/u);
      if (homeMatch && request.method === "GET") {
        const workspaceId = decodeURIComponent(homeMatch[1]!);
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
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
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
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
        return json(await threadTurns(options.store, TENANT_ID, threadId,
          options.cas && options.protectedPayloadKeyProvider
            ? { cas: options.cas, keyProvider: options.protectedPayloadKeyProvider } : undefined), 200, traceId);
      }
      if (turnMatch && request.method === "POST") {
        const body = await readBody(request);
        const workspaceId = decodeURIComponent(turnMatch[1]!);
        const threadId = decodeURIComponent(turnMatch[2]!);
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        const expected = expectedVersion(body);
        const thread = await projectionGet<Thread>(options.store, TENANT_ID, "thread", threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          throw new KernelError("THREAD_NOT_FOUND", "会话不存在", "刷新工作区会话");
        }
        if (!workspace.activePluginIds.includes(thread.pluginId)) {
          throw new PluginPolicyError(
            "PLUGIN_NOT_ACTIVE",
            `工作区未启用插件 ${thread.pluginId}`,
            "先在工作区启用插件",
          );
        }
        const definition = tenantPlugins.definition(thread.pluginId);
        if (!definition) {
          throw new PluginPolicyError("PLUGIN_NOT_INSTALLED", `插件 ${thread.pluginId} 不可用`, "安装插件后重试");
        }
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
          : connections.find((connection) => connection.status === "ready" && connection.defaultForNewExecutions)
            ?? connections.find((connection) => connection.status === "ready");
        if (!modelConnection) {
          throw new KernelError(
            "MODEL_CONNECTION_REQUIRED",
            requestedModel ? "所选模型连接不可用" : "尚未连接可用模型",
            "在集成设置中连接模型后重试",
          );
        }
        const requestedRunner = stringField(body, "runnerId", false);
        if (thread.pluginId !== "coding" && requestedRunner !== undefined) {
          throw new KernelError(
            "CODING_RUNNER_NOT_APPLICABLE",
            "runnerId 只能用于 Coding turn",
            "删除 runnerId 或选择 Coding 会话",
          );
        }
        let runnerId: CodingRunnerId | undefined;
        let runnerTool: string | undefined;
        if (thread.pluginId === "coding") {
          runnerId = requestedRunner === undefined || requestedRunner === "builtin"
            ? "builtin"
            : parseExternalCodingRunnerId(requestedRunner);
          if (runnerId !== "builtin") {
            runnerTool = await requireRunnerPluginTool(TENANT_ID, workspace, runnerId);
            await requireConfirmedCodingRunner(
              options.store,
              TENANT_ID,
              workspaceId,
              runnerId,
            );
          }
        }
        const toolIds = definition.contributions.tools.map((tool) => tool.id);
        if (runnerTool) toolIds.push(runnerTool);
        const dataNamespaces = new Set([thread.pluginId]);
        if (toolIds.some((toolId) => toolId.includes("web"))) dataNamespaces.add("web");
        if (toolIds.some((toolId) => toolId.includes("repository") || toolId.includes("sandbox"))) {
          dataNamespaces.add("repository");
        }
        const message = stringField(body, "message")!;
        const modelPrice = findModelPrice(modelConnection.presetId, modelConnection.defaultModel);
        if (!modelPrice) throw new KernelError("MODEL_PRICE_UNAVAILABLE", "模型缺少参考价格", "重新探测模型连接后再提交任务");
        const preparedMessage = options.cas && options.protectedPayloadKeyProvider
          ? await storeProtectedJson({ tenantId: TENANT_ID, workspaceId, ownerType: "thread",
            ownerId: threadId, protectedPayloadRef: nextId("thread-payload"), value: { message: message.trim() },
            cas: options.cas, keyProvider: options.protectedPayloadKeyProvider, createdAt: now() })
          : undefined;
        const execution = await withPluginUse(
          tenantRuntime,
          thread.pluginId,
          "execution",
          ACTOR_ID,
          async () => {
            if (!officialPluginIds.has(thread.pluginId)) {
              pluginInstaller?.assertCanStartExecution?.(thread.pluginId);
            }
            return kernel.submitTurn(TENANT_ID, ACTOR_ID, mutationKey as string, {
              workspaceId,
              threadId,
              expectedStreamVersion: expected,
              message,
              ...(preparedMessage ? { preparedMessage } : {}),
              agentDefinitionId: agentDefinition.id,
              ...(definition.manifest ? { pluginPackageSha256: definition.manifest.packageSha256 } : {}),
              modelBindingId: modelConnection.id,
              executionPrincipalId: `agent:${thread.pluginId}`,
              ...(runnerId ? { runnerId } : {}),
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
                  currency: modelPrice.rates.currency,
                  maxDurationMs: 3_600_000,
                },
              },
            });
          },
        );
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
        if (execution.pluginId === "industry") {
          throw new KernelError("BUSINESS_EXECUTION_COMMAND_FORBIDDEN", "行业固定流程只能通过业务入口管理", "在业务页查看候选、批准出包或核对未知结果");
        }
        const command = stringField(body, "command")!;
        if (command === "follow_up" || command === "steer") {
          const text = stringField(body, "message")!;
          const expected = expectedVersion(body);
          const inboxItemId = nextId("inbox-item");
          const preparedPayload = options.cas && options.protectedPayloadKeyProvider
            ? await storeProtectedJson({ tenantId: TENANT_ID, workspaceId: execution.workspaceId,
              ownerType: "runtime", ownerId: executionId, protectedPayloadRef: nextId("runtime-payload"),
              value: { id: inboxItemId, kind: command, text }, cas: options.cas,
              keyProvider: options.protectedPayloadKeyProvider, createdAt: now() }) : undefined;
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
              enqueueRuntimeInbox(transaction, {
                executionId,
                kind: command,
                text,
                occurredAt: timestamp,
                recordId: nextId("runtime"),
                itemId: inboxItemId,
                ...(preparedPayload ? { preparedPayload } : {}),
              });
              const next: Execution = {
                ...current,
                streamVersion: current.streamVersion + 1,
                updatedAt: timestamp,
              };
              transaction.putProjection("execution", executionId, next);
              appendKernelEvent(transaction, {
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
        if (command === "cancel" && execution.pluginId === "coding") {
          const expectedStreamVersion = expectedVersion(body);
          const idempotencyScope = `coding.execution.command:${executionId}`;
          const idempotencyRequest = { expectedStreamVersion, command };
          const replay = await options.store.transact(TENANT_ID, (transaction) =>
            transaction.getIdempotency(idempotencyScope, mutationKey as string));
          if (replay) {
            if (replay.requestDigest !== sha256(idempotencyRequest)) {
              throw new KernelError(
                "IDEMPOTENCY_KEY_REUSED",
                "幂等键已用于不同请求",
                "使用新的 Idempotency-Key",
              );
            }
            const stored = replay.response as Execution | { readonly execution: Execution };
            return json("execution" in stored ? stored.execution : stored, 200, traceId);
          }
          if (execution.status === "needs_reconciliation") {
            const detail = await getCodingReconciliation(
              options.store,
              TENANT_ID,
              ACTOR_ID,
              executionId,
              reconciliationVerificationReadiness(),
            );
            const result = await decideCodingReconciliation(options.store, {
              tenantId: TENANT_ID,
              actorId: ACTOR_ID,
              idempotencyKey: mutationKey as string,
              idempotencyScope,
              idempotencyRequest,
              executionId,
              expectedStreamVersion,
              expectedCodingStreamVersion: detail.expectedCodingStreamVersion,
              decision: "terminate",
              verificationReadiness: reconciliationVerificationReadiness(),
              newCallRuntimeReadiness: detail.newCall,
              now,
              id: nextId,
            });
            return json(result.execution, 200, traceId);
          }
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
        const visible = allowed ? inbox.filter((item) => allowed.has(item.workspaceId)) : inbox;
        const linked = await options.store.transact(TENANT_ID, transaction => visible.map(item => {
          if (!item.executionId) return item;
          const execution = transaction.getProjection<Execution>("execution", item.executionId);
          if (!execution || execution.tenantId !== TENANT_ID || execution.workspaceId !== item.workspaceId) return item;
          const thread = transaction.getProjection<Thread>("thread", execution.threadId);
          if (!thread || thread.tenantId !== TENANT_ID || thread.workspaceId !== item.workspaceId) return item;
          return { ...item, navigation: { threadId: thread.id, pluginId: thread.pluginId,
            ...(thread.resourceRef ? { resourceRef: thread.resourceRef } : {}) } };
        }));
        return json(linked, 200, traceId);
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
          ...(options.protectedPayloadKeyProvider
            ? { protectedPayloadKeyProvider: options.protectedPayloadKeyProvider }
            : {}),
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
        return json(await workspaceActivity(options.store, TENANT_ID, workspaceId,
          options.cas && options.protectedPayloadKeyProvider ? { cas: options.cas, keyProvider: options.protectedPayloadKeyProvider } : undefined), 200, traceId);
      }
      const assetMatch = url.pathname.match(/^\/v2\/assets\/([^/]+)(\/content)?$/u);
      if (assetMatch && request.method === "GET") {
        const asset = await projectionGet<Asset>(
          options.store,
          TENANT_ID,
          "asset",
          decodeURIComponent(assetMatch[1]!),
        );
        if (!asset) return notFound(traceId);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, asset.workspaceId);
        if (url.searchParams.size) throw new KernelError("INVALID_BODY", "附件接口不接受查询参数", "使用附件元数据或文件下载接口");
        if (!assetMatch[2]) return json(asset, 200, traceId);
        if (!options.cas) throw new KernelError("ASSET_STORE_UNAVAILABLE", "成果文件暂不可用", "检查对象存储连接");
        return new Response(await readAssetContent({
          store: options.store,
          cas: options.cas,
          tenantId: TENANT_ID,
          asset,
          ...(options.protectedPayloadKeyProvider
            ? { protectedPayloadKeyProvider: options.protectedPayloadKeyProvider }
            : {}),
        }), {
          headers: {
            "content-type": asset.mediaType,
            "content-length": String(asset.byteLength),
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`,
          },
        });
      }
      if (assetMatch && !assetMatch[2] && request.method === "DELETE") {
        const body = await readBody(request);
        if (Object.keys(body).some((field) => !["expectedStreamVersion", "reason"].includes(field))) {
          throw new KernelError("INVALID_BODY", "附件删除请求包含不支持的字段", "删除未在 OpenAPI 中声明的字段");
        }
        const assetId = decodeURIComponent(assetMatch[1]!);
        const target = await options.store.transact(TENANT_ID, (transaction) =>
          transaction.getProjection<Asset>("asset", assetId)
          ?? transaction.getProjection<AssetTombstone>(ASSET_TOMBSTONE_NAMESPACE, assetId));
        if (!target) throw new KernelError("ASSET_NOT_FOUND", "附件不存在", "刷新成果列表");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, target.workspaceId, "owner");
        const deleted = await deleteAsset({
          store: options.store,
          tenantId: TENANT_ID,
          actorId: ACTOR_ID,
          assetId,
          idempotencyKey: mutationKey as string,
          expectedStreamVersion: expectedVersion(body),
          reason: stringField(body, "reason")!,
          now,
          id: nextId,
        });
        await erasePayloadKeys(TENANT_ID, ACTOR_ID, `asset:${assetId}`, mutationKey as string);
        return json(deleted, 200, traceId);
      }
      if (url.pathname === "/v2/memories" && request.method === "GET") {
        const namespace = url.searchParams.get("namespace");
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
        if (workspaceId) await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        const allowed = workspaceId ? undefined : await accessibleWorkspaceIds();
        const values = await projectionList<MemoryRecord>(options.store, TENANT_ID, "memory");
        const visible = values
          .filter((value) => workspaceId ? value.workspaceId === workspaceId : allowed!.has(value.workspaceId))
          .filter((value) => !namespace || value.namespace === namespace);
        return json(await Promise.all(visible.map(async (value) => {
          const memoryValue = await readMemoryValue({
            store: options.store,
            cas: options.cas,
            keyProvider: options.protectedPayloadKeyProvider,
            tenantId: TENANT_ID,
            memory: value,
          });
          return {
            id: value.id,
            namespace: value.namespace,
            resourceId: value.resourceId,
            summary: typeof memoryValue.summary === "string" ? memoryValue.summary : "待审阅的记忆提案",
            source: value.sourceEventId,
            confidence: value.confidence,
            status: value.status,
            streamVersion: value.streamVersion,
          };
        })), 200, traceId);
      }
      if (url.pathname === "/v2/memories" && request.method === "POST") {
        const body = await readBody(request);
        if (Object.hasOwn(body, "protectedPayloadRef")) {
          throw new KernelError(
            "PROTECTED_PAYLOAD_REF_FORBIDDEN",
            "客户端不能指定受保护数据引用",
            "提交明文输入，由 Host 创建受保护数据引用",
          );
        }
        if (!isObject(body.value)) {
          throw new KernelError("INVALID_BODY", "记忆提案需要 value", "提交结构化记忆内容");
        }
        const workspaceId = stringField(body, "workspaceId")!;
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        const memoryId = nextId("memory");
        const preparedPayload = await prepareMemoryPayload({
          store: options.store,
          cas: options.cas,
          keyProvider: options.protectedPayloadKeyProvider,
          tenantId: TENANT_ID,
          workspaceId,
          memoryId,
          protectedPayloadRef: nextId("protected-payload"),
          value: body.value as JsonObject,
          createdAt: now(),
        });
        const memory = await kernel.proposeMemory(TENANT_ID, ACTOR_ID, mutationKey as string, {
          workspaceId,
          scopeType: body.scopeType === "thread" || body.scopeType === "resource" || body.scopeType === "principal"
            ? body.scopeType : "workspace",
          namespace: stringField(body, "namespace")!, resourceId: stringField(body, "resourceId")!,
          sourceEventId: stringField(body, "sourceEventId")!,
          confidence: typeof body.confidence === "number" ? body.confidence : 0,
          ...(typeof body.expiresAt === "string" ? { expiresAt: body.expiresAt } : {}),
          ...(typeof body.derivedFromMemoryId === "string"
            ? { derivedFromMemoryId: body.derivedFromMemoryId } : {}),
          ...(typeof body.derivedViaShareGrantId === "string"
            ? { derivedViaShareGrantId: body.derivedViaShareGrantId } : {}),
          preparedPayload,
        });
        return json(publicMemory(memory, body.value as JsonObject), 201, traceId);
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
        const decided = await kernel.decideMemory(
          TENANT_ID,
          ACTOR_ID,
          mutationKey as string,
          memoryId,
          expectedVersion(body),
          decision,
        );
        return json(publicMemory(decided, await readMemoryValue({
          store: options.store,
          cas: options.cas,
          keyProvider: options.protectedPayloadKeyProvider,
          tenantId: TENANT_ID,
          memory: decided,
        })), 200, traceId);
      }
      const memoryMatch = url.pathname.match(/^\/v2\/memories\/([^/]+)$/u);
      if (memoryMatch && request.method === "PATCH") {
        const body = await readBody(request);
        const memoryId = decodeURIComponent(memoryMatch[1]!);
        const memory = await projectionGet<MemoryRecord>(options.store, TENANT_ID, "memory", memoryId);
        if (!memory) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, memory.workspaceId, "operate");
        if (Object.hasOwn(body, "protectedPayloadRef")) {
          throw new KernelError(
            "PROTECTED_PAYLOAD_REF_FORBIDDEN",
            "客户端不能指定受保护数据引用",
            "提交明文输入，由 Host 创建受保护数据引用",
          );
        }
        if (!isObject(body.value) || typeof body.confidence !== "number") {
          throw new KernelError("INVALID_BODY", "修改记忆需要 value 和 confidence", "填写修正后的内容与置信度");
        }
        const preparedPayload = await prepareMemoryPayload({
          store: options.store,
          cas: options.cas,
          keyProvider: options.protectedPayloadKeyProvider,
          tenantId: TENANT_ID,
          workspaceId: memory.workspaceId,
          memoryId,
          protectedPayloadRef: nextId("protected-payload"),
          value: body.value as JsonObject,
          createdAt: now(),
        });
        const revised = await kernel.reviseMemoryProposal(
          TENANT_ID,
          ACTOR_ID,
          mutationKey as string,
          memoryId,
          expectedVersion(body),
          { confidence: body.confidence, preparedPayload },
        );
        await erasePayloadKeys(TENANT_ID, ACTOR_ID, `memory:${memoryId}`, mutationKey as string);
        return json(publicMemory(revised, body.value as JsonObject), 200, traceId);
      }
      if (memoryMatch && request.method === "DELETE") {
        const body = await readBody(request);
        const memoryId = decodeURIComponent(memoryMatch[1]!);
        const memory = await options.store.transact(TENANT_ID, (transaction) =>
          transaction.getProjection<MemoryRecord>("memory", memoryId)
          ?? transaction.getProjection<MemoryTombstone>("memoryTombstone", memoryId));
        if (!memory) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, memory.workspaceId, "owner");
        const deleted = await kernel.deleteMemory(
          TENANT_ID,
          ACTOR_ID,
          mutationKey as string,
          memoryId,
          expectedVersion(body),
          stringField(body, "reason")!,
        );
        await erasePayloadKeys(TENANT_ID, ACTOR_ID, `memory:${memoryId}`, mutationKey as string);
        return json(deleted, 200, traceId);
      }
      const revocationMatch = url.pathname.match(/^\/v2\/key-revocations\/([^/]+)\/decisions$/u);
      if (revocationMatch && request.method === "POST") {
        const body = await readBody(request);
        if (body.decision !== "retry" || Object.keys(body).some(key => !["decision", "expectedStreamVersion"].includes(key))) {
          throw new KernelError("INVALID_DECISION", "密钥删除决定无效", "选择重新发起删除");
        }
        const revocationId = decodeURIComponent(revocationMatch[1]!);
        const record = await projectionGet<KeyRevocation>(options.store, TENANT_ID, KEY_REVOCATION_NAMESPACE, revocationId);
        if (!record) throw new KernelError("KEY_REVOCATION_NOT_FOUND", "密钥删除记录不存在", "刷新收件箱");
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, record.workspaceId, "owner");
        await requestKeyRevocationRetry({ store: options.store, tenantId: TENANT_ID, actorId: ACTOR_ID, revocationId,
          expectedStreamVersion: expectedVersion(body), requestId: mutationKey as string, now });
        await drainKeyRevocations({ store: options.store, tenantId: TENANT_ID, actorId: ACTOR_ID, revocationId,
          keyProvider: options.protectedPayloadKeyProvider ?? {}, now });
        const current = (await projectionGet<KeyRevocation>(options.store, TENANT_ID, KEY_REVOCATION_NAMESPACE, revocationId))!;
        return json({ id: current.id, status: current.status, streamVersion: current.streamVersion }, 200, traceId);
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
          store: options.store, tenantId: TENANT_ID, actorId: ACTOR_ID, key: mutationKey as string,
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
        if (body.makeDefault !== undefined && typeof body.makeDefault !== "boolean") {
          throw new KernelError("INVALID_BODY", "makeDefault 必须为布尔值", "刷新模型连接后重试");
        }
        if (body.makeDefault === true) requireOrganizationRole(profile, ORGANIZATION_ROLES, ["organization_admin"]);
        const connection = await idempotentAsyncOperation<ModelConnection>({
          store: options.store, tenantId: TENANT_ID, actorId: ACTOR_ID, key: mutationKey as string,
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
              if (body.makeDefault === true) {
                for (const previous of transaction.listProjections<ModelConnection>("modelConnection")) {
                  if (previous.id === id || !previous.defaultForNewExecutions) continue;
                  transaction.putProjection("modelConnection", previous.id, { ...previous, defaultForNewExecutions: false,
                    streamVersion: previous.streamVersion + 1 });
                  appendKernelEvent(transaction, { tenantId: TENANT_ID, aggregateType: "modelConnection", aggregateId: previous.id,
                    expectedStreamVersion: previous.streamVersion, type: "model_connection.default_cleared", actorId: ACTOR_ID,
                    generation: 0, correlationId: nextId("correlation"), publicPayload: { replacementId: id } });
                }
              }
              const next = {
                ...value, discoveredModels: [...discovered.models], defaultModel: discovered.defaultModel,
                status: "ready" as const, streamVersion: value.streamVersion + 1,
                ...(body.makeDefault === true ? { defaultForNewExecutions: true } : {}),
              };
              transaction.putProjection("modelConnection", id, next);
              appendKernelEvent(transaction, {
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
        const missingInstalledRuntime = !pluginInstaller
          && await options.store.transact(TENANT_ID, (transaction) =>
            transaction.listProjections(PLUGIN_INSTALLATION_PROJECTION).length > 0);
        if (missingInstalledRuntime) {
          throw new PluginPolicyError(
            "PLUGIN_REGISTRY_UNAVAILABLE",
            "该租户已有插件安装态，但当前 Host 缺少已验签运行制品",
            "使用包含相同插件仓库的发布镜像重新部署",
          );
        }
        if (profile === "enterprise") await pluginInstaller?.synchronize?.();
        const installed = await pluginInstaller?.list?.() ?? [];
        return json([...tenantPlugins.listOfficial(), ...installed], 200, traceId);
      }
      if (url.pathname === "/v2/plugins/installations" && request.method === "POST") {
        requireOrganizationRole(profile, ORGANIZATION_ROLES, ["organization_admin", "governance_admin"]);
        if (!pluginInstaller) {
          throw new KernelError("PLUGIN_REGISTRY_UNAVAILABLE", "插件仓库暂不可用", "检查签名仓库连接");
        }
        const body = await readBody(request);
        const result = await idempotentAsyncOperation({
          store: options.store, tenantId: TENANT_ID, actorId: ACTOR_ID, key: mutationKey as string,
          scope: "http.plugin.install", request: body, now, inFlight: inFlightAsyncMutations,
          work: () => pluginInstaller!.install(body, {
            idempotencyKey: mutationKey as string,
            idempotencyScope: "http.plugin.install",
            actorId: ACTOR_ID,
          }),
        });
        return json(result, 201, traceId);
      }
      const pluginInstallationMatch = url.pathname.match(/^\/v2\/plugins\/installations\/([^/]+)$/u);
      if (pluginInstallationMatch && request.method === "PATCH") {
        requireOrganizationRole(profile, ORGANIZATION_ROLES, ["organization_admin", "governance_admin"]);
        if (!pluginInstaller?.update) {
          throw new KernelError("PLUGIN_REGISTRY_UNAVAILABLE", "插件更新暂不可用", "检查签名仓库连接");
        }
        const pluginId = decodeURIComponent(pluginInstallationMatch[1]!);
        const body = await readBody(request);
        const result = await idempotentAsyncOperation({
          store: options.store,
          tenantId: TENANT_ID,
          key: mutationKey as string, actorId: ACTOR_ID,
          scope: `http.plugin.update:${pluginId}`,
          request: body,
          now,
          inFlight: inFlightAsyncMutations,
          work: () => pluginInstaller!.update!(pluginId, body, {
            idempotencyKey: mutationKey as string,
            idempotencyScope: `http.plugin.update:${pluginId}`,
            actorId: ACTOR_ID,
          }),
        });
        return json(result, 200, traceId);
      }
      const pluginDisableMatch = url.pathname.match(/^\/v2\/plugins\/installations\/([^/]+)\/disable$/u);
      if (pluginDisableMatch && request.method === "POST") {
        requireOrganizationRole(profile, ORGANIZATION_ROLES, ["organization_admin", "governance_admin"]);
        if (!pluginInstaller?.disable) {
          throw new KernelError("PLUGIN_REGISTRY_UNAVAILABLE", "插件停用暂不可用", "检查签名仓库连接");
        }
        const pluginId = decodeURIComponent(pluginDisableMatch[1]!);
        const body = await readBody(request);
        const scope = `http.plugin.disable:${pluginId}`;
        const result = await idempotentAsyncOperation({
          store: options.store,
          tenantId: TENANT_ID,
          key: mutationKey as string, actorId: ACTOR_ID,
          scope,
          request: body,
          now,
          inFlight: inFlightAsyncMutations,
          work: () => pluginInstaller!.disable!(pluginId, body, {
            idempotencyKey: mutationKey as string,
            idempotencyScope: scope,
            actorId: ACTOR_ID,
          }),
        });
        return json(result, 200, traceId);
      }
      if (pluginInstallationMatch && request.method === "DELETE") {
        requireOrganizationRole(profile, ORGANIZATION_ROLES, ["organization_admin", "governance_admin"]);
        if (!pluginInstaller?.purge) {
          throw new KernelError("PLUGIN_REGISTRY_UNAVAILABLE", "插件清除暂不可用", "检查签名仓库连接");
        }
        const pluginId = decodeURIComponent(pluginInstallationMatch[1]!);
        const body = await readBody(request);
        const scope = `http.plugin.purge:${pluginId}`;
        const result = await idempotentAsyncOperation({
          store: options.store,
          tenantId: TENANT_ID,
          key: mutationKey as string, actorId: ACTOR_ID,
          scope,
          request: body,
          now,
          inFlight: inFlightAsyncMutations,
          work: () => pluginInstaller!.purge!(pluginId, body, {
            idempotencyKey: mutationKey as string,
            idempotencyScope: scope,
            actorId: ACTOR_ID,
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
          store: options.store, tenantId: TENANT_ID, actorId: ACTOR_ID, key: mutationKey as string,
          scope: `http.plugin.activate:${workspaceId}`, request: body, now, inFlight: inFlightAsyncMutations,
          work: () => withPluginUse(tenantRuntime, pluginId, "activation", ACTOR_ID, async () => {
            const current = await projectionGet<Workspace>(options.store, TENANT_ID, "workspace", workspaceId);
            if (!current) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
            if (current.streamVersion !== expected) throw new KernelStreamVersionConflictError(expected, current.streamVersion);
            try {
              if (!officialPluginIds.has(pluginId)) {
                await pluginInstaller?.activate?.(pluginId, { actorId: ACTOR_ID });
              }
              await tenantPlugins.activate(pluginWorkspaceKey(workspaceId), pluginId);
              return await options.store.transact(TENANT_ID, (transaction) => {
              const value = transaction.getProjection<Workspace>("workspace", workspaceId)!;
              if (value.streamVersion !== expected) throw new KernelStreamVersionConflictError(expected, value.streamVersion);
              const activePluginIds = value.activePluginIds.includes(pluginId)
                ? value.activePluginIds : [...value.activePluginIds, pluginId];
              const next = { ...value, activePluginIds, streamVersion: value.streamVersion + 1, updatedAt: now() };
              transaction.putProjection("workspace", workspaceId, next);
              appendKernelEvent(transaction, {
                tenantId: TENANT_ID, aggregateType: "workspace", aggregateId: workspaceId,
                expectedStreamVersion: expected, type: "workspace.plugin_activated", actorId: ACTOR_ID,
                generation: 0, correlationId: nextId("correlation"), publicPayload: { pluginId },
              });
              return next;
              });
            } catch (error) {
              await tenantPlugins.deactivate(pluginWorkspaceKey(workspaceId), pluginId);
              throw error;
            }
          }),
        });
        return json(workspace, 200, traceId);
      }
      const deactivationMatch = url.pathname.match(
        /^\/v2\/workspaces\/([^/]+)\/plugin-activations\/([^/]+)$/u,
      );
      if (deactivationMatch && request.method === "DELETE") {
        const body = await readBody(request);
        const workspaceId = decodeURIComponent(deactivationMatch[1]!);
        const pluginId = decodeURIComponent(deactivationMatch[2]!);
        await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "owner");
        const expected = expectedVersion(body);
        const scope = pluginWorkspaceKey(workspaceId);
        const workspace = await idempotentAsyncOperation<Workspace>({
          store: options.store,
          tenantId: TENANT_ID,
          key: mutationKey as string, actorId: ACTOR_ID,
          scope: `http.plugin.deactivate:${workspaceId}:${pluginId}`,
          request: body,
          now,
          inFlight: inFlightAsyncMutations,
          work: async () => {
            const current = await projectionGet<Workspace>(options.store, TENANT_ID, "workspace", workspaceId);
            if (!current) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
            if (current.streamVersion !== expected) {
              throw new KernelStreamVersionConflictError(expected, current.streamVersion);
            }
            if (!current.activePluginIds.includes(pluginId)) {
              throw new PluginPolicyError(
                "PLUGIN_NOT_ACTIVE",
                `工作区未启用插件 ${pluginId}`,
                "刷新工作区插件列表",
              );
            }
            const hookWasActive = tenantPlugins.activeWorkspaceIds(pluginId).includes(scope);
            await tenantPlugins.deactivate(scope, pluginId).catch(() => undefined);
            try {
              return await options.store.transact(TENANT_ID, (transaction) => {
                const value = transaction.getProjection<Workspace>("workspace", workspaceId);
                if (!value) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
                if (value.streamVersion !== expected) {
                  throw new KernelStreamVersionConflictError(expected, value.streamVersion);
                }
                const next: Workspace = {
                  ...value,
                  activePluginIds: value.activePluginIds.filter((id) => id !== pluginId),
                  streamVersion: value.streamVersion + 1,
                  updatedAt: now(),
                };
                transaction.putProjection("workspace", workspaceId, next);
                appendKernelEvent(transaction, {
                  tenantId: TENANT_ID,
                  aggregateType: "workspace",
                  aggregateId: workspaceId,
                  expectedStreamVersion: expected,
                  type: "workspace.plugin_deactivated",
                  actorId: ACTOR_ID,
                  generation: 0,
                  correlationId: nextId("correlation"),
                  publicPayload: { pluginId, reason: "workspace_request" },
                });
                return next;
              });
            } catch (error) {
              if (hookWasActive) await tenantPlugins.activate(scope, pluginId).catch(() => undefined);
              throw error;
            }
          },
        });
        return json(workspace, 200, traceId);
      }
      if (url.pathname === "/v2/plugins/coding/runners" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) {
          throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        }
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "view");
        if (!workspace.activePluginIds.includes("coding")) {
          throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用 Coding", "先启用 Coding 插件");
        }
        return json(await listCodingRunners(options.store, TENANT_ID, workspaceId), 200, traceId);
      }
      const runnerInspectionMatch = url.pathname.match(
        /^\/v2\/plugins\/coding\/runners\/([^/]+)\/inspections$/u,
      );
      if (runnerInspectionMatch && request.method === "POST") {
        const body = await readBody(request);
        if (Object.keys(body).some((field) => !["workspaceId", "binaryPath"].includes(field))) {
          throw new KernelError("INVALID_BODY", "Runner 检查请求包含不支持的字段", "按 OpenAPI 重新提交");
        }
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "owner");
        if (!workspace.activePluginIds.includes("coding")) {
          throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用 Coding", "先启用 Coding 插件");
        }
        const runnerId = parseExternalCodingRunnerId(decodeURIComponent(runnerInspectionMatch[1]!));
        await requireRunnerPluginTool(TENANT_ID, workspace, runnerId);
        const identity = await idempotentAsyncOperation({
          actorId: ACTOR_ID,
          store: options.store,
          tenantId: TENANT_ID,
          key: mutationKey as string,
          scope: `coding.runner.inspect:${workspaceId}:${runnerId}`,
          request: body,
          now,
          inFlight: inFlightAsyncMutations,
          work: () => inspectCodingRunner(
            runnerIdentityInspector,
            runnerId,
            stringField(body, "binaryPath")!,
          ),
        });
        return json(identity, 200, traceId);
      }
      const runnerConfirmationMatch = url.pathname.match(
        /^\/v2\/plugins\/coding\/runners\/([^/]+)\/confirmations$/u,
      );
      if (runnerConfirmationMatch && request.method === "POST") {
        const body = await readBody(request);
        if (Object.keys(body).some((field) => ![
          "workspaceId", "expectedStreamVersion", "binaryPath", "version", "sha256",
        ].includes(field))) {
          throw new KernelError("INVALID_BODY", "Runner 确认请求包含不支持的字段", "按 OpenAPI 重新提交");
        }
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "owner");
        if (!workspace.activePluginIds.includes("coding")) {
          throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用 Coding", "先启用 Coding 插件");
        }
        const runnerId = parseExternalCodingRunnerId(decodeURIComponent(runnerConfirmationMatch[1]!));
        await requireRunnerPluginTool(TENANT_ID, workspace, runnerId);
        const scope = `coding.runner.confirm:${workspaceId}:${runnerId}`;
        const requestDigest = sha256(body);
        const replay = await options.store.transact(TENANT_ID, (transaction) =>
          transaction.getIdempotency(scope, mutationKey as string));
        if (replay) {
          if (replay.requestDigest !== requestDigest) {
            throw new KernelError(
              "IDEMPOTENCY_KEY_REUSED",
              "幂等键已用于不同请求",
              "使用新的 Idempotency-Key",
            );
          }
          return json(replay.response, 200, traceId);
        }
        const inspection = await inspectCodingRunner(
          runnerIdentityInspector,
          runnerId,
          stringField(body, "binaryPath")!,
        );
        const configuration = await idempotentProjectionMutation({
          store: options.store,
          tenantId: TENANT_ID,
          key: mutationKey as string,
          scope,
          request: body,
          now,
          work: (transaction) => confirmCodingRunner({
            transaction,
            tenantId: TENANT_ID,
            workspaceId,
            actorId: ACTOR_ID,
            runnerId,
            expectedStreamVersion: expectedVersion(body),
            expectedVersion: stringField(body, "version")!,
            expectedSha256: stringField(body, "sha256")!,
            inspection,
            occurredAt: now(),
            correlationId: nextId("correlation"),
          }),
        });
        return json(configuration, 200, traceId);
      }
      const codingReconciliationViewMatch = url.pathname.match(
        /^\/v2\/plugins\/coding\/executions\/([^/]+)\/reconciliation$/u,
      );
      if (codingReconciliationViewMatch && request.method === "GET") {
        const executionId = decodeURIComponent(codingReconciliationViewMatch[1]!);
        return json(await getCodingReconciliation(
          options.store,
          TENANT_ID,
          ACTOR_ID,
          executionId,
          reconciliationVerificationReadiness(),
          resolveCodingNewCallRuntimeReadiness,
        ), 200, traceId);
      }
      const codingReconciliationMatch = url.pathname.match(
        /^\/v2\/plugins\/coding\/executions\/([^/]+)\/reconciliation-decisions$/u,
      );
      if (codingReconciliationMatch && request.method === "POST") {
        const body = await readBody(request);
        if (Object.keys(body).some((field) => ![
          "expectedStreamVersion", "expectedCodingStreamVersion", "decision",
        ].includes(field))) {
          throw new KernelError("INVALID_BODY", "人工核对请求包含不支持的字段", "按 OpenAPI 重新提交");
        }
        const decision = stringField(body, "decision") as CodingReconciliationDecision;
        if (decision !== "terminate"
          && decision !== "mark_completed"
          && decision !== "create_new_call") {
          throw new KernelError(
            "INVALID_DECISION",
            "人工核对决定无效",
            "选择 terminate、mark_completed 或 create_new_call",
          );
        }
        const executionId = decodeURIComponent(codingReconciliationMatch[1]!);
        const expectedStreamVersion = expectedVersion(body);
        const expectedCodingStreamVersion = expectedCodingVersion(body);
        const reconciliationScope = `coding.reconciliation:${executionId}`;
        const reconciliationRequest = {
          executionId,
          expectedStreamVersion,
          expectedCodingStreamVersion,
          decision,
        };
        const replay = await options.store.transact(TENANT_ID, (transaction) =>
          transaction.getIdempotency(reconciliationScope, mutationKey as string));
        if (replay) {
          if (replay.requestDigest !== sha256(reconciliationRequest)) {
            throw new KernelError(
              "IDEMPOTENCY_KEY_REUSED",
              "幂等键已用于不同请求",
              "使用新的 Idempotency-Key",
            );
          }
          const replayStatus = (replay.response as { status?: unknown }).status
            === "verification_pending" ? 202 : 200;
          return json(replay.response, replayStatus, traceId);
        }
        const detail = await getCodingReconciliation(
          options.store,
          TENANT_ID,
          ACTOR_ID,
          executionId,
          reconciliationVerificationReadiness(),
          resolveCodingNewCallRuntimeReadiness,
        );
        const result = await decideCodingReconciliation(options.store, {
          tenantId: TENANT_ID,
          actorId: ACTOR_ID,
          idempotencyKey: mutationKey as string,
          executionId,
          expectedStreamVersion,
          expectedCodingStreamVersion,
          decision,
          verificationReadiness: reconciliationVerificationReadiness(),
          newCallRuntimeReadiness: detail.newCall,
          now,
          id: nextId,
        });
        return json(result, result.status === "verification_pending" ? 202 : 200, traceId);
      }
      if (url.pathname === "/v2/plugins/opc/opportunities" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        return json(await listOpportunitySummaries(options.store, TENANT_ID, workspaceId), 200, traceId);
      }
      const opcOpportunityMatch = url.pathname.match(/^\/v2\/plugins\/opc\/opportunities\/([^/]+)$/u);
      if (opcOpportunityMatch && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        const opportunity = await opcService.get(
          encodePluginWorkspace(TENANT_ID, workspaceId),
          decodeURIComponent(opcOpportunityMatch[1]!),
        );
        if (!opportunity) throw new KernelError("NOT_FOUND", "机会不存在", "刷新机会列表");
        const hydrated = await hydrateOpcOpportunity({
          store: options.store,
          tenantId: TENANT_ID,
          workspaceId,
          opportunity,
          ...(options.cas ? { cas: options.cas } : {}),
          ...(options.protectedPayloadKeyProvider
            ? { protectedPayloadKeyProvider: options.protectedPayloadKeyProvider }
            : {}),
        });
        return json(hydrated.opportunity, 200, traceId);
      }
      const opcCommandMatch = url.pathname.match(/^\/v2\/plugins\/opc\/opportunities\/([^/]+)\/commands$/u);
      if (opcCommandMatch && request.method === "POST") {
        const body = await readBody(request);
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        const sourceOptions = {
          store: options.store,
          tenantId: TENANT_ID,
          workspaceId,
          ...(options.cas ? { cas: options.cas } : {}),
          ...(options.protectedPayloadKeyProvider
            ? { protectedPayloadKeyProvider: options.protectedPayloadKeyProvider }
            : {}),
        };
        const current = await opcService.get(
          encodePluginWorkspace(TENANT_ID, workspaceId),
          decodeURIComponent(opcCommandMatch[1]!),
        );
        if (!current) throw new KernelError("NOT_FOUND", "机会不存在", "刷新机会列表");
        await hydrateOpcOpportunity({ ...sourceOptions, opportunity: current });
        await validateOpcCommandSources({
          ...sourceOptions,
          command: stringField(body, "command")!,
          input: body.input,
        });
        const updated = await executeOpcCommand({
          service: opcService,
          scopedWorkspaceId: encodePluginWorkspace(TENANT_ID, workspaceId),
          opportunityId: decodeURIComponent(opcCommandMatch[1]!),
          expectedStreamVersion: expectedVersion(body),
          actorId: ACTOR_ID,
          command: stringField(body, "command")!,
          input: body.input,
          idempotencyKey: mutationKey as string,
          idempotencyRequest: body,
        });
        const hydrated = await hydrateOpcOpportunity({ ...sourceOptions, opportunity: updated });
        return json(hydrated.opportunity, 200, traceId);
      }
      const opcDeliverablesMatch = url.pathname.match(
        /^\/v2\/plugins\/opc\/opportunities\/([^/]+)\/deliverables$/u,
      );
      if (opcDeliverablesMatch && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        const opportunity = await opcService.get(
          encodePluginWorkspace(TENANT_ID, workspaceId),
          decodeURIComponent(opcDeliverablesMatch[1]!),
        );
        if (!opportunity) throw new KernelError("NOT_FOUND", "机会不存在", "刷新机会列表");
        const hydrated = await hydrateOpcOpportunity({
          store: options.store,
          tenantId: TENANT_ID,
          workspaceId,
          opportunity,
          ...(options.cas ? { cas: options.cas } : {}),
          ...(options.protectedPayloadKeyProvider
            ? { protectedPayloadKeyProvider: options.protectedPayloadKeyProvider }
            : {}),
        });
        return json(exportOpportunityDeliverables(opportunity, {
          interviewRawRecords: hydrated.interviewRawRecords,
        }), 200, traceId);
      }
      const opcExportMatch = url.pathname.match(/^\/v2\/plugins\/opc\/opportunities\/([^/]+)\/exports$/u);
      if (opcExportMatch && request.method === "POST") {
        const body = await readBody(request);
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        const opportunityId = decodeURIComponent(opcExportMatch[1]!);
        const opportunity = await opcService.get(encodePluginWorkspace(TENANT_ID, workspaceId), opportunityId);
        if (!opportunity) throw new KernelError("NOT_FOUND", "机会不存在", "刷新机会列表");
        const hydrated = await hydrateOpcOpportunity({
          store: options.store,
          tenantId: TENANT_ID,
          workspaceId,
          opportunity,
          ...(options.cas ? { cas: options.cas } : {}),
          ...(options.protectedPayloadKeyProvider
            ? { protectedPayloadKeyProvider: options.protectedPayloadKeyProvider }
            : {}),
        });
        const rendered = exportOpportunityDeliverables(opportunity, {
          interviewRawRecords: hydrated.interviewRawRecords,
        });
        const stored = await exportOpcOpportunity({
          store: options.store,
          tenantId: TENANT_ID,
          workspaceId,
          opportunityId,
          actorId: ACTOR_ID,
          idempotencyKey: mutationKey as string,
          expectedStreamVersion: expectedVersion(body),
          now,
          id: nextId,
        });
        return json(stored.map((item) => ({
          ...item,
          content: rendered.find((candidate) => candidate.kind === item.kind)?.content ?? item.content,
        })), 201, traceId);
      }
      if (url.pathname === "/v2/plugins/coding/repositories" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        if (!workspace.activePluginIds.includes("coding")) throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用 Coding", "先启用 Coding 插件");
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        return json(await listCodingRepositories(options.store, TENANT_ID, workspaceId), 200, traceId);
      }
      if (url.pathname === "/v2/plugins/coding/tasks" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId");
        if (!workspaceId) throw new KernelError("INVALID_BODY", "缺少 workspaceId", "选择工作区后重试");
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId);
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        return json(await listCodingTaskSummaries(options.store, TENANT_ID, workspaceId), 200, traceId);
      }
      const productCapture = url.pathname.match(/^\/v2\/plugins\/(opc|coding)\/(opportunities|repositories|tasks)$/u);
      if (productCapture && request.method === "POST") {
        const pluginId = productCapture[1] as "opc" | "coding";
        const resource = productCapture[2]!;
        if ((pluginId === "opc" && resource !== "opportunities")
          || (pluginId === "coding" && resource === "opportunities")) return notFound(traceId);
        const body = await readBody(request);
        const fields = ["workspaceId", "expectedStreamVersion", "input", ...(pluginId === "coding" && resource === "tasks" ? ["repositoryId"] : [])];
        if (Object.keys(body).some(field => !fields.includes(field))) {
          throw new KernelError("INVALID_BODY", "请求包含未声明的字段", "仅提交当前插件接口声明的字段");
        }
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
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
            : await captureCodingTask({ ...common, repositoryId: stringField(body, "repositoryId", false) });
        return json(result, 201, traceId);
      }
      const sampleMatch = url.pathname.match(/^\/v2\/plugins\/(opc|coding)\/samples\/read-only$/u);
      if (sampleMatch && request.method === "POST") {
        const body = await readBody(request);
        const workspaceId = stringField(body, "workspaceId")!;
        const workspace = await authorizedWorkspace(options.store, TENANT_ID, ACTOR_ID, workspaceId, "operate");
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
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
        await ensurePluginsActive(TENANT_ID, workspace, tenantRuntime, ACTOR_ID);
        const pluginId = decodeURIComponent(pluginMatch[1]!);
        const commandId = decodeURIComponent(pluginMatch[2]!);
        const commandInput = Object.fromEntries(Object.entries(body)
          .filter(([key]) => key !== "workspaceId")) as JsonObject;
        const result = await idempotentAsyncOperation({
          store: options.store, tenantId: TENANT_ID, actorId: ACTOR_ID, key: mutationKey as string,
          scope: `http.plugin.command:${workspaceId}:${pluginId}:${commandId}`, request: body, now,
          inFlight: inFlightAsyncMutations,
          work: () => withPluginUse(tenantRuntime, pluginId, "execution", ACTOR_ID, async () => {
            if (!officialPluginIds.has(pluginId)) pluginInstaller?.assertCanStartExecution?.(pluginId);
            return tenantPlugins.runCommand(
              pluginWorkspaceKey(workspaceId), pluginId, commandId, commandInput, ACTOR_ID,
              !officialPluginIds.has(pluginId) && tenantRuntime.dataManager ? createPluginDataPort({ store: options.store,
                tenantId: TENANT_ID, workspaceId, pluginId, actorId: ACTOR_ID, commandId, idempotencyKey: mutationKey as string,
                manager: tenantRuntime.dataManager, now, ...(options.cas && options.protectedPayloadKeyProvider
                  ? { protection: { cas: options.cas, keyProvider: options.protectedPayloadKeyProvider } } : {}) }) : undefined,
            );
          }),
        });
        return json(result, 200, traceId);
      }
      return notFound(traceId);
    } catch (error) {
      return safeError(error, traceId);
    }
  };

  let revocationTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryStopped = false;
  let revocationRecovery = Promise.resolve();
  const recoverRevocations = async () => {
    const tenantIds = options.store.listTenantIds ? await options.store.listTenantIds() : [LOCAL_TENANT_ID];
    for (const tenantId of tenantIds) {
      if (recoveryStopped) return;
      await drainKeyRevocations({ store: options.store, tenantId, now, keyProvider: options.protectedPayloadKeyProvider! });
    }
  };
  const scheduleRevocationRecovery = () => {
    if (recoveryStopped || !protectedJournal) return;
    revocationTimer = setTimeout(() => {
      revocationRecovery = recoverRevocations().catch(() => { /* A failed inspection cannot acknowledge erasure. */ })
        .finally(scheduleRevocationRecovery);
    }, 30_000);
    revocationTimer.unref?.();
  };
  if (protectedJournal) {
    await recoverRevocations().catch(() => { /* Core services stay available when key storage is unavailable. */ });
    scheduleRevocationRecovery();
  }

  let pluginRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let pluginRefresh = Promise.resolve();
  const schedulePluginRefresh = () => {
    if (recoveryStopped) return;
    pluginRefreshTimer = setTimeout(() => {
      pluginRefresh = (async () => {
        for (const pending of tenantRuntimes.values()) {
          if (recoveryStopped) return;
          const runtime = await pending.catch(() => undefined);
          await runtime?.installer?.synchronize?.().catch(() => {});
        }
      })().finally(schedulePluginRefresh);
    }, 30_000);
    pluginRefreshTimer.unref?.();
  };
  schedulePluginRefresh();

  return {
    context,
    kernel,
    plugins,
    dispatch,
    async listen({ host = "127.0.0.1", port }) {
      if (server) throw new Error("Host 已启动");
      server = createServer({ requestTimeout: 60_000, headersTimeout: 10_000, keepAliveTimeout: 5000,
        maxHeaderSize: 16 * 1024, connectionsCheckingInterval: 1000 }, async (incoming, outgoing) => {
        outgoing.once("finish", () => { if (!incoming.complete) incoming.destroy(); });
        try {
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
        const iterator = incoming.iterator({ destroyOnReturn: false });
        const body = ["GET", "HEAD"].includes(incoming.method ?? "GET") ? undefined : new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) controller.close(); else controller.enqueue(Buffer.from(next.value));
            } catch (error) { controller.error(error); }
          },
          cancel() { void iterator.return?.().catch(() => undefined); },
        });
        const address = `http://${incoming.headers.host ?? `${host}:${port}`}${incoming.url ?? "/"}`;
        const request = new Request(address, {
          method: incoming.method,
          headers: incoming.headers as HeadersInit,
          ...(body ? { body, duplex: "half" } : {}),
        } as RequestInit & { duplex?: "half" });
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
        } catch (error) {
          if (outgoing.destroyed) return;
          if (outgoing.headersSent) { outgoing.destroy(); return; }
          const failure = safeError(error, randomUUID());
          outgoing.writeHead(failure.status, Object.fromEntries(failure.headers));
          outgoing.end(await failure.text());
        }
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
        recoveryStopped = true;
        if (revocationTimer) clearTimeout(revocationTimer);
        if (pluginRefreshTimer) clearTimeout(pluginRefreshTimer);
        await pluginRefresh;
        await revocationRecovery;
        for (const closeStream of [...activeEventStreams]) closeStream();
        if (server) {
          if (server.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
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
  } catch (error) {
    await context.fiber.dispose();
    throw error;
  }
}

export type { InboxItem };
