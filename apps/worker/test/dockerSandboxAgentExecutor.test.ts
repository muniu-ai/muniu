import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunInput } from "@mn/core";
import {
  DockerSandboxAgentExecutor,
  type DockerAgentSandbox,
  type DockerSandboxExecuteRequest
} from "../src/index.js";

test("Docker candidate receives receipt proxy URLs but never arbitrary secret env", async () => {
  let captured: (DockerSandboxExecuteRequest & { stdin?: string }) | undefined;
  const backend: DockerAgentSandbox = {
    workspaceRoot: () => "/scratch",
    containerPath: (_leaseId, path) => path,
    execute: async (_leaseId, request) => {
      captured = request;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    }
  };
  const executor = new DockerSandboxAgentExecutor({
    provider: "codex",
    backend,
    leaseId: "lease-a",
    mock: true
  });
  await executor.run({
    runId: "run-a",
    candidateId: "codex-1",
    provider: "codex",
    cwd: "/scratch/codex-1",
    prompt: "test",
    context: {} as AgentRunInput["context"],
    timeoutSeconds: 30,
    env: {
      MN_RUN_ID: "run-a",
      MN_CANDIDATE_ID: "codex-1",
      MN_PROXY_BASE_URL: "http://proxy",
      MN_ASSOCIATED_PROXY_BASE_URL:
        "http://proxy/mn/usage-receipts/signed.receipt",
      OPENAI_BASE_URL:
        "http://proxy/mn/usage-receipts/signed.receipt/v1",
      OPENAI_API_BASE:
        "http://proxy/mn/usage-receipts/signed.receipt/v1",
      CODEX_BASE_URL:
        "http://proxy/mn/usage-receipts/signed.receipt/v1",
      MN_CODEX_BASE_URL:
        "http://proxy/mn/usage-receipts/signed.receipt/v1",
      OPENAI_API_KEY: "must-not-cross",
      AWS_SECRET_ACCESS_KEY: "must-not-cross"
    }
  });
  assert.equal(
    captured?.env?.OPENAI_BASE_URL,
    "http://proxy/mn/usage-receipts/signed.receipt/v1"
  );
  assert.equal(
    captured?.env?.MN_ASSOCIATED_PROXY_BASE_URL,
    "http://proxy/mn/usage-receipts/signed.receipt"
  );
  assert.equal(captured?.env?.OPENAI_API_KEY, undefined);
  assert.equal(captured?.env?.AWS_SECRET_ACCESS_KEY, undefined);
});
