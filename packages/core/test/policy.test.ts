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

  assert.deepEqual(strategy.providers, ["claude", "codex"]);
  assert.equal(strategy.candidates, 2);
  assert.equal(strategy.sandbox, "isolated-worktree");
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
