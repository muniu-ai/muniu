// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCas, InMemoryKeyProvider, SqliteStorage, readProtectedJson, type WrappedDataKey } from "@mn/storage";
import { createAgentOsHost } from "../src/index.js";

function request(path: string, body: unknown, key: string, method = "POST") {
  return new Request(`http://host.test${path}`, { method, headers: {
    "content-type": "application/json", "Idempotency-Key": key,
  }, body: JSON.stringify(body) });
}
async function data(response: Response): Promise<any> {
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return (body as any).data;
}

for (const unknown of [false, true]) test(`Memory deletion confirms external key erasure (unknown=${unknown})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-host-erasure-"));
  const store = new SqliteStorage({ databaseFile: join(root, "kernel.sqlite"), hmacKey: Buffer.alloc(32, 22) });
  const cas = new FileCas({ rootDir: join(root, "cas") });
  let attempts = 0;
  class Provider extends InMemoryKeyProvider {
    override async revokeKey(key: WrappedDataKey) {
      if (++attempts === 1 && unknown) throw new Error("fixture lost response");
      await super.revokeKey(key);
    }
  }
  const keyProvider = new Provider(Buffer.alloc(32, 23));
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider,
    secretStore: { async save() { throw new Error("fixture"); }, async read() { throw new Error("fixture"); } } });
  try {
    const workspace = await data(await host.dispatch(request("/v2/workspaces", {
      name: "删除核对", viewMode: "business", pluginIds: ["opc"],
    }, "workspace")));
    const memory = await data(await host.dispatch(request("/v2/memories", {
      workspaceId: workspace.id, scopeType: "workspace", namespace: "opc", resourceId: workspace.id,
      sourceEventId: "fixture-source", confidence: 0.5, value: { summary: "backup must not restore deleted content" },
    }, "create")));
    const saved = await store.transact("local", tx => {
      const row = tx.getProjection<any>("memory", memory.id);
      return { ref: row.protectedPayloadRef, keyRecord: tx.getProjection<any>("protectedPayloadKey", row.protectedPayloadRef) };
    });
    const deletion = () => host.dispatch(request(`/v2/memories/${memory.id}`, {
      expectedStreamVersion: memory.streamVersion, reason: "用户删除",
    }, "delete", "DELETE"));
    const response = await deletion();
    assert.equal(attempts, 1, "Host must revoke the external wrapping key before acknowledging deletion");
    if (unknown) {
      assert.equal(response.ok, false);
      assert.equal((await response.json() as any).code, "KEY_REVOCATION_PENDING");
      assert.equal((await deletion()).ok, false);
      assert.equal(attempts, 1, "the same request cannot replay an unknown external deletion");
      const inbox = await data(await host.dispatch(new Request(`http://host.test/v2/inbox?workspaceId=${workspace.id}`)));
      const item = inbox.find((entry: any) => entry.revocationId === saved.ref);
      assert.ok(item, "manual reconciliation remains actionable after the memory is tombstoned");
      const retry = request(`/v2/key-revocations/${item.revocationId}/decisions`, {
        expectedStreamVersion: item.streamVersion, decision: "retry",
      }, "explicit-human-retry");
      const result = await data(await host.dispatch(retry.clone()));
      assert.equal(result.status, "completed");
      assert.equal((await data(await host.dispatch(retry))).status, "completed");
      assert.equal(attempts, 2);
    } else assert.equal((await data(response)).status, "deleted");
    await assert.rejects(readProtectedJson({ tenantId: "local", workspaceId: workspace.id, ownerType: "memory",
      ownerId: memory.id, protectedPayloadRef: saved.ref, keyRecord: saved.keyRecord, cas, keyProvider }), /revoked/i);
    const events = (await store.readEvents("local", 0, 1000)).events;
    assert.equal(JSON.stringify(events).includes(saved.keyRecord.wrappedKey.ciphertext), false);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
