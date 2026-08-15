import type { GovernanceIssue } from "./types.js";

export class GovernanceResolutionError extends Error {
  readonly code = "GOVERNANCE_RESOLUTION_FAILED" as const;
  readonly issues: readonly GovernanceIssue[];

  constructor(issues: readonly GovernanceIssue[]) {
    super(
      issues.length === 1
        ? issues[0]?.message ?? "Governance resolution failed"
        : `Governance resolution failed with ${issues.length} issues`
    );
    this.name = "GovernanceResolutionError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}
