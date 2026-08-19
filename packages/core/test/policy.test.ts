import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_POLICY,
  normalizeStrategy,
  requiresHumanApproval,
  validateTaskPolicy
} from "../src/index.js";
import type { AgentTask } from "../src/index.js";

test("policy normalizes strategy defaults", () => {
  const strategy = normalizeStrategy(undefined, DEFAULT_POLICY);

  assert.equal(strategy.schemaVersion, 2);
  assert.deepEqual(strategy.targets, [{
    runtimeId: "builtin",
    providerId: "default",
    modelId: "default",
    candidates: 2
  }]);
  assert.equal(strategy.sandbox, "isolated-worktree");
});

test("policy deterministically migrates legacy providers to V2 targets", () => {
  const strategy = normalizeStrategy({
    providers: ["claude", "codex"],
    candidates: 3
  });

  assert.deepEqual(strategy.targets, [
    { runtimeId: "claude", candidates: 2 },
    { runtimeId: "codex", candidates: 1 }
  ]);
});

test("policy rejects builtin targets without provider and model bindings", () => {
  const task: AgentTask = {
    id: "task-invalid-builtin",
    projectId: "project-1",
    title: "invalid builtin",
    intent: "implement",
    targetServices: [],
    prompt: "change contract",
    acceptanceCriteria: [],
    strategy: {
      schemaVersion: 2,
      targets: [{ runtimeId: "builtin", candidates: 1 }],
      sandbox: "isolated-worktree",
      requiredGates: [],
      humanApproval: "never",
      timeoutSeconds: 300
    },
    createdAt: new Date(0).toISOString()
  };
  assert.ok(validateTaskPolicy(task).includes("Builtin target requires providerId and modelId"));
});

test("policy requires approval for cross-service task with default policy", () => {
  const task: AgentTask = {
    id: "task-1",
    projectId: "project-1",
    title: "change shared contract",
    intent: "implement",
    targetServices: ["api", "worker"],
    prompt: "change contract",
    acceptanceCriteria: ["contract tests pass"],
    strategy: normalizeStrategy({ humanApproval: "never" }),
    createdAt: new Date(0).toISOString()
  };

  assert.ok(
    validateTaskPolicy(task).includes(
      "Cross-service tasks require human approval"
    )
  );
  assert.equal(
    requiresHumanApproval({ ...task, strategy: normalizeStrategy({}) }),
    true
  );
});
