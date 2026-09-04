import { randomUUID } from "node:crypto";
import { OpcDomainError, requireText } from "./errors.js";
import type { OpcEvent } from "./events.js";
import type {
  Actor,
  CommitmentEvidenceInput,
  DecisionChoice,
  ExperimentInput,
  MinimumPaidOfferInput,
  OpportunityAggregate,
  OpportunityCaptureDraft,
  SignalInput,
} from "./model.js";
import type { OpcRepository } from "./repository.js";
import { isPausableState } from "./workflow.js";

export interface OpcServiceOptions {
  readonly repository: OpcRepository;
  readonly clock?: () => string;
  readonly createId?: (prefix: string) => string;
}

interface ExistingOpportunityCommand {
  readonly workspaceId: string;
  readonly opportunityId: string;
  readonly expectedStreamVersion: number;
  readonly actor: Actor;
}

export interface CaptureOpportunityCommand extends ExistingOpportunityCommand {
  readonly draft: OpportunityCaptureDraft;
}

export interface FrameOpportunityCommand extends ExistingOpportunityCommand {
  readonly targetCustomer: string;
  readonly problem: string;
  readonly falsifiableHypothesis: string;
}

export interface RecordSignalCommand extends ExistingOpportunityCommand {
  readonly signal: SignalInput;
}

export interface RecordInterviewCommand extends ExistingOpportunityCommand {
  readonly interviewId: string;
  readonly participantRef: string;
  readonly occurredAt: string;
  readonly rawRecord: string;
}

export interface AnnotateInterviewCommand extends ExistingOpportunityCommand {
  readonly interviewId: string;
  readonly annotation: string;
}

export interface RecordExperimentCommand extends ExistingOpportunityCommand {
  readonly experiment: ExperimentInput;
}

export interface ProposeCommitmentEvidenceCommand extends ExistingOpportunityCommand {
  readonly evidence: CommitmentEvidenceInput;
}

export interface ConfirmCommitmentEvidenceCommand extends ExistingOpportunityCommand {
  readonly evidenceId: string;
}

export interface PrepareOfferCommand extends ExistingOpportunityCommand {
  readonly offer: MinimumPaidOfferInput;
}

export interface DecideOpportunityCommand extends ExistingOpportunityCommand {
  readonly decision: DecisionChoice;
  readonly rationale: string;
}

export interface PauseOpportunityCommand extends ExistingOpportunityCommand {
  readonly reason: string;
}

export interface AbandonOpportunityCommand extends ExistingOpportunityCommand {
  readonly reason: string;
}

export class OpcService {
  readonly #repository: OpcRepository;
  readonly #clock: () => string;
  readonly #createId: (prefix: string) => string;

  constructor(options: OpcServiceOptions) {
    this.#repository = options.repository;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? defaultCreateId;
  }

  async get(workspaceId: string, opportunityId: string): Promise<OpportunityAggregate | undefined> {
    return this.#repository.load(workspaceId, opportunityId);
  }

  async capture(command: CaptureOpportunityCommand): Promise<OpportunityAggregate> {
    if (command.expectedStreamVersion !== 0) {
      throw new OpcDomainError(
        "STREAM_VERSION_CONFLICT",
        "创建机会时 expectedStreamVersion 必须为 0",
        "将 expectedStreamVersion 设为 0",
      );
    }
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.captured",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        title: requireText(command.draft.title, "title", "机会名称"),
        rawInput: requireText(command.draft.rawInput, "rawInput", "原始输入"),
      },
    }]);
  }

  async frame(command: FrameOpportunityCommand): Promise<OpportunityAggregate> {
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.framed",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        hypothesisId: this.#createId("hypothesis"),
        targetCustomer: command.targetCustomer,
        problem: command.problem,
        falsifiableHypothesis: command.falsifiableHypothesis,
      },
    }]);
  }

  async startResearch(command: ExistingOpportunityCommand): Promise<OpportunityAggregate> {
    return this.#append(command, [this.#emptyEvent("opportunity.research_started", command.actor)]);
  }

  async recordSignal(command: RecordSignalCommand): Promise<OpportunityAggregate> {
    if (command.signal.sourceKind === "public_web") {
      const sourceUrl = requireText(command.signal.sourceUrl ?? "", "sourceUrl", "公开网页来源");
      let url: URL;
      try {
        url = new URL(sourceUrl);
      } catch {
        throw new OpcDomainError("INVALID_INPUT", "公开网页来源无效", "填写完整 HTTP 或 HTTPS 地址", "sourceUrl");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new OpcDomainError("INVALID_INPUT", "公开网页来源必须使用 HTTP 或 HTTPS", "更换公开网页地址", "sourceUrl");
      }
    }
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.signal_recorded",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { signalId: this.#createId("signal"), signal: command.signal },
    }]);
  }

  async startInterviewing(command: ExistingOpportunityCommand): Promise<OpportunityAggregate> {
    return this.#append(command, [this.#emptyEvent("opportunity.interviewing_started", command.actor)]);
  }

  async recordInterview(command: RecordInterviewCommand): Promise<OpportunityAggregate> {
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.interview_recorded",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        interviewId: requireText(command.interviewId, "interviewId", "访谈 ID"),
        participantRef: command.participantRef,
        interviewOccurredAt: command.occurredAt,
        rawRecord: command.rawRecord,
      },
    }]);
  }

  async annotateInterview(command: AnnotateInterviewCommand): Promise<OpportunityAggregate> {
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.interview_annotated",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        interviewId: command.interviewId,
        annotationId: this.#createId("annotation"),
        text: command.annotation,
      },
    }]);
  }

  async startEvaluation(command: ExistingOpportunityCommand): Promise<OpportunityAggregate> {
    return this.#append(command, [this.#emptyEvent("opportunity.evaluation_started", command.actor)]);
  }

  async recordExperiment(command: RecordExperimentCommand): Promise<OpportunityAggregate> {
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.experiment_recorded",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { experimentId: this.#createId("experiment"), experiment: command.experiment },
    }]);
  }

  async proposeCommitmentEvidence(
    command: ProposeCommitmentEvidenceCommand,
  ): Promise<OpportunityAggregate> {
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.commitment_evidence_proposed",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { evidenceId: this.#createId("evidence"), evidence: command.evidence },
    }]);
  }

  async confirmCommitmentEvidence(
    command: ConfirmCommitmentEvidenceCommand,
  ): Promise<OpportunityAggregate> {
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.commitment_evidence_confirmed",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { evidenceId: command.evidenceId },
    }]);
  }

  async prepareOffer(command: PrepareOfferCommand): Promise<OpportunityAggregate> {
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.offer_prepared",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { offerId: this.#createId("offer"), offer: command.offer },
    }]);
  }

  async decide(command: DecideOpportunityCommand): Promise<OpportunityAggregate> {
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.decided",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: {
        decisionId: this.#createId("decision"),
        choice: command.decision,
        rationale: command.rationale,
      },
    }]);
  }

  async pause(command: PauseOpportunityCommand): Promise<OpportunityAggregate> {
    const current = await this.#requireCurrent(command);
    if (!isPausableState(current.state)) {
      throw new OpcDomainError(
        "INVALID_TRANSITION",
        `状态 ${current.state} 不能暂停`,
        "选择仍在进行的机会",
      );
    }
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.paused",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { previousState: current.state, reason: command.reason },
    }]);
  }

  async resume(command: ExistingOpportunityCommand): Promise<OpportunityAggregate> {
    const current = await this.#requireCurrent(command);
    if (current.state !== "paused" || !current.stateBeforePause) {
      throw new OpcDomainError(
        "INVALID_TRANSITION",
        `状态 ${current.state} 不能恢复`,
        "选择已暂停的机会",
      );
    }
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.resumed",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { resumedState: current.stateBeforePause },
    }]);
  }

  async abandon(command: AbandonOpportunityCommand): Promise<OpportunityAggregate> {
    return this.#append(command, [{
      eventId: this.#createId("event"),
      type: "opportunity.abandoned",
      actor: command.actor,
      occurredAt: this.#clock(),
      payload: { reason: command.reason },
    }]);
  }

  #emptyEvent<T extends "opportunity.research_started" | "opportunity.interviewing_started" | "opportunity.evaluation_started">(
    type: T,
    actor: Actor,
  ): Extract<OpcEvent, { readonly type: T }> {
    return {
      eventId: this.#createId("event"),
      type,
      actor,
      occurredAt: this.#clock(),
      payload: {},
    } as Extract<OpcEvent, { readonly type: T }>;
  }

  async #requireCurrent(command: ExistingOpportunityCommand): Promise<OpportunityAggregate> {
    const current = await this.#repository.load(command.workspaceId, command.opportunityId);
    if (!current) {
      throw new OpcDomainError("NOT_FOUND", "机会不存在", "刷新工作区后重试");
    }
    if (current.streamVersion !== command.expectedStreamVersion) {
      throw new OpcDomainError(
        "STREAM_VERSION_CONFLICT",
        `预期版本 ${command.expectedStreamVersion}，实际版本 ${current.streamVersion}`,
        "重新读取机会后重试",
      );
    }
    return current;
  }

  async #append(
    command: ExistingOpportunityCommand,
    events: readonly OpcEvent[],
  ): Promise<OpportunityAggregate> {
    return this.#repository.append({
      workspaceId: command.workspaceId,
      opportunityId: command.opportunityId,
      expectedStreamVersion: command.expectedStreamVersion,
      events,
    });
  }
}

function defaultCreateId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
