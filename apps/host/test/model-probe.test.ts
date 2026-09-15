// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_PRESETS } from "@mn/kernel";
import { createModelProbe } from "../src/model-probe.js";

test("BYOK discovery selects a supported model without requiring internal identifiers", async () => {
  const models = { openai: ["unpriced-first", "gpt-5"], anthropic: ["claude-sonnet-4-5-20250929"],
    deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"] };
  for (const preset of PROVIDER_PRESETS) {
    const probe = createModelProbe({ async fetch(url, init) {
      assert.match(String(url), /\/models$/u);
      assert.equal(init?.redirect, "error");
      return Response.json({ data: models[preset.id as keyof typeof models].map(id => ({ id })) });
    } });
    const result = await probe({ preset, apiKey: "fixture" });
    assert.equal(result.defaultModel, preset.id === "deepseek" ? "deepseek-v4-flash"
      : preset.id === "openai" ? "gpt-5" : "claude-sonnet-4-5-20250929");
  }
});

test("unknown, malformed and oversized model lists fail closed with redacted errors", async () => {
  const preset = PROVIDER_PRESETS[0]!;
  for (const body of [{ data: [{ id: "unknown" }] }, { data: "SECRET" }, { data: [null] }, { data: [] }]) {
    const probe = createModelProbe({ fetch: async () => Response.json(body) });
    await assert.rejects(probe({ preset, apiKey: "SECRET" }), error => {
      assert.doesNotMatch(String(error), /SECRET/u);
      return true;
    });
  }
  const probe = createModelProbe({ fetch: async () => new Response("SECRET", { headers: { "content-length": "2000000" } }) });
  await assert.rejects(probe({ preset, apiKey: "SECRET" }));
});
