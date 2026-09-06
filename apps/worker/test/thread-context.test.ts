// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRuntimeStore, PersistentSessionLog } from "@mn/agent-runtime";
import type { Execution } from "@mn/contracts";
import { InMemoryKernelStore } from "@mn/kernel";
import { readThreadHistory } from "../src/thread-context.js";
import { readExecutionInput } from "../src/runtime-store.js";

test("会话按持久化轮次读取，不受 SSE 游标过期影响，也不跨插件和工作区", async () => {
  const store = new InMemoryKernelStore();
  const runtime = new InMemoryRuntimeStore();
  const execution = { id: "current", tenantId: "local", workspaceId: "workspace",
    threadId: "thread", pluginId: "coding", status: "queued" } as Execution;
  await store.transact("local", tx => {
    for (const [id, version, extra] of [
      ["current", 5, {}], ["second", 2, {}], ["first", 1, {}],
      ["foreign-plugin", 3, { pluginId: "opc" }],
      ["foreign-workspace", 4, { workspaceId: "other" }],
      ["future", 6, {}],
    ] as const) {
      tx.putProjection("session-log-entry", id, { ...execution, executionId: id,
        threadStreamVersion: version, ...extra });
      tx.putProjection("execution", id, { ...execution, id, status: "completed", ...extra });
    }
  });
  for (const id of ["first", "second", "foreign-plugin", "foreign-workspace", "future"]) {
    const session = new PersistentSessionLog(runtime, id);
    await session.append({ role: "user", content: id, turn: 1 });
    await session.append({ role: "assistant", content: `${id} result`, turn: 1 });
  }
  store.readEvents = async () => { throw new Error("EVENT_CURSOR_EXPIRED"); };
  assert.deepEqual((await readThreadHistory(store, runtime, execution)).map(message => message.content),
    ["first", "first result", "second", "second result"]);
});

test("首个模型边界前中断后，恢复 Job 从同一 execution 的已提交轮次取回输入", async () => {
  const store = new InMemoryKernelStore();
  const execution = { id: "current", tenantId: "local", workspaceId: "workspace",
    threadId: "thread", pluginId: "coding" } as Execution;
  await store.transact("local", tx => tx.putProjection("session-log-entry", "turn", {
    ...execution, executionId: execution.id, message: "恢复之前已提交的原始要求",
  }));
  assert.equal(await readExecutionInput({ store, execution, payload: { command: "resume" } }),
    "恢复之前已提交的原始要求");
  await assert.rejects(readExecutionInput({ store,
    execution: { ...execution, workspaceId: "foreign" }, payload: { command: "resume" } }), /持久化.*输入/u);
});
