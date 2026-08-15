import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { validateSpecRevision, type SpecRevision } from "@mn/specs";
import type {
  GateContractDocument,
  GateEvaluationFacts,
  GateEvaluationResult,
  GateRunnerV2
} from "./gateRegistry.js";

const TEXT_FILE_LIMIT = 1024 * 1024;
const OPERATION_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "send",
  "receive"
]);

function evaluator(
  id: string,
  gateId: string,
  evaluate: (cwd: string, facts: GateEvaluationFacts | undefined) =>
    | GateEvaluationResult
    | Promise<GateEvaluationResult>
): GateRunnerV2 {
  return {
    id,
    version: "2",
    gateIds: [gateId],
    languages: ["*"],
    evaluate(context) {
      if (context.signal?.aborted) {
        return { status: "cancelled", summary: `${gateId} cancelled before evaluation.` };
      }
      return evaluate(context.cwd, context.facts);
    }
  };
}

function missingFacts(gateId: string, field: string): GateEvaluationResult {
  return {
    status: "error",
    summary: `${gateId} requires immutable ${field} facts.`
  };
}

function specFromFacts(
  gateId: string,
  facts: GateEvaluationFacts | undefined
): SpecRevision | GateEvaluationResult {
  if (!facts?.spec) return missingFacts(gateId, "Spec");
  const validation = validateSpecRevision(facts.spec);
  if (!validation.valid) {
    return {
      status: "fail",
      summary: `Spec validation failed with ${validation.issues.length} issue(s).`,
      log: validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")
    };
  }
  return facts.spec as SpecRevision;
}

function createSpecSchemaRunner(): GateRunnerV2 {
  return evaluator("builtin/spec-schema", "spec_schema", (_cwd, facts) => {
    const spec = specFromFacts("spec_schema", facts);
    if ("summary" in spec) return spec;
    return { status: "pass", summary: "Spec revision schema and digest are valid." };
  });
}

function createSpecApprovalRunner(): GateRunnerV2 {
  return evaluator("builtin/spec-approval", "spec_approval", (_cwd, facts) => {
    const spec = specFromFacts("spec_approval", facts);
    if ("summary" in spec) return spec;
    return spec.status === "approved"
      ? { status: "pass", summary: `Spec revision ${spec.revision} is approved.` }
      : { status: "fail", summary: `Spec revision ${spec.revision} has status ${spec.status}.` };
  });
}

function createAcceptanceCoverageRunner(): GateRunnerV2 {
  return evaluator("builtin/acceptance-coverage", "acceptance_coverage", (_cwd, facts) => {
    const spec = specFromFacts("acceptance_coverage", facts);
    if ("summary" in spec) return spec;
    if (!Array.isArray(facts?.coveredSpecClauseIds)) {
      return missingFacts("acceptance_coverage", "coveredSpecClauseIds");
    }
    const covered = new Set(facts.coveredSpecClauseIds);
    const missing = spec.acceptanceCases
      .map((acceptance) => acceptance.id)
      .filter((id) => !covered.has(id))
      .sort(compareCodeUnits);
    return missing.length === 0
      ? { status: "pass", summary: "Every Acceptance Case has evidence coverage." }
      : {
          status: "fail",
          summary: `${missing.length} Acceptance Case(s) have no evidence coverage.`,
          log: missing.join("\n")
        };
  });
}

function createProtectedPathRunner(): GateRunnerV2 {
  return evaluator("builtin/protected-path", "protected_path", (_cwd, facts) => {
    if (!facts?.changedPaths || !facts.protectedPaths) {
      return missingFacts("protected_path", "changedPaths and protectedPaths");
    }
    const changed = facts.changedPaths.map(normalizeRepositoryPath);
    const protectedPaths = facts.protectedPaths.map(normalizePolicyPath);
    const violations = changed.filter((path) =>
      protectedPaths.some((pattern) => policyPathMatches(pattern, path))
    );
    return violations.length === 0
      ? { status: "pass", summary: "No protected path is modified." }
      : {
          status: "fail",
          summary: `${violations.length} protected path modification(s) detected.`,
          log: uniqueSorted(violations).join("\n")
        };
  });
}

function createDiffScopeRunner(): GateRunnerV2 {
  return evaluator("builtin/diff-scope", "diff_scope", (_cwd, facts) => {
    if (!facts?.changedPaths || !facts.allowedPaths) {
      return missingFacts("diff_scope", "changedPaths and allowedPaths");
    }
    const allowed = facts.allowedPaths.map(normalizePolicyPath);
    const outside = facts.changedPaths
      .map(normalizeRepositoryPath)
      .filter((path) => !allowed.some((pattern) => policyPathMatches(pattern, path)));
    return outside.length === 0
      ? { status: "pass", summary: "Diff is contained within the allowed scope." }
      : {
          status: "fail",
          summary: `${outside.length} changed path(s) are outside the allowed scope.`,
          log: uniqueSorted(outside).join("\n")
        };
  });
}

function createContractRunner(): GateRunnerV2 {
  return evaluator("builtin/contract", "contract", (_cwd, facts) => {
    if (!facts?.contractDocuments || facts.contractDocuments.length === 0) {
      return missingFacts("contract", "contractDocuments");
    }
    const findings: string[] = [];
    for (const document of facts.contractDocuments) {
      findings.push(...validateContractDocument(document));
    }
    const spec = facts.spec as { contracts?: { interface?: Record<string, unknown> } } | undefined;
    if (spec?.contracts?.interface?.breaking === true) {
      findings.push("Spec declares contracts.interface.breaking=true");
    }
    const artifact = JSON.stringify(
      { gate: "contract", findings: uniqueSorted(findings) },
      null,
      2
    );
    return findings.length === 0
      ? {
          status: "pass",
          summary: "OpenAPI/AsyncAPI documents are valid and no removed surface was detected.",
          artifacts: [{ kind: "contract", contentType: "application/json", content: artifact }]
        }
      : {
          status: "fail",
          summary: `${findings.length} contract compatibility issue(s) detected.`,
          log: uniqueSorted(findings).join("\n"),
          artifacts: [{ kind: "contract", contentType: "application/json", content: artifact }]
        };
  });
}

function validateContractDocument(document: GateContractDocument): string[] {
  const current = parseContract(document.content, document.path);
  const versionField = document.type;
  if (typeof current[versionField] !== "string") {
    return [`${document.path}: missing ${versionField} version`];
  }
  const surfaceField = document.type === "openapi" ? "paths" : "channels";
  const currentSurface = plainRecord(current[surfaceField]);
  if (!currentSurface) return [`${document.path}: ${surfaceField} must be an object`];
  if (!document.previousContent) return [];
  const previous = parseContract(document.previousContent, `${document.path} (previous)`);
  const previousSurface = plainRecord(previous[surfaceField]);
  if (!previousSurface) return [`${document.path}: previous ${surfaceField} must be an object`];
  const findings: string[] = [];
  for (const key of Object.keys(previousSurface)) {
    if (!(key in currentSurface)) {
      findings.push(`${document.path}: removed ${surfaceField} entry ${key}`);
      continue;
    }
    const beforeOperations = plainRecord(previousSurface[key]);
    const afterOperations = plainRecord(currentSurface[key]);
    if (!beforeOperations || !afterOperations) continue;
    for (const operation of Object.keys(beforeOperations).filter((name) =>
      OPERATION_METHODS.has(name.toLowerCase())
    )) {
      if (!(operation in afterOperations)) {
        findings.push(`${document.path}: removed ${key} operation ${operation}`);
      }
    }
  }
  return findings;
}

function parseContract(content: string, path: string): Record<string, unknown> {
  if (typeof content !== "string" || Buffer.byteLength(content) > TEXT_FILE_LIMIT) {
    throw new TypeError(`${path}: contract content is missing or too large`);
  }
  const document = parseDocument(content, { schema: "core", uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new TypeError(`${path}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const value = document.toJS({ maxAliasCount: 50 }) as unknown;
  const parsed = plainRecord(value);
  if (!parsed) throw new TypeError(`${path}: contract root must be an object`);
  return parsed;
}

function createMigrationSafetyRunner(): GateRunnerV2 {
  return evaluator("builtin/migration-safety", "migration_safety", async (cwd, facts) => {
    if (!facts?.changedPaths) return missingFacts("migration_safety", "changedPaths");
    const migrations = facts.changedPaths
      .map(normalizeRepositoryPath)
      .filter(isMigrationPath);
    if (migrations.length === 0) {
      return { status: "pass", summary: "No database migration is changed." };
    }
    const rollbacks = new Set((facts.rollbackPaths ?? []).map(normalizeRepositoryPath));
    const findings: string[] = [];
    for (const migration of migrations) {
      const content = await readSafeText(cwd, migration);
      const destructive = /\b(?:drop\s+(?:table|column|database)|truncate\s+table|alter\s+table[\s\S]*?\bset\s+not\s+null|alter\s+type)\b/iu.test(
        content
      );
      const hasRollback = [...rollbacks].some((rollback) => rollbackFor(migration, rollback));
      if (!hasRollback) findings.push(`${migration}: no rollback migration is declared`);
      if (destructive) findings.push(`${migration}: destructive migration statement detected`);
    }
    return findings.length === 0
      ? { status: "pass", summary: "Migration changes have rollback coverage and no destructive statement." }
      : {
          status: "fail",
          summary: `${findings.length} migration safety issue(s) detected.`,
          log: uniqueSorted(findings).join("\n")
        };
  });
}

function createSecurityRunner(): GateRunnerV2 {
  return evaluator("builtin/security", "security", async (cwd, facts) => {
    if (!facts?.changedPaths) return missingFacts("security", "changedPaths");
    const findings: Array<{ path: string; rule: string }> = [];
    for (const path of facts.changedPaths.map(normalizeRepositoryPath)) {
      if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|ya?ml|json|toml|env|properties)$/iu.test(path)) {
        continue;
      }
      const content = await readSafeText(cwd, path);
      for (const [rule, pattern] of SECURITY_PATTERNS) {
        if (pattern.test(content)) findings.push({ path, rule });
        pattern.lastIndex = 0;
      }
    }
    const sarif = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "mn-static-security", rules: [] } },
          results: findings.map((finding) => ({
            ruleId: finding.rule,
            message: { text: finding.rule },
            locations: [{ physicalLocation: { artifactLocation: { uri: finding.path } } }]
          }))
        }
      ]
    });
    return findings.length === 0
      ? {
          status: "pass",
          summary: "Static security checks found no high-confidence issue.",
          artifacts: [{ kind: "sarif", contentType: "application/sarif+json", content: sarif }]
        }
      : {
          status: "fail",
          summary: `${findings.length} high-confidence security issue(s) detected.`,
          log: findings.map((finding) => `${finding.path}: ${finding.rule}`).join("\n"),
          artifacts: [{ kind: "sarif", contentType: "application/sarif+json", content: sarif }]
        };
  });
}

const SECURITY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private-key", /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/gu],
  ["api-key", /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gu],
  ["aws-secret", /\bAKIA[0-9A-Z]{16}\b/gu],
  ["hardcoded-password", /\b(?:password|passwd|secret)\s*[:=]\s*["'][^"'\n]{8,}["']/giu],
  ["dynamic-eval", /\b(?:eval|exec)\s*\(/gu]
];

async function readSafeText(cwd: string, repositoryPath: string): Promise<string> {
  const root = resolve(cwd);
  const absolute = resolve(root, repositoryPath);
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError(`Path escapes gate workspace: ${repositoryPath}`);
  }
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > TEXT_FILE_LIMIT) {
    throw new TypeError(`Gate input is not a safe bounded file: ${repositoryPath}`);
  }
  return readFile(absolute, "utf8");
}

function normalizeRepositoryPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value)
  ) {
    throw new TypeError(`Invalid repository path: ${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`Repository path contains traversal: ${value}`);
  }
  return segments.join("/");
}

function normalizePolicyPath(value: string): string {
  if (value.endsWith("/**")) return `${normalizeRepositoryPath(value.slice(0, -3))}/**`;
  if (value.endsWith("/")) return `${normalizeRepositoryPath(value.slice(0, -1))}/`;
  return normalizeRepositoryPath(value);
}

function policyPathMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  return path === pattern;
}

function isMigrationPath(path: string): boolean {
  return (
    path.split("/").some((segment) => /^(?:migrations?|migrate)$/u.test(segment.toLowerCase())) &&
    /\.(?:sql|xml|ya?ml|json|js|ts|py)$/iu.test(path)
  );
}

function rollbackFor(migration: string, rollback: string): boolean {
  const migrationStem = migration
    .replace(/\.[^.]+$/u, "")
    .replace(/(?:[._-](?:up|forward))$/iu, "");
  const rollbackStem = rollback
    .replace(/\.[^.]+$/u, "")
    .replace(/(?:[._-](?:down|rollback|revert))$/iu, "");
  return migrationStem === rollbackStem;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createPolicyGateRunners(): readonly GateRunnerV2[] {
  return [
    createSpecSchemaRunner(),
    createSpecApprovalRunner(),
    createAcceptanceCoverageRunner(),
    createProtectedPathRunner(),
    createDiffScopeRunner(),
    createContractRunner(),
    createMigrationSafetyRunner(),
    createSecurityRunner()
  ];
}
