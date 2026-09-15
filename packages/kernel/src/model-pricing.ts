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
    { model: "deepseek-v4-flash", input: "300000", cached: "10000", output: "900000" },
    { model: "deepseek-v4-pro", input: "900000", cached: "30000", output: "2700000" },
  ].map(({ model, input, cached, output }): ModelPriceReference => ({
    providerId: "deepseek", modelIds: [model], verifiedAt: "2026-09-06",
    sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/", estimateBasis: "peak_reference_price",
    billingGuarantee: false, maxInputTokens: 100_000,
    rates: { id: `deepseek:${model}:peak:2026-09-06`, currency: "CNY", inputNanoMinorUnitsPerToken: input,
      cachedInputNanoMinorUnitsPerToken: cached, outputNanoMinorUnitsPerToken: output },
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
