// SPDX-License-Identifier: Apache-2.0

import { Context } from "@deepseek-ai/cordis";
import { AgentOsKernel, type KernelOptions, type KernelStore } from "@mn/kernel";

export async function createAgentOsCompositionRoot(options: {
  readonly profile: "local" | "enterprise";
  readonly store: KernelStore;
  readonly kernelOptions?: KernelOptions;
}): Promise<{ readonly context: Context; readonly kernel: AgentOsKernel }> {
  const context = new Context();
  try {
    await context.plugin({
      name: "agent-os.kernel",
      apply(scope) {
        scope.provide("agentOsProfile", options.profile);
        scope.provide("agentOsKernel", new AgentOsKernel(options.store, {
          acceptsModelSecretReference: options.profile === "enterprise"
            ? reference => reference.startsWith("vault://muniu/v2/")
            : reference => reference.startsWith("keychain://muniu.v2/"),
          ...options.kernelOptions,
        }));
      },
    });
    return { context, kernel: context.get("agentOsKernel") as AgentOsKernel };
  } catch (error) {
    await context.fiber.dispose();
    throw error;
  }
}
