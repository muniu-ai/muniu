// SPDX-License-Identifier: Apache-2.0
import type { ApiOutputsV2, CodingReconciliationDecisionV2 } from "@mn/contracts";

const timestamp = "2026-09-04T08:00:00.000Z";
const entity = { tenantId: "local", streamVersion: 1, createdAt: timestamp, updatedAt: timestamp };
export const workspaceFixture = (value: Partial<ApiOutputsV2["createWorkspace"]> = {}): ApiOutputsV2["createWorkspace"] => ({
  ...entity, id: "workspace-1", name: "木牛", viewMode: "business", activePluginIds: ["opc"], ...value,
});
export const opportunityFixture = (value: Partial<ApiOutputsV2["createOpcOpportunity"]> = {}): ApiOutputsV2["createOpcOpportunity"] => ({
  id: "opportunity-1", workspaceId: "workspace-1", title: "访谈整理", rawCapture: "整理访谈", state: "captured",
  evidenceLevel: "none", streamVersion: 1, createdAt: timestamp, updatedAt: timestamp,
  hypotheses: [], signals: [], interviews: [], experiments: [], commitmentEvidence: [], ...value,
});
export const repositoryFixture = (value: Partial<ApiOutputsV2["createCodingRepository"]> = {}): ApiOutputsV2["createCodingRepository"] => ({
  id: "repository-1", workspaceId: "workspace-1", name: "muniu", rootRealPath: "/work/muniu", vcs: "git",
  streamVersion: 1, createdAt: timestamp, updatedAt: timestamp, ...value,
});
export const codingTaskFixture = (value: Partial<ApiOutputsV2["createCodingTask"]> = {}): ApiOutputsV2["createCodingTask"] => ({
  id: "task-1", workspaceId: "workspace-1", repositoryId: "repository-1", title: "修复事件游标", request: "修复事件游标",
  stage: "discover", status: "active", streamVersion: 1, createdAt: timestamp, updatedAt: timestamp, ...value,
});
export const modelFixture = (value: Partial<ApiOutputsV2["createModelConnection"]> = {}): ApiOutputsV2["createModelConnection"] => ({
  id: "connection-1", tenantId: "local", presetId: "deepseek", displayName: "DeepSeek", defaultModel: "deepseek-chat",
  discoveredModels: ["deepseek-chat"], status: "ready", streamVersion: 1, ...value,
});
export const executionFixture = (value: Partial<ApiOutputsV2["createTurn"]> = {}): ApiOutputsV2["createTurn"] => ({
  ...entity, id: "execution-1", workspaceId: "workspace-1", threadId: "thread-1", pluginId: "coding", agentDefinitionId: "coding.builtin",
  modelBindingId: "connection-1", initiatedBy: "local-owner", executionPrincipalId: "agent-1", authorityId: "authority-1", generation: 1, status: "queued", ...value,
});
export const sampleFixture = (value: Partial<ApiOutputsV2["runOpcReadOnlySample"]> = {}): ApiOutputsV2["runOpcReadOnlySample"] => ({
  id: "sample-1", pluginId: "opc", effectClass: "external_read", status: "completed", summary: "只读策略检查通过", ...value,
});
export const installationFixture = (value: Partial<ApiOutputsV2["installPlugin"]> = {}): ApiOutputsV2["installPlugin"] => ({
  ...entity, id: "installation-1", pluginId: "research", version: "1.2.3", packageSha256: "a".repeat(64), releaseSequence: 1,
  status: "installed", projectionNamespace: "research.1", developmentMode: false, ...value,
});
export const inboxFixture = (value: Partial<ApiOutputsV2["listInbox"][number]> = {}): ApiOutputsV2["listInbox"][number] => ({
  id: "approval:1", tenantId: "local", workspaceId: "workspace-1", kind: "approval", title: "操作需要批准", summary: "等待审阅",
  createdAt: timestamp, status: "open", ...value,
});
export const runnerInspectionFixture = (): ApiOutputsV2["inspectCodingRunner"] => ({
  requestedPath: "/opt/homebrew/bin/claude", realPath: "/opt/homebrew/bin/claude", sha256: "a".repeat(64), device: "1", inode: "2", byteLength: 100, modifiedAtMs: 1,
});
export const runnerConfigurationFixture = (): ApiOutputsV2["confirmCodingRunner"] => ({
  ...entity, id: "runner-1", workspaceId: "w-1", runnerId: "claude-cli", status: "confirmed", streamVersion: 3,
  identity: { ...runnerInspectionFixture(), version: "2.1.0" }, identityDigest: "a".repeat(64), confirmedBy: "local-owner", confirmedAt: timestamp,
});
export const reconciliationFixture = (decision: CodingReconciliationDecisionV2): ApiOutputsV2["getCodingReconciliation"] => ({
  executionId: "execution/a", workspaceId: "workspace-1", taskTitle: "修复事件游标", nextStep: "核对执行结果", runnerId: "claude-cli",
  status: "needs_reconciliation", expectedStreamVersion: 4, expectedCodingStreamVersion: 7,
  evidence: { candidateCount: 0, gateCount: 0, markCompletedAllowed: decision === "mark_completed", summary: "核对证据摘要" },
  newCall: { allowed: true, summary: "可创建新调用" }, availableDecisions: [decision],
});
export const reconciliationDecisionFixture = (decision: CodingReconciliationDecisionV2): ApiOutputsV2["decideCodingReconciliation"] => ({
  decision, status: decision === "mark_completed" ? "verification_pending" : "settled", cleanupJobId: "cleanup-1",
  execution: executionFixture({ id: "execution/a", status: "cancelled" }), task: codingTaskFixture({ status: "cancelled" }),
  codingExecution: { executionId: "execution/a", status: "cancelled", streamVersion: 8, result: {
    task: codingTaskFixture({ status: "cancelled" }), runnerId: "claude-cli", status: "cancelled", candidates: [], gates: [],
    nextStep: "人工核对已记录", limits: { maxRepairAttempts: 3, maxDurationMs: 3600000 },
    controlPlane: { protocol: "coding-v2", specDigest: "a".repeat(64), governanceDigest: "b".repeat(64), harnessDigest: "c".repeat(64), sandboxDigest: "d".repeat(64), repositoryIndexDigest: "e".repeat(64) },
  } },
});
