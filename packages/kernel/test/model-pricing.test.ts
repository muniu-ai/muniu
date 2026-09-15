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
  assert.equal(deepseek.rates.inputNanoMinorUnitsPerToken, "300000");
  assert.equal(deepseek.rates.outputNanoMinorUnitsPerToken, "900000");
  assert.equal(deepseek.estimateBasis, "peak_reference_price");
  for (const price of [openai, anthropic, deepseek]) {
    assert.equal(price.verifiedAt, "2026-09-06");
    assert.match(price.sourceUrl, /^https:\/\//u);
    assert.equal(price.billingGuarantee, false);
  }
});

test("model discovery only selects models with an explicit price policy", () => {
  assert.equal(selectPricedModel("openai", ["unknown-first", "gpt-5"]), "gpt-5");
  assert.equal(selectPricedModel("anthropic", ["claude-sonnet-4-5-20250929"]), "claude-sonnet-4-5-20250929");
  assert.equal(selectPricedModel("deepseek", ["deepseek-v4-pro", "deepseek-v4-flash"]), "deepseek-v4-flash");
  assert.equal(selectPricedModel("openai", ["unknown-model"]), undefined);
  assert.equal(findModelPrice("deepseek", "deepseek-chat"), undefined);
  assert.equal(findModelPrice("openai", "gpt-5-unverified"), undefined);
  const copy = findModelPrice("openai", "gpt-5")!;
  (copy.rates as { currency: string }).currency = "CNY";
  assert.equal(findModelPrice("openai", "gpt-5")!.rates.currency, "USD");
});
