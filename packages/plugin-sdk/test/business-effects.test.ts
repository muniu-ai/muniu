// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { defineBusinessEffectToolV1 } from "../src/business-effects.js";

test("业务副作用工具只提供准备阶段，不接受自定义执行器", async () => {
  const prepare = async () => ({ schemaVersion: "1" as const, action: "issueQuotePackage" as const,
    actionId: "action-a", operationKey: "operation-a",
    scope: { tenantId: "tenant-a", workspaceId: "workspace-a", principalId: "person-a", customerId: "customer-a" },
    quote: { id: "quote-a", version: "1", digest: "a".repeat(64) },
    businessDecision: { id: "decision-a", digest: "b".repeat(64) },
    template: { id: "template-a", version: "1", digest: "c".repeat(64) }, renderVersion: "1", exportFormat: "pdf" as const, issueDate: "2026-09-18" });
  const definition = { id: "sales.issue-quote", version: "1", action: "issueQuotePackage" as const,
    effectClass: "external_side_effect" as const, prepare };
  const tool = defineBusinessEffectToolV1(definition);
  assert.equal(Object.isFrozen(tool), true);
  assert.equal("execute" in tool, false);
  const scope = (await prepare()).scope;
  assert.deepEqual(await tool.prepare({}, { scope, signal: new AbortController().signal }), await prepare());
  assert.throws(() => defineBusinessEffectToolV1({ ...definition, execute: async () => ({}) } as never));
  const invalid = defineBusinessEffectToolV1({ ...definition, prepare: async () => ({ ...await prepare(), workerId: "forged" }) });
  await assert.rejects(invalid.prepare({}, { scope, signal: new AbortController().signal }));
  const crossScope = defineBusinessEffectToolV1({ ...definition,
    prepare: async () => ({ ...await prepare(), scope: { ...scope, customerId: "another-customer" } }) });
  await assert.rejects(crossScope.prepare({}, { scope, signal: new AbortController().signal }), /调用范围/u);
  await assert.rejects(tool.prepare({}, { scope, signal: AbortSignal.abort("cancelled") }));
});
