// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { appendKernelEvent, InMemoryKernelStore } from "@mn/kernel";
import { createAgentOsHost } from "../src/index.js";

test("Agent diagnostics are readable in business workspaces and do not claim installed agents are ready", async () => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({ store,
    secretStore: { async save() { return "keychain://muniu.v2/test"; }, async read() { return "fixture"; } },
  });
  try {
    const response = await host.dispatch(new Request("http://host.test/v2/workspaces", {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "workspace" },
      body: JSON.stringify({ name: "经营", viewMode: "business", pluginIds: ["opc"] }),
    }));
    const workspace = (await response.json()).data;
    const read = await host.dispatch(new Request(`http://host.test/v2/workspaces/${workspace.id}/agent-readiness`));
    assert.equal(read.status, 200);
    const report = (await read.json()).data;
    assert.equal(report.workspaceId, workspace.id);
    assert.equal(report.agents.length, 4);
    assert.equal(report.agents.every((agent: any) => agent.status === "blocked"), true);
    assert.equal(report.agents.find((agent: any) => agent.agentId === "workbuddy").support, "not_supported");
    const codex = report.agents.find((agent: any) => agent.agentId === "codex-cli");
    assert.equal(codex.checks.find((check: any) => check.id === "model").status, "blocked");
    assert.equal(codex.checks.find((check: any) => check.id === "authentication").status, "unknown");
    await store.transact("local", tx => {
      const principal = tx.getProjection<any>("principal", "local-owner");
      tx.putProjection("principal", "local-owner", { ...principal, streamVersion: principal.streamVersion + 1, disabledAt: "2026-10-09T00:00:00.000Z" });
      appendKernelEvent(tx, { tenantId: "local", aggregateType: "principal", aggregateId: "local-owner", expectedStreamVersion: 0,
        type: "principal.disabled", actorId: "local-owner", generation: 0, correlationId: "disable-test", publicPayload: {} });
    });
    const disabled = (await (await host.dispatch(new Request(`http://host.test/v2/workspaces/${workspace.id}/agent-readiness`))).json()).data;
    assert.equal(disabled.agents[0].checks.find((check: any) => check.id === "permission").status, "blocked");
    const missing = await host.dispatch(new Request("http://host.test/v2/workspaces/nonexistent/agent-readiness"));
    assert.notEqual(missing.status, 200);
  } finally { await host.close(); }
});
