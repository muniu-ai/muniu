// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject, PluginInstallation, PluginManifestV1, Workspace } from "@mn/contracts";
import { InMemoryKernelStore } from "@mn/kernel";
import { FileCas, InMemoryKeyProvider, SqliteStorage } from "@mn/storage";
import { createPluginPackageArchive, createSignedRegistryMetadata, sha256Hex, signPluginManifest,
  verifyRegistryMetadata, verifyPluginArtifact, type PluginDefinitionV1, type PluginProjectionProgramV1 } from "@mn/plugin-sdk";
import { createAgentOsHost, KernelPluginProjectionManager, LocalSignedPluginRepository, PLUGIN_INSTALLATION_PROJECTION,
  PLUGIN_DATA_HEAD_NAMESPACE, PLUGIN_PROJECTION_LAYOUT_NAMESPACE, pluginProjectionNamespace } from "../src/index.js";

const NOW = "2026-09-04T12:00:00.000Z";
const SECRET = "private-customer-validation-notes";

function fixture() {
  const root = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519");
  const metadata = createSignedRegistryMetadata({ schemaVersion: 1, sequence: 10, issuedAt: "2026-09-04T06:00:00.000Z",
    expiresAt: "2026-09-05T06:00:00.000Z", keys: [{ keyId: "release", publicKeySpki: release.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      notBefore: "2026-09-01T00:00:00.000Z", notAfter: "2027-09-01T00:00:00.000Z" }], revokedKeys: [], revokedReleases: [] }, "root", root.privateKey);
  const programs: PluginProjectionProgramV1[] = [
    { schemaVersion: 1, rules: [{ eventType: "research.created", operation: "replace" }], requiredFields: ["title"] },
    { schemaVersion: 1, rules: [{ eventType: "research.created", operation: "replace", fields: { name: "/title" }, defaults: { status: "pending" } }], requiredFields: ["name", "status"] },
    { schemaVersion: 1, rules: [{ eventType: "research.created", operation: "replace", fields: { name: "/absent" } }] },
    { schemaVersion: 1, rules: [{ eventType: "research.created", operation: "replace" }] },
  ];
  const releases = programs.map((program, index) => {
    const packageBytes = createPluginPackageArchive({ "host.js": { content: Buffer.from("export default () => ({})") },
      "projection/sqlite.json": { content: Buffer.from(JSON.stringify(program)) },
      "projection/postgres.json": { content: Buffer.from(JSON.stringify(program)) } });
    const manifest = signPluginManifest({ schemaVersion: 1, id: "research", version: `1.0.${index}`, engineApi: "0.2.0",
      displayName: "研究资料", description: "维护研究记录", entrypoints: { host: "./host.js" },
      contributes: { routes: [], navigation: [], widgets: [], commands: ["capture", "read"], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [], ...(index === 3 ? { healthCheck: "research.health" } : {}) },
      permissions: [], dataNamespace: "research", eventSchemas: { "research.created": { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } },
      projections: [{ engine: "sqlite", namespace: "records", entry: "./projection/sqlite.json" },
        { engine: "postgresql", namespace: "records", entry: "./projection/postgres.json" }], dependencies: [], packageSha256: sha256Hex(packageBytes),
      signature: { algorithm: "Ed25519", keyId: "release", value: "pending" }, release: { sequence: index + 1, publishedAt: "2026-09-04T06:00:00.000Z",
        expiresAt: "2026-09-05T06:00:00.000Z", source: `https://plugins.example/research/1.0.${index}` }, license: "Apache-2.0" } satisfies PluginManifestV1, release.privateKey);
    const definition: PluginDefinitionV1 = { id: manifest.id, version: manifest.version, manifest, official: false, trustBoundary: "process_equivalent",
      ...(index === 3 ? { healthCheck: () => ({ status: "degraded" as const, message: "private-health-failure" }) } : {}),
      contributions: { routes: [], navigation: [], widgets: [], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [], commands: [
        { id: "capture", title: "保存记录", async run(input, context) { return context.data!.append({ key: "capture", resourceId: String(input.resourceId),
          eventType: "research.created", payload: input.payload as JsonObject, expectedStreamVersion: Number(input.expectedStreamVersion) }); } },
        { id: "read", title: "读取记录", async run(input, context) { return await context.data!.get("records", String(input.resourceId)) ?? null; } },
      ] } };
    return { manifest, packageBytes, definition };
  });
  const roots = [{ keyId: "root", publicKey: root.publicKey }];
  const registry = verifyRegistryMetadata(metadata, roots, { now: new Date(NOW), operation: "install" });
  return { repository: new LocalSignedPluginRepository({ metadata, releases }), roots, releases,
    artifacts: releases.map(item => verifyPluginArtifact({ ...item, registry, now: new Date(NOW), operation: "install" })) };
}

test("默认投影端口从加密事实升级，跨 SSE 保留期重放，失败不切换，命令和投影不明文落库", async t => {
  const directory = await mkdtemp(join(tmpdir(), "muniu-plugin-projection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "state.sqlite3");
  let store = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 7) });
  const signed = fixture();
  const options = { now: () => NOW, cas: new FileCas({ rootDir: join(directory, "cas") }), protectedPayloadKeyProvider: new InMemoryKeyProvider(Buffer.alloc(32, 8)),
    secretStore: { async save(id: string) { return `keychain://muniu.v2/${id}`; }, async read() { return "test"; } }, pluginRepository: signed.repository, trustedPluginRoots: signed.roots };
  let host = await createAgentOsHost({ ...options, store });
  t.after(() => host.close());
  let serial = 0;
  const request = (path: string, body: JsonObject, key = `request-${++serial}`, method = "POST") => host.dispatch(new Request(`http://host.test${path}`, {
    method, headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  const success = async (response: Response) => { assert.ok(response.ok, await response.clone().text()); return (await response.json()).data; };
  await success(await request("/v2/plugins/installations", { pluginId: "research", version: "1.0.0" }));
  const workspace = await success(await request("/v2/workspaces", { name: "研究", viewMode: "professional", pluginIds: ["research"] }));
  const other = await success(await request("/v2/workspaces", { name: "隔离", viewMode: "business", pluginIds: ["research"] }));
  const capture = { workspaceId: workspace.id, resourceId: "record-1", expectedStreamVersion: 0, payload: { title: SECRET } };
  const event = await success(await request("/v2/plugins/research/capture", capture, "capture-once"));
  assert.equal(event.streamVersion, 1);
  assert.deepEqual(await success(await request("/v2/plugins/research/capture", capture, "capture-once")), event);
  assert.equal((await request("/v2/plugins/research/capture", { ...capture, payload: { title: "changed" } }, "capture-once")).status, 409);
  assert.equal((await request("/v2/plugins/research/capture", { ...capture, payload: { title: 42 } })).status, 422);
  const read = (workspaceId: string) => request("/v2/plugins/research/read", { workspaceId, resourceId: "record-1", expectedStreamVersion: 0 });
  assert.deepEqual((await success(await read(workspace.id))).value, { title: SECRET });
  assert.equal(await success(await read(other.id)), null);
  const facts = (await store.readEventHistory("local", 0, 1000)).events.filter(item => item.aggregateType === "plugin:research");
  assert.equal(facts.length, 1);
  assert.equal(JSON.stringify(facts).includes(SECRET), false);
  assert.ok(facts[0]!.protectedPayloadRef);
  await store.advanceRetentionFloor("local", facts[0]!.position + 1);
  await assert.rejects(store.readEvents("local", 0, 1000));
  const current = () => store.transact("local", tx => tx.getProjection<PluginInstallation>(PLUGIN_INSTALLATION_PROJECTION, "research")!);
  const upgraded = await success(await request("/v2/plugins/installations/research", { version: "1.0.1", expectedStreamVersion: (await current()).streamVersion }, undefined, "PATCH"));
  assert.equal(upgraded.version, "1.0.1");
  assert.deepEqual((await success(await read(workspace.id))).value, { name: SECRET, status: "pending" });
  const badUpgrade = await request("/v2/plugins/installations/research", { version: "1.0.2", expectedStreamVersion: (await current()).streamVersion }, undefined, "PATCH");
  assert.equal(badUpgrade.status, 422);
  assert.equal((await badUpgrade.json()).code, "PLUGIN_UPGRADE_INVALID");
  assert.equal((await current()).version, "1.0.1");
  const unhealthy = await request("/v2/plugins/installations/research", { version: "1.0.3", expectedStreamVersion: (await current()).streamVersion }, undefined, "PATCH");
  assert.equal(unhealthy.status, 422);
  assert.equal((await current()).version, "1.0.1");
  assert.equal((await unhealthy.text()).includes("private-health-failure"), false);
  assert.deepEqual((await success(await read(workspace.id))).value, { name: SECRET, status: "pending" });
  await host.close();
  store = new SqliteStorage({ databaseFile, hmacKey: Buffer.alloc(32, 7) });
  host = await createAgentOsHost({ ...options, store });
  assert.deepEqual((await success(await read(workspace.id))).value, { name: SECRET, status: "pending" });
  const updated = await success(await request("/v2/plugins/research/capture", { ...capture, expectedStreamVersion: 1, payload: { title: "reviewed" } }));
  assert.equal(updated.streamVersion, 2);
  assert.deepEqual((await success(await read(workspace.id))).value, { name: "reviewed", status: "pending" });
  const disabled = await success(await request("/v2/plugins/installations/research/disable", { expectedStreamVersion: (await current()).streamVersion }));
  await success(await request("/v2/plugins/installations/research", { expectedStreamVersion: disabled.streamVersion }, undefined, "DELETE"));
  assert.equal(await store.transact("local", tx => tx.getProjection(PLUGIN_PROJECTION_LAYOUT_NAMESPACE, "research")), undefined);
  assert.equal((await store.readEventHistory("local", 0, 1000)).events.filter(item => item.aggregateType === "plugin:research").length, 2);
  const rollback = await request("/v2/plugins/installations", { pluginId: "research", version: "1.0.0" });
  assert.equal(rollback.status, 422, "purge must not reset the monotonic release floor");
  assert.equal((await rollback.json()).code, "RELEASE_ROLLBACK");
  await success(await request("/v2/plugins/installations", { pluginId: "research", version: "1.0.1" }));
  const workspaceVersion = await store.transact("local", tx => tx.getProjection<Workspace>("workspace", workspace.id)!.streamVersion);
  await success(await request(`/v2/workspaces/${workspace.id}/plugin-activations`, { pluginId: "research", expectedStreamVersion: workspaceVersion }));
  assert.deepEqual((await success(await read(workspace.id))).value, { name: "reviewed", status: "pending" });
  await host.close();
  assert.equal((await readFile(databaseFile)).includes(Buffer.from(SECRET)), false);
});

test("重放后领域水位变化必须拒绝切换，清除覆盖所有历史投影且不删除事实", async () => {
  const store = new InMemoryKernelStore();
  const signed = fixture();
  const manager = new KernelPluginProjectionManager({ store, tenantId: "tenant-a", engine: "postgresql", async readEvent() { throw new Error("unexpected domain event"); } });
  const prepare = (index: number) => manager.replayAndValidate({ pluginId: "research", manifest: signed.releases[index]!.manifest,
    artifact: signed.artifacts[index], packageBytes: signed.releases[index]!.packageBytes, namespace: `research__1_0_${index}__${index + 1}` });
  const stale = await prepare(0);
  await store.transact("tenant-a", tx => tx.putProjection(PLUGIN_DATA_HEAD_NAMESPACE, "research", { streamVersion: 1, position: 1 }));
  await assert.rejects(store.transact("tenant-a", tx => stale.activate(tx)), /重放后发生变化/u);
  assert.equal(await store.transact("tenant-a", tx => tx.getProjection(PLUGIN_PROJECTION_LAYOUT_NAMESPACE, "research")), undefined);
  await stale.discard();
  await store.transact("tenant-a", tx => tx.deleteProjection(PLUGIN_DATA_HEAD_NAMESPACE, "research"));
  for (let index = 0; index < 3; index++) {
    const prepared = await prepare(index);
    await store.transact("tenant-a", tx => prepared.activate(tx));
    await prepared.discard();
  }
  const before = await store.readEventHistory("tenant-a", 0, 100);
  await store.transact("tenant-a", tx => manager.purge({ pluginId: "research", namespaces: ["research__1_0_2__3", "research__1_0_1__2"], transaction: tx }));
  assert.equal(await store.transact("tenant-a", tx => tx.getProjection(PLUGIN_PROJECTION_LAYOUT_NAMESPACE, "research")), undefined);
  assert.deepEqual(await store.readEventHistory("tenant-a", 0, 100), before);
  assert.notEqual(pluginProjectionNamespace("research-a", "research_a__1_0_0__1", "records"),
    pluginProjectionNamespace("research.a", "research_a__1_0_0__1", "records"));
});

test("投影重放超过事件预算时不准备切换，也不泄漏历史内容", async () => {
  const store = new InMemoryKernelStore();
  const signed = fixture();
  await store.transact("tenant-a", tx => {
    for (let index = 0; index < 2; index++) tx.appendEvent({ tenantId: "tenant-a", aggregateType: "fixture",
      aggregateId: String(index), expectedStreamVersion: 0, type: "fixture.created", actorId: "owner", generation: 1,
      correlationId: "fixture", publicPayload: { text: SECRET } });
  });
  const options = { store, tenantId: "tenant-a", engine: "sqlite" as const, replayLimits: { maxEvents: 1 },
    async readEvent(): Promise<never> { throw new Error("unexpected plugin event"); } };
  const manager = new KernelPluginProjectionManager(options);
  await assert.rejects(manager.replayAndValidate({ pluginId: "research", manifest: signed.releases[0]!.manifest,
    artifact: signed.artifacts[0], packageBytes: signed.releases[0]!.packageBytes, namespace: "bounded_replay" }), error => {
      assert.equal((error as { code?: string }).code, "PLUGIN_UPGRADE_INVALID");
      assert.equal(String(error).includes(SECRET), false);
      return true;
    });
  assert.equal(await store.transact("tenant-a", tx => tx.getProjection(PLUGIN_PROJECTION_LAYOUT_NAMESPACE, "research")), undefined);
});
