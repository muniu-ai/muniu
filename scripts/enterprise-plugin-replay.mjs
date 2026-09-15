// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentOsHost, createEnterpriseFilePluginRepository, configureProductProjectionJournal, PLUGIN_INSTALLATION_PROJECTION } from "@mn/host";
import { createPluginPackageArchive, createSignedRegistryMetadata, sha256Hex, signPluginManifest } from "@mn/plugin-sdk";
import { S3Cas } from "@mn/storage";
import { PostgresKernelStore } from "./lib/postgres-kernel-store.mjs";
import { createPostgresPool } from "./lib/postgres-pool.mjs";
import { SigV4S3Client } from "./lib/s3-client.mjs";
import { VaultTransitKeyProvider } from "./lib/enterprise-secrets.mjs";

export async function verifyEnterprisePluginReplay() {
  const directory = await mkdtemp(join(tmpdir(), "mn-enterprise-plugin-proof-"));
  const hmacKey = Buffer.from("ZW50ZXJwcmlzZS1lMmUtaG1hYy1maXh0dXJlLWtleS0wMg==", "base64");
  const poolOptions = { connectionString: "postgresql://mn:mn-e2e-only@127.0.0.1:55432/mn_enterprise" };
  const pool = createPostgresPool(poolOptions);
  const storeA = new PostgresKernelStore({ pool: createPostgresPool(poolOptions), hmacKey });
  const storeB = new PostgresKernelStore({ pool: createPostgresPool(poolOptions), hmacKey });
  const cas = new S3Cas({ bucket: "mn-v2-artifacts", prefix: "v2/", client: new SigV4S3Client({
    endpoint: "http://127.0.0.1:59000", region: "us-east-1", accessKeyId: "mn-e2e", secretAccessKey: "mn-e2e-secret-only",
  }) });
  const keyProvider = new VaultTransitKeyProvider({ address: "http://127.0.0.1:58200",
    token: "mn-v2-vault-fixture-only", individuallyRevocable: true });
  let hostA;
  let hostB;
  let closedA = false;
  let closedB = false;
  try {
    await Promise.all([storeA.initialize(), storeB.initialize()]);
    const signed = await writeSignedFixture(directory);
    const options = { profile: "enterprise", cas, protectedPayloadKeyProvider: keyProvider,
      now: () => "2026-09-04T12:00:00.000Z", ...signed,
      identityResolver: request => ({ tenantId: request.headers.get("X-Tenant"), principalId: "fixture-owner",
        organizationRoles: ["organization_admin", "governance_admin"] }),
      secretStore: { async save() { throw new Error("No model calls in projection verification"); },
        async read() { throw new Error("No model calls in projection verification"); } } };
    hostA = await createAgentOsHost({ ...options, store: storeA });
    hostB = await createAgentOsHost({ ...options, store: storeB });
    const tenantId = `tenant-plugin-${randomUUID()}`;
    const otherTenant = `tenant-plugin-${randomUUID()}`;
    const call = (host, path, body, { tenant = tenantId, method = "POST", key = randomUUID() } = {}) =>
      host.dispatch(new Request(`http://host.test${path}`, { method,
        headers: { "X-Tenant": tenant, "Content-Type": "application/json", "Idempotency-Key": key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const data = async response => {
      assert.ok(response.ok, `fixture HTTP ${response.status}: ${(await response.clone().json()).code ?? "unknown"}`);
      return (await response.json()).data;
    };
    await data(await call(hostA, "/v2/plugins/installations", { pluginId: "research", version: "1.0.0" }));
    const workspace = await data(await call(hostA, "/v2/workspaces", { name: "企业投影验证", viewMode: "business", pluginIds: ["research"] }));
    const second = await data(await call(hostB, "/v2/workspaces", { name: "隔离工作区", viewMode: "professional", pluginIds: ["research"] }));
    const secret = `fixture-private-record-${randomUUID()}`;
    const payload = { workspaceId: workspace.id, resourceId: "record-one", expectedStreamVersion: 0, payload: { title: secret } };
    const event = await data(await call(hostA, "/v2/plugins/research/capture", payload, { key: "capture-once" }));
    assert.deepEqual(await data(await call(hostB, "/v2/plugins/research/capture", payload, { key: "capture-once" })), event);
    const read = workspaceId => ({ workspaceId, resourceId: "record-one", expectedStreamVersion: 0 });
    assert.deepEqual((await data(await call(hostB, "/v2/plugins/research/read", read(workspace.id)))).value, { title: secret });
    assert.equal(await data(await call(hostB, "/v2/plugins/research/read", read(second.id))), null);
    assert.equal((await call(hostB, "/v2/plugins/research/read", read(workspace.id), { tenant: otherTenant })).ok, false);
    const foreign = await data(await call(hostB, "/v2/plugins/installations", undefined, { method: "GET", tenant: otherTenant }));
    assert.equal(foreign.some(plugin => plugin.pluginId === "research"), false);

    const sourceEvent = (await storeA.readEventHistory(tenantId, 0, 1000)).events.find(item => item.aggregateType === "plugin:research");
    assert.ok(sourceEvent.protectedPayloadRef);
    await pool.query("update mn_v2.tenant_heads set retention_floor = $2 where tenant_id = $1", [tenantId, sourceEvent.position + 1]);
    await assert.rejects(storeA.readEvents(tenantId, 0, 1000));
    await data(await call(hostA, "/v2/plugins/installations/research", {
      version: "1.0.1", expectedStreamVersion: (await storeA.transact(tenantId,
        tx => tx.getProjection(PLUGIN_INSTALLATION_PROJECTION, "research"))).streamVersion,
    }, { method: "PATCH" }));
    assert.deepEqual((await data(await call(hostB, "/v2/plugins/research/read", read(workspace.id)))).value, { name: secret, status: "pending" });
    const invalidUpgrade = await call(hostA, "/v2/plugins/installations/research", {
      version: "1.0.2", expectedStreamVersion: (await storeA.transact(tenantId,
        tx => tx.getProjection(PLUGIN_INSTALLATION_PROJECTION, "research"))).streamVersion,
    }, { method: "PATCH" });
    assert.equal(invalidUpgrade.status, 422, "投影重放失败应拒绝升级，不得以版本冲突冒充重放验证");
    assert.deepEqual((await data(await call(hostB, "/v2/plugins/research/read", read(workspace.id)))).value, { name: secret, status: "pending" });

    const snapshot = async () => (await pool.query(`select namespace, projection_key, value_json from mn_v2.projections
      where tenant_id = $1 order by namespace, projection_key`, [tenantId])).rows;
    const before = await snapshot();
    const receipts = (await pool.query("select idempotency_key, request_hash, response_json from mn_v2.idempotency where tenant_id = $1 order by idempotency_key", [tenantId])).rows;
    assert.equal(JSON.stringify(before).includes(secret), false, "产品数据不应明文落库");
    assert.equal(JSON.stringify(receipts).includes(secret), false, "幂等结果不应明文落库");
    // Both application instances are drained before simulating loss of query projections.
    await hostA.close(); hostA = undefined; closedA = true;
    await hostB.close(); hostB = undefined; closedB = true;
    const rebuildStore = new PostgresKernelStore({ pool: createPostgresPool(poolOptions), hmacKey });
    configureProductProjectionJournal(rebuildStore, cas, keyProvider);
    try {
      const allFacts = (await rebuildStore.readEventHistory(tenantId, 0, 1000)).events;
      assert.equal(JSON.stringify(allFacts).includes(secret), false);
      const headBefore = allFacts.at(-1).position;
      const result = await rebuildStore.rebuildProjections(tenantId);
      assert.equal(result.position, headBefore);
      assert.ok(result.count > 0);
      assert.deepEqual(await snapshot(), before);
      await pool.query("delete from mn_v2.projections where tenant_id = $1", [tenantId]);
      await pool.query("delete from mn_v2.idempotency where tenant_id = $1", [tenantId]);
      await rebuildStore.rebuildProjections(tenantId);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual((await pool.query("select idempotency_key, request_hash, response_json from mn_v2.idempotency where tenant_id = $1 order by idempotency_key", [tenantId])).rows, receipts);
      assert.equal((await rebuildStore.readEventHistory(tenantId, 0, 1000)).events.at(-1).position, headBefore, "重建不重放命令或外部调用");
    } finally { await rebuildStore.close(); }
    process.stdout.write("真实 PostgreSQL/S3/Vault 插件数据端口：双 Host、租户隔离、投影升级失败不切换、查询表与幂等结果重建通过\n");
  } finally {
    await Promise.all([closedA ? undefined : hostA?.close() ?? storeA.close(),
      closedB ? undefined : hostB?.close() ?? storeB.close(), pool.end()]);
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeSignedFixture(directory) {
  const root = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519");
  const metadata = createSignedRegistryMetadata({ schemaVersion: 1, sequence: 10,
    issuedAt: "2026-09-04T06:00:00.000Z", expiresAt: "2026-09-05T06:00:00.000Z",
    keys: [{ keyId: "release", publicKeySpki: release.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      notBefore: "2026-09-01T00:00:00.000Z", notAfter: "2027-09-01T00:00:00.000Z" }], revokedKeys: [], revokedReleases: [],
  }, "root", root.privateKey);
  const source = `export default manifest => ({ id: manifest.id, version: manifest.version, manifest,
    official: false, trustBoundary: "process_equivalent", contributions: {
      routes: [], navigation: [], widgets: [], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [],
      commands: [{ id: "capture", title: "保存记录", run: (input, context) => context.data.append({
        key: "capture", resourceId: input.resourceId, eventType: "research.created", payload: input.payload,
        expectedStreamVersion: input.expectedStreamVersion }) },
        { id: "read", title: "读取记录", run: async (input, context) => await context.data.get("records", input.resourceId) ?? null }]
    } });`;
  const programs = [
    { schemaVersion: 1, rules: [{ eventType: "research.created", operation: "replace" }], requiredFields: ["title"] },
    { schemaVersion: 1, rules: [{ eventType: "research.created", operation: "replace", fields: { name: "/title" }, defaults: { status: "pending" } }] },
    { schemaVersion: 1, rules: [{ eventType: "research.created", operation: "replace", fields: { name: "/missing" } }] },
  ];
  const releases = await Promise.all(programs.map(async (program, index) => {
    const packageBytes = createPluginPackageArchive({ "host.mjs": { content: Buffer.from(source) },
      "sqlite.json": { content: Buffer.from(JSON.stringify(program)) }, "postgres.json": { content: Buffer.from(JSON.stringify(program)) } });
    const manifest = signPluginManifest({ schemaVersion: 1, id: "research", version: `1.0.${index}`, engineApi: "0.2.0",
      displayName: "企业研究 fixture", description: "验证签名插件事实恢复", entrypoints: { host: "./host.mjs" },
      contributes: { routes: [], navigation: [], widgets: [], commands: ["capture", "read"], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [] },
      permissions: [], dataNamespace: "research", eventSchemas: { "research.created": {
        type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false,
      } }, projections: [{ engine: "sqlite", namespace: "records", entry: "./sqlite.json" },
        { engine: "postgresql", namespace: "records", entry: "./postgres.json" }], dependencies: [], packageSha256: sha256Hex(packageBytes),
      signature: { algorithm: "Ed25519", keyId: "release", value: "pending" }, license: "Apache-2.0",
      release: { sequence: index + 1, publishedAt: "2026-09-04T06:00:00.000Z", expiresAt: "2026-09-05T06:00:00.000Z", source: `https://plugins.example/research/1.0.${index}` },
    }, release.privateKey);
    const packagePath = `release-${index}.json`;
    await writeFile(join(directory, packagePath), packageBytes, { mode: 0o600 });
    return { manifest, packagePath };
  }));
  const indexFile = join(directory, "index.json");
  const trustedRootsFile = join(directory, "roots.json");
  await writeFile(indexFile, JSON.stringify({ schemaVersion: 1, metadata, releases }), { mode: 0o600 });
  await writeFile(trustedRootsFile, JSON.stringify({ schemaVersion: 1, roots: [{ keyId: "root",
    publicKeySpki: root.publicKey.export({ type: "spki", format: "der" }).toString("base64url") }] }), { mode: 0o600 });
  const repository = await createEnterpriseFilePluginRepository({ indexFile, trustedRootsFile, now: () => new Date("2026-09-04T12:00:00.000Z") });
  return { pluginRepository: repository.pluginRepository, trustedPluginRoots: repository.trustedPluginRoots };
}
