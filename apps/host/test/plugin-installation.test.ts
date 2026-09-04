import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Execution, PluginInstallation, PluginManifestV1 } from "@mn/contracts";
import { InMemoryKernelStore } from "@mn/kernel";
import { SqliteStorage } from "@mn/storage";
import {
  createSignedRegistryMetadata,
  sha256Hex,
  signPluginManifest,
  type PluginDefinitionV1,
  type RegistryMetadataV1,
} from "@mn/plugin-sdk";
import {
  LocalSignedPluginRepository,
  PLUGIN_INSTALLATION_PROJECTION,
  PLUGIN_LOCK_PROJECTION,
  createAgentOsHost,
  type ModelSecretStore,
  type PluginLockV1,
} from "../src/index.js";

const NOW = "2026-09-04T12:00:00.000Z";
const secrets: ModelSecretStore = {
  async save(connectionId) { return `keychain://muniu.v2/${connectionId}`; },
  async read() { return "test-key"; },
};

function jsonRequest(path: string, body: unknown, key: string, method = "POST"): Request {
  return new Request(`http://host.test${path}`, {
    method,
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response): Promise<any> {
  return response.json();
}

function signedRepository(options: {
  readonly packageBytes?: Uint8Array;
  readonly packageMetadata?: {
    readonly scripts?: Readonly<Record<string, string>>;
    readonly remoteJavaScript?: readonly string[];
  };
} = {}) {
  const root = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519");
  const packageBytes = options.packageBytes ?? Buffer.from("local signed research plugin");
  const registry = createSignedRegistryMetadata({
    schemaVersion: 1,
    sequence: 11,
    issuedAt: "2026-09-04T06:00:00.000Z",
    expiresAt: "2026-09-05T06:00:00.000Z",
    keys: [{
      keyId: "release-1",
      publicKeySpki: release.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      notBefore: "2026-09-01T00:00:00.000Z",
      notAfter: "2027-09-01T00:00:00.000Z",
    }],
    revokedKeys: [],
    revokedReleases: [],
  } satisfies Omit<RegistryMetadataV1, "signature">, "root-1", root.privateKey);
  const manifest = signPluginManifest({
    schemaVersion: 1,
    id: "research",
    version: "1.2.3",
    engineApi: "0.2.0",
    displayName: "研究助手",
    description: "整理本地研究成果",
    entrypoints: { host: "./dist/host.js" },
    contributes: {
      routes: ["research.home"],
      navigation: [],
      widgets: [],
      commands: ["summarize"],
      agents: [],
      skills: [],
      workflows: [],
      tools: [],
      memorySchemas: [],
    },
    permissions: [],
    dataNamespace: "research",
    eventSchemas: {},
    projections: [],
    dependencies: [],
    packageSha256: sha256Hex(packageBytes),
    signature: { algorithm: "Ed25519", keyId: "release-1", value: "pending" },
    release: {
      sequence: 4,
      publishedAt: "2026-09-04T06:00:00.000Z",
      expiresAt: "2026-09-05T06:00:00.000Z",
      source: "https://plugins.muniu.example/research/1.2.3",
    },
    license: "Apache-2.0",
  } satisfies PluginManifestV1, release.privateKey);
  const definition: PluginDefinitionV1 = {
    id: "research",
    version: "1.2.3",
    official: false,
    trustBoundary: "process_equivalent",
    manifest,
    contributions: {
      routes: [{ id: "research.home", path: "/plugins/research" }],
      navigation: [], widgets: [], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [],
      commands: [{
        id: "summarize",
        title: "生成摘要",
        async run(input) { return { outcome: `已整理：${String(input.topic)}` }; },
      }],
    },
  };
  return {
    root,
    release,
    manifest,
    packageBytes,
    definition,
    repository: new LocalSignedPluginRepository({
      metadata: registry,
      releases: [{ manifest, packageBytes, definition, packageMetadata: options.packageMetadata }],
    }),
  };
}

async function signedUpgradeRepository() {
  const first = signedRepository();
  const snapshot = (await first.repository.read())!;
  const nextPackageBytes = Buffer.from("local signed research plugin v1.3");
  const nextManifest = signPluginManifest({
    ...first.manifest,
    version: "1.3.0",
    packageSha256: sha256Hex(nextPackageBytes),
    projections: [{
      engine: "sqlite",
      namespace: "research_v2",
      entry: "./projection/sqlite.sql",
    }],
    release: { ...first.manifest.release, sequence: 5 },
  }, first.release.privateKey);
  const nextDefinition: PluginDefinitionV1 = {
    ...first.definition,
    version: "1.3.0",
    manifest: nextManifest,
    contributions: {
      ...first.definition.contributions,
      commands: [{
        id: "summarize",
        title: "生成摘要",
        async run(input) { return { outcome: `新版已整理：${String(input.topic)}` }; },
      }],
    },
  };
  return {
    ...first,
    nextManifest,
    nextPackageBytes,
    nextDefinition,
    repository: new LocalSignedPluginRepository({
      metadata: snapshot.metadata,
      releases: [
        snapshot.releases[0]!,
        { manifest: nextManifest, packageBytes: nextPackageBytes, definition: nextDefinition },
      ],
    }),
  };
}

test("生产更新先排空执行并重放投影，再原子更新 installation、lock 与运行贡献", async () => {
  const store = new InMemoryKernelStore();
  const fixture = await signedUpgradeRepository();
  const order: string[] = [];
  let releaseDrain!: () => void;
  let markDrainStarted!: () => void;
  const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const drainStarted = new Promise<void>((resolve) => { markDrainStarted = resolve; });
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    now: () => NOW,
    pluginRepository: fixture.repository,
    trustedPluginRoots: [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    pluginExecutionControl: {
      async drain(pluginId) {
        order.push(`drain:${pluginId}`);
        markDrainStarted();
        await drainGate;
      },
      async interruptAtSafeBoundary() {},
    },
    pluginProjections: {
      async replayAndValidate(input) {
        order.push(`replay:${input.namespace}`);
        return {
          namespace: input.namespace,
          activate() { order.push(`switch:${input.namespace}`); },
          discard() { order.push(`discard:${input.namespace}`); },
        };
      },
    },
  });

  assert.equal((await host.dispatch(jsonRequest("/v2/plugins/installations", {
    pluginId: "research", version: "1.2.3",
  }, "install-before-update"))).status, 201);
  const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "升级验证", viewMode: "professional", pluginIds: ["research"],
  }, "workspace-before-update")))).data;

  const updateRequest = jsonRequest("/v2/plugins/installations/research", {
    version: "1.3.0",
    expectedStreamVersion: 2,
  }, "update-research", "PATCH");
  const updating = host.dispatch(updateRequest);
  await drainStarted;
  const blockedCommand = await host.dispatch(jsonRequest("/v2/plugins/research/summarize", {
    expectedStreamVersion: 0,
    workspaceId: workspace.id,
    topic: "不得在排空期间执行",
  }, "blocked-during-update"));
  assert.equal(blockedCommand.status, 422);
  assert.equal((await responseJson(blockedCommand)).code, "PLUGIN_NOT_ACTIVE");
  releaseDrain();
  const updatedResponse = await updating;
  const updatedBody = await updatedResponse.text();
  assert.equal(updatedResponse.status, 200, updatedBody);
  const updated = JSON.parse(updatedBody).data as PluginInstallation;
  assert.equal(updated.version, "1.3.0");
  assert.equal(updated.status, "active");
  assert.equal(updated.streamVersion, 3);
  assert.deepEqual(order, [
    "drain:research",
    "replay:research__1_3_0__5",
    "switch:research__1_3_0__5",
  ]);
  const replayedUpdate = await host.dispatch(jsonRequest("/v2/plugins/installations/research", {
    version: "1.3.0",
    expectedStreamVersion: 2,
  }, "update-research", "PATCH"));
  assert.deepEqual((await responseJson(replayedUpdate)).data, updated);
  assert.equal(order.length, 3);

  const conflict = await host.dispatch(jsonRequest("/v2/plugins/installations/research", {
    version: "1.3.0",
    expectedStreamVersion: 2,
  }, "update-research-stale", "PATCH"));
  assert.equal(conflict.status, 409);
  assert.equal((await responseJson(conflict)).code, "STREAM_VERSION_CONFLICT");

  const persisted = await store.transact("local", (transaction) => ({
    installation: transaction.getProjection<PluginInstallation>(PLUGIN_INSTALLATION_PROJECTION, "research"),
    lock: transaction.getProjection<PluginLockV1>(PLUGIN_LOCK_PROJECTION, "current"),
  }));
  assert.equal(persisted.installation?.version, "1.3.0");
  assert.equal(persisted.lock?.plugins[0]?.version, "1.3.0");

  const command = await host.dispatch(jsonRequest("/v2/plugins/research/summarize", {
    expectedStreamVersion: 0,
    workspaceId: workspace.id,
    topic: "反证",
  }, "summarize-after-update"));
  assert.deepEqual((await responseJson(command)).data, { outcome: "新版已整理：反证" });
  const events = (await store.readEvents("local", 0, 100)).events
    .filter((event) => event.type === "plugin.upgraded");
  assert.equal(events.length, 1);
  await host.close();
});

test("生产更新的投影切换失败时回滚状态、lock 与新命名空间写入", async () => {
  const store = new InMemoryKernelStore();
  const fixture = await signedUpgradeRepository();
  let discarded = false;
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    now: () => NOW,
    pluginRepository: fixture.repository,
    trustedPluginRoots: [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    pluginProjections: {
      async replayAndValidate(input) {
        return {
          namespace: input.namespace,
          activate(transaction) {
            transaction.putProjection("plugin-projection-pointer", "research", {
              namespace: input.namespace,
            });
            throw new Error("projection switch failed");
          },
          discard() { discarded = true; },
        };
      },
    },
  });
  const installed = (await responseJson(await host.dispatch(jsonRequest("/v2/plugins/installations", {
    pluginId: "research", version: "1.2.3",
  }, "install-before-failed-update")))).data as PluginInstallation;

  const failed = await host.dispatch(jsonRequest("/v2/plugins/installations/research", {
    version: "1.3.0",
    expectedStreamVersion: installed.streamVersion,
  }, "failed-update-research", "PATCH"));
  assert.equal(failed.status, 500);
  assert.equal(discarded, true);
  const persisted = await store.transact("local", (transaction) => ({
    installation: transaction.getProjection<PluginInstallation>(PLUGIN_INSTALLATION_PROJECTION, "research"),
    lock: transaction.getProjection<PluginLockV1>(PLUGIN_LOCK_PROJECTION, "current"),
    pointer: transaction.getProjection("plugin-projection-pointer", "research"),
  }));
  assert.equal(persisted.installation?.version, "1.2.3");
  assert.equal(persisted.lock?.plugins[0]?.version, "1.2.3");
  assert.equal(persisted.pointer, undefined);
  assert.equal((await store.readEvents("local", 0, 100)).events
    .some((event) => event.type === "plugin.upgraded"), false);
  await host.close();
});

test("生产更新在插件仍有未终结 Execution 时拒绝切换", async () => {
  const store = new InMemoryKernelStore();
  const fixture = await signedUpgradeRepository();
  let replayed = false;
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    now: () => NOW,
    pluginRepository: fixture.repository,
    trustedPluginRoots: [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    pluginProjections: {
      async replayAndValidate(input) {
        replayed = true;
        return { namespace: input.namespace, activate() {}, discard() {} };
      },
    },
  });
  const installed = (await responseJson(await host.dispatch(jsonRequest("/v2/plugins/installations", {
    pluginId: "research", version: "1.2.3",
  }, "install-before-busy-update")))).data as PluginInstallation;
  await store.transact("local", (transaction) => {
    transaction.putProjection<Execution>("execution", "execution-busy", {
      id: "execution-busy",
      tenantId: "local",
      workspaceId: "workspace-busy",
      threadId: "thread-busy",
      pluginId: "research",
      agentDefinitionId: "researcher",
      modelBindingId: "model-local",
      initiatedBy: "local-owner",
      executionPrincipalId: "agent:research",
      generation: 1,
      status: "running",
      authorityId: "authority-busy",
      streamVersion: 2,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  const blocked = await host.dispatch(jsonRequest("/v2/plugins/installations/research", {
    version: "1.3.0",
    expectedStreamVersion: installed.streamVersion,
  }, "busy-update-research", "PATCH"));
  assert.equal(blocked.status, 422);
  assert.equal((await responseJson(blocked)).code, "PLUGIN_UPGRADE_INVALID");
  assert.equal(replayed, false);
  await host.close();
});

test("默认生产安装链验签本地制品，持久化 installation 与确定性 lock 后才能激活", async () => {
  const store = new InMemoryKernelStore();
  const fixture = signedRepository();
  const host = await createAgentOsHost({
    store,
    secretStore: secrets,
    now: () => NOW,
    pluginRepository: fixture.repository,
    trustedPluginRoots: [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
  });

  const installedResponse = await host.dispatch(jsonRequest("/v2/plugins/installations", {
    pluginId: "research",
    version: "1.2.3",
  }, "install-research"));
  assert.equal(installedResponse.status, 201);
  const installed = (await responseJson(installedResponse)).data as PluginInstallation;
  assert.equal(installed.pluginId, "research");
  assert.equal(installed.status, "installed");
  assert.equal(installed.packageSha256.length, 64);
  const replayed = await host.dispatch(jsonRequest("/v2/plugins/installations", {
    pluginId: "research",
    version: "1.2.3",
  }, "install-research"));
  assert.deepEqual((await responseJson(replayed)).data, installed);

  const persisted = await store.transact("local", (transaction) => ({
    installation: transaction.getProjection<PluginInstallation>(PLUGIN_INSTALLATION_PROJECTION, "research"),
    lock: transaction.getProjection<PluginLockV1>(PLUGIN_LOCK_PROJECTION, "current"),
  }));
  assert.equal(persisted.installation?.version, "1.2.3");
  assert.equal(persisted.lock?.plugins[0]?.pluginId, "research");
  assert.match(persisted.lock?.digest ?? "", /^[0-9a-f]{64}$/u);
  const installEvents = (await store.readEvents("local", 0, 100)).events
    .filter((event) => event.type === "plugin.installed");
  assert.equal(installEvents.length, 1);

  const workspace = (await responseJson(await host.dispatch(jsonRequest("/v2/workspaces", {
    name: "第三方插件", viewMode: "professional", pluginIds: [],
  }, "workspace")))).data;
  const activation = await host.dispatch(jsonRequest(`/v2/workspaces/${workspace.id}/plugin-activations`, {
    expectedStreamVersion: workspace.streamVersion,
    pluginId: "research",
  }, "activate-research"));
  assert.equal(activation.status, 200);
  assert.deepEqual((await responseJson(activation)).data.activePluginIds, ["research"]);

  const command = await host.dispatch(jsonRequest("/v2/plugins/research/summarize", {
    expectedStreamVersion: 0,
    workspaceId: workspace.id,
    topic: "访谈证据",
  }, "summarize"));
  assert.deepEqual((await responseJson(command)).data, { outcome: "已整理：访谈证据" });
  const listed = (await responseJson(await host.dispatch(
    new Request("http://host.test/v2/plugins/installations"),
  ))).data;
  assert.equal(listed.find((item: any) => item.pluginId === "research").status, "active");
  await host.close();
});

test("已安装插件可用过期的已验仓库快照离线恢复，但安装请求仍拒绝过期元数据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mn-plugin-install-"));
  const databaseFile = join(directory, "state.sqlite3");
  const hmacKey = Buffer.alloc(32, 7);
  const fixture = signedRepository();
  try {
    const first = await createAgentOsHost({
      store: new SqliteStorage({ databaseFile, hmacKey }),
      secretStore: secrets,
      now: () => NOW,
      pluginRepository: fixture.repository,
      trustedPluginRoots: [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    });
    assert.equal((await first.dispatch(jsonRequest("/v2/plugins/installations", {
      pluginId: "research", version: "1.2.3",
    }, "install-before-offline"))).status, 201);
    await first.close();

    const reopened = await createAgentOsHost({
      store: new SqliteStorage({ databaseFile, hmacKey }),
      secretStore: secrets,
      now: () => "2026-09-10T12:00:00.000Z",
      pluginRepository: fixture.repository,
      trustedPluginRoots: [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    });
    const workspace = (await responseJson(await reopened.dispatch(jsonRequest("/v2/workspaces", {
      name: "离线恢复", viewMode: "business", pluginIds: ["research"],
    }, "offline-workspace")))).data;
    assert.deepEqual(workspace.activePluginIds, ["research"]);
    const duplicate = await reopened.dispatch(jsonRequest("/v2/plugins/installations", {
      pluginId: "research", version: "1.2.3",
    }, "offline-install"));
    assert.equal(duplicate.status, 422);
    assert.equal((await responseJson(duplicate)).code, "REVOCATION_METADATA_STALE");
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("重启时校验持久化 plugin lock，篡改只会使插件不可用", async () => {
  const store = new InMemoryKernelStore();
  const fixture = signedRepository();
  const first = await createAgentOsHost({
    store, secretStore: secrets, now: () => NOW,
    pluginRepository: fixture.repository,
    trustedPluginRoots: [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
  });
  assert.equal((await first.dispatch(jsonRequest("/v2/plugins/installations", {
    pluginId: "research", version: "1.2.3",
  }, "install-before-tamper"))).status, 201);
  await first.close();
  await store.transact("local", (transaction) => {
    const lock = transaction.getProjection<PluginLockV1>(PLUGIN_LOCK_PROJECTION, "current")!;
    transaction.putProjection(PLUGIN_LOCK_PROJECTION, "current", { ...lock, digest: "0".repeat(64) });
  });

  const reopened = await createAgentOsHost({
    store, secretStore: secrets, now: () => NOW,
    pluginRepository: fixture.repository,
    trustedPluginRoots: [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
  });
  const listed = (await responseJson(await reopened.dispatch(
    new Request("http://host.test/v2/plugins/installations"),
  ))).data;
  assert.equal(listed.find((item: any) => item.pluginId === "research").status, "failed");
  const core = await responseJson(await reopened.dispatch(new Request("http://host.test/v2/health")));
  assert.equal(core.data.core.status, "healthy");
  const workspace = await reopened.dispatch(jsonRequest("/v2/workspaces", {
    name: "不得启用篡改插件", viewMode: "business", pluginIds: ["research"],
  }, "tampered-workspace"));
  assert.equal(workspace.status, 422);
  assert.equal((await responseJson(workspace)).code, "PLUGIN_NOT_INSTALLED");
  await reopened.close();
});

test("生产安装拒绝调用方来源、篡改包、安装 hook 和远程 JavaScript", async () => {
  const cases = [
    ["调用方来源", signedRepository(), { pluginId: "research", version: "1.2.3", source: "https://bad.example/x.js" }, "INVALID_BODY"],
    ["篡改包", signedRepository({ packageBytes: Buffer.from("signed bytes") }), { pluginId: "research", version: "1.2.3" }, "PACKAGE_DIGEST_MISMATCH"],
    ["安装 hook", signedRepository({ packageMetadata: { scripts: { postinstall: "node install.js" } } }), { pluginId: "research", version: "1.2.3" }, "INSTALL_HOOK_FORBIDDEN"],
    ["远程 JavaScript", signedRepository({ packageMetadata: { remoteJavaScript: ["https://bad.example/x.js"] } }), { pluginId: "research", version: "1.2.3" }, "REMOTE_JAVASCRIPT_FORBIDDEN"],
  ] as const;
  for (const [index, [name, fixture, body, expectedCode]] of cases.entries()) {
    const repository = name === "篡改包"
      ? new LocalSignedPluginRepository({
        ...(await fixture.repository.read())!,
        releases: [{ ...(await fixture.repository.read())!.releases[0]!, packageBytes: Buffer.from("tampered") }],
      })
      : fixture.repository;
    const host = await createAgentOsHost({
      store: new InMemoryKernelStore(), secretStore: secrets, now: () => NOW,
      pluginRepository: repository,
      trustedPluginRoots: [{ keyId: "root-1", publicKey: fixture.root.publicKey }],
    });
    const response = await host.dispatch(jsonRequest("/v2/plugins/installations", body, `reject-${index}`));
    assert.equal(response.status, 422);
    assert.equal((await responseJson(response)).code, expectedCode);
    await host.close();
  }
});
