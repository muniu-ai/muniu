// SPDX-License-Identifier: Apache-2.0
import type { CodingRunnerConfigurationV1 } from "./models.js";

export interface AgentReadinessCheckV1 {
  readonly id: "model" | "coding_plugin" | "runner_plugin" | "permission" | "confirmation" | "binary_identity" | "worker" | "sandbox" | "authentication" | "approval" | "adapter";
  readonly status: "passed" | "blocked" | "unknown" | "required";
  readonly message: string;
  readonly action?: string;
}

export interface AgentReadinessV1 {
  readonly agentId: "builtin" | "codex-cli" | "claude-cli" | "workbuddy";
  readonly displayName: string;
  readonly scope: "coding";
  readonly support: "supported" | "not_supported";
  readonly status: "blocked" | "unverified";
  readonly checks: readonly AgentReadinessCheckV1[];
  readonly configuration?: CodingRunnerConfigurationV1;
}

export interface AgentReadinessReportV1 {
  readonly workspaceId: string;
  readonly checkedAt: string;
  readonly agents: readonly AgentReadinessV1[];
}
