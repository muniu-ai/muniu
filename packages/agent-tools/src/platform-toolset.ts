// SPDX-License-Identifier: Apache-2.0

import type { ToolDefinition } from "./define-tool.js";
import { createPlatformBridgeTools, type PlatformToolAdapters } from "./platform-tools.js";
import { createProcessTools, type ProcessSupervisor } from "./process-tools.js";
import { createWorkspaceTools, type WorkspaceToolOptions } from "./workspace-tools.js";

export interface PlatformToolsetOptions {
  readonly workspace?: WorkspaceToolOptions;
  readonly processes?: ProcessSupervisor;
  readonly adapters?: PlatformToolAdapters;
}

export function createPlatformTools(options: PlatformToolsetOptions = {}): readonly ToolDefinition[] {
  return Object.freeze([
    ...createWorkspaceTools(options.workspace),
    ...(options.processes === undefined ? [] : createProcessTools(options.processes)),
    ...createPlatformBridgeTools(options.adapters ?? {})
  ]);
}
