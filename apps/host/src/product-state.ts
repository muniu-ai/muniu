// SPDX-License-Identifier: Apache-2.0
import { appendKernelEvent } from "@mn/kernel";

import type { Approval, Asset, Deliverable, Execution, ExecutionAuthority, JsonObject, Thread, Workspace, CodingTaskSummaryV2 } from "@mn/contracts";
import { KernelProjectionRuntimeStore } from "@mn/agent-runtime";
import { createProtectedRuntimeStore, type RuntimeProtection } from "@mn/worker";
import { executionMetering, meteringCostSummary } from "./execution-metering.js";
import {
  KernelError,
  sha256,
  type InboxItem,
  type KernelStore,
  type KernelTransaction,
} from "@mn/kernel";
import {
  createCodingTask,
  type CodingExecutionResult,
  type CodingControlPlaneCommitment,
  type CodingTask,
  type Repository,
} from "@mn/plugin-coding";
import {
  createOpportunityDraft,
  exportOpportunityDeliverables,
  OpcDomainError,
  reduceOpcEvents,
  type OpcAppendRequest,
  type OpcEvent,
  type OpcRepository,
  type OpportunityAggregate,
  type StoredOpcEvent,
} from "@mn/plugin-opc";
import { encodePluginWorkspace } from "./plugin-workspace.js";

export { encodePluginWorkspace } from "./plugin-workspace.js";

const OPC_PROJECTION = "opc.opportunity";
const OPC_EVENTS_PROJECTION = "opc.events";
const CODING_REPOSITORY_PROJECTION = "coding.repository";
const CODING_TASK_PROJECTION = "coding.task";

interface ScopedWorkspace {
  readonly tenantId: string;
  readonly workspaceId: string;
}

interface VersionedRepository extends Repository {
  readonly streamVersion: number;
  readonly updatedAt: string;
}

interface ProductStateOptions {
  readonly store: KernelStore;
  readonly now: () => string;
  readonly id: (kind: string) => string;
}

interface ProductMutationOptions extends ProductStateOptions {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly expectedStreamVersion: number;
  readonly input: string;
}

interface OpcExportOptions extends Omit<ProductMutationOptions, "input"> {
  readonly opportunityId: string;
}

interface StoredOpcDeliverable extends Deliverable {
  readonly validationStatus: string;
  readonly content: JsonObject;
}

function decodePluginWorkspace(value: string): ScopedWorkspace {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2
      && typeof parsed[0] === "string" && parsed[0]
      && typeof parsed[1] === "string" && parsed[1]) {
      return { tenantId: parsed[0], workspaceId: parsed[1] };
    }
  } catch {
    // 统一在下面返回不包含内部细节的错误。
  }
  throw new OpcDomainError("INVALID_INPUT", "工作区作用域无效", "重新打开工作区后重试");
}

function opcEventsKey(workspaceId: string, opportunityId: string): string {
  return `${workspaceId.length}:${workspaceId}${opportunityId}`;
}

function ensureWorkspace(transaction: KernelTransaction, workspaceId: string): Workspace {
  const workspace = transaction.getProjection<Workspace>("workspace", workspaceId);
  if (!workspace) throw new KernelError("WORKSPACE_NOT_FOUND", "工作区不存在", "刷新工作区列表");
  return workspace;
}

function ensureVersionZero(expectedStreamVersion: number): void {
  if (expectedStreamVersion !== 0) {
    throw new KernelError("STREAM_VERSION_CONFLICT", "新对象的预期版本必须为 0", "刷新工作区后重试", true);
  }
}

function idempotentMutation<T>(
  transaction: KernelTransaction,
  tenantId: string,
  scope: string,
  key: string,
  request: unknown,
  createdAt: string,
  work: () => T,
): T {
  const requestDigest = sha256(request);
  const previous = transaction.getIdempotency(scope, key);
  if (previous) {
    if (previous.requestDigest !== requestDigest) {
      throw new KernelError("IDEMPOTENCY_KEY_REUSED", "幂等键已用于不同请求", "使用新的 Idempotency-Key");
    }
    return previous.response as T;
  }
  const response = work();
  transaction.putIdempotency({ tenantId, scope, key, requestDigest, response, createdAt });
  return response;
}

export class KernelOpcRepository implements OpcRepository {
  constructor(private readonly options: ProductStateOptions) {}

  async load(scopedWorkspaceId: string, opportunityId: string): Promise<OpportunityAggregate | undefined> {
    const scope = decodePluginWorkspace(scopedWorkspaceId);
    return this.options.store.transact(scope.tenantId, (transaction) => {
      const value = transaction.getProjection<OpportunityAggregate>(OPC_PROJECTION, opportunityId);
      return value?.workspaceId === scope.workspaceId ? value : undefined;
    });
  }

  async append(request: OpcAppendRequest): Promise<OpportunityAggregate> {
    if (request.events.length === 0) {
      throw new OpcDomainError("INVALID_INPUT", "事件列表不能为空", "至少提交一个领域事件");
    }
    const scope = decodePluginWorkspace(request.workspaceId);
    return this.options.store.transact(scope.tenantId, (transaction) => {
      const append = () => {
        ensureWorkspace(transaction, scope.workspaceId);
        const key = opcEventsKey(scope.workspaceId, request.opportunityId);
        const current = transaction.getProjection<readonly StoredOpcEvent[]>(OPC_EVENTS_PROJECTION, key) ?? [];
        if (current.length !== request.expectedStreamVersion) {
          throw new OpcDomainError(
            "STREAM_VERSION_CONFLICT",
            `预期版本 ${request.expectedStreamVersion}，实际版本 ${current.length}`,
            "重新读取机会后重试",
          );
        }
        const ids = new Set(current.map((event) => event.eventId));
        const appended = request.events.map((event, index): StoredOpcEvent => {
          const eventId = event.eventId ?? this.options.id("opc-event");
          if (ids.has(eventId)) throw new OpcDomainError("DUPLICATE_ID", "领域事件 ID 已存在", "生成新的事件 ID 后重试");
          ids.add(eventId);
          return { ...event, eventId, streamVersion: current.length + index + 1 } as StoredOpcEvent;
        });
        for (const event of appended) {
          validateOpcAssetReference(transaction, scope.tenantId, scope.workspaceId, event);
        }
        const events = [...current, ...appended];
        const aggregate = reduceOpcEvents(scope.workspaceId, request.opportunityId, events);
        if (!aggregate) throw new OpcDomainError("INVALID_INPUT", "事件未生成机会", "先提交机会捕获事件");
        transaction.putProjection(OPC_EVENTS_PROJECTION, key, events);
        transaction.putProjection(OPC_PROJECTION, request.opportunityId, aggregate);
        for (const event of appended) {
          appendKernelEvent(transaction, {
            tenantId: scope.tenantId,
            aggregateType: "opc.opportunity",
            aggregateId: request.opportunityId,
            expectedStreamVersion: event.streamVersion - 1,
            type: event.type,
            actorId: event.actor.id,
            generation: 0,
            correlationId: this.options.id("correlation"),
            publicPayload: {
              workspaceId: scope.workspaceId,
              state: aggregate.state,
              evidenceLevel: aggregate.evidenceLevel,
            },
          });
        }
        return aggregate;
      };
      return request.idempotency
        ? idempotentMutation(
            transaction,
            scope.tenantId,
            `${request.idempotency.scope}:${scope.workspaceId}:${request.opportunityId}`,
            request.idempotency.key,
            request.idempotency.request,
            this.options.now(),
            append,
          )
        : append();
    });
  }

  async events(scopedWorkspaceId: string, opportunityId: string): Promise<readonly StoredOpcEvent[]> {
    const scope = decodePluginWorkspace(scopedWorkspaceId);
    return this.options.store.transact(scope.tenantId, (transaction) =>
      transaction.getProjection<readonly StoredOpcEvent[]>(
        OPC_EVENTS_PROJECTION,
        opcEventsKey(scope.workspaceId, opportunityId),
      ) ?? []);
  }
}

function validateOpcAssetReference(
  transaction: KernelTransaction,
  tenantId: string,
  workspaceId: string,
  event: StoredOpcEvent,
): void {
  if (event.type === "opportunity.signal_recorded" && event.payload.signal.sourceKind === "file") {
    requireOpcAsset(transaction, tenantId, workspaceId, event.payload.signal.sourceAssetId ?? "");
  }
  if (event.type !== "opportunity.interview_recorded") return;
  const asset = requireOpcAsset(transaction, tenantId, workspaceId, event.payload.rawRecordAssetId);
  if (!asset.protected) {
    throw new KernelError(
      "OPC_INTERVIEW_ASSET_NOT_PROTECTED",
      "访谈原文必须使用受保护附件",
      "重新上传并启用受保护存储",
    );
  }
  if (asset.mediaType !== "text/plain" && asset.mediaType !== "text/markdown") {
    throw new KernelError(
      "OPC_INTERVIEW_ASSET_TYPE_INVALID",
      "访谈原文只接受纯文本或 Markdown",
      "上传 UTF-8 编码的 .txt 或 .md 文件",
    );
  }
}

function requireOpcAsset(
  transaction: KernelTransaction,
  tenantId: string,
  workspaceId: string,
  assetId: string,
): Asset {
  const asset = transaction.getProjection<Asset>("asset", assetId);
  if (!asset) {
    throw new KernelError(
      "OPC_ASSET_NOT_FOUND",
      "OPC 引用的附件不存在或已删除",
      "重新上传附件并更新引用",
    );
  }
  if (asset.tenantId !== tenantId) {
    throw new KernelError(
      "OPC_ASSET_NOT_FOUND",
      "OPC 引用的附件不存在或已删除",
      "重新上传附件并更新引用",
    );
  }
  if (asset.workspaceId !== workspaceId) {
    throw new KernelError(
      "OPC_ASSET_SCOPE_MISMATCH",
      "OPC 不能引用其他工作区的附件",
      "选择当前工作区中的附件",
    );
  }
  return asset;
}

export async function captureOpportunity(options: ProductMutationOptions): Promise<OpportunityAggregate> {
  ensureVersionZero(options.expectedStreamVersion);
  return options.store.transact(options.tenantId, (transaction) => idempotentMutation(
    transaction,
    options.tenantId,
    `opc.opportunity.capture:${options.workspaceId}`,
    options.idempotencyKey,
    { expectedStreamVersion: options.expectedStreamVersion, input: options.input },
    options.now(),
    () => {
      const workspace = ensureWorkspace(transaction, options.workspaceId);
      if (!workspace.activePluginIds.includes("opc")) {
        throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用 OPC", "先在工作区启用 OPC");
      }
      const draft = createOpportunityDraft(options.input);
      const opportunityId = options.id("opportunity");
      const domainEvent: OpcEvent = {
        eventId: options.id("opc-event"),
        type: "opportunity.captured",
        actor: { id: options.actorId, kind: "human" },
        occurredAt: options.now(),
        payload: { title: draft.title, rawInput: draft.rawInput },
      };
      const storedEvent = { ...domainEvent, streamVersion: 1 } as StoredOpcEvent;
      const aggregate = reduceOpcEvents(options.workspaceId, opportunityId, [storedEvent]);
      if (!aggregate) throw new OpcDomainError("INVALID_INPUT", "机会创建失败", "检查输入后重试");
      const threadId = options.id("thread");
      const thread: Thread = {
        id: threadId,
        tenantId: options.tenantId,
        workspaceId: options.workspaceId,
        subject: aggregate.title,
        pluginId: "opc",
        resourceRef: { namespace: "opc.opportunity", resourceId: opportunityId },
        streamVersion: 1,
        createdAt: options.now(),
        updatedAt: options.now(),
      };
      transaction.putProjection(OPC_EVENTS_PROJECTION, opcEventsKey(options.workspaceId, opportunityId), [storedEvent]);
      transaction.putProjection(OPC_PROJECTION, opportunityId, aggregate);
      transaction.putProjection("thread", threadId, thread);
      appendKernelEvent(transaction, {
        tenantId: options.tenantId,
        aggregateType: "thread",
        aggregateId: threadId,
        expectedStreamVersion: 0,
        type: "thread.created",
        actorId: options.actorId,
        generation: 0,
        correlationId: options.id("correlation"),
        publicPayload: {
          workspaceId: options.workspaceId,
          pluginId: "opc",
          resourceNamespace: "opc.opportunity",
          resourceId: opportunityId,
        },
      });
      appendKernelEvent(transaction, {
        tenantId: options.tenantId,
        aggregateType: "opc.opportunity",
        aggregateId: opportunityId,
        expectedStreamVersion: 0,
        type: domainEvent.type,
        actorId: options.actorId,
        generation: 0,
        correlationId: options.id("correlation"),
        publicPayload: {
          workspaceId: options.workspaceId,
          title: aggregate.title,
          state: aggregate.state,
          evidenceLevel: aggregate.evidenceLevel,
          reviewRequired: draft.reviewRequired,
          inferredFields: draft.inferredFields,
        },
      });
      return aggregate;
    },
  ));
}

export async function exportOpcOpportunity(options: OpcExportOptions): Promise<readonly StoredOpcDeliverable[]> {
  return options.store.transact(options.tenantId, (transaction) => idempotentMutation(
    transaction,
    options.tenantId,
    `opc.opportunity.export:${options.workspaceId}:${options.opportunityId}`,
    options.idempotencyKey,
    { expectedStreamVersion: options.expectedStreamVersion, opportunityId: options.opportunityId },
    options.now(),
    () => {
      const workspace = ensureWorkspace(transaction, options.workspaceId);
      if (!workspace.activePluginIds.includes("opc")) {
        throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用 OPC", "先在工作区启用 OPC");
      }
      const opportunity = transaction.getProjection<OpportunityAggregate>(OPC_PROJECTION, options.opportunityId);
      if (!opportunity || opportunity.workspaceId !== options.workspaceId) {
        throw new OpcDomainError("NOT_FOUND", "机会不存在", "刷新工作区后重试");
      }
      if (opportunity.streamVersion !== options.expectedStreamVersion) {
        throw new OpcDomainError(
          "STREAM_VERSION_CONFLICT",
          `预期版本 ${options.expectedStreamVersion}，实际版本 ${opportunity.streamVersion}`,
          "重新读取机会后重试",
        );
      }
      const thread = transaction.listProjections<Thread>("thread").find((candidate) =>
        candidate.workspaceId === options.workspaceId
        && candidate.resourceRef?.namespace === "opc.opportunity"
        && candidate.resourceRef.resourceId === options.opportunityId);
      if (!thread) throw new KernelError("THREAD_NOT_FOUND", "机会会话不存在", "重新创建机会后重试");
      const createdAt = options.now();
      return exportOpportunityDeliverables(opportunity).map((item): StoredOpcDeliverable => {
        const deliverable: StoredOpcDeliverable = {
          id: options.id("deliverable"),
          tenantId: options.tenantId,
          workspaceId: options.workspaceId,
          pluginId: "opc",
          threadId: thread.id,
          kind: item.kind,
          title: item.title,
          summary: item.summary,
          validationStatus: item.validationStatus,
          content: item.content as JsonObject,
          assetIds: [],
          nextAction: item.nextAction,
          streamVersion: 1,
          createdAt,
          updatedAt: createdAt,
        };
        transaction.putProjection("deliverable", deliverable.id, deliverable);
        appendKernelEvent(transaction, {
          tenantId: options.tenantId,
          aggregateType: "deliverable",
          aggregateId: deliverable.id,
          expectedStreamVersion: 0,
          type: "deliverable.created",
          actorId: options.actorId,
          generation: 0,
          correlationId: options.id("correlation"),
          publicPayload: {
            workspaceId: options.workspaceId,
            pluginId: "opc",
            opportunityId: options.opportunityId,
            kind: item.kind,
            validationStatus: item.validationStatus,
          },
        });
        return deliverable;
      });
    },
  ));
}

export async function listOpportunitySummaries(store: KernelStore, tenantId: string, workspaceId: string) {
  return store.transact(tenantId, (transaction) => transaction.listProjections<OpportunityAggregate>(OPC_PROJECTION)
    .filter((opportunity) => opportunity.workspaceId === workspaceId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((opportunity) => {
      const hypothesis = opportunity.hypotheses.at(-1);
      const captureDraft = createOpportunityDraft(opportunity.rawCapture);
      const evidence = [
        ...opportunity.signals.map((signal) => ({
          id: signal.id,
          stance: signal.relationship === "support" ? "supporting" as const
            : signal.relationship === "oppose" ? "opposing" as const : "neutral" as const,
          summary: signal.summary,
          source: signal.sourceUrl ?? signal.sourceKind,
          capturedAt: signal.recordedAt,
        })),
        ...opportunity.commitmentEvidence.map((item) => ({
          id: item.id,
          stance: "supporting" as const,
          summary: item.description,
          source: item.sourceRef,
          capturedAt: item.proposedAt,
          humanConfirmed: item.status === "confirmed",
        })),
      ];
      const gaps = opportunity.state === "captured"
        ? ["目标客户", "客户问题", "可证伪假设"]
        : [
            ...(evidence.some((item) => item.stance === "supporting") ? [] : ["支持证据"]),
            ...(evidence.some((item) => item.stance === "opposing") ? [] : ["反证"]),
            ...(opportunity.evidenceLevel === "none" ? ["客户兴趣或承诺"] : []),
          ];
      return {
        id: opportunity.id,
        title: opportunity.title,
        targetCustomer: hypothesis?.targetCustomer ?? captureDraft.targetCustomer ?? "待界定目标客户",
        problem: hypothesis?.problem ?? captureDraft.problem ?? "待界定客户问题",
        falsifiableHypothesis: hypothesis?.statement ?? captureDraft.falsifiableHypothesis ?? "",
        status: opportunity.state,
        evidenceLevel: opportunity.evidenceLevel,
        evidence,
        gaps,
        nextAction: opportunityNextAction(opportunity),
        streamVersion: opportunity.streamVersion,
      };
    }));
}

function opportunityNextAction(opportunity: OpportunityAggregate): string {
  switch (opportunity.state) {
    case "captured": return "界定目标客户、问题和可证伪假设";
    case "framed": return "开始公开资料研究并记录反证";
    case "researching": return "准备并开展非诱导访谈";
    case "interviewing": return "同时整理支持证据、反证和证据缺口";
    case "evaluating": return "形成可供客户行动验证的最小收费方案";
    case "offer_ready": return "由负责人选择推进、修订或停止";
    case "decided": return "归档决策并复盘结果";
    case "paused": return "确认条件后恢复机会";
    case "abandoned": return "保留证据并结束跟进";
  }
}

export async function captureCodingRepository(options: ProductMutationOptions): Promise<VersionedRepository> {
  ensureVersionZero(options.expectedStreamVersion);
  return options.store.transact(options.tenantId, (transaction) => idempotentMutation(
    transaction,
    options.tenantId,
    `coding.repository.capture:${options.workspaceId}`,
    options.idempotencyKey,
    { expectedStreamVersion: options.expectedStreamVersion, input: options.input },
    options.now(),
    () => {
      const workspace = ensureWorkspace(transaction, options.workspaceId);
      if (!workspace.activePluginIds.includes("coding")) {
        throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用 Coding", "先在工作区启用 Coding");
      }
      const createdAt = options.now();
      const normalized = options.input.trim().replace(/\/+$/u, "");
      if (!normalized) throw new KernelError("INVALID_BODY", "仓库路径或名称不能为空", "填写仓库路径或名称");
      const repository: VersionedRepository = {
        id: options.id("repository"),
        workspaceId: options.workspaceId,
        name: normalized.split("/").at(-1) || normalized,
        rootRealPath: normalized.startsWith("/") ? normalized : "",
        vcs: "git",
        streamVersion: 1,
        createdAt,
        updatedAt: createdAt,
      };
      transaction.putProjection(CODING_REPOSITORY_PROJECTION, repository.id, repository);
      appendKernelEvent(transaction, {
        tenantId: options.tenantId,
        aggregateType: "coding.repository",
        aggregateId: repository.id,
        expectedStreamVersion: 0,
        type: "coding.repository_captured",
        actorId: options.actorId,
        generation: 0,
        correlationId: options.id("correlation"),
        publicPayload: { workspaceId: options.workspaceId, name: repository.name, reviewRequired: true },
      });
      return repository;
    },
  ));
}

export async function listCodingRepositories(store: KernelStore, tenantId: string, workspaceId: string): Promise<readonly VersionedRepository[]> {
  return store.transact(tenantId, tx => tx.listProjections<VersionedRepository>(CODING_REPOSITORY_PROJECTION)
    .filter(repository => repository.workspaceId === workspaceId));
}

export async function captureCodingTask(options: ProductMutationOptions & { readonly repositoryId?: string }): Promise<CodingTask> {
  ensureVersionZero(options.expectedStreamVersion);
  return options.store.transact(options.tenantId, (transaction) => idempotentMutation(
    transaction,
    options.tenantId,
    `coding.task.capture:${options.workspaceId}`,
    options.idempotencyKey,
    { expectedStreamVersion: options.expectedStreamVersion, input: options.input, repositoryId: options.repositoryId },
    options.now(),
    () => {
      const workspace = ensureWorkspace(transaction, options.workspaceId);
      if (!workspace.activePluginIds.includes("coding")) {
        throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用 Coding", "先在工作区启用 Coding");
      }
      const repositories = transaction.listProjections<VersionedRepository>(CODING_REPOSITORY_PROJECTION)
        .filter(item => item.workspaceId === options.workspaceId);
      const repository = options.repositoryId ? repositories.find(item => item.id === options.repositoryId)
        : repositories.length === 1 ? repositories[0] : undefined;
      if (!repository) {
        if (options.repositoryId) throw new KernelError("CODING_REPOSITORY_NOT_FOUND", "所选仓库不属于当前工作区或已不可用", "刷新仓库列表后重新选择");
        throw new KernelError("CODING_REPOSITORY_REQUIRED", repositories.length ? "工作区有多个仓库，需要选择任务仓库" : "当前工作区还没有仓库", "在 Coding 页面添加或选择仓库后再创建任务");
      }
      const title = options.input.trim().split(/[。；;\n]/u, 1)[0]?.slice(0, 80) || "新 Coding 任务";
      const createdAt = options.now();
      const correlationId = options.id("correlation");
      const resourceRef = { namespace: "coding.task", resourceId: options.id("coding-task") } as const;
      const task = {
        ...createCodingTask({
          id: resourceRef.resourceId,
          workspaceId: options.workspaceId,
          repositoryId: repository.id,
          title,
          request: options.input,
          createdAt,
        }),
        streamVersion: 1,
      };
      const thread: Thread = {
        id: options.id("thread"),
        tenantId: options.tenantId,
        workspaceId: options.workspaceId,
        subject: task.title,
        pluginId: "coding",
        resourceRef,
        streamVersion: 1,
        createdAt,
        updatedAt: createdAt,
      };
      transaction.putProjection(CODING_TASK_PROJECTION, task.id, task);
      transaction.putProjection("thread", thread.id, thread);
      appendKernelEvent(transaction, {
        tenantId: options.tenantId,
        aggregateType: "coding.task",
        aggregateId: task.id,
        expectedStreamVersion: 0,
        type: "coding.task_captured",
        actorId: options.actorId,
        generation: 0,
        correlationId,
        publicPayload: { workspaceId: options.workspaceId, repositoryId: task.repositoryId, title: task.title },
      });
      appendKernelEvent(transaction, {
        tenantId: options.tenantId,
        aggregateType: "thread",
        aggregateId: thread.id,
        expectedStreamVersion: 0,
        type: "thread.created",
        actorId: options.actorId,
        generation: 0,
        correlationId,
        publicPayload: {
          workspaceId: options.workspaceId,
          pluginId: "coding",
          resourceNamespace: resourceRef.namespace,
          resourceId: task.id,
        },
      });
      return task;
    },
  ));
}

export async function listCodingTaskSummaries(store: KernelStore, tenantId: string, workspaceId: string): Promise<readonly CodingTaskSummaryV2[]> {
  return store.transact(tenantId, (transaction) => {
    const runs = transaction.listProjections<{ readonly executionId: string; readonly taskId: string; readonly updatedAt: string;
      readonly controlPlane?: CodingControlPlaneCommitment; readonly result?: CodingExecutionResult }>("coding.execution");
    const candidates = transaction.listProjections<{ readonly id: string; readonly taskId: string; readonly workspaceId: string;
      readonly executionId: string; readonly diff: string }>("coding.candidate").filter(candidate => candidate.workspaceId === workspaceId);
    const repositories = new Map(transaction.listProjections<VersionedRepository>(CODING_REPOSITORY_PROJECTION)
      .filter((repository) => repository.workspaceId === workspaceId)
      .map((repository) => [repository.id, repository]));
    return transaction.listProjections<CodingTask>(CODING_TASK_PROJECTION)
      .filter((task) => task.workspaceId === workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((task): CodingTaskSummaryV2 => {
        const run = runs.filter(run => run.taskId === task.id && (!run.result || run.result.task.workspaceId === workspaceId))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        const lastCandidate = run?.result?.candidates.at(-1);
        const material = candidates.find(candidate => candidate.id === lastCandidate?.id && candidate.executionId === run?.executionId);
        const checks = run?.result?.gates.at(-1)?.checks;
        const repairsUsed = Math.max(0, (run?.result?.candidates.length ?? 0) - 1);
        const maxRepairs = run?.result?.limits.maxRepairAttempts ?? 3;
        return {
        id: task.id,
        title: task.title,
        repository: repositories.get(task.repositoryId)?.name ?? "待选择仓库",
        status: task.status,
        ...(lastCandidate ? { diffSummary: lastCandidate.summary } : {}),
        ...(material ? { diff: material.diff } : {}),
        checks: checks?.length ? checks.map(check => ({ name: check.id, status: check.status === "passed" ? "pass" : "fail" }))
          : [{ name: "只读仓库检查", status: "pending" }],
        ...(run?.result?.approval ? { approval: run.result.approval === "approved_once" ? "已单次批准" : "已拒绝" }
          : task.status === "waiting_approval" ? { approval: "等待人工审批" } : {}),
        nextAction: run?.result?.nextStep ?? (task.repositoryId === "unassigned" ? "选择仓库并审阅任务范围" : "审阅 Spec 与影响范围"),
        advanced: {
          harnessDigest: run?.controlPlane?.harnessDigest ?? "待执行后固定",
          candidateCount: candidates.filter(candidate => candidate.taskId === task.id && candidate.executionId === run?.executionId).length,
          remainingBudget: `本轮还可修复 ${Math.max(0, maxRepairs - repairsUsed)} 次；时长上限 ${(run?.result?.limits.maxDurationMs ?? 3600000) / 1000} 秒`,
        },
      }; });
  });
}

export async function runReadOnlySample(options: Omit<ProductMutationOptions, "input">, pluginId: "opc" | "coding") {
  ensureVersionZero(options.expectedStreamVersion);
  return options.store.transact(options.tenantId, (transaction) => idempotentMutation(
    transaction,
    options.tenantId,
    `plugin.sample:${options.workspaceId}:${pluginId}`,
    options.idempotencyKey,
    { expectedStreamVersion: options.expectedStreamVersion, pluginId },
    options.now(),
    () => {
      const workspace = ensureWorkspace(transaction, options.workspaceId);
      if (!workspace.activePluginIds.includes(pluginId)) {
        throw new KernelError("PLUGIN_NOT_ACTIVE", "工作区尚未启用此插件", "先在工作区启用插件");
      }
      const sampleId = options.id("sample");
      const effectClass = pluginId === "opc" ? "external_read" : "local_read";
      const response = {
        id: sampleId,
        pluginId,
        effectClass,
        status: "completed",
        summary: pluginId === "opc" ? "公开资料读取策略检查通过" : "仓库只读能力检查通过",
      } as const;
      appendKernelEvent(transaction, {
        tenantId: options.tenantId,
        aggregateType: "plugin.sample",
        aggregateId: sampleId,
        expectedStreamVersion: 0,
        type: "plugin.read_only_sample_completed",
        actorId: options.actorId,
        generation: 0,
        correlationId: options.id("correlation"),
        publicPayload: { workspaceId: options.workspaceId, pluginId, effectClass },
      });
      return response;
    },
  ));
}

export async function workspaceHome(store: KernelStore, tenantId: string, workspaceId: string) {
  const [opportunities, codingTasks] = await Promise.all([
    listOpportunitySummaries(store, tenantId, workspaceId),
    listCodingTaskSummaries(store, tenantId, workspaceId),
  ]);
  return store.transact(tenantId, (transaction) => {
    ensureWorkspace(transaction, workspaceId);
    const inbox = transaction.listProjections<InboxItem>("inbox")
      .filter((item) => item.workspaceId === workspaceId && item.status === "open");
    const approvalsById = new Map(transaction.listProjections<Approval>("approval")
      .map((approval) => [approval.id, approval]));
    const deliverables = transaction.listProjections<Deliverable>("deliverable")
      .filter((item) => item.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 5)
      .map(deliverableSummary);
    return {
      todayActions: [
        ...opportunities.filter((item) => !["decided", "abandoned"].includes(item.status)).map((item) => ({
          id: item.id, title: item.title, detail: item.nextAction, pluginId: "opc" as const,
        })),
        ...codingTasks.filter((item) => !["completed", "cancelled"].includes(item.status)).map((item) => ({
          id: item.id, title: item.title, detail: item.nextAction, pluginId: "coding" as const,
        })),
      ],
      blockers: inbox.filter((item) => item.kind !== "approval").map((item) => ({
        id: item.id, title: item.title, detail: item.summary,
      })),
      approvals: inbox.filter((item) => item.kind === "approval").flatMap((item) => {
        const approval = approvalsById.get(item.id.replace(/^approval:/u, ""));
        return approval ? [{
          id: approval.id,
          title: item.title,
          intent: approval.intent,
          resourceSummary: item.resourceSummary ?? "未指定资源",
          risk: approval.effectClass,
          expiresAt: approval.expiresAt,
          streamVersion: approval.streamVersion,
        }] : [];
      }),
      recentDeliverables: deliverables,
    };
  });
}

export function deliverableSummary(item: Deliverable) {
  return {
    id: item.id,
    pluginId: item.pluginId,
    title: item.title,
    outcome: item.summary,
    ...(item.nextAction ? { nextAction: item.nextAction } : {}),
    createdAt: item.createdAt,
  };
}

export async function workspaceActivity(store: KernelStore, tenantId: string, workspaceId: string, protection?: RuntimeProtection) {
  const readHistory = store.readEventHistory ?? store.readEvents;
  const recent: import("@mn/contracts").KernelEventV1[] = [];
  let position = 0;
  for (;;) {
    const page = await readHistory.call(store, tenantId, position, 1000);
    recent.push(...page.events.filter(event => (event.aggregateType === "workspace" && event.aggregateId === workspaceId)
      || event.publicPayload.workspaceId === workspaceId));
    if (recent.length > 1000) recent.splice(0, recent.length - 1000);
    if (!page.events.length) break;
    if (page.nextPosition <= position) throw new Error("活动事实游标未前进");
    position = page.nextPosition;
    if (page.events.length < 1000) break;
  }
  const costs = new Map<string, string>();
  for (const event of recent) {
    if (event.aggregateType !== "execution" || costs.has(event.aggregateId)) continue;
    const state = await store.transact(tenantId, tx => {
      const execution = tx.getProjection<Execution>("execution", event.aggregateId);
      if (!execution || execution.workspaceId !== workspaceId) return undefined;
      const authority = tx.getProjection<ExecutionAuthority>("authority", execution.authorityId);
      return authority ? { execution, authority } : undefined;
    });
    if (!state) { costs.set(event.aggregateId, "费用未核算"); continue; }
    const runtime = protection ? createProtectedRuntimeStore({ ...protection, store, tenantId, workspaceId })
      : new KernelProjectionRuntimeStore({ store, tenantId });
    costs.set(event.aggregateId, meteringCostSummary(executionMetering(state.execution, state.authority,
      await runtime.readExecution(event.aggregateId))));
  }
  const latestByExecution = new Map(recent.filter(event => event.aggregateType === "execution").map(event => [event.aggregateId, event.id]));
  return recent.map((event) => ({
      id: event.id,
      title: activityTitle(event.type),
      status: activityStatus(event.type),
      cost: latestByExecution.get(event.aggregateId) === event.id ? costs.get(event.aggregateId) ?? "费用未核算" : "—",
      occurredAt: event.occurredAt,
    }))
    .reverse();
}

function activityTitle(type: string): string {
  if (type === "opportunity.captured") return "创建机会";
  if (type === "coding.repository_captured") return "登记仓库";
  if (type === "coding.task_captured") return "创建 Coding 任务";
  if (type === "plugin.read_only_sample_completed") return "完成只读样例";
  if (type.startsWith("approval.")) return "处理审批";
  if (type.startsWith("execution.")) return "更新执行";
  if (type === "workspace.created") return "创建工作区";
  return "更新工作区记录";
}

function activityStatus(type: string): string {
  if (type.includes("failed") || type.includes("denied")) return "需要关注";
  if (type.includes("waiting") || type.includes("requested")) return "等待处理";
  return "已记录";
}

export function asPublicPayload(value: unknown): JsonObject {
  return value as JsonObject;
}
