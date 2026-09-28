// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExecutionAuthority } from "@mn/contracts";
import test from "node:test";
import { FileCas, InMemoryKeyProvider, SqliteStorage, replayProjectionJournal, DEFAULT_PROJECTION_JOURNAL_NAMESPACES } from "@mn/storage";
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
    const products = await replayProjectionJournal({ cas, keyProvider, namespaces: DEFAULT_PROJECTION_JOURNAL_NAMESPACES,
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


test("Host protects core titles and approval text in every durable copy and rebuilds the review content", async () => {
  const root = mkdtempSync(join(tmpdir(), "mn-host-core-privacy-"));
  const databaseFile = join(root, "kernel.sqlite");
  const store = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 25) });
  const host = await createAgentOsHost({ store, cas: new FileCas({ rootDir: join(root, "cas") }),
    protectedPayloadKeyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 26)),
    secretStore: { async save() { throw new Error("no model access"); }, async read() { throw new Error("no model access"); } } });
  const marker = "private-core-business-content-916";
  try {
    const workspace = await host.kernel.createWorkspace("local", "local-owner", "workspace", {
      name: marker, viewMode: "business", pluginIds: ["opc"],
    });
    const threadInput = { workspaceId: workspace.id, subject: marker, pluginId: "opc" };
    const thread = await host.kernel.createThread("local", "local-owner", "thread", threadInput);
    const execution = await host.kernel.createExecution("local", "local-owner", "execution", {
      workspaceId: workspace.id, threadId: thread.id, pluginId: "opc", agentDefinitionId: "fixture", modelBindingId: "fixture",
      executionPrincipalId: "fixture-agent", authority: { workspaceId: workspace.id, principalId: "fixture-agent",
        toolIds: ["fixture.write"], dataScopes: [{ namespace: "fixture", resourceId: "resource" }], autoAllowedEffects: [],
        budget: { maxSubagentDepth: 0, maxSubagents: 0, maxTokens: 100, maxCostMinorUnits: "100", currency: "CNY", maxDurationMs: 60_000 } },
    });
    await host.kernel.commandExecution("local", "local-owner", "start", execution.id, execution.streamVersion, "start");
    const authority = await store.transact("local", tx => tx.getProjection<ExecutionAuthority>("authority", execution.authorityId));
    const response = await host.kernel.requestToolApproval("local", "fixture-agent", "approve", {
      id: "call", executionId: execution.id, generation: 1, toolId: "fixture.write", toolVersion: "1.0.0",
      effectClass: "external_side_effect", intent: marker, normalizedArguments: { content: marker },
      argumentsDigest: "args", resourceRefs: [{ namespace: "fixture", resourceId: "resource" }], resourcesDigest: "resources",
      authorityCommitment: authority!.commitment, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(response.mode, "approval");
    if (response.mode !== "approval") throw new Error("manual approval expected");
    await host.kernel.saveModelConnection("local", "local-owner", "model", {
      presetId: "openai", displayName: marker, secretRef: "keychain://muniu.v2/fixture", defaultModel: "fixture", discoveredModels: [],
    });
    const raw = new DatabaseSync(databaseFile);
    try {
      for (const table of ["events", "projections", "idempotency", "outbox"]) {
        assert.equal(JSON.stringify(raw.prepare(`select * from ${table}`).all()).includes(marker), false, table);
      }
      raw.exec("delete from projections; delete from idempotency");
      await store.rebuildProjections("local");
      assert.equal((await host.kernel.listThreads("local", workspace.id))[0]!.subject, marker);
      assert.equal((await host.kernel.listWorkspaces("local"))[0]!.name, marker);
      assert.equal((await host.kernel.listInbox("local", workspace.id))[0]!.summary, marker);
      assert.equal((await store.getProjection("local", "approval", response.approval.id))!.intent, marker);
      assert.deepEqual(await host.kernel.createThread("local", "local-owner", "thread", threadInput), thread);
      for (const table of ["events", "projections", "idempotency", "outbox"]) {
        assert.equal(JSON.stringify(raw.prepare(`select * from ${table}`).all()).includes(marker), false, table);
      }
    } finally { raw.close(); }
  } finally { await host.close(); rmSync(root, { recursive: true, force: true }); }
});
