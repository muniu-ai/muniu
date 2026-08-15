import { maskSecret, type ProviderSecretRef } from "@mn/provider-catalog";
import type { EnvConflict, ManagedEnvName, SecretResolveOptions } from "./types.js";

export const managedEnvNames: readonly ManagedEnvName[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY"
];

export async function resolveProviderSecret(
  secretRef: ProviderSecretRef | undefined,
  options: SecretResolveOptions
): Promise<string | undefined> {
  if (!secretRef) return undefined;
  if (secretRef.type === "env") {
    return options.env?.[secretRef.ref] ?? process.env[secretRef.ref];
  }
  if (options.secretResolver) {
    return options.secretResolver(secretRef);
  }
  return undefined;
}

export function scanEnvConflicts(
  env: NodeJS.ProcessEnv = process.env
): EnvConflict[] {
  const conflicts: EnvConflict[] = [];
  for (const name of managedEnvNames) {
    const value = env[name];
    if (!value) continue;
    conflicts.push({
      name,
      maskedValue: maskSecret(value),
      source: "process.env"
    });
  }
  return conflicts;
}
