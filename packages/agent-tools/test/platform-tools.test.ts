// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry, createPlatformBridgeTools, createPlatformTools } from "../src/index.js";

test("platform bridge tools expose the complete capability set through centralized authorization", async () => {
  const calls: string[] = [];
  const call = (name: string) => async () => {
    calls.push(name);
    return { operation: name };
  };
  const tools = createPlatformBridgeTools({
    attachments: { store: call("attachment.store") },
    images: { view: call("image.view"), generate: call("image.generate") },
    plan: { update: call("plan.update") },
    goal: { update: call("goal.update") },
    skills: { list: call("skills.list"), invoke: call("skills.invoke") },
    mcp: {
      listServers: call("mcp.listServers"),
      readResource: call("mcp.readResource"),
      callTool: call("mcp.callTool")
    },
    web: { search: call("web.search"), open: call("web.open") },
    symbols: { search: call("symbols.search") },
    subagents: {
      spawn: call("subagents.spawn"),
      send: call("subagents.send"),
      wait: call("subagents.wait"),
      interrupt: call("subagents.interrupt"),
      close: call("subagents.close"),
      resume: call("subagents.resume")
    }
  });
  assert.deepEqual(tools.map((tool) => tool.name), [
    "attachment_store",
    "image_view",
    "image_generate",
    "plan_update",
    "goal_update",
    "skills_list",
    "skill_invoke",
    "mcp_server_list",
    "mcp_resource_read",
    "mcp_tool_call",
    "web_search",
    "web_open",
    "symbol_search",
    "subagent_spawn",
    "subagent_send",
    "subagent_wait",
    "subagent_interrupt",
    "subagent_close",
    "subagent_resume"
  ]);

  let authorizations = 0;
  const registry = new ToolRegistry({
    async authorize() {
      authorizations += 1;
      return { decision: "approve" };
    }
  });
  for (const tool of tools) registry.register(tool);
  registry.seal();
  await registry.execute({
    name: "web_search",
    arguments: JSON.stringify({ query: "Muniu" }),
    context: { sessionId: "platform-session", cwd: "/workspace" }
  });
  assert.equal(authorizations, 1);
  assert.deepEqual(calls, ["web.search"]);
});

test("platform bridge factory omits unavailable optional capabilities", () => {
  assert.deepEqual(createPlatformBridgeTools({}).map((tool) => tool.name), []);
  assert.deepEqual(createPlatformTools().map((tool) => tool.name), [
    "read_file", "list_files", "search_text", "write_file", "apply_patch", "run_command"
  ]);
});
