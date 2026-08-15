import type { HarnessCompilationIssue } from "./types.js";
import {
  deepFreezeJson,
  redactContextContent,
  redactSensitiveValue
} from "./redaction.js";

function sanitizeIssue(issue: HarnessCompilationIssue): HarnessCompilationIssue {
  let details: Readonly<Record<string, unknown>> | undefined;
  if (issue.details !== undefined) {
    try {
      details = redactSensitiveValue(issue.details);
    } catch {
      details = { redactionFailure: "Issue details were not safe JSON" };
    }
  }
  return deepFreezeJson({
    code: issue.code,
    message: redactContextContent(issue.message),
    ...(issue.field === undefined
      ? {}
      : { field: redactContextContent(issue.field) }),
    ...(details === undefined ? {} : { details })
  });
}

export class HarnessCompilationError extends Error {
  readonly issues: readonly HarnessCompilationIssue[];

  constructor(issues: readonly HarnessCompilationIssue[]) {
    const sanitized = issues.map(sanitizeIssue);
    super(
      `Harness compilation failed: ${sanitized
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ")}`
    );
    this.name = "HarnessCompilationError";
    this.issues = Object.freeze(sanitized);
  }
}
