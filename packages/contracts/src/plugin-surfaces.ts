// SPDX-License-Identifier: Apache-2.0
import type { JsonObject, JsonValue } from "./json.js";
import type { ResourceRef, ToolEffectClass } from "./models.js";

export interface PluginInputFieldV1 {
  readonly name: string;
  readonly label?: string;
  readonly type: "string" | "number" | "boolean";
  readonly required?: boolean;
}
export interface PluginCardV1 {
  readonly title: string;
  readonly body: string;
  readonly commandId?: string;
  readonly fields?: readonly PluginInputFieldV1[];
}
export interface PluginUiV1 {
  readonly pages: readonly { readonly routeId: string; readonly title: string; readonly cards: readonly PluginCardV1[] }[];
  readonly widgets: readonly { readonly widgetId: string; readonly card: PluginCardV1 }[];
}
export interface PluginCliV1 {
  readonly commands: readonly {
    readonly name: string;
    readonly commandId: string;
    readonly description: string;
    readonly fields: readonly PluginInputFieldV1[];
  }[];
}
export interface PluginSurfacesV1 {
  readonly ui?: PluginUiV1;
  readonly cli?: PluginCliV1;
}
export interface WorkspacePluginSurfaceV1 extends PluginSurfacesV1 {
  readonly pluginId: string;
  readonly version: string;
  readonly navigation: readonly { readonly id: string; readonly label: string; readonly routeId: string; readonly order?: number }[];
}
export interface PluginWorkerContextV1 {
  readonly executionId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}
export interface PluginWorkerToolV1 {
  readonly id: string;
  readonly version: string;
  readonly effectClass: ToolEffectClass;
  prepare(arguments_: JsonObject, context: PluginWorkerContextV1): Promise<{ readonly normalizedArguments: JsonObject; readonly resourceRefs: readonly ResourceRef[] }> | { readonly normalizedArguments: JsonObject; readonly resourceRefs: readonly ResourceRef[] };
  execute(prepared: { readonly normalizedArguments: JsonObject; readonly resourceRefs: readonly ResourceRef[] }, context: PluginWorkerContextV1): Promise<JsonValue>;
}
export interface PluginWorkerV1 {
  readonly agents: readonly { readonly id: string; readonly instructions: string; readonly toolIds: readonly string[] }[];
  readonly tools: readonly PluginWorkerToolV1[];
}
