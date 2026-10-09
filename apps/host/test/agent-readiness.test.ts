// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { CodingRunnerConfigurationV1, ExternalCodingRunnerId } from "@mn/contracts";
import { InMemoryKernelStore, sha256 } from "@mn/kernel";
import { evaluateCodingAgentReadiness, readAgentReadiness } from "../src/agent-readiness.js";

const checkedAt = "2026-10-09T08:00:00.000Z";
const identity = {
  requestedPath: "/opt/muniu/codex", realPath: "/opt/muniu/codex", sha256: "a".repeat(64),
  device: "1", inode: "2", byteLength: 100, modifiedAtMs: 3, version: "codex-cli 1.0.0",
};
function configuration(runnerId: ExternalCodingRunnerId = "codex-cli"): CodingRunnerConfigurationV1 {
  return { id: `workspace:${runnerId}`, tenantId: "local", workspaceId: "workspace", runnerId,
    status: "confirmed", identity, identityDigest: sha256(identity), confirmedBy: "owner",
    confirmedAt: checkedAt, streamVersion: 1, createdAt: checkedAt, updatedAt: checkedAt };
}
const common = {
  tenantId: "local", workspaceId: "workspace", checkedAt, canExecute: true, modelReady: true,
  activePluginIds: ["coding", "runner-codex-cli", "runner-claude-cli"],
  runnerPlugins: { "codex-cli": { status: "healthy" as const }, "claude-cli": { status: "healthy" as const } },
};

test("OPC 工作区也能看到 Agent 适用范围与尚未接入的 WorkBuddy", () => {
  const report = evaluateCodingAgentReadiness({ ...common, activePluginIds: ["opc"], configurations: [] });
  assert.equal(report.workspaceId, "workspace");
  assert.equal(report.checkedAt, checkedAt);
  assert.deepEqual(report.agents.map(agent => agent.agentId), ["builtin", "codex-cli", "claude-cli", "workbuddy"]);
  assert.ok(report.agents.every(agent => agent.status === "blocked" && agent.scope === "coding"));
  assert.equal(report.agents[0]!.checks.find(check => check.id === "coding_plugin")?.status, "blocked");
  const workbuddy = report.agents.find(agent => agent.agentId === "workbuddy")!;
  assert.equal(workbuddy.support, "not_supported");
  assert.match(workbuddy.checks[0]!.message, /尚未接入/u);
});

test("已确认且文件身份匹配仍不表示登录或真实任务已验证", () => {
  const report = evaluateCodingAgentReadiness({ ...common, configurations: [configuration()],
    binaryChecks: { "codex-cli": { status: "passed", message: "已确认文件身份匹配" } },
    runtime: { worker: "available", sandbox: "available" } });
  const codex = report.agents.find(agent => agent.agentId === "codex-cli")!;
  assert.equal(codex.status, "unverified");
  assert.equal(codex.configuration?.identityDigest, sha256(identity));
  assert.equal(codex.checks.find(check => check.id === "authentication")?.status, "unknown");
  assert.equal(codex.checks.find(check => check.id === "approval")?.status, "required");
  const builtin = report.agents.find(agent => agent.agentId === "builtin")!;
  assert.equal(builtin.status, "unverified");
  assert.equal(builtin.checks.some(check => check.id === "authentication"), false);
});

test("权限、插件健康、Worker 与 sandbox 的阻断信息分别保留", () => {
  const report = evaluateCodingAgentReadiness({ ...common, canExecute: false, configurations: [configuration()],
    runnerPlugins: { "codex-cli": { status: "missing_tool" } },
    runtime: { worker: "unavailable", sandbox: "unknown" } });
  const checks = report.agents.find(agent => agent.agentId === "codex-cli")!.checks;
  for (const id of ["permission", "runner_plugin", "worker"]) {
    assert.equal(checks.find(check => check.id === id)?.status, "blocked", id);
  }
  assert.equal(checks.find(check => check.id === "sandbox")?.status, "unknown");
});

test("缺少木牛模型连接时内置与外部 Coding Agent 均显示阻断", () => {
  const report = evaluateCodingAgentReadiness({ ...common, modelReady: false, configurations: [configuration()],
    binaryChecks: { "codex-cli": { status: "passed", message: "文件身份匹配" } },
    runtime: { worker: "available", sandbox: "available" } });
  for (const agentId of ["builtin", "codex-cli"]) {
    const agent = report.agents.find(entry => entry.agentId === agentId)!;
    assert.equal(agent.status, "blocked");
    assert.equal(agent.checks.find(check => check.id === "model")?.status, "blocked");
  }
});

test("只检查当前工作区已经确认且摘要有效的二进制，不扫描其他路径", async () => {
  const store = new InMemoryKernelStore();
  const own = configuration();
  await store.transact("local", transaction => {
    transaction.putProjection("coding.runner-configuration", own.id, own);
    transaction.putProjection("coding.runner-configuration", "other:claude-cli", {
      ...configuration("claude-cli"), id: "other:claude-cli", workspaceId: "other",
    });
  });
  const calls: string[] = [];
  const report = await readAgentReadiness({ ...common, store, inspector: {
    async inspect(runnerId, path) { calls.push(`${runnerId}:${path}`); return identity; },
  } });
  assert.deepEqual(calls, [`codex-cli:${identity.requestedPath}`]);
  const checks = report.agents.find(agent => agent.agentId === "codex-cli")!.checks;
  assert.equal(checks.find(check => check.id === "binary_identity")?.status, "passed");
  assert.equal(checks.find(check => check.id === "worker")?.status, "unknown");
});

test("已确认二进制被替换或检查失败时阻断，错误信息不回显敏感路径", async () => {
  for (const failure of ["changed", "missing"] as const) {
    const store = new InMemoryKernelStore();
    const own = configuration();
    await store.transact("local", transaction => transaction.putProjection("coding.runner-configuration", own.id, own));
    const report = await readAgentReadiness({ ...common, store, inspector: {
      async inspect() {
        if (failure === "missing") throw new Error("secret=private-key /sensitive/private/path");
        return { ...identity, sha256: "b".repeat(64) };
      },
    } });
    const codex = report.agents.find(agent => agent.agentId === "codex-cli")!;
    assert.equal(codex.status, "blocked");
    assert.equal(codex.checks.find(check => check.id === "binary_identity")?.status, "blocked");
    assert.doesNotMatch(JSON.stringify(report), /private-key|sensitive/u);
  }
});

test("没有检查器、插件未启用或确认记录损坏时不会尝试启动或检查 Runner", async () => {
  const store = new InMemoryKernelStore();
  const own = configuration();
  await store.transact("local", transaction => transaction.putProjection("coding.runner-configuration", own.id, own));
  const unknown = await readAgentReadiness({ ...common, store });
  assert.equal(unknown.agents.find(agent => agent.agentId === "codex-cli")!.checks
    .find(check => check.id === "binary_identity")?.status, "unknown");
  let called = false;
  const inspector = { async inspect() { called = true; return identity; } };
  await readAgentReadiness({ ...common, store, activePluginIds: ["coding"], inspector });
  assert.equal(called, false);
  await store.transact("local", transaction => transaction.putProjection("coding.runner-configuration", own.id, {
    ...own, identityDigest: "bad-digest",
  }));
  const corrupted = await readAgentReadiness({ ...common, store, inspector });
  assert.equal(called, false);
  assert.equal(corrupted.agents.find(agent => agent.agentId === "codex-cli")!.checks
    .find(check => check.id === "confirmation")?.status, "blocked");
});
