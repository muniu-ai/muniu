import type { JsonObject } from "@mn/contracts";
import type { PluginDefinitionV1 } from "@mn/plugin-sdk";

async function accept(input: JsonObject): Promise<JsonObject> {
  return { accepted: true, input };
}

export const claudeCliPluginDefinition = {
  id: "runner-claude-cli",
  version: "0.2.0",
  official: true,
  trustBoundary: "process_equivalent",
  contributions: {
    routes: [],
    navigation: [],
    widgets: [],
    commands: [{ id: "runner.claude.enable", title: "启用 Claude CLI Runner", run: accept }],
    agents: [],
    skills: [{
      id: "runner.claude.connect",
      title: "连接 Claude CLI",
      expectedOutcome: "记录并确认 Claude CLI 的真实路径、版本和二进制摘要",
      source: "Muniu",
      license: "Apache-2.0",
      version: "0.2.0",
      permissionIds: ["runner.claude.execute"],
    }],
    workflows: [],
    tools: [{ id: "runner.claude.execute", version: "0.2.0", effectClass: "local_reversible_write" }],
    memorySchemas: [],
  },
  healthCheck() { return { status: "healthy" as const }; },
} satisfies PluginDefinitionV1;

export const runnerClaudeCliPlugin = Object.freeze({
  id: "runner-claude-cli",
  version: "0.2.0",
  defaultEnabled: false,
  explicitSelectionRequired: true,
  capabilities: Object.freeze(["start", "events", "cancel", "resume"] as const),
  definition: claudeCliPluginDefinition,
});
