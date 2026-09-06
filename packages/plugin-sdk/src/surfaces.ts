// SPDX-License-Identifier: Apache-2.0
import type { PluginSurfacesV1, PluginWorkerV1, PluginManifestV1 } from "@mn/contracts";
import { PluginPolicyError } from "./errors.js";

function invalid(): never {
  throw new PluginPolicyError("PLUGIN_CONTRIBUTION_INVALID", "插件入口贡献不符合签名声明", "修复插件定义后重新加载");
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 100) invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) invalid();
  return value;
}
function fields(value: unknown): void {
  const names = new Set<string>();
  for (const raw of list(value)) {
    const field = object(raw, ["name", "label", "type", "required"]);
    const name = text(field.name);
    if (!/^[a-z][a-zA-Z0-9_-]*$/u.test(name) || names.has(name)
      || ["workspaceId", "expectedStreamVersion", "__proto__", "constructor", "prototype", "json", "help", "workspace", "version"].includes(name)
      || !["string", "number", "boolean"].includes(String(field.type))) invalid();
    names.add(name);
    if (field.label !== undefined) text(field.label);
    if (field.required !== undefined && typeof field.required !== "boolean") invalid();
  }
}
export function assertPluginSurfaces(value: unknown, contributions: {
  readonly routes: readonly { readonly id: string }[];
  readonly widgets: readonly { readonly id: string }[];
  readonly commands: readonly { readonly id: string }[];
}): asserts value is PluginSurfacesV1 {
  const surfaces = object(value, ["ui", "cli"]);
  const commandIds = new Set(contributions.commands.map((item) => item.id));
  const card = (raw: unknown) => {
    const item = object(raw, ["title", "body", "commandId", "fields"]);
    text(item.title); text(item.body);
    if (item.commandId !== undefined && !commandIds.has(text(item.commandId))) invalid();
    if (item.fields !== undefined) { if (!item.commandId) invalid(); fields(item.fields); }
  };
  if (surfaces.ui !== undefined) {
    const ui = object(surfaces.ui, ["pages", "widgets"]);
    const routes = new Set(contributions.routes.map((item) => item.id));
    for (const raw of list(ui.pages)) {
      const page = object(raw, ["routeId", "title", "cards"]);
      if (!routes.delete(text(page.routeId))) invalid();
      text(page.title); list(page.cards).forEach(card);
    }
    const widgets = new Set(contributions.widgets.map((item) => item.id));
    for (const raw of list(ui.widgets)) {
      const widget = object(raw, ["widgetId", "card"]);
      if (!widgets.delete(text(widget.widgetId))) invalid();
      card(widget.card);
    }
  }
  if (surfaces.cli !== undefined) {
    const cli = object(surfaces.cli, ["commands"]);
    const names = new Set<string>();
    for (const raw of list(cli.commands)) {
      const command = object(raw, ["name", "commandId", "description", "fields"]);
      const name = text(command.name);
      if (!/^[a-z][a-z0-9-]*$/u.test(name) || names.has(name) || !commandIds.has(text(command.commandId))) invalid();
      names.add(name); text(command.description); fields(command.fields);
    }
  }
}

export function assertPluginWorker(value: unknown, manifest: PluginManifestV1): asserts value is PluginWorkerV1 {
  const worker = object(value, ["agents", "tools"]);
  const agents = new Set(manifest.contributes.agents);
  const tools = new Set(manifest.contributes.tools);
  for (const raw of list(worker.agents)) {
    const agent = object(raw, ["id", "instructions", "toolIds"]);
    if (!agents.delete(text(agent.id))) invalid();
    text(agent.instructions);
    for (const id of list(agent.toolIds)) if (!tools.has(text(id))) invalid();
  }
  const effects = new Set(manifest.permissions.flatMap((permission) => permission.effectClasses));
  for (const raw of list(worker.tools)) {
    const tool = object(raw, ["id", "version", "effectClass", "prepare", "execute"]);
    if (!tools.delete(text(tool.id)) || !effects.has(tool.effectClass as never)
      || typeof tool.prepare !== "function" || typeof tool.execute !== "function") invalid();
    text(tool.version);
  }
  if (agents.size || tools.size) invalid();
}
