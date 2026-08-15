import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASSIC_WORKFLOW_REF,
  GOVERNED_INCREMENT_WORKFLOW_REF,
  isGovernedTask,
  resolveTaskWorkflowRef,
  validateTaskWorkflowBindings
} from "../src/index.js";

const digest = "a".repeat(64);

test("legacy tasks default to classic-v1 without requiring new fields", () => {
  const task = {};
  assert.deepEqual(resolveTaskWorkflowRef(task), CLASSIC_WORKFLOW_REF);
  assert.equal(isGovernedTask(task), false);
  assert.deepEqual(validateTaskWorkflowBindings(task), []);
});

test("a Spec-bound task defaults to the governed workflow", () => {
  const task = {
    specRef: { specSetId: "checkout", revision: 2, digest }
  };
  assert.deepEqual(resolveTaskWorkflowRef(task), GOVERNED_INCREMENT_WORKFLOW_REF);
  assert.equal(isGovernedTask(task), true);
  assert.deepEqual(validateTaskWorkflowBindings(task), []);
});

test("governed references fail closed when malformed or unbound", () => {
  assert.deepEqual(
    validateTaskWorkflowBindings({
      workflowRef: { id: "governed-increment-v1", version: "1", digest }
    }),
    ["governed-increment-v1 requires specRef"]
  );

  const errors = validateTaskWorkflowBindings({
    specRef: { specSetId: " ", revision: 0, digest: "bad" },
    workflowRef: { id: " governed-increment-v1", version: "", digest: "BAD" },
    harnessProfileRef: { id: "enterprise", version: "1", digest: "BAD" }
  });
  assert.ok(errors.some((message) => message.includes("specRef.specSetId")));
  assert.ok(errors.some((message) => message.includes("specRef.revision")));
  assert.ok(errors.some((message) => message.includes("specRef.digest")));
  assert.ok(errors.some((message) => message.includes("workflowRef.id")));
  assert.ok(errors.some((message) => message.includes("workflowRef.version")));
  assert.ok(errors.some((message) => message.includes("workflowRef.digest")));
  assert.ok(errors.some((message) => message.includes("harnessProfileRef.digest")));

  const missingDigest = validateTaskWorkflowBindings({
    workflowRef: {
      id: "governed-increment-v1",
      version: "1"
    } as never
  });
  assert.ok(missingDigest.some((message) => message.includes("workflowRef.digest")));
});
