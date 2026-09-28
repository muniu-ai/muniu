// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { Approval, Execution, ExecutionAuthority, ToolCallIntent } from "@mn/contracts";
import { AgentOsKernel, InMemoryKernelStore, recordToolAdmission, replayCoreProjections, type ToolAdmission } from "../src/index.js";

const NOW = "2026-09-04T00:00:00.000Z";

async function fixture() {
  const store = new InMemoryKernelStore(Buffer.alloc(32), () => NOW);
  const kernel = new AgentOsKernel(store, { now: () => NOW });
  const workspace = await kernel.createWorkspace("local", "owner", "workspace", {
    name: "撤权测试", viewMode: "professional", pluginIds: ["fixture"],
  });
  const member = await kernel.setWorkspaceMembership("local", "owner", "member", workspace.id, "operator", 0, "operator");
  const thread = await kernel.createThread("local", "operator", "thread", {
    workspaceId: workspace.id, subject: "检查当前授权", pluginId: "fixture",
  });
  const execution = await kernel.createExecution("local", "operator", "execution", {
    workspaceId: workspace.id, threadId: thread.id, pluginId: "fixture", agentDefinitionId: "fixture.agent",
    modelBindingId: "model", executionPrincipalId: "agent:fixture", authority: {
      workspaceId: workspace.id, principalId: "agent:fixture", toolIds: ["fixture.send"], dataScopes: [], autoAllowedEffects: [],
      budget: { maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 100, maxCostMinorUnits: "10", currency: "CNY", maxDurationMs: 60_000 },
    },
  });
  const authority = await store.transact("local", tx => tx.getProjection<ExecutionAuthority>("authority", execution.authorityId));
  const intent: ToolCallIntent = { id: "send-1", executionId: execution.id, generation: 1,
    toolId: "fixture.send", toolVersion: "1.0.0", effectClass: "external_side_effect", intent: "发送测试结果",
    normalizedArguments: {}, argumentsDigest: "arguments", resourceRefs: [], resourcesDigest: "resources",
    authorityCommitment: authority!.commitment, expiresAt: "2026-09-04T00:10:00.000Z" };
  const read = () => store.transact("local", tx => tx.getProjection<Execution>("execution", execution.id)!);
  const revoke = () => kernel.removeWorkspaceMembership("local", "owner", "revoke", workspace.id, "operator", member.streamVersion);
  const start = () => kernel.commandExecution("local", "operator", "start", execution.id, execution.streamVersion, "start");
  return { store, kernel, workspace, member, execution, intent, read, revoke, start };
}

test("撤权中断排队执行，旧权限不能启动或恢复", async () => {
  const f = await fixture();
  await f.revoke();
  const execution = await f.read();
  assert.equal(execution.status, "interrupted");
  await assert.rejects(f.kernel.commandExecution("local", "operator", "start-revoked", execution.id, execution.streamVersion, "start"), /授权已撤销/u);
  await assert.rejects(f.kernel.commandExecution("local", "owner", "resume-revoked", execution.id, execution.streamVersion, "resume"), /授权已撤销/u);
});

test("降为只读角色与移除成员使用相同撤权路径", async () => {
  const f = await fixture();
  await f.start();
  await f.kernel.setWorkspaceMembership("local", "owner", "downgrade", f.workspace.id, "operator", f.member.streamVersion, "reviewer");
  assert.equal((await f.read()).status, "interrupted");
  await assert.rejects(f.kernel.requestToolApproval("local", "agent:fixture", "tool-revoked", f.intent), /授权已撤销/u);
});

for (const approved of [false, true]) test(`撤权使${approved ? "已批准" : "待批准"}请求失效，重新入会不恢复旧批准`, async () => {
  const f = await fixture();
  await f.start();
  const requested = await f.kernel.requestToolApproval("local", "agent:fixture", "tool", f.intent);
  assert.equal(requested.mode, "approval");
  if (requested.mode !== "approval") throw new Error("审批请求缺失");
  if (approved) await f.kernel.decideApproval("local", "owner", "approve", requested.approval.id, 1, "approve_once");
  const revoked = await f.revoke();
  await f.kernel.setWorkspaceMembership("local", "owner", "restore", f.workspace.id, "operator", revoked.streamVersion, "operator");
  const approval = await f.store.transact("local", tx => tx.getProjection<Approval>("approval", requested.approval.id));
  assert.equal(approval?.status, "expired");
  assert.equal((await f.read()).status, "interrupted");
  assert.equal((await f.kernel.listInbox("local")).length, 0);
  await assert.rejects(f.kernel.decideApproval("local", "owner", "approve-old", approval!.id, approval!.streamVersion, "approve_once"), /已经处理/u);
});

test("已准入且结果未知的副作用在撤权和重新入会后保持人工核对", async () => {
  const f = await fixture();
  await f.start();
  const requested = await f.kernel.requestToolApproval("local", "agent:fixture", "tool", f.intent);
  assert.equal(requested.mode, "approval");
  if (requested.mode !== "approval") throw new Error("审批请求缺失");
  await f.kernel.decideApproval("local", "owner", "approve", requested.approval.id, 1, "approve_once");
  // Protected runtime records expose type metadata while keeping payloads encrypted.
  await f.store.transact("local", tx => tx.putProjection("agent-runtime", f.execution.id, {
    executionId: f.execution.id, records: [{ type: "tool/started", payload: {}, protectedPayloadRef: "opaque-record" }],
  }));
  const revoked = await f.revoke();
  await f.kernel.setWorkspaceMembership("local", "owner", "restore", f.workspace.id, "operator", revoked.streamVersion, "operator");
  const current = await f.read();
  assert.equal(current.status, "needs_reconciliation");
  await assert.rejects(f.kernel.commandExecution("local", "operator", "resume-unknown", current.id, current.streamVersion, "resume"), /不能执行/u);
});

test("审批人撤权会失效其为其他成员批准的操作", async () => {
  const f = await fixture();
  await f.kernel.setWorkspaceMembership("local", "owner", "reviewer", f.workspace.id, "reviewer", 0, "reviewer");
  await f.start();
  const requested = await f.kernel.requestToolApproval("local", "agent:fixture", "tool", f.intent);
  if (requested.mode !== "approval") throw new Error("审批请求缺失");
  await f.kernel.decideApproval("local", "reviewer", "approve", requested.approval.id, 1, "approve_once");
  await f.kernel.removeWorkspaceMembership("local", "owner", "revoke-reviewer", f.workspace.id, "reviewer", 1);
  assert.equal((await f.read()).status, "interrupted");
  assert.equal((await f.store.transact("local", tx => tx.getProjection<Approval>("approval", requested.approval.id)))?.status, "expired");
});


test("工具准入事实可重建，未知结果不能重复派发，确定结果才结算", async () => {
  const f = await fixture();
  const execution = await f.start();
  await f.store.transact("local", tx => recordToolAdmission(tx, execution, f.intent.id, "started", NOW));
  const events = (await f.store.readEvents("local", 0, 100)).events;
  const snapshot = replayCoreProjections(events, "local", Buffer.alloc(32));
  const admission = snapshot.records.find(record => record.namespace === "toolAdmission")?.value;
  assert.equal(admission?.status, "started");
  await assert.rejects(f.store.transact("local", tx => recordToolAdmission(tx, execution, f.intent.id, "started", NOW)),
    { code: "TOOL_ALREADY_ADMITTED" });
  await f.revoke();
  assert.equal((await f.read()).status, "needs_reconciliation");
  await f.store.transact("local", tx => recordToolAdmission(tx, execution, f.intent.id, "settled", NOW));
  const confirmed = await f.store.transact("local", tx => tx.listProjections<ToolAdmission>("toolAdmission"));
  assert.equal(confirmed[0]?.status, "settled");
  assert.equal((await f.read()).status, "needs_reconciliation");
});
