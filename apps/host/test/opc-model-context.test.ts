import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryKernelStore } from "@mn/kernel";
import { createOpcModelContextReader } from "../src/opc-model-context.js";

test("OPC 模型上下文包含当前对象证据，只读取同租户同工作区机会", async () => {
  const store = new InMemoryKernelStore();
  await store.transact("tenant-a", (transaction) => transaction.putProjection("opc.opportunity", "opportunity", {
    id: "opportunity", workspaceId: "workspace-a", signals: [{ sourceKind: "manual", summary: "反证：客户已有免费替代方案", relationship: "oppose" }], interviews: [],
  }));
  const reader = createOpcModelContextReader({ store });
  const thread = { tenantId: "tenant-a", workspaceId: "workspace-a", pluginId: "opc", resourceRef: { namespace: "opc.opportunity", resourceId: "opportunity" } } as any;
  assert.match(await reader(thread) ?? "", /客户已有免费替代方案/u);
  await assert.rejects(reader({ ...thread, workspaceId: "workspace-b" }));
  await assert.rejects(reader({ ...thread, tenantId: "tenant-b" }));
  assert.equal(await reader({ ...thread, pluginId: "coding" }), undefined);
});
