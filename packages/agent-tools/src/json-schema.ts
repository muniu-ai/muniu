/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/tools/src/json-schema.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: retained the enforced object/array/scalar/oneOf subset and
 * path-qualified value validation in a smaller Cordis-free implementation.
 */

import { isJsonValue, type JsonValue } from "@mn/agent-protocol";

export type JsonSchemaScalar = string | number | boolean | null;
export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface JsonSchemaNode {
  type?: JsonSchemaType;
  oneOf?: JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaNode;
  enum?: JsonSchemaScalar[];
  const?: JsonSchemaScalar;
  description?: string;
  title?: string;
  default?: JsonValue;
  examples?: JsonValue;
}

export type ObjectJsonSchema = JsonSchemaNode & { type: "object" };

export class JsonSchemaError extends Error {
  readonly code = "UNSUPPORTED_SCHEMA";
  constructor(readonly violations: string[]) {
    super(`unsupported JSON schema: ${violations.join("; ")}`);
    this.name = "JsonSchemaError";
  }
}

const TYPES = new Set<JsonSchemaType>(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYS = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title", "default", "examples"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === null || prototype === Object.prototype;
}

function isJsonNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}

function scalarMatches(type: Exclude<JsonSchemaType, "object" | "array">, value: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return isJsonNumber(value);
  if (type === "integer") return isJsonNumber(value) && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return value === null;
}

function checkSchema(schema: unknown, path: string, violations: string[], ancestors: Set<object>): void {
  if (!isRecord(schema)) {
    violations.push(`${path} must be a schema object`);
    return;
  }
  if (ancestors.has(schema)) {
    violations.push(`${path} is circular`);
    return;
  }
  ancestors.add(schema);
  try {
    for (const key of Object.keys(schema)) {
      if (!KEYS.has(key)) violations.push(`${path}.${key} is not a supported keyword`);
    }
    if (schema.description !== undefined && typeof schema.description !== "string") violations.push(`${path}.description must be a string`);
    if (schema.title !== undefined && typeof schema.title !== "string") violations.push(`${path}.title must be a string`);
    for (const annotation of ["default", "examples"] as const) {
      if (!Object.hasOwn(schema, annotation)) continue;
      let valid = false;
      try { valid = isJsonValue(schema[annotation]); } catch { valid = false; }
      if (!valid) violations.push(`${path}.${annotation} annotation must be lossless JSON data`);
    }
    const hasType = Object.hasOwn(schema, "type");
    const hasOneOf = Object.hasOwn(schema, "oneOf");
    if (hasType === hasOneOf) {
      if (hasType) violations.push(`${path} cannot declare both type and oneOf`);
      else if (Object.keys(schema).some((key) => !["description", "title", "default", "examples"].includes(key))) {
        violations.push(`${path} constraints require type or oneOf`);
      }
      return;
    }
    if (hasOneOf) {
      if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) {
        violations.push(`${path}.oneOf must contain at least two schemas`);
        return;
      }
      if (["properties", "required", "additionalProperties", "items", "enum", "const"].some((key) => Object.hasOwn(schema, key))) {
        violations.push(`${path} oneOf cannot have constraint siblings`);
      }
      schema.oneOf.forEach((branch, index) => checkSchema(branch, `${path}.oneOf[${index}]`, violations, ancestors));
      return;
    }
    if (typeof schema.type !== "string" || !TYPES.has(schema.type as JsonSchemaType)) {
      violations.push(`${path}.type is not supported`);
      return;
    }
    const type = schema.type as JsonSchemaType;
    if (type === "object") {
      if (schema.properties !== undefined) {
        if (!isRecord(schema.properties)) violations.push(`${path}.properties must be an object of schemas`);
        else for (const [key, child] of Object.entries(schema.properties)) checkSchema(child, `${path}.properties.${key}`, violations, ancestors);
      }
      if (schema.required !== undefined) {
        if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string")) {
          violations.push(`${path}.required must be an array of strings`);
        } else {
          for (const key of schema.required) {
            if (!isRecord(schema.properties) || !Object.hasOwn(schema.properties, key)) {
              violations.push(`${path}.required names undeclared property "${key}"`);
            }
          }
        }
      }
      if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
        violations.push(`${path}.additionalProperties must be a boolean`);
      }
    } else if (["properties", "required", "additionalProperties"].some((key) => Object.hasOwn(schema, key))) {
      violations.push(`${path} object keywords require type object`);
    }
    if (type === "array") {
      if (schema.items !== undefined) checkSchema(schema.items, `${path}.items`, violations, ancestors);
    } else if (Object.hasOwn(schema, "items")) {
      violations.push(`${path}.items requires type array`);
    }
    if (type !== "object" && type !== "array") {
      if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some((item) => !scalarMatches(type, item)))) {
        violations.push(`${path}.enum contains an invalid ${type} value`);
      }
      if (Object.hasOwn(schema, "const") && !scalarMatches(type, schema.const)) {
        violations.push(`${path}.const is not a ${type} value`);
      }
    } else if (Object.hasOwn(schema, "enum") || Object.hasOwn(schema, "const")) {
      violations.push(`${path} literal constraints require a scalar type`);
    }
  } finally {
    ancestors.delete(schema);
  }
}

export function assertSupportedJsonSchema(schema: unknown): asserts schema is JsonSchemaNode {
  const violations: string[] = [];
  checkSchema(schema, "schema", violations, new Set());
  if (violations.length > 0) throw new JsonSchemaError(violations);
}

export function assertObjectJsonSchema(schema: unknown): asserts schema is ObjectJsonSchema {
  assertSupportedJsonSchema(schema);
  if (schema.type !== "object") throw new JsonSchemaError(['schema.type must be "object"']);
}

function diagnosticPath(path: string): string { return path === "" ? "arguments" : path; }
function propertyPath(path: string, key: string): string { return path === "" ? key : `${path}.${key}`; }

function validate(schema: JsonSchemaNode, value: unknown, path: string): string[] {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((branch) => validate(branch, value, path).length === 0).length;
    return matches === 1 ? [] : [`"${diagnosticPath(path)}" must match exactly one oneOf branch`];
  }
  if (schema.type === undefined) return isJsonValue(value) ? [] : [`"${diagnosticPath(path)}" must be a lossless JSON value`];
  if (schema.type === "object") {
    if (!isRecord(value)) return [`"${diagnosticPath(path)}" must be an object`];
    const violations: string[] = [];
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`missing required property "${propertyPath(path, key)}"`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) violations.push(...validate(child, value[key], propertyPath(path, key)));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`"${propertyPath(path, key)}" is not a declared property`);
      }
    }
    return isJsonValue(value) ? violations : [`"${diagnosticPath(path)}" must be a lossless JSON object`];
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`"${diagnosticPath(path)}" must be an array`];
    const violations = schema.items === undefined
      ? []
      : value.flatMap((entry, index) => validate(schema.items as JsonSchemaNode, entry, `${path}[${index}]`));
    return isJsonValue(value) ? violations : [`"${diagnosticPath(path)}" must be a dense lossless JSON array`];
  }
  if (!scalarMatches(schema.type, value)) return [`"${diagnosticPath(path)}" must be a ${schema.type}`];
  if (schema.enum !== undefined && !schema.enum.includes(value as JsonSchemaScalar)) {
    return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(schema.enum)}`];
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    return [`"${diagnosticPath(path)}" must be ${JSON.stringify(schema.const)}`];
  }
  return [];
}

export function validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path = ""): string[] {
  return validate(schema, value, path);
}
