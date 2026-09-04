import { homedir } from "node:os";
import { FileCas, SqliteStorage } from "@mn/storage";
import {
  AgentOsWorker,
  createKernelAgentTurnHandler,
  runWorkerLoop,
  type ByokModelInvoker,
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
  readonly workerId?: string;
  readonly workerIdleDelayMs?: number;
}

export async function startLocalAgentOsHost(options: StartLocalHostOptions = {}): Promise<AgentOsHost> {
  await assertNoLegacyDaemon(options.legacyDaemonProbe);
  const configuredRoot = options.stateRoot ?? process.env[STATE_ROOT_ENV];
  const paths = configuredRoot
    ? localStatePaths(configuredRoot)
    : defaultLocalStatePaths(options.homeDirectory ?? homedir());
  const secretStore = options.secretStore ?? new MacOsKeychainSecretStore();
  const hmacKey = await secretStore.getOrCreateBytes("event-hmac", 32);
  const store = new SqliteStorage({ databaseFile: paths.database, hmacKey });
  const stopWorker = new AbortController();
  let workerFailure: unknown;
  let workerLoop = Promise.resolve();
  const host = await createAgentOsHost({
    store,
    profile: "local",
    cas: new FileCas({ rootDir: paths.cas }),
    secretStore,
    ...(options.modelProbe ? { modelProbe: options.modelProbe } : {}),
    ...(options.officialPlugins ? { officialPlugins: options.officialPlugins } : {}),
    ...(options.pluginInstaller ? { pluginInstaller: options.pluginInstaller } : {}),
    readiness: async () => {
      const base = await options.readiness?.() ?? { ready: true, issues: [] };
      const issues = workerFailure === undefined
        ? base.issues
        : [...base.issues, {
          code: "LOCAL_WORKER_UNAVAILABLE",
          message: "本地 Worker 已停止",
          action: "重新启动木牛 Agent OS",
        }];
      return { ready: base.ready && workerFailure === undefined, issues };
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.id ? { id: options.id } : {}),
    beforeStoreClose: async () => {
      stopWorker.abort();
      await workerLoop;
    },
  });
  try {
    await host.listen({ host: options.host ?? "127.0.0.1", port: options.port ?? DEFAULT_HOST_PORT });
  } catch (error) {
    await host.close();
    throw error;
  }
  const turnHandler = createKernelAgentTurnHandler({
    store,
    secretStore,
    ...(options.modelInvoker ? { modelInvoker: options.modelInvoker } : {}),
    acceptsSecretReference: (reference) => reference.startsWith("keychain://muniu.v2/"),
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
    handlers: { "agent.execution.run": turnHandler },
    tenantId: "local",
    kinds: ["agent.execution.run"],
  });
  workerLoop = runWorkerLoop(worker, {
    signal: stopWorker.signal,
    ...(options.workerIdleDelayMs ? { idleDelayMs: options.workerIdleDelayMs } : {}),
  }).catch((error: unknown) => {
    workerFailure = error;
  });
  return host;
}
