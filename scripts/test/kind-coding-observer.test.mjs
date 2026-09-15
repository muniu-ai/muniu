// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { readPendingKindApproval } from "../lib/kind-coding-observer.mjs";

test("Kind approval polling is a scoped SELECT without Kernel write transactions", async () => {
  const approval = { id: "approval", status: "pending" };
  const pool = { async query(sql, values) {
    assert.match(sql, /^select value_json/u);
    assert.doesNotMatch(sql, /insert|update|delete|for update/iu);
    assert.deepEqual(values, ["tenant", "execution"]);
    assert.match(sql, /namespace = 'approval'/u);
    return { rows: [{ value_json: approval }] };
  } };
  assert.deepEqual(await readPendingKindApproval(pool, "tenant", "execution"), approval);
  assert.equal(await readPendingKindApproval({ async query() { return { rows: [] }; } }, "tenant", "execution"), undefined);
});

test("Kind retries only transient observation failures, never masks SQL or authorization failures", async () => {
  for (const error of [Object.assign(new Error("offline"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("restart"), { code: "57P01" }), new Error("timeout exceeded when trying to connect")]) {
    assert.equal(await readPendingKindApproval({ async query() { throw error; } }, "tenant", "execution"), undefined);
  }
  for (const code of ["42501", "42P01", "XX001"]) {
    const error = Object.assign(new Error("fixture error"), { code });
    await assert.rejects(readPendingKindApproval({ async query() { throw error; } }, "tenant", "execution"), error);
  }
});
