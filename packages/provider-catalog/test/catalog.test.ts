import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderInputFromPreset,
  maskSecret,
  providerSupportsApp
} from "../src/index.js";

test("provider presets stay scoped to Claude Code and Codex", () => {
  const claude = createProviderInputFromPreset("claude-official");
  const codex = createProviderInputFromPreset("openai-official");

  assert.equal(providerSupportsApp(claude, "claude"), true);
  assert.equal(providerSupportsApp(claude, "codex"), false);
  assert.equal(providerSupportsApp(codex, "codex"), true);
});

test("preset overrides produce a create input without mutating catalog", () => {
  const provider = createProviderInputFromPreset("deepseek", {
    name: "DeepSeek test",
    baseUrl: "https://relay.example/v1"
  });

  assert.equal(provider.name, "DeepSeek test");
  assert.equal(provider.baseUrl, "https://relay.example/v1");
  assert.equal(provider.defaultModel, "deepseek-chat");
});

test("secret mask never returns full secret", () => {
  assert.equal(maskSecret("sk-1234567890"), "sk-1...7890");
  assert.equal(maskSecret("short"), "****");
});
