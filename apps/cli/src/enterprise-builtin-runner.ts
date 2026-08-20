// SPDX-License-Identifier: Apache-2.0

import type {
  EnterpriseBuiltinExecutionOutputV1,
  EnterpriseBuiltinExecutionViewV1,
  EnterpriseBuiltinToolResultV1
} from "@mn/core";
import type { BuiltinAgentExecutionInput, BuiltinAgentExecutionOutput } from "@mn/executors";
import type { SandboxExecutionEvidence, SandboxLeaseAttestation } from "@mn/harness";
import { GovernedLoopInterruptionError } from "@mn/loop";
import {
  executeEnterpriseBuiltinWorkspaceTool,
  type DockerAgentSandbox
} from "@mn/worker";

export interface EnterpriseBuiltinAgentTransport {
  post(path: string, body: unknown): Promise<unknown>;
}

export interface EnterpriseBuiltinCandidateOptions {
  readonly runId: string;
  readonly ownerId: string;
  readonly claimToken: string;
  readonly backend: DockerAgentSandbox;
  readonly leaseId: string;
  readonly attestation: SandboxLeaseAttestation;
  readonly sandboxExecution: SandboxExecutionEvidence;
  readonly input: BuiltinAgentExecutionInput;
  readonly transport: EnterpriseBuiltinAgentTransport;
}

export async function runEnterpriseBuiltinAgentCandidate(
  options: EnterpriseBuiltinCandidateOptions
): Promise<BuiltinAgentExecutionOutput> {
  const runId = encodeURIComponent(options.runId);
  const claim = { ownerId: options.ownerId, claimToken: options.claimToken };
  const workspacePath = options.backend.containerPath(options.leaseId, options.input.cwd);
  const path = `/v1/run-jobs/queue/${runId}/builtin-executions`;
  let view = requireEnterpriseBuiltinView(await options.transport.post(path, {
    ...claim,
    execution: {
      schemaVersion: 1,
      sessionId: options.input.sessionId,
      runId: options.input.runId,
      candidateId: options.input.candidateId,
      workspacePath,
      prompt: options.input.prompt,
      providerId: options.input.providerId,
      modelId: options.input.modelId,
      timeoutSeconds: options.input.timeoutSeconds,
      executionBinding: options.input.executionBinding,
      sandboxAttestation: options.attestation,
      sandboxExecution: options.sandboxExecution
    }
  }));
  const executionId = encodeURIComponent(view.executionId);
  const results = new Map<string, EnterpriseBuiltinToolResultV1>();
  try {
    while (true) {
      if (options.input.signal?.aborted) {
        await options.transport.post(`${path}/${executionId}/cancel`, claim).catch(() => undefined);
        return {
          reason: "cancelled",
          summary: "Enterprise builtin Agent execution was cancelled.",
          steps: 0,
          toolCalls: results.size,
          providerId: view.providerId,
          modelId: view.modelId,
          executionBinding: view.executionBinding
        };
      }
      if (view.state !== "running") return outputFromEnterpriseBuiltinView(view);
      if (view.toolCall) {
        let result = results.get(view.toolCall.callId);
        if (!result) {
          result = await executeEnterpriseBuiltinWorkspaceTool({
            backend: options.backend,
            leaseId: options.leaseId,
            hostWorkspacePath: options.input.cwd,
            executionId: view.executionId,
            sessionId: options.input.sessionId,
            call: view.toolCall,
            timeoutSeconds: options.input.timeoutSeconds,
            ...(options.input.signal ? { signal: options.input.signal } : {})
          });
          results.set(result.callId, result);
        }
        view = await submitToolResult(
          options.transport,
          `${path}/${executionId}/tool-results`,
          claim,
          result,
          options.input.signal
        );
        continue;
      }
      view = requireEnterpriseBuiltinView(await options.transport.post(
        `${path}/${executionId}/poll`,
        { ...claim, afterRevision: view.revision, waitMs: 10_000 }
      ));
    }
  } catch (error) {
    // A non-user transport/authority loss has an indeterminate outcome. Do
    // not cancel the durable execution: its owner lease and generation are
    // the takeover authority. Bubble a Loop interruption so the worker
    // releases its queue claim without terminalizing the running checkpoint.
    if (options.input.signal?.aborted) {
      await options.transport.post(`${path}/${executionId}/cancel`, claim).catch(() => undefined);
      throw error;
    }
    throw new GovernedLoopInterruptionError(
      "Enterprise builtin Agent authority was interrupted before a durable outcome",
      { cause: error }
    );
  }
}

async function submitToolResult(
  transport: EnterpriseBuiltinAgentTransport,
  path: string,
  claim: { readonly ownerId: string; readonly claimToken: string },
  result: EnterpriseBuiltinToolResultV1,
  signal?: AbortSignal
): Promise<EnterpriseBuiltinExecutionViewV1> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (signal?.aborted) throw new Error("enterprise builtin tool result submission was cancelled");
    try {
      return requireEnterpriseBuiltinView(await transport.post(path, { ...claim, result }));
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(100 * (attempt + 1), signal);
    }
  }
  throw new Error("enterprise builtin tool result could not be committed", { cause: lastError });
}

function outputFromEnterpriseBuiltinView(
  view: EnterpriseBuiltinExecutionViewV1
): EnterpriseBuiltinExecutionOutputV1 {
  if (view.output) return view.output;
  return {
    reason: view.state === "cancelled" ? "cancelled" : "error",
    summary: view.error ?? "Enterprise builtin Agent execution failed.",
    steps: 0,
    toolCalls: 0,
    providerId: view.providerId,
    modelId: view.modelId,
    executionBinding: view.executionBinding
  };
}

function requireEnterpriseBuiltinView(value: unknown): EnterpriseBuiltinExecutionViewV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("enterprise builtin Agent authority returned no execution view");
  }
  const view = value as EnterpriseBuiltinExecutionViewV1;
  if (
    view.schemaVersion !== 1 ||
    typeof view.executionId !== "string" ||
    !/^(?:running|completed|failed|cancelled)$/u.test(view.state) ||
    !Number.isSafeInteger(view.revision) ||
    view.revision < 0 ||
    typeof view.providerId !== "string" ||
    typeof view.modelId !== "string" ||
    !view.executionBinding ||
    view.executionBinding.schemaVersion !== 1 ||
    view.executionBinding.runtimeId !== "builtin"
  ) {
    throw new Error("enterprise builtin Agent authority returned an invalid execution view");
  }
  return view;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("operation cancelled"));
      return;
    }
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolvePromise();
    };
    const abort = (): void => finish(new Error("operation cancelled"));
    const timer = setTimeout(() => finish(), milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
