// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { findModelPrice, selectPricedModel } from "../src/index.js";

test("reference model prices retain native currencies, source dates and exact minor-unit arithmetic", () => {
  const openai = findModelPrice("openai", "gpt-5")!;
  assert.equal(openai.rates.currency, "USD");
  assert.equal(openai.rates.inputNanoMinorUnitsPerToken, "125000");
  assert.equal(openai.rates.cachedInputNanoMinorUnitsPerToken, "12500");
  assert.equal(openai.rates.outputNanoMinorUnitsPerToken, "1000000");
  const anthropic = findModelPrice("anthropic", "claude-sonnet-4-5-20250929")!;
  assert.equal(anthropic.rates.outputNanoMinorUnitsPerToken, "1500000");
  const deepseek = findModelPrice("deepseek", "deepseek-v4-flash")!;
  assert.equal(deepseek.rates.currency, "CNY");
  assert.equal(deepseek.rates.inputNanoMinorUnitsPerToken, "200000");
  assert.equal(deepseek.rates.outputNanoMinorUnitsPerToken, "800000");
  assert.equal(deepseek.estimateBasis, "peak_reference_price");
  for (const price of [openai, anthropic, deepseek]) {
    assert.equal(price.verifiedAt, price.providerId === "deepseek" ? "2026-10-09" : "2026-09-06");
    assert.match(price.sourceUrl, /^https:\/\//u);
    assert.equal(price.billingGuarantee, false);
  }
});

test("model discovery only selects models with an explicit price policy", () => {
  assert.equal(selectPricedModel("openai", ["unknown-first", "gpt-5"]), "gpt-5");
  assert.equal(selectPricedModel("anthropic", ["claude-sonnet-4-5-20250929"]), "claude-sonnet-4-5-20250929");
  assert.equal(selectPricedModel("deepseek", ["deepseek-v4-pro", "deepseek-v4-flash"]), "deepseek-v4-flash");
  assert.equal(selectPricedModel("openai", ["unknown-model"]), undefined);
  assert.equal(findModelPrice("deepseek", "deepseek-flash")?.rates.cachedInputNanoMinorUnitsPerToken, "4000");
  assert.equal(selectPricedModel("deepseek", ["deepseek-v4-flash", "deepseek-flash"]), "deepseek-flash");
  assert.equal(findModelPrice("deepseek", "deepseek-chat"), undefined);
  assert.equal(findModelPrice("openai", "gpt-5-unverified"), undefined);
  const copy = findModelPrice("openai", "gpt-5")!;
  (copy.rates as { currency: string }).currency = "CNY";
  assert.equal(findModelPrice("openai", "gpt-5")!.rates.currency, "USD");
});


test("Kimi and Qwen models retain verified China-region pricing and reject unverified aliases", () => {
  for (const [provider, model, input, cached, output] of [
    ["moonshot", "kimi-k2.6", "650000", "110000", "2700000"],
    ["qwen", "qwen-plus", "80000", "16000", "200000"],
    ["qwen", "qwen-flash", "15000", "3000", "150000"],
    ["qwen", "qwen3.5-plus", "80000", "80000", "480000"],
  ]) {
    const reference = findModelPrice(provider!, model!);
    assert.ok(reference, `${provider}:${model} requires an explicit price policy`);
    assert.equal(reference.verifiedAt, "2026-10-09");
    assert.equal(reference.rates.currency, "CNY");
    assert.equal(reference.rates.inputNanoMinorUnitsPerToken, input);
    assert.equal(reference.rates.cachedInputNanoMinorUnitsPerToken, cached);
    assert.equal(reference.rates.outputNanoMinorUnitsPerToken, output);
    assert.ok(reference.maxInputTokens <= 100_000);
  }
  assert.equal(selectPricedModel("moonshot", ["kimi-k3", "kimi-k2.6"]), "kimi-k2.6");
  assert.equal(selectPricedModel("qwen", ["qwen3.5-plus", "qwen-plus"]), "qwen-plus");
  assert.equal(findModelPrice("qwen", "qwen-plus-2025-12-01")?.rates.currency, "CNY");
  for (const model of ["kimi-k3", "kimi-k2.7-code", "kimi-k2.5", "kimi-for-coding"])
    assert.equal(findModelPrice("moonshot", model), undefined);
  assert.equal(findModelPrice("qwen", "qwen-plus-unverified"), undefined);
});
