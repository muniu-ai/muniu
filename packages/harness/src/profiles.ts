import { digestHarnessProfile } from "./compiler.js";
import type { HarnessProfile } from "./types.js";

function profile(
  value: Omit<HarnessProfile, "digest">
): Readonly<HarnessProfile> {
  const result: HarnessProfile = {
    ...value,
    ...(value.requiredSandboxCapabilities
      ? { requiredSandboxCapabilities: [...value.requiredSandboxCapabilities] }
      : {}),
    ...(value.requiredContextSourceIds
      ? { requiredContextSourceIds: [...value.requiredContextSourceIds] }
      : {}),
    ...(value.requiredContextFragmentIds
      ? { requiredContextFragmentIds: [...value.requiredContextFragmentIds] }
      : {}),
    digest: digestHarnessProfile(value)
  };
  if (result.requiredSandboxCapabilities) {
    Object.freeze(result.requiredSandboxCapabilities);
  }
  if (result.requiredContextSourceIds) Object.freeze(result.requiredContextSourceIds);
  if (result.requiredContextFragmentIds) {
    Object.freeze(result.requiredContextFragmentIds);
  }
  return Object.freeze(result);
}

export const LOCAL_HARNESS_PROFILE = profile({
  id: "local",
  version: "1",
  sandboxBackendId: "worktree-postcheck",
  minimumSandboxEnforcement: "postcheck",
  requiredSandboxCapabilities: ["source-isolation", "diff-postcheck"],
  maxContextBytes: 1_048_576,
  maxContextTokens: 262_144,
  contextSourceTimeoutMs: 5_000,
  failOnMissingRequiredGates: true,
  redactSensitiveContext: true,
  outputSchema: "mn.agent-result.v1"
});

export const ENTERPRISE_HARNESS_PROFILE = profile({
  id: "enterprise",
  version: "1",
  sandboxBackendId: "enterprise-container",
  minimumSandboxEnforcement: "enforced",
  requiredSandboxCapabilities: [
    "mount-policy",
    "network-policy",
    "resource-limits",
    "secret-injection",
    "tool-allowlist"
  ],
  maxContextBytes: 1_048_576,
  maxContextTokens: 262_144,
  contextSourceTimeoutMs: 5_000,
  failOnMissingRequiredGates: true,
  redactSensitiveContext: true,
  outputSchema: "mn.agent-result.v1"
});

export function builtinHarnessProfile(
  id: string
): Readonly<HarnessProfile> | undefined {
  if (id === LOCAL_HARNESS_PROFILE.id) return LOCAL_HARNESS_PROFILE;
  if (id === ENTERPRISE_HARNESS_PROFILE.id) return ENTERPRISE_HARNESS_PROFILE;
  return undefined;
}
