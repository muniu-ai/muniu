// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunInput } from "@mn/core";
import { BuiltinAgentExecutor } from "../src/index.js";

test("builtin executor delegates to the embedded Agent runner with durable binding", async () => {
  let captured: unknown;
  const executor = new BuiltinAgentExecutor({
    async run(input) {
      captured = input;
      return { reason: "completed", summary: "implemented", steps: 2, toolCalls: 1 };
    }
  });
  const input = {
    runId: "run-1",
    candidateId: "builtin-1",
    provider: "builtin",
    runtimeId: "builtin",
    providerId: "provider-1",
    modelId: "model-1",
    model: "model-1",
    sessionId: "session-1",
    executionBinding: {
      schemaVersion: 1,
      runId: "run-1",
      candidateId: "builtin-1",
      sessionId: "session-1",
      runtimeId: "builtin",
      providerId: "provider-1",
      modelId: "model-1",
      harnessDigest: "a".repeat(64),
      governanceDigest: "b".repeat(64),
      effectPolicyDigest: "c".repeat(64),
      sandboxCapabilityId: "isolated-worktree"
    },
    cwd: "/workspace",
    prompt: "implement",
    context: {
      project: { id: "p", name: "p", rootPath: "/workspace", defaultBranch: "main", services: [], policyId: "default" },
      task: {} as never,
      selectedServices: [],
      previousFailures: []
    },
    timeoutSeconds: 60
  } satisfies AgentRunInput;

  const result = await executor.run(input);
  assert.deepEqual(captured, {
    sessionId: "session-1",
    runId: "run-1",
    candidateId: "builtin-1",
    cwd: "/workspace",
    prompt: "implement",
    providerId: "provider-1",
    modelId: "model-1",
    timeoutSeconds: 60,
    executionBinding: input.executionBinding
  });
  assert.equal(result.status, "completed");
  assert.equal(result.provider, "builtin");
  assert.equal(result.sessionId, "session-1");
});
