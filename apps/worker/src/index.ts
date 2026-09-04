import type { JsonObject, JsonValue } from "@mn/contracts";
import { AgentHandle, type AgentHandleOptions, type Awaitable } from "@mn/agent-runtime";
import {
  JOB_LEASE_MILLISECONDS,
  StaleFencingTokenError,
  type JobClaimOptions,
  type NeedsReconciliationInput,
  type StoredJob,
} from "@mn/storage";

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

class WorkerLeaseLostError extends Error {
  constructor(options?: ErrorOptions) {
    super("Worker 无法续租，已停止当前处理", options);
    this.name = "WorkerLeaseLostError";
  }
}

export type WorkerPollResult =
  | { readonly status: "not_ready"; readonly issues: readonly WorkerReadinessIssue[] }
  | { readonly status: "idle" }
  | { readonly status: "completed" | "failed" | "needs_reconciliation" | "lost_lease"; readonly jobId: string };

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

  async pollOnce(): Promise<WorkerPollResult> {
    const readiness = this.readiness();
    if (!readiness.ready) return { status: "not_ready", issues: readiness.issues };
    const claimedAt = this.#now();
    const job = await this.#store.claimJob(this.#id, claimedAt.toISOString(), this.#claimOptions);
    if (!job) return { status: "idle" };
    const handler = this.#handlers[job.kind];
    if (!handler) return this.#failKnown(job, "JOB_HANDLER_NOT_FOUND", "没有可处理此任务的 Worker", false);
    const leaseExpiresAt = job.leaseExpiresAt
      ?? new Date(claimedAt.getTime() + WORKER_LEASE_MILLISECONDS).toISOString();
    const abort = new AbortController();
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
      const message = error instanceof Error ? error.message : "任务执行失败";
      return this.#failKnown(job, "JOB_EXECUTION_FAILED", message, true);
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
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
    const result = await worker.pollOnce();
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
}

export function createAgentTurnHandler(options: AgentTurnHandlerOptions): WorkerJobHandler {
  return async (job, context) => {
    const executionId = requiredPayloadString(job.payload, "executionId");
    const message = requiredPayloadString(job.payload, "message");
    const handleOptions = await options.resolveOptions(job, context);
    if (handleOptions.executionId !== executionId) {
      throw new Error("Job 的 executionId 与 Runtime 配置不一致");
    }
    const handle = await AgentHandle.open(handleOptions);
    const cancelForLeaseLoss = () => {
      void handle.cancel("Worker 租约已丢失");
    };
    context.signal.addEventListener("abort", cancelForLeaseLoss, { once: true });
    try {
      if (context.signal.aborted) {
        await handle.cancel("Worker 租约已丢失");
      } else {
        await handle.followUp(message);
      }
      await handle.whenIdle();
    } finally {
      context.signal.removeEventListener("abort", cancelForLeaseLoss);
    }
    if (handle.status === "needs_reconciliation") {
      throw new UnknownExternalSideEffectError(executionId);
    }
    if (handle.status === "failed") {
      throw handle.lastError instanceof Error
        ? handle.lastError
        : new Error("Agent turn 执行失败");
    }
    if (handle.status === "cancelled") throw new Error("Agent turn 已取消");
    return { executionId, status: handle.status };
  };
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
