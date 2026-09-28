import { randomUUID } from "node:crypto";
import type {
  Approval,
  EventAppendRequest,
  Execution,
  ExecutionAuthority,
  Job,
  JsonObject,
  MemoryRecord,
  MemoryTombstone,
  ToolCallCommitment,
  OrganizationRole,
  ShareGrant,
  Thread,
  ToolCallIntent,
  Workspace,
  WorkspaceMembership,
  WorkspaceRole,
  CodingRunnerId,
} from "@mn/contracts";
import { acceptMemory, rejectMemory } from "./memory.js";
import { assertCurrentApprovalAuthorization, assertCurrentExecutionAuthorization, authorityAllowsIntent, computeExecutionAuthorityCommitment, hasUnsettledToolCalls } from "./authority.js";
import { sha256 } from "./canonical.js";
import { KernelError, StreamVersionConflictError } from "./errors.js";
import { transitionExecution, type ExecutionCommand } from "./execution.js";
import type { InboxItem, ModelConnection } from "./models.js";
import type { KernelStore, KernelTransaction } from "./store.js";
import { appendKernelEvent } from "./projections.js";
import { expireExecutionApprovals } from "./approvals.js";

export interface KernelOptions {
  readonly now?: () => string;
  readonly id?: (kind: string) => string;
  /** 由组合根限定当前部署可接受的密钥引用；内核从不读取密钥正文。 */
  readonly acceptsModelSecretReference?: (reference: string) => boolean;
}

export const PROTECTED_PAYLOAD_KEY_NAMESPACE = "protectedPayloadKey";
export const MEMORY_TOMBSTONE_NAMESPACE = "memoryTombstone";

export interface PreparedMemoryPayload {
  readonly memoryId: string;
  readonly protectedPayloadRef: string;
  readonly plaintextDigest: string;
  readonly keyRecord: object;
}

export interface SubmitTurnInput {
  readonly pluginPackageSha256?: string;
  readonly preparedMessage?: {
    readonly protectedPayloadRef: string;
    readonly keyRecord: object;
  };
  readonly workspaceId: string;
  readonly threadId: string;
  readonly expectedStreamVersion: number;
  readonly message: string;
  readonly agentDefinitionId: string;
  readonly modelBindingId: string;
  readonly executionPrincipalId: string;
  readonly runnerId?: CodingRunnerId;
  readonly authority: Omit<
    ExecutionAuthority,
    "id" | "tenantId" | "executionId" | "streamVersion" | "commitment" | "createdAt" | "updatedAt"
  >;
}

export class AgentOsKernel {
  private readonly now: () => string;
  private readonly nextId: (kind: string) => string;
  private readonly acceptsModelSecretReference: (reference: string) => boolean;

  constructor(private readonly store: KernelStore, options: KernelOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.acceptsModelSecretReference = options.acceptsModelSecretReference
      ?? ((reference) => reference.startsWith("keychain://muniu.v2/"));
    this.nextId = options.id ?? ((kind) => `${kind}-${randomUUID()}`);
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
    return appendKernelEvent(transaction, {
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
    input: {
      readonly name: string;
      readonly viewMode: Workspace["viewMode"];
      readonly pluginIds: readonly string[];
      readonly organizationRoles?: readonly OrganizationRole[];
    },
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
        organizationRoles: [...(input.organizationRoles ?? [])], workspaceRole: "owner",
        streamVersion: 1, createdAt: now, updatedAt: now,
      });
      this.append(transaction, {
        tenantId, aggregateType: "workspace", aggregateId: id, expectedStreamVersion: 0,
        type: "workspace.created", actorId, publicPayload: { viewMode: workspace.viewMode, activePluginIds: workspace.activePluginIds },
      });
      this.append(transaction, { tenantId, aggregateType: "workspaceMembership", aggregateId: `${id}:${actorId}`,
        expectedStreamVersion: 0, type: "workspace_membership.created", actorId,
        publicPayload: { workspaceId: id, principalId: actorId, workspaceRole: "owner" } });
      return workspace;
    });
  }

  async listWorkspaces(tenantId: string): Promise<readonly Workspace[]> {
    return this.store.transact(tenantId, (transaction) =>
      [...transaction.listProjections<Workspace>("workspace")].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  async listWorkspaceMemberships(
    tenantId: string,
    workspaceId: string,
  ): Promise<readonly WorkspaceMembership[]> {
    return this.store.transact(tenantId, (transaction) => {
      if (!transaction.getProjection<Workspace>("workspace", workspaceId)) {
        throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
      }
      return transaction.listProjections<WorkspaceMembership>("membership")
        .filter((membership) => membership.workspaceId === workspaceId && !membership.removedAt)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
          || left.principalId.localeCompare(right.principalId));
    });
  }

  async setWorkspaceMembership(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    workspaceId: string,
    principalId: string,
    expectedStreamVersion: number,
    workspaceRole: WorkspaceRole,
  ): Promise<WorkspaceMembership> {
    const memberId = `${workspaceId}:${principalId}`;
    const initial = await this.initialWorkspaceMembership(tenantId, workspaceId, principalId, expectedStreamVersion);
    return this.mutation(
      tenantId,
      `workspace.membership.set:${memberId}`,
      idempotencyKey,
      { workspaceId, principalId, expectedStreamVersion, workspaceRole },
      (transaction) => {
        if (!transaction.getProjection<Workspace>("workspace", workspaceId)) {
          throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
        }
        if (!principalId.trim()) {
          throw new KernelError("MEMBERSHIP_PRINCIPAL_INVALID", "成员身份不能为空", "选择有效成员");
        }
        const current = transaction.getProjection<WorkspaceMembership>("membership", memberId);
        const actualVersion = current?.streamVersion ?? 0;
        if (actualVersion !== expectedStreamVersion) {
          throw new StreamVersionConflictError(expectedStreamVersion, actualVersion);
        }
        if (current && !current.removedAt && current.workspaceRole === workspaceRole) return current;
        if (current && !current.removedAt && current.workspaceRole === "owner" && workspaceRole !== "owner") {
          this.assertAnotherWorkspaceOwner(transaction, workspaceId, principalId);
        }
        this.initializeWorkspaceMembershipStream(transaction, actorId, current, initial);
        const timestamp = this.now();
        const next: WorkspaceMembership = {
          id: memberId,
          tenantId,
          workspaceId,
          principalId,
          organizationRoles: [...(current?.organizationRoles ?? [])],
          workspaceRole,
          streamVersion: actualVersion + 1,
          createdAt: current?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        transaction.putProjection("membership", memberId, next);
        if (!["owner", "operator"].includes(workspaceRole)) {
          this.revokeMemberExecutions(transaction, tenantId, actorId, workspaceId, principalId, timestamp, workspaceRole !== "reviewer");
        }
        this.append(transaction, {
          tenantId,
          aggregateType: "workspaceMembership",
          aggregateId: memberId,
          expectedStreamVersion: actualVersion,
          type: current?.removedAt
            ? "workspace_membership.restored"
            : current
              ? "workspace_membership.role_changed"
              : "workspace_membership.created",
          actorId,
          publicPayload: { workspaceId, principalId, workspaceRole },
        });
        return next;
      },
    );
  }

  async removeWorkspaceMembership(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    workspaceId: string,
    principalId: string,
    expectedStreamVersion: number,
  ): Promise<WorkspaceMembership> {
    const memberId = `${workspaceId}:${principalId}`;
    const initial = await this.initialWorkspaceMembership(tenantId, workspaceId, principalId, expectedStreamVersion);
    return this.mutation(
      tenantId,
      `workspace.membership.remove:${memberId}`,
      idempotencyKey,
      { workspaceId, principalId, expectedStreamVersion },
      (transaction) => {
        if (!transaction.getProjection<Workspace>("workspace", workspaceId)) {
          throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
        }
        const current = transaction.getProjection<WorkspaceMembership>("membership", memberId);
        if (!current || current.workspaceId !== workspaceId) {
          throw new KernelError("MEMBERSHIP_NOT_FOUND", "工作区成员不存在", "刷新成员列表");
        }
        if (current.streamVersion !== expectedStreamVersion) {
          throw new StreamVersionConflictError(expectedStreamVersion, current.streamVersion);
        }
        if (current.removedAt) return current;
        if (current.workspaceRole === "owner") {
          this.assertAnotherWorkspaceOwner(transaction, workspaceId, principalId);
        }
        this.initializeWorkspaceMembershipStream(transaction, actorId, current, initial);
        const timestamp = this.now();
        const next: WorkspaceMembership = {
          ...current,
          removedAt: timestamp,
          streamVersion: current.streamVersion + 1,
          updatedAt: timestamp,
        };
        transaction.putProjection("membership", memberId, next);
        this.revokeMemberExecutions(transaction, tenantId, actorId, workspaceId, principalId, timestamp);
        this.append(transaction, {
          tenantId,
          aggregateType: "workspaceMembership",
          aggregateId: memberId,
          expectedStreamVersion: current.streamVersion,
          type: "workspace_membership.removed",
          actorId,
          publicPayload: { workspaceId, principalId, previousRole: current.workspaceRole },
        });
        return next;
      },
    );
  }

  /** Current 0.2 workspaces originally recorded their first owner in workspace.created only. */
  private async initialWorkspaceMembership(tenantId: string, workspaceId: string, principalId: string, expectedVersion: number):
    Promise<{ readonly membership: WorkspaceMembership; readonly eventId: string } | undefined> {
    if (expectedVersion !== 1) return undefined;
    const memberId = `${workspaceId}:${principalId}`;
    const read = this.store.readEventHistory ?? this.store.readEvents;
    let position = 0;
    let initial: { readonly membership: WorkspaceMembership; readonly eventId: string } | undefined;
    for (;;) {
      const page = await read.call(this.store, tenantId, position, 500);
      for (const event of page.events) {
        if (event.aggregateType === "workspaceMembership" && event.aggregateId === memberId) return undefined;
        if (event.type !== "workspace.created" || event.aggregateId !== workspaceId || event.actorId !== principalId) continue;
        const facts = event.publicPayload.projectionFacts;
        if (!facts || typeof facts !== "object" || Array.isArray(facts)) continue;
        const changes = (facts as JsonObject).changes;
        if (!Array.isArray(changes)) continue;
        for (const value of changes) {
          if (!value || typeof value !== "object" || Array.isArray(value)
            || value.namespace !== "membership" || value.id !== memberId || !value.value) continue;
          const member = value.value as unknown as WorkspaceMembership;
          if (member.id === memberId && member.tenantId === tenantId && member.workspaceId === workspaceId
            && member.principalId === principalId && member.workspaceRole === "owner"
            && member.streamVersion === 1 && !member.removedAt) initial = { membership: member, eventId: event.id };
        }
      }
      if (page.events.length < 500) return initial;
      position = page.events.at(-1)!.position;
    }
  }

  private initializeWorkspaceMembershipStream(transaction: KernelTransaction, actorId: string,
    current: WorkspaceMembership | undefined,
    initial: { readonly membership: WorkspaceMembership; readonly eventId: string } | undefined): void {
    if (!current || !initial || sha256(current) !== sha256(initial.membership)) return;
    this.append(transaction, { tenantId: current.tenantId, aggregateType: "workspaceMembership", aggregateId: current.id,
      expectedStreamVersion: 0, type: "workspace_membership.created", actorId, causationId: initial.eventId,
      publicPayload: { workspaceId: current.workspaceId, principalId: current.principalId, workspaceRole: "owner" } });
  }

  private revokeMemberExecutions(
    transaction: KernelTransaction, tenantId: string, actorId: string,
    workspaceId: string, principalId: string, occurredAt: string, revokeReviews = true,
  ): void {
    const approvedExecutions = new Set(transaction.listProjections<Approval>("approval")
      .filter(approval => revokeReviews && approval.workspaceId === workspaceId
        && approval.decidedBy === principalId && approval.status === "approved_once")
      .map(approval => approval.executionId));
    for (const execution of transaction.listProjections<Execution>("execution")) {
      if (execution.workspaceId !== workspaceId
        || (execution.initiatedBy !== principalId && !approvedExecutions.has(execution.id))
        || ["completed", "failed", "cancelled"].includes(execution.status)) continue;
      const status = execution.status === "needs_reconciliation" || hasUnsettledToolCalls(transaction, execution.id)
        ? "needs_reconciliation" : "interrupted";
      transaction.putProjection("execution", execution.id, { ...execution, status,
        failureCode: "EXECUTION_AUTHORIZATION_REVOKED", streamVersion: execution.streamVersion + 1, updatedAt: occurredAt });
      this.append(transaction, { tenantId, aggregateType: "execution", aggregateId: execution.id,
        expectedStreamVersion: execution.streamVersion, type: "execution.authorization_revoked", actorId,
        executionId: execution.id, generation: execution.generation,
        publicPayload: { workspaceId, previousStatus: execution.status, status, reason: "workspace_membership_revoked" } });
      expireExecutionApprovals(transaction, { tenantId, actorId, executionId: execution.id,
        generation: execution.generation, occurredAt, reason: "workspace_membership_revoked" });
    }
  }

  private assertAnotherWorkspaceOwner(
    transaction: KernelTransaction,
    workspaceId: string,
    principalId: string,
  ): void {
    const hasAnotherOwner = transaction.listProjections<WorkspaceMembership>("membership")
      .some((membership) => membership.workspaceId === workspaceId
        && membership.principalId !== principalId
        && membership.workspaceRole === "owner"
        && !membership.removedAt);
    if (!hasAnotherOwner) {
      throw new KernelError(
        "LAST_WORKSPACE_OWNER",
        "不能移除或降级工作区的最后一名所有者",
        "先将另一名成员设为所有者",
      );
    }
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
        type: "thread.created", actorId, publicPayload: { workspaceId: thread.workspaceId, pluginId: thread.pluginId },
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
      readonly runnerId?: CodingRunnerId;
      readonly authority: Omit<ExecutionAuthority, "id" | "tenantId" | "executionId" | "commitment" | "streamVersion" | "createdAt" | "updatedAt">;
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
        ...(input.runnerId ? { runnerId: input.runnerId } : {}),
      };
      const authority: ExecutionAuthority = {
        ...input.authority,
        id: authorityId,
        tenantId,
        executionId: id,
        commitment: computeExecutionAuthorityCommitment({
          ...input.authority,
          executionId: id,
          ...(input.runnerId ? { runnerId: input.runnerId } : {}),
        }),
        streamVersion: 1,
        createdAt: now,
        updatedAt: now,
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
    const { preparedMessage, ...request } = input;
    return this.mutation(tenantId, `thread.turn:${input.threadId}`, idempotencyKey, request, (transaction) => {
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
      const commitment = computeExecutionAuthorityCommitment({
        executionId,
        workspaceId: input.workspaceId,
        principalId: input.authority.principalId,
        toolIds: input.authority.toolIds,
        dataScopes: input.authority.dataScopes,
        autoAllowedEffects: input.authority.autoAllowedEffects,
        budget: input.authority.budget,
        parentAuthorityId: input.authority.parentAuthorityId,
        runnerId: input.runnerId,
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
        ...(input.pluginPackageSha256 ? { pluginPackageSha256: input.pluginPackageSha256 } : {}),
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
        ...(input.runnerId ? { runnerId: input.runnerId } : {}),
        streamVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const job: Job = {
        id: jobId,
        tenantId,
        workspaceId: input.workspaceId,
        kind: "agent.execution.run",
        payload: { executionId, ...(preparedMessage
          ? { protectedPayloadRef: preparedMessage.protectedPayloadRef, threadId: thread.id }
          : { message: input.message.trim() }) },
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
        threadStreamVersion: thread.streamVersion + 1,
        role: "user",
        ...(preparedMessage ? { protectedPayloadRef: preparedMessage.protectedPayloadRef }
          : { message: input.message.trim() }),
        generation: 1,
        createdAt: timestamp,
      });
      if (preparedMessage) {
        transaction.putProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE,
          preparedMessage.protectedPayloadRef, preparedMessage.keyRecord);
      }
      transaction.putProjection("execution", executionId, execution);
      transaction.putProjection("authority", authorityId, authority);
      transaction.putProjection("job", jobId, job);
      this.append(transaction, {
        tenantId,
        aggregateType: "thread",
        aggregateId: thread.id,
        expectedStreamVersion: thread.streamVersion,
        type: "thread.turn_submitted",
        ...(preparedMessage ? { protectedPayloadRef: preparedMessage.protectedPayloadRef } : {}),
        actorId,
        executionId,
        generation: 1,
        publicPayload: {
          workspaceId: input.workspaceId,
          executionId,
          pluginId: thread.pluginId,
          turnId,
          ...(input.runnerId ? { runnerId: input.runnerId } : {}),
        },
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
          ...(input.runnerId ? { runnerId: input.runnerId } : {}),
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
      if (command === "start" || command === "resume") assertCurrentExecutionAuthorization(transaction, execution);
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
      if (command === "resume" || command === "cancel") {
        for (const item of transaction.listProjections<InboxItem>("inbox")) {
          if (item.executionId === executionId && item.id.startsWith("runtime-pause:") && item.status === "open") {
            transaction.putProjection("inbox", item.id, { ...item, status: "resolved" });
          }
        }
      }
      this.append(transaction, {
        tenantId, aggregateType: "execution", aggregateId: executionId,
        expectedStreamVersion, type: `execution.${nextStatus}`, actorId, executionId,
        generation: next.generation, publicPayload: { previousStatus: execution.status, status: nextStatus },
      });
      if (command === "resume" || command === "cancel" || command === "pause" || command === "interrupt") {
        expireExecutionApprovals(transaction, { tenantId, executionId, actorId, generation: next.generation,
          occurredAt: now, reason: command === "resume" ? "execution_resumed_with_new_generation" : `execution_${nextStatus}` });
      }
      if (command === "resume") {
        const jobId = this.nextId("job");
        const job: Job = {
          id: jobId,
          tenantId,
          workspaceId: execution.workspaceId,
          kind: "agent.execution.run",
          payload: { executionId, command: "resume", generation: next.generation },
          status: "available",
          attempts: 0,
          availableAt: now,
          fencingToken: 0,
          idempotencyKey: `execution:${executionId}:generation:${next.generation}`,
          streamVersion: 1,
          createdAt: now,
          updatedAt: now,
        };
        transaction.putProjection("job", jobId, job);
        this.append(transaction, {
          tenantId,
          aggregateType: "job",
          aggregateId: jobId,
          expectedStreamVersion: 0,
          type: "job.available",
          actorId,
          executionId,
          generation: next.generation,
          publicPayload: {
            workspaceId: execution.workspaceId,
            executionId,
            kind: job.kind,
            command: "resume",
          },
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
          payload: { workspaceId: execution.workspaceId, executionId, jobId },
          availableAt: now,
        });
      }
      return next;
    });
  }

  async requestToolApproval(
    tenantId: string,
    actorId: string,
    idempotencyKey: string,
    intent: ToolCallIntent,
  ): Promise<{ readonly mode: "auto"; readonly intent: ToolCallCommitment } | { readonly mode: "approval"; readonly approval: Approval }> {
    return this.mutation(tenantId, `tool.intent:${intent.executionId}`, idempotencyKey, intent, (transaction) => {
      const execution = transaction.getProjection<Execution>("execution", intent.executionId);
      if (!execution) throw new KernelError("EXECUTION_NOT_FOUND", "执行不存在", "刷新执行状态");
      assertCurrentExecutionAuthorization(transaction, execution);
      if (execution.status !== "running") throw new KernelError("EXECUTION_NOT_RUNNING", "当前执行不能创建工具调用", "刷新执行状态");
      if (transaction.getProjection("toolIntent", intent.id)) throw new KernelError("TOOL_CALL_ID_REUSED", "工具调用标识已被使用", "为新调用生成独立标识");
      const expiresAt = Date.parse(intent.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(this.now())) {
        throw new KernelError("TOOL_INTENT_EXPIRED", "工具调用意图已过期", "重新准备并审阅当前操作");
      }
      const authority = transaction.getProjection<ExecutionAuthority>("authority", execution.authorityId);
      if (!authority) throw new KernelError("AUTHORITY_NOT_FOUND", "执行权限不存在", "停止执行并检查审计记录");
      const mode = authorityAllowsIntent(authority, intent);
      if (execution.generation !== intent.generation) {
        throw new KernelError("STALE_GENERATION", "工具调用来自旧执行代次", "重新运行当前 turn");
      }
      const { normalizedArguments: _arguments, ...commitment } = intent;
      transaction.putProjection("toolIntent", intent.id, commitment);
      const updatedExecution = { ...execution, streamVersion: execution.streamVersion + 1, updatedAt: this.now() };
      transaction.putProjection("execution", execution.id, updatedExecution);
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
      if (mode === "auto") return { mode, intent: commitment } as const;
      const now = this.now();
      const approvalId = this.nextId("approval");
      const approval: Approval = {
        id: approvalId, tenantId, workspaceId: execution.workspaceId, executionId: execution.id,
        toolCallId: intent.id, effectClass: intent.effectClass, intent: intent.intent,
        resourceRefs: intent.resourceRefs, authorityCommitment: intent.authorityCommitment,
        expiresAt: intent.expiresAt, status: "pending", streamVersion: 1, createdAt: now, updatedAt: now,
      };
      transaction.putProjection("approval", approvalId, approval);
      const inbox: InboxItem = {
        id: `approval:${approvalId}`, tenantId, workspaceId: execution.workspaceId,
        executionId: execution.id, kind: "approval", title: "操作需要批准", summary: intent.intent,
        risk: intent.effectClass, resourceSummary: intent.resourceRefs.map((resource) => resource.resourceId).join("、"),
        expiresAt: intent.expiresAt, createdAt: now, status: "open",
      };
      transaction.putProjection("inbox", inbox.id, inbox);
      transaction.putProjection("execution", execution.id, { ...updatedExecution, status: "waiting_approval" });
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
      if (decision === "approve_once") {
        assertCurrentExecutionAuthorization(transaction, execution);
        assertCurrentApprovalAuthorization(transaction, { ...approval, decidedBy: actorId });
      }
      if (execution.status !== "waiting_approval") {
        throw new KernelError(
          "APPROVAL_EXECUTION_NOT_WAITING",
          "关联执行已不再等待批准",
          "刷新执行与收件箱状态",
        );
      }
      const intent = transaction.getProjection<ToolCallCommitment>("toolIntent", approval.toolCallId);
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
    input: Omit<
      MemoryRecord,
      "id" | "tenantId" | "streamVersion" | "status" | "createdAt" | "updatedAt"
      | "shareGrantIds" | "protectedPayloadRef"
    > & { readonly preparedPayload?: PreparedMemoryPayload },
  ): Promise<MemoryRecord> {
    const { preparedPayload } = input;
    const metadata = {
      workspaceId: input.workspaceId,
      scopeType: input.scopeType,
      namespace: input.namespace,
      resourceId: input.resourceId,
      sourceEventId: input.sourceEventId,
      confidence: input.confidence,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.derivedFromMemoryId ? { derivedFromMemoryId: input.derivedFromMemoryId } : {}),
      ...(input.derivedViaShareGrantId
        ? { derivedViaShareGrantId: input.derivedViaShareGrantId }
        : {}),
    };
    return this.mutation(tenantId, "memory.propose", idempotencyKey, {
      ...metadata,
      payloadDigest: preparedPayload?.plaintextDigest,
    }, (transaction) => {
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
      if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
        throw new KernelError("MEMORY_CONFIDENCE_INVALID", "记忆置信度必须在 0 到 1 之间", "修正置信度");
      }
      const now = this.now();
      const id = preparedPayload?.memoryId ?? this.nextId("memory");
      const memory: MemoryRecord = {
        ...metadata,
        id,
        tenantId,
        streamVersion: 1,
        status: "proposed",
        shareGrantIds: [],
        ...(preparedPayload ? { protectedPayloadRef: preparedPayload.protectedPayloadRef } : {}),
        createdAt: now, updatedAt: now,
      };
      if (preparedPayload) {
        if (!preparedPayload.memoryId.trim() || !preparedPayload.protectedPayloadRef.trim()) {
          throw new KernelError(
            "PROTECTED_PAYLOAD_INVALID",
            "受保护记忆引用无效",
            "重新提交记忆内容",
          );
        }
        if (transaction.getProjection(
          PROTECTED_PAYLOAD_KEY_NAMESPACE,
          preparedPayload.protectedPayloadRef,
        )) {
          throw new KernelError(
            "PROTECTED_PAYLOAD_CONFLICT",
            "受保护记忆引用已存在",
            "重新提交记忆内容",
            true,
          );
        }
        transaction.putProjection(
          PROTECTED_PAYLOAD_KEY_NAMESPACE,
          preparedPayload.protectedPayloadRef,
          preparedPayload.keyRecord,
        );
      }
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
    revision: { readonly confidence: number; readonly preparedPayload?: PreparedMemoryPayload },
  ): Promise<MemoryRecord> {
    const { preparedPayload } = revision;
    return this.mutation(
      tenantId,
      `memory.revise:${memoryId}`,
      idempotencyKey,
      {
        expectedStreamVersion,
        confidence: revision.confidence,
        payloadDigest: preparedPayload?.plaintextDigest,
      },
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
        if (preparedPayload && (preparedPayload.memoryId !== memoryId
          || !preparedPayload.protectedPayloadRef.trim()
          || preparedPayload.protectedPayloadRef === memory.protectedPayloadRef)) {
          throw new KernelError(
            "PROTECTED_PAYLOAD_INVALID",
            "受保护记忆引用无效",
            "重新提交记忆内容",
          );
        }
        const next: MemoryRecord = {
          ...memory,
          confidence: revision.confidence,
          ...(preparedPayload ? { protectedPayloadRef: preparedPayload.protectedPayloadRef } : {}),
          updatedAt: this.now(),
          streamVersion: memory.streamVersion + 1,
        };
        if (memory.protectedPayloadRef && preparedPayload) {
          transaction.deleteProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, memory.protectedPayloadRef);
        }
        if (preparedPayload) {
          if (transaction.getProjection(
            PROTECTED_PAYLOAD_KEY_NAMESPACE,
            preparedPayload.protectedPayloadRef,
          )) {
            throw new KernelError(
              "PROTECTED_PAYLOAD_CONFLICT",
              "受保护记忆引用已存在",
              "重新提交记忆内容",
              true,
            );
          }
          transaction.putProjection(
            PROTECTED_PAYLOAD_KEY_NAMESPACE,
            preparedPayload.protectedPayloadRef,
            preparedPayload.keyRecord,
          );
        }
        transaction.putProjection("memory", memoryId, next);
        this.append(transaction, {
          tenantId,
          aggregateType: "memory",
          aggregateId: memoryId,
          expectedStreamVersion,
          type: "memory.proposal_revised",
          actorId,
          publicPayload: { workspaceId: memory.workspaceId, confidence: next.confidence },
          ...(preparedPayload ? { protectedPayloadRef: preparedPayload.protectedPayloadRef } : {}),
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
  ): Promise<MemoryTombstone> {
    return this.mutation(
      tenantId,
      `memory.delete:${memoryId}`,
      idempotencyKey,
      { expectedStreamVersion, reason },
      (transaction) => {
        const current = transaction.getProjection<MemoryRecord>("memory", memoryId);
        if (!current) throw new KernelError("MEMORY_NOT_FOUND", "记忆不存在", "刷新记忆列表");
        if (current.streamVersion !== expectedStreamVersion) {
          throw new KernelError("STREAM_VERSION_CONFLICT", "记忆版本已变化", "刷新记忆后重试", true);
        }
        const deletedAt = this.now();
        const objectDigest = sha256({
          id: current.id,
          namespace: current.namespace,
          resourceId: current.resourceId,
        });
        const tombstone: MemoryTombstone = {
          id: current.id,
          tenantId: current.tenantId,
          workspaceId: current.workspaceId,
          status: "deleted",
          objectDigest,
          reason,
          deletedAt,
          streamVersion: current.streamVersion + 1,
          createdAt: current.createdAt,
          updatedAt: deletedAt,
        };
        if (current.protectedPayloadRef) {
          transaction.deleteProjection(PROTECTED_PAYLOAD_KEY_NAMESPACE, current.protectedPayloadRef);
        }
        transaction.deleteProjection("memory", memoryId);
        transaction.putProjection(MEMORY_TOMBSTONE_NAMESPACE, memoryId, tombstone);
        const invalidatedIds = new Set([memoryId]);
        const descendants = transaction.listProjections<MemoryRecord>("memory");
        let changed = true;
        while (changed) {
          changed = false;
          for (const derived of descendants) {
            if (!derived.derivedFromMemoryId || invalidatedIds.has(derived.id)
              || !invalidatedIds.has(derived.derivedFromMemoryId)) continue;
            invalidatedIds.add(derived.id);
            changed = true;
            if (derived.status === "invalidated") continue;
            transaction.putProjection("memory", derived.id, {
              ...derived, status: "invalidated", updatedAt: deletedAt,
              streamVersion: derived.streamVersion + 1,
            });
            this.append(transaction, {
              tenantId, aggregateType: "memory", aggregateId: derived.id,
              expectedStreamVersion: derived.streamVersion, type: "memory.invalidated", actorId,
              publicPayload: { workspaceId: derived.workspaceId, deletedSourceDigest: objectDigest },
            });
          }
        }
        this.append(transaction, {
          tenantId, aggregateType: "memory", aggregateId: memoryId, expectedStreamVersion,
          type: "memory.deleted", actorId,
          publicPayload: {
            workspaceId: current.workspaceId,
            objectDigest,
          },
        });
        return tombstone;
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
        publicPayload: { presetId: connection.presetId },
      });
      return connection;
    });
  }
}
