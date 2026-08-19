// SPDX-License-Identifier: Apache-2.0

import type { Context } from "@deepseek-ai/cordis";
import type { RuntimeProfileId, RuntimeScope } from "./types.js";

interface CoreRuntimePluginConfig {
  readonly scope: RuntimeScope;
  readonly profileId: RuntimeProfileId;
  readonly serviceName?: string;
  readonly components?: readonly string[];
}

/** First-party runtime metadata plugin embedded in every Muniu host. */
export function coreRuntimePlugin(
  context: Context,
  config: CoreRuntimePluginConfig
): void {
  const descriptor = Object.freeze({
    schemaVersion: 1 as const,
    scope: config.scope,
    profileId: config.profileId,
    components: Object.freeze([...(config.components ?? [])])
  });
  const serviceName = config.serviceName ?? "muniuRuntimeDescriptor";
  context.provide(serviceName, descriptor);
  context.effect(() => () => context.set(serviceName, undefined));
}
