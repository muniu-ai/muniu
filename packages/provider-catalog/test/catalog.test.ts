import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderInputFromPreset,
  managedApps,
  maskSecret,
  normalizeProviderApp,
  providerConsumers,
  providerSupportsApp
} from "../src/index.js";
import type { ManagedAgentApp, ProviderConsumerId } from "../src/index.js";

test("managed apps stay scoped to legacy executors while provider consumers add agent", () => {
  const managed: readonly ManagedAgentApp[] = managedApps;
  const consumers: readonly ProviderConsumerId[] = providerConsumers;

  assert.deepEqual(managed, ["claude", "codex"]);
  assert.deepEqual(consumers, ["claude", "codex", "agent"]);

  const claude = createProviderInputFromPreset("claude-official");
  const codex = createProviderInputFromPreset("openai-official");

  assert.equal(providerSupportsApp(claude, "claude"), true);
  assert.equal(providerSupportsApp(claude, "codex"), false);
  assert.equal(providerSupportsApp(codex, "codex"), true);
});

test("agent provider scope is isolated from managed apps and unified supports all consumers", () => {
  const agent = createProviderInputFromPreset("deepseek-official");
  const unified = createProviderInputFromPreset("openrouter");

  assert.equal(normalizeProviderApp("agent"), "agent");
  assert.equal(providerSupportsApp(agent, "agent"), true);
  assert.equal(providerSupportsApp(agent, "codex"), false);
  assert.equal(providerSupportsApp(unified, "agent"), true);
});

test("DeepSeek official preset targets the embedded agent with the v4 model catalog", () => {
  const provider = createProviderInputFromPreset("deepseek-official");

  assert.equal(provider.app, "agent");
  assert.equal(provider.baseUrl, "https://api.deepseek.com");
  assert.equal(provider.defaultModel, "deepseek-v4-flash");
  assert.deepEqual(provider.modelCatalog, [
    { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }
  ]);
});

test("preset overrides produce a create input without mutating catalog", () => {
  const provider = createProviderInputFromPreset("deepseek", {
    name: "DeepSeek test",
    baseUrl: "https://relay.example/v1"
  });

  assert.equal(provider.name, "DeepSeek test");
  assert.equal(provider.baseUrl, "https://relay.example/v1");
  assert.equal(provider.defaultModel, "deepseek-chat");
  assert.equal(provider.app, "codex");
});

test("secret mask never returns full secret", () => {
  assert.equal(maskSecret("sk-1234567890"), "sk-1...7890");
  assert.equal(maskSecret("short"), "****");
});
