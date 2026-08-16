/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/agent-loop/src/agent.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: retained the bounded model/tool reaction loop while replacing
 * Cordis hooks and plugins with static runtimes and durable Muniu events.
 */

import {
  MessageId,
  createSafeRandomPublicControlIdV1,
  createRuntimeEffectCommitmentBinderV1,
  createUserMessage,
  type AgentSessionEventV1,
  type ToolCallBlock,
  type TurnEndReason
} from "@mn/agent-protocol";
import { BlockAssembler, type LlmRuntime } from "@mn/agent-llm";
import { projectRuntimeMessages } from "@mn/agent-session";
import type { ToolRegistry } from "@mn/agent-tools";

import type { AgentRunInput, AgentRunResult } from "./agent-registry.js";
import { withAgentRunLease } from "./run-lease.js";
import type { StaticSystemPrompt } from "./system-prompt.js";
import { ToolOutcomePersistenceError, runToolStep } from "./tool-step.js";

const DEFAULT_MAX_STEPS = 16;
const DEFAULT_MAX_TOOL_CALLS = 64;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function assertBudget(name: string, value: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
}

function nextTurn(input: AgentRunInput): number {
  let turn = 0;
  for (const event of input.session.events) {
    if (event.type === "turn/start") turn = Math.max(turn, event.payload.publicControls.turn);
  }
  return turn + 1;
}

export class ReactDriver {
  constructor(
    private readonly llm: LlmRuntime,
    private readonly tools: ToolRegistry,
    private readonly systemPrompt: StaticSystemPrompt
  ) {}

  run(input: AgentRunInput): Promise<AgentRunResult> {
    return withAgentRunLease(input.session.header.sessionId, "driver", () => this.runExclusive(input));
  }

  private async runExclusive(input: AgentRunInput): Promise<AgentRunResult> {
    const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
    const maxToolCalls = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    assertBudget("maxSteps", maxSteps, false);
    assertBudget("maxToolCalls", maxToolCalls, true);
    if (input.prompt.length === 0) throw new Error("agent prompt must not be empty");
    // A reopened protected history cannot be converted back into executable
    // model messages. Fail before appending a new turn unless the caller has
    // supplied the process-local runtime overlay for every prior message.
    projectRuntimeMessages(input.session);

    const effectPolicyBinding = input.effectPolicyBinding;
    const commitmentBinder = effectPolicyBinding === undefined
      ? undefined
      : createRuntimeEffectCommitmentBinderV1(effectPolicyBinding);

    try {
      const turn = nextTurn(input);
      const metadata = {
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId })
      };
      let steps = 0;
      let toolCalls = 0;
      let lastEvent: AgentSessionEventV1 | undefined;
      let reason: TurnEndReason = "error";

      lastEvent = await input.session.append("turn/start", { turn }, metadata);
      const userMessage = createUserMessage({
        id: MessageId(createSafeRandomPublicControlIdV1("user")),
        source: { kind: "user" },
        content: [{ type: "text", text: input.prompt }]
      });
      lastEvent = await input.session.append("user/message", { turn, message: userMessage }, metadata);

      for (let step = 1; step <= maxSteps; step += 1) {
        steps = step;
        lastEvent = await input.session.append("step/start", { turn, step }, metadata);
        let stepClosed = false;
        try {
          if (isAborted(input.signal)) {
            reason = "cancelled";
          } else {
            const assembler = new BlockAssembler();
            for await (const chunk of this.llm.stream({
              provider: input.provider,
              model: input.model,
              messages: projectRuntimeMessages(input.session),
              system: this.systemPrompt.render(),
              tools: this.tools.schemas(),
              ...(input.signal === undefined ? {} : { signal: input.signal })
            })) {
              if (isAborted(input.signal)) {
                reason = "cancelled";
                break;
              }
              assembler.push(chunk);
            }

            if (reason !== "cancelled") {
              const message = assembler.message({ kind: "model", provider: input.provider, model: input.model });
              lastEvent = await input.session.append("assistant/message", {
                turn,
                step,
                message,
                ...(assembler.usage === undefined ? {} : { usage: assembler.usage })
              }, metadata);
              const calls = message.content.filter((block): block is ToolCallBlock => block.type === "tool-call");

              if (assembler.error !== undefined || assembler.finish === "error") {
                reason = "error";
              } else if (assembler.finish === "cancelled" || isAborted(input.signal)) {
                reason = "cancelled";
              } else if (assembler.finish === "max-tokens") {
                reason = "budget-exceeded";
              } else if (calls.length === 0) {
                reason = "completed";
              } else {
                let budgetExceeded = false;
                let effectRejected = false;
                let outcomeUnknown = false;
                for (const call of calls) {
                  const result = await runToolStep({
                    session: input.session,
                    tools: this.tools,
                    turn,
                    step,
                    call,
                    ...(input.signal === undefined ? {} : { signal: input.signal }),
                    budgetAvailable: toolCalls < maxToolCalls,
                    ...(commitmentBinder === undefined ? {} : { commitmentBinder }),
                    metadata
                  });
                  if (result.invoked) toolCalls += 1;
                  if (result.budgetExceeded) budgetExceeded = true;
                  if (result.effectRejected) effectRejected = true;
                  if (result.outcomeUnknown) outcomeUnknown = true;
                  if (isAborted(input.signal)) {
                    reason = "cancelled";
                    continue;
                  }
                }
                if (reason === "cancelled") {
                  // Preserve cancellation selected above.
                } else if (effectRejected || outcomeUnknown) {
                  reason = "error";
                } else if (budgetExceeded) {
                  reason = "budget-exceeded";
                } else if (step === maxSteps) {
                  reason = "budget-exceeded";
                } else {
                  lastEvent = await input.session.append("step/end", { turn, step, status: "completed" }, metadata);
                  stepClosed = true;
                  continue;
                }
              }
            }
          }
        } catch (error: unknown) {
          if (error instanceof ToolOutcomePersistenceError) throw error;
          reason = isAborted(input.signal) ? "cancelled" : "error";
        }

        if (!stepClosed) {
          lastEvent = await input.session.append("step/end", { turn, step, status: reason }, metadata);
        }
        break;
      }

      lastEvent = await input.session.append("turn/end", { turn, reason }, metadata);
      await input.session.flush();
      return {
        reason,
        steps,
        toolCalls,
        ...(lastEvent === undefined ? {} : { lastEvent })
      };
    } finally {
      commitmentBinder?.dispose();
    }
  }
}
