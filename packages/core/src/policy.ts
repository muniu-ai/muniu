import type {
  AgentRuntimeId,
  AgentTask,
  ExecutionStrategy,
  ExecutionStrategyV1,
  ExecutionStrategyV2,
  ExecutionTargetV2,
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
  allowedProviders: ["builtin", "claude", "codex"],
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
  strategy: Partial<ExecutionStrategyV1> | Partial<ExecutionStrategyV2> | undefined,
  policy: Policy = DEFAULT_POLICY
): ExecutionStrategyV2 {
  const common = {
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
  if (strategy && "targets" in strategy && Array.isArray(strategy.targets)) {
    return {
      schemaVersion: 2,
      targets: clampTargets(strategy.targets, policy),
      ...common
    };
  }

  const legacy = strategy as Partial<ExecutionStrategyV1> | undefined;
  const providers = legacy?.providers?.length
    ? legacy.providers.filter((provider) => policy.allowedProviders.includes(provider))
    : [];
  const candidates = Math.max(1, Math.min(legacy?.candidates ?? 2, policy.maxCandidates));
  return {
    schemaVersion: 2,
    targets: providers.length > 0
      ? migrateLegacyTargets(providers, candidates)
      : [{
          runtimeId: "builtin",
          providerId: "default",
          modelId: "default",
          candidates
        }],
    ...common
  };
}

function migrateLegacyTargets(
  providers: readonly Exclude<AgentRuntimeId, "builtin">[],
  candidates: number
): ExecutionTargetV2[] {
  const counts = new Map<Exclude<AgentRuntimeId, "builtin">, number>();
  for (let index = 0; index < candidates; index += 1) {
    const provider = providers[index % providers.length]!;
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return providers
    .filter((provider, index) => providers.indexOf(provider) === index)
    .map((runtimeId) => ({ runtimeId, candidates: counts.get(runtimeId) ?? 0 }))
    .filter((target) => target.candidates > 0);
}

function clampTargets(
  targets: readonly ExecutionTargetV2[],
  policy: Policy
): ExecutionTargetV2[] {
  const result: ExecutionTargetV2[] = [];
  let remaining = policy.maxCandidates;
  for (const target of targets) {
    if (remaining <= 0 || !policy.allowedProviders.includes(target.runtimeId)) continue;
    const candidates = Math.min(remaining, Math.max(1, Math.trunc(target.candidates || 1)));
    result.push({
      runtimeId: target.runtimeId,
      ...(target.providerId === undefined ? {} : { providerId: target.providerId }),
      ...(target.modelId === undefined ? {} : { modelId: target.modelId }),
      candidates
    });
    remaining -= candidates;
  }
  return result.length > 0 ? result : [{
    runtimeId: "builtin",
    providerId: "default",
    modelId: "default",
    candidates: 1
  }];
}

export function executionTargets(strategy: ExecutionStrategy): ExecutionTargetV2[] {
  if ("targets" in strategy) return strategy.targets.map((target) => ({ ...target }));
  return migrateLegacyTargets(strategy.providers, strategy.candidates);
}

export function executionCandidateCount(strategy: ExecutionStrategy): number {
  return executionTargets(strategy).reduce((total, target) => total + target.candidates, 0);
}

export function executionRuntimeIds(strategy: ExecutionStrategy): AgentRuntimeId[] {
  return [...new Set(executionTargets(strategy).map((target) => target.runtimeId))];
}

export function validateTaskPolicy(
  task: AgentTask,
  policy: Policy = DEFAULT_POLICY
): string[] {
  const errors: string[] = [];
  const targets = executionTargets(task.strategy);
  const unknownProviders = targets.map((target) => target.runtimeId).filter(
    (provider) => !policy.allowedProviders.includes(provider)
  );

  if (unknownProviders.length > 0) {
    errors.push(`Provider is not allowed: ${unknownProviders.join(", ")}`);
  }

  const candidateCount = executionCandidateCount(task.strategy);
  if (candidateCount > policy.maxCandidates) {
    errors.push(
      `Candidate count ${candidateCount} exceeds max ${policy.maxCandidates}`
    );
  }

  if (targets.some((target) => target.runtimeId === "builtin"
    && (!target.providerId?.trim() || !target.modelId?.trim()))) {
    errors.push("Builtin target requires providerId and modelId");
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
