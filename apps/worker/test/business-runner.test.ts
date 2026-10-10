// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { businessRunnerArguments, extractBusinessRunnerText } from "../src/business-runner.js";

test("经营 CLI 禁用工具、个性化配置和会话持久化，不接触仓库", () => {
  const codex = businessRunnerArguments("codex-cli");
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "read-only", "features.shell_tool=false", 'web_search="disabled"']) assert.ok(codex.includes(flag));
  const claude = businessRunnerArguments("claude-cli");
  assert.equal(claude[claude.indexOf("--tools") + 1], "");
  assert.ok(claude.includes("--strict-mcp-config"));
  assert.ok(claude.includes("--no-session-persistence"));
  assert.ok(!claude.includes("--dangerously-skip-permissions"));
});

test("只接收 CLI 的最终答复，不把诊断、工具输出或中间消息当成果", () => {
  assert.equal(extractBusinessRunnerText("codex-cli", { type: "item.completed", item: { type: "agent_message", text: "经营建议" } }), "经营建议");
  assert.equal(extractBusinessRunnerText("claude-cli", { type: "result", subtype: "success", result: "经营建议" }), "经营建议");
  assert.equal(extractBusinessRunnerText("claude-cli", { type: "result", is_error: true, result: "错误" }), undefined);
  assert.equal(extractBusinessRunnerText("codex-cli", { type: "item.completed", item: { type: "command_execution", aggregated_output: "不得采信" } }), undefined);
});
