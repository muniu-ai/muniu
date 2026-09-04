// SPDX-License-Identifier: Apache-2.0

import {
  OpcDomainError,
  type CommitmentEvidenceLevel,
  type DecisionChoice,
  type ExperimentInput,
  type MinimumPaidOfferInput,
  type OpcService,
  type OpportunityAggregate,
  type SignalEvidenceKind,
  type SignalInput,
  type SignalRelationship,
  type SignalSourceKind,
} from "@mn/plugin-opc";

export interface ExecuteOpcCommandOptions {
  readonly service: OpcService;
  readonly scopedWorkspaceId: string;
  readonly opportunityId: string;
  readonly expectedStreamVersion: number;
  readonly actorId: string;
  readonly command: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly idempotencyRequest: unknown;
}

export async function executeOpcCommand(
  options: ExecuteOpcCommandOptions,
): Promise<OpportunityAggregate> {
  const input = object(options.input, "input");
  const base = {
    workspaceId: options.scopedWorkspaceId,
    opportunityId: options.opportunityId,
    expectedStreamVersion: options.expectedStreamVersion,
    actor: { id: options.actorId, kind: "human" as const },
    idempotency: { key: options.idempotencyKey, request: options.idempotencyRequest },
  };
  switch (options.command) {
    case "frame":
      return options.service.frame({
        ...base,
        targetCustomer: text(input, "targetCustomer"),
        problem: text(input, "problem"),
        falsifiableHypothesis: text(input, "falsifiableHypothesis"),
      });
    case "start_research":
      return options.service.startResearch(base);
    case "record_signal":
      return options.service.recordSignal({ ...base, signal: signal(input) });
    case "start_interviewing":
      return options.service.startInterviewing(base);
    case "record_interview":
      if (Object.hasOwn(input, "rawRecord")) {
        throw new OpcDomainError(
          "INVALID_INPUT",
          "访谈原文不能直接写入命令",
          "先上传受保护附件，再提交 rawRecordAssetId",
          "rawRecord",
        );
      }
      return options.service.recordInterview({
        ...base,
        interviewId: text(input, "interviewId"),
        participantRef: text(input, "participantRef"),
        occurredAt: text(input, "occurredAt"),
        rawRecordAssetId: text(input, "rawRecordAssetId"),
      });
    case "annotate_interview":
      return options.service.annotateInterview({
        ...base,
        interviewId: text(input, "interviewId"),
        annotation: text(input, "annotation"),
      });
    case "start_evaluation":
      return options.service.startEvaluation(base);
    case "record_experiment":
      return options.service.recordExperiment({ ...base, experiment: experiment(input) });
    case "propose_commitment":
      return options.service.proposeCommitmentEvidence({
        ...base,
        evidence: {
          level: oneOf(input, "level", ["commitment", "paid"] as const) as CommitmentEvidenceLevel,
          description: text(input, "description"),
          sourceRef: text(input, "sourceRef"),
        },
      });
    case "confirm_commitment":
      return options.service.confirmCommitmentEvidence({ ...base, evidenceId: text(input, "evidenceId") });
    case "prepare_offer":
      return options.service.prepareOffer({ ...base, offer: offer(input) });
    case "decide":
      return options.service.decide({
        ...base,
        decision: oneOf(input, "decision", ["pursue", "revise", "stop"] as const) as DecisionChoice,
        rationale: text(input, "rationale"),
      });
    case "pause":
      return options.service.pause({ ...base, reason: text(input, "reason") });
    case "resume":
      return options.service.resume(base);
    case "abandon":
      return options.service.abandon({ ...base, reason: text(input, "reason") });
    default:
      throw new OpcDomainError(
        "UNKNOWN_COMMAND",
        `不支持 OPC 命令 ${options.command}`,
        "刷新客户端支持的命令列表",
        "command",
      );
  }
}

function signal(input: Record<string, unknown>): SignalInput {
  const sourceKind = oneOf(input, "sourceKind", ["public_web", "pasted", "file", "manual"] as const) as SignalSourceKind;
  return {
    sourceKind,
    ...(optionalText(input, "sourceUrl") ? { sourceUrl: optionalText(input, "sourceUrl") } : {}),
    ...(optionalText(input, "sourceAssetId") ? { sourceAssetId: optionalText(input, "sourceAssetId") } : {}),
    observedAt: text(input, "observedAt"),
    ...(optionalText(input, "excerpt") ? { excerpt: optionalText(input, "excerpt") } : {}),
    summary: text(input, "summary"),
    relationship: oneOf(input, "relationship", ["support", "oppose", "neutral"] as const) as SignalRelationship,
    evidenceKind: oneOf(input, "evidenceKind", ["context", "interest"] as const) as SignalEvidenceKind,
  };
}

function experiment(input: Record<string, unknown>): ExperimentInput {
  return {
    question: text(input, "question"),
    method: text(input, "method"),
    successCriterion: text(input, "successCriterion"),
    ...(optionalText(input, "outcome") ? { outcome: optionalText(input, "outcome") } : {}),
    status: oneOf(input, "status", ["planned", "completed"] as const),
  };
}

function offer(input: Record<string, unknown>): MinimumPaidOfferInput {
  const price = object(input.price, "price");
  return {
    targetCustomer: text(input, "targetCustomer"),
    promisedOutcome: text(input, "promisedOutcome"),
    inScope: textArray(input, "inScope"),
    outOfScope: textArray(input, "outOfScope"),
    price: {
      amountMinor: text(price, "amountMinor"),
      currency: text(price, "currency"),
      assumption: text(price, "assumption"),
    },
    deliveryFormat: text(input, "deliveryFormat"),
    duration: text(input, "duration"),
    acceptanceMethod: text(input, "acceptanceMethod"),
    nextCustomerAction: text(input, "nextCustomerAction"),
    risks: textArray(input, "risks"),
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(field, `${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function text(record: Record<string, unknown>, field: string, trim = true): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) throw invalid(field, `${field} 必须是非空字符串`);
  return trim ? value.trim() : value;
}

function optionalText(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw invalid(field, `${field} 必须是非空字符串`);
  return value.trim();
}

function textArray(record: Record<string, unknown>, field: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw invalid(field, `${field} 必须是字符串数组`);
  }
  return value.map((item) => (item as string).trim());
}

function oneOf<const T extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  allowed: T,
): T[number] {
  const value = record[field];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalid(field, `${field} 必须是 ${allowed.join("、")} 之一`);
  }
  return value as T[number];
}

function invalid(field: string, message: string): OpcDomainError {
  return new OpcDomainError("INVALID_INPUT", message, `修正 ${field} 后重试`, field);
}
