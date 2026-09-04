import type { JsonObject } from "@mn/contracts";
import type { PluginDefinitionV1 } from "@mn/plugin-sdk";

async function accept(input: JsonObject): Promise<JsonObject> {
  return { accepted: true, input };
}

export const codexCliPluginDefinition = {
  id: "runner-codex-cli",
  version: "0.2.0",
  official: true,
  trustBoundary: "process_equivalent",
  contributions: {
    routes: [],
    navigation: [],
    widgets: [],
    commands: [{ id: "runner.codex.enable", title: "启用 Codex CLI Runner", run: accept }],
    agents: [],
    skills: [{
      id: "runner.codex.connect",
      title: "连接 Codex CLI",
      expectedOutcome: "记录并确认 Codex CLI 的真实路径、版本和二进制摘要",
      source: "Muniu",
      license: "Apache-2.0",
      version: "0.2.0",
      permissionIds: ["runner.codex.execute"],
    }],
    workflows: [],
    tools: [{ id: "runner.codex.execute", version: "0.2.0", effectClass: "external_side_effect" }],
    memorySchemas: [],
  },
  healthCheck() { return { status: "healthy" as const }; },
} satisfies PluginDefinitionV1;

export const runnerCodexCliPlugin = Object.freeze({
  id: "runner-codex-cli",
  version: "0.2.0",
  defaultEnabled: false,
  explicitSelectionRequired: true,
  capabilities: Object.freeze(["start", "events", "cancel", "resume"] as const),
  definition: codexCliPluginDefinition,
});
