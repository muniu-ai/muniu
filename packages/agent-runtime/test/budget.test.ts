// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRuntimeStore, PersistentExecutionBudget, ExecutionBudgetExceededError } from "../src/index.js";

test("execution deadlines survive reopening and cannot be extended by another turn", async () => {
  const store = new InMemoryRuntimeStore();
  let time = 1000;
  const options = { store, executionId: "execution", maxDurationMs: 100, now: () => time };
  const budget = new PersistentExecutionBudget(options);
  assert.equal(await budget.remainingMilliseconds(), 100);
  time = 1080;
  assert.equal(await new PersistentExecutionBudget({ ...options, maxDurationMs: 1000 }).remainingMilliseconds(), 20);
  time = 1100;
  await assert.rejects(budget.remainingMilliseconds(), ExecutionBudgetExceededError);
});

test("concurrent Coding repair reservations stop at three and survive restart", async () => {
  const store = new InMemoryRuntimeStore();
  const options = { store, executionId: "execution", maxDurationMs: 100, now: () => 1000 };
  const budgets = [new PersistentExecutionBudget(options), new PersistentExecutionBudget(options)];
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
    budgets[index % 2]!.reserveCounter("coding_repair", `repair-${index}`, 3)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 3);
  const reopened = new PersistentExecutionBudget(options);
  assert.equal(await reopened.counter("coding_repair"), 3);
  await assert.rejects(reopened.reserveCounter("coding_repair", "another-generation", 3), ExecutionBudgetExceededError);
  await reopened.reserveCounter("coding_repair", "repair-0", 3);
  assert.equal(await reopened.counter("coding_repair"), 3);
});

test("a zero duration allocation is exhausted, not reset or treated as invalid storage", async () => {
  const store = new InMemoryRuntimeStore();
  const options = { store, executionId: "zero", maxDurationMs: 0, now: () => 1000 };
  await assert.rejects(new PersistentExecutionBudget(options).remainingMilliseconds(), ExecutionBudgetExceededError);
  await assert.rejects(new PersistentExecutionBudget({ ...options, maxDurationMs: 1000 }).remainingMilliseconds(), ExecutionBudgetExceededError);
});
