// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { MUNIU_CONTROL_OPERATIONS } from "./control-methods.generated.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";
import type { JsonValue } from "./json.js";

export { MUNIU_CONTROL_OPERATIONS } from "./control-methods.generated.js";

export type MuniuMethod = (typeof MUNIU_CONTROL_OPERATIONS)[number]["method"];
export type LegacyControlOperationId = (typeof MUNIU_CONTROL_OPERATIONS)[number]["operationId"];

export const MUNIU_METHODS = Object.freeze(
  MUNIU_CONTROL_OPERATIONS.map((operation) => operation.method)
) as readonly MuniuMethod[];

export const MuniuControlParamsSchema = z.object({
  path: JsonObjectSchema.optional(),
  query: JsonObjectSchema.optional(),
  body: JsonValueSchema.optional(),
  idempotencyKey: z.string().min(1).max(512).optional()
}).strict();

export const MuniuControlResultSchema = JsonValueSchema;
export type MuniuControlParams = z.infer<typeof MuniuControlParamsSchema>;
export type MuniuControlResult = z.infer<typeof MuniuControlResultSchema>;

const BY_METHOD = new Map(MUNIU_CONTROL_OPERATIONS.map((operation) => [operation.method, operation]));
const BY_OPERATION = new Map(MUNIU_CONTROL_OPERATIONS.map((operation) => [operation.operationId, operation]));

interface ControlRouteMatcher {
  readonly operation: (typeof MUNIU_CONTROL_OPERATIONS)[number];
  readonly segments: readonly string[];
  readonly staticSegments: number;
}

const CONTROL_ROUTE_MATCHERS = Object.freeze(MUNIU_CONTROL_OPERATIONS
  .map((operation): ControlRouteMatcher => {
    const segments = operation.path.split("/").filter(Boolean);
    return {
      operation,
      segments,
      staticSegments: segments.filter((segment) => !segment.startsWith("{")).length
    };
  })
  .sort((left, right) => right.staticSegments - left.staticSegments || right.segments.length - left.segments.length));

export function isMuniuMethod(method: string): method is MuniuMethod {
  return BY_METHOD.has(method as MuniuMethod);
}

export function controlOperationForMethod(method: MuniuMethod) {
  return BY_METHOD.get(method);
}

export function controlMethodForOperation(operationId: LegacyControlOperationId): MuniuMethod {
  const operation = BY_OPERATION.get(operationId);
  if (!operation) throw new TypeError(`Unknown legacy control operation: ${operationId}`);
  return operation.method;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new TypeError("control path contains an invalid encoded segment", { cause: error });
  }
}

function queryObject(searchParams: URLSearchParams): Record<string, JsonValue> | undefined {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of searchParams) {
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (Array.isArray(existing)) result[key] = [...existing, value];
    else result[key] = [existing, value];
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function serializeJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("control request body must be JSON serializable");
  return JsonValueSchema.parse(JSON.parse(serialized));
}

export function controlRequestForHttp(
  verb: string,
  pathAndQuery: string,
  body?: unknown,
  idempotencyKey?: string
): { readonly method: MuniuMethod; readonly params: MuniuControlParams } {
  const normalizedVerb = verb.toLowerCase();
  const url = new URL(pathAndQuery, "http://control.invalid");
  const requestSegments = url.pathname.split("/").filter(Boolean);
  for (const matcher of CONTROL_ROUTE_MATCHERS) {
    if (matcher.operation.verb !== normalizedVerb || matcher.segments.length !== requestSegments.length) continue;
    const path: Record<string, JsonValue> = {};
    let matched = true;
    for (let index = 0; index < matcher.segments.length; index += 1) {
      const expected = matcher.segments[index]!;
      const actual = requestSegments[index]!;
      const parameter = /^\{([^{}]+)\}$/u.exec(expected)?.[1];
      if (parameter !== undefined) path[parameter] = decodePathSegment(actual);
      else if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const query = queryObject(url.searchParams);
    return {
      method: matcher.operation.method,
      params: MuniuControlParamsSchema.parse({
        ...(Object.keys(path).length === 0 ? {} : { path }),
        ...(query === undefined ? {} : { query }),
        ...(body === undefined ? {} : { body: serializeJsonValue(body) }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey })
      })
    };
  }
  throw new TypeError(`No control operation matches ${verb.toUpperCase()} ${url.pathname}`);
}
