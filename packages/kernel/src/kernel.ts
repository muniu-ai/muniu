import type {
  Approval,
  EventAppendRequest,
  Execution,
  ExecutionAuthority,
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
import { KernelError } from "./errors.js";
import { transitionExecution, type ExecutionCommand } from "./execution.js";
import type { InboxItem, ModelConnection } from "./models.js";
import type { KernelStore, KernelTransaction } from "./store.js";

export interface KernelOptions {
  readonly now?: () => string;
  readonly id?: (kind: string) => string;
}

export interface ProtectedPayloadKeyDestroyer {
  destroy(reference: string): Promise<void>;
}

function payload(value: unknown): JsonObject {
  return value as JsonObject;
}

export class AgentOsKernel {
  private readonly now: () => string;
  private readonly nextId: (kind: string) => string;

  constructor(private readonly store: KernelStore, options: KernelOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
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
      const execution = transaction.getProjection<Execution>("execution", approval.executionId);
      if (execution) {
        transaction.putProjection("execution", execution.id, {
          ...execution,
          status: decision === "approve_once" ? "running" : "failed",
          updatedAt: now,
        });
      }
      this.append(transaction, {
        tenantId, aggregateType: "approval", aggregateId: approvalId, expectedStreamVersion,
        type: decision === "approve_once" ? "approval.approved_once" : "approval.denied",
        actorId, executionId: approval.executionId,
        generation: execution?.generation ?? 0,
        publicPayload: { toolCallId: approval.toolCallId, decision },
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
      this.append(transaction, {
        tenantId, aggregateType: "shareGrant", aggregateId: grantId, expectedStreamVersion,
        type: "share_grant.revoked", actorId, publicPayload: { memoryId: grant.memoryId, toNamespace: grant.toNamespace },
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
    const memory = await this.store.transact(tenantId, (transaction) => transaction.getProjection<MemoryRecord>("memory", memoryId));
    if (!memory) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
    if (memory.protectedPayloadRef) await keys.destroy(memory.protectedPayloadRef);
    return this.mutation(tenantId, `memory.delete:${memoryId}`, idempotencyKey, { expectedStreamVersion, reason }, (transaction) => {
      const current = transaction.getProjection<MemoryRecord>("memory", memoryId);
      if (!current || current.streamVersion !== expectedStreamVersion) {
        throw new KernelError("STREAM_VERSION_CONFLICT", "记忆版本已变化", "刷新记忆后重试", true);
      }
      const next = deleteMemory(current, this.now());
      transaction.putProjection("memory", memoryId, next);
      this.append(transaction, {
        tenantId, aggregateType: "memory", aggregateId: memoryId, expectedStreamVersion,
        type: "memory.deleted", actorId,
        publicPayload: { objectDigest: sha256({ id: current.id, namespace: current.namespace, resourceId: current.resourceId }), reason },
      });
      return next;
    });
  }

  async saveModelConnection(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    input: Omit<ModelConnection, "id" | "tenantId" | "streamVersion" | "status">,
  ): Promise<ModelConnection> {
    return this.mutation(tenantId, "modelConnection.create", idempotencyKey, input, (transaction) => {
      if (!input.secretRef.startsWith("keychain://muniu.v2/")) {
        throw new KernelError("INVALID_SECRET_REFERENCE", "模型密钥必须存入 v2 Keychain", "重新保存密钥");
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
