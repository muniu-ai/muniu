// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { goalMutationSchema } from "../src/goal-api-schema.js";
import type { JsonObject } from "../src/json.js";

function accepts(schema: JsonObject, value: unknown): boolean {
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(branch => accepts(branch as JsonObject, value)).length !== 1) return false;
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) return false;
  if (schema.type === "string") return typeof value === "string" && value.length >= Number(schema.minLength ?? 0);
  if (schema.type === "integer") return Number.isSafeInteger(value) && (value as number) >= Number(schema.minimum ?? 0);
  if (schema.type !== "object") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>, properties = schema.properties as Record<string, JsonObject>;
  return !(schema.required as string[]).some(key => !Object.hasOwn(object, key))
    && Object.keys(object).every(key => properties[key] ? accepts(properties[key], object[key]) : schema.additionalProperties !== false);
}
test("plan request selects exactly one existing single path or an explicit versioned team", () => {
  const schema = goalMutationSchema("proposeGoalPlan")!;
  const base = { workspaceId: "workspace", expectedStreamVersion: 1 };
  const single = { ...base, modelBindingId: "model" };
  const scheduled = { ...base, scheduling: { runnerId: "auto", strategy: "quality" } };
  const team = { ...single, kind: "team-v1", templateId: "research-summary", templateVersion: "1" };
  for (const body of [single, scheduled, team]) assert.ok(accepts(schema, body));
  for (const body of [base, { ...single, ...scheduled }, { ...team, kind: undefined }, { ...team, kind: "team-v2" },
    { ...team, templateVersion: "2" }, { ...team, templateId: "arbitrary" }, { ...team, scheduling: scheduled.scheduling },
    { ...single, templateId: "research-summary" }, { ...team, modelBindingId: undefined }]) assert.equal(accepts(schema, body), false);
  assert.equal((schema.oneOf as JsonObject[]).length, 3);
  for (const branch of schema.oneOf as JsonObject[]) assert.equal(branch.type, "object", "client generator requires complete branches");
});
