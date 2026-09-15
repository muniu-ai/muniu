// SPDX-License-Identifier: Apache-2.0
import type { JsonObject, JsonValue } from "@mn/contracts";
import { canonicalJson } from "./canonical.js";

const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const TYPES = ["object", "array", "string", "boolean", "null", "number", "integer"];
const KEYWORDS = ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "allOf", "oneOf",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "description", "title"];

/** This bounded subset deliberately rejects references, executable patterns and unknown keywords. */
export function assertPluginEventSchema(schema: JsonObject): void {
  let nodes = 4096;
  function check(value: JsonValue, depth: number): void {
    if (--nodes < 0 || depth > 32) throw new Error("插件事件结构定义过于复杂");
    if (typeof value === "boolean") return;
    if (!object(value) || Object.keys(value).some(key => !KEYWORDS.includes(key))) throw new Error("插件事件结构包含未支持的关键字");
    if (value.type !== undefined && (typeof value.type !== "string" || !TYPES.includes(value.type))) throw new Error("插件事件字段类型无效");
    if (value.properties !== undefined) {
      if (!object(value.properties)) throw new Error("插件事件 properties 必须是对象");
      for (const child of Object.values(value.properties)) check(child, depth + 1);
    }
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(key => typeof key !== "string")
      || new Set(value.required).size !== value.required.length)) throw new Error("插件事件 required 无效");
    for (const name of ["items", "additionalProperties"] as const) if (value[name] !== undefined) check(value[name], depth + 1);
    for (const name of ["anyOf", "allOf", "oneOf"] as const) if (value[name] !== undefined) {
      const children = value[name];
      if (!Array.isArray(children) || !children.length) throw new Error("插件事件组合结构无效");
      for (const child of children) check(child, depth + 1);
    }
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) throw new Error("插件事件枚举无效");
    for (const name of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
      const limit = value[name];
      if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit)
        || (!["minimum", "maximum"].includes(name) && (!Number.isSafeInteger(limit) || limit < 0)))) throw new Error("插件事件边界无效");
    }
  }
  check(schema, 0);
}

export function assertPluginEventPayload(schema: JsonObject, payload: JsonObject): void {
  assertPluginEventSchema(schema);
  if (!object(payload) || Buffer.byteLength(canonicalJson(payload)) > 1024 * 1024) throw new Error("插件事件内容大小或格式无效");
  let nodes = 100_000;
  function matches(shape: JsonValue, value: JsonValue, depth: number): boolean {
    if (--nodes < 0 || depth > 64) throw new Error("插件事件内容过于复杂");
    if (typeof shape === "boolean") return shape;
    const s = shape as JsonObject;
    if (Object.hasOwn(s, "const") && canonicalJson(s.const) !== canonicalJson(value)) return false;
    if (s.enum && !(s.enum as JsonValue[]).some(item => canonicalJson(item) === canonicalJson(value))) return false;
    if (s.anyOf && !(s.anyOf as JsonValue[]).some(child => matches(child, value, depth + 1))) return false;
    if (s.allOf && !(s.allOf as JsonValue[]).every(child => matches(child, value, depth + 1))) return false;
    if (s.oneOf && (s.oneOf as JsonValue[]).filter(child => matches(child, value, depth + 1)).length !== 1) return false;
    const type = s.type;
    if (type && !(type === "null" ? value === null : type === "object" ? object(value) : type === "array" ? Array.isArray(value)
      : type === "integer" ? Number.isSafeInteger(value) : typeof value === type)) return false;
    if (typeof value === "number" && (!Number.isFinite(value) || (typeof s.minimum === "number" && value < s.minimum)
      || (typeof s.maximum === "number" && value > s.maximum))) return false;
    if (typeof value === "string" && ((typeof s.minLength === "number" && [...value].length < s.minLength)
      || (typeof s.maxLength === "number" && [...value].length > s.maxLength))) return false;
    if (Array.isArray(value)) {
      if ((typeof s.minItems === "number" && value.length < s.minItems) || (typeof s.maxItems === "number" && value.length > s.maxItems)) return false;
      if (!value.every(item => matches(s.items ?? true, item, depth + 1))) return false;
    }
    if (object(value)) {
      if ((s.required as string[] | undefined)?.some(key => !Object.hasOwn(value, key))) return false;
      const properties = s.properties as JsonObject | undefined;
      if (!Object.entries(value).every(([key, item]) => matches(properties && Object.hasOwn(properties, key)
        ? properties[key]! : s.additionalProperties ?? true, item, depth + 1))) return false;
    }
    return true;
  }
  if (!matches(schema, payload, 0)) throw new Error("插件事件内容不符合签名结构定义");
}
