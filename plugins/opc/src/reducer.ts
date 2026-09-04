import { OpcDomainError, requireNonEmpty, requireText } from "./errors.js";
import type { StoredOpcEvent } from "./events.js";
import type {
  CommitmentEvidence,
  EvidenceLevel,
  MinimumPaidOfferInput,
  OpportunityAggregate,
  OpportunityState,
} from "./model.js";

const EVIDENCE_RANK: Readonly<Record<EvidenceLevel, number>> = {
  none: 0,
  interest: 1,
  commitment: 2,
  paid: 3,
};

export function reduceOpcEvents(
  workspaceId: string,
  opportunityId: string,
  events: readonly StoredOpcEvent[],
): OpportunityAggregate | undefined {
  let aggregate: OpportunityAggregate | undefined;
  for (const event of events) {
    aggregate = applyOpcEvent(workspaceId, opportunityId, aggregate, event);
  }
  return aggregate;
}

export function applyOpcEvent(
  workspaceId: string,
  opportunityId: string,
  current: OpportunityAggregate | undefined,
  event: StoredOpcEvent,
): OpportunityAggregate {
  if (event.type === "opportunity.captured") {
    if (current) {
      throw new OpcDomainError("ALREADY_EXISTS", "机会已经存在", "使用新的机会 ID");
    }
    return {
      id: opportunityId,
      workspaceId,
      title: requireText(event.payload.title, "title", "机会名称"),
      rawCapture: requireText(event.payload.rawInput, "rawInput", "原始输入"),
      state: "captured",
      evidenceLevel: "none",
      streamVersion: event.streamVersion,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      hypotheses: [],
      signals: [],
      interviews: [],
      experiments: [],
      commitmentEvidence: [],
    };
  }
  if (!current) {
    throw new OpcDomainError("NOT_FOUND", "机会不存在", "先创建机会");
  }
  assertNextVersion(current, event);

  switch (event.type) {
    case "opportunity.framed": {
      assertState(current.state, ["captured"], event.type);
      const targetCustomer = requireText(event.payload.targetCustomer, "targetCustomer", "目标客户");
      const problem = requireText(event.payload.problem, "problem", "客户问题");
      const statement = requireText(
        event.payload.falsifiableHypothesis,
        "falsifiableHypothesis",
        "可证伪假设",
      );
      return update(current, event, {
        state: "framed",
        hypotheses: [...current.hypotheses, {
          id: event.payload.hypothesisId,
          opportunityId,
          targetCustomer,
          problem,
          statement,
          falsifiable: true,
          createdAt: event.occurredAt,
          createdBy: event.actor.id,
        }],
      });
    }
    case "opportunity.research_started":
      assertState(current.state, ["framed"], event.type);
      return update(current, event, { state: "researching" });
    case "opportunity.signal_recorded": {
      assertState(current.state, ["researching", "interviewing", "evaluating", "offer_ready"], event.type);
      assertUniqueId(current.signals, event.payload.signalId, "Signal");
      const signal = event.payload.signal;
      assertOneOf(signal.sourceKind, ["public_web", "pasted", "file", "manual"], "sourceKind", "信号来源类型");
      assertOneOf(signal.relationship, ["support", "oppose", "neutral"], "relationship", "证据关系");
      assertOneOf(signal.evidenceKind, ["context", "interest"], "evidenceKind", "证据类型");
      if (signal.evidenceKind === "interest" && signal.relationship !== "support") {
        throw new OpcDomainError(
          "INVALID_INPUT",
          "兴趣证据必须支持当前机会",
          "将反对或中立材料记录为背景证据",
          "evidenceKind",
        );
      }
      const sourceUrl = signal.sourceKind === "public_web"
        ? requirePublicSourceUrl(signal.sourceUrl)
        : signal.sourceUrl;
      const sourceAssetId = signal.sourceKind === "file"
        ? requireText(signal.sourceAssetId ?? "", "sourceAssetId", "文件 Asset 引用")
        : undefined;
      if (signal.sourceKind !== "file" && signal.sourceAssetId !== undefined) {
        throw new OpcDomainError(
          "INVALID_INPUT",
          "只有文件信号可以引用 Asset",
          "删除 sourceAssetId，或将来源类型改为 file",
          "sourceAssetId",
        );
      }
      return updateWithEvidence(current, event, {
        signals: [...current.signals, {
          id: event.payload.signalId,
          opportunityId,
          sourceKind: signal.sourceKind,
          ...(sourceUrl ? { sourceUrl } : {}),
          ...(sourceAssetId ? { sourceAssetId } : {}),
          observedAt: requireText(signal.observedAt, "observedAt", "采集时间"),
          ...(signal.excerpt ? { excerpt: signal.excerpt } : {}),
          summary: requireText(signal.summary, "summary", "信号摘要"),
          relationship: signal.relationship,
          evidenceKind: signal.evidenceKind,
          recordedAt: event.occurredAt,
          recordedBy: event.actor.id,
        }],
      });
    }
    case "opportunity.interviewing_started":
      assertState(current.state, ["researching"], event.type);
      return update(current, event, { state: "interviewing" });
    case "opportunity.interview_recorded": {
      assertState(current.state, ["interviewing", "evaluating"], event.type);
      if (event.actor.kind !== "human") {
        throw new OpcDomainError(
          "HUMAN_REQUIRED",
          "访谈原始记录需要由人导入或确认",
          "请核对原文后再保存",
        );
      }
      assertUniqueId(current.interviews, event.payload.interviewId, "Interview");
      return update(current, event, {
        interviews: [...current.interviews, {
          id: event.payload.interviewId,
          opportunityId,
          participantRef: requireText(event.payload.participantRef, "participantRef", "受访者引用"),
          occurredAt: requireText(event.payload.interviewOccurredAt, "occurredAt", "访谈时间"),
          rawRecordAssetId: requireText(
            event.payload.rawRecordAssetId,
            "rawRecordAssetId",
            "访谈原文 Asset 引用",
          ),
          recordedAt: event.occurredAt,
          recordedBy: event.actor.id,
          annotations: [],
        }],
      });
    }
    case "opportunity.interview_annotated": {
      assertState(current.state, ["interviewing", "evaluating", "offer_ready"], event.type);
      const interview = current.interviews.find((item) => item.id === event.payload.interviewId);
      if (!interview) {
        throw new OpcDomainError("NOT_FOUND", "访谈记录不存在", "选择现有访谈后重试");
      }
      assertUniqueId(interview.annotations, event.payload.annotationId, "InterviewAnnotation");
      return update(current, event, {
        interviews: current.interviews.map((item) => item.id === interview.id ? {
          ...item,
          annotations: [...item.annotations, {
            id: event.payload.annotationId,
            text: requireText(event.payload.text, "annotation", "访谈标注"),
            createdAt: event.occurredAt,
            createdBy: event.actor.id,
            actorKind: event.actor.kind,
          }],
        } : item),
      });
    }
    case "opportunity.evaluation_started":
      assertState(current.state, ["interviewing"], event.type);
      return update(current, event, { state: "evaluating" });
    case "opportunity.experiment_recorded": {
      assertState(current.state, ["researching", "interviewing", "evaluating"], event.type);
      assertUniqueId(current.experiments, event.payload.experimentId, "Experiment");
      const experiment = event.payload.experiment;
      assertOneOf(experiment.status, ["planned", "completed"], "status", "实验状态");
      return update(current, event, {
        experiments: [...current.experiments, {
          id: event.payload.experimentId,
          opportunityId,
          question: requireText(experiment.question, "question", "实验问题"),
          method: requireText(experiment.method, "method", "实验方法"),
          successCriterion: requireText(experiment.successCriterion, "successCriterion", "成功标准"),
          ...(experiment.outcome ? { outcome: experiment.outcome } : {}),
          status: experiment.status,
          createdAt: event.occurredAt,
          createdBy: event.actor.id,
        }],
      });
    }
    case "opportunity.commitment_evidence_proposed": {
      assertState(current.state, ["researching", "interviewing", "evaluating", "offer_ready"], event.type);
      assertUniqueId(current.commitmentEvidence, event.payload.evidenceId, "CommitmentEvidence");
      assertOneOf(event.payload.evidence.level, ["commitment", "paid"], "level", "承诺证据等级");
      return updateWithEvidence(current, event, {
        commitmentEvidence: [...current.commitmentEvidence, {
          id: event.payload.evidenceId,
          opportunityId,
          level: event.payload.evidence.level,
          description: requireText(event.payload.evidence.description, "description", "证据说明"),
          sourceRef: requireText(event.payload.evidence.sourceRef, "sourceRef", "证据来源"),
          status: "proposed",
          proposedAt: event.occurredAt,
          proposedBy: event.actor.id,
        }],
      });
    }
    case "opportunity.commitment_evidence_confirmed": {
      assertState(current.state, ["researching", "interviewing", "evaluating", "offer_ready"], event.type);
      if (event.actor.kind !== "human") {
        throw new OpcDomainError("HUMAN_REQUIRED", "承诺和付费证据需要人工确认", "请由人员核对原始证据");
      }
      const evidence = current.commitmentEvidence.find((item) => item.id === event.payload.evidenceId);
      if (!evidence) {
        throw new OpcDomainError("NOT_FOUND", "承诺证据不存在", "选择现有证据后重试");
      }
      if (evidence.status === "confirmed") {
        throw new OpcDomainError("INVALID_INPUT", "承诺证据已经确认", "无需重复确认");
      }
      return updateWithEvidence(current, event, {
        commitmentEvidence: current.commitmentEvidence.map((item): CommitmentEvidence => {
          return item.id === evidence.id ? {
            ...item,
            status: "confirmed",
            confirmedAt: event.occurredAt,
            confirmedBy: event.actor.id,
          } : item;
        }),
      });
    }
    case "opportunity.offer_prepared": {
      assertState(current.state, ["evaluating"], event.type);
      const offer = normalizeOffer(event.payload.offer);
      return update(current, event, {
        state: "offer_ready",
        minimumPaidOffer: {
          id: event.payload.offerId,
          opportunityId,
          ...offer,
          preparedAt: event.occurredAt,
          preparedBy: event.actor.id,
        },
      });
    }
    case "opportunity.decided": {
      assertState(current.state, ["offer_ready"], event.type);
      if (event.actor.kind !== "human") {
        throw new OpcDomainError("HUMAN_REQUIRED", "机会决策只能由人完成", "请由负责人作出决策");
      }
      assertOneOf(event.payload.choice, ["pursue", "revise", "stop"], "decision", "决策");
      return update(current, event, {
        state: "decided",
        decision: {
          id: event.payload.decisionId,
          opportunityId,
          choice: event.payload.choice,
          rationale: requireText(event.payload.rationale, "rationale", "决策理由"),
          decidedAt: event.occurredAt,
          decidedBy: event.actor.id,
        },
      });
    }
    case "opportunity.paused":
      assertState(current.state, [event.payload.previousState], event.type);
      return update(current, event, {
        state: "paused",
        stateBeforePause: event.payload.previousState,
        pauseReason: requireText(event.payload.reason, "reason", "暂停原因"),
      });
    case "opportunity.resumed":
      assertState(current.state, ["paused"], event.type);
      if (current.stateBeforePause !== event.payload.resumedState) {
        throw new OpcDomainError("INVALID_TRANSITION", "恢复状态与暂停前状态不一致", "重新读取机会后重试");
      }
      return update(current, event, {
        state: event.payload.resumedState,
        stateBeforePause: undefined,
        pauseReason: undefined,
      });
    case "opportunity.abandoned":
      if (current.state === "decided" || current.state === "abandoned") {
        throw invalidTransition(current.state, event.type);
      }
      return update(current, event, {
        state: "abandoned",
        abandonmentReason: requireText(event.payload.reason, "reason", "放弃原因"),
        stateBeforePause: undefined,
        pauseReason: undefined,
      });
  }
}

export function deriveEvidenceLevel(
  signals: OpportunityAggregate["signals"],
  commitmentEvidence: OpportunityAggregate["commitmentEvidence"],
): EvidenceLevel {
  let level: EvidenceLevel = signals.some((signal) => signal.evidenceKind === "interest")
    ? "interest"
    : "none";
  for (const evidence of commitmentEvidence) {
    if (evidence.status !== "confirmed") continue;
    if (EVIDENCE_RANK[evidence.level] > EVIDENCE_RANK[level]) level = evidence.level;
  }
  return level;
}

function update(
  current: OpportunityAggregate,
  event: StoredOpcEvent,
  changes: Partial<OpportunityAggregate>,
): OpportunityAggregate {
  return {
    ...current,
    ...changes,
    streamVersion: event.streamVersion,
    updatedAt: event.occurredAt,
  };
}

function updateWithEvidence(
  current: OpportunityAggregate,
  event: StoredOpcEvent,
  changes: Pick<Partial<OpportunityAggregate>, "signals" | "commitmentEvidence">,
): OpportunityAggregate {
  const next = update(current, event, changes);
  return { ...next, evidenceLevel: deriveEvidenceLevel(next.signals, next.commitmentEvidence) };
}

function assertNextVersion(current: OpportunityAggregate, event: StoredOpcEvent): void {
  if (event.streamVersion !== current.streamVersion + 1) {
    throw new OpcDomainError(
      "STREAM_VERSION_CONFLICT",
      `事件版本 ${event.streamVersion} 与当前版本 ${current.streamVersion} 不连续`,
      "重新读取机会后重试",
    );
  }
}

function assertState(
  actual: OpportunityState,
  expected: readonly OpportunityState[],
  eventType: string,
): void {
  if (!expected.includes(actual)) throw invalidTransition(actual, eventType);
}

function invalidTransition(state: OpportunityState, eventType: string): OpcDomainError {
  return new OpcDomainError(
    "INVALID_TRANSITION",
    `状态 ${state} 不接受事件 ${eventType}`,
    "按机会验证流程完成前置步骤",
  );
}

function assertUniqueId(items: readonly { readonly id: string }[], id: string, label: string): void {
  if (items.some((item) => item.id === id)) {
    throw new OpcDomainError("DUPLICATE_ID", `${label} ID 已存在`, "生成新的 ID 后重试");
  }
}

export function normalizeOffer(input: MinimumPaidOfferInput): MinimumPaidOfferInput {
  const inScope = requireNonEmpty(input.inScope, "inScope", "范围").map((item) => requireText(item, "inScope", "范围项"));
  const outOfScope = requireNonEmpty(input.outOfScope, "outOfScope", "非范围").map((item) => requireText(item, "outOfScope", "非范围项"));
  const risks = requireNonEmpty(input.risks, "risks", "风险").map((item) => requireText(item, "risks", "风险项"));
  const amountMinor = requireText(input.price.amountMinor, "price.amountMinor", "价格假设金额");
  if (!/^[1-9]\d*$/u.test(amountMinor)) {
    throw new OpcDomainError("INVALID_INPUT", "价格假设金额必须是正整数最小货币单位", "修正金额后重试", "price.amountMinor");
  }
  const currency = requireText(input.price.currency, "price.currency", "币种").toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new OpcDomainError("INVALID_INPUT", "币种必须是三位大写代码", "填写 ISO 4217 币种代码", "price.currency");
  }
  return {
    targetCustomer: requireText(input.targetCustomer, "targetCustomer", "目标客户"),
    promisedOutcome: requireText(input.promisedOutcome, "promisedOutcome", "承诺结果"),
    inScope,
    outOfScope,
    price: {
      amountMinor,
      currency,
      assumption: requireText(input.price.assumption, "price.assumption", "价格假设"),
    },
    deliveryFormat: requireText(input.deliveryFormat, "deliveryFormat", "交付形式"),
    duration: requireText(input.duration, "duration", "交付周期"),
    acceptanceMethod: requireText(input.acceptanceMethod, "acceptanceMethod", "验收方式"),
    nextCustomerAction: requireText(input.nextCustomerAction, "nextCustomerAction", "下一次客户行动"),
    risks,
  };
}

function assertOneOf<T extends string>(
  value: T,
  allowed: readonly T[],
  field: string,
  label: string,
): void {
  if (!allowed.includes(value)) {
    throw new OpcDomainError("INVALID_INPUT", `${label}无效`, `修正${label}后重试`, field);
  }
}

function requirePublicSourceUrl(value: string | undefined): string {
  const sourceUrl = requireText(value ?? "", "sourceUrl", "公开网页来源");
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new OpcDomainError("INVALID_INPUT", "公开网页来源无效", "填写完整 HTTP 或 HTTPS 地址", "sourceUrl");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new OpcDomainError("INVALID_INPUT", "公开网页来源必须是无凭据的 HTTP 或 HTTPS 地址", "修正公开网页地址", "sourceUrl");
  }
  return url.href;
}
