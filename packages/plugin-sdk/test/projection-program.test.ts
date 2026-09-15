// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectionProgram, reducePluginProjection, type PluginDomainEventV1 } from "../src/index.js";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const event = (patch: Partial<PluginDomainEventV1> = {}): PluginDomainEventV1 => ({
  id: "event-1", tenantId: "tenant", workspaceId: "workspace", resourceId: "record", streamVersion: 1,
  position: 1, type: "research.created", payload: { title: "证据", detail: { verified: false } }, ...patch,
});

test("声明式投影按事件重放，支持字段映射、默认值、修正与删除", () => {
  const program = parseProjectionProgram(bytes({ schemaVersion: 1,
    rules: [
      { eventType: "research.created", operation: "replace", fields: { name: "/title", verified: "/detail/verified" }, defaults: { status: "pending" } },
      { eventType: "research.corrected", operation: "merge" },
      { eventType: "research.deleted", operation: "delete" },
    ], requiredFields: ["name", "verified", "status"],
  }));
  const first = reducePluginProjection(program, undefined, event());
  assert.deepEqual(first?.value, { name: "证据", verified: false, status: "pending" });
  assert.equal(first?.workspaceId, "workspace");
  const changed = reducePluginProjection(program, first, event({ type: "research.corrected", id: "event-2", position: 2,
    streamVersion: 2, payload: { status: "reviewed" } }));
  assert.deepEqual(changed?.value, { name: "证据", verified: false, status: "reviewed" });
  assert.equal(first?.value.status, "pending");
  assert.equal(reducePluginProjection(program, changed, event({ type: "research.deleted", position: 3, streamVersion: 3 })), undefined);
});

test("投影不能混入其他租户或工作区，也不能跳过已声明的输出校验", () => {
  const program = parseProjectionProgram(bytes({ schemaVersion: 1,
    rules: [{ eventType: "research.created", operation: "replace" }], requiredFields: ["title"] }));
  const first = reducePluginProjection(program, undefined, event());
  assert.throws(() => reducePluginProjection(program, first, event({ tenantId: "other", position: 2, streamVersion: 2 })), /范围/u);
  assert.throws(() => reducePluginProjection(program, first, event({ workspaceId: "other", position: 2, streamVersion: 2 })), /范围/u);
  assert.throws(() => reducePluginProjection(program, undefined, event({ payload: {} })), /title/u);
  assert.throws(() => reducePluginProjection(program, first, event()), /顺序/u);
});

test("投影定义拒绝代码、路径原型访问、重复事件与未知语法", () => {
  const rule = { eventType: "research.created", operation: "replace" };
  for (const program of [
    { schemaVersion: 1, rules: [rule], script: "process.exit()" },
    { schemaVersion: 1, rules: [{ ...rule, fields: { title: "/__proto__/secret" } }] },
    { schemaVersion: 1, rules: [rule, rule] },
    { schemaVersion: 2, rules: [rule] },
    { schemaVersion: 1, rules: [{ ...rule, operation: "execute" }] },
  ]) assert.throws(() => parseProjectionProgram(bytes(program)));
  assert.throws(() => parseProjectionProgram(Buffer.from("export default () => {}")));
});
