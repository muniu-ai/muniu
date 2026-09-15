import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OrganizationRole, PluginManifestV1 } from "@mn/contracts";
import { InMemoryKernelStore } from "@mn/kernel";
import { createKernelAgentTurnHandler } from "@mn/worker";
import {
  createSignedRegistryMetadata,
  createPluginPackageArchive,
  sha256Hex,
  signPluginManifest,
  type PluginDefinitionV1,
  type RegistryMetadataV1,
} from "@mn/plugin-sdk";
import {
  createAgentOsHost,
  createEnterpriseFilePluginRepository,
  createSignedWorkerResolver,
  LocalSignedPluginRepository,
  PLUGIN_LOCK_PROJECTION,
  type ModelSecretStore,
} from "../src/index.js";

const NOW = "2026-09-04T12:00:00.000Z";
const secrets: ModelSecretStore = {
  async save(connectionId) { return `vault://muniu/v2/${connectionId}`; },
  async read() { return "test-key"; },
};

function signedRepository(options?: {
  readonly run?: PluginDefinitionV1["contributions"]["commands"][number]["run"];
}) {
  const root = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519");
  const packageBytes = Buffer.from("tenant-aware signed research plugin");
  const metadata = createSignedRegistryMetadata({
    schemaVersion: 1,
    sequence: 17,
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
    description: "整理租户内研究成果",
    entrypoints: { host: "./dist/host.js" },
    contributes: {
      routes: ["research.home"], navigation: [], widgets: [], commands: ["summarize"],
      agents: [], skills: [], workflows: [], tools: [], memorySchemas: [],
    },
    permissions: [],
    dataNamespace: "research",
    eventSchemas: {},
    projections: [],
    dependencies: [],
    packageSha256: sha256Hex(packageBytes),
    signature: { algorithm: "Ed25519", keyId: "release-1", value: "pending" },
    release: {
      sequence: 7,
      publishedAt: "2026-09-04T06:00:00.000Z",
      expiresAt: "2026-09-05T06:00:00.000Z",
      source: "https://plugins.muniu.example/research/1.2.3",
    },
    license: "Apache-2.0",
  } satisfies PluginManifestV1, release.privateKey);
  const definition: PluginDefinitionV1 = {
    id: manifest.id,
    version: manifest.version,
    official: false,
    trustBoundary: "process_equivalent",
    manifest,
    contributions: {
      routes: [{ id: "research.home", path: "/plugins/research" }],
      navigation: [], widgets: [], agents: [], skills: [], workflows: [], tools: [], memorySchemas: [],
      commands: [{
        id: "summarize",
        title: "生成摘要",
        run: options?.run ?? (async (input, context) => ({
          outcome: String(input.topic),
          workspaceScope: context.workspaceId,
        })),
      }],
    },
  };
  return {
    repository: new LocalSignedPluginRepository({
      metadata,
      releases: [{ manifest, packageBytes, definition }],
    }),
    trustedRoots: [{ keyId: "root-1", publicKey: root.publicKey }],
  };
}

function request(input: {
  readonly tenantId: string;
  readonly principalId: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly key?: string;
  readonly role?: "organization_admin" | "governance_admin";
}): Request {
  const headers = new Headers({
    "X-Tenant": input.tenantId,
    "X-Principal": input.principalId,
  });
  if (input.body !== undefined) headers.set("content-type", "application/json");
  if (input.key) headers.set("Idempotency-Key", input.key);
  if (input.role) headers.set("X-Organization-Role", input.role);
  return new Request(`http://host.test${input.path}`, {
    method: input.method ?? "GET",
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

async function body(response: Response): Promise<any> {
  return response.json();
}

test("企业签名插件的安装、贡献和工作区激活按租户隔离，并可由另一 Host 恢复", async () => {
  const store = new InMemoryKernelStore();
  const fixture = signedRepository();
  const options = {
    profile: "enterprise" as const,
    store,
    secretStore: secrets,
    now: () => NOW,
    pluginRepository: fixture.repository,
    trustedPluginRoots: fixture.trustedRoots,
    identityResolver(input: Request) {
      const role = input.headers.get("X-Organization-Role");
      return {
        tenantId: input.headers.get("X-Tenant") ?? "",
        principalId: input.headers.get("X-Principal") ?? "",
        organizationRoles: role === "organization_admin" || role === "governance_admin"
          ? [role as OrganizationRole]
          : [],
      };
    },
  };
  const hostA = await createAgentOsHost(options);
  const hostB = await createAgentOsHost(options);

  const installed = await hostA.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a", role: "governance_admin",
    path: "/v2/plugins/installations", method: "POST", key: "tenant-a-install",
    body: { pluginId: "research", version: "1.2.3" },
  }));
  assert.equal(installed.status, 201, await installed.clone().text());
  assert.equal(
    (await store.readEvents("tenant-a", 0, 100)).events
      .find((event) => event.type === "plugin.installed")?.actorId,
    "admin-a",
  );
  const replayedInstall = await hostB.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a", role: "governance_admin",
    path: "/v2/plugins/installations", method: "POST", key: "tenant-a-install",
    body: { pluginId: "research", version: "1.2.3" },
  }));
  assert.equal(replayedInstall.status, 201, await replayedInstall.clone().text());
  assert.deepEqual((await body(replayedInstall)).data, (await body(installed)).data);

  const tenantAList = await body(await hostA.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a", path: "/v2/plugins/installations",
  })));
  assert.ok(tenantAList.data.some((item: any) => item.pluginId === "research"));
  const tenantAListFromHostB = await body(await hostB.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a", path: "/v2/plugins/installations",
  })));
  assert.ok(tenantAListFromHostB.data.some((item: any) => item.pluginId === "research"));
  const tenantBList = await body(await hostA.dispatch(request({
    tenantId: "tenant-b", principalId: "admin-b", path: "/v2/plugins/installations",
  })));
  assert.ok(!tenantBList.data.some((item: any) => item.pluginId === "research"));
  assert.ok(await store.transact("tenant-a", (transaction) =>
    transaction.getProjection(PLUGIN_LOCK_PROJECTION, "current")));
  assert.equal(await store.transact("tenant-b", (transaction) =>
    transaction.getProjection(PLUGIN_LOCK_PROJECTION, "current")), undefined);
  const crossTenantGovernance = await hostA.dispatch(request({
    tenantId: "tenant-b", principalId: "admin-b", role: "governance_admin",
    path: "/v2/plugins/installations/research/disable", method: "POST", key: "tenant-b-disable-a",
    body: { expectedStreamVersion: 1 },
  }));
  assert.equal(crossTenantGovernance.status, 422);
  assert.equal((await body(crossTenantGovernance)).code, "PLUGIN_NOT_INSTALLED");

  const createA = await hostA.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a", role: "organization_admin",
    path: "/v2/workspaces", method: "POST", key: "tenant-a-workspace",
    body: { name: "A 研究", viewMode: "professional", pluginIds: ["research"] },
  }));
  assert.equal(createA.status, 201, await createA.clone().text());
  const workspaceA = (await body(createA)).data;

  const hiddenFromB = await hostA.dispatch(request({
    tenantId: "tenant-b", principalId: "admin-b", role: "organization_admin",
    path: "/v2/workspaces", method: "POST", key: "tenant-b-invalid-workspace",
    body: { name: "B 研究", viewMode: "professional", pluginIds: ["research"] },
  }));
  assert.equal(hiddenFromB.status, 422);
  assert.equal((await body(hiddenFromB)).code, "PLUGIN_NOT_INSTALLED");

  const commandA = await hostA.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a",
    path: "/v2/plugins/research/summarize", method: "POST", key: "tenant-a-command",
    body: { workspaceId: workspaceA.id, expectedStreamVersion: 0, topic: "A 的私有资料" },
  }));
  assert.equal(commandA.status, 200, await commandA.clone().text());
  assert.equal((await body(commandA)).data.outcome, "A 的私有资料");

  const recovered = await hostB.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a",
    path: "/v2/plugins/research/summarize", method: "POST", key: "tenant-a-command-host-b",
    body: { workspaceId: workspaceA.id, expectedStreamVersion: 0, topic: "跨 Host 恢复" },
  }));
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.equal((await body(recovered)).data.outcome, "跨 Host 恢复");

  const deactivated = await hostA.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a",
    path: `/v2/workspaces/${workspaceA.id}/plugin-activations/research`,
    method: "DELETE", key: "tenant-a-deactivate",
    body: { expectedStreamVersion: workspaceA.streamVersion },
  }));
  assert.equal(deactivated.status, 200, await deactivated.clone().text());
  const staleReplicaCommand = await hostB.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a",
    path: "/v2/plugins/research/summarize", method: "POST", key: "tenant-a-command-after-deactivate",
    body: { workspaceId: workspaceA.id, expectedStreamVersion: 0, topic: "不得执行" },
  }));
  assert.equal(staleReplicaCommand.status, 422);
  assert.equal((await body(staleReplicaCommand)).code, "PLUGIN_NOT_ACTIVE");

  const crossTenantWorkspace = await hostB.dispatch(request({
    tenantId: "tenant-b", principalId: "admin-b",
    path: `/v2/plugins/research/summarize`, method: "POST", key: "tenant-b-cross-tenant",
    body: { workspaceId: workspaceA.id, expectedStreamVersion: 0, topic: "越权" },
  }));
  assert.equal(crossTenantWorkspace.status, 404);

  await hostA.close();
  await hostB.close();
});

test("企业签名插件在一个 Host 排空时阻止另一 Host 接收新执行", async () => {
  const store = new InMemoryKernelStore();
  let releaseCommand!: () => void;
  let markCommandStarted!: () => void;
  const commandGate = new Promise<void>((resolve) => { releaseCommand = resolve; });
  const commandStarted = new Promise<void>((resolve) => { markCommandStarted = resolve; });
  const fixture = signedRepository({
    async run(input) {
      markCommandStarted();
      await commandGate;
      return { outcome: String(input.topic) };
    },
  });
  let releaseDrain!: () => void;
  let markDrainStarted!: () => void;
  const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const drainStarted = new Promise<void>((resolve) => { markDrainStarted = resolve; });
  const identityResolver = (input: Request) => {
    const role = input.headers.get("X-Organization-Role");
    return {
      tenantId: input.headers.get("X-Tenant") ?? "",
      principalId: input.headers.get("X-Principal") ?? "",
      organizationRoles: role === "organization_admin" || role === "governance_admin"
        ? [role as OrganizationRole]
        : [],
    };
  };
  const common = {
    profile: "enterprise" as const,
    store,
    secretStore: secrets,
    now: () => NOW,
    pluginRepository: fixture.repository,
    trustedPluginRoots: fixture.trustedRoots,
    identityResolver,
  };
  const hostA = await createAgentOsHost({
    ...common,
    tenantPluginExecutionControlFactory: () => ({
      async drain() {
        markDrainStarted();
        await drainGate;
      },
      async interruptAtSafeBoundary() {},
    }),
  });
  const hostB = await createAgentOsHost(common);

  const installed = await hostA.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a", role: "governance_admin",
    path: "/v2/plugins/installations", method: "POST", key: "distributed-install",
    body: { pluginId: "research", version: "1.2.3" },
  }));
  assert.equal(installed.status, 201, await installed.clone().text());
  const workspaceResponse = await hostA.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a", role: "organization_admin",
    path: "/v2/workspaces", method: "POST", key: "distributed-workspace",
    body: { name: "跨 Host 排空", viewMode: "professional", pluginIds: ["research"] },
  }));
  assert.equal(workspaceResponse.status, 201, await workspaceResponse.clone().text());
  const workspace = (await body(workspaceResponse)).data;

  const runningCommand = hostB.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a",
    path: "/v2/plugins/research/summarize", method: "POST", key: "distributed-running-command",
    body: { workspaceId: workspace.id, expectedStreamVersion: 0, topic: "先完成的请求" },
  }));
  await commandStarted;
  const busyDisable = await hostA.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a", role: "governance_admin",
    path: "/v2/plugins/installations/research/disable", method: "POST", key: "distributed-busy-disable",
    body: { expectedStreamVersion: 2 },
  }));
  assert.equal(busyDisable.status, 422, await busyDisable.clone().text());
  assert.equal((await body(busyDisable)).code, "PLUGIN_UPGRADE_INVALID");
  releaseCommand();
  assert.equal((await runningCommand).status, 200);

  const disabling = hostA.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a", role: "governance_admin",
    path: "/v2/plugins/installations/research/disable", method: "POST", key: "distributed-disable",
    body: { expectedStreamVersion: 2 },
  }));
  await drainStarted;

  const blocked = await hostB.dispatch(request({
    tenantId: "tenant-a", principalId: "admin-a",
    path: "/v2/plugins/research/summarize", method: "POST", key: "distributed-command",
    body: { workspaceId: workspace.id, expectedStreamVersion: 0, topic: "排空期间不得执行" },
  }));
  assert.equal(blocked.status, 422, await blocked.clone().text());
  assert.equal((await body(blocked)).code, "PLUGIN_NOT_ACTIVE");
  const readiness = await hostB.dispatch(new Request("http://host.test/v2/readiness"));
  assert.equal(readiness.status, 200);
  assert.ok((await body(readiness)).data.issues.some(
    (issue: any) => issue.code === "TENANT_PLUGIN_OPERATION_IN_PROGRESS",
  ));

  releaseDrain();
  const disabled = await disabling;
  assert.equal(disabled.status, 200, await disabled.clone().text());
  const operationEvents = (await store.readEvents("tenant-a", 0, 100)).events
    .filter((event) => event.aggregateType === "pluginOperation");
  assert.deepEqual(operationEvents.map((event) => event.type), [
    "plugin.operation_started",
    "plugin.operation_completed",
  ]);
  await hostA.close();
  await hostB.close();
});

test("企业 profile 拒绝复用无法证明租户边界的单例安装器", async () => {
  await assert.rejects(
    createAgentOsHost({
      profile: "enterprise",
      store: new InMemoryKernelStore(),
      secretStore: secrets,
      pluginInstaller: {
        async install() { throw new Error("不得调用"); },
      },
      identityResolver: () => ({ tenantId: "tenant-a", principalId: "admin-a" }),
    }),
    /企业 profile 必须使用租户化插件安装器工厂/u,
  );

  const store = new InMemoryKernelStore();
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    await store.transact(tenantId, (transaction) => {
      transaction.appendEvent({
        tenantId,
        aggregateType: "tenant",
        aggregateId: tenantId,
        expectedStreamVersion: 0,
        type: "tenant.fixture_created",
        actorId: "fixture",
        generation: 0,
        correlationId: `fixture-${tenantId}`,
        publicPayload: {},
      });
    });
  }
  const sharedInstaller = {
    async install(): Promise<never> { throw new Error("不得调用"); },
  };
  await assert.rejects(
    createAgentOsHost({
      profile: "enterprise",
      store,
      secretStore: secrets,
      tenantPluginInstallerFactory: () => sharedInstaller,
      identityResolver: () => ({ tenantId: "tenant-a", principalId: "admin-a" }),
    }),
    /不能复用租户 .* 的插件安装器实例/u,
  );
});

test("企业副本缺少租户 lock 对应制品时 readiness 失败，但核心健康接口可用", async () => {
  const store = new InMemoryKernelStore();
  const fixture = signedRepository();
  const identityResolver = (input: Request) => ({
    tenantId: input.headers.get("X-Tenant") ?? "",
    principalId: input.headers.get("X-Principal") ?? "",
    organizationRoles: ["governance_admin"] as const,
  });
  const incompleteReplica = await createAgentOsHost({
    profile: "enterprise",
    store,
    secretStore: secrets,
    identityResolver,
  });
  const seeded = await createAgentOsHost({
    profile: "enterprise",
    store,
    secretStore: secrets,
    now: () => NOW,
    pluginRepository: fixture.repository,
    trustedPluginRoots: fixture.trustedRoots,
    identityResolver,
  });
  const installed = await seeded.dispatch(request({
    tenantId: "tenant-a", principalId: "governance-a", role: "governance_admin",
    path: "/v2/plugins/installations", method: "POST", key: "seed-missing-repository",
    body: { pluginId: "research", version: "1.2.3" },
  }));
  assert.equal(installed.status, 201, await installed.clone().text());
  await seeded.close();
  const readiness = await incompleteReplica.dispatch(new Request("http://host.test/v2/readiness"));
  assert.equal(readiness.status, 503);
  assert.ok((await body(readiness)).data.issues.some(
    (issue: any) => issue.code === "TENANT_PLUGIN_REPOSITORY_REQUIRED",
  ));
  const health = await incompleteReplica.dispatch(new Request("http://host.test/v2/health"));
  assert.equal(health.status, 200);
  assert.equal((await body(health)).data.core.status, "healthy");
  const hidden = await incompleteReplica.dispatch(request({
    tenantId: "tenant-a", principalId: "governance-a", path: "/v2/plugins/installations",
  }));
  assert.equal(hidden.status, 422);
  assert.equal((await body(hidden)).code, "PLUGIN_REGISTRY_UNAVAILABLE");
  await incompleteReplica.close();
});

test("企业文件仓库只在完整验签后执行镜像内 Host 模块", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mn-enterprise-plugins-"));
  const evaluationKey = "__mnEnterprisePluginEvaluations";
  const source = Buffer.from(`
globalThis.${evaluationKey} = (globalThis.${evaluationKey} ?? 0) + 1;
export default (manifest) => ({
  id: manifest.id,
  version: manifest.version,
  official: false,
  trustBoundary: "process_equivalent",
  manifest,
  contributions: {
    routes: [{ id: "research.home", path: "/plugins/research" }],
    navigation: [], widgets: [], agents: [{ id: "research.reader", displayName: "研究员", description: "整理资料" }], skills: [], workflows: [], tools: [], memorySchemas: [],
    commands: [{ id: "summarize", title: "生成摘要", run: async (input) => ({ outcome: String(input.topic) }) }]
  }
});
`, "utf8");
  const uiSource = Buffer.from("export default () => ({ pages: [{ routeId: 'research.home', title: '研究', cards: [{ title: '摘要', body: '整理来源', commandId: 'summarize' }] }], widgets: [] });\n", "utf8");
  const cliSource = Buffer.from("export default () => ({ commands: [{ name: 'summarize', commandId: 'summarize', description: '整理来源', fields: [] }] });\n", "utf8");
  const workerSource = Buffer.from("export default () => ({ agents: [{ id: 'research.reader', instructions: '按来源整理研究结果', toolIds: [] }], tools: [] });\n", "utf8");
  const packageBytes = createPluginPackageArchive({
    "./dist/host.mjs": { content: source },
    "./dist/ui.mjs": { content: uiSource },
    "./dist/cli.mjs": { content: cliSource },
    "./dist/worker.mjs": { content: workerSource },
  });
  const root = generateKeyPairSync("ed25519");
  const release = generateKeyPairSync("ed25519");
  const metadata = createSignedRegistryMetadata({
    schemaVersion: 1,
    sequence: 21,
    issuedAt: "2026-09-04T06:00:00.000Z",
    expiresAt: "2026-09-05T06:00:00.000Z",
    keys: [{
      keyId: "release-1",
      publicKeySpki: release.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      notBefore: "2026-09-01T00:00:00.000Z",
      notAfter: "2027-09-01T00:00:00.000Z",
    }],
    revokedKeys: [], revokedReleases: [],
  }, "root-1", root.privateKey);
  const manifest = signPluginManifest({
    schemaVersion: 1,
    id: "research",
    version: "2.0.0",
    engineApi: "0.2.0",
    displayName: "企业研究助手",
    description: "镜像内签名插件",
    entrypoints: {
      host: "./dist/host.mjs",
      ui: "./dist/ui.mjs",
      cli: "./dist/cli.mjs",
      worker: "./dist/worker.mjs",
    },
    contributes: {
      routes: ["research.home"], navigation: [], widgets: [], commands: ["summarize"],
      agents: ["research.reader"], skills: [], workflows: [], tools: [], memorySchemas: [],
    },
    permissions: [], dataNamespace: "research", eventSchemas: {}, projections: [], dependencies: [],
    packageSha256: sha256Hex(packageBytes),
    signature: { algorithm: "Ed25519", keyId: "release-1", value: "pending" },
    release: {
      sequence: 9,
      publishedAt: "2026-09-04T06:00:00.000Z",
      expiresAt: "2026-09-05T06:00:00.000Z",
      source: "https://plugins.muniu.example/research/2.0.0",
    },
    license: "Apache-2.0",
  } satisfies PluginManifestV1, release.privateKey);
  const indexFile = join(directory, "index.json");
  const rootsFile = join(directory, "trusted-roots.json");
  await writeFile(join(directory, "research.mnplugin.json"), packageBytes);
  await writeFile(indexFile, JSON.stringify({
    schemaVersion: 1,
    metadata,
    releases: [{ manifest, packagePath: "research.mnplugin.json" }],
  }));
  await writeFile(rootsFile, JSON.stringify({
    schemaVersion: 1,
    roots: [{
      keyId: "root-1",
      publicKeySpki: root.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    }],
  }));

  try {
    (globalThis as any)[evaluationKey] = 0;
    const loaded = await createEnterpriseFilePluginRepository({
      indexFile,
      trustedRootsFile: rootsFile,
      now: () => new Date(NOW),
    });
    assert.equal((globalThis as any)[evaluationKey], 0, "读取索引不得执行插件代码");
    assert.deepEqual(
      Buffer.from((await loaded.pluginRepository.readEntrypoint("research", "2.0.0", "ui"))!),
      uiSource,
    );
    assert.deepEqual(
      Buffer.from((await loaded.pluginRepository.readEntrypoint("research", "2.0.0", "worker"))!),
      workerSource,
    );
    assert.equal((globalThis as any)[evaluationKey], 0, "读取非 Host 入口不得执行插件代码");
    const store = new InMemoryKernelStore();
    const host = await createAgentOsHost({
      profile: "enterprise",
      store,
      secretStore: secrets,
      now: () => NOW,
      ...loaded,
      modelProbe: async () => ({ models: ["deepseek-v4-flash"], defaultModel: "deepseek-v4-flash" }),
      identityResolver: () => ({
        tenantId: "tenant-a", principalId: "governance-a", organizationRoles: ["organization_admin", "governance_admin"],
      }),
    });
    assert.equal((globalThis as any)[evaluationKey], 0, "创建 Host 不得提前执行未安装插件");
    const installed = await host.dispatch(new Request("http://host.test/v2/plugins/installations", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "signed-file-install" },
      body: JSON.stringify({ pluginId: "research", version: "2.0.0" }),
    }));
    assert.equal(installed.status, 201, await installed.clone().text());
    assert.equal((globalThis as any)[evaluationKey], 1);
    const definition = await (await loaded.pluginRepository.read())!.releases[0]!.loadDefinition!();
    assert.equal(definition.surfaces?.ui?.pages[0]?.title, "研究");
    assert.equal(definition.surfaces?.cli?.commands[0]?.name, "summarize");
    const resolveWorker = createSignedWorkerResolver({ store, repository: loaded.pluginRepository });
    const execution = { tenantId: "tenant-a", pluginId: "research", pluginPackageSha256: manifest.packageSha256 } as any;
    assert.deepEqual(await resolveWorker(execution), { agents: [{ id: "research.reader", instructions: "按来源整理研究结果", toolIds: [] }], tools: [] });
    await assert.rejects(resolveWorker({ ...execution, tenantId: "tenant-b" }));
    await assert.rejects(resolveWorker({ ...execution, pluginPackageSha256: "0".repeat(64) }));
    let commandIndex = 0;
    const post = async (path: string, input: unknown) => {
      const response = await host.dispatch(new Request(`http://host.test${path}`, { method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": `signed-worker-${++commandIndex}` },
        body: JSON.stringify(input) }));
      assert.ok(response.ok, await response.clone().text());
      return (await response.json() as any).data;
    };
    const workspace = await post("/v2/workspaces", { name: "签名 Worker", pluginIds: ["research"], viewMode: "business" });
    const model = await post("/v2/model-connections", { presetId: "deepseek", apiKey: "fixture-key" });
    await post(`/v2/model-connections/${model.id}/probe`, { expectedStreamVersion: model.streamVersion });
    const thread = await post(`/v2/workspaces/${workspace.id}/threads`, { subject: "研究资料", pluginId: "research" });
    const submitted = await post(`/v2/workspaces/${workspace.id}/threads/${thread.id}/turns`, {
      expectedStreamVersion: thread.streamVersion, message: "整理来源", agentDefinitionId: "research.reader",
    });
    assert.equal(submitted.pluginPackageSha256, manifest.packageSha256);
    const job = store.readJobs("tenant-a").find((entry) => entry.payload.executionId === submitted.id)!;
    let modelCalls = 0;
    const unclaimed = async (): Promise<never> => { throw new Error("该测试直接调用 handler，不应操作物理租约"); };
    const handler = createKernelAgentTurnHandler({ store: {
      transact: store.transact.bind(store), readEvents: store.readEvents.bind(store),
      claimJob: unclaimed, completeJob: unclaimed, failJob: unclaimed, interruptJob: unclaimed,
      renewJobLease: unclaimed, markNeedsReconciliation: unclaimed,
    }, secretStore: secrets, resolvePluginWorker: resolveWorker,
      approvalKernel: host.kernel, acceptsSecretReference: (reference) => reference.startsWith("vault://muniu/v2/"),
      modelInvoker: async ({ request: modelRequest }) => {
        modelCalls += 1;
        assert.match(modelRequest.messages[0]?.content ?? "", /按来源整理研究结果/u);
        assert.deepEqual(modelRequest.availableToolIds, []);
        return { text: "研究结果已整理", toolCalls: [], usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 } };
      },
      modelQuoter: async () => ({ inputTokenLimit: 100, maxOutputTokens: 100,
        rates: { id: "non-billable-fixture", currency: "CNY", inputNanoMinorUnitsPerToken: "0",
          cachedInputNanoMinorUnitsPerToken: "0", outputNanoMinorUnitsPerToken: "0" } }),
    });
    const result = await handler({ ...job, status: "leased", attempts: 1, fencingToken: 1,
      createdAt: NOW, updatedAt: NOW, leaseOwner: "worker", leaseExpiresAt: "2026-09-04T12:00:30.000Z" },
      { workerId: "worker", fencingToken: 1, leaseExpiresAt: "2026-09-04T12:00:30.000Z", signal: new AbortController().signal });
    assert.equal(modelCalls, 1);
    assert.deepEqual(result, { executionId: submitted.id, status: "completed" });
    const { signature: _registrySignature, ...unsignedRegistry } = metadata;
    const revokedMetadata = createSignedRegistryMetadata({ ...unsignedRegistry, sequence: metadata.sequence + 1,
      revokedReleases: [{ pluginId: manifest.id, packageSha256: manifest.packageSha256, revokedAt: NOW, reason: "release withdrawn" }] },
      "root-1", root.privateKey);
    await writeFile(indexFile, JSON.stringify({ schemaVersion: 1, metadata: revokedMetadata,
      releases: [{ manifest, packagePath: "research.mnplugin.json" }] }));
    assert.equal((await loaded.pluginRepository.read())?.metadata.sequence, metadata.sequence + 1, "文件仓库必须读取新的签名撤销元数据");
    const revokedList = await host.dispatch(new Request("http://host.test/v2/plugins/installations"));
    assert.equal(revokedList.status, 200);
    assert.equal((await revokedList.json() as any).data.find((item: any) => item.pluginId === "research").status, "revoked");
    assert.equal((globalThis as any)[evaluationKey], 1, "处理撤销不得再次执行插件模块");
    await host.close();

    await writeFile(indexFile, JSON.stringify({ schemaVersion: 1, metadata,
      releases: [{ manifest, packagePath: "research.mnplugin.json" }] }));

    (globalThis as any)[evaluationKey] = 0;
    await writeFile(
      join(directory, "research.mnplugin.json"),
      Buffer.concat([packageBytes, Buffer.from("\n")]),
    );
    await assert.rejects(createEnterpriseFilePluginRepository({
      indexFile,
      trustedRootsFile: rootsFile,
      now: () => new Date(NOW),
    }), /摘要与清单不一致/u);
    assert.equal((globalThis as any)[evaluationKey], 0, "摘要不匹配时不得执行模块");
  } finally {
    delete (globalThis as any)[evaluationKey];
    await rm(directory, { recursive: true, force: true });
  }
});
