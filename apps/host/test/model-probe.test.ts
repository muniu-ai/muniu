// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_PRESETS } from "@mn/kernel";
import { createModelProbe } from "../src/model-probe.js";

test("BYOK discovery selects a supported model without requiring internal identifiers", async () => {
  const models = { openai: ["unpriced-first", "gpt-5"], anthropic: ["claude-sonnet-4-5-20250929"],
    deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"] };
  for (const preset of PROVIDER_PRESETS.filter(item => ["openai", "anthropic", "deepseek"].includes(item.id))) {
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


test("Kimi discovery uses the documented China endpoint and selects a priced model", async () => {
  const preset = PROVIDER_PRESETS.find(item => item.id === "moonshot");
  assert.ok(preset);
  const probe = createModelProbe({ async fetch(url, init) {
    assert.equal(String(url), "https://api.moonshot.cn/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture");
    return Response.json({ data: [{ id: "kimi-k3" }, { id: "kimi-k2.6" }] });
  } });
  assert.deepEqual(await probe({ preset, apiKey: "fixture" }), {
    models: ["kimi-k3", "kimi-k2.6"], defaultModel: "kimi-k2.6",
  });
});

test("Qwen discovery follows bounded native catalog pagination, never a paid completion probe", async () => {
  const preset = PROVIDER_PRESETS.find(item => item.id === "qwen");
  assert.ok(preset);
  let calls = 0;
  const probe = createModelProbe({ async fetch(url, init) {
    calls++;
    const endpoint = new URL(String(url));
    assert.equal(endpoint.origin + endpoint.pathname, "https://dashscope.aliyuncs.com/api/v1/models");
    assert.equal(endpoint.searchParams.get("page_no"), String(calls));
    assert.equal(endpoint.searchParams.get("name"), "qwen");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture");
    return Response.json({ success: true, output: { total: 2, page_no: calls,
      models: [{ model: calls === 1 ? "qwen-unknown" : "qwen-plus" }] } });
  } });
  assert.deepEqual(await probe({ preset, apiKey: "fixture" }), {
    models: ["qwen-unknown", "qwen-plus"], defaultModel: "qwen-plus",
  });
  assert.equal(calls, 2);
});

test("Qwen malformed catalog and repeated pages fail closed without provider details", async () => {
  const preset = PROVIDER_PRESETS.find(item => item.id === "qwen");
  assert.ok(preset);
  for (const body of [
    { success: false, message: "SECRET" },
    { success: true, output: { total: 20_000, page_no: 1, models: [{ model: "qwen-plus" }] } },
    { success: true, output: { total: 2, page_no: 1, models: [{ model: "qwen-plus" }] } },
    { success: true, output: { total: 1, page_no: 1, models: [] } },
  ]) {
    const probe = createModelProbe({ fetch: async () => Response.json(body) });
    await assert.rejects(probe({ preset, apiKey: "SECRET" }), error => {
      assert.doesNotMatch(String(error), /SECRET/u);
      return true;
    });
  }
});
