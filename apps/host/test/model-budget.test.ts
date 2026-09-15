// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryKernelStore } from "@mn/kernel";
import { createAgentOsHost } from "../src/index.js";

for (const [presetId, currency] of [["openai", "USD"], ["anthropic", "USD"], ["deepseek", "CNY"]]) {
  test(`${presetId} 的 Execution 预算使用厂商原币种`, async t => {
    const store = new InMemoryKernelStore();
    const host = await createAgentOsHost({ store,
      secretStore: { async save(id) { return `keychain://muniu.v2/${id}`; }, async read() { return "fixture"; } },
      modelProbe: async ({ preset }) => ({ models: preset.suggestedModels, defaultModel: preset.suggestedModels[0]! }),
    });
    t.after(() => host.close());
    let sequence = 0;
    const post = async (path: string, data: unknown) => {
      const response = await host.dispatch(new Request(`http://host.test${path}`, { method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `budget-${++sequence}` }, body: JSON.stringify(data) }));
      const result = await response.json() as any;
      assert.ok(response.ok, JSON.stringify(result));
      return result.data;
    };
    const workspace = await post("/v2/workspaces", { name: "预算工作区", viewMode: "business", pluginIds: ["opc"] });
    const model = await post("/v2/model-connections", { presetId, apiKey: "fixture" });
    await post(`/v2/model-connections/${model.id}/probe`, { expectedStreamVersion: model.streamVersion });
    const thread = await post(`/v2/workspaces/${workspace.id}/threads`, { subject: "验证需求", pluginId: "opc" });
    const execution = await post(`/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`, {
      expectedStreamVersion: thread.streamVersion, message: "整理证据缺口", modelBindingId: model.id,
      agentDefinitionId: "opc.opportunity-validator",
    });
    const authority = await store.transact("local", tx => tx.getProjection<any>("authority", execution.authorityId));
    assert.equal(authority.budget.currency, currency);
  });
}

test("默认模型连接显式切换，只影响新执行，不改写既有模型绑定", async t => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({ store,
    secretStore: { async save(id) { return `keychain://muniu.v2/${id}`; }, async read() { return "fixture"; } },
    modelProbe: async ({ preset }) => ({ models: preset.suggestedModels, defaultModel: preset.suggestedModels[0]! }),
  });
  t.after(() => host.close());
  let sequence = 0;
  const post = async (path: string, body: unknown) => {
    const response = await host.dispatch(new Request(`http://host.test${path}`, { method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `default-${++sequence}` }, body: JSON.stringify(body) }));
    const result = await response.json() as any;
    assert.ok(response.ok, JSON.stringify(result));
    return result.data;
  };
  const workspace = await post("/v2/workspaces", { name: "连接管理", viewMode: "business", pluginIds: ["opc"] });
  const first = await post("/v2/model-connections", { presetId: "openai", apiKey: "fixture-one" });
  await post(`/v2/model-connections/${first.id}/probe`, { expectedStreamVersion: 1 });
  const thread = () => post(`/v2/workspaces/${workspace.id}/threads`, { subject: "检查当前连接", pluginId: "opc" });
  const submit = async () => { const current = await thread(); return post(`/v2/workspaces/${workspace.id}/threads/${current.id}/turns`, {
    expectedStreamVersion: current.streamVersion, message: "列出证据缺口",
  }); };
  const original = await submit();
  const second = await post("/v2/model-connections", { presetId: "deepseek", apiKey: "fixture-two" });
  const probed = await post(`/v2/model-connections/${second.id}/probe`, { expectedStreamVersion: 1, makeDefault: true });
  assert.equal(probed.defaultForNewExecutions, true);
  assert.equal((await submit()).modelBindingId, second.id);
  assert.equal((await store.transact("local", tx => tx.getProjection<any>("execution", original.id))).modelBindingId, first.id);
  await post(`/v2/model-connections/${first.id}/probe`, { expectedStreamVersion: 2, makeDefault: true });
  assert.equal((await submit()).modelBindingId, first.id);
  assert.equal((await store.transact("local", tx => tx.getProjection<any>("modelConnection", second.id))).defaultForNewExecutions, false);
});
