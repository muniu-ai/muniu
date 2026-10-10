// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundled = await build({ entryPoints: [new URL("../../src/api.ts", import.meta.url).pathname], bundle: true,
  platform: "browser", format: "esm", write: false, define: { "import.meta.env.VITE_MN_API_URL": '"http://host.test"' } });
const { AgentOsClient } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

class FakeSource extends EventTarget {
  static instances = [];
  closed = false;
  constructor(url) { super(); this.url = url; FakeSource.instances.push(this); }
  close() { this.closed = true; }
  emit(type, position) { this.dispatchEvent(new MessageEvent(type, { lastEventId: String(position ?? "") })); }
}

test("同一工作区共享事件连接，最后一个订阅释放连接", () => {
  const original = globalThis.EventSource;
  globalThis.EventSource = FakeSource; FakeSource.instances = [];
  const api = new AgentOsClient("http://host.test");
  let first = 0, second = 0;
  const stopFirst = api.watchWorkspaceEvents("workspace", () => first++);
  const stopSecond = api.watchWorkspaceEvents("workspace", () => second++);
  try {
    assert.equal(FakeSource.instances.length, 1);
    const source = FakeSource.instances[0];
    source.emit("kernel", 1);
    assert.equal(first, 1); assert.equal(second, 1);
    stopFirst(); source.emit("kernel", 2);
    assert.equal(first, 1); assert.equal(second, 2); assert.equal(source.closed, false);
    stopSecond(); assert.equal(source.closed, true);
  } finally { stopFirst(); stopSecond(); globalThis.EventSource = original; }
});

test("工作区连接状态明确，断线重连后重新读取状态，已关闭连接不再通知", async () => {
  const original = globalThis.EventSource;
  globalThis.EventSource = FakeSource; FakeSource.instances = [];
  const api = new AgentOsClient("http://host.test"), states = [];
  let changes = 0;
  const stop = api.watchWorkspaceEvents("status", () => changes++, state => states.push(state));
  try {
    assert.deepEqual(states, ["connecting"]);
    FakeSource.instances[0].emit("open");
    assert.equal(states.at(-1), "connected");
    FakeSource.instances[0].emit("error");
    assert.equal(states.at(-1), "disconnected");
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(FakeSource.instances.length, 2);
    const before = changes;
    FakeSource.instances[1].emit("open");
    assert.equal(states.at(-1), "connected"); assert.ok(changes > before);
    stop(); const after = changes;
    FakeSource.instances[1].emit("kernel", 9); assert.equal(changes, after);
  } finally { stop(); globalThis.EventSource = original; }
});

test("工作区连接隔离，重复释放不会影响新的订阅", () => {
  const original = globalThis.EventSource;
  globalThis.EventSource = FakeSource; FakeSource.instances = [];
  const api = new AgentOsClient("http://host.test"); let changes = 0;
  const stopA = api.watchWorkspaceEvents("a", () => changes++);
  const stopB = api.watchWorkspaceEvents("b", () => {});
  stopA(); const nextA = api.watchWorkspaceEvents("a", () => changes++); stopA();
  try {
    assert.equal(FakeSource.instances.length, 3);
    assert.equal(FakeSource.instances[1].closed, false);
    assert.equal(FakeSource.instances[2].closed, false);
    FakeSource.instances[2].emit("kernel", 1); assert.equal(changes, 1);
  } finally { stopB(); nextA(); globalThis.EventSource = original; }
});
