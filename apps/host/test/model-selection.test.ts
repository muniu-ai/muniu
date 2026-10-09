// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryKernelStore } from "@mn/kernel";
import { createAgentOsHost } from "../src/index.js";

const post = (path: string, data: unknown, key: string) => new Request(`http://host.test${path}`, {
  method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(data),
});
async function fixture() {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({ store,
    secretStore: { async save() { return "keychain://muniu.v2/fixture"; }, async read() { return "SECRET"; } },
    modelProbe: async () => ({ models: ["deepseek-v4-flash", "deepseek-v4-pro", "unknown-model"], defaultModel: "deepseek-v4-flash" }),
  });
  const pending = (await (await host.dispatch(post("/v2/model-connections", { presetId: "deepseek", apiKey: "SECRET" }, "create"))).json()).data;
  const current = (await (await host.dispatch(post(`/v2/model-connections/${pending.id}/probe`, { expectedStreamVersion: pending.streamVersion, makeDefault: true }, "probe"))).json()).data;
  return { store, host, current };
}

test("model selection preserves the original binding and creates an idempotent default for new executions", async () => {
  const { host, current } = await fixture();
  try {
    const route = `/v2/model-connections/${current.id}/model`;
    const input = { expectedStreamVersion: current.streamVersion, modelName: "deepseek-v4-pro" };
    const response = await host.dispatch(post(route, input, "select"));
    assert.equal(response.status, 200);
    const selected = (await response.json()).data;
    assert.notEqual(selected.id, current.id);
    assert.equal(selected.defaultModel, "deepseek-v4-pro");
    assert.equal(selected.defaultForNewExecutions, true);
    assert.equal(JSON.stringify(selected).includes("SECRET"), false);
    assert.equal("secretRef" in selected, false);
    const replay = (await (await host.dispatch(post(route, input, "select"))).json()).data;
    assert.deepEqual(replay, selected);
    const connections = (await (await host.dispatch(new Request("http://host.test/v2/model-connections"))).json()).data;
    assert.equal(connections.length, 2);
    assert.equal(connections.find((value: any) => value.id === current.id).defaultModel, "deepseek-v4-flash");
    assert.equal(connections.find((value: any) => value.id === current.id).streamVersion, current.streamVersion);
    assert.equal(connections.filter((value: any) => value.defaultForNewExecutions).length, 1);
    assert.equal(connections[0].modelOptions.find((value: any) => value.modelName === "unknown-model").selectable, false);
    const probe = await host.dispatch(post(`/v2/model-connections/${selected.id}/probe`, { expectedStreamVersion: selected.streamVersion }, "reprobe"));
    assert.equal((await probe.json()).data.defaultModel, "deepseek-v4-pro");
    const other = await host.dispatch(post(route, { expectedStreamVersion: current.streamVersion, modelName: "deepseek-v4-flash" }, "other-default"));
    assert.equal(other.status, 200);
    assert.deepEqual((await (await host.dispatch(post(route, input, "select"))).json()).data, selected);
  } finally { await host.close(); }
});

test("model selection rejects unknown, unpriced and stale choices", async () => {
  const { host, current } = await fixture();
  try {
    for (const [modelName, expectedStreamVersion, expectedCode] of [
      ["not-discovered", current.streamVersion, "MODEL_NOT_DISCOVERED"],
      ["unknown-model", current.streamVersion, "MODEL_PRICE_UNAVAILABLE"],
      ["deepseek-v4-pro", 0, "STREAM_VERSION_CONFLICT"],
    ] as const) {
      const response = await host.dispatch(post(`/v2/model-connections/${current.id}/model`, { expectedStreamVersion, modelName }, `invalid-${modelName}`));
      assert.equal((await response.json()).code, expectedCode);
    }
  } finally { await host.close(); }
});
