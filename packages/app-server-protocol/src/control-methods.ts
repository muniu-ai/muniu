// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { MUNIU_CONTROL_OPERATIONS } from "./control-methods.generated.js";
import { JsonObjectSchema, JsonValueSchema } from "./json.js";

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
