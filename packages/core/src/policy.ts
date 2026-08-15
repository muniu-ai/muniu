import type {
  AgentTask,
  ExecutionStrategy,
  GateId,
  Policy
} from "./types.js";

export const DEFAULT_REQUIRED_GATES: GateId[] = [
  "unit_test",
  "lint",
  "typecheck",
  "contract",
  "security",
  "llm_verifier"
];

export const DEFAULT_POLICY: Policy = {
  id: "default",
  name: "Default enterprise policy",
  allowedProviders: ["claude", "codex"],
  defaultRequiredGates: DEFAULT_REQUIRED_GATES,
  commandAllowlist: [
    "npm",
    "pnpm",
    "yarn",
    "node",
    "npx",
    "tsc",
    "vitest",
    "go",
    "cargo",
    "pytest",
    "python",
    "git"
  ],
  protectedPaths: [".env", ".env.local", "secrets/", ".ssh/"],
  requireHumanApprovalForCrossService: true,
  maxCandidates: 4,
  maxTimeoutSeconds: 7200
};

export function normalizeStrategy(
  strategy: Partial<ExecutionStrategy> | undefined,
  policy: Policy = DEFAULT_POLICY
): ExecutionStrategy {
  return {
    providers: strategy?.providers?.length
      ? strategy.providers.filter((provider) =>
          policy.allowedProviders.includes(provider)
        )
      : policy.allowedProviders,
    candidates: Math.max(
      1,
      Math.min(strategy?.candidates ?? 2, policy.maxCandidates)
    ),
    sandbox: strategy?.sandbox ?? "isolated-worktree",
    requiredGates: strategy?.requiredGates?.length
      ? Array.from(new Set(strategy.requiredGates))
      : policy.defaultRequiredGates,
    humanApproval: strategy?.humanApproval ?? "on-risk",
    timeoutSeconds: Math.max(
      60,
      Math.min(strategy?.timeoutSeconds ?? 3600, policy.maxTimeoutSeconds)
    )
  };
}

export function validateTaskPolicy(
  task: AgentTask,
  policy: Policy = DEFAULT_POLICY
): string[] {
  const errors: string[] = [];
  const unknownProviders = task.strategy.providers.filter(
    (provider) => !policy.allowedProviders.includes(provider)
  );

  if (unknownProviders.length > 0) {
    errors.push(`Provider is not allowed: ${unknownProviders.join(", ")}`);
  }

  if (task.strategy.candidates > policy.maxCandidates) {
    errors.push(
      `Candidate count ${task.strategy.candidates} exceeds max ${policy.maxCandidates}`
    );
  }

  if (task.strategy.timeoutSeconds > policy.maxTimeoutSeconds) {
    errors.push(
      `Timeout ${task.strategy.timeoutSeconds}s exceeds max ${policy.maxTimeoutSeconds}s`
    );
  }

  if (
    policy.requireHumanApprovalForCrossService &&
    task.targetServices.length > 1 &&
    task.strategy.humanApproval === "never"
  ) {
    errors.push("Cross-service tasks require human approval");
  }

  return errors;
}

export function requiresHumanApproval(task: AgentTask): boolean {
  return (
    task.strategy.humanApproval === "before-merge" ||
    (task.strategy.humanApproval === "on-risk" &&
      task.targetServices.length > 1)
  );
}
