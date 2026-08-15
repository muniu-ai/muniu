import type { CandidateRecord, GateResult } from "@mn/core";
import { scoreCandidate } from "@mn/core";

export interface VerificationCriteria {
  correctnessWeight: number;
  testWeight: number;
  maintainabilityWeight: number;
  riskWeight: number;
}

export interface CandidateScore {
  candidateId: string;
  score: number;
  reasons: string[];
  blockingGates: GateResult[];
}

export interface ComparisonResult {
  winnerCandidateId?: string;
  scores: CandidateScore[];
  summary: string;
}

export const DEFAULT_CRITERIA: VerificationCriteria = {
  correctnessWeight: 0.45,
  testWeight: 0.3,
  maintainabilityWeight: 0.15,
  riskWeight: 0.1
};

export function scoreForVerification(
  candidate: CandidateRecord,
  criteria: VerificationCriteria = DEFAULT_CRITERIA
): CandidateScore {
  const blockingGates = candidate.gates.filter((gate) => gate.status === "fail");
  const warnings = candidate.gates.filter((gate) => gate.status === "warn");
  const base = scoreCandidate(candidate);
  const outputBonus = candidate.result?.summary ? 5 : 0;
  const gatePenalty = blockingGates.length * 40 + warnings.length * 5;
  const weighted =
    base * criteria.correctnessWeight +
    outputBonus * criteria.maintainabilityWeight -
    gatePenalty * criteria.riskWeight;

  const reasons = [
    `base=${base}`,
    `outputBonus=${outputBonus}`,
    `blockingGates=${blockingGates.length}`,
    `warnings=${warnings.length}`
  ];

  return {
    candidateId: candidate.id,
    score: Math.round(weighted * 100) / 100,
    reasons,
    blockingGates
  };
}

export function compareCandidates(
  candidates: CandidateRecord[],
  criteria: VerificationCriteria = DEFAULT_CRITERIA
): ComparisonResult {
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreForVerification(candidate, criteria)
    }))
    .sort((a, b) => b.score.score - a.score.score);
  const winner = scored.find(
    ({ candidate, score }) =>
      candidate.status === "completed" && score.blockingGates.length === 0
  );

  return {
    winnerCandidateId: winner?.candidate.id,
    scores: scored.map(({ score }) => score),
    summary: winner
      ? `Winner is ${winner.candidate.id} with score ${winner.score.score}`
      : "No candidate passed blocking gates"
  };
}
