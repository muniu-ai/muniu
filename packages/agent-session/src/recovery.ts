/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/session/src/repair.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: recovery appends v1 digest-chained interrupted facts through the
 * store API and never receives or invokes an effect executor.
 */

import {
  MessageId,
  createToolResultMessage,
  type AgentSessionEventV1
} from "@mn/agent-protocol";

import { projectSession } from "./projection.js";
import type { AgentSessionExclusiveView, AgentSessionLike } from "./types.js";

export const TOOL_NOT_STARTED = "TOOL_NOT_STARTED";
export const TOOL_OUTCOME_UNKNOWN = "TOOL_OUTCOME_UNKNOWN";

async function recoverOnce(session: AgentSessionExclusiveView): Promise<AgentSessionEventV1[]> {
  const projection = projectSession(session.events);
  if (projection.openTurn === undefined) return [];
  const appended: AgentSessionEventV1[] = [];
  for (const call of projection.pendingToolCalls) {
    const code = call.started ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED;
    const text = call.started
      ? "The tool call was durably recorded but no outcome was recorded. Its external outcome is unknown; do not replay it automatically."
      : "The tool call was not durably recorded as started. It was interrupted and was not replayed automatically.";
    const message = createToolResultMessage({
      id: MessageId(`recovery-${call.callId}`),
      source: { kind: "tool", callId: call.callId },
      content: [{
        type: "tool-result",
        toolCallId: call.callId,
        isError: true,
        content: [{ type: "text", text }]
      }]
    });
    appended.push(await session.append("tool/result", {
      turn: call.turn,
      step: call.step,
      message,
      status: "interrupted",
      error: {
        name: call.started ? "ToolOutcomeUnknownError" : "ToolNotStartedError",
        code
      }
    }));
  }
  if (projection.openStep !== undefined) {
    appended.push(await session.append("step/end", {
      turn: projection.openTurn,
      step: projection.openStep,
      status: "interrupted"
    }));
  }
  appended.push(await session.append("turn/end", { turn: projection.openTurn, reason: "interrupted" }));
  await session.flush();
  return appended;
}

export function recoverInterruptedSession(session: AgentSessionLike): Promise<AgentSessionEventV1[]> {
  return session.withExclusive(recoverOnce);
}
