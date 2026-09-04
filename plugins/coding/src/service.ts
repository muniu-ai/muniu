import { randomUUID } from "node:crypto";
import type {
  Candidate,
  CodeEvidence,
  CodingTaskAggregate,
  CodingWorkflowStage,
  GateResult,
  RepositoryAggregate,
  ServiceAggregate,
} from "./domain.ts";
import { CodingDomainError, requireCodingText } from "./errors.ts";
import type {
  CodingActor,
  CodingTaskEvent,
  RepositoryEvent,
  ServiceEvent,
} from "./events.ts";
import type { CodingRepository } from "./repository.ts";

export interface CodingServiceOptions {
  readonly repository: CodingRepository;
  readonly clock?: () => string;
  readonly createEventId?: () => string;
}

interface CodingCommandContext {
  readonly workspaceId: string;
  readonly expectedStreamVersion: number;
  readonly idempotencyKey: string;
  readonly actor: CodingActor;
}

export interface RegisterRepositoryCommand extends CodingCommandContext {
  readonly repositoryId: string;
  readonly name: string;
  readonly rootRealPath: string;
}

export interface RegisterServiceCommand extends CodingCommandContext {
  readonly serviceId: string;
  readonly repositoryId: string;
  readonly name: string;
  readonly paths: readonly string[];
}

export interface CreateTaskCommand extends CodingCommandContext {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly title: string;
  readonly request: string;
}

interface ExistingTaskCommand extends CodingCommandContext {
  readonly taskId: string;
}

export interface RecordSpecCommand extends ExistingTaskCommand {
  readonly specId: string;
  readonly title: string;
  readonly body: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface ReviseSpecCommand extends ExistingTaskCommand {
  readonly previousSpecId: string;
  readonly specId: string;
  readonly title?: string;
  readonly body: string;
  readonly acceptanceCriteria?: readonly string[];
}

export interface AdvanceTaskCommand extends ExistingTaskCommand {
  readonly nextStage: CodingWorkflowStage;
}

export interface RecordCandidateCommand extends ExistingTaskCommand {
  readonly runnerId: string;
  readonly candidate: Omit<Candidate, "taskId" | "runnerId">;
}

export interface RecordGateResultCommand extends ExistingTaskCommand {
  readonly gateResult: GateResult;
}

export interface RecordCodeEvidenceCommand extends ExistingTaskCommand {
  readonly evidence: Omit<CodeEvidence, "taskId" | "digest">;
}

export class CodingService {
  readonly #repository: CodingRepository;
  readonly #clock: () => string;
  readonly #createEventId: () => string;

  constructor(options: CodingServiceOptions) {
    this.#repository = options.repository;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#createEventId = options.createEventId ?? (() => `coding-event-${randomUUID()}`);
  }

  async getRepository(
    workspaceId: string,
    repositoryId: string,
  ): Promise<RepositoryAggregate | undefined> {
    return this.#repository.loadRepository(workspaceId, repositoryId);
  }

  async getService(workspaceId: string, serviceId: string): Promise<ServiceAggregate | undefined> {
    return this.#repository.loadService(workspaceId, serviceId);
  }

  async getTask(workspaceId: string, taskId: string): Promise<CodingTaskAggregate | undefined> {
    return this.#repository.loadTask(workspaceId, taskId);
  }

  async registerRepository(command: RegisterRepositoryCommand): Promise<RepositoryAggregate> {
    const event: RepositoryEvent = {
      eventId: this.#createEventId(),
      type: "coding.repository_registered",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        name: command.name,
        rootRealPath: command.rootRealPath,
        vcs: "git",
      },
    };
    return this.#repository.appendRepository({
      workspaceId: requireCodingText(command.workspaceId, "workspaceId", "工作区 ID"),
      aggregateId: requireCodingText(command.repositoryId, "repositoryId", "仓库 ID"),
      expectedStreamVersion: command.expectedStreamVersion,
      events: [event],
      idempotency: { key: command.idempotencyKey, request: command },
    });
  }

  async registerService(command: RegisterServiceCommand): Promise<ServiceAggregate> {
    const workspaceId = requireCodingText(command.workspaceId, "workspaceId", "工作区 ID");
    const repositoryId = requireCodingText(command.repositoryId, "repositoryId", "仓库 ID");
    await this.#requireRepository(workspaceId, repositoryId);
    const event: ServiceEvent = {
      eventId: this.#createEventId(),
      type: "coding.service_registered",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        repositoryId,
        name: command.name,
        paths: [...command.paths],
      },
    };
    return this.#repository.appendService({
      workspaceId,
      aggregateId: requireCodingText(command.serviceId, "serviceId", "服务 ID"),
      expectedStreamVersion: command.expectedStreamVersion,
      events: [event],
      idempotency: { key: command.idempotencyKey, request: command },
    });
  }

  async createTask(command: CreateTaskCommand): Promise<CodingTaskAggregate> {
    const workspaceId = requireCodingText(command.workspaceId, "workspaceId", "工作区 ID");
    const repositoryId = requireCodingText(command.repositoryId, "repositoryId", "仓库 ID");
    await this.#requireRepository(workspaceId, repositoryId);
    const event: CodingTaskEvent = {
      eventId: this.#createEventId(),
      type: "coding.task_created",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        repositoryId,
        title: command.title,
        request: command.request,
      },
    };
    return this.#appendTask(command, event);
  }

  async recordSpec(command: RecordSpecCommand): Promise<CodingTaskAggregate> {
    return this.#appendTask(command, {
      eventId: this.#createEventId(),
      type: "coding.spec_recorded",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        specId: command.specId,
        title: command.title,
        body: command.body,
        acceptanceCriteria: [...command.acceptanceCriteria],
      },
    });
  }

  async reviseSpec(command: ReviseSpecCommand): Promise<CodingTaskAggregate> {
    return this.#appendTask(command, {
      eventId: this.#createEventId(),
      type: "coding.spec_revised",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        previousSpecId: command.previousSpecId,
        specId: command.specId,
        body: command.body,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.acceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: [...command.acceptanceCriteria] }),
      },
    });
  }

  async advanceTask(command: AdvanceTaskCommand): Promise<CodingTaskAggregate> {
    return this.#appendTask(command, {
      eventId: this.#createEventId(),
      type: "coding.task_advanced",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { nextStage: command.nextStage },
    });
  }

  async recordCandidate(command: RecordCandidateCommand): Promise<CodingTaskAggregate> {
    return this.#appendTask(command, {
      eventId: this.#createEventId(),
      type: "coding.candidate_recorded",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        runnerId: command.runnerId,
        candidate: structuredClone(command.candidate),
      },
    });
  }

  async recordGateResult(command: RecordGateResultCommand): Promise<CodingTaskAggregate> {
    return this.#appendTask(command, {
      eventId: this.#createEventId(),
      type: "coding.gate_result_recorded",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { gateResult: structuredClone(command.gateResult) },
    });
  }

  async recordCodeEvidence(command: RecordCodeEvidenceCommand): Promise<CodingTaskAggregate> {
    return this.#appendTask(command, {
      eventId: this.#createEventId(),
      type: "coding.code_evidence_recorded",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { evidence: structuredClone(command.evidence) },
    });
  }

  async #appendTask(
    command: ExistingTaskCommand,
    event: CodingTaskEvent,
  ): Promise<CodingTaskAggregate> {
    return this.#repository.appendTask({
      workspaceId: requireCodingText(command.workspaceId, "workspaceId", "工作区 ID"),
      aggregateId: requireCodingText(command.taskId, "taskId", "任务 ID"),
      expectedStreamVersion: command.expectedStreamVersion,
      events: [event],
      idempotency: { key: command.idempotencyKey, request: command },
    });
  }

  async #requireRepository(workspaceId: string, repositoryId: string): Promise<void> {
    if (!await this.#repository.loadRepository(workspaceId, repositoryId)) {
      throw new CodingDomainError(
        "NOT_FOUND",
        `仓库 ${repositoryId} 不存在于当前工作区`,
        "先登记仓库后重试",
        "repositoryId",
      );
    }
  }
}
