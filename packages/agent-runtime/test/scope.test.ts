// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentScope,
  ScopeDisposedError,
  type LlmContribution,
  type PromptContribution,
} from "../src/index.js";

function llm(id: string, label: string): LlmContribution {
  return {
    id,
    async complete() {
      return { text: label, toolCalls: [] };
    },
  };
}

test("作用域按 tenant/workspace/thread/execution/subagent 隔离并继承贡献", async () => {
  const tenant = AgentScope.tenant("tenant-a");
  const workspace = tenant.createChild("workspace", "workspace-a");
  const otherWorkspace = tenant.createChild("workspace", "workspace-b");
  const thread = workspace.createChild("thread", "thread-a");
  const execution = thread.createChild("execution", "execution-a");
  const subagent = execution.createChild("subagent", "subagent-a");

  tenant.register("llm", llm("default", "tenant"));
  workspace.register("llm", llm("default", "workspace"));
  const prompt: PromptContribution = { id: "policy", render: () => "workspace policy" };
  workspace.register("prompt", prompt);
  workspace.register("tool", {
    id: "web.read",
    version: "1.0.0",
    effectClass: "external_read",
    prepare: (normalizedArguments) => ({ normalizedArguments, resourceRefs: [] }),
    execute: async () => null,
  });
  workspace.register("skill", { id: "research", description: "研究", instructions: "查证来源" });
  workspace.register("job", { id: "refresh", run: async () => null });
  workspace.register("subagent", { id: "reviewer", spawn: async () => ({ kind: "reviewer" }) });

  assert.equal(execution.resolveTurn().get("llm", "default"), workspace.resolveTurn().get("llm", "default"));
  assert.equal(subagent.resolveTurn().get("prompt", "policy"), prompt);
  assert.deepEqual(
    ["prompt", "llm", "tool", "skill", "job", "subagent"].map((kind) =>
      subagent.resolveTurn().list(kind as "prompt").length),
    [1, 1, 1, 1, 1, 1],
  );
  assert.equal(otherWorkspace.resolveTurn().get("prompt", "policy"), undefined);
  assert.deepEqual(subagent.identity, {
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    threadId: "thread-a",
    executionId: "execution-a",
    subagentPath: ["subagent-a"],
  });

  assert.throws(() => tenant.createChild("thread", "invalid"), /workspace/u);
  await tenant.dispose();
});

test("turn 固定贡献与 generation，HMR 只影响下一 turn", async () => {
  const tenant = AgentScope.tenant("tenant-a");
  const workspace = tenant.createChild("workspace", "workspace-a");
  const thread = workspace.createChild("thread", "thread-a");
  const execution = thread.createChild("execution", "execution-a");
  const first = llm("default", "first");
  const second = llm("default", "second");

  workspace.register("llm", first);
  const turnOne = execution.resolveTurn();
  workspace.register("llm", second);

  assert.equal(turnOne.get("llm", "default"), first);
  assert.equal(execution.resolveTurn().get("llm", "default"), second);
  assert.ok(execution.resolveTurn().generation > turnOne.generation);
  assert.throws(() => (turnOne.byKind.llm as Map<string, LlmContribution>).clear(), /只读/u);

  await tenant.dispose();
});

test("dispose 递归清理子 Scope 和贡献资源", async () => {
  const disposed: string[] = [];
  const tenant = AgentScope.tenant("tenant-a");
  const workspace = tenant.createChild("workspace", "workspace-a");
  const thread = workspace.createChild("thread", "thread-a");
  tenant.onDispose(() => { disposed.push("tenant"); });
  workspace.onDispose(() => { disposed.push("workspace"); });
  thread.register("prompt", {
    id: "owned",
    render: () => "owned",
    dispose: () => { disposed.push("contribution"); },
  });

  await tenant.dispose();

  assert.deepEqual(disposed, ["contribution", "workspace", "tenant"]);
  assert.throws(() => thread.resolveTurn(), ScopeDisposedError);
  assert.equal(tenant.disposed, true);
  assert.equal(workspace.disposed, true);
  assert.equal(thread.disposed, true);
});
