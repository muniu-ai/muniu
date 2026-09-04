import type {
  EvidenceLevel,
  OpportunityAggregate,
  Signal,
} from "./model.js";

export type OpcDeliverableKind =
  | "opportunity_validation_dossier"
  | "interview_pack"
  | "evidence_ledger"
  | "counterevidence_list"
  | "minimum_paid_offer"
  | "decision_record";

export interface OpcDeliverableOutcome {
  readonly kind: OpcDeliverableKind;
  readonly title: string;
  readonly expectedOutcome: string;
}

export const OPC_DELIVERABLE_OUTCOMES: readonly OpcDeliverableOutcome[] = Object.freeze([
  {
    kind: "opportunity_validation_dossier",
    title: "机会验证档案",
    expectedOutcome: "把客户、问题、可证伪假设、支持证据、反证和缺口放在同一份档案中",
  },
  {
    kind: "interview_pack",
    title: "访谈包",
    expectedOutcome: "提供非诱导提纲，并保留不可覆盖的原始访谈记录",
  },
  {
    kind: "evidence_ledger",
    title: "证据账本",
    expectedOutcome: "区分市场信号、兴趣、人工确认的承诺与付费证据",
  },
  {
    kind: "counterevidence_list",
    title: "反证清单",
    expectedOutcome: "优先呈现反对信号和仍需寻找的反证",
  },
  {
    kind: "minimum_paid_offer",
    title: "最小收费方案",
    expectedOutcome: "形成可审阅的目标客户、结果、范围、价格、验收和下一步",
  },
  {
    kind: "decision_record",
    title: "决策记录",
    expectedOutcome: "由人记录继续、修订或停止及其理由",
  },
]);

export interface OpcDeliverable {
  readonly kind: OpcDeliverableKind;
  readonly title: string;
  readonly summary: string;
  readonly validationStatus: string;
  readonly nextAction: string;
  readonly content: Readonly<Record<string, unknown>>;
}

export interface OpcDeliverableRenderOptions {
  /** 仅由完成工作区授权和受保护 Asset 解密的 API 边界提供。 */
  readonly interviewRawRecords?: ReadonlyMap<string, string>;
}

export function exportOpportunityDeliverables(
  opportunity: OpportunityAggregate,
  options: OpcDeliverableRenderOptions = {},
): readonly OpcDeliverable[] {
  const hypothesis = opportunity.hypotheses.at(-1);
  const support = opportunity.signals.filter((signal) => signal.relationship === "support");
  const opposition = opportunity.signals.filter((signal) => signal.relationship === "oppose");
  const gaps = evidenceGaps(opportunity, support, opposition);
  const validationStatus = validationLabel(opportunity.evidenceLevel);
  const nextAction = deriveNextAction(opportunity);

  return [
    deliverable("opportunity_validation_dossier", validationStatus, nextAction, {
      opportunity: opportunity.title,
      state: opportunity.state,
      targetCustomer: hypothesis?.targetCustomer ?? "待补充",
      problem: hypothesis?.problem ?? "待补充",
      falsifiableHypothesis: hypothesis?.statement ?? "待补充",
      supportEvidence: support.map(signalSummary),
      counterevidence: opposition.map(signalSummary),
      evidenceGaps: gaps,
    }),
    deliverable("interview_pack", validationStatus, nextAction, {
      guide: [
        "请回忆最近一次遇到这个问题的具体经过。",
        "当时你先做了什么，之后又做了什么？",
        "你已经尝试过哪些替代办法？结果怎样？",
        "这个问题造成了哪些可观察的成本或延误？",
        "接下来你准备怎么处理？",
      ],
      interviews: opportunity.interviews.map((interview) => ({
        id: interview.id,
        participantRef: interview.participantRef,
        occurredAt: interview.occurredAt,
        rawRecordAssetId: interview.rawRecordAssetId,
        ...(options.interviewRawRecords?.has(interview.rawRecordAssetId)
          ? { rawRecord: options.interviewRawRecords.get(interview.rawRecordAssetId) }
          : {}),
        annotations: interview.annotations.map((annotation) => ({
          text: annotation.text,
          createdBy: annotation.createdBy,
          actorKind: annotation.actorKind,
        })),
      })),
    }),
    deliverable("evidence_ledger", validationStatus, nextAction, {
      evidenceLevel: opportunity.evidenceLevel,
      signals: opportunity.signals.map((signal) => ({
        id: signal.id,
        sourceKind: signal.sourceKind,
        sourceUrl: signal.sourceUrl ?? null,
        sourceAssetId: signal.sourceAssetId ?? null,
        observedAt: signal.observedAt,
        excerpt: signal.excerpt ?? null,
        summary: signal.summary,
        relationship: signal.relationship,
        evidenceKind: signal.evidenceKind,
      })),
      commitmentEvidence: opportunity.commitmentEvidence.map((evidence) => ({
        id: evidence.id,
        level: evidence.level,
        description: evidence.description,
        sourceRef: evidence.sourceRef,
        status: evidence.status,
        confirmedBy: evidence.confirmedBy ?? null,
        confirmedAt: evidence.confirmedAt ?? null,
      })),
    }),
    deliverable("counterevidence_list", validationStatus, nextAction, {
      counterevidence: opposition.map(signalSummary),
      prompts: [
        "什么事实会直接推翻当前假设？",
        "哪些免费或低成本替代方案已经足够好？",
        "谁明确拒绝采取下一步，原因是什么？",
      ],
      gaps,
    }),
    deliverable("minimum_paid_offer", validationStatus, nextAction, opportunity.minimumPaidOffer
      ? { offer: opportunity.minimumPaidOffer }
      : { status: "尚未形成最小收费方案" }),
    deliverable("decision_record", validationStatus, nextAction, opportunity.decision
      ? { decision: opportunity.decision }
      : { status: "等待人工决策" }),
  ];
}

export function renderDeliverablesAsText(deliverables: readonly OpcDeliverable[]): string {
  return deliverables.map((item) => [
    item.title,
    item.validationStatus,
    item.summary,
    JSON.stringify(item.content),
    `下一步：${item.nextAction}`,
  ].join("\n")).join("\n\n");
}

function deliverable(
  kind: OpcDeliverableKind,
  validationStatus: string,
  nextAction: string,
  content: Readonly<Record<string, unknown>>,
): OpcDeliverable {
  const outcome = OPC_DELIVERABLE_OUTCOMES.find((item) => item.kind === kind);
  if (!outcome) throw new Error(`未声明的 OPC 成果 ${kind}`);
  return {
    kind,
    title: outcome.title,
    summary: outcome.expectedOutcome,
    validationStatus,
    nextAction,
    content,
  };
}

function validationLabel(level: EvidenceLevel): string {
  if (level === "paid") return "已有人工确认的付费证据";
  if (level === "commitment") return "已有人工确认的承诺证据";
  return "方案待验证";
}

function evidenceGaps(
  opportunity: OpportunityAggregate,
  support: readonly Signal[],
  opposition: readonly Signal[],
): readonly string[] {
  const gaps: string[] = [];
  if (support.length === 0) gaps.push("缺少支持当前假设的外部信号");
  if (opposition.length === 0) gaps.push("缺少主动寻找的反对信号");
  if (opportunity.interviews.length === 0) gaps.push("缺少目标客户原始访谈");
  if (!opportunity.commitmentEvidence.some((item) => item.status === "confirmed" && item.level === "commitment")) {
    gaps.push("缺少人工确认的客户承诺");
  }
  if (!opportunity.commitmentEvidence.some((item) => item.status === "confirmed" && item.level === "paid")) {
    gaps.push("缺少人工确认的付费证据");
  }
  return gaps;
}

function signalSummary(signal: Signal): Readonly<Record<string, unknown>> {
  return {
    summary: signal.summary,
    sourceKind: signal.sourceKind,
    sourceAssetId: signal.sourceAssetId ?? null,
    observedAt: signal.observedAt,
    excerpt: signal.excerpt ?? null,
  };
}

function deriveNextAction(opportunity: OpportunityAggregate): string {
  switch (opportunity.state) {
    case "captured": return "补充目标客户、问题和可证伪假设";
    case "framed": return "开始公开资料研究并记录来源";
    case "researching": return "整理支持、反对和中立信号";
    case "interviewing": return "完成非诱导访谈并保留原始记录";
    case "evaluating": return "并列审阅支持证据、反证和证据缺口";
    case "offer_ready": return "由负责人决定继续、修订或停止";
    case "decided": return "按人工决策执行并保留决策记录";
    case "paused": return "处理暂停原因后恢复原阶段";
    case "abandoned": return "保留证据，必要时创建新的验证机会";
  }
}
