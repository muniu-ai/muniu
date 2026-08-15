import type { CandidateRecord, GateResult } from "./types.js";

export interface GateSummary {
  status: "pass" | "fail" | "warn";
  failed: GateResult[];
  warnings: GateResult[];
  passed: GateResult[];
}

export function summarizeGates(gates: GateResult[]): GateSummary {
  const failed = gates.filter((gate) => gate.status === "fail");
  const warnings = gates.filter((gate) => gate.status === "warn");
  const passed = gates.filter((gate) => gate.status === "pass");

  return {
    status: failed.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
    failed,
    warnings,
    passed
  };
}

export function blocksMerge(gates: GateResult[]): boolean {
  return gates.some((gate) => gate.status === "fail");
}

export function scoreCandidate(candidate: CandidateRecord): number {
  const gateScore = candidate.gates.reduce((score, gate) => {
    if (gate.status === "pass") return score + 10;
    if (gate.status === "warn") return score + 2;
    if (gate.status === "skipped") return score - 1;
    return score - 10;
  }, 0);

  const resultScore = candidate.result?.status === "completed" ? 25 : -25;

  return gateScore + resultScore;
}

export function selectWinner(
  candidates: CandidateRecord[]
): CandidateRecord | undefined {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.status === "completed" && !blocksMerge(candidate.gates)
  );

  return eligible.sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0];
}
