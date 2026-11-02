// SPDX-License-Identifier: Apache-2.0
import { ENTERPRISE_SCHEMAS } from './enterprise-schema.js';
import type { EnterpriseContractTypes } from './enterprise-types.js';
export * from './enterprise-schema.js';
export * from './enterprise-types.js';
export * from './enterprise-examples.js';

interface Schema {
  readonly $ref?: string; readonly const?: unknown; readonly enum?: readonly unknown[];
  readonly type?: string; readonly format?: string; readonly pattern?: string; readonly minLength?: number;
  readonly minimum?: number; readonly maximum?: number; readonly minItems?: number; readonly uniqueItems?: boolean;
  readonly properties?: Readonly<Record<string, Schema>>; readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Schema; readonly items?: Schema;
  readonly oneOf?: readonly Schema[]; readonly anyOf?: readonly Schema[];
}

/** Structural validation only. Current identity, grants and versions are checked by trusted services. */
export function parseEnterpriseContract<K extends keyof EnterpriseContractTypes>(name: K, value: unknown): EnterpriseContractTypes[K] {
  let remaining = 100_000;
  const schemas = ENTERPRISE_SCHEMAS as Readonly<Record<string, Schema>>;
  function matches(schema: Schema, item: unknown, depth = 0): boolean {
    if (--remaining < 0 || depth > 64) return false;
    if (schema.$ref) {
      const child = schemas[schema.$ref.split('/').at(-1)!];
      return child !== undefined && matches(child, item, depth + 1);
    }
    if (schema.oneOf) return schema.oneOf.filter(child => matches(child, item, depth + 1)).length === 1;
    if (schema.anyOf) return schema.anyOf.some(child => matches(child, item, depth + 1));
    if (Object.hasOwn(schema, 'const')) return item === schema.const;
    if (schema.enum && !schema.enum.includes(item)) return false;
    if (schema.type === 'string') {
      if (typeof item !== 'string' || (schema.minLength !== undefined && item.length < schema.minLength)
        || (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(item))) return false;
      if (schema.format === 'date') return /^\d{4}-\d{2}-\d{2}$/u.test(item) && Number.isFinite(Date.parse(item)) && new Date(item).toISOString().slice(0, 10) === item;
      if (schema.format === 'date-time') {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(item)) return false;
        return Number.isFinite(Date.parse(item)) && new Date(item).toISOString().slice(0, 19) === item.slice(0, 19);
      }
      return true;
    }
    if (schema.type === 'integer' || schema.type === 'number') return typeof item === 'number' && Number.isFinite(item)
      && (schema.type !== 'integer' || Number.isSafeInteger(item)) && (schema.minimum === undefined || item >= schema.minimum)
      && (schema.maximum === undefined || item <= schema.maximum);
    if (schema.type === 'array') return Array.isArray(item) && (schema.minItems === undefined || item.length >= schema.minItems)
      && (!schema.uniqueItems || new Set(item.map(entry => JSON.stringify(entry))).size === item.length)
      && item.every(entry => schema.items !== undefined && matches(schema.items, entry, depth + 1));
    if (schema.type === 'object') {
      if (typeof item !== 'object' || item === null || Array.isArray(item) || ![null, Object.prototype].includes(Object.getPrototypeOf(item))) return false;
      const object = item as Record<string, unknown>;
      if (schema.required?.some(key => !Object.hasOwn(object, key))) return false;
      return Object.keys(object).every(key => Object.hasOwn(schema.properties ?? {}, key)
        ? matches(schema.properties![key]!, object[key], depth + 1)
        : schema.additionalProperties === true || (typeof schema.additionalProperties === 'object' && matches(schema.additionalProperties, object[key], depth + 1)));
    }
    return false;
  }
  const schema = Object.hasOwn(schemas, name) ? schemas[name] : undefined;
  if (!schema || !matches(schema, value)) throw new Error('企业契约格式无效');
  return value as EnterpriseContractTypes[K];
}
