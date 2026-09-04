import { randomUUID } from "node:crypto";

import type {
  Execution,
  ExecutionAuthority,
  JsonObject,
  JsonValue,
  Thread,
} from "@mn/contracts";
import {
  AgentHandle,
  AgentScope,
  KernelProjectionRuntimeStore,
  type AgentHandleOptions,
  type Awaitable,
  type RuntimeProjectionStore,
} from "@mn/agent-runtime";
import { AgentOsKernel, type KernelStore } from "@mn/kernel";
import {
  JOB_LEASE_MILLISECONDS,
  StaleFencingTokenError,
  type JobClaimOptions,
  type NeedsReconciliationInput,
  type StoredJob,
} from "@mn/storage";
import {
  createByokModelInvoker,
  ModelTransportError,
  type ByokModelInvoker,
  type ByokProviderId,
} from "./model-invoker.js";
import { createKernelToolApprovalPort, type ToolApprovalKernel } from "./approval.js";
import {
  CodingWorkerOutcomeError,
  createCodingExecutionWorkerHandler,
} from "./coding.js";
export * from "./approval.js";
export * from "./coding.js";

export * from "./model-invoker.js";

export const WORKER_LEASE_MILLISECONDS = JOB_LEASE_MILLISECONDS;

export interface WorkerLockState {
  readonly engineLockDigest: string;
  readonly expectedEngineLockDigest: string;
  readonly pluginLockDigest: string;
  readonly expectedPluginLockDigest: string;
}

export interface WorkerReadinessIssue {
  readonly code: "ENGINE_LOCK_MISMATCH" | "PLUGIN_LOCK_MISMATCH";
  readonly message: string;
  readonly action: string;
}

export function workerReadiness(lock: WorkerLockState): {
  readonly ready: boolean;
  readonly issues: readonly WorkerReadinessIssue[];
} {
  const issues: WorkerReadinessIssue[] = [];
  if (lock.engineLockDigest !== lock.expectedEngineLockDigest) {
    issues.push({
      code: "ENGINE_LOCK_MISMATCH",
      message: "Worker 与 Host 的 engine lock 不一致",
      action: "使用同一发布物重新部署 Worker",
    });
  }
  if (lock.pluginLockDigest !== lock.expectedPluginLockDigest) {
    issues.push({
      code: "PLUGIN_LOCK_MISMATCH",
      message: "Worker 与 Host 的 plugin lock 不一致",
      action: "同步插件 lock 后重新部署 Worker",
    });
  }
  return { ready: issues.length === 0, issues };
}

export interface WorkerJobStore {
  claimJob(workerId: string, now: string, options?: JobClaimOptions): Promise<StoredJob | undefined>;
  completeJob(jobId: string, workerId: string, fencingToken: number, result: JsonValue, now: string): Promise<void>;
  failJob(jobId: string, workerId: string, fencingToken: number, failure: JsonObject, now: string): Promise<void>;
  interruptJob(jobId: string, workerId: string, fencingToken: number, reason: string, now: string): Promise<void>;
  renewJobLease(jobId: string, workerId: string, fencingToken: number, now: string): Promise<void>;
  markNeedsReconciliation(executionId: string, input: NeedsReconciliationInput): Promise<void>;
}

export interface WorkerJobContext {
  readonly workerId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly signal: AbortSignal;
}

export type WorkerJobHandler = (job: StoredJob, context: WorkerJobContext) => Promise<JsonValue>;

export class UnknownExternalSideEffectError extends Error {
  readonly code = "UNKNOWN_EXTERNAL_SIDE_EFFECT";

  constructor(readonly executionId: string) {
    super("外部副作用结果未知，需要人工核对");
    this.name = "UnknownExternalSideEffectError";
  }
}

export class AgentExecutionInterruptedError extends Error {
  constructor(readonly executionId: string) {
    super("Agent turn 已中断，需要显式恢复");
    this.name = "AgentExecutionInterruptedError";
  }
}

export class AgentExecutionCancelledError extends Error {
  constructor(readonly executionId: string) {
    super("Agent turn 已由用户取消");
    this.name = "AgentExecutionCancelledError";
  }
}

class WorkerLeaseLostError extends Error {
  constructor(options?: ErrorOptions) {
    super("Worker 无法续租，已停止当前处理", options);
    this.name = "WorkerLeaseLostError";
  }
}

export type WorkerPollResult =
  | { readonly status: "not_ready"; readonly issues: readonly WorkerReadinessIssue[] }
  | { readonly status: "idle" }
  | { readonly status: "completed" | "failed" | "cancelled" | "interrupted" | "needs_reconciliation" | "lost_lease"; readonly jobId: string };

export interface AgentOsWorkerOptions {
  readonly id: string;
  readonly store: WorkerJobStore;
  readonly lock: WorkerLockState;
  readonly handlers: Readonly<Record<string, WorkerJobHandler>>;
  readonly tenantId?: string;
  readonly kinds?: readonly string[];
  readonly now?: () => Date;
  readonly leaseRenewIntervalMs?: number;
}

function safeFailure(code: string, message: string, retryable: boolean): JsonObject {
  return { code, message, retryable };
}

export class AgentOsWorker {
  readonly #id: string;
  readonly #store: WorkerJobStore;
  readonly #lock: WorkerLockState;
  readonly #handlers: Readonly<Record<string, WorkerJobHandler>>;
  readonly #claimOptions: JobClaimOptions;
  readonly #now: () => Date;
  readonly #leaseRenewIntervalMs: number;

  constructor(options: AgentOsWorkerOptions) {
    if (!options.id.trim()) throw new TypeError("Worker id 不能为空");
    this.#id = options.id;
    this.#store = options.store;
    this.#lock = options.lock;
    this.#handlers = options.handlers;
    this.#claimOptions = {
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      ...(options.kinds ? { kinds: options.kinds } : {}),
    };
    this.#now = options.now ?? (() => new Date());
    this.#leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? Math.floor(WORKER_LEASE_MILLISECONDS / 3);
    if (!Number.isInteger(this.#leaseRenewIntervalMs) || this.#leaseRenewIntervalMs < 1
      || this.#leaseRenewIntervalMs >= WORKER_LEASE_MILLISECONDS) {
      throw new TypeError("租约续期间隔必须小于 30 秒");
    }
  }

  readiness() {
    return workerReadiness(this.#lock);
  }

  async pollOnce(stopSignal?: AbortSignal): Promise<WorkerPollResult> {
    const readiness = this.readiness();
    if (!readiness.ready) return { status: "not_ready", issues: readiness.issues };
    if (stopSignal?.aborted) return { status: "idle" };
    const claimedAt = this.#now();
    const job = await this.#store.claimJob(this.#id, claimedAt.toISOString(), this.#claimOptions);
    if (!job) return { status: "idle" };
    const handler = this.#handlers[job.kind];
    if (!handler) return this.#failKnown(job, "JOB_HANDLER_NOT_FOUND", "没有可处理此任务的 Worker", false);
    const leaseExpiresAt = job.leaseExpiresAt
      ?? new Date(claimedAt.getTime() + WORKER_LEASE_MILLISECONDS).toISOString();
    const abort = new AbortController();
    const stopCurrentJob = () => abort.abort(stopSignal?.reason ?? "Worker 正在停止");
    stopSignal?.addEventListener("abort", stopCurrentJob, { once: true });
    if (stopSignal?.aborted) stopCurrentJob();
    let renewalTimer: ReturnType<typeof setInterval> | undefined;
    let rejectLease: ((error: unknown) => void) | undefined;
    const leaseLost = new Promise<never>((_resolve, reject) => { rejectLease = reject; });
    renewalTimer = setInterval(() => {
      void this.#store.renewJobLease(
        job.id, this.#id, job.fencingToken, this.#now().toISOString(),
      ).catch((error: unknown) => {
        rejectLease?.(new WorkerLeaseLostError({ cause: error }));
        abort.abort();
      });
    }, this.#leaseRenewIntervalMs);
    try {
      const execution = handler(job, {
        workerId: this.#id, fencingToken: job.fencingToken, leaseExpiresAt, signal: abort.signal,
      });
      const result = await Promise.race([execution, leaseLost]);
      await this.#store.completeJob(job.id, this.#id, job.fencingToken, result, this.#now().toISOString());
      return { status: "completed", jobId: job.id };
    } catch (error) {
      if (stopSignal?.aborted) {
        try {
          await this.#store.interruptJob(
            job.id,
            this.#id,
            job.fencingToken,
            "Worker 已停止",
            this.#now().toISOString(),
          );
          return { status: "interrupted", jobId: job.id };
        } catch (interruptError) {
          if (interruptError instanceof StaleFencingTokenError
            || (typeof interruptError === "object" && interruptError !== null
              && "code" in interruptError && interruptError.code === "STALE_FENCING_TOKEN")) {
            return { status: "lost_lease", jobId: job.id };
          }
          throw interruptError;
        }
      }
      if (error instanceof WorkerLeaseLostError
        || error instanceof StaleFencingTokenError
        || (typeof error === "object" && error !== null && "code" in error && error.code === "STALE_FENCING_TOKEN")) {
        abort.abort();
        return { status: "lost_lease", jobId: job.id };
      }
      if (error instanceof UnknownExternalSideEffectError) {
        const occurredAt = this.#now().toISOString();
        try {
          await this.#store.markNeedsReconciliation(error.executionId, {
            jobId: job.id,
            workerId: this.#id,
            fencingToken: job.fencingToken,
            occurredAt,
          });
        } catch (failureError) {
          if (failureError instanceof StaleFencingTokenError
            || (typeof failureError === "object" && failureError !== null
              && "code" in failureError && failureError.code === "STALE_FENCING_TOKEN")) {
            return { status: "lost_lease", jobId: job.id };
          }
          throw failureError;
        }
        return { status: "needs_reconciliation", jobId: job.id };
      }
      if (error instanceof AgentExecutionInterruptedError) {
        try {
          await this.#store.interruptJob(
            job.id,
            this.#id,
            job.fencingToken,
            error.message,
            this.#now().toISOString(),
          );
          return { status: "interrupted", jobId: job.id };
        } catch (interruptError) {
          if (interruptError instanceof StaleFencingTokenError
            || (typeof interruptError === "object" && interruptError !== null
              && "code" in interruptError && interruptError.code === "STALE_FENCING_TOKEN")) {
            return { status: "lost_lease", jobId: job.id };
          }
          throw interruptError;
        }
      }
      if (error instanceof AgentExecutionCancelledError) {
        try {
          await this.#store.failJob(
            job.id,
            this.#id,
            job.fencingToken,
            safeFailure("EXECUTION_CANCELLED", error.message, false),
            this.#now().toISOString(),
          );
          return { status: "cancelled", jobId: job.id };
        } catch (failureError) {
          if (failureError instanceof StaleFencingTokenError
            || (typeof failureError === "object" && failureError !== null
              && "code" in failureError && failureError.code === "STALE_FENCING_TOKEN")) {
            return { status: "lost_lease", jobId: job.id };
          }
          throw failureError;
        }
      }
      const message = error instanceof Error ? error.message : "任务执行失败";
      return this.#failKnown(job, "JOB_EXECUTION_FAILED", message, true);
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
      stopSignal?.removeEventListener("abort", stopCurrentJob);
    }
  }

  async #failKnown(job: StoredJob, code: string, message: string, retryable: boolean): Promise<WorkerPollResult> {
    try {
      await this.#store.failJob(
        job.id, this.#id, job.fencingToken,
        safeFailure(code, message, retryable), this.#now().toISOString(),
      );
      return { status: "failed", jobId: job.id };
    } catch (error) {
      if (error instanceof StaleFencingTokenError) return { status: "lost_lease", jobId: job.id };
      throw error;
    }
  }
}

export interface WorkerLoopOptions {
  readonly signal: AbortSignal;
  readonly idleDelayMs?: number;
  readonly onResult?: (result: WorkerPollResult) => Awaitable<void>;
}

export async function runWorkerLoop(
  worker: AgentOsWorker,
  options: WorkerLoopOptions,
): Promise<void> {
  const idleDelayMs = options.idleDelayMs ?? 250;
  if (!Number.isSafeInteger(idleDelayMs) || idleDelayMs < 1) {
    throw new TypeError("Worker 空闲轮询间隔必须是正整数毫秒");
  }
  while (!options.signal.aborted) {
    const result = await worker.pollOnce(options.signal);
    await options.onResult?.(result);
    if (options.signal.aborted) break;
    if (result.status === "idle" || result.status === "not_ready") {
      await abortableDelay(idleDelayMs, options.signal);
    }
  }
}

export async function runWorkerMain(
  workerOptions: AgentOsWorkerOptions,
  loopOptions: WorkerLoopOptions,
): Promise<void> {
  await runWorkerLoop(new AgentOsWorker(workerOptions), loopOptions);
}

export interface AgentTurnHandlerOptions {
  readonly resolveOptions: (
    job: StoredJob,
    context: WorkerJobContext,
  ) => Awaitable<AgentHandleOptions>;
  readonly observeControl?: (
    handle: AgentHandle,
    job: StoredJob,
    context: WorkerJobContext,
  ) => Awaitable<() => Awaitable<void>>;
}

export function createAgentTurnHandler(options: AgentTurnHandlerOptions): WorkerJobHandler {
  return async (job, context) => {
    const executionId = requiredPayloadString(job.payload, "executionId");
    const command = optionalPayloadString(job.payload, "command");
    const isResume = command === "resume";
    if (command !== undefined && !isResume) throw new Error("Agent Job command 无效");
    const message = isResume ? undefined : requiredPayloadString(job.payload, "message");
    const handleOptions = await options.resolveOptions(job, context);
    if (handleOptions.executionId !== executionId) {
      throw new Error("Job 的 executionId 与 Runtime 配置不一致");
    }
    const handle = await AgentHandle.open(handleOptions);
    if (handle.status === "completed") {
      await handleOptions.scope.dispose();
      return { executionId, status: "completed" };
    }
    if (handle.status === "needs_reconciliation") {
      await handleOptions.scope.dispose();
      throw new UnknownExternalSideEffectError(executionId);
    }
    if (handle.status === "paused" || handle.status === "interrupted") {
      if (!isResume) {
        await handleOptions.scope.dispose();
        throw new AgentExecutionInterruptedError(executionId);
      }
    } else if (isResume) {
      await handleOptions.scope.dispose();
      throw new Error(`状态为 ${handle.status} 的 Agent turn 不能恢复`);
    }
    const stopObserving = await options.observeControl?.(handle, job, context);
    const interruptForWorkerStop = () => {
      void handle.interrupt("Worker 已停止").catch(() => {});
    };
    context.signal.addEventListener("abort", interruptForWorkerStop, { once: true });
    try {
      if (context.signal.aborted) {
        await handle.interrupt("Worker 已停止");
      } else if (handle.status === "cancelled") {
        // 控制观察器已持久化取消并中止在途执行。
      } else if (isResume) {
        await handle.resume();
      } else {
        await handle.followUp(message!);
      }
      await handle.whenIdle();
    } catch (error) {
      if (handle.status !== "cancelled") throw error;
    } finally {
      context.signal.removeEventListener("abort", interruptForWorkerStop);
      await stopObserving?.();
      await handleOptions.scope.dispose();
    }
    const finalStatus: string = handle.status;
    if (finalStatus === "needs_reconciliation") {
      throw new UnknownExternalSideEffectError(executionId);
    }
    if (finalStatus === "failed") {
      throw handle.lastError instanceof Error
        ? handle.lastError
        : new Error("Agent turn 执行失败");
    }
    if (finalStatus === "interrupted") throw new AgentExecutionInterruptedError(executionId);
    if (finalStatus === "cancelled") throw new AgentExecutionCancelledError(executionId);
    return { executionId, status: handle.status };
  };
}

function optionalPayloadString(payload: JsonObject, field: string): string | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Job payload 缺少 ${field}`);
  return value;
}

interface StoredModelConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly presetId: string;
  readonly secretRef: string;
  readonly defaultModel: string;
  readonly status: "pending" | "ready" | "invalid";
}

export interface ModelSecretReader {
  read(secretRef: string): Promise<string>;
}

export interface OpcPublicWebReader {
  read(url: string): Promise<unknown>;
}

export interface AgentExecutionStore extends WorkerJobStore, KernelStore {}

export interface KernelAgentTurnHandlerOptions {
  readonly store: AgentExecutionStore;
  readonly secretStore: ModelSecretReader;
  readonly modelInvoker?: ByokModelInvoker;
  readonly approvalKernel?: ToolApprovalKernel;
  readonly approvalPollIntervalMs?: number;
  readonly opcPublicWebReader?: OpcPublicWebReader;
  readonly codingSandboxRoot?: string;
  readonly codingSandboxExecutable?: string;
  readonly controlPollIntervalMs?: number;
  readonly acceptsSecretReference?: (reference: string) => boolean;
  readonly now?: () => string;
}

export function createKernelAgentTurnHandler(
  options: KernelAgentTurnHandlerOptions,
): WorkerJobHandler {
  const invokeModel = options.modelInvoker ?? createByokModelInvoker();
  const acceptsSecretReference = options.acceptsSecretReference ?? (() => true);
  const approvalKernel = options.approvalKernel ?? new AgentOsKernel(options.store, {
    ...(options.now ? { now: options.now } : {}),
    id: (kind) => `${kind}-${randomUUID()}`,
    acceptsModelSecretReference: acceptsSecretReference,
  });
  const controlPollIntervalMs = options.controlPollIntervalMs ?? 100;
  if (!Number.isSafeInteger(controlPollIntervalMs) || controlPollIntervalMs < 1) {
    throw new TypeError("执行控制轮询间隔必须是正整数毫秒");
  }
  const genericHandler = createAgentTurnHandler({
    observeControl: async (handle, job) => observeExecutionControl(
      options.store,
      job.tenantId,
      handle,
      controlPollIntervalMs,
    ),
    resolveOptions: async (job) => {
      const executionId = requiredPayloadString(job.payload, "executionId");
      const state = await options.store.transact(job.tenantId, (transaction) => {
        const execution = transaction.getProjection<Execution>("execution", executionId);
        if (!execution) throw new Error("Execution 不存在");
        const authority = transaction.getProjection<ExecutionAuthority>("authority", execution.authorityId);
        if (!authority) throw new Error("Execution Authority 不存在");
        const thread = transaction.getProjection<Thread>("thread", execution.threadId);
        if (!thread) throw new Error("Thread 不存在");
        const model = transaction.getProjection<StoredModelConnection>(
          "modelConnection",
          execution.modelBindingId,
        );
        if (!model) throw new Error("模型连接不存在");
        return { execution, authority, thread, model };
      });
      assertExecutionState(job, state.execution, state.authority, state.thread, state.model);
      if (!acceptsSecretReference(state.model.secretRef)) {
        throw new Error("模型密钥引用不属于当前运行环境");
      }
      const provider = providerId(state.model.presetId);
      const tenantScope = AgentScope.tenant(job.tenantId, state.execution.generation);
      const executionScope = tenantScope
        .createChild("workspace", state.execution.workspaceId)
        .createChild("thread", state.thread.id)
        .createChild("execution", state.execution.id);
      const promptId = `${state.execution.pluginId}.outcome`;
      const llmId = `byok:${state.model.id}`;
      const hasPublicWebTool = state.execution.pluginId === "opc"
        && state.authority.toolIds.includes("opc.public-web.read")
        && options.opcPublicWebReader !== undefined;
      executionScope.register("prompt", {
        id: promptId,
        render: () => productPrompt(
          state.execution.pluginId,
          state.thread.subject,
          hasPublicWebTool,
        ),
      });
      executionScope.register("llm", {
        id: llmId,
        complete: async (request, context) => {
          let apiKey: string;
          try {
            apiKey = await options.secretStore.read(state.model.secretRef);
          } catch {
            throw new ModelTransportError("无法读取模型凭据");
          }
          try {
            return await invokeModel({
              presetId: provider,
              model: state.model.defaultModel,
              apiKey,
              request,
              signal: context.signal,
            });
          } catch (error) {
            if (error instanceof ModelTransportError) throw error;
            throw new ModelTransportError("模型调用失败");
          }
        },
      });
      const toolIds: string[] = [];
      if (hasPublicWebTool) {
        const toolId = "opc.public-web.read";
        executionScope.register("tool", {
          id: toolId,
          version: "0.2.0",
          effectClass: "external_read",
          prepare(arguments_) {
            const url = publicWebUrl(arguments_.url);
            return {
              normalizedArguments: { url },
              resourceRefs: [{ namespace: "web", resourceId: url }],
            };
          },
          async execute(prepared) {
            const url = publicWebUrl(prepared.normalizedArguments.url);
            return jsonValue(await options.opcPublicWebReader!.read(url));
          },
        });
        toolIds.push(toolId);
      }
      return {
        executionId,
        scope: executionScope,
        store: new KernelProjectionRuntimeStore({
          tenantId: job.tenantId,
          store: options.store,
          ...(options.now ? { now: options.now } : {}),
          id: (sequence) => `${executionId}:runtime:${sequence}`,
        }),
        definition: {
          id: state.execution.agentDefinitionId,
          llmId,
          promptIds: [promptId],
          toolIds,
        },
        authority: {
          commitment: state.authority.commitment,
          toolIds: state.authority.toolIds,
          dataScopes: state.authority.dataScopes,
          effectClasses: state.authority.autoAllowedEffects,
          budget: state.authority.budget,
        },
        approval: createKernelToolApprovalPort({
          tenantId: job.tenantId,
          actorId: state.execution.executionPrincipalId,
          kernel: approvalKernel,
          store: options.store,
          ...(options.approvalPollIntervalMs
            ? { pollIntervalMs: options.approvalPollIntervalMs }
            : {}),
          ...(options.now ? { now: () => Date.parse(options.now!()) } : {}),
        }),
        ...(options.now ? { now: options.now } : {}),
      };
    },
  });
  const codingHandler = options.codingSandboxRoot
    ? createCodingExecutionWorkerHandler({
        store: options.store,
        secretStore: options.secretStore,
        modelInvoker: invokeModel,
        approvalKernel,
        sandboxRoot: options.codingSandboxRoot,
        ...(options.codingSandboxExecutable
          ? { sandboxExecutable: options.codingSandboxExecutable }
          : {}),
        acceptsSecretReference,
        ...(options.approvalPollIntervalMs
          ? { approvalPollIntervalMs: options.approvalPollIntervalMs }
          : {}),
        ...(options.now ? { now: options.now } : {}),
      })
    : undefined;
  return async (job, context) => {
    const executionId = requiredPayloadString(job.payload, "executionId");
    const pluginId = await options.store.transact(job.tenantId, (transaction) =>
      transaction.getProjection<Execution>("execution", executionId)?.pluginId);
    if (pluginId !== "coding") return genericHandler(job, context);
    if (!codingHandler) {
      throw new Error("Coding sandbox 尚未配置，已拒绝无沙箱执行");
    }
    const control = await observeCodingExecutionControl(
      options.store,
      job.tenantId,
      executionId,
      controlPollIntervalMs,
    );
    try {
      return await codingHandler(job, {
        ...context,
        signal: AbortSignal.any([context.signal, control.signal]),
      });
    } catch (error) {
      const status = await options.store.transact(job.tenantId, (transaction) =>
        transaction.getProjection<Execution>("execution", executionId)?.status);
      if (status === "cancelled") throw new AgentExecutionCancelledError(executionId);
      if (status === "paused" || status === "interrupted") {
        throw new AgentExecutionInterruptedError(executionId);
      }
      if (!(error instanceof CodingWorkerOutcomeError)) throw error;
      if (error.status === "needs_reconciliation") {
        throw new UnknownExternalSideEffectError(error.executionId);
      }
      if (error.status === "cancelled") {
        throw new AgentExecutionCancelledError(error.executionId);
      }
      throw error;
    } finally {
      await control.stop();
    }
  };
}

async function observeCodingExecutionControl(
  store: AgentExecutionStore,
  tenantId: string,
  executionId: string,
  intervalMs: number,
): Promise<{ readonly signal: AbortSignal; readonly stop: () => Promise<void> }> {
  const abort = new AbortController();
  let stopped = false;
  let current = Promise.resolve();
  const inspect = async () => {
    if (stopped || abort.signal.aborted) return;
    const status = await store.transact(tenantId, (transaction) =>
      transaction.getProjection<Execution>("execution", executionId)?.status);
    if (status === "cancelled" || status === "paused" || status === "interrupted") {
      abort.abort(status);
    }
  };
  const schedule = () => {
    current = current.then(inspect).catch(() => abort.abort("执行控制状态检查失败"));
  };
  await inspect();
  const timer = setInterval(schedule, intervalMs);
  return {
    signal: abort.signal,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}

function publicWebUrl(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("公开网页工具缺少 url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("公开网页工具的 url 无效");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("公开网页工具只接受不含凭据的 HTTP 或 HTTPS 地址");
  }
  return url.href;
}

function jsonValue(value: unknown): JsonValue {
  try {
    const normalized = JSON.parse(JSON.stringify(value)) as unknown;
    if (normalized === undefined) throw new Error("结果为空");
    return normalized as JsonValue;
  } catch {
    throw new Error("工具结果不能持久化为 JSON");
  }
}

async function observeExecutionControl(
  store: AgentExecutionStore,
  tenantId: string,
  handle: AgentHandle,
  intervalMs: number,
): Promise<() => Promise<void>> {
  let stopped = false;
  let current = Promise.resolve();
  const inspect = async () => {
    if (stopped) return;
    const status = await store.transact(tenantId, (transaction) =>
      transaction.getProjection<Execution>("execution", handle.executionId)?.status);
    if (status === "cancelled") await handle.cancel("用户取消");
  };
  const schedule = () => {
    current = current.then(inspect).catch(async () => {
      if (!stopped) await handle.interrupt("执行控制状态检查失败");
    });
  };
  await inspect();
  const timer = setInterval(schedule, intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await current;
  };
}

function assertExecutionState(
  job: StoredJob,
  execution: Execution,
  authority: ExecutionAuthority,
  thread: Thread,
  model: StoredModelConnection,
): void {
  if (execution.tenantId !== job.tenantId
    || authority.tenantId !== job.tenantId
    || thread.tenantId !== job.tenantId
    || model.tenantId !== job.tenantId) {
    throw new Error("Agent Job 不能跨租户读取执行配置");
  }
  if (execution.workspaceId !== job.workspaceId
    || thread.workspaceId !== execution.workspaceId
    || authority.workspaceId !== execution.workspaceId) {
    throw new Error("Agent Job 的工作区配置不一致");
  }
  if (thread.id !== execution.threadId
    || thread.pluginId !== execution.pluginId
    || authority.executionId !== execution.id) {
    throw new Error("Agent Job 的执行配置不一致");
  }
  const expectedAgent = execution.pluginId === "opc"
    ? "opc.opportunity-validator"
    : execution.pluginId === "coding"
      ? "coding.builtin"
      : undefined;
  if (!expectedAgent || execution.agentDefinitionId !== expectedAgent) {
    throw new Error("Agent 定义不受当前产品插件支持");
  }
  if (model.status !== "ready" || !model.defaultModel.trim()) {
    throw new Error("模型连接尚未就绪");
  }
}

function providerId(value: string): ByokProviderId {
  if (value === "openai" || value === "deepseek" || value === "anthropic") return value;
  throw new Error("模型厂商预设不受支持");
}

function productPrompt(pluginId: string, subject: string, hasPublicWebTool: boolean): string {
  if (pluginId === "opc") {
    return [
      "你是木牛 OPC 机会验证 Agent。",
      `当前会话主题：${subject}。`,
      "输出可审阅的阶段成果，分别列出支持证据、反证、证据缺口和下一次人工行动。",
      "未经人工确认的 commitment 或 paid 证据，不得声称机会已经验证。",
      hasPublicWebTool
        ? "当前执行只注册了受控公开网页读取工具；未注册外联、发布、报价或支付工具。"
        : "当前执行未注册网页、外联、发布、报价或支付工具，不得声称已经调用这些能力。",
    ].join("\n");
  }
  return [
    "你是木牛 Coding Agent。",
    `当前任务主题：${subject}。`,
    "输出可审阅的任务结论、建议变更、检查项、风险和下一步。",
    "当前执行未注册仓库、sandbox 或 Gate 工具，不得声称已经修改代码或运行检查。",
  ].join("\n");
}

function requiredPayloadString(payload: JsonObject, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Job payload.${field} 必须是非空字符串`);
  }
  return value;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
