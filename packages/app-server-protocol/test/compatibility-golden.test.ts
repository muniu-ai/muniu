// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

import { CLIENT_METHODS, METHOD_SCHEMAS } from "../src/index.js";

interface Shape {
  properties: string[];
  required: string[];
}

interface Golden {
  baselineCommit: string;
  sourceSchemaSha256: string;
  methods: Record<string, { params: Shape; result: Shape }>;
}

function topLevelShape(schema: ZodTypeAny): Shape {
  const converted = zodToJsonSchema(schema, { name: "Root", target: "jsonSchema7" }) as {
    definitions?: { Root?: { properties?: Record<string, unknown>; required?: string[] } };
  };
  const root = converted.definitions?.Root;
  return {
    properties: Object.keys(root?.properties ?? {}).sort(),
    required: [...(root?.required ?? [])].sort()
  };
}

const golden = JSON.parse(
  readFileSync(new URL("../../schema/codex-core-stable-shapes.json", import.meta.url), "utf8")
) as Golden;

test("matches the fixed Codex stable top-level method shapes", () => {
  assert.equal(golden.baselineCommit, "99660ab3c7b861c916e467581fa9b8723504d66b");
  assert.equal(golden.sourceSchemaSha256, "f7f448fce148b1ad47d5d7ea3d05a56f14c21a2b7dc64580966b56cc97389514");
  assert.deepEqual(Object.keys(golden.methods), [...CLIENT_METHODS]);

  for (const method of CLIENT_METHODS) {
    assert.deepEqual(topLevelShape(METHOD_SCHEMAS[method].params), golden.methods[method]?.params, `${method} params`);
    assert.deepEqual(topLevelShape(METHOD_SCHEMAS[method].result), golden.methods[method]?.result, `${method} result`);
  }
});
