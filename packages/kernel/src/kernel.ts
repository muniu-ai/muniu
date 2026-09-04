import type {
  Approval,
  EventAppendRequest,
  Execution,
  ExecutionAuthority,
  Job,
  JsonObject,
  MemoryRecord,
  ShareGrant,
  Thread,
  ToolCallIntent,
  Workspace,
} from "@mn/contracts";
import { acceptMemory, deleteMemory, rejectMemory } from "./memory.js";
import { authorityAllowsIntent } from "./authority.js";
import { sha256 } from "./canonical.js";
import { KernelError, StreamVersionConflictError } from "./errors.js";
import { transitionExecution, type ExecutionCommand } from "./execution.js";
import type { InboxItem, ModelConnection } from "./models.js";
import type { KernelStore, KernelTransaction } from "./store.js";

export interface KernelOptions {
  readonly now?: () => string;
  readonly id?: (kind: string) => string;
  /** 由组合根限定当前部署可接受的密钥引用；内核从不读取密钥正文。 */
  readonly acceptsModelSecretReference?: (reference: string) => boolean;
}

export interface ProtectedPayloadKeyDestroyer {
  /** 必须幂等：进程中断后可能用同一引用再次确认销毁。 */
  destroy(reference: string): Promise<void>;
}

export interface SubmitTurnInput {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly expectedStreamVersion: number;
  readonly message: string;
  readonly agentDefinitionId: string;
  readonly modelBindingId: string;
  readonly executionPrincipalId: string;
  readonly authority: Omit<
    ExecutionAuthority,
    "id" | "tenantId" | "executionId" | "streamVersion" | "commitment" | "createdAt" | "updatedAt"
  >;
}

function payload(value: unknown): JsonObject {
  return value as JsonObject;
}

export class AgentOsKernel {
  private readonly now: () => string;
  private readonly nextId: (kind: string) => string;
  private readonly acceptsModelSecretReference: (reference: string) => boolean;

  constructor(private readonly store: KernelStore, options: KernelOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.acceptsModelSecretReference = options.acceptsModelSecretReference
      ?? ((reference) => reference.startsWith("keychain://muniu.v2/"));
    let counter = 0;
    this.nextId = options.id ?? ((kind) => `${kind}-${++counter}`);
  }

  private async mutation<T>(
    tenantId: string,
    scope: string,
    idempotencyKey: string,
    request: unknown,
    work: (transaction: KernelTransaction) => T,
  ): Promise<T> {
    if (!idempotencyKey.trim()) {
      throw new KernelError("IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key", "为本次写操作提供唯一键");
    }
    return this.store.transact(tenantId, (transaction) => {
      const requestDigest = sha256(request);
      const previous = transaction.getIdempotency(scope, idempotencyKey);
      if (previous) {
        if (previous.requestDigest !== requestDigest) {
          throw new KernelError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求", "使用新的 Idempotency-Key");
        }
        return previous.response as T;
      }
      const response = work(transaction);
      transaction.putIdempotency({
        tenantId,
        scope,
        key: idempotencyKey,
        requestDigest,
        response,
        createdAt: this.now(),
      });
      return response;
    });
  }

  private append(
    transaction: KernelTransaction,
    request: Omit<EventAppendRequest, "generation" | "correlationId"> & {
      readonly generation?: number;
      readonly correlationId?: string;
    },
  ) {
    return transaction.appendEvent({
      ...request,
      generation: request.generation ?? 0,
      correlationId: request.correlationId ?? this.nextId("correlation"),
    });
  }

  async bootstrapLocal(idempotencyKey: string): Promise<{ tenantId: string; principalId: string }> {
    return this.mutation("local", "bootstrap", idempotencyKey, {}, (transaction) => {
      const now = this.now();
      transaction.putProjection("tenant", "local", {
        id: "local", tenantId: "local", streamVersion: 1, slug: "local", displayName: "本地",
        profile: "local", createdAt: now, updatedAt: now,
      });
      transaction.putProjection("principal", "local-owner", {
        id: "local-owner", tenantId: "local", streamVersion: 1, kind: "human", displayName: "本地所有者",
        createdAt: now, updatedAt: now,
      });
      this.append(transaction, {
        tenantId: "local", aggregateType: "tenant", aggregateId: "local", expectedStreamVersion: 0,
        type: "tenant.bootstrapped", actorId: "local-owner", publicPayload: { principalId: "local-owner" },
      });
      return { tenantId: "local", principalId: "local-owner" };
    });
  }

  async createWorkspace(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    input: { readonly name: string; readonly viewMode: Workspace["viewMode"]; readonly pluginIds: readonly string[] },
  ): Promise<Workspace> {
    return this.mutation(tenantId, "workspace.create", idempotencyKey, input, (transaction) => {
      const now = this.now();
      const id = this.nextId("workspace");
      const workspace: Workspace = {
        id, tenantId, streamVersion: 1, name: input.name.trim(), viewMode: input.viewMode,
        activePluginIds: [...input.pluginIds], createdAt: now, updatedAt: now,
      };
      if (!workspace.name) throw new KernelError("INVALID_WORKSPACE", "工作区名称不能为空", "填写工作区名称");
      transaction.putProjection("workspace", id, workspace);
      transaction.putProjection("membership", `${id}:${actorId}`, {
        id: `${id}:${actorId}`, tenantId, workspaceId: id, principalId: actorId,
        organizationRoles: [], workspaceRole: "owner", streamVersion: 1, createdAt: now, updatedAt: now,
      });
      this.append(transaction, {
        tenantId, aggregateType: "workspace", aggregateId: id, expectedStreamVersion: 0,
        type: "workspace.created", actorId, publicPayload: payload(workspace),
      });
      return workspace;
    });
  }

  async listWorkspaces(tenantId: string): Promise<readonly Workspace[]> {
    return this.store.transact(tenantId, (transaction) =>
      [...transaction.listProjections<Workspace>("workspace")].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  async listThreads(tenantId: string, workspaceId: string): Promise<readonly Thread[]> {
    return this.store.transact(tenantId, (transaction) =>
      transaction.listProjections<Thread>("thread")
        .filter((thread) => thread.workspaceId === workspaceId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  async listInbox(tenantId: string, workspaceId?: string): Promise<readonly InboxItem[]> {
    return this.store.transact(tenantId, (transaction) =>
      transaction.listProjections<InboxItem>("inbox")
        .filter((item) => item.status === "open" && (!workspaceId || item.workspaceId === workspaceId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  async createThread(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    input: { readonly workspaceId: string; readonly subject: string; readonly pluginId: string },
  ): Promise<Thread> {
    return this.mutation(tenantId, "thread.create", idempotencyKey, input, (transaction) => {
      const workspace = transaction.getProjection<Workspace>("workspace", input.workspaceId);
      if (!workspace) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
      if (!workspace.activePluginIds.includes(input.pluginId)) {
        throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用此插件", "先在工作区启用插件");
      }
      const now = this.now();
      const id = this.nextId("thread");
      const thread: Thread = {
        id, tenantId, workspaceId: input.workspaceId, subject: input.subject.trim(), pluginId: input.pluginId,
        streamVersion: 1, createdAt: now, updatedAt: now,
      };
      transaction.putProjection("thread", id, thread);
      this.append(transaction, {
        tenantId, aggregateType: "thread", aggregateId: id, expectedStreamVersion: 0,
        type: "thread.created", actorId, publicPayload: payload(thread),
      });
      return thread;
    });
  }

  async createExecution(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    input: {
      readonly workspaceId: string;
      readonly threadId: string;
      readonly pluginId: string;
      readonly agentDefinitionId: string;
      readonly modelBindingId: string;
      readonly executionPrincipalId: string;
      readonly authority: Omit<ExecutionAuthority, "id" | "tenantId" | "executionId" | "streamVersion" | "createdAt" | "updatedAt">;
    },
  ): Promise<Execution> {
    return this.mutation(tenantId, "execution.create", idempotencyKey, input, (transaction) => {
      const now = this.now();
      const id = this.nextId("execution");
      const authorityId = this.nextId("authority");
      const execution: Execution = {
        id, tenantId, workspaceId: input.workspaceId, threadId: input.threadId, pluginId: input.pluginId,
        agentDefinitionId: input.agentDefinitionId, modelBindingId: input.modelBindingId,
        initiatedBy: actorId, executionPrincipalId: input.executionPrincipalId, generation: 1,
        status: "queued", authorityId, streamVersion: 1, createdAt: now, updatedAt: now,
      };
      const authority: ExecutionAuthority = {
        ...input.authority, id: authorityId, tenantId, executionId: id, streamVersion: 1,
        createdAt: now, updatedAt: now,
      };
      transaction.putProjection("execution", id, execution);
      transaction.putProjection("authority", authorityId, authority);
      this.append(transaction, {
        tenantId, aggregateType: "execution", aggregateId: id, expectedStreamVersion: 0,
        type: "execution.queued", actorId, executionId: id, generation: 1,
        publicPayload: { workspaceId: input.workspaceId, threadId: input.threadId, authorityId },
      });
      return execution;
    });
  }

  async submitTurn(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    input: SubmitTurnInput,
  ): Promise<Execution> {
    return this.mutation(tenantId, `thread.turn:${input.threadId}`, idempotencyKey, input, (transaction) => {
      const workspace = transaction.getProjection<Workspace>("workspace", input.workspaceId);
      if (!workspace) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
      const thread = transaction.getProjection<Thread>("thread", input.threadId);
      if (!thread || thread.workspaceId !== input.workspaceId) {
        throw new KernelError("THREAD_NOT_FOUND", "会话不存在", "刷新工作区会话");
      }
      if (thread.streamVersion !== input.expectedStreamVersion) {
        throw new StreamVersionConflictError(input.expectedStreamVersion, thread.streamVersion);
      }
      if (thread.pluginId !== workspace.activePluginIds.find((pluginId) => pluginId === thread.pluginId)) {
        throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用此插件", "先在工作区启用插件");
      }
      if (!input.message.trim()) {
        throw new KernelError("INVALID_BODY", "message 必须是非空字符串", "填写 message");
      }
      if (input.authority.workspaceId !== input.workspaceId
        || input.authority.principalId !== input.executionPrincipalId) {
        throw new KernelError("AUTHORITY_INVALID", "执行权限与工作区或执行身份不一致", "重新创建执行权限");
      }

      const timestamp = this.now();
      const executionId = this.nextId("execution");
      const authorityId = this.nextId("authority");
      const turnId = this.nextId("turn");
      const jobId = this.nextId("job");
      const commitment = sha256({
        executionId,
        workspaceId: input.workspaceId,
        principalId: input.authority.principalId,
        toolIds: input.authority.toolIds,
        dataScopes: input.authority.dataScopes,
        autoAllowedEffects: input.authority.autoAllowedEffects,
        budget: input.authority.budget,
        parentAuthorityId: input.authority.parentAuthorityId,
      });
      const authority: ExecutionAuthority = {
        ...input.authority,
        id: authorityId,
        tenantId,
        executionId,
        commitment,
        streamVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const execution: Execution = {
        id: executionId,
        tenantId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        pluginId: thread.pluginId,
        agentDefinitionId: input.agentDefinitionId,
        modelBindingId: input.modelBindingId,
        initiatedBy: actorId,
        executionPrincipalId: input.executionPrincipalId,
        generation: 1,
        status: "queued",
        authorityId,
        streamVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const job: Job = {
        id: jobId,
        tenantId,
        workspaceId: input.workspaceId,
        kind: "agent.execution.run",
        payload: { executionId, message: input.message.trim() },
        status: "available",
        attempts: 0,
        availableAt: timestamp,
        fencingToken: 0,
        idempotencyKey: `execution:${executionId}:generation:1`,
        streamVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      transaction.putProjection("thread", thread.id, {
        ...thread,
        streamVersion: thread.streamVersion + 1,
        updatedAt: timestamp,
      });
      transaction.putProjection("session-log-entry", turnId, {
        id: turnId,
        tenantId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        executionId,
        role: "user",
        message: input.message.trim(),
        generation: 1,
        createdAt: timestamp,
      });
      transaction.putProjection("execution", executionId, execution);
      transaction.putProjection("authority", authorityId, authority);
      transaction.putProjection("job", jobId, job);
      this.append(transaction, {
        tenantId,
        aggregateType: "thread",
        aggregateId: thread.id,
        expectedStreamVersion: thread.streamVersion,
        type: "thread.turn_submitted",
        actorId,
        executionId,
        generation: 1,
        publicPayload: { workspaceId: input.workspaceId, executionId, pluginId: thread.pluginId },
      });
      this.append(transaction, {
        tenantId,
        aggregateType: "execution",
        aggregateId: executionId,
        expectedStreamVersion: 0,
        type: "execution.queued",
        actorId,
        executionId,
        generation: 1,
        publicPayload: {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          authorityId,
          authorityCommitment: commitment,
        },
      });
      this.append(transaction, {
        tenantId,
        aggregateType: "job",
        aggregateId: jobId,
        expectedStreamVersion: 0,
        type: "job.available",
        actorId,
        executionId,
        generation: 1,
        publicPayload: { workspaceId: input.workspaceId, executionId, kind: job.kind },
      });
      transaction.putJob({
        id: job.id,
        tenantId,
        workspaceId: job.workspaceId,
        kind: job.kind,
        payload: job.payload,
        availableAt: job.availableAt,
        idempotencyKey: job.idempotencyKey,
      });
      transaction.putOutbox({
        id: this.nextId("outbox"),
        tenantId,
        topic: "job.available",
        payload: { workspaceId: input.workspaceId, executionId, jobId },
        availableAt: timestamp,
      });
      return execution;
    });
  }

  async commandExecution(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    executionId: string,
    expectedStreamVersion: number,
    command: ExecutionCommand,
  ): Promise<Execution> {
    return this.mutation(tenantId, `execution.command:${executionId}`, idempotencyKey, { expectedStreamVersion, command }, (transaction) => {
      const execution = transaction.getProjection<Execution>("execution", executionId);
      if (!execution) throw new KernelError("EXECUTION_NOT_FOUND", "执行不存在", "刷新执行列表");
      if (execution.streamVersion !== expectedStreamVersion) {
        throw new KernelError("STREAM_VERSION_CONFLICT", "执行版本已变化", "刷新执行状态后重试", true);
      }
      const nextStatus = transitionExecution(execution.status, command);
      const now = this.now();
      const next: Execution = {
        ...execution,
        status: nextStatus,
        generation: command === "resume" ? execution.generation + 1 : execution.generation,
        streamVersion: execution.streamVersion + 1,
        updatedAt: now,
        startedAt: command === "start" ? now : execution.startedAt,
        finishedAt: ["completed", "failed", "cancelled"].includes(nextStatus) ? now : execution.finishedAt,
      };
      transaction.putProjection("execution", executionId, next);
      this.append(transaction, {
        tenantId, aggregateType: "execution", aggregateId: executionId,
        expectedStreamVersion, type: `execution.${nextStatus}`, actorId, executionId,
        generation: next.generation, publicPayload: { previousStatus: execution.status, status: nextStatus },
      });
      return next;
    });
  }

  async requestToolApproval(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    intent: ToolCallIntent,
  ): Promise<{ readonly mode: "auto"; readonly intent: ToolCallIntent } | { readonly mode: "approval"; readonly approval: Approval }> {
    return this.mutation(tenantId, `tool.intent:${intent.executionId}`, idempotencyKey, intent, (transaction) => {
      const execution = transaction.getProjection<Execution>("execution", intent.executionId);
      if (!execution) throw new KernelError("EXECUTION_NOT_FOUND", "执行不存在", "刷新执行状态");
      const authority = transaction.getProjection<ExecutionAuthority>("authority", execution.authorityId);
      if (!authority) throw new KernelError("AUTHORITY_NOT_FOUND", "执行权限不存在", "停止执行并检查审计记录");
      const mode = authorityAllowsIntent(authority, intent);
      if (execution.generation !== intent.generation) {
        throw new KernelError("STALE_GENERATION", "工具调用来自旧执行代次", "重新运行当前 turn");
      }
      transaction.putProjection("toolIntent", intent.id, intent);
      this.append(transaction, {
        tenantId, aggregateType: "execution", aggregateId: execution.id,
        expectedStreamVersion: execution.streamVersion, type: "tool.intent_recorded", actorId,
        executionId: execution.id, generation: execution.generation,
        publicPayload: {
          toolCallId: intent.id, toolId: intent.toolId, toolVersion: intent.toolVersion,
          effectClass: intent.effectClass, argumentsDigest: intent.argumentsDigest,
          resourcesDigest: intent.resourcesDigest, authorityCommitment: intent.authorityCommitment,
        },
      });
      const updatedExecution = { ...execution, streamVersion: execution.streamVersion + 1, updatedAt: this.now() };
      transaction.putProjection("execution", execution.id, updatedExecution);
      if (mode === "auto") return { mode, intent } as const;
      const now = this.now();
      const approvalId = this.nextId("approval");
      const approval: Approval = {
        id: approvalId, tenantId, workspaceId: execution.workspaceId, executionId: execution.id,
        toolCallId: intent.id, effectClass: intent.effectClass, intent: intent.intent,
        resourceRefs: intent.resourceRefs, authorityCommitment: intent.authorityCommitment,
        expiresAt: intent.expiresAt, status: "pending", streamVersion: 1, createdAt: now, updatedAt: now,
      };
      transaction.putProjection("approval", approvalId, approval);
      this.append(transaction, {
        tenantId,
        aggregateType: "approval",
        aggregateId: approvalId,
        expectedStreamVersion: 0,
        type: "approval.requested",
        actorId,
        executionId: execution.id,
        generation: execution.generation,
        publicPayload: {
          toolCallId: intent.id,
          effectClass: intent.effectClass,
          authorityCommitment: intent.authorityCommitment,
          expiresAt: intent.expiresAt,
        },
      });
      const inbox: InboxItem = {
        id: `approval:${approvalId}`, tenantId, workspaceId: execution.workspaceId,
        executionId: execution.id, kind: "approval", title: "操作需要批准", summary: intent.intent,
        risk: intent.effectClass, resourceSummary: intent.resourceRefs.map((resource) => resource.resourceId).join("、"),
        expiresAt: intent.expiresAt, createdAt: now, status: "open",
      };
      transaction.putProjection("inbox", inbox.id, inbox);
      transaction.putProjection("execution", execution.id, { ...updatedExecution, status: "waiting_approval" });
      return { mode, approval } as const;
    });
  }

  async decideApproval(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    approvalId: string,
    expectedStreamVersion: number,
    decision: "approve_once" | "deny",
  ): Promise<Approval> {
    return this.mutation(tenantId, `approval.decide:${approvalId}`, idempotencyKey, { expectedStreamVersion, decision }, (transaction) => {
      const approval = transaction.getProjection<Approval>("approval", approvalId);
      if (!approval) throw new KernelError("APPROVAL_NOT_FOUND", "批准请求不存在", "刷新收件箱");
      if (approval.streamVersion !== expectedStreamVersion) {
        throw new KernelError("STREAM_VERSION_CONFLICT", "批准请求版本已变化", "刷新收件箱后重试", true);
      }
      if (approval.status !== "pending") {
        throw new KernelError("APPROVAL_ALREADY_DECIDED", "此操作已经处理", "刷新收件箱");
      }
      const now = this.now();
      if (approval.expiresAt <= now) {
        throw new KernelError("APPROVAL_EXPIRED", "批准请求已过期", "让 Agent 生成新的操作请求");
      }
      const execution = transaction.getProjection<Execution>("execution", approval.executionId);
      if (!execution) {
        throw new KernelError(
          "EXECUTION_NOT_FOUND",
          "批准请求关联的执行不存在",
          "停止处理并检查审计记录",
        );
      }
      if (execution.status !== "waiting_approval") {
        throw new KernelError(
          "APPROVAL_EXECUTION_NOT_WAITING",
          "关联执行已不再等待批准",
          "刷新执行与收件箱状态",
        );
      }
      const intent = transaction.getProjection<ToolCallIntent>("toolIntent", approval.toolCallId);
      if (!intent
        || intent.executionId !== execution.id
        || intent.generation !== execution.generation
        || intent.authorityCommitment !== approval.authorityCommitment) {
        throw new KernelError(
          "STALE_APPROVAL",
          "工具调用代次或权限承诺已变化",
          "让 Agent 生成新的操作请求",
        );
      }
      const next: Approval = {
        ...approval,
        status: decision === "approve_once" ? "approved_once" : "denied",
        decidedBy: actorId,
        decidedAt: now,
        updatedAt: now,
        streamVersion: approval.streamVersion + 1,
      };
      transaction.putProjection("approval", approvalId, next);
      const inboxId = `approval:${approvalId}`;
      const inbox = transaction.getProjection<InboxItem>("inbox", inboxId);
      if (inbox) transaction.putProjection("inbox", inboxId, { ...inbox, status: "resolved" });
      const executionStatus = decision === "approve_once" ? "running" : "failed";
      const updatedExecution: Execution = {
        ...execution,
        status: executionStatus,
        streamVersion: execution.streamVersion + 1,
        updatedAt: now,
        ...(decision === "deny" ? { finishedAt: now, failureCode: "TOOL_APPROVAL_DENIED" } : {}),
      };
      transaction.putProjection("execution", execution.id, updatedExecution);
      this.append(transaction, {
        tenantId, aggregateType: "approval", aggregateId: approvalId, expectedStreamVersion,
        type: decision === "approve_once" ? "approval.approved_once" : "approval.denied",
        actorId, executionId: approval.executionId,
        generation: execution.generation,
        publicPayload: { toolCallId: approval.toolCallId, decision },
      });
      this.append(transaction, {
        tenantId,
        aggregateType: "execution",
        aggregateId: execution.id,
        expectedStreamVersion: execution.streamVersion,
        type: `execution.approval_${decision === "approve_once" ? "approved_once" : "denied"}`,
        actorId,
        executionId: execution.id,
        generation: execution.generation,
        publicPayload: {
          approvalId,
          toolCallId: approval.toolCallId,
          decision,
          status: executionStatus,
        },
      });
      return next;
    });
  }

  async proposeMemory(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    input: Omit<MemoryRecord, "id" | "tenantId" | "streamVersion" | "status" | "createdAt" | "updatedAt" | "shareGrantIds">,
  ): Promise<MemoryRecord> {
    return this.mutation(tenantId, "memory.propose", idempotencyKey, input, (transaction) => {
      if (Boolean(input.derivedFromMemoryId) !== Boolean(input.derivedViaShareGrantId)) {
        throw new KernelError(
          "MEMORY_DERIVATION_INVALID",
          "派生记忆必须同时记录来源记忆与共享授权",
          "重新生成记忆提案",
        );
      }
      if (input.derivedFromMemoryId && input.derivedViaShareGrantId) {
        const source = transaction.getProjection<MemoryRecord>("memory", input.derivedFromMemoryId);
        const grant = transaction.getProjection<ShareGrant>("shareGrant", input.derivedViaShareGrantId);
        if (!source || source.status !== "accepted" || !grant || grant.revokedAt
          || grant.memoryId !== source.id || grant.toNamespace !== input.namespace
          || grant.workspaceId !== input.workspaceId) {
          throw new KernelError(
            "MEMORY_SHARE_REQUIRED",
            "派生记忆缺少有效的跨 namespace 授权",
            "重新授权后再生成记忆提案",
          );
        }
      }
      const now = this.now();
      const id = this.nextId("memory");
      const memory: MemoryRecord = {
        ...input, id, tenantId, streamVersion: 1, status: "proposed", shareGrantIds: [],
        createdAt: now, updatedAt: now,
      };
      transaction.putProjection("memory", id, memory);
      this.append(transaction, {
        tenantId, aggregateType: "memory", aggregateId: id, expectedStreamVersion: 0,
        type: "memory.proposed", actorId,
        publicPayload: { workspaceId: memory.workspaceId, scopeType: memory.scopeType, namespace: memory.namespace, resourceId: memory.resourceId, confidence: memory.confidence },
        protectedPayloadRef: memory.protectedPayloadRef,
      });
      return memory;
    });
  }

  async decideMemory(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    memoryId: string,
    expectedStreamVersion: number,
    decision: "accept" | "reject",
  ): Promise<MemoryRecord> {
    return this.mutation(tenantId, `memory.decide:${memoryId}`, idempotencyKey, { expectedStreamVersion, decision }, (transaction) => {
      const memory = transaction.getProjection<MemoryRecord>("memory", memoryId);
      if (!memory) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
      if (memory.streamVersion !== expectedStreamVersion) {
        throw new KernelError("STREAM_VERSION_CONFLICT", "记忆版本已变化", "刷新记忆后重试", true);
      }
      const next = decision === "accept" ? acceptMemory(memory, this.now()) : rejectMemory(memory, this.now());
      transaction.putProjection("memory", memoryId, next);
      this.append(transaction, {
        tenantId, aggregateType: "memory", aggregateId: memoryId, expectedStreamVersion,
        type: `memory.${decision === "accept" ? "accepted" : "rejected"}`,
        actorId, publicPayload: { decision },
      });
      return next;
    });
  }

  async reviseMemoryProposal(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    memoryId: string,
    expectedStreamVersion: number,
    revision: { readonly confidence: number; readonly value: JsonObject },
  ): Promise<MemoryRecord> {
    return this.mutation(
      tenantId,
      `memory.revise:${memoryId}`,
      idempotencyKey,
      { expectedStreamVersion, revision },
      (transaction) => {
        const memory = transaction.getProjection<MemoryRecord>("memory", memoryId);
        if (!memory) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
        if (memory.streamVersion !== expectedStreamVersion) {
          throw new KernelError("STREAM_VERSION_CONFLICT", "记忆版本已变化", "刷新记忆后重试", true);
        }
        if (memory.status !== "proposed") {
          throw new KernelError("MEMORY_NOT_PROPOSED", "只有待确认记忆可以修改", "创建新的记忆提案");
        }
        if (!Number.isFinite(revision.confidence)
          || revision.confidence < 0 || revision.confidence > 1) {
          throw new KernelError("MEMORY_CONFIDENCE_INVALID", "记忆置信度必须在 0 到 1 之间", "修正置信度");
        }
        const next: MemoryRecord = {
          ...memory,
          confidence: revision.confidence,
          value: revision.value,
          updatedAt: this.now(),
          streamVersion: memory.streamVersion + 1,
        };
        transaction.putProjection("memory", memoryId, next);
        this.append(transaction, {
          tenantId,
          aggregateType: "memory",
          aggregateId: memoryId,
          expectedStreamVersion,
          type: "memory.proposal_revised",
          actorId,
          publicPayload: { workspaceId: memory.workspaceId, confidence: next.confidence },
        });
        return next;
      },
    );
  }

  async createShareGrant(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    memoryId: string,
    expectedStreamVersion: number,
    toNamespace: string,
  ): Promise<ShareGrant> {
    return this.mutation(tenantId, `memory.share:${memoryId}`, idempotencyKey, { expectedStreamVersion, toNamespace }, (transaction) => {
      const memory = transaction.getProjection<MemoryRecord>("memory", memoryId);
      if (!memory || memory.status !== "accepted") {
        throw new KernelError("MEMORY_NOT_SHAREABLE", "只有已确认记忆可以共享", "先确认记忆");
      }
      if (memory.streamVersion !== expectedStreamVersion) {
        throw new KernelError("STREAM_VERSION_CONFLICT", "记忆版本已变化", "刷新记忆后重试", true);
      }
      const now = this.now();
      const id = this.nextId("share-grant");
      const grant: ShareGrant = {
        id, tenantId, workspaceId: memory.workspaceId, memoryId, fromNamespace: memory.namespace,
        toNamespace, grantedBy: actorId, grantedAt: now, streamVersion: 1, createdAt: now, updatedAt: now,
      };
      transaction.putProjection("shareGrant", id, grant);
      transaction.putProjection("memory", memoryId, {
        ...memory, shareGrantIds: [...memory.shareGrantIds, id], streamVersion: memory.streamVersion + 1, updatedAt: now,
      });
      this.append(transaction, {
        tenantId, aggregateType: "memory", aggregateId: memoryId, expectedStreamVersion,
        type: "memory.shared", actorId, publicPayload: { grantId: id, fromNamespace: memory.namespace, toNamespace },
      });
      this.append(transaction, {
        tenantId, aggregateType: "shareGrant", aggregateId: id, expectedStreamVersion: 0,
        type: "share_grant.created", actorId,
        publicPayload: {
          workspaceId: memory.workspaceId,
          memoryId,
          fromNamespace: memory.namespace,
          toNamespace,
        },
      });
      return grant;
    });
  }

  async revokeShareGrant(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    grantId: string,
    expectedStreamVersion: number,
  ): Promise<ShareGrant> {
    return this.mutation(tenantId, `shareGrant.revoke:${grantId}`, idempotencyKey, { expectedStreamVersion }, (transaction) => {
      const grant = transaction.getProjection<ShareGrant>("shareGrant", grantId);
      if (!grant) throw new KernelError("SHARE_GRANT_NOT_FOUND", "共享授权不存在", "刷新授权列表");
      if (grant.streamVersion !== expectedStreamVersion) {
        throw new KernelError("STREAM_VERSION_CONFLICT", "共享授权版本已变化", "刷新授权后重试", true);
      }
      if (grant.revokedAt) return grant;
      const now = this.now();
      const next: ShareGrant = { ...grant, revokedAt: now, updatedAt: now, streamVersion: grant.streamVersion + 1 };
      transaction.putProjection("shareGrant", grantId, next);
      const readableMemories = transaction.listProjections<MemoryRecord>("memory")
        .filter((memory) => memory.status !== "deleted" && memory.status !== "invalidated");
      const derived: MemoryRecord[] = [];
      const invalidatedIds = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const memory of readableMemories) {
          if (invalidatedIds.has(memory.id)) continue;
          const directlyShared = memory.derivedViaShareGrantId === grantId;
          const transitivelyDerived = memory.derivedFromMemoryId !== undefined
            && invalidatedIds.has(memory.derivedFromMemoryId);
          if (!directlyShared && !transitivelyDerived) continue;
          invalidatedIds.add(memory.id);
          derived.push(memory);
          changed = true;
        }
      }
      for (const memory of derived) {
        const invalidated = {
          ...memory,
          status: "invalidated" as const,
          updatedAt: now,
          streamVersion: memory.streamVersion + 1,
        };
        transaction.putProjection("memory", memory.id, invalidated);
        this.append(transaction, {
          tenantId,
          aggregateType: "memory",
          aggregateId: memory.id,
          expectedStreamVersion: memory.streamVersion,
          type: "memory.invalidated",
          actorId,
          publicPayload: {
            workspaceId: memory.workspaceId,
            revokedGrantId: grantId,
            ...(memory.derivedViaShareGrantId === grantId
              ? {}
              : { invalidatedViaMemoryId: memory.derivedFromMemoryId }),
          },
        });
      }
      this.append(transaction, {
        tenantId, aggregateType: "shareGrant", aggregateId: grantId, expectedStreamVersion,
        type: "share_grant.revoked", actorId,
        publicPayload: {
          workspaceId: grant.workspaceId,
          memoryId: grant.memoryId,
          toNamespace: grant.toNamespace,
          invalidatedMemoryCount: derived.length,
        },
      });
      return next;
    });
  }

  async deleteMemory(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    memoryId: string,
    expectedStreamVersion: number,
    reason: string,
    keys: ProtectedPayloadKeyDestroyer,
  ): Promise<MemoryRecord> {
    const pending = await this.mutation(
      tenantId,
      `memory.delete.request:${memoryId}`,
      idempotencyKey,
      { expectedStreamVersion, reason },
      (transaction) => {
      const current = transaction.getProjection<MemoryRecord>("memory", memoryId);
      if (!current) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
      if (current.streamVersion !== expectedStreamVersion) {
        throw new KernelError("STREAM_VERSION_CONFLICT", "记忆版本已变化", "刷新记忆后重试", true);
      }
      const next: MemoryRecord = {
        ...current,
        status: "deletion_pending",
        value: undefined,
        shareGrantIds: [],
        updatedAt: this.now(),
        streamVersion: current.streamVersion + 1,
      };
      transaction.putProjection("memory", memoryId, next);
      this.append(transaction, {
        tenantId, aggregateType: "memory", aggregateId: memoryId, expectedStreamVersion,
        type: "memory.deletion_requested", actorId,
        publicPayload: {
          workspaceId: current.workspaceId,
          objectDigest: sha256({ id: current.id, namespace: current.namespace, resourceId: current.resourceId }),
        },
      });
      return next;
    });
    const latest = await this.store.transact(tenantId, (transaction) =>
      transaction.getProjection<MemoryRecord>("memory", memoryId));
    if (latest?.status === "deleted") return latest;
    if (pending.protectedPayloadRef) await keys.destroy(pending.protectedPayloadRef);
    return this.mutation(
      tenantId,
      `memory.delete.finalize:${memoryId}`,
      idempotencyKey,
      { deletionRequestVersion: pending.streamVersion, reason },
      (transaction) => {
        const current = transaction.getProjection<MemoryRecord>("memory", memoryId);
        if (!current || current.status !== "deletion_pending"
          || current.streamVersion !== pending.streamVersion) {
          throw new KernelError(
            "MEMORY_DELETE_RECONCILIATION_REQUIRED",
            "无法确认敏感记忆删除结果",
            "核对密钥状态与审计记录",
          );
        }
        const next = deleteMemory(current, this.now());
        transaction.putProjection("memory", memoryId, next);
        this.append(transaction, {
          tenantId,
          aggregateType: "memory",
          aggregateId: memoryId,
          expectedStreamVersion: current.streamVersion,
          type: "memory.deleted",
          actorId,
          publicPayload: {
            workspaceId: current.workspaceId,
            objectDigest: sha256({ id: current.id, namespace: current.namespace, resourceId: current.resourceId }),
            reason,
          },
        });
        return next;
      },
    );
  }

  async saveModelConnection(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    input: Omit<ModelConnection, "id" | "tenantId" | "streamVersion" | "status">,
  ): Promise<ModelConnection> {
    return this.mutation(tenantId, "modelConnection.create", idempotencyKey, input, (transaction) => {
      if (!this.acceptsModelSecretReference(input.secretRef)) {
        throw new KernelError(
          "INVALID_SECRET_REFERENCE",
          "模型密钥引用不属于当前部署的受信存储",
          "通过当前部署配置的密钥存储重新保存密钥",
        );
      }
      const connection: ModelConnection = {
        ...input, id: this.nextId("model-connection"), tenantId, streamVersion: 1, status: "pending",
      };
      transaction.putProjection("modelConnection", connection.id, connection);
      this.append(transaction, {
        tenantId, aggregateType: "modelConnection", aggregateId: connection.id, expectedStreamVersion: 0,
        type: "model_connection.saved", actorId,
        publicPayload: { presetId: connection.presetId, displayName: connection.displayName },
      });
      return connection;
    });
  }
}
