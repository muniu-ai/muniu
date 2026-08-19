// SPDX-License-Identifier: Apache-2.0

import { Context, FiberState } from "@deepseek-ai/cordis";
import Group from "@deepseek-ai/cordis-plugin-group";
import Hmr from "@deepseek-ai/cordis-plugin-hmr";
import Include from "@deepseek-ai/cordis-plugin-include";
import Loader, { type EntryOptions } from "@deepseek-ai/cordis-plugin-loader";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeAuditLog } from "./audit.js";
import { digestRuntimeValue } from "./canonical.js";
import { coreRuntimePlugin } from "./core-plugin.js";
import type {
  BootRuntimeOptions,
  RuntimeAuditEvent,
  RuntimePluginSnapshot,
  RuntimeScopeMetadata,
  RuntimeSnapshot
} from "./types.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    readonly muniuScope: RuntimeScopeMetadata;
  }

  interface Events {
    "muniu/runtime-audit"(event: RuntimeAuditEvent): void;
  }
}

const STATE_NAMES = {
  [FiberState.PENDING]: "pending",
  [FiberState.LOADING]: "loading",
  [FiberState.ACTIVE]: "active",
  [FiberState.FAILED]: "failed",
  [FiberState.UNLOADING]: "unloading",
  [FiberState.DISPOSED]: "disposed"
} as const;

function pluginIdentity(fiber: Context["fiber"]): {
  pluginId?: string;
  pluginName?: string;
  configDigest?: string;
} {
  const entry = fiber.entry;
  return {
    ...(entry?.options.id || entry?.id ? { pluginId: entry?.options.id ?? entry?.id } : {}),
    ...(entry?.options.name || fiber.runtime?.name
      ? { pluginName: entry?.options.name ?? fiber.runtime?.name }
      : {}),
    ...(fiber.config === undefined
      ? {}
      : { configDigest: digestRuntimeValue(fiber.config) })
  };
}

function lifecycleEvent(state: FiberState) {
  switch (state) {
    case FiberState.PENDING:
    case FiberState.LOADING:
      return "plugin.loading" as const;
    case FiberState.ACTIVE:
      return "plugin.loaded" as const;
    case FiberState.FAILED:
      return "plugin.failed" as const;
    case FiberState.UNLOADING:
      return "plugin.unloading" as const;
    case FiberState.DISPOSED:
      return "plugin.unloaded" as const;
  }
}

function listPlugins(context: Context): RuntimePluginSnapshot[] {
  const plugins: RuntimePluginSnapshot[] = [];
  for (const entry of context.loader.entries()) {
    plugins.push({
      id: entry.options.id ?? entry.id,
      name: entry.options.name,
      state: entry.fiber ? STATE_NAMES[entry.fiber.state] : "pending",
      configDigest: digestRuntimeValue(entry.options.config ?? null)
    });
  }
  return plugins;
}

function listServices(context: Context): string[] {
  const services = new Set<string>();
  for (const runtime of context.registry.values()) {
    for (const fiber of runtime.fibers) {
      for (const dependency of Object.keys(fiber.inject)) services.add(dependency);
      const name = runtime.name;
      if (name) services.add(name);
    }
  }
  services.add("loader");
  return [...services].sort();
}

export interface MuniuRuntime {
  readonly context: Context;
  readonly audit: RuntimeAuditLog;
  readonly snapshot: RuntimeSnapshot;
  dispose(): Promise<void>;
}

export async function bootRuntime(options: BootRuntimeOptions): Promise<MuniuRuntime> {
  const metadata: RuntimeScopeMetadata = Object.freeze({
    scope: options.scope,
    profileId: options.profileId
  });
  const context = new Context().extend({ muniuScope: metadata });
  const audit = new RuntimeAuditLog(metadata, options.auditSink);
  const record = (type: Parameters<RuntimeAuditLog["record"]>[0], detail?: Parameters<RuntimeAuditLog["record"]>[1]) => {
    const event = audit.record(type, detail);
    context.emit("muniu/runtime-audit", event);
  };

  context.on("internal/status", (fiber) => {
    const type = lifecycleEvent(fiber.state);
    if (type) record(type, pluginIdentity(fiber));
  }, { global: true });

  const profileLayers = options.profileLayers ?? (options.profilePath
    ? [{ id: "deployment-profile", path: options.profilePath }]
    : []);
  const primaryProfilePath = profileLayers[0]?.path ?? options.profilePath;
  const profileBaseUrl = primaryProfilePath
    ? `${pathToFileURL(dirname(primaryProfilePath)).href}/`
    : pathToFileURL(`${process.cwd()}/`).href;
  context.baseUrl = profileBaseUrl;
  await context.plugin(Loader, { baseUrl: profileBaseUrl });
  context.loader.builtins.include = Include;
  context.loader.builtins.group = Group;
  context.loader.builtins["muniu-core"] = coreRuntimePlugin;

  if (options.enableHmr) {
    await context.plugin(Timer);
    await context.plugin(Hmr, {
      base: dirname(primaryProfilePath ?? process.cwd()),
      root: profileLayers.length > 0
        ? profileLayers.map((layer) => dirname(layer.path))
        : [dirname(primaryProfilePath ?? process.cwd())],
      ignored: ["**/node_modules", "**/.*", "dist", "dist-test"],
      debounce: options.hmrDebounceMs ?? 100
    });
  }

  for (const layer of profileLayers) {
    if (!layer.id.trim()) throw new TypeError("runtime profile layer id must not be empty");
    const includeConfig = {
      path: pathToFileURL(layer.path).href,
      enableLogs: true
    };
    const rootInclude: EntryOptions = {
      id: `profile-${layer.id.replace(/[^A-Za-z0-9._-]/gu, "-")}`,
      name: "cordis:include",
      config: includeConfig
    };
    await context.loader.create(rootInclude);
    await context.loader.await();
  }

  const plugins = listPlugins(context);
  const profileDigest = digestRuntimeValue({
    profileId: options.profileId,
    layers: profileLayers.map((layer) => layer.id),
    plugins: plugins.map(({ id, name, configDigest }) => ({ id, name, configDigest }))
  });
  const snapshot: RuntimeSnapshot = Object.freeze({
    schemaVersion: 1,
    scope: options.scope,
    profileId: options.profileId,
    profileDigest,
    plugins: Object.freeze(plugins),
    serviceGraph: Object.freeze(listServices(context)),
    generatedAt: new Date().toISOString()
  });
  record("runtime.started", { detail: profileDigest });

  let disposal: Promise<void> | undefined;
  return {
    context,
    audit,
    snapshot,
    dispose() {
      disposal ??= context.fiber.dispose().finally(() => {
        const unloaded = new Set(
          audit.list()
            .filter((event) => event.type === "plugin.unloaded" && event.pluginId)
            .map((event) => event.pluginId)
        );
        for (const plugin of snapshot.plugins) {
          if (unloaded.has(plugin.id)) continue;
          audit.record("plugin.unloaded", {
            pluginId: plugin.id,
            pluginName: plugin.name,
            configDigest: plugin.configDigest
          });
        }
        audit.record("runtime.stopped", { detail: profileDigest });
      });
      return disposal;
    }
  };
}

export function createSessionContext(root: Context, sessionId: string): Context {
  if (!sessionId.trim()) throw new TypeError("sessionId must not be empty");
  let context = root;
  for (const service of ["muniuSession", "agentHost", "agentSession", "toolRegistry", "modelRuntime"]) {
    context = context.isolate(service);
  }
  return context.extend({
    muniuScope: Object.freeze({
      scope: "session",
      profileId: root.muniuScope.profileId,
      sessionId
    })
  });
}
