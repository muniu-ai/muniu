// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryKernelStore } from "@mn/kernel";
import { createAgentOsHost } from "../src/index.js";

test("Coding 任务明确绑定所选仓库，多仓库不猜测，也不接受跨工作区仓库", async t => {
  const host = await createAgentOsHost({ store: new InMemoryKernelStore(), secretStore: {
    async save(id) { return `keychain://muniu.v2/${id}`; }, async read() { throw new Error("no model calls"); },
  } });
  t.after(() => host.close());
  let sequence = 0;
  const post = (path: string, body: unknown, key = `request-${++sequence}`) => host.dispatch(new Request(`http://host.test${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
  }));
  const success = async (response: Response) => { assert.ok(response.ok, await response.clone().text()); return (await response.json()).data; };
  const workspace = await success(await post("/v2/workspaces", { name: "多个仓库", viewMode: "business", pluginIds: ["coding", "opc"] }));
  const other = await success(await post("/v2/workspaces", { name: "其他工作区", viewMode: "business", pluginIds: ["coding"] }));
  const taskInput = { workspaceId: workspace.id, expectedStreamVersion: 0, input: "修复请求校验" };
  for (const path of ["opc/repositories", "opc/tasks", "coding/opportunities"]) {
    assert.equal((await post(`/v2/plugins/${path}`, taskInput)).status, 404);
  }
  assert.deepEqual(await success(await host.dispatch(new Request(`http://host.test/v2/plugins/opc/opportunities?workspaceId=${workspace.id}`))), []);
  assert.equal((await post("/v2/plugins/coding/tasks", taskInput)).status, 422);
  const first = await success(await post("/v2/plugins/coding/repositories", { workspaceId: workspace.id, expectedStreamVersion: 0, input: "/work/first" }));
  const second = await success(await post("/v2/plugins/coding/repositories", { workspaceId: workspace.id, expectedStreamVersion: 0, input: "/work/second" }));
  const foreign = await success(await post("/v2/plugins/coding/repositories", { workspaceId: other.id, expectedStreamVersion: 0, input: "/work/foreign" }));
  const listed = await success(await host.dispatch(new Request(`http://host.test/v2/plugins/coding/repositories?workspaceId=${workspace.id}`)));
  assert.deepEqual(new Set(listed.map((repo: { id: string }) => repo.id)), new Set([first.id, second.id]));
  assert.equal((await post("/v2/plugins/coding/tasks", taskInput)).status, 422);
  const selected = { ...taskInput, repositoryId: second.id };
  assert.equal((await post("/v2/plugins/coding/tasks", { ...selected, toolAuthority: "unsafe" })).status, 422);
  const task = await success(await post("/v2/plugins/coding/tasks", selected, "chosen-repository"));
  assert.equal(task.repositoryId, second.id);
  assert.deepEqual(await success(await post("/v2/plugins/coding/tasks", selected, "chosen-repository")), task);
  assert.equal((await post("/v2/plugins/coding/tasks", { ...selected, repositoryId: first.id }, "chosen-repository")).status, 409);
  assert.equal((await post("/v2/plugins/coding/tasks", { ...selected, repositoryId: foreign.id })).status, 404);
});
