// SPDX-License-Identifier: Apache-2.0

import type { LlmRuntime } from "@mn/agent-llm";
import type { ToolRegistry } from "@mn/agent-tools";

import type { AgentExecutor } from "./agent-registry.js";
import { ReactDriver } from "./react-driver.js";
import type { StaticSystemPrompt } from "./system-prompt.js";

export interface BuiltinAgentKernelOptions {
  readonly llm: LlmRuntime;
  readonly tools: ToolRegistry;
  readonly systemPrompt: StaticSystemPrompt;
}

export function createBuiltinAgentKernel(options: BuiltinAgentKernelOptions): AgentExecutor {
  return new ReactDriver(options.llm, options.tools, options.systemPrompt);
}
