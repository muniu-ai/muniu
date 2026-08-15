import assert from "node:assert/strict";
import test from "node:test";
import { createRunContext, normalizeStrategy } from "@mn/core";
import { MockExecutor } from "../src/index.js";

test("mock executor returns a completed result", async () => {
  const executor = new MockExecutor("claude");
  const context = createRunContext({
    project: {
      id: "p1",
      name: "demo",
      rootPath: "/tmp/demo",
      defaultBranch: "main",
      policyId: "default",
      services: []
    },
    task: {
      id: "t1",
      projectId: "p1",
      title: "demo",
      intent: "implement",
      targetServices: [],
      prompt: "do work",
      acceptanceCriteria: ["done"],
      strategy: normalizeStrategy({}),
      createdAt: new Date(0).toISOString()
    }
  });

  const result = await executor.run({
    runId: "r1",
    candidateId: "c1",
    provider: "claude",
    cwd: process.cwd(),
    prompt: "do work",
    context,
    timeoutSeconds: 1
  });

  assert.equal(result.status, "completed");
});
