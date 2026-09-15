// SPDX-License-Identifier: Apache-2.0
import type { JsonObject, JsonValue } from "@mn/contracts";
import { cloneJson } from "./canonical.js";

export interface PluginDomainEventV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly type: string;
  readonly position: number;
  readonly streamVersion: number;
  readonly payload: JsonObject;
}

export interface PluginProjectionRecordV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly sourceEventId: string;
  readonly sourcePosition: number;
  readonly streamVersion: number;
  readonly value: JsonObject;
}

export interface PluginProjectionRuleV1 {
  readonly eventType: string;
  readonly operation: "replace" | "merge" | "delete";
  readonly fields?: Readonly<Record<string, string>>;
  readonly defaults?: JsonObject;
}

export interface PluginProjectionProgramV1 {
  readonly schemaVersion: 1;
  readonly rules: readonly PluginProjectionRuleV1[];
  readonly requiredFields?: readonly string[];
}

const safeName = (value: unknown): value is string => typeof value === "string"
  && /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u.test(value) && !["constructor", "prototype", "__proto__"].includes(value);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("投影定义包含未支持的字段");
}

function pointer(value: unknown): readonly string[] {
  if (typeof value !== "string" || !value.startsWith("/")) throw new Error("投影字段必须使用 JSON Pointer");
  const parts = value.slice(1).split("/").map(part => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  if (parts.length > 16 || parts.some(part => !safeName(part) && !/^\d{1,6}$/u.test(part))) {
    throw new Error("投影字段路径无效");
  }
  return parts;
}

export function parseProjectionProgram(bytes: Uint8Array): PluginProjectionProgramV1 {
  if (!bytes.byteLength || bytes.byteLength > 1024 * 1024) throw new Error("投影定义大小无效");
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!object(input)) throw new Error("投影定义必须是 JSON 对象");
  keys(input, ["schemaVersion", "rules", "requiredFields"]);
  if (input.schemaVersion !== 1 || !Array.isArray(input.rules) || !input.rules.length || input.rules.length > 256) {
    throw new Error("投影定义版本或规则数量无效");
  }
  const seen = new Set<string>();
  for (const rule of input.rules) {
    if (!object(rule)) throw new Error("投影规则必须是对象");
    keys(rule, ["eventType", "operation", "fields", "defaults"]);
    if (!safeName(rule.eventType) || seen.has(rule.eventType)) throw new Error("投影规则事件重复或无效");
    seen.add(rule.eventType);
    if (!["replace", "merge", "delete"].includes(String(rule.operation))) throw new Error("投影操作无效");
    if (rule.operation === "delete" && (rule.fields !== undefined || rule.defaults !== undefined)) {
      throw new Error("删除投影不能同时映射字段");
    }
    if (rule.fields !== undefined) {
      if (!object(rule.fields) || Object.keys(rule.fields).length > 256) throw new Error("投影字段映射无效");
      for (const [field, path] of Object.entries(rule.fields)) {
        if (!safeName(field)) throw new Error("投影字段名无效");
        pointer(path);
      }
    }
    if (rule.defaults !== undefined && (!object(rule.defaults) || Object.keys(rule.defaults).some(field => !safeName(field)))) {
      throw new Error("投影默认值无效");
    }
  }
  if (input.requiredFields !== undefined && (!Array.isArray(input.requiredFields) || input.requiredFields.length > 256
    || input.requiredFields.some(field => !safeName(field)) || new Set(input.requiredFields).size !== input.requiredFields.length)) {
    throw new Error("投影必填字段无效");
  }
  return cloneJson(input) as unknown as PluginProjectionProgramV1;
}

export function reducePluginProjection(program: PluginProjectionProgramV1, previous: PluginProjectionRecordV1 | undefined,
  event: PluginDomainEventV1): PluginProjectionRecordV1 | undefined {
  const rule = program.rules.find(candidate => candidate.eventType === event.type);
  if (!rule) return previous;
  if (!event.id || !event.tenantId || !event.workspaceId || !event.resourceId || !object(event.payload)
    || !Number.isSafeInteger(event.position) || event.position < 1
    || !Number.isSafeInteger(event.streamVersion) || event.streamVersion < 1) throw new Error("插件事实事件无效");
  if (previous && (previous.tenantId !== event.tenantId || previous.workspaceId !== event.workspaceId || previous.id !== event.resourceId)) {
    throw new Error("投影事件超出原记录的数据范围");
  }
  if (previous && (event.position <= previous.sourcePosition || event.streamVersion <= previous.streamVersion)) {
    throw new Error("投影事实事件顺序无效");
  }
  if (rule.operation === "delete") return undefined;
  const selected = Object.create(null) as Record<string, JsonValue>;
  if (rule.fields) {
    for (const [field, path] of Object.entries(rule.fields)) {
      let value: unknown = event.payload;
      for (const part of pointer(path)) {
        if ((object(value) || Array.isArray(value)) && Object.hasOwn(value, part)) value = (value as Record<string, unknown>)[part];
        else throw new Error(`投影输入缺少字段：${path}`);
      }
      selected[field] = cloneJson(value) as JsonValue;
    }
  } else Object.assign(selected, cloneJson(event.payload));
  const value = { ...cloneJson(rule.defaults ?? {}), ...(rule.operation === "merge" ? previous?.value : {}), ...selected };
  for (const field of program.requiredFields ?? []) if (!Object.hasOwn(value, field) || value[field] === null) {
    throw new Error(`投影输出缺少必填字段：${field}`);
  }
  return { id: event.resourceId, tenantId: event.tenantId, workspaceId: event.workspaceId, sourceEventId: event.id,
    sourcePosition: event.position, streamVersion: event.streamVersion, value: cloneJson(value) };
}
