// SPDX-License-Identifier: Apache-2.0
import type { AgentSchedulingCandidateV2, AgentSchedulingRequestV2, CodingRunnerId, GoalBudgetV2 } from "@mn/contracts";
import { KernelError } from "@mn/kernel";

export interface SchedulingCandidate {
  readonly id: string; readonly label: string; readonly runnerId: CodingRunnerId; readonly modelBindingId: string;
  readonly fingerprint: string; readonly currency: string; readonly samples: number; readonly accepted: number;
  readonly expectedCostMinorUnits?: string; readonly expectedDurationMs: number; readonly reasons: readonly string[];
}
// One-sided 95% Wilson bound. Cold-start candidates carry no measured success claim.
function lowerBound(successes: number, count: number): number {
  if (!count || !successes) return 0;
  const z = 1.645, rate = successes / count, z2 = z * z;
  return Math.floor(10000 * (rate + z2 / (2 * count) - z * Math.sqrt(rate * (1 - rate) / count + z2 / (4 * count * count))) / (1 + z2 / count)) / 10000;
}
const ceilDivide = (amount: bigint, divisor: bigint) => (amount + divisor - 1n) / divisor;
export function chooseAgent(candidates: readonly SchedulingCandidate[], request: AgentSchedulingRequestV2, budget: GoalBudgetV2): {
  selectedId: string; candidates: readonly AgentSchedulingCandidateV2[];
} {
  const evaluated = candidates.map((candidate): AgentSchedulingCandidateV2 => {
    const reasons = [...candidate.reasons];
    const observed = candidate.samples >= 5;
    const quality = observed ? lowerBound(candidate.accepted, candidate.samples) : 0;
    if (request.runnerId === "auto" && observed && quality < 0.5) reasons.push("历史验收率保守下界低于当前自动调度门槛（50%）");
    const cost = candidate.expectedCostMinorUnits === undefined ? null : BigInt(candidate.expectedCostMinorUnits);
    if (candidate.currency !== budget.currency) reasons.push("币种不同，未配置汇率换算");
    if (cost !== null && cost > BigInt(budget.maxCostMinorUnits)) reasons.push("预计执行费超过额度");
    if (candidate.expectedDurationMs > budget.maxDurationMs) reasons.push("预计耗时超过时限");
    if (request.runnerId === "auto" && candidate.runnerId !== "builtin" && (!observed || cost === null)) reasons.push("CLI 缺少足够的已验收与费用记录，请先人工选择验证");
    const timeCost = ceilDivide(BigInt(request.timeCostMinorUnitsPerHour ?? "0") * BigInt(candidate.expectedDurationMs), 3600000n);
    // Expected rework is priced conservatively only when acceptance observations exist.
    const total = cost === null || (observed && quality <= 0) ? null
      : observed ? ceilDivide((cost + timeCost) * 10000n, BigInt(Math.round(quality * 10000))) : cost + timeCost;
    const value = request.expectedValueMinorUnits !== undefined && observed ? BigInt(request.expectedValueMinorUnits) : null;
    const net = value === null || total === null ? null : value - total;
    const roi = net === null || total === null || total === 0n ? null : net * 10000n / total;
    return { ...candidate, qualityLowerBound: quality, evidence: observed ? "observed" : "insufficient",
      expectedCostMinorUnits: cost?.toString() ?? null, expectedTotalCostMinorUnits: total?.toString() ?? null,
      expectedNetValueMinorUnits: net?.toString() ?? null, roiBasisPoints: roi !== null && roi <= BigInt(Number.MAX_SAFE_INTEGER) && roi >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(roi) : null,
      eligible: reasons.length === 0, reasons };
  });
  let eligible = evaluated.filter(candidate => candidate.eligible && (request.runnerId === "auto" || candidate.runnerId === request.runnerId)
    && (request.runnerId !== "builtin" || !request.modelBindingId || candidate.modelBindingId === request.modelBindingId));
  if (!eligible.length) throw new KernelError("SCHEDULER_NO_CANDIDATE", "没有符合任务权限、费用和时限的执行者", "检查 Agent 配置或调整额度；费用未知的 CLI 需人工选择");
  const bestQuality = Math.max(...eligible.map(candidate => candidate.qualityLowerBound));
  if (request.runnerId === "auto" && bestQuality > 0) {
    const tolerance = request.strategy === "quality" ? 0 : request.strategy === "balanced" ? 0.05 : 0.1;
    eligible = eligible.filter(candidate => candidate.qualityLowerBound >= Math.max(0, bestQuality - tolerance));
  }
  const compareCost = (a: AgentSchedulingCandidateV2, b: AgentSchedulingCandidateV2) => {
    if (a.expectedTotalCostMinorUnits === null) return b.expectedTotalCostMinorUnits === null ? 0 : 1;
    if (b.expectedTotalCostMinorUnits === null) return -1;
    const delta = BigInt(a.expectedTotalCostMinorUnits) - BigInt(b.expectedTotalCostMinorUnits);
    return delta < 0n ? -1 : delta > 0n ? 1 : 0;
  };
  eligible.sort((a, b) => {
    if (a.evidence === "insufficient" && b.evidence === "insufficient") {
      const preferred = Number(b.modelBindingId === request.modelBindingId) - Number(a.modelBindingId === request.modelBindingId);
      if (preferred) return preferred;
    }
    if (request.strategy === "quality" && a.qualityLowerBound !== b.qualityLowerBound) return b.qualityLowerBound - a.qualityLowerBound;
    if (request.expectedValueMinorUnits && a.expectedNetValueMinorUnits !== null && b.expectedNetValueMinorUnits !== null) {
      const delta = BigInt(b.expectedNetValueMinorUnits) - BigInt(a.expectedNetValueMinorUnits);
      if (delta) return delta < 0n ? -1 : 1;
    }
    return compareCost(a, b) || a.expectedDurationMs - b.expectedDurationMs || a.id.localeCompare(b.id, "en");
  });
  return { selectedId: eligible[0]!.id, candidates: evaluated };
}
