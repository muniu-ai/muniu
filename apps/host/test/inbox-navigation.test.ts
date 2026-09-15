// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryKernelStore } from "@mn/kernel";
import { createAgentOsHost } from "../src/index.js";

test("收件箱提供同一工作区的业务会话入口，拒绝损坏的跨工作区引用", async () => {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({ store,
    secretStore: { async save() { throw new Error("unused"); }, async read() { throw new Error("unused"); } } });
  try {
    const workspace = await host.kernel.createWorkspace("local", "local-owner", "workspace", {
      name: "机会研究", viewMode: "business", pluginIds: ["opc"],
    });
    await store.transact("local", tx => {
      tx.putProjection("thread", "thread-one", { id: "thread-one", tenantId: "local", workspaceId: workspace.id,
        pluginId: "opc", resourceRef: { namespace: "opc.opportunity", resourceId: "opportunity-one" } });
      for (const [id, foreign] of [["own", false], ["foreign", true]] as const) {
        tx.putProjection("execution", id, { id, tenantId: "local", workspaceId: foreign ? "other" : workspace.id, threadId: "thread-one" });
        tx.putProjection("inbox", id, { id, tenantId: "local", workspaceId: workspace.id, executionId: id,
          kind: "agent_question", title: "执行已暂停", summary: "用量需要核对", status: "open", createdAt: "2026-09-06T00:00:00.000Z" });
      }
    });
    const response = await host.dispatch(new Request(`http://host.test/v2/inbox?workspaceId=${workspace.id}`));
    assert.equal(response.status, 200);
    const items = (await response.json()).data;
    assert.deepEqual(items.find((item: { id: string }) => item.id === "own").navigation, {
      threadId: "thread-one", pluginId: "opc", resourceRef: { namespace: "opc.opportunity", resourceId: "opportunity-one" },
    });
    assert.equal(items.find((item: { id: string }) => item.id === "foreign").navigation, undefined);
  } finally { await host.close(); }
});
