import { homedir } from "node:os";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { acquireLocalStateLock, FileCas, MacOsKeychainKeyProvider, SqliteStorage } from "@mn/storage";
import { createNodePublicWebReader } from "@mn/plugin-opc";
import {
  AgentOsWorker,
  createCodingReconciliationVerificationWorkerHandler,
  createCodingSandboxCleanupWorkerHandler,
  createEncryptedMemoryReader,
  createKernelAgentTurnHandler,
  createBusinessActionWorkerHandler,
  createBusinessCandidateWorkerHandler,
  loadBusinessProviderConfiguration,
  runWorkerLoop,
  type ByokModelInvoker,
  type ByokModelQuoter,
  type OpcPublicWebReader,
} from "@mn/worker";
import {
  assertNoLegacyDaemon,
  defaultLocalStatePaths,
  DEFAULT_HOST_PORT,
  localStatePaths,
  STATE_ROOT_ENV,
  type LegacyDaemonProbe,
} from "./config.js";
import { createAgentOsHost, type AgentOsHost, type AgentOsHostOptions } from "./host.js";
import { MacOsKeychainSecretStore } from "./secrets.js";
import { createSignedWorkerResolver } from "./plugin-worker.js";
import { createOpcModelContextReader } from "./opc-model-context.js";
import { createEnterpriseFilePluginRepository } from "./enterprise-plugin-repository.js";
import type { ModelSecretStore } from "./secrets.js";

const LOCAL_WORKER_LOCK = "agent-os-0.2-local-bundle";

export interface LocalAgentOsSecretStore extends ModelSecretStore {
  getOrCreateBytes(account: string, byteLength?: number): Promise<Buffer>;
}

export interface StartLocalHostOptions extends Omit<
  Partial<AgentOsHostOptions>,
  "store" | "cas" | "secretStore" | "profile" | "beforeStoreClose"
> {
  readonly homeDirectory?: string;
  readonly stateRoot?: string;
  readonly legacyDaemonProbe?: LegacyDaemonProbe;
  readonly host?: string;
  readonly port?: number;
  readonly secretStore?: LocalAgentOsSecretStore;
  readonly modelInvoker?: ByokModelInvoker;
  readonly modelQuoter?: ByokModelQuoter;
  readonly workerId?: string;
  readonly workerIdleDelayMs?: number;
  readonly opcPublicWebReader?: OpcPublicWebReader;
}

export async function startLocalAgentOsHost(options: StartLocalHostOptions = {}): Promise<AgentOsHost> {
  await assertNoLegacyDaemon(options.legacyDaemonProbe);
  const business = options.businessProvider ? {
    businessProvider: options.businessProvider,
    ...(options.businessWorkspaceScopes ? { businessWorkspaceScopes: options.businessWorkspaceScopes } : {}),
    ...(options.businessAuthorityTokenResolver ? { businessAuthorityTokenResolver: options.businessAuthorityTokenResolver } : {}),
  } : await loadBusinessProviderConfiguration("local");
  const indexFile = process.env.MN_PLUGIN_REPOSITORY_INDEX?.trim();
  const trustedRootsFile = process.env.MN_PLUGIN_TRUSTED_ROOTS?.trim();
  if (Boolean(indexFile) !== Boolean(trustedRootsFile)) throw new Error("插件仓库索引和受信根必须同时配置");
  const configuredPlugins = !options.pluginRepository && indexFile && trustedRootsFile
    ? await createEnterpriseFilePluginRepository({ indexFile, trustedRootsFile }) : undefined;
  const pluginRepository = options.pluginRepository ?? configuredPlugins?.pluginRepository;
  const trustedPluginRoots = options.trustedPluginRoots ?? configuredPlugins?.trustedPluginRoots;
  const configuredRoot = options.stateRoot ?? process.env[STATE_ROOT_ENV];
  const paths = configuredRoot
    ? localStatePaths(configuredRoot)
    : defaultLocalStatePaths(options.homeDirectory ?? homedir());
  const stateLock = await acquireLocalStateLock(paths.root);
  let ownedStore: SqliteStorage | undefined;
  let ownedHost: AgentOsHost | undefined;
  try {
    const pendingRestore = await lstat(join(paths.root, ".restore-pending")).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (pendingRestore) throw new Error("恢复目录尚未完成验证，不能启动；请重新从备份恢复到新的状态目录");
    const secretStore = options.secretStore ?? new MacOsKeychainSecretStore();
    const hmacKey = await secretStore.getOrCreateBytes("event-hmac", 32);
    const store = new SqliteStorage({ databaseFile: paths.database, hmacKey });
    ownedStore = store;
    const cas = new FileCas({ rootDir: paths.cas });
    const protectedPayloadKeyProvider = options.protectedPayloadKeyProvider
      ?? new MacOsKeychainKeyProvider({ account: "protected-payload-wrapping-key", individuallyRevocable: true });
    let maintenanceFailed = false;
    try { await store.gcLocalOrphans({ lock: stateLock, keyProvider: protectedPayloadKeyProvider }); }
    catch {
      maintenanceFailed = true;
      process.stderr.write('{"code":"LOCAL_CAS_MAINTENANCE_FAILED","message":"CAS 校验或清理未完成；核心页面仍可使用，请检查本地存储"}\n');
    }
    const stopWorker = new AbortController();
    let workerFailure: unknown;
    let workerLoop = Promise.resolve();
    const host = await createAgentOsHost({
      ...business,
      store,
      profile: "local",
      cas,
      protectedPayloadKeyProvider,
      secretStore,
      ...(options.modelProbe ? { modelProbe: options.modelProbe } : {}),
      ...(options.officialPlugins ? { officialPlugins: options.officialPlugins } : {}),
      ...(options.pluginInstaller ? { pluginInstaller: options.pluginInstaller } : {}),
      ...(pluginRepository ? { pluginRepository } : {}),
      ...(trustedPluginRoots ? { trustedPluginRoots } : {}),
      ...(options.pluginExecutionControl ? { pluginExecutionControl: options.pluginExecutionControl } : {}),
      ...(options.pluginProjections ? { pluginProjections: options.pluginProjections } : {}),
      ...(options.runnerIdentityInspector ? { runnerIdentityInspector: options.runnerIdentityInspector } : {}),
      readiness: async () => {
        const base = await options.readiness?.() ?? { ready: true, issues: [] };
        const issues = [...base.issues, ...(maintenanceFailed ? [{
          code: "LOCAL_CAS_MAINTENANCE_FAILED", message: "本地 CAS 校验或清理未完成",
          action: "检查 v2 Keychain、状态目录权限和备份；不要手工删除 CAS 对象",
        }] : []), ...(workerFailure === undefined ? [] : [{
            code: "LOCAL_WORKER_UNAVAILABLE",
            message: "本地 Worker 已停止",
            action: "重新启动木牛 Agent OS",
          }])];
        return { ready: base.ready && workerFailure === undefined && !maintenanceFailed, issues };
      },
      ...(options.now ? { now: options.now } : {}),
      ...(options.id ? { id: options.id } : {}),
      beforeStoreClose: async () => {
        stopWorker.abort();
        await workerLoop;
      },
    });
    ownedHost = host;
    const closeHost = host.close.bind(host);
    host.close = async () => { await closeHost(); stateLock.release(); };
    try {
      await host.listen({ host: options.host ?? "127.0.0.1", port: options.port ?? DEFAULT_HOST_PORT });
    } catch (error) {
      await host.close();
      throw error;
    }
    const turnHandler = createKernelAgentTurnHandler({
      scopeContext: host.context,
      resolveThreadContext: createOpcModelContextReader({ store, cas, protectedPayloadKeyProvider }),
      ...(pluginRepository ? { resolvePluginWorker: createSignedWorkerResolver({ store, repository: pluginRepository }) } : {}),
      store,
      secretStore,
      approvalKernel: host.kernel,
      runtimeProtection: { cas, keyProvider: protectedPayloadKeyProvider },
      memoryReader: createEncryptedMemoryReader({
        store,
        cas,
        keyProvider: protectedPayloadKeyProvider,
      }),
      opcPublicWebReader: options.opcPublicWebReader ?? createNodePublicWebReader(),
      codingSandboxRoot: join(paths.root, "sandboxes", "coding"),
      ...(options.modelInvoker ? { modelInvoker: options.modelInvoker } : {}),
      ...(options.modelQuoter ? { modelQuoter: options.modelQuoter } : {}),
      acceptsSecretReference: (reference) => reference.startsWith("keychain://muniu.v2/"),
      ...(options.now ? { now: options.now } : {}),
    });
    const sandboxCleanupHandler = createCodingSandboxCleanupWorkerHandler({
      store,
      sandboxRoot: join(paths.root, "sandboxes", "coding"),
      ...(options.now ? { now: options.now } : {}),
    });
    const reconciliationVerificationHandler = createCodingReconciliationVerificationWorkerHandler({
      runtimeProtection: { cas, keyProvider: protectedPayloadKeyProvider },
      store,
      sandboxRoot: join(paths.root, "sandboxes", "coding"),
      ...(options.now ? { now: options.now } : {}),
    });
    const worker = new AgentOsWorker({
      id: options.workerId ?? `local-${process.pid}`,
      store,
      lock: {
        engineLockDigest: LOCAL_WORKER_LOCK,
        expectedEngineLockDigest: LOCAL_WORKER_LOCK,
        pluginLockDigest: LOCAL_WORKER_LOCK,
        expectedPluginLockDigest: LOCAL_WORKER_LOCK,
      },
      handlers: {
        "agent.execution.run": turnHandler,
        "coding.reconciliation.verify": reconciliationVerificationHandler,
        "coding.sandbox.cleanup": sandboxCleanupHandler,
        ...(business?.businessProvider ? { "business.action.execute": createBusinessActionWorkerHandler({
          store, kernel: host.kernel, ports: business.businessProvider, ...(options.now ? { now: options.now } : {}),
        }) } : {}),
        ...(business?.businessProvider.inquiries ? { "business.candidate.extract": createBusinessCandidateWorkerHandler({
          store, secretStore, runtimeProtection: { cas, keyProvider: protectedPayloadKeyProvider },
          acceptsSecretReference: reference => reference.startsWith("keychain://muniu.v2/"),
          ...(options.modelInvoker ? { modelInvoker: options.modelInvoker } : {}),
          ...(options.modelQuoter ? { modelQuoter: options.modelQuoter } : {}),
          ...(options.now ? { now: options.now } : {}),
        }) } : {}),
      },
      tenantId: "local",
      kinds: ["agent.execution.run", "coding.reconciliation.verify", "coding.sandbox.cleanup",
        ...(business?.businessProvider ? ["business.action.execute"] : []),
        ...(business?.businessProvider.inquiries ? ["business.candidate.extract"] : [])],
    });
    workerLoop = runWorkerLoop(worker, {
      signal: stopWorker.signal,
      ...(options.workerIdleDelayMs ? { idleDelayMs: options.workerIdleDelayMs } : {}),
    }).catch((error: unknown) => {
      workerFailure = error;
    });
    return host;
  } catch (error) {
    if (ownedHost) await ownedHost.close(); else await ownedStore?.close();
    stateLock.release();
    throw error;
  }
}
