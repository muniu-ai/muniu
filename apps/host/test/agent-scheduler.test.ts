// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { chooseAgent, type SchedulingCandidate } from "../src/agent-scheduler.js";

const candidate = (id: string, changes: Partial<SchedulingCandidate> = {}): SchedulingCandidate => ({
  id, runnerId: "builtin", modelBindingId: id, fingerprint: id, label: id, currency: "CNY", reasons: [],
  expectedCostMinorUnits: "10", expectedDurationMs: 60000, samples: 20, accepted: 18, ...changes,
});
const request = { strategy: "quality" as const, runnerId: "auto" as const };
const budget = { maxTokens: 10000, maxCostMinorUnits: "1000", currency: "CNY", maxDurationMs: 600000 };
test("质量优先选择验收下界较高的候选，不偏向最低单价", () => {
  const result = chooseAgent([candidate("cheap", { accepted: 10, expectedCostMinorUnits: "1" }), candidate("quality", { accepted: 19, expectedCostMinorUnits: "100" })], request, budget);
  assert.equal(result.selectedId, "quality");
  assert.ok(result.candidates[1]!.qualityLowerBound > result.candidates[0]!.qualityLowerBound);
});
test("费用未知的 CLI 不按零计价，明确人工选择仍可审阅", () => {
  const cli = candidate("codex-cli", { runnerId: "codex-cli", expectedCostMinorUnits: undefined });
  assert.equal(chooseAgent([cli, candidate("builtin")], request, budget).selectedId, "builtin");
  assert.equal(chooseAgent([cli], { ...request, runnerId: "codex-cli" }, budget).selectedId, "codex-cli");
  assert.equal(chooseAgent([cli], { ...request, runnerId: "codex-cli" }, budget).candidates[0]!.expectedTotalCostMinorUnits, null);
});
test("预算、币种、不可用状态是硬约束，人工选择也不能绕过", () => {
  const denied = [candidate("large", { expectedCostMinorUnits: "1001" }), candidate("usd", { currency: "USD" }), candidate("missing", { reasons: ["身份未确认"] })];
  assert.throws(() => chooseAgent(denied, request, budget), /没有符合/u);
  assert.throws(() => chooseAgent(denied, { ...request, runnerId: "builtin", modelBindingId: "missing" }, budget), /没有符合/u);
});
test("少量成功样本不产生虚假的高质量证据，结果与输入顺序无关", () => {
  const choices = [candidate("a", { samples: 1, accepted: 1 }), candidate("b", { samples: 20, accepted: 18 })];
  assert.equal(chooseAgent(choices, request, budget).selectedId, "b");
  assert.equal(chooseAgent([...choices].reverse(), request, budget).selectedId, "b");
  assert.equal(chooseAgent(choices, request, budget).candidates[0]!.evidence, "insufficient");
});
test("成本优先保留质量门槛，价值和时间输入产生可解释的净收益", () => {
  const choices = [candidate("unreliable", { accepted: 5, expectedCostMinorUnits: "1" }), candidate("fast", { expectedCostMinorUnits: "20", expectedDurationMs: 1000 }), candidate("slow", { expectedCostMinorUnits: "1", expectedDurationMs: 500000 })];
  const result = chooseAgent(choices, { ...request, strategy: "cost", expectedValueMinorUnits: "10000", timeCostMinorUnitsPerHour: "3600" }, budget);
  assert.equal(result.selectedId, "fast");
  assert.ok(Number(result.candidates.find(c => c.id === "fast")!.expectedNetValueMinorUnits) > 0);
  assert.equal(chooseAgent([candidate("a")], request, budget).candidates[0]!.roiBasisPoints, null);
});
test("冷启动明确标为无历史依据，沿用用户首选模型而非厂商排行", () => {
  const choices = [candidate("b", { samples: 0, accepted: 0 }), candidate("a", { samples: 0, accepted: 0 })];
  assert.equal(chooseAgent(choices, { ...request, modelBindingId: "b" }, budget).selectedId, "b");
});

test("候选历史明显不足以交付时自动调度拒绝，ROI 使用完成价值减返工总成本", () => {
  assert.throws(() => chooseAgent([candidate("bad", { samples: 100, accepted: 10 })], request, budget), /没有符合/u);
  const picked = chooseAgent([candidate("good")], { ...request, expectedValueMinorUnits: "1000" }, budget).candidates[0]!;
  assert.equal(BigInt(picked.expectedNetValueMinorUnits!) + BigInt(picked.expectedTotalCostMinorUnits!), 1000n);
});

test("手动选择零验收候选时不编造有限返工成本或 ROI", () => {
  for (let samples = 5; samples <= 100; samples++) {
    const picked = chooseAgent([candidate("bad", { samples, accepted: 0 })], { ...request, runnerId: "builtin", expectedValueMinorUnits: "1000" }, budget).candidates[0]!;
    assert.equal(picked.qualityLowerBound, 0);
    assert.equal(picked.expectedTotalCostMinorUnits, null);
    assert.equal(picked.expectedNetValueMinorUnits, null);
    assert.equal(picked.roiBasisPoints, null);
  }
});
