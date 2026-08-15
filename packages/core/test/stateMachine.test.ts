import assert from "node:assert/strict";
import test from "node:test";
import {
  canTransitionRun,
  isTerminalRunStatus,
  transitionRun
} from "../src/index.js";

test("run state machine allows the standard execution path", () => {
  assert.equal(canTransitionRun("queued", "preparing"), true);
  assert.equal(canTransitionRun("preparing", "running"), true);
  assert.equal(canTransitionRun("running", "verifying"), true);
  assert.equal(canTransitionRun("verifying", "completed"), true);
});

test("run state machine rejects invalid transitions", () => {
  assert.throws(
    () => transitionRun("queued", "completed"),
    /Invalid run transition/
  );
});

test("run state machine marks terminal states", () => {
  assert.equal(isTerminalRunStatus("completed"), true);
  assert.equal(isTerminalRunStatus("failed"), true);
  assert.equal(isTerminalRunStatus("running"), false);
});
