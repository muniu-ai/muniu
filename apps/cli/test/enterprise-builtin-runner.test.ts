// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import type { AgentExecutionBindingV1, EnterpriseBuiltinExecutionViewV1 } from "@mn/core";
import { GovernedLoopInterruptionError } from "@mn/loop";
import type {
  DockerAgentSandbox,
  DockerSandboxCommandResult,
  DockerSandboxExecuteRequest
} from "@mn/worker";

import { runEnterpriseBuiltinAgentCandidate } from "../src/enterprise-builtin-runner.js";

test("enterprise builtin runner relays a Pod tool call and retries the exact result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-cli-builtin-"));
  const workspace = join(root, "candidate");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = new LocalSandbox(root);
  const binding = executionBinding();
  let resultAttempts = 0;
  const submitted: unknown[] = [];
  const initial = view({ state: "running", revision: 0, binding });
  const tool = view({
    state: "running",
    revision: 2,
    binding,
    toolCall: {
      schemaVersion: 1,
      callId: "call-1",
      executionId: "execution-1",
      sessionId: binding.sessionId,
      name: "write_file",
      risk: "side-effecting",
      args: { path: "result.txt", content: "written in sandbox\n" },
      workspacePath: "/workspace/scratch/candidate",
      createdAt: new Date().toISOString()
    }
  });
  const completed = view({
    state: "completed",
    revision: 4,
    binding,
    output: {
      reason: "completed",
      summary: "done",
      steps: 2,
      toolCalls: 1,
      providerId: "provider-1",
      modelId: "model-1",
      executionBinding: binding
    }
  });

  const output = await runEnterpriseBuiltinAgentCandidate({
    runId: "run-1",
    ownerId: "worker-1",
    claimToken: "claim-token-1",
    backend,
    leaseId: "lease-1",
    attestation: {} as never,
    sandboxExecution: {} as never,
    input: {
      sessionId: binding.sessionId,
      runId: binding.runId,
      candidateId: binding.candidateId,
      cwd: workspace,
      prompt: "write result",
      providerId: "default",
      modelId: "default",
      timeoutSeconds: 30,
      executionBinding: binding
    },
    transport: {
      async post(path, body) {
        if (path.endsWith("/builtin-executions")) return initial;
        if (path.endsWith("/poll")) return tool;
        if (path.endsWith("/tool-results")) {
          resultAttempts += 1;
          submitted.push(body);
          if (resultAttempts < 3) throw new Error("simulated response loss");
          return completed;
        }
        throw new Error(`unexpected transport path ${path}`);
      }
    }
  });

  assert.equal(output.reason, "completed");
  assert.equal(output.providerId, "provider-1");
  assert.equal(resultAttempts, 3);
  assert.deepEqual(submitted[0], submitted[1]);
  assert.deepEqual(submitted[1], submitted[2]);
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "written in sandbox\n");
});

test("enterprise builtin runner preserves an indeterminate generation for takeover", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mn-cli-builtin-interruption-"));
  const workspace = join(root, "candidate");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding = executionBinding();
  let cancelRequests = 0;

  await assert.rejects(
    runEnterpriseBuiltinAgentCandidate({
      runId: "run-1",
      ownerId: "worker-1",
      claimToken: "claim-token-1",
      backend: new LocalSandbox(root),
      leaseId: "lease-1",
      attestation: {} as never,
      sandboxExecution: {} as never,
      input: {
        sessionId: binding.sessionId,
        runId: binding.runId,
        candidateId: binding.candidateId,
        cwd: workspace,
        prompt: "write result",
        providerId: "default",
        modelId: "default",
        timeoutSeconds: 30,
        executionBinding: binding
      },
      transport: {
        async post(path) {
          if (path.endsWith("/builtin-executions")) {
            return view({ state: "running", revision: 0, binding });
          }
          if (path.endsWith("/poll")) throw new Error("owner lease expired");
          if (path.endsWith("/cancel")) {
            cancelRequests += 1;
            return view({ state: "cancelled", revision: 1, binding });
          }
          throw new Error(`unexpected transport path ${path}`);
        }
      }
    }),
    GovernedLoopInterruptionError
  );
  assert.equal(cancelRequests, 0);
});

function executionBinding(): AgentExecutionBindingV1 {
  return {
    schemaVersion: 1,
    runId: "run-1",
    candidateId: "builtin-1",
    sessionId: "session-1",
    runtimeId: "builtin",
    providerId: "provider-1",
    modelId: "model-1",
    harnessDigest: "1".repeat(64),
    governanceDigest: "2".repeat(64),
    effectPolicyDigest: "3".repeat(64),
    sandboxCapabilityId: "isolated-worktree"
  };
}

function view(input: {
  state: EnterpriseBuiltinExecutionViewV1["state"];
  revision: number;
  binding: AgentExecutionBindingV1;
  toolCall?: EnterpriseBuiltinExecutionViewV1["toolCall"];
  output?: EnterpriseBuiltinExecutionViewV1["output"];
}): EnterpriseBuiltinExecutionViewV1 {
  return {
    schemaVersion: 1,
    executionId: "execution-1",
    state: input.state,
    revision: input.revision,
    providerId: "provider-1",
    modelId: "model-1",
    executionBinding: input.binding,
    ...(input.toolCall ? { toolCall: input.toolCall } : {}),
    ...(input.output ? { output: input.output } : {})
  };
}

class LocalSandbox implements DockerAgentSandbox {
  constructor(private readonly root: string) {}

  workspaceRoot(): string {
    return this.root;
  }

  containerPath(_leaseId: string, hostPath: string): string {
    return `/workspace/scratch/${relative(this.root, hostPath).split("\\").join("/")}`;
  }

  execute(
    _leaseId: string,
    request: DockerSandboxExecuteRequest & { readonly stdin?: string }
  ): Promise<DockerSandboxCommandResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
      child.stdin.end(request.stdin ?? "");
    });
  }
}
