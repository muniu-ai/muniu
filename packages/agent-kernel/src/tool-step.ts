/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/agent-loop/src/tool-calls.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: reduced tool-call processing to sequential, durable-before-effect
 * execution through the closed Muniu session and tool runtime contracts.
 */

import {
  MessageId,
  createSafeRandomPublicControlIdV1,
  createProtectedTextV1,
  createToolResultMessage,
  deriveToolEffectKindV1,
  isRuntimeEffectCommitmentBinderV1,
  type AgentApprovalResolutionV1,
  type AgentToolApprovalBindingV1,
  type EffectCommitmentHandleV1,
  type RuntimeEffectCommitmentBinderV1,
  type ToolCallBlock
} from "@mn/agent-protocol";
import type { AgentEventMetadata, AgentSession } from "@mn/agent-session";
import {
  ToolExecutionError,
  type PreparedToolInvocation,
  type ToolAuthorizationOutcome,
  type ToolRegistry
} from "@mn/agent-tools";

export interface ToolStepOptions {
  readonly session: AgentSession;
  readonly tools: ToolRegistry;
  readonly turn: number;
  readonly step: number;
  readonly call: ToolCallBlock;
  readonly signal?: AbortSignal;
  readonly budgetAvailable: boolean;
  readonly metadata?: AgentEventMetadata;
  readonly commitmentBinder?: RuntimeEffectCommitmentBinderV1;
}

export interface ToolStepResult {
  readonly invoked: boolean;
  readonly budgetExceeded: boolean;
  readonly effectRejected: boolean;
  readonly outcomeUnknown: boolean;
}

export class ToolOutcomePersistenceError extends Error {
  readonly code = "TOOL_OUTCOME_PERSISTENCE_FAILED";

  constructor(primary: unknown, fallback: unknown) {
    super("TOOL_OUTCOME_PERSISTENCE_FAILED: a started tool effect has no durable terminal result", {
      cause: new AggregateError([primary, fallback], "tool outcome persistence and bounded fallback both failed")
    });
    this.name = "ToolOutcomePersistenceError";
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function toolResultMessage(call: ToolCallBlock, text: string, isError: boolean) {
  return createToolResultMessage({
    id: MessageId(createSafeRandomPublicControlIdV1("tool")),
    source: { kind: "tool", callId: call.id },
    content: [{
      type: "tool-result",
      toolCallId: call.id,
      ...(isError ? { isError: true } : {}),
      content: [{ type: "text", text }]
    }]
  });
}

export async function runToolStep(options: ToolStepOptions): Promise<ToolStepResult> {
  const session = options.session;
  const tools = options.tools;
  const turn = options.turn;
  const step = options.step;
  const signal = options.signal;
  const budgetAvailable = options.budgetAvailable;
  const metadataSource = options.metadata;
  const metadataRunId = metadataSource?.runId;
  const metadataCandidateId = metadataSource?.candidateId;
  const metadata = metadataSource === undefined ? undefined : Object.freeze({
    ...(metadataRunId === undefined ? {} : { runId: metadataRunId }),
    ...(metadataCandidateId === undefined ? {} : { candidateId: metadataCandidateId })
  });
  const commitmentBinder = options.commitmentBinder;
  const sourceCall = options.call;
  const call: ToolCallBlock = Object.freeze({
    type: "tool-call",
    id: sourceCall.id,
    name: sourceCall.name,
    arguments: sourceCall.arguments
  });
  if (isAborted(signal)) {
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool execution was cancelled before dispatch.", true),
      status: "interrupted",
      error: { name: "ToolCancelledError", code: "TOOL_CANCELLED" }
    }, metadata);
    return { invoked: false, budgetExceeded: false, effectRejected: false, outcomeUnknown: false };
  }
  if (!budgetAvailable) {
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool call was not executed because the turn tool budget was exhausted.", true),
      status: "interrupted",
      error: { name: "ToolBudgetExceededError", code: "TOOL_BUDGET_EXCEEDED" }
    }, metadata);
    return { invoked: false, budgetExceeded: true, effectRejected: false, outcomeUnknown: false };
  }

  const runId = metadata?.runId;
  const candidateId = metadata?.candidateId;
  if (!isRuntimeEffectCommitmentBinderV1(commitmentBinder)
    || runId === undefined
    || candidateId === undefined) {
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool execution was rejected because its runtime effect commitment was unavailable.", true),
      status: "interrupted",
      error: { name: "EffectCommitmentError", code: "EFFECT_COMMITMENT_UNAVAILABLE" }
    }, metadata);
    return { invoked: false, budgetExceeded: false, effectRejected: true, outcomeUnknown: false };
  }

  let handle: EffectCommitmentHandleV1;
  try {
    handle = commitmentBinder.bind({
      effectKind: deriveToolEffectKindV1(call.name),
      sessionId: session.header.sessionId,
      runId,
      candidateId,
      turn,
      step,
      internalEffectId: call.id,
      protectedInput: createProtectedTextV1(call.arguments),
      raw: { kind: "text", value: call.arguments }
    });
  } catch {
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool execution was rejected because its runtime effect commitment could not be created.", true),
      status: "interrupted",
      error: { name: "EffectCommitmentError", code: "EFFECT_COMMITMENT_REJECTED" }
    }, metadata);
    return { invoked: false, budgetExceeded: false, effectRejected: true, outcomeUnknown: false };
  }

  let prepared: PreparedToolInvocation;
  try {
    prepared = tools.prepare({
      name: call.name,
      arguments: call.arguments,
      context: { sessionId: session.header.sessionId, ...(signal === undefined ? {} : { signal }) }
    });
  } catch (cause: unknown) {
    commitmentBinder.release(handle);
    const code = cause instanceof ToolExecutionError ? cause.code : "TOOL_EXECUTION_FAILED";
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, `Tool execution failed (${code}).`, true),
      status: "interrupted",
      error: { name: "ToolExecutionError", code }
    }, metadata);
    return { invoked: false, budgetExceeded: false, effectRejected: false, outcomeUnknown: false };
  }

  const approvalBinding: AgentToolApprovalBindingV1 = Object.freeze({
    schemaVersion: 1,
    approvalId: createSafeRandomPublicControlIdV1("approval"),
    scope: handle.commitment.effectKind,
    risk: prepared.risk,
    callId: call.id,
    name: call.name,
    commitment: handle.commitment
  });

  let requestedApproval;
  try {
    requestedApproval = await session.append("approval/requested", {
      binding: approvalBinding
    }, metadata);
  } catch (error: unknown) {
    commitmentBinder.release(handle);
    throw error;
  }

  let authorization: ToolAuthorizationOutcome;
  try {
    authorization = await tools.authorizePrepared(prepared, requestedApproval);
  } catch (cause: unknown) {
    commitmentBinder.release(handle);
    const cancelled = isAborted(signal)
      || (cause instanceof ToolExecutionError && cause.code === "TOOL_CANCELLED");
    const resolution: AgentApprovalResolutionV1 = cancelled ? "cancelled" : "interrupted";
    await session.append("approval/resolved", {
      binding: approvalBinding,
      requestEventId: requestedApproval.eventId,
      requestDigest: requestedApproval.digest,
      decision: "deny",
      resolution
    }, metadata);
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(
        call,
        cancelled ? "Tool execution was cancelled before dispatch." : "Tool authorization failed.",
        true
      ),
      status: "interrupted",
      error: cancelled
        ? { name: "ToolCancelledError", code: "TOOL_CANCELLED" }
        : { name: "ToolAuthorizationError", code: "TOOL_AUTHORIZATION_FAILED" }
    }, metadata);
    return { invoked: false, budgetExceeded: false, effectRejected: false, outcomeUnknown: false };
  }

  const resolvedApproval = await session.append("approval/resolved", {
    binding: approvalBinding,
    requestEventId: requestedApproval.eventId,
    requestDigest: requestedApproval.digest,
    decision: authorization.approvalDecision,
    resolution: authorization.resolution
  }, metadata);
  const permit = tools.issueExecutePermit(prepared, resolvedApproval);
  if (authorization.decision !== "approve" || permit === undefined) {
    commitmentBinder.release(handle);
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool execution was denied before dispatch.", true),
      status: "interrupted",
      error: { name: "ToolDeniedError", code: "TOOL_DENIED" }
    }, metadata);
    return { invoked: false, budgetExceeded: false, effectRejected: false, outcomeUnknown: false };
  }

  if (isAborted(signal)) {
    commitmentBinder.release(handle);
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool execution was cancelled before dispatch.", true),
      status: "interrupted",
      error: { name: "ToolCancelledError", code: "TOOL_CANCELLED" }
    }, metadata);
    return { invoked: false, budgetExceeded: false, effectRejected: false, outcomeUnknown: false };
  }

  // Awaiting this append is the durable boundary immediately before the
  // authenticated handler side effect. Approval facts are already durable.
  try {
    await session.append("tool/call", {
      turn,
      step,
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
      commitment: handle.commitment
    }, metadata);
  } catch (error: unknown) {
    commitmentBinder.release(handle);
    throw error;
  }

  if (isAborted(signal)) {
    commitmentBinder.release(handle);
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool execution was cancelled before dispatch.", true),
      status: "interrupted",
      error: { name: "ToolCancelledError", code: "TOOL_CANCELLED" }
    }, metadata);
    return { invoked: false, budgetExceeded: false, effectRejected: false, outcomeUnknown: false };
  }

  if (!commitmentBinder.verifyAndConsume(handle, { kind: "text", value: call.arguments })) {
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool execution was rejected because its runtime effect commitment did not match.", true),
      status: "interrupted",
      error: { name: "EffectCommitmentError", code: "EFFECT_COMMITMENT_MISMATCH" }
    }, metadata);
    return { invoked: false, budgetExceeded: false, effectRejected: true, outcomeUnknown: false };
  }

  let text: string;
  let error: { name: string; code: string } | undefined;
  try {
    const result = await tools.executeAuthorized(permit);
    text = JSON.stringify(result);
  } catch (cause: unknown) {
    const code = cause instanceof ToolExecutionError && String(cause.code) !== "TOOL_CANCELLED"
      ? cause.code
      : "TOOL_EXECUTION_FAILED";
    error = { name: "ToolExecutionError", code };
    text = `Tool execution failed (${code}).`;
  }

  const cancelled = isAborted(signal);
  if (cancelled) {
    error = { name: "ToolCancelledError", code: "TOOL_CANCELLED" };
    text = "Tool execution was interrupted by cancellation; its external outcome must not be assumed.";
  }

  try {
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, text, error !== undefined),
      status: cancelled ? "interrupted" : "completed",
      ...(error === undefined ? {} : { error })
    }, metadata);
  } catch (primary: unknown) {
    try {
      await session.append("tool/result", {
        turn,
        step,
        message: toolResultMessage(
          call,
          "Tool execution finished but its result could not be recorded; the external outcome is unknown.",
          true
        ),
        status: "interrupted",
        error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" }
      }, metadata);
    } catch (fallback: unknown) {
      throw new ToolOutcomePersistenceError(primary, fallback);
    }
    return { invoked: true, budgetExceeded: false, effectRejected: false, outcomeUnknown: true };
  }
  return { invoked: true, budgetExceeded: false, effectRejected: false, outcomeUnknown: false };
}
