// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCas, InMemoryKeyProvider, SqliteStorage, replayProjectionJournal } from "@mn/storage";
import { replayCoreProjections } from "@mn/kernel";
import { captureOpportunity, captureCodingRepository, captureCodingTask, createAgentOsHost, exportOpcOpportunity,
  listOpportunitySummaries, listCodingTaskSummaries } from "../src/index.js";

test("Host product capture and deliverables can be rebuilt without source projections", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-host-product-replay-"));
  const hmacKey = Buffer.alloc(32, 17);
  const cas = new FileCas({ rootDir: join(root, "cas") });
  const keyProvider = new InMemoryKeyProvider(Buffer.alloc(32, 18));
  const store = new SqliteStorage({ databaseFile: join(root, "source.sqlite"), hmacKey });
  const target = new SqliteStorage({ databaseFile: join(root, "target.sqlite"), hmacKey });
  const host = await createAgentOsHost({ store, cas, protectedPayloadKeyProvider: keyProvider,
    secretStore: { async save() { throw new Error("fixture must not use models"); }, async read() { throw new Error("fixture must not use models"); } } });
  try {
    const workspace = await host.kernel.createWorkspace("local", "local-owner", "workspace", {
      name: "研究", viewMode: "business", pluginIds: ["opc", "coding"],
    });
    const options = { store, tenantId: "local", workspaceId: workspace.id, actorId: "local-owner",
      now: () => new Date().toISOString(), id: (kind: string) => `${kind}-${randomUUID()}`,
      expectedStreamVersion: 0, idempotencyKey: "capture", input: "帮助独立咨询师整理访谈反证" };
    const opportunity = await captureOpportunity(options);
    await exportOpcOpportunity({ ...options, idempotencyKey: "export", opportunityId: opportunity.id, expectedStreamVersion: 1 });
    await captureCodingRepository({ ...options, idempotencyKey: "repo", input: "/fixture/repository" });
    await captureCodingTask({ ...options, idempotencyKey: "task", input: "修复异常恢复，保留已提交事实" });
    const events = (await store.readEvents("local", 0, 1000)).events;
    assert.ok(events.some(event => event.type === "projection.fact_committed"), "Host must enable product fact persistence");
    const products = await replayProjectionJournal({ cas, keyProvider, namespaces: ["*non-core"],
      events, tenantId: "local", hmacKey });
    const core = replayCoreProjections(events, "local", hmacKey);
    await target.transact("local", tx => {
      for (const fact of [...core.records, ...products]) {
        if (fact.value !== null) tx.putProjection(fact.namespace, fact.id, fact.value);
      }
    });
    assert.deepEqual(await listOpportunitySummaries(target, "local", workspace.id), await listOpportunitySummaries(store, "local", workspace.id));
    assert.deepEqual(await listCodingTaskSummaries(target, "local", workspace.id), await listCodingTaskSummaries(store, "local", workspace.id));
    for (const namespace of ["opc.events", "opc.opportunity", "coding.repository", "coding.task", "deliverable"]) {
      assert.deepEqual(await target.transact("local", tx => tx.listProjections(namespace)),
        await store.transact("local", tx => tx.listProjections(namespace)), namespace);
    }
  } finally {
    await host.close();
    await target.close();
    rmSync(root, { recursive: true, force: true });
  }
});
