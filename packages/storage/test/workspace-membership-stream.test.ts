// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { KernelEventV1, WorkspaceMembership } from "@mn/contracts";
import { AgentOsKernel, type KernelStore } from "@mn/kernel";
import { SqliteStorage } from "../src/index.js";

async function fixture(t: TestContext, originalFormat: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "muniu-membership-stream-"));
  const store = new SqliteStorage({ databaseFile: join(directory, "state.sqlite"), hmacKey: Buffer.alloc(32, 1) });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const creationStore: KernelStore = {
    readEvents: (...args) => store.readEvents(...args),
    transact: (tenantId, work) => store.transact(tenantId, tx => {
      let previous: KernelEventV1;
      return work({ ...tx, appendEvent: request => {
        if (originalFormat && request.aggregateType === "workspaceMembership") return previous;
        previous = tx.appendEvent(request);
        return previous;
      } });
    }),
  };
  const workspace = await new AgentOsKernel(creationStore).createWorkspace("local", "owner", "create", {
    name: "成员流测试", viewMode: "professional", pluginIds: [],
  });
  const kernel = new AgentOsKernel(store);
  await kernel.setWorkspaceMembership("local", "owner", "second-owner", workspace.id, "admin", 0, "owner");
  return { store, kernel, workspace };
}

for (const originalFormat of [false, true]) for (const operation of ["remove", "downgrade"] as const) {
  test(`${originalFormat ? "当前0.2初始格式" : "新工作区"}所有者可${operation === "remove" ? "移除" : "降级"}且成员事件版本连续`, async t => {
    const { store, kernel, workspace } = await fixture(t, originalFormat);
    const updated = operation === "remove"
      ? await kernel.removeWorkspaceMembership("local", "admin", "change", workspace.id, "owner", 1)
      : await kernel.setWorkspaceMembership("local", "admin", "change", workspace.id, "owner", 1, "viewer");
    assert.equal(updated.streamVersion, 2);
    const events = (await store.readEvents("local", 0, 100)).events
      .filter(event => event.aggregateType === "workspaceMembership" && event.aggregateId === `${workspace.id}:owner`);
    assert.deepEqual(events.map(event => event.streamVersion), [1, 2]);
    assert.equal(events[0]?.type, "workspace_membership.created");
    assert.equal((await kernel.listWorkspaceMemberships("local", workspace.id)).some(member => member.principalId === "admin"), true);
  });
}

test("当前0.2初始成员流修复不接受过期版本或与认证事实不符的缓存", async t => {
  const { store, kernel, workspace } = await fixture(t, true);
  const before = (await store.readEvents("local", 0, 100)).events.length;
  await assert.rejects(kernel.removeWorkspaceMembership("local", "admin", "stale", workspace.id, "owner", 0),
    { code: "STREAM_VERSION_CONFLICT" });
  await store.transact("local", tx => {
    const member = tx.getProjection<WorkspaceMembership>("membership", `${workspace.id}:owner`)!;
    tx.putProjection("membership", member.id, { ...member, workspaceRole: "operator" });
  });
  await assert.rejects(kernel.removeWorkspaceMembership("local", "admin", "altered", workspace.id, "owner", 1),
    { code: "STREAM_VERSION_CONFLICT" });
  assert.equal((await store.readEvents("local", 0, 100)).events.length, before);
});
