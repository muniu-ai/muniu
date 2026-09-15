// SPDX-License-Identifier: Apache-2.0
import type { ApiOutputsV2 } from "./api-outputs.js";
import { API_OPERATIONS_V2, createOpenApiDocument } from "./openapi.js";

type OperationId = (typeof API_OPERATIONS_V2)[number]["operationId"];
export type JsonApiOperationIdV2 = Exclude<OperationId, "downloadAsset" | "streamWorkspaceEvents">;
interface Schema {
  readonly $ref?: string;
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly allOf?: readonly Schema[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Schema;
  readonly items?: Schema;
  readonly minimum?: number;
  readonly minLength?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
}
const document = createOpenApiDocument() as unknown as {
  readonly components: { readonly schemas: Readonly<Record<string, Schema>> };
  readonly paths: Readonly<Record<string, Readonly<Record<string, {
    readonly responses: Readonly<Record<string, { readonly content?: Readonly<Record<string, { readonly schema: Schema }>> }>>;
  }>>>>;
};
const responseSchemas = new Map(API_OPERATIONS_V2.map((operation) => {
  const responses = document.paths[operation.path]![operation.method]!.responses;
  return [operation.operationId, Object.entries(responses).find(([status]) => status.startsWith("2"))?.[1].content?.["application/json"]?.schema];
}));

export class ApiResponseContractError extends Error {
  constructor(readonly operationId: OperationId) {
    super(`响应不符合公共契约：${operationId}`);
    this.name = "ApiResponseContractError";
  }
}

export function parseApiResponse<K extends JsonApiOperationIdV2>(operationId: K, value: unknown): ApiOutputsV2[K] {
  const schema = responseSchemas.get(operationId);
  let remaining = 2_000_000;
  function matches(shape: Schema, item: unknown, depth = 0): boolean {
    if (--remaining < 0 || depth > 128) return false;
    if (shape.$ref) {
      const resolved = document.components.schemas[shape.$ref.split("/").at(-1)!];
      return resolved !== undefined && matches(resolved, item, depth + 1);
    }
    if (Object.hasOwn(shape, "const") && item !== shape.const) return false;
    if (shape.enum && !shape.enum.includes(item)) return false;
    if (shape.anyOf && !shape.anyOf.some((child) => matches(child, item, depth + 1))) return false;
    if (shape.oneOf && shape.oneOf.filter((child) => matches(child, item, depth + 1)).length !== 1) return false;
    if (shape.allOf && !shape.allOf.every((child) => matches(child, item, depth + 1))) return false;
    if (shape.type === "null") return item === null;
    if (shape.type === "boolean") return typeof item === "boolean";
    if (shape.type === "number" || shape.type === "integer") return typeof item === "number"
      && Number.isFinite(item) && (shape.type !== "integer" || Number.isSafeInteger(item))
      && (shape.minimum === undefined || item >= shape.minimum);
    if (shape.type === "string") return typeof item === "string"
      && (shape.minLength === undefined || item.length >= shape.minLength)
      && (shape.pattern === undefined || new RegExp(shape.pattern, "u").test(item));
    if (shape.type === "array") return Array.isArray(item)
      && (shape.minItems === undefined || item.length >= shape.minItems)
      && (!shape.uniqueItems || new Set(item.map((entry) => JSON.stringify(entry))).size === item.length)
      && item.every((entry) => shape.items !== undefined && matches(shape.items, entry, depth + 1));
    if (shape.type === "object") {
      if (typeof item !== "object" || item === null || Array.isArray(item)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
      const object = item as Record<string, unknown>;
      if (shape.required?.some((key) => !Object.hasOwn(object, key))) return false;
      return Object.keys(object).every((key) => {
        if (Object.hasOwn(shape.properties ?? {}, key)) return matches(shape.properties![key]!, object[key], depth + 1);
        return typeof shape.additionalProperties === "object"
          && matches(shape.additionalProperties, object[key], depth + 1);
      });
    }
    return Boolean(shape.anyOf || shape.oneOf || shape.allOf);
  }
  if (!schema || !matches(schema, value)) throw new ApiResponseContractError(operationId);
  return (value as { readonly data: ApiOutputsV2[K] }).data;
}

const matchers = [...API_OPERATIONS_V2].sort((left, right) =>
  Number(left.operationId === "runPluginCommand") - Number(right.operationId === "runPluginCommand"))
  .map((operation) => ({ ...operation,
    pattern: new RegExp(`^${operation.path.split(/(\{[^}]+\})/u).map((part) => part.startsWith("{")
      ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("")}$`, "u"),
  }));

export function matchApiOperation(method: string, pathname: string): OperationId | undefined {
  return matchers.find((operation) => operation.method === method.toLowerCase() && operation.pattern.test(pathname))?.operationId;
}
