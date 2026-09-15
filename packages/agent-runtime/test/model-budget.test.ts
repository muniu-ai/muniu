// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRuntimeStore, PersistentModelBudget, completeWithModelBudget } from "../src/index.js";

const limits = { maxTokens: 100, maxCostMinorUnits: "10", currency: "USD" };
const rates = { id: "fixture-v1", currency: "USD", inputNanoMinorUnitsPerToken: "1000000",
  cachedInputNanoMinorUnitsPerToken: "100000", outputNanoMinorUnitsPerToken: "2000000" };
const quote = { id: "request-1", requestDigest: "a".repeat(64), inputTokenLimit: 20, maxOutputTokens: 30, rates };
const usage = { inputTokens: 12, cachedInputTokens: 2, outputTokens: 8 };
const setup = (store = new InMemoryRuntimeStore(), budget = limits) =>
  new PersistentModelBudget({ store, executionId: "execution", limits: budget });

test("model reservations are durable, single-use and block unknown requests after restart", async () => {
  const store = new InMemoryRuntimeStore();
  await setup(store).reserve(quote);
  await assert.rejects(setup(store).reserve(quote), /未结算|重复/u);
  await assert.rejects(setup(store).reserve({ ...quote, id: "next" }), /未结算/u);
  assert.equal((await setup(store).snapshot()).pendingRequests, 1);
  await setup(store).settle(quote.id, usage);
  await setup(store).settle(quote.id, usage);
  await assert.rejects(setup(store).settle(quote.id, { ...usage, outputTokens: 9 }), /结算/u);
  const snapshot = await setup(store).snapshot();
  assert.equal(snapshot.knownTokens, 20);
  assert.equal(snapshot.knownCostNanoMinorUnits, "26200000");
  assert.equal(snapshot.pendingRequests, 0);
  await assert.rejects(setup(store).reserve(quote), /重复/u);
  await setup(store).reserve({ ...quote, id: "next" });
});

test("concurrent reservations cannot overdraw or reset token and cost limits", async () => {
  const store = new InMemoryRuntimeStore();
  const attempts = await Promise.allSettled(["a", "b"].map(id => setup(store).reserve({ ...quote, id })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const id = attempts[0]?.status === "fulfilled" ? "a" : "b";
  await setup(store).settle(id, { inputTokens: 20, cachedInputTokens: 0, outputTokens: 30 });
  await assert.rejects(setup(store, { ...limits, maxTokens: 1000 }).reserve({ ...quote, id: "over", inputTokenLimit: 71 }), /token/u);
  await assert.rejects(setup(store).reserve({ ...quote, id: "expensive", rates: {
    ...rates, outputNanoMinorUnitsPerToken: "1000000000" } }), /费用/u);
  await assert.rejects(setup(store).reserve({ ...quote, id: "currency", rates: { ...rates, currency: "CNY" } }), /币种/u);
});

test("provider overrun remains recorded and stops subsequent calls; invalid usage stays unknown", async () => {
  const store = new InMemoryRuntimeStore();
  await setup(store).reserve(quote);
  await assert.rejects(setup(store).settle(quote.id, { ...usage, cachedInputTokens: 99 }), /用量/u);
  assert.equal((await setup(store).snapshot()).pendingRequests, 1);
  await assert.rejects(setup(store).settle(quote.id, { ...usage, outputTokens: 120 }), /超出/u);
  assert.equal((await setup(store).snapshot()).knownTokens, 132);
  await assert.rejects(setup(store).reserve({ ...quote, id: "next" }), /超出/u);
});

test("model usage and child allocations share one parent budget", async () => {
  const store = new InMemoryRuntimeStore();
  await store.append({ executionId: "execution", type: "subagent/reserved", payload: {
    authority: { budget: { ...limits, maxTokens: 60, maxCostMinorUnits: "8" } } } });
  await assert.rejects(setup(store).reserve(quote), /token/u);
  await assert.rejects(setup(store).reserve({ ...quote, inputTokenLimit: 1, maxOutputTokens: 3,
    rates: { ...rates, outputNanoMinorUnitsPerToken: "1000000000" } }), /费用/u);
  await setup(store).reserve({ ...quote, inputTokenLimit: 1, maxOutputTokens: 3 });
  const snapshot = await setup(store).snapshot();
  assert.equal(snapshot.allocatedTokens, 64);
});

test("metered calls persist a commitment before transport and settle before returning tools", async () => {
  const store = new InMemoryRuntimeStore();
  const request = { executionId: "execution", agentId: "agent", generation: 1,
    messages: [{ role: "user" as const, content: "SECRET" }], availableToolIds: ["tool"] };
  const result = await completeWithModelBudget({ store, limits, request, modelKey: "fixture",
    quote: { inputTokenLimit: 20, maxOutputTokens: 30, rates }, signal: new AbortController().signal,
    async complete(actual) {
      assert.equal(actual.maxOutputTokens, 30);
      const pending = (await store.readExecution("execution")).find(record => record.type === "model/reserved");
      assert.ok(pending);
      assert.doesNotMatch(JSON.stringify(pending), /SECRET/u);
      return { text: "result", toolCalls: [], usage };
    } });
  assert.equal(result.text, "result");
  assert.equal((await setup(store).snapshot()).knownTokens, 20);
});

test("missing usage, transport loss and cancellation keep a durable unknown reservation", async () => {
  for (const outcome of ["missing", "loss", "cancel"] as const) {
    const store = new InMemoryRuntimeStore();
    const controller = new AbortController();
    let finish: ((value: { text: string; toolCalls: []; usage: typeof usage }) => void) | undefined;
    const pending = completeWithModelBudget({ store, limits, modelKey: "fixture",
      request: { executionId: "execution", agentId: "agent", generation: 1, messages: [], availableToolIds: [] },
      quote: { inputTokenLimit: 20, maxOutputTokens: 30, rates }, signal: controller.signal,
      async complete() {
        if (outcome === "missing") return { text: "unaccounted", toolCalls: [] };
        if (outcome === "loss") throw new Error("SECRET transport diagnostic");
        return new Promise(resolve => { finish = resolve; controller.abort(); });
      } });
    await assert.rejects(pending, error => {
      assert.match(String(error), /未结算/u);
      assert.doesNotMatch(String(error), /SECRET/u);
      return true;
    });
    finish?.({ text: "late", toolCalls: [], usage });
    await Promise.resolve();
    assert.equal((await setup(store).snapshot()).pendingRequests, 1);
    await assert.rejects(setup(store).reserve(quote), /未结算/u);
  }
});
