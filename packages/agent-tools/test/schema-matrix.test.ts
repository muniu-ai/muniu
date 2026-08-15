import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonSchemaError,
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  defineTool,
  validateJsonSchemaValue,
  type JsonSchemaNode
} from "../src/index.js";

test("schema boundary rejects malformed nodes, annotations, and misplaced constraints", () => {
  const circular: Record<string, unknown> = { type: "array" };
  circular.items = circular;
  const invalid: unknown[] = [
    null,
    circular,
    { type: "string", default: undefined },
    { type: "string", description: 1 },
    { type: "string", title: false },
    { type: "string", examples: 1n },
    { type: "string", oneOf: [{ type: "string" }, { type: "number" }] },
    { oneOf: [{ type: "string" }] },
    { oneOf: [{ type: "string" }, { type: "number" }], const: "x" },
    { type: ["string", "null"] },
    { properties: {} },
    { type: "object", properties: [] },
    { type: "object", properties: {}, required: [1] },
    { type: "object", properties: {}, required: ["missing"] },
    { type: "object", additionalProperties: "false" },
    { type: "string", properties: {} },
    { type: "string", items: { type: "string" } },
    { type: "array", enum: [] },
    { type: "string", enum: [] },
    { type: "integer", const: 1.5 }
  ];
  for (const schema of invalid) assert.throws(() => assertSupportedJsonSchema(schema), JsonSchemaError);
  assert.throws(() => assertObjectJsonSchema({ type: "string" }), /schema.type/i);
});

test("schema value validator covers exact-one, containers, scalars, enum, and const", () => {
  const oneOf: JsonSchemaNode = { oneOf: [{ type: "string" }, { type: "number" }] };
  assert.deepEqual(validateJsonSchemaValue(oneOf, "ok"), []);
  assert.match(validateJsonSchemaValue(oneOf, true)[0] ?? "", /exactly one/);
  assert.match(validateJsonSchemaValue({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1)[0] ?? "", /exactly one/);

  assert.deepEqual(validateJsonSchemaValue({}, { any: [1, true, null] }), []);
  assert.match(validateJsonSchemaValue({}, 1n)[0] ?? "", /lossless JSON/);

  const object: JsonSchemaNode = {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
    additionalProperties: false
  };
  assert.match(validateJsonSchemaValue(object, null)[0] ?? "", /must be an object/);
  assert.match(validateJsonSchemaValue(object, { count: 1.2 })[0] ?? "", /integer/);
  assert.deepEqual(validateJsonSchemaValue(object, { count: 1 }), []);

  const array: JsonSchemaNode = { type: "array", items: { type: "boolean" } };
  assert.match(validateJsonSchemaValue(array, "no")[0] ?? "", /array/);
  assert.match(validateJsonSchemaValue(array, [true, "no"])[0] ?? "", /boolean/);
  assert.deepEqual(validateJsonSchemaValue({ type: "array" }, [1, "two"]), []);
  const sparse = new Array(2);
  sparse[1] = true;
  assert.match(validateJsonSchemaValue(array, sparse)[0] ?? "", /dense lossless/);

  const cases: Array<[JsonSchemaNode, unknown, unknown, RegExp]> = [
    [{ type: "string", enum: ["a", "b"] }, "a", "c", /one of/],
    [{ type: "number", const: 2 }, 2, 3, /must be 2/],
    [{ type: "integer" }, 2, 2.2, /integer/],
    [{ type: "boolean" }, true, "true", /boolean/],
    [{ type: "null" }, null, false, /null/]
  ];
  for (const [schema, accepted, rejected, pattern] of cases) {
    assert.deepEqual(validateJsonSchemaValue(schema, accepted), []);
    assert.match(validateJsonSchemaValue(schema, rejected)[0] ?? "", pattern);
  }
  assert.match(validateJsonSchemaValue({ type: "number" }, -0)[0] ?? "", /number/);
});

test("defineTool rejects invalid identity and non-object parameter schemas", () => {
  const base = {
    description: "tool",
    risk: "read-only" as const,
    parameters: { type: "object" as const },
    execute: async () => null
  };
  assert.throws(() => defineTool({ ...base, name: "bad name" }), /name/i);
  assert.throws(() => defineTool({ ...base, name: "ok", description: "" }), /description/i);
  assert.throws(() => defineTool({ ...base, name: "ok", parameters: { type: "string" } as never }), /schema.type/i);
});
