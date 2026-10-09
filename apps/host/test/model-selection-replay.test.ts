// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { replayCoreProjections } from "@mn/kernel";
import { createAgentOsHost } from "../src/index.js";

const post = (path: string, body: unknown, key: string) => new Request(`http://host.test${path}`, {
  method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
});

test("模型选择写入可重放事实，重启和删除投影后仍能恢复默认模型及幂等回执", async () => {
  const root = await mkdtemp(join(tmpdir(), "muniu-model-selection-replay-"));
  const databaseFile = join(root, "kernel.sqlite");
  const hmacKey = Buffer.alloc(32, 37);
  const options = {
    cas: new FileCas({ rootDir: join(root, "cas") }),
    protectedPayloadKeyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 38)),
    secretStore: { async save() { return "keychain://muniu.v2/private-model-reference"; }, async read() { return "private-test-key"; } },
    modelProbe: async () => ({ models: ["deepseek-v4-flash", "deepseek-v4-pro"], defaultModel: "deepseek-v4-flash" }),
  };
  let store = new SqliteStorage({ databaseFile, hmacKey });
  let host = await createAgentOsHost({ ...options, store });
  try {
    const pendingResponse = await host.dispatch(post("/v2/model-connections", { presetId: "deepseek", apiKey: "private-test-key" }, "create"));
    assert.equal(pendingResponse.status, 201);
    const pending = (await pendingResponse.json()).data;
    const probeResponse = await host.dispatch(post(`/v2/model-connections/${pending.id}/probe`, {
      expectedStreamVersion: pending.streamVersion, makeDefault: true,
    }, "probe"));
    assert.equal(probeResponse.status, 200);
    const current = (await probeResponse.json()).data;
    const route = `/v2/model-connections/${current.id}/model`;
    const input = { expectedStreamVersion: current.streamVersion, modelName: "deepseek-v4-pro" };
    const selectedResponse = await host.dispatch(post(route, input, "select"));
    assert.equal(selectedResponse.status, 200);
    const selected = (await selectedResponse.json()).data;
    const events = (await store.readEvents("local", 0, 1000)).events;
    assert.doesNotThrow(() => replayCoreProjections(events, "local", hmacKey));
    await host.close();
    store = new SqliteStorage({ databaseFile, hmacKey });
    host = await createAgentOsHost({ ...options, store });
    const raw = new DatabaseSync(databaseFile);
    try {
      for (const table of ["events", "projections", "idempotency", "outbox"]) {
        assert.doesNotMatch(JSON.stringify(raw.prepare(`select * from ${table}`).all()), /private-test-key|private-model-reference/u);
      }
      raw.exec("delete from projections; delete from idempotency");
      await store.rebuildProjections("local");
    } finally { raw.close(); }
    const connections = (await (await host.dispatch(new Request("http://host.test/v2/model-connections"))).json()).data;
    assert.equal(connections.find((value: any) => value.id === selected.id).defaultForNewExecutions, true);
    assert.equal(connections.find((value: any) => value.id === current.id).defaultModel, "deepseek-v4-flash");
    const replay = await host.dispatch(post(route, input, "select"));
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).data, selected);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
