// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { Deliverable, Thread } from "@mn/contracts";
import { InMemoryKernelStore } from "@mn/kernel";
import { createCodingTask } from "@mn/plugin-coding";
import { createAgentOsHost } from "../src/index.js";

async function fixture(t: test.TestContext) {
  const store = new InMemoryKernelStore();
  const host = await createAgentOsHost({ store,
    secretStore: { async save() { throw new Error("unused"); }, async read() { throw new Error("unused"); } } });
  t.after(() => host.close());
  const workspace = await host.kernel.createWorkspace("local", "local-owner", "workspace", {
    name: "对象导航", viewMode: "business", pluginIds: ["opc", "coding"],
  });
  const capture = await host.dispatch(new Request("http://host.test/v2/plugins/opc/opportunities", {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "capture" },
    body: JSON.stringify({ workspaceId: workspace.id, expectedStreamVersion: 0, input: "验证咖啡店会员工具" }),
  }));
  assert.equal(capture.status, 201);
  const opportunity = (await capture.json()).data;
  const thread = await store.transact("local", tx => tx.listProjections<Thread>("thread")
    .find(item => item.resourceRef?.resourceId === opportunity.id)!);
  assert.ok(thread);
  async function get(path: string) {
    const response = await host.dispatch(new Request(`http://host.test${path}`));
    assert.equal(response.status, 200);
    return (await response.json()).data;
  }
  async function deliverable(id: string, reference: Thread, storedId = reference.id) {
    await store.transact("local", tx => {
      tx.putProjection("thread", storedId, reference);
      const value: Deliverable = { id, tenantId: "local", workspaceId: workspace.id, pluginId: "opc", threadId: storedId,
        kind: "brief", title: "同名成果", summary: "摘要", assetIds: [], streamVersion: 1,
        createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z" };
      tx.putProjection("deliverable", id, value);
    });
  }
  async function collections() {
    const home = await get(`/v2/workspaces/${workspace.id}/home`);
    return [home.recentDeliverables, await get(`/v2/deliverables?workspaceId=${workspace.id}`), await get("/v2/deliverables")];
  }
  return { store, workspace, thread, opportunity, get, deliverable, collections };
}

test("首页机会和研发行动定位到明确对象，成果保留同工作区会话和资源", async t => {
  const f = await fixture(t);
  await f.store.transact("local", tx => tx.putProjection("coding.task", "coding-task", createCodingTask({
    id: "coding-task", workspaceId: f.workspace.id, repositoryId: "repository", title: "同名成果", request: "实现会员工具",
    createdAt: "2026-10-10T00:00:00.000Z",
  })));
  await f.deliverable("valid", f.thread);
  await f.deliverable("general", { ...f.thread, id: "general-thread", resourceRef: undefined });
  const home = await f.get(`/v2/workspaces/${f.workspace.id}/home`);
  assert.deepEqual(home.todayActions.find((item: any) => item.id === f.opportunity.id).navigation,
    { pluginId: "opc", resourceRef: { namespace: "opc.opportunity", resourceId: f.opportunity.id } });
  assert.deepEqual(home.todayActions.find((item: any) => item.id === "coding-task").navigation,
    { pluginId: "coding", resourceRef: { namespace: "coding.task", resourceId: "coding-task" } });
  for (const items of await f.collections()) {
    assert.deepEqual(items.find((item: any) => item.id === "valid").navigation,
      { pluginId: "opc", threadId: f.thread.id, resourceRef: f.thread.resourceRef });
    assert.deepEqual(items.find((item: any) => item.id === "general").navigation,
      { pluginId: "opc", threadId: "general-thread" });
    assert.equal(items.find((item: any) => item.id === "valid").outcome, "摘要");
  }
});

test("成果的缺失、跨工作区、跨租户、插件不符和身份损坏会话均不提供导航", async t => {
  const f = await fixture(t);
  const invalid: Thread[] = [
    { ...f.thread, id: "foreign-workspace", workspaceId: "other" },
    { ...f.thread, id: "foreign-tenant", tenantId: "other" },
    { ...f.thread, id: "foreign-plugin", pluginId: "coding" },
    { ...f.thread, id: "wrong-identity" },
    { ...f.thread, id: "missing-thread" },
  ];
  for (const thread of invalid) await f.deliverable(thread.id, thread, thread.id === "wrong-identity" ? "stored-elsewhere" : thread.id);
  await f.store.transact("local", tx => tx.deleteProjection("thread", "missing-thread"));
  for (const items of await f.collections()) {
    assert.equal(items.length, invalid.length);
    for (const item of items) assert.equal(item.navigation, undefined, item.id);
  }
});

test("成果会话的资源不存在、跨工作区、跨租户或身份不符时不提供导航", async t => {
  const f = await fixture(t);
  const resources = [
    { id: "foreign-resource", workspaceId: "other" },
    { id: "foreign-tenant-resource", workspaceId: f.workspace.id, tenantId: "other" },
    { id: "wrong-resource-identity", workspaceId: f.workspace.id },
  ];
  await f.store.transact("local", tx => {
    for (const resource of resources) tx.putProjection("opc.opportunity", resource.id, {
      ...f.opportunity, ...resource, ...(resource.id === "wrong-resource-identity" ? { id: "different-resource" } : {}),
    });
  });
  for (const resourceId of ["missing-resource", ...resources.map(item => item.id)]) {
    await f.deliverable(resourceId, { ...f.thread, id: `thread-${resourceId}`,
      resourceRef: { namespace: "opc.opportunity", resourceId } });
  }
  for (const items of await f.collections()) {
    assert.equal(items.length, 4);
    for (const item of items) assert.equal(item.navigation, undefined, item.id);
  }
});
