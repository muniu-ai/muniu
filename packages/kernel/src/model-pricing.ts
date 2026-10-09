// SPDX-License-Identifier: Apache-2.0
import type { ModelRateCard } from "@mn/contracts";

export interface ModelPriceReference {
  readonly providerId: string;
  readonly modelIds: readonly string[];
  readonly verifiedAt: string;
  readonly sourceUrl: string;
  readonly estimateBasis: "reference_price" | "peak_reference_price";
  readonly billingGuarantee: false;
  readonly maxInputTokens: number;
  readonly rates: ModelRateCard;
}

const REFERENCES: readonly ModelPriceReference[] = [
  { providerId: "openai", modelIds: ["gpt-5", "gpt-5-2025-08-07"], verifiedAt: "2026-09-06",
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5", estimateBasis: "reference_price",
    billingGuarantee: false, maxInputTokens: 100_000,
    rates: { id: "openai:gpt-5:2026-09-06", currency: "USD", inputNanoMinorUnitsPerToken: "125000",
      cachedInputNanoMinorUnitsPerToken: "12500", outputNanoMinorUnitsPerToken: "1000000" } },
  { providerId: "anthropic", modelIds: ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"], verifiedAt: "2026-09-06",
    sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing", estimateBasis: "reference_price",
    billingGuarantee: false, maxInputTokens: 100_000,
    rates: { id: "anthropic:claude-sonnet-4-5:2026-09-06", currency: "USD", inputNanoMinorUnitsPerToken: "300000",
      cachedInputNanoMinorUnitsPerToken: "30000", outputNanoMinorUnitsPerToken: "1500000" } },
  ...[
    { model: "deepseek-flash", input: "200000", cached: "4000", output: "800000" },
    { model: "deepseek-v4-pro", input: "900000", cached: "30000", output: "2700000" },
  ].map(({ model, input, cached, output }): ModelPriceReference => ({
    providerId: "deepseek", modelIds: model === "deepseek-flash" ? [model, "deepseek-v4-flash"] : [model], verifiedAt: "2026-10-09",
    sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/", estimateBasis: "peak_reference_price",
    billingGuarantee: false, maxInputTokens: 100_000,
    rates: { id: `deepseek:${model}:peak:2026-10-09`, currency: "CNY", inputNanoMinorUnitsPerToken: input,
      cachedInputNanoMinorUnitsPerToken: cached, outputNanoMinorUnitsPerToken: output },
  })),
  { providerId: "moonshot", modelIds: ["kimi-k2.6"], verifiedAt: "2026-10-09",
    sourceUrl: "https://platform.kimi.com/", estimateBasis: "reference_price",
    billingGuarantee: false, maxInputTokens: 100_000,
    rates: { id: "moonshot:kimi-k2.6:cn:2026-10-09", currency: "CNY", inputNanoMinorUnitsPerToken: "650000",
      cachedInputNanoMinorUnitsPerToken: "110000", outputNanoMinorUnitsPerToken: "2700000" } },
  ...[
    { models: ["qwen-plus", "qwen-plus-2025-12-01"], page: "qwen-plus", input: "80000", cached: "16000", output: "200000" },
    { models: ["qwen-flash"], page: "qwen-flash", input: "15000", cached: "3000", output: "150000" },
    // No implicit-cache discount is assumed for this model family. Explicit cache writes are disabled.
    { models: ["qwen3.5-plus", "qwen3.5-plus-2026-02-15", "qwen3.5-plus-2026-04-20"],
      page: "qwen3-5-plus", input: "80000", cached: "80000", output: "480000" },
  ].map(({ models, page, input, cached, output }): ModelPriceReference => ({
    providerId: "qwen", modelIds: models, verifiedAt: "2026-10-09",
    sourceUrl: `https://help.aliyun.com/zh/model-studio/${page}`, estimateBasis: "reference_price",
    billingGuarantee: false, maxInputTokens: 100_000,
    rates: { id: `qwen:${models[0]}:beijing:non-thinking:2026-10-09`, currency: "CNY",
      inputNanoMinorUnitsPerToken: input, cachedInputNanoMinorUnitsPerToken: cached, outputNanoMinorUnitsPerToken: output },
  })),
];

export function findModelPrice(providerId: string, modelId: string): ModelPriceReference | undefined {
  const reference = REFERENCES.find(item => item.providerId === providerId && item.modelIds.includes(modelId));
  return reference ? structuredClone(reference) : undefined;
}

export function selectPricedModel(providerId: string, available: readonly string[]): string | undefined {
  for (const reference of REFERENCES) {
    if (reference.providerId !== providerId) continue;
    for (const model of reference.modelIds) if (available.includes(model)) return model;
  }
  return undefined;
}
