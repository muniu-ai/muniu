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

import { MessageId, createToolResultMessage, type ToolCallBlock } from "@mn/agent-protocol";
import type { AgentEventMetadata, AgentSession } from "@mn/agent-session";
import { ToolExecutionError, type ToolRegistry } from "@mn/agent-tools";

export interface ToolStepOptions {
  readonly session: AgentSession;
  readonly tools: ToolRegistry;
  readonly turn: number;
  readonly step: number;
  readonly call: ToolCallBlock;
  readonly signal?: AbortSignal;
  readonly budgetAvailable: boolean;
  readonly metadata?: AgentEventMetadata;
}

export interface ToolStepResult {
  readonly invoked: boolean;
  readonly budgetExceeded: boolean;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function toolResultMessage(call: ToolCallBlock, text: string, isError: boolean) {
  return createToolResultMessage({
    id: MessageId(`tool-${crypto.randomUUID()}`),
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
  const { session, call, turn, step } = options;
  if (isAborted(options.signal)) {
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool execution was cancelled before dispatch.", true),
      status: "interrupted",
      error: { name: "ToolCancelledError", code: "TOOL_CANCELLED" }
    }, options.metadata);
    return { invoked: false, budgetExceeded: false };
  }
  if (!options.budgetAvailable) {
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool call was not executed because the turn tool budget was exhausted.", true),
      status: "interrupted",
      error: { name: "ToolBudgetExceededError", code: "TOOL_BUDGET_EXCEEDED" }
    }, options.metadata);
    return { invoked: false, budgetExceeded: true };
  }

  // Awaiting this append is the durable boundary before any handler side effect.
  await session.append("tool/call", {
    turn,
    step,
    callId: call.id,
    name: call.name,
    arguments: call.arguments
  }, options.metadata);

  if (isAborted(options.signal)) {
    await session.append("tool/result", {
      turn,
      step,
      message: toolResultMessage(call, "Tool execution was cancelled before dispatch.", true),
      status: "interrupted",
      error: { name: "ToolCancelledError", code: "TOOL_CANCELLED" }
    }, options.metadata);
    return { invoked: false, budgetExceeded: false };
  }

  let text: string;
  let error: { name: string; code: string } | undefined;
  try {
    const result = await options.tools.execute({
      name: call.name,
      arguments: call.arguments,
      context: { sessionId: session.header.sessionId, ...(options.signal === undefined ? {} : { signal: options.signal }) }
    });
    text = JSON.stringify(result);
  } catch (cause: unknown) {
    const code = cause instanceof ToolExecutionError ? cause.code : "TOOL_EXECUTION_FAILED";
    error = { name: "ToolExecutionError", code };
    text = `Tool execution failed (${code}).`;
  }

  const cancelled = isAborted(options.signal);
  if (cancelled) {
    error = { name: "ToolCancelledError", code: "TOOL_CANCELLED" };
    text = "Tool execution was interrupted by cancellation; its external outcome must not be assumed.";
  }

  await session.append("tool/result", {
    turn,
    step,
    message: toolResultMessage(call, text, error !== undefined),
    status: cancelled ? "interrupted" : "completed",
    ...(error === undefined ? {} : { error })
  }, options.metadata);
  return { invoked: true, budgetExceeded: false };
}
