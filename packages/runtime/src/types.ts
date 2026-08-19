// SPDX-License-Identifier: Apache-2.0

import type { EntryOptions } from "@deepseek-ai/cordis-plugin-loader";

export type RuntimeScope = "api" | "worker" | "desktop" | "session";

export type RuntimeProfileId =
  | "local"
  | "enterprise-api"
  | "enterprise-worker"
  | "desktop"
  | (string & {});

export interface RuntimeScopeMetadata {
  readonly scope: RuntimeScope;
  readonly profileId: RuntimeProfileId;
  readonly sessionId?: string;
}

export interface RuntimeProfileEntry extends EntryOptions {
  readonly id: string;
}

export interface RuntimeProfileLayer {
  readonly id: string;
  readonly entries: readonly RuntimeProfileEntry[];
}

export interface ResolvedRuntimeProfile {
  readonly layers: readonly string[];
  readonly entries: readonly RuntimeProfileEntry[];
  readonly digest: string;
}

export type RuntimeAuditEventType =
  | "runtime.started"
  | "runtime.stopped"
  | "plugin.loading"
  | "plugin.loaded"
  | "plugin.failed"
  | "plugin.unloading"
  | "plugin.unloaded"
  | "plugin.configured";

export interface RuntimeAuditEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: RuntimeAuditEventType;
  readonly scope: RuntimeScope;
  readonly profileId: RuntimeProfileId;
  readonly pluginId?: string;
  readonly pluginName?: string;
  readonly configDigest?: string;
  readonly detail?: string;
}

export interface RuntimePluginSnapshot {
  readonly id: string;
  readonly name: string;
  readonly state: "pending" | "loading" | "active" | "failed" | "unloading" | "disposed";
  readonly configDigest: string;
}

export interface RuntimeSnapshot {
  readonly schemaVersion: 1;
  readonly scope: RuntimeScope;
  readonly profileId: RuntimeProfileId;
  readonly profileDigest: string;
  readonly plugins: readonly RuntimePluginSnapshot[];
  readonly serviceGraph: readonly string[];
  readonly generatedAt: string;
}

export interface BootRuntimeOptions {
  readonly scope: Exclude<RuntimeScope, "session">;
  readonly profileId: RuntimeProfileId;
  readonly profilePath?: string;
  /** Ordered executable configuration layers. Later layers may replace ids. */
  readonly profileLayers?: readonly {
    readonly id: string;
    readonly path: string;
  }[];
  readonly enableHmr?: boolean;
  readonly hmrDebounceMs?: number;
  readonly auditSink?: (event: RuntimeAuditEvent) => void | Promise<void>;
}
