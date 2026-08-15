import assert from "node:assert/strict";
import test from "node:test";
import {
  approveSpecRevision,
  createNextSpecRevision,
  digestSpecRevision,
  validateSpecRevision
} from "../src/index.js";
import { makeRevision } from "./fixtures.js";

test("approval creates a new immutable approved revision and preserves predecessor", () => {
  const predecessor = makeRevision();
  const before = structuredClone(predecessor);

  const approved = approveSpecRevision(predecessor, {
    approvedBy: "reviewer@example.com",
    approvedAt: "2026-07-12T00:00:00.000Z"
  });

  assert.deepEqual(predecessor, before);
  assert.equal(predecessor.status, "draft");
  assert.equal(approved.revision, predecessor.revision + 1);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, "reviewer@example.com");
  assert.equal(approved.approvedAt, "2026-07-12T00:00:00.000Z");
  assert.equal(approved.digest, digestSpecRevision(approved));
  assert.equal(validateSpecRevision(approved).valid, true);
  assert.ok(Object.isFrozen(approved));
  assert.ok(Object.isFrozen(approved.acceptanceCases));
});

test("approval rejects missing approver identity", () => {
  assert.throws(
    () =>
      approveSpecRevision(makeRevision(), {
        approvedBy: " ",
        approvedAt: "2026-07-12T00:00:00.000Z"
      }),
    /approvedBy must be a non-empty string/u
  );
});

test("approval rejects an approval timestamp before its predecessor", () => {
  assert.throws(
    () =>
      approveSpecRevision(makeRevision(), {
        approvedBy: "reviewer@example.com",
        approvedAt: "2026-07-10T23:59:59.999Z"
      }),
    /at or after the predecessor event floor/u
  );
});

test("next revision rejects a timestamp before its predecessor", () => {
  const predecessor = makeRevision();
  assert.throws(
    () =>
      createNextSpecRevision(predecessor, {
        createdAt: "2026-07-10T23:59:59.999Z"
      }),
    /at or after the predecessor event floor/u
  );
});

test("next revision and approval respect an approved predecessor event floor", () => {
  const predecessor = approveSpecRevision(makeRevision(), {
    approvedBy: "reviewer@example.com",
    approvedAt: "2026-07-12T00:00:00.000Z"
  });

  assert.throws(
    () =>
      createNextSpecRevision(predecessor, {
        createdAt: "2026-07-11T12:00:00.000Z"
      }),
    /predecessor event floor/u
  );
  assert.throws(
    () =>
      approveSpecRevision(predecessor, {
        approvedBy: "reviewer@example.com",
        approvedAt: "2026-07-11T12:00:00.000Z"
      }),
    /predecessor event floor/u
  );
});
