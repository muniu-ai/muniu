// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { assertCommittedSseEvents } from "../enterprise-host-flow.mjs";

test("恢复检查比较已提交事实，不把租户游标误当成工作区可见事件", () => {
  const event = { id: "event-one", position: 1, digest: "digest", hmac: "hmac" };
  const state = { cursor: 2, committedEvents: [event] };
  const frames = value => `id: 1\nevent: kernel\ndata: ${JSON.stringify(value)}\n\nid: 7\nevent: cursor\ndata: {"position":7}\n\n`;
  assert.doesNotThrow(() => assertCommittedSseEvents(state, frames(event)));
  assert.throws(() => assertCommittedSseEvents(state, frames({ ...event, digest: "tampered" })));
  assert.throws(() => assertCommittedSseEvents(state, "id: 7\nevent: cursor\ndata: {\"position\":7}\n\n"));
  assert.throws(() => assertCommittedSseEvents(state, frames(event).replace("id: 7", "id: 1")));
});

test('企业部署入口在启动依赖之前通过 Node 语法检查', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  for (const file of ['enterprise-host.mjs', 'enterprise-worker.mjs', 'migrate-v2.mjs', 'enterprise-platform-host.mjs']) {
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(`../${file}`, import.meta.url))], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});
