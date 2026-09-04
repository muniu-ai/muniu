import { OpcDomainError, requireText } from "./errors.js";
import type { OpportunityCaptureDraft } from "./model.js";

const MAX_CAPTURE_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 80;

export function createOpportunityDraft(input: string): OpportunityCaptureDraft {
  const rawInput = requireText(input, "text", "机会描述");
  if (rawInput.length > MAX_CAPTURE_LENGTH) {
    throw new OpcDomainError(
      "INVALID_INPUT",
      `机会描述不能超过 ${MAX_CAPTURE_LENGTH} 个字符`,
      "缩短描述或改用附件",
      "text",
    );
  }

  const explicitTitle = extractField(rawInput, ["机会", "名称", "标题"]);
  const explicitTargetCustomer = extractField(rawInput, ["目标客户", "客户"]);
  const explicitProblem = extractField(rawInput, ["问题"]);
  const explicitHypothesis = extractField(rawInput, ["假设", "可证伪假设"]);
  const audienceAndProblem = inferAudienceAndProblem(rawInput);
  const targetCustomer = explicitTargetCustomer ?? audienceAndProblem?.targetCustomer;
  const problem = explicitProblem ?? audienceAndProblem?.problem;
  const falsifiableHypothesis = explicitHypothesis ?? inferIfThenHypothesis(rawInput);
  const inferredFields: ("title" | "targetCustomer" | "problem" | "falsifiableHypothesis")[] = [];
  if (!explicitTitle) inferredFields.push("title");
  if (!explicitTargetCustomer && targetCustomer) inferredFields.push("targetCustomer");
  if (!explicitProblem && problem) inferredFields.push("problem");
  if (!explicitHypothesis && falsifiableHypothesis) inferredFields.push("falsifiableHypothesis");
  const title = truncate(explicitTitle ?? problem ?? firstClause(rawInput), MAX_TITLE_LENGTH);

  return {
    rawInput,
    title,
    ...(targetCustomer ? { targetCustomer } : {}),
    ...(problem ? { problem } : {}),
    ...(falsifiableHypothesis ? { falsifiableHypothesis } : {}),
    reviewRequired: true,
    inferredFields,
  };
}

function inferAudienceAndProblem(
  input: string,
): { readonly targetCustomer: string; readonly problem: string } | undefined {
  const match = /(?:面向|为)\s*([^，,。；;]{2,60})[，,]\s*(?:解决|降低|减少|避免)\s*([^，,。；;]{2,120})/u.exec(input)
    ?? /帮助\s*([^，,。；;]{2,60}?)\s*(?:解决|降低|减少|避免)\s*([^，,。；;]{2,120})/u.exec(input);
  const targetCustomer = match?.[1]?.trim();
  const problem = match?.[2]?.trim();
  return targetCustomer && problem ? { targetCustomer, problem } : undefined;
}

function inferIfThenHypothesis(input: string): string | undefined {
  return /(如果[^。；;]{2,160}(?:那么|则)[^。；;]{2,160})/u.exec(input)?.[1]?.trim();
}

function extractField(input: string, labels: readonly string[]): string | undefined {
  const alternation = labels.map(escapeRegExp).join("|");
  const expression = new RegExp(
    `(?:^|[；;。\\n])\\s*(?:${alternation})\\s*[:：]\\s*([^；;。\\n]+)`,
    "u",
  );
  const match = expression.exec(input);
  return match?.[1]?.trim() || undefined;
}

function firstClause(input: string): string {
  return input.split(/[；;。\n]/u, 1)[0]?.trim() || "新机会";
}

function truncate(value: string, maxLength: number): string {
  const points = [...value];
  return points.length <= maxLength ? value : `${points.slice(0, maxLength - 1).join("")}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
