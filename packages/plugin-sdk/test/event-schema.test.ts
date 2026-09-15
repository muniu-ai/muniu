// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "@mn/contracts";
import { assertPluginEventPayload, assertPluginEventSchema } from "../src/index.js";

test("事件结构校验拒绝未声明字段、错误类型、远程引用和未知关键字", () => {
  const schema = { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 20 },
    rating: { type: "integer", minimum: 0, maximum: 5 }, tags: { type: "array", items: { type: "string" }, maxItems: 2 } }, required: ["title"], additionalProperties: false };
  assert.doesNotThrow(() => assertPluginEventPayload(schema, { title: "原始证据", rating: 3, tags: ["interview"] }));
  const invalidPayloads: JsonObject[] = [{ title: 3 }, { title: "" }, { title: "有效", unknown: true }, { title: "有效", rating: 6 },
    { title: "有效", rating: 1.5 }, { title: "有效", tags: ["one", "two", "three"] }];
  for (const payload of invalidPayloads) assert.throws(() => assertPluginEventPayload(schema, payload));
  const invalidSchemas: JsonObject[] = [{ $ref: "https://example/schema" }, { pattern: "(a+)+" }, { type: "madeup" }, { required: [3] },
    { minimum: "0" }, { type: "object", properties: { child: { unknown: true } } }];
  for (const shape of invalidSchemas) assert.throws(() => assertPluginEventSchema(shape));
});

test("事件结构支持有界组合规则、枚举和常量，拒绝超大内容", () => {
  const schema: JsonObject = { type: "object", required: ["outcome"], properties: { outcome: { anyOf: [{ const: "stop" }, { type: "integer", minimum: 1 }] },
    currency: { enum: ["CNY", "USD"] } }, additionalProperties: false };
  assert.doesNotThrow(() => assertPluginEventPayload(schema, { outcome: "stop", currency: "CNY" }));
  assert.doesNotThrow(() => assertPluginEventPayload(schema, { outcome: 1 }));
  assert.throws(() => assertPluginEventPayload(schema, { outcome: "pursue" }));
  assert.throws(() => assertPluginEventPayload({}, { title: "x".repeat(1024 * 1024) }));
  assert.throws(() => assertPluginEventPayload({ properties: { value: { oneOf: [{ type: "integer" }, { minimum: 1 }] } } }, { value: 2 }));
});
