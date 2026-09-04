import { homedir } from "node:os";
import { FileCas, SqliteStorage } from "@mn/storage";
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

export interface StartLocalHostOptions extends Omit<Partial<AgentOsHostOptions>, "store" | "cas" | "secretStore"> {
  readonly homeDirectory?: string;
  readonly stateRoot?: string;
  readonly legacyDaemonProbe?: LegacyDaemonProbe;
  readonly host?: string;
  readonly port?: number;
}

export async function startLocalAgentOsHost(options: StartLocalHostOptions = {}): Promise<AgentOsHost> {
  await assertNoLegacyDaemon(options.legacyDaemonProbe);
  const configuredRoot = options.stateRoot ?? process.env[STATE_ROOT_ENV];
  const paths = configuredRoot
    ? localStatePaths(configuredRoot)
    : defaultLocalStatePaths(options.homeDirectory ?? homedir());
  const secretStore = new MacOsKeychainSecretStore();
  const hmacKey = await secretStore.getOrCreateBytes("event-hmac", 32);
  const store = new SqliteStorage({ databaseFile: paths.database, hmacKey });
  const host = await createAgentOsHost({
    store,
    cas: new FileCas({ rootDir: paths.cas }),
    secretStore,
    ...(options.modelProbe ? { modelProbe: options.modelProbe } : {}),
    ...(options.officialPlugins ? { officialPlugins: options.officialPlugins } : {}),
    ...(options.pluginInstaller ? { pluginInstaller: options.pluginInstaller } : {}),
    ...(options.readiness ? { readiness: options.readiness } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.id ? { id: options.id } : {}),
  });
  await host.listen({ host: options.host ?? "127.0.0.1", port: options.port ?? DEFAULT_HOST_PORT });
  return host;
}
