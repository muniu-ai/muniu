import assert from "node:assert/strict";
import test from "node:test";

import {
  KernelProjectionRuntimeStore,
  type RuntimeProjectionStore,
  type RuntimeProjectionTransaction,
} from "../src/index.js";

class SharedProjectionStore implements RuntimeProjectionStore {
  readonly values = new Map<string, unknown>();

  async transact<T>(tenantId: string, work: (transaction: RuntimeProjectionTransaction) => T): Promise<T> {
    return work({
      getProjection: <Value>(namespace: string, id: string) =>
        structuredClone(this.values.get(`${tenantId}:${namespace}:${id}`)) as Value | undefined,
      putProjection: <Value>(namespace: string, id: string, value: Value) => {
        this.values.set(`${tenantId}:${namespace}:${id}`, structuredClone(value));
      },
    });
  }
}

test("KernelStore 投影 RuntimeStore 跨实例恢复且保持租户隔离", async () => {
  const backing = new SharedProjectionStore();
  const first = new KernelProjectionRuntimeStore({
    tenantId: "tenant-a",
    store: backing,
    now: () => "2026-09-04T00:00:00.000Z",
    id: (sequence) => `record-${sequence}`,
  });
  await first.append({ executionId: "execution-1", type: "execution/status", payload: { status: "running" } });
  await first.append({ executionId: "execution-1", type: "session/entry", payload: { content: "已持久化" } });

  const recovered = new KernelProjectionRuntimeStore({ tenantId: "tenant-a", store: backing });
  assert.deepEqual((await recovered.readExecution("execution-1")).map((record) => record.sequence), [1, 2]);
  assert.equal((await recovered.readExecution("execution-1"))[1]?.payload.content, "已持久化");

  const otherTenant = new KernelProjectionRuntimeStore({ tenantId: "tenant-b", store: backing });
  assert.deepEqual(await otherTenant.readExecution("execution-1"), []);
});
