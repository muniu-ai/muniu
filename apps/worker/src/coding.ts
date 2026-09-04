// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  KernelProjectionRuntimeStore,
  type ModelRequest,
  type RuntimeStore,
  type ToolApprovalPort,
} from "@mn/agent-runtime";
import type {
  Deliverable,
  Execution,
  ExecutionAuthority,
  JsonObject,
  JsonValue,
  Thread,
  ToolCallIntent,
} from "@mn/contracts";
import { sha256, type InboxItem, type KernelStore } from "@mn/kernel";
import {
  buildRepositoryIndex,
  CodingExecutionEngine,
  decideCodingExecution,
  type Candidate,
  type CandidateDraft,
  type CodingControlPlaneCommitment,
  type CodingExecutionResult,
  type CodingRunnerAdapter,
  type CodingTask,
  type GateVerifier,
  type Repository,
  type RepositoryIndex,
  type RunnerEvent,
} from "@mn/plugin-coding";
import type { StoredJob } from "@mn/storage";

import { createKernelToolApprovalPort, type ToolApprovalKernel } from "./approval.js";
import {
  ModelTransportError,
  type ByokModelInvoker,
  type ByokProviderId,
} from "./model-invoker.js";

const MAX_TRACKED_FILES = 10_000;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_MODEL_CONTEXT_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const TOOL_INTENT_TTL_MS = 5 * 60 * 1000;
const GIT = "/usr/bin/git";
const DEFAULT_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

interface StoredModelConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly presetId: string;
  readonly secretRef: string;
  readonly defaultModel: string;
  readonly status: "pending" | "ready" | "invalid";
}

interface VersionedRepository extends Repository {
  readonly streamVersion: number;
  readonly updatedAt: string;
}

interface StoredCandidate extends Candidate {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly diff: string;
  readonly createdAt: string;
}

interface StoredCodingRun {
  readonly executionId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly status: "running" | CodingExecutionResult["status"];
  readonly controlPlane: CodingControlPlaneCommitment;
  readonly baseRevision: string;
  readonly result?: CodingExecutionResult;
  readonly approvalIntent?: ToolCallIntent;
  readonly streamVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RepositorySnapshot {
  readonly repository: VersionedRepository;
  readonly realPath: string;
  readonly baseRevision: string;
  readonly index: RepositoryIndex;
  readonly modelContext: string;
}

interface CandidateMaterial {
  readonly diff: string;
  readonly sandboxPath: string;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CodingWorkerJobContext {
  readonly signal: AbortSignal;
}

export interface CodingModelSecretReader {
  read(secretRef: string): Promise<string>;
}

export interface CodingExecutionWorkerOptions {
  readonly store: KernelStore;
  readonly secretStore: CodingModelSecretReader;
  readonly modelInvoker: ByokModelInvoker;
  readonly approvalKernel: ToolApprovalKernel;
  readonly sandboxRoot: string;
  readonly sandboxExecutable?: string;
  readonly acceptsSecretReference?: (reference: string) => boolean;
  readonly approvalPollIntervalMs?: number;
  readonly now?: () => string;
}

export class CodingWorkerOutcomeError extends Error {
  constructor(
    readonly executionId: string,
    readonly status: "failed" | "cancelled" | "needs_reconciliation",
    message: string,
  ) {
    super(message);
    this.name = "CodingWorkerOutcomeError";
  }
}

export function createCodingExecutionWorkerHandler(options: CodingExecutionWorkerOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const sandbox = new MacOsCodingSandbox({
    root: options.sandboxRoot,
    executable: options.sandboxExecutable ?? DEFAULT_SANDBOX_EXECUTABLE,
  });

  return async (job: StoredJob, context: CodingWorkerJobContext): Promise<JsonValue> => {
    const executionId = payloadString(job.payload, "executionId");
    if (job.payload.command !== undefined && job.payload.command !== "resume") {
      throw new Error("Coding Job command 无效");
    }
    const state = await loadCodingState(options.store, job.tenantId, executionId);
    assertCodingState(job, state);
    if (options.acceptsSecretReference && !options.acceptsSecretReference(state.model.secretRef)) {
      throw new Error("模型密钥引用不属于当前运行环境");
    }
    const runtime = new KernelProjectionRuntimeStore({
      tenantId: job.tenantId,
      store: options.store,
      now,
      id: (sequence) => `${executionId}:coding-runtime:${sequence}`,
    });
    const approval = createKernelToolApprovalPort({
      tenantId: job.tenantId,
      actorId: state.execution.executionPrincipalId,
      kernel: options.approvalKernel,
      store: options.store,
      ...(options.approvalPollIntervalMs
        ? { pollIntervalMs: options.approvalPollIntervalMs }
        : {}),
      now: () => Date.parse(now()),
    });

    const recovered = await loadCodingRun(options.store, job.tenantId, executionId);
    if (recovered?.generation === state.execution.generation && recovered.result) {
      return settlePersistedResult({
        options,
        job,
        context,
        state,
        runtime,
        approval,
        run: recovered,
        now,
      });
    }

    const snapshot = await inspectRepositoryControlled({
      repository: state.repository,
      execution: state.execution,
      authority: state.authority,
      runtime,
      approval,
      signal: context.signal,
      now,
    });
    const controlPlane = await sandbox.controlPlane(snapshot, state.task);
    await persistRunning(options.store, job.tenantId, state, controlPlane, snapshot.baseRevision, now());

    const runner = new BuiltinCodingRunner({
      execution: state.execution,
      authority: state.authority,
      task: state.task,
      model: state.model,
      snapshot,
      controlPlane,
      runtime,
      approval,
      sandbox,
      secretStore: options.secretStore,
      modelInvoker: options.modelInvoker,
      signal: context.signal,
      now,
    });
    let run: StoredCodingRun;
    try {
      const result = await new CodingExecutionEngine({ runners: [runner], now: () => Date.parse(now()) })
        .execute({
          task: state.task,
          controlPlane,
          gateVerifier: runner.gateVerifier,
          executionId,
          repositoryPath: snapshot.realPath,
          expectedRepositoryRealPath: state.repository.rootRealPath,
          limits: { maxDurationMs: state.authority.budget.maxDurationMs },
        });
      if (context.signal.aborted) throw new Error("Coding 执行已中断");
      const approvalIntent = result.status === "waiting_approval"
        ? acceptanceIntent(state.execution, state.authority, state.repository, result, now())
        : undefined;
      run = await persistCodingResult({
        store: options.store,
        tenantId: job.tenantId,
        state,
        controlPlane,
        baseRevision: snapshot.baseRevision,
        result,
        approvalIntent,
        material: runner.material,
        now: now(),
      });
    } finally {
      await runner.cleanup();
    }
    return settlePersistedResult({
      options,
      job,
      context,
      state,
      runtime,
      approval,
      run,
      now,
    });
  };
}

async function settlePersistedResult(input: {
  readonly options: CodingExecutionWorkerOptions;
  readonly job: StoredJob;
  readonly context: CodingWorkerJobContext;
  readonly state: CodingState;
  readonly runtime: RuntimeStore;
  readonly approval: ToolApprovalPort;
  readonly run: StoredCodingRun;
  readonly now: () => string;
}): Promise<JsonValue> {
  const { result } = input.run;
  if (!result) throw new Error("Coding 执行检查点缺少持久结果");
  if (result.status === "completed" || result.status === "needs_human_decision") {
    return { executionId: input.state.execution.id, status: result.status };
  }
  if (result.status === "failed" || result.status === "cancelled"
    || result.status === "needs_reconciliation") {
    throw new CodingWorkerOutcomeError(input.state.execution.id, result.status, result.nextStep);
  }
  if (result.status !== "waiting_approval" || !input.run.approvalIntent) {
    throw new Error("Coding 执行结果状态无效");
  }
  await input.runtime.append({
    executionId: input.state.execution.id,
    type: "tool/intent",
    payload: input.run.approvalIntent as unknown as JsonObject,
  });
  const authorization = await input.approval.authorize(
    input.run.approvalIntent,
    input.context.signal,
  );
  if (authorization.mode === "auto") {
    throw new Error("特权候选批准不能自动放行");
  }
  const decision = authorization.mode === "deny" ? "denied" : "approved_once";
  const decided = decideCodingExecution(result, decision);
  await input.runtime.append({
    executionId: input.state.execution.id,
    type: "tool/result",
    payload: {
      toolCallId: input.run.approvalIntent.id,
      status: decision === "approved_once" ? "completed" : "denied",
    },
  });
  const persisted = await persistCodingDecision(
    input.options.store,
    input.job.tenantId,
    input.state,
    decided,
    input.now(),
  );
  if (persisted.status === "cancelled") {
    throw new CodingWorkerOutcomeError(input.state.execution.id, "cancelled", persisted.nextStep);
  }
  return { executionId: input.state.execution.id, status: persisted.status };
}

interface CodingState {
  readonly execution: Execution;
  readonly authority: ExecutionAuthority;
  readonly thread: Thread;
  readonly task: CodingTask;
  readonly repository: VersionedRepository;
  readonly model: StoredModelConnection;
}

async function loadCodingState(
  store: KernelStore,
  tenantId: string,
  executionId: string,
): Promise<CodingState> {
  return store.transact(tenantId, (transaction) => {
    const execution = transaction.getProjection<Execution>("execution", executionId);
    if (!execution) throw new Error("Execution 不存在");
    const authority = transaction.getProjection<ExecutionAuthority>("authority", execution.authorityId);
    if (!authority) throw new Error("Execution Authority 不存在");
    const thread = transaction.getProjection<Thread>("thread", execution.threadId);
    if (!thread) throw new Error("Thread 不存在");
    if (thread.resourceRef?.namespace !== "coding.task") {
      throw new Error("Coding Thread 未绑定 coding.task 资源");
    }
    const task = transaction.getProjection<CodingTask>("coding.task", thread.resourceRef.resourceId);
    if (!task) throw new Error("CodingTask 不存在");
    const repository = transaction.getProjection<VersionedRepository>(
      "coding.repository",
      task.repositoryId,
    );
    if (!repository) throw new Error("Coding Repository 不存在");
    const model = transaction.getProjection<StoredModelConnection>(
      "modelConnection",
      execution.modelBindingId,
    );
    if (!model) throw new Error("模型连接不存在");
    return { execution, authority, thread, task, repository, model };
  });
}

function assertCodingState(job: StoredJob, state: CodingState): void {
  if (state.execution.tenantId !== job.tenantId || state.authority.tenantId !== job.tenantId
    || state.thread.tenantId !== job.tenantId || state.model.tenantId !== job.tenantId) {
    throw new Error("Coding Job 不能跨租户读取执行配置");
  }
  if (state.execution.workspaceId !== job.workspaceId
    || state.authority.workspaceId !== state.execution.workspaceId
    || state.thread.workspaceId !== state.execution.workspaceId
    || state.task.workspaceId !== state.execution.workspaceId
    || state.repository.workspaceId !== state.execution.workspaceId) {
    throw new Error("Coding Job 的工作区配置不一致");
  }
  if (state.execution.pluginId !== "coding"
    || state.thread.pluginId !== "coding"
    || state.execution.agentDefinitionId !== "coding.builtin"
    || state.authority.executionId !== state.execution.id) {
    throw new Error("Coding Job 的执行配置不一致");
  }
  if (state.execution.status !== "running" && state.execution.status !== "waiting_approval") {
    throw new Error(`状态为 ${state.execution.status} 的 Coding Execution 不能由 Worker 处理`);
  }
  if (state.model.status !== "ready" || !state.model.defaultModel.trim()) {
    throw new Error("模型连接尚未就绪");
  }
  for (const toolId of [
    "coding.repository.read",
    "coding.sandbox.write",
    "coding.gate.verify",
    "coding.candidate.accept",
  ]) {
    if (!state.authority.toolIds.includes(toolId)) {
      throw new Error(`Coding builtin 缺少工具权限：${toolId}`);
    }
  }
}

async function loadCodingRun(
  store: KernelStore,
  tenantId: string,
  executionId: string,
): Promise<StoredCodingRun | undefined> {
  return store.transact(tenantId, (transaction) =>
    transaction.getProjection<StoredCodingRun>("coding.execution", executionId));
}

async function inspectRepositoryControlled(input: {
  readonly repository: VersionedRepository;
  readonly execution: Execution;
  readonly authority: ExecutionAuthority;
  readonly runtime: RuntimeStore;
  readonly approval: ToolApprovalPort;
  readonly signal: AbortSignal;
  readonly now: () => string;
}): Promise<RepositorySnapshot> {
  const normalized = resolve(input.repository.rootRealPath);
  if (!input.repository.rootRealPath || normalized !== input.repository.rootRealPath) {
    throw new Error("仓库必须使用已规范化的绝对真实路径");
  }
  const actual = await realpath(normalized);
  if (actual !== input.repository.rootRealPath) throw new Error("仓库真实路径已变化，拒绝执行");
  const intent = createIntent({
    execution: input.execution,
    authority: input.authority,
    toolId: "coding.repository.read",
    effectClass: "local_read",
    intent: `读取受控仓库 ${input.repository.name}`,
    normalizedArguments: { repositoryId: input.repository.id, rootRealPath: actual },
    resourceRefs: [{ namespace: "repository", resourceId: input.repository.id }],
    now: input.now(),
  });
  await authorizeTool(input.runtime, input.approval, intent, input.signal);
  const snapshot = await inspectRepository(input.repository, actual);
  await recordToolResult(input.runtime, intent, {
    baseRevision: snapshot.baseRevision,
    repositoryIndexDigest: snapshot.index.digest,
    trackedFiles: snapshot.index.entries.length,
  });
  return snapshot;
}

async function inspectRepository(
  repository: VersionedRepository,
  actualPath: string,
): Promise<RepositorySnapshot> {
  const topLevel = (await git(actualPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (topLevel !== actualPath) throw new Error("仓库路径不是 Git 工作树根目录");
  const status = (await git(actualPath, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  if (status.trim()) throw new Error("仓库存在未提交变更；为避免覆盖用户工作，已拒绝执行");
  const baseRevision = (await git(actualPath, ["rev-parse", "HEAD"])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(baseRevision)) throw new Error("无法固定仓库基础版本");
  const tracked = (await git(actualPath, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean);
  if (tracked.length > MAX_TRACKED_FILES) throw new Error("仓库跟踪文件数量超过受控读取上限");
  const entries: Array<{ path: string; digest: string; byteLength: number }> = [];
  const context: string[] = [];
  let totalBytes = 0;
  let contextBytes = 0;
  for (const path of tracked) {
    assertRelativeRepositoryPath(path);
    const absolute = join(actualPath, path);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`仓库包含不受支持的文件类型：${path}`);
    const actualFile = await realpath(absolute);
    assertWithin(actualPath, actualFile, "跟踪文件");
    const content = await readFile(actualFile);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_INDEX_BYTES) throw new Error("仓库索引内容超过受控读取上限");
    entries.push({ path, digest: hashBytes(content), byteLength: content.byteLength });
    if (!content.includes(0) && contextBytes + content.byteLength <= MAX_MODEL_CONTEXT_BYTES) {
      context.push(`--- ${path}\n${content.toString("utf8")}`);
      contextBytes += content.byteLength;
    }
  }
  return {
    repository,
    realPath: actualPath,
    baseRevision,
    index: buildRepositoryIndex(entries),
    modelContext: context.join("\n\n"),
  };
}

class BuiltinCodingRunner implements CodingRunnerAdapter {
  readonly id = "builtin";
  readonly external = false;
  readonly material = new Map<string, CandidateMaterial>();
  readonly gateVerifier: GateVerifier;
  readonly #options: BuiltinRunnerOptions;
  #sequence = 0;
  #feedback = "";

  constructor(options: BuiltinRunnerOptions) {
    this.#options = options;
    this.gateVerifier = { verify: (candidate, controlPlane) => this.#verify(candidate, controlPlane) };
  }

  async start(): Promise<{ sessionId: string }> {
    return { sessionId: `${this.#options.execution.id}:builtin` };
  }

  async *events(): AsyncIterable<RunnerEvent> {
    try {
      yield { type: "candidate", candidate: await this.#candidate() };
    } catch (error) {
      yield { type: "result", status: "failed", reason: safeMessage(error) };
    }
  }

  async cancel(): Promise<void> {
    // 每个候选都在隔离目录内完成；取消后不再启动新的模型或 Gate 边界。
  }

  async cleanup(): Promise<void> {
    const paths = new Set([...this.material.values()].map((item) => item.sandboxPath));
    await Promise.all([...paths].map((path) => this.#options.sandbox.cleanup(path)));
  }

  async resume(_sessionId: string, input: { readonly preparedInput: string }): Promise<void> {
    this.#feedback = input.preparedInput;
  }

  async #candidate(): Promise<CandidateDraft> {
    if (this.#options.signal.aborted) throw new Error("Coding 执行已取消");
    const sequence = ++this.#sequence;
    const current = await this.#inspectCurrentRepository(sequence);
    if (current.realPath !== this.#options.snapshot.realPath
      || current.baseRevision !== this.#options.snapshot.baseRevision
      || current.index.digest !== this.#options.controlPlane.repositoryIndexDigest) {
      throw new Error("仓库在模型边界前已变化，拒绝使用旧审批与旧上下文");
    }
    const request: ModelRequest = {
      executionId: this.#options.execution.id,
      agentId: "coding.builtin",
      generation: this.#options.execution.generation,
      messages: [
        {
          role: "system",
          content: [
            "你是木牛 Coding builtin Runner。",
            "只能调用 coding.sandbox.write 一次，参数必须是 {patch, summary}。",
            "patch 必须是基于固定 HEAD 的 unified diff；禁止声称已经通过 Gate。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `任务：${this.#options.task.request}`,
            `基础版本：${this.#options.snapshot.baseRevision}`,
            this.#feedback ? `上次 Gate 反馈：\n${this.#feedback}` : "",
            `受控仓库内容：\n${this.#options.snapshot.modelContext}`,
          ].filter(Boolean).join("\n\n"),
        },
      ],
      availableToolIds: ["coding.sandbox.write"],
    };
    await this.#options.runtime.append({
      executionId: this.#options.execution.id,
      type: "model/request",
      payload: request as unknown as JsonObject,
    });
    let apiKey: string;
    try {
      apiKey = await this.#options.secretStore.read(this.#options.model.secretRef);
    } catch {
      throw new ModelTransportError("无法读取模型凭据");
    }
    const response = await this.#options.modelInvoker({
      presetId: providerId(this.#options.model.presetId),
      model: this.#options.model.defaultModel,
      apiKey,
      request,
      signal: this.#options.signal,
    });
    await this.#options.runtime.append({
      executionId: this.#options.execution.id,
      type: "model/response",
      payload: response as unknown as JsonObject,
    });
    if (response.toolCalls.length !== 1 || response.toolCalls[0]?.toolId !== "coding.sandbox.write") {
      throw new Error("模型必须且只能提交一次 coding.sandbox.write 工具调用");
    }
    const call = response.toolCalls[0];
    const patch = requiredArgument(call.arguments, "patch");
    const summary = requiredArgument(call.arguments, "summary");
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES || patch.includes("\0")) {
      throw new Error("模型提交的 Diff 超过大小上限或包含空字节");
    }
    const patchDigest = hashBytes(Buffer.from(patch));
    const intent = createIntent({
      execution: this.#options.execution,
      authority: this.#options.authority,
      toolId: "coding.sandbox.write",
      effectClass: "local_reversible_write",
      intent: `在隔离目录生成第 ${sequence} 个候选`,
      normalizedArguments: { sequence, patchDigest, byteLength: Buffer.byteLength(patch) },
      resourceRefs: [{
        namespace: "repository",
        resourceId: this.#options.snapshot.repository.id,
        digest: this.#options.controlPlane.repositoryIndexDigest,
      }],
      now: this.#options.now(),
    });
    await authorizeTool(this.#options.runtime, this.#options.approval, intent, this.#options.signal);
    if (hashBytes(Buffer.from(patch)) !== patchDigest) throw new Error("Diff 在执行前已变化");
    const applied = await this.#options.sandbox.applyPatch(this.#options.snapshot, patch, sequence);
    const candidateId = `${this.#options.execution.id}:generation:${this.#options.execution.generation}:candidate:${sequence}`;
    await recordToolResult(this.#options.runtime, intent, {
      candidateId,
      diffDigest: applied.diffDigest,
      sandboxDigest: this.#options.controlPlane.sandboxDigest,
    });
    this.material.set(candidateId, { diff: applied.diff, sandboxPath: applied.sandboxPath });
    return {
      id: candidateId,
      sequence,
      baseRevision: this.#options.snapshot.baseRevision,
      diffDigest: applied.diffDigest,
      summary,
      sandbox: {
        enforced: true,
        fallbackUsed: false,
        evidenceDigest: this.#options.controlPlane.sandboxDigest,
      },
    };
  }

  async #inspectCurrentRepository(sequence: number): Promise<RepositorySnapshot> {
    const actual = await realpath(this.#options.snapshot.realPath);
    const intent = createIntent({
      execution: this.#options.execution,
      authority: this.#options.authority,
      toolId: "coding.repository.read",
      effectClass: "local_read",
      intent: `在第 ${sequence} 个模型边界复核受控仓库`,
      normalizedArguments: {
        repositoryId: this.#options.snapshot.repository.id,
        rootRealPath: actual,
        sequence,
        expectedIndexDigest: this.#options.controlPlane.repositoryIndexDigest,
      },
      resourceRefs: [{
        namespace: "repository",
        resourceId: this.#options.snapshot.repository.id,
        digest: this.#options.controlPlane.repositoryIndexDigest,
      }],
      now: this.#options.now(),
    });
    await authorizeTool(this.#options.runtime, this.#options.approval, intent, this.#options.signal);
    const snapshot = await inspectRepository(this.#options.snapshot.repository, actual);
    await recordToolResult(this.#options.runtime, intent, {
      baseRevision: snapshot.baseRevision,
      repositoryIndexDigest: snapshot.index.digest,
    });
    return snapshot;
  }

  async #verify(candidate: Candidate, controlPlane: CodingControlPlaneCommitment) {
    const material = this.material.get(candidate.id);
    if (!material) throw new Error("Gate 找不到候选隔离目录");
    if (hashBytes(Buffer.from(material.diff)) !== candidate.diffDigest) {
      throw new Error("Gate 前候选 Diff 摘要不一致");
    }
    const intent = createIntent({
      execution: this.#options.execution,
      authority: this.#options.authority,
      toolId: "coding.gate.verify",
      effectClass: "local_read",
      intent: `验证候选 ${candidate.id}`,
      normalizedArguments: { candidateId: candidate.id, diffDigest: candidate.diffDigest },
      resourceRefs: [{
        namespace: "repository",
        resourceId: this.#options.snapshot.repository.id,
        digest: controlPlane.repositoryIndexDigest,
      }],
      now: this.#options.now(),
    });
    await authorizeTool(this.#options.runtime, this.#options.approval, intent, this.#options.signal);
    const currentDiff = await this.#options.sandbox.diff(material.sandboxPath);
    if (hashBytes(Buffer.from(currentDiff)) !== candidate.diffDigest) {
      throw new Error("Gate 执行前隔离目录中的 Diff 已变化");
    }
    const gate = await this.#options.sandbox.verify(material.sandboxPath);
    const evidenceDigest = sha256({
      candidateId: candidate.id,
      diffDigest: candidate.diffDigest,
      sandboxDigest: controlPlane.sandboxDigest,
      command: "git diff --check HEAD --",
      ...gate,
    });
    await recordToolResult(this.#options.runtime, intent, {
      candidateId: candidate.id,
      status: gate.exitCode === 0 ? "passed" : "failed",
      evidenceDigest,
    });
    return {
      status: gate.exitCode === 0 ? "passed" as const : "failed" as const,
      authoritative: true,
      evidenceDigest,
      checks: [{
        id: "git.diff-check",
        status: gate.exitCode === 0 ? "passed" as const : "failed" as const,
        summary: gate.exitCode === 0
          ? "git diff --check 通过"
          : (gate.stderr || gate.stdout || "git diff --check 未通过").trim(),
      }],
      ...(gate.exitCode === 0 ? {} : { reason: "候选 Diff 未通过权威 Gate" }),
    };
  }
}

interface BuiltinRunnerOptions {
  readonly execution: Execution;
  readonly authority: ExecutionAuthority;
  readonly task: CodingTask;
  readonly model: StoredModelConnection;
  readonly snapshot: RepositorySnapshot;
  readonly controlPlane: CodingControlPlaneCommitment;
  readonly runtime: RuntimeStore;
  readonly approval: ToolApprovalPort;
  readonly sandbox: MacOsCodingSandbox;
  readonly secretStore: CodingModelSecretReader;
  readonly modelInvoker: ByokModelInvoker;
  readonly signal: AbortSignal;
  readonly now: () => string;
}

class MacOsCodingSandbox {
  readonly #root: string;
  readonly #executable: string;
  #realRoot?: string;

  constructor(options: { readonly root: string; readonly executable: string }) {
    if (!isAbsolute(options.root)) throw new Error("Coding sandbox 根目录必须是绝对路径");
    if (!isAbsolute(options.executable)) throw new Error("sandbox-exec 必须是绝对路径");
    this.#root = resolve(options.root);
    this.#executable = resolve(options.executable);
  }

  async controlPlane(
    snapshot: RepositorySnapshot,
    task: CodingTask,
  ): Promise<CodingControlPlaneCommitment> {
    const root = await this.#initialize();
    return {
      protocol: "coding-v2",
      specDigest: sha256({ version: "coding-spec-v2", taskId: task.id, request: task.request }),
      governanceDigest: sha256({
        version: "coding-governance-v2",
        rules: ["preserve-user-work", "central-tool-policy", "no-unsandboxed-fallback"],
      }),
      harnessDigest: sha256({ version: "coding-harness-v2", gates: ["git.diff-check"], maxRepairs: 3 }),
      sandboxDigest: sha256({
        version: "macos-sandbox-exec-v1",
        executable: this.#executable,
        root,
        writeScope: "candidate-directory",
        network: "denied",
        fallback: "forbidden",
      }),
      repositoryIndexDigest: snapshot.index.digest,
    };
  }

  async applyPatch(snapshot: RepositorySnapshot, patch: string, sequence: number) {
    const root = await this.#initialize();
    const prefix = `${safePathPart(snapshot.repository.id)}-${sequence}-`;
    const candidateRoot = await mkdtemp(join(root, prefix));
    assertWithin(root, candidateRoot, "候选目录");
    const repositoryPath = join(candidateRoot, "repository");
    const patchPath = join(candidateRoot, "candidate.patch");
    await mkdir(join(candidateRoot, "tmp"), { mode: 0o700 });
    await writeFile(join(candidateRoot, "empty.gitconfig"), "", { flag: "wx", mode: 0o600 });
    await writeFile(patchPath, patch, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await requireSuccess(await this.#run(candidateRoot, undefined, [
      "-c", "protocol.file.allow=always",
      "clone", "--no-local", "--no-hardlinks", "--no-checkout", "--quiet",
      snapshot.realPath,
      repositoryPath,
    ]), "隔离仓库创建失败");
    await requireSuccess(await this.#run(candidateRoot, repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "checkout", "--detach", "--quiet", snapshot.baseRevision,
    ]), "固定基础版本失败");
    await requireSuccess(await this.#run(candidateRoot, repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "apply", "--check", "--index", "--whitespace=nowarn", patchPath,
    ]), "候选 Diff 无法安全应用");
    await requireSuccess(await this.#run(candidateRoot, repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "apply", "--index", "--whitespace=nowarn", patchPath,
    ]), "候选 Diff 应用失败");
    const diff = await this.diff(repositoryPath);
    if (!diff.trim()) throw new Error("模型没有生成可审阅的代码变更");
    return {
      diff,
      diffDigest: hashBytes(Buffer.from(diff)),
      sandboxPath: repositoryPath,
    };
  }

  async diff(repositoryPath: string): Promise<string> {
    const candidateRoot = await this.#candidateRoot(repositoryPath);
    const result = await this.#run(candidateRoot, repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "diff", "--binary", "--no-ext-diff", "--no-color", "HEAD", "--",
    ]);
    await requireSuccess(result, "读取候选 Diff 失败");
    return result.stdout;
  }

  async verify(repositoryPath: string): Promise<CommandResult> {
    const candidateRoot = await this.#candidateRoot(repositoryPath);
    return this.#run(candidateRoot, repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "diff", "--check", "HEAD", "--",
    ]);
  }

  async cleanup(repositoryPath: string): Promise<void> {
    const root = await this.#initialize();
    const candidateRoot = resolve(repositoryPath, "..");
    assertWithin(root, candidateRoot, "候选目录");
    if (basename(repositoryPath) !== "repository") throw new Error("候选仓库目录结构无效");
    await rm(candidateRoot, { recursive: true, force: true });
  }

  async #initialize(): Promise<string> {
    if (process.platform !== "darwin") {
      throw new Error("当前平台没有已审核的 Coding sandbox，已拒绝无沙箱执行");
    }
    const executable = await realpath(this.#executable).catch(() => "");
    if (executable !== this.#executable) throw new Error("sandbox-exec 不存在或真实路径已变化");
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.#root);
    this.#realRoot = root;
    return root;
  }

  async #candidateRoot(repositoryPath: string): Promise<string> {
    const root = await this.#initialize();
    const actual = await realpath(repositoryPath);
    assertWithin(root, actual, "候选仓库");
    if (basename(actual) !== "repository") throw new Error("候选仓库目录结构无效");
    return resolve(actual, "..");
  }

  #run(candidateRoot: string, cwd: string | undefined, gitArguments: readonly string[]) {
    const root = this.#realRoot;
    if (!root) throw new Error("Coding sandbox 尚未初始化");
    assertWithin(root, candidateRoot, "候选目录");
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow sysctl-read)",
      "(allow file-read*)",
      `(allow file-write* (subpath \"${schemeString(candidateRoot)}\"))`,
      "(allow file-write* (literal \"/dev/null\"))",
      "(deny network*)",
    ].join("\n");
    return command(this.#executable, ["-p", profile, GIT, ...gitArguments], cwd, {
      TMPDIR: join(candidateRoot, "tmp"),
      GIT_CONFIG_GLOBAL: join(candidateRoot, "empty.gitconfig"),
    });
  }
}

async function persistRunning(
  store: KernelStore,
  tenantId: string,
  state: CodingState,
  controlPlane: CodingControlPlaneCommitment,
  baseRevision: string,
  occurredAt: string,
): Promise<void> {
  await store.transact(tenantId, (transaction) => {
    const current = transaction.getProjection<StoredCodingRun>("coding.execution", state.execution.id);
    if (current?.generation === state.execution.generation) {
      if (current.controlPlane.repositoryIndexDigest !== controlPlane.repositoryIndexDigest
        || current.controlPlane.sandboxDigest !== controlPlane.sandboxDigest
        || current.baseRevision !== baseRevision) {
        throw new Error("Coding 执行恢复时控制面或仓库快照已变化");
      }
      return;
    }
    const streamVersion = current?.streamVersion ?? 0;
    const next: StoredCodingRun = {
      executionId: state.execution.id,
      generation: state.execution.generation,
      taskId: state.task.id,
      repositoryId: state.repository.id,
      status: "running",
      controlPlane,
      baseRevision,
      streamVersion: streamVersion + 1,
      createdAt: current?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
    };
    transaction.putProjection("coding.execution", state.execution.id, next);
    transaction.putProjection("coding.control-plane", state.execution.id, {
      executionId: state.execution.id,
      generation: state.execution.generation,
      ...controlPlane,
      baseRevision,
      createdAt: occurredAt,
    });
    transaction.appendEvent({
      tenantId,
      aggregateType: "coding.execution",
      aggregateId: state.execution.id,
      expectedStreamVersion: streamVersion,
      type: "coding.execution_started",
      actorId: state.execution.executionPrincipalId,
      executionId: state.execution.id,
      generation: state.execution.generation,
      correlationId: `coding:${state.execution.id}:${state.execution.generation}`,
      publicPayload: {
        workspaceId: state.execution.workspaceId,
        taskId: state.task.id,
        repositoryId: state.repository.id,
        runnerId: "builtin",
        baseRevision,
        ...controlPlane,
      },
    });
  });
}

async function persistCodingResult(input: {
  readonly store: KernelStore;
  readonly tenantId: string;
  readonly state: CodingState;
  readonly controlPlane: CodingControlPlaneCommitment;
  readonly baseRevision: string;
  readonly result: CodingExecutionResult;
  readonly approvalIntent?: ToolCallIntent;
  readonly material: ReadonlyMap<string, CandidateMaterial>;
  readonly now: string;
}): Promise<StoredCodingRun> {
  return input.store.transact(input.tenantId, (transaction) => {
    const current = transaction.getProjection<StoredCodingRun>(
      "coding.execution",
      input.state.execution.id,
    );
    if (!current || current.generation !== input.state.execution.generation) {
      throw new Error("Coding 执行开始检查点不存在");
    }
    if (current.result) return current;
    let taskVersion = input.state.task.streamVersion;
    for (const candidate of input.result.candidates) {
      const material = input.material.get(candidate.id);
      if (!material) throw new Error(`候选 ${candidate.id} 缺少持久化 Diff`);
      const stored: StoredCandidate = {
        ...candidate,
        tenantId: input.tenantId,
        workspaceId: input.state.execution.workspaceId,
        executionId: input.state.execution.id,
        diff: material.diff,
        createdAt: input.now,
      };
      transaction.putProjection("coding.candidate", candidate.id, stored);
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "coding.task",
        aggregateId: input.state.task.id,
        expectedStreamVersion: taskVersion++,
        type: "coding.candidate_recorded",
        actorId: input.state.execution.executionPrincipalId,
        executionId: input.state.execution.id,
        generation: input.state.execution.generation,
        correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
        publicPayload: {
          workspaceId: input.state.execution.workspaceId,
          candidateId: candidate.id,
          sequence: candidate.sequence,
          runnerId: candidate.runnerId,
          baseRevision: candidate.baseRevision,
          diffDigest: candidate.diffDigest,
          sandboxDigest: candidate.sandbox.evidenceDigest!,
        },
      });
    }
    for (const gate of input.result.gates) {
      transaction.putProjection("coding.gate-result", gate.candidateId, {
        ...gate,
        tenantId: input.tenantId,
        workspaceId: input.state.execution.workspaceId,
        executionId: input.state.execution.id,
        createdAt: input.now,
      });
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "coding.task",
        aggregateId: input.state.task.id,
        expectedStreamVersion: taskVersion++,
        type: "coding.gate_result_recorded",
        actorId: input.state.execution.executionPrincipalId,
        executionId: input.state.execution.id,
        generation: input.state.execution.generation,
        correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
        publicPayload: {
          workspaceId: input.state.execution.workspaceId,
          candidateId: gate.candidateId,
          status: gate.status,
          authoritative: gate.authoritative,
          ...(gate.evidenceDigest ? { evidenceDigest: gate.evidenceDigest } : {}),
        },
      });
    }
    if (input.result.evidence) {
      transaction.putProjection("coding.code-evidence", input.result.evidence.digest, {
        ...input.result.evidence,
        tenantId: input.tenantId,
        workspaceId: input.state.execution.workspaceId,
        executionId: input.state.execution.id,
        createdAt: input.now,
      });
      transaction.appendEvent({
        tenantId: input.tenantId,
        aggregateType: "coding.task",
        aggregateId: input.state.task.id,
        expectedStreamVersion: taskVersion++,
        type: "coding.code_evidence_recorded",
        actorId: input.state.execution.executionPrincipalId,
        executionId: input.state.execution.id,
        generation: input.state.execution.generation,
        correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
        publicPayload: {
          workspaceId: input.state.execution.workspaceId,
          candidateId: input.result.evidence.candidateId,
          evidenceDigest: input.result.evidence.digest,
        },
      });
    }
    transaction.appendEvent({
      tenantId: input.tenantId,
      aggregateType: "coding.task",
      aggregateId: input.state.task.id,
      expectedStreamVersion: taskVersion++,
      type: `coding.execution_${input.result.status}`,
      actorId: input.state.execution.executionPrincipalId,
      executionId: input.state.execution.id,
      generation: input.state.execution.generation,
      correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
      publicPayload: {
        workspaceId: input.state.execution.workspaceId,
        status: input.result.status,
        candidateCount: input.result.candidates.length,
        gateCount: input.result.gates.length,
      },
    });
    transaction.putProjection("coding.task", input.state.task.id, {
      ...input.state.task,
      stage: input.result.status === "waiting_approval" ? "approve" : "verify",
      status: input.result.status,
      streamVersion: taskVersion,
      updatedAt: input.now,
    });
    if (input.result.status === "needs_human_decision") {
      const inbox: InboxItem = {
        id: `coding-review:${input.state.execution.id}`,
        tenantId: input.tenantId,
        workspaceId: input.state.execution.workspaceId,
        executionId: input.state.execution.id,
        kind: "failure",
        title: "Coding Gate 已达到修复上限",
        summary: input.result.nextStep,
        risk: "gate_failed",
        resourceSummary: input.state.repository.name,
        createdAt: input.now,
        status: "open",
      };
      transaction.putProjection("inbox", inbox.id, inbox);
    }
    const next: StoredCodingRun = {
      ...current,
      status: input.result.status,
      result: input.result,
      ...(input.approvalIntent ? { approvalIntent: input.approvalIntent } : {}),
      streamVersion: current.streamVersion + 1,
      updatedAt: input.now,
    };
    transaction.putProjection("coding.execution", input.state.execution.id, next);
    transaction.appendEvent({
      tenantId: input.tenantId,
      aggregateType: "coding.execution",
      aggregateId: input.state.execution.id,
      expectedStreamVersion: current.streamVersion,
      type: "coding.execution_result_persisted",
      actorId: input.state.execution.executionPrincipalId,
      executionId: input.state.execution.id,
      generation: input.state.execution.generation,
      correlationId: `coding:${input.state.execution.id}:${input.state.execution.generation}`,
      publicPayload: {
        workspaceId: input.state.execution.workspaceId,
        taskId: input.state.task.id,
        status: input.result.status,
      },
    });
    return next;
  });
}

async function persistCodingDecision(
  store: KernelStore,
  tenantId: string,
  state: CodingState,
  result: CodingExecutionResult,
  occurredAt: string,
): Promise<CodingExecutionResult> {
  return store.transact(tenantId, (transaction) => {
    const current = transaction.getProjection<StoredCodingRun>("coding.execution", state.execution.id);
    if (!current?.result) throw new Error("Coding 审批检查点不存在");
    if (current.result.status === "completed" || current.result.status === "cancelled") {
      return current.result;
    }
    if (current.result.status !== "waiting_approval") throw new Error("Coding 执行没有等待审批");
    const task = transaction.getProjection<CodingTask>("coding.task", state.task.id);
    if (!task) throw new Error("CodingTask 不存在");
    let taskVersion = task.streamVersion;
    if (result.status === "completed" && result.deliverable) {
      const deliverableId = `coding-deliverable:${state.execution.id}`;
      const deliverable: Deliverable = {
        id: deliverableId,
        tenantId,
        workspaceId: state.execution.workspaceId,
        pluginId: "coding",
        threadId: state.thread.id,
        executionId: state.execution.id,
        kind: result.deliverable.kind,
        title: result.deliverable.title,
        summary: result.deliverable.summary,
        assetIds: [],
        nextAction: result.deliverable.nextStep,
        streamVersion: 1,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
      transaction.putProjection("deliverable", deliverable.id, deliverable);
      transaction.appendEvent({
        tenantId,
        aggregateType: "deliverable",
        aggregateId: deliverable.id,
        expectedStreamVersion: 0,
        type: "deliverable.created",
        actorId: state.execution.executionPrincipalId,
        executionId: state.execution.id,
        generation: state.execution.generation,
        correlationId: `coding:${state.execution.id}:${state.execution.generation}`,
        publicPayload: {
          workspaceId: state.execution.workspaceId,
          pluginId: "coding",
          taskId: state.task.id,
          kind: deliverable.kind,
          diffDigest: result.deliverable.diffDigest,
        },
      });
    }
    transaction.appendEvent({
      tenantId,
      aggregateType: "coding.task",
      aggregateId: state.task.id,
      expectedStreamVersion: taskVersion++,
      type: result.status === "completed" ? "coding.candidate_approved" : "coding.candidate_denied",
      actorId: state.execution.executionPrincipalId,
      executionId: state.execution.id,
      generation: state.execution.generation,
      correlationId: `coding:${state.execution.id}:${state.execution.generation}`,
      publicPayload: {
        workspaceId: state.execution.workspaceId,
        status: result.status,
        candidateId: result.evidence!.candidateId,
      },
    });
    transaction.putProjection("coding.task", task.id, {
      ...task,
      stage: result.status === "completed" ? "learn" : "approve",
      status: result.status,
      streamVersion: taskVersion,
      updatedAt: occurredAt,
    });
    const next: StoredCodingRun = {
      ...current,
      status: result.status,
      result,
      streamVersion: current.streamVersion + 1,
      updatedAt: occurredAt,
    };
    transaction.putProjection("coding.execution", state.execution.id, next);
    transaction.appendEvent({
      tenantId,
      aggregateType: "coding.execution",
      aggregateId: state.execution.id,
      expectedStreamVersion: current.streamVersion,
      type: result.status === "completed"
        ? "coding.execution_approved"
        : "coding.execution_denied",
      actorId: state.execution.executionPrincipalId,
      executionId: state.execution.id,
      generation: state.execution.generation,
      correlationId: `coding:${state.execution.id}:${state.execution.generation}`,
      publicPayload: { workspaceId: state.execution.workspaceId, status: result.status },
    });
    return result;
  });
}

function acceptanceIntent(
  execution: Execution,
  authority: ExecutionAuthority,
  repository: Repository,
  result: CodingExecutionResult,
  now: string,
): ToolCallIntent {
  const candidate = result.candidates.at(-1);
  if (!candidate || !result.evidence) throw new Error("等待审批的 Coding 结果缺少候选或 Evidence");
  return createIntent({
    execution,
    authority,
    toolId: "coding.candidate.accept",
    effectClass: "privileged",
    intent: `批准 Coding 任务“${result.task.title}”的候选成果`,
    normalizedArguments: {
      candidateId: candidate.id,
      diffDigest: candidate.diffDigest,
      evidenceDigest: result.evidence.digest,
    },
    resourceRefs: [{
      namespace: "repository",
      resourceId: repository.id,
      digest: result.controlPlane.repositoryIndexDigest,
    }],
    now,
  });
}

function createIntent(input: {
  readonly execution: Execution;
  readonly authority: ExecutionAuthority;
  readonly toolId: string;
  readonly effectClass: ToolCallIntent["effectClass"];
  readonly intent: string;
  readonly normalizedArguments: JsonObject;
  readonly resourceRefs: ToolCallIntent["resourceRefs"];
  readonly now: string;
}): ToolCallIntent {
  const argumentsDigest = sha256(input.normalizedArguments);
  const resourcesDigest = sha256(input.resourceRefs);
  return {
    id: `coding-tool:${sha256({
      executionId: input.execution.id,
      generation: input.execution.generation,
      toolId: input.toolId,
      argumentsDigest,
      resourcesDigest,
    })}`,
    executionId: input.execution.id,
    generation: input.execution.generation,
    toolId: input.toolId,
    toolVersion: "0.2.0",
    effectClass: input.effectClass,
    intent: input.intent,
    normalizedArguments: input.normalizedArguments,
    argumentsDigest,
    resourceRefs: input.resourceRefs,
    resourcesDigest,
    authorityCommitment: input.authority.commitment,
    expiresAt: new Date(Date.parse(input.now) + TOOL_INTENT_TTL_MS).toISOString(),
  };
}

async function authorizeTool(
  runtime: RuntimeStore,
  approval: ToolApprovalPort,
  intent: ToolCallIntent,
  signal: AbortSignal,
): Promise<void> {
  await runtime.append({
    executionId: intent.executionId,
    type: "tool/intent",
    payload: intent as unknown as JsonObject,
  });
  const authorization = await approval.authorize(intent, signal);
  if (authorization.mode === "deny") throw new Error(authorization.reason ?? "工具调用已拒绝");
}

async function recordToolResult(
  runtime: RuntimeStore,
  intent: ToolCallIntent,
  result: JsonObject,
): Promise<void> {
  await runtime.append({
    executionId: intent.executionId,
    type: "tool/result",
    payload: { toolCallId: intent.id, status: "completed", result },
  });
}

function providerId(value: string): ByokProviderId {
  if (value === "openai" || value === "deepseek" || value === "anthropic") return value;
  throw new Error("模型厂商预设不受支持");
}

function payloadString(payload: JsonObject, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Job payload 缺少 ${field}`);
  return value;
}

function requiredArgument(input: JsonObject, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`工具参数 ${field} 必须是非空字符串`);
  return value;
}

function assertRelativeRepositoryPath(path: string): void {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`仓库包含不安全路径：${path}`);
  }
}

function assertWithin(root: string, target: string, label: string): void {
  const path = relative(root, target);
  if (!path || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error(`${label} 超出受控目录`);
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 48) || "coding";
}

function schemeString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, arguments_: readonly string[]): Promise<CommandResult> {
  return command(GIT, [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    ...arguments_,
  ], cwd).then(async (result) => {
    await requireSuccess(result, `Git ${arguments_[0] ?? "命令"} 失败`);
    return result;
  });
}

function command(
  executable: string,
  arguments_: readonly string[],
  cwd?: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(executable, [...arguments_], {
      ...(cwd ? { cwd } : {}),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        LC_ALL: "C",
        ...environment,
      },
    }, (error, stdout, stderr) => {
      if (!error) {
        resolveCommand({ exitCode: 0, stdout, stderr });
        return;
      }
      if (typeof error.code === "number") {
        resolveCommand({ exitCode: error.code, stdout, stderr });
        return;
      }
      rejectCommand(new Error("受控命令无法启动", { cause: error }));
    });
  });
}

async function requireSuccess(result: CommandResult, message: string): Promise<void> {
  if (result.exitCode === 0) return;
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(detail ? `${message}：${detail}` : message);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
