// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { JsonValueSchema } from "./json.js";
import {
  MuniuControlParamsSchema,
  isMuniuMethod,
  type MuniuControlParams,
  type MuniuMethod
} from "./control-methods.js";
import { METHOD_SCHEMAS, type ClientMethod, type MethodParams } from "./methods.js";

export const RequestIdSchema = z.union([z.string(), z.number().int().safe()]);
export type RequestId = z.infer<typeof RequestIdSchema>;

export const JsonRpcRequestSchema = z.object({
  id: RequestIdSchema,
  method: z.string().min(1),
  params: JsonValueSchema.optional(),
  trace: z.object({ traceparent: z.string().optional(), tracestate: z.string().optional() }).strict().optional()
}).strict();

export const JsonRpcNotificationSchema = z.object({
  method: z.string().min(1),
  params: JsonValueSchema.optional()
}).strict();

export const JsonRpcResponseSchema = z.object({
  id: RequestIdSchema,
  result: JsonValueSchema
}).strict();

export const JsonRpcErrorSchema = z.object({
  id: RequestIdSchema.nullable(),
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: JsonValueSchema.optional()
  }).strict()
}).strict();

export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcResponseSchema,
  JsonRpcErrorSchema
]);

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;

export class MethodNotFoundError extends Error {
  constructor(readonly method: string) {
    super(`Unsupported method: ${method}`);
    this.name = "MethodNotFoundError";
  }
}

export type ParsedClientRequest<M extends ClientMethod = ClientMethod> = {
  id: RequestId;
  method: M;
  params: MethodParams<M>;
  trace?: JsonRpcRequest["trace"];
};

export type ParsedMuniuRequest = {
  id: RequestId;
  method: MuniuMethod;
  params: MuniuControlParams;
  trace?: JsonRpcRequest["trace"];
};

export function isClientMethod(method: string): method is ClientMethod {
  return Object.hasOwn(METHOD_SCHEMAS, method);
}

export function parseClientRequest(value: unknown): ParsedClientRequest | ParsedMuniuRequest {
  const request = JsonRpcRequestSchema.parse(value);
  if (isClientMethod(request.method)) {
    const schema = METHOD_SCHEMAS[request.method].params as z.ZodTypeAny;
    const params = schema.parse(request.params === undefined ? {} : request.params);
    return { id: request.id, method: request.method, params, trace: request.trace } as ParsedClientRequest;
  }
  if (isMuniuMethod(request.method)) {
    const params = MuniuControlParamsSchema.parse(request.params === undefined ? {} : request.params);
    return { id: request.id, method: request.method, params, trace: request.trace };
  }
  throw new MethodNotFoundError(request.method);
}

export function parseJsonRpcMessageText(text: string): JsonRpcMessage {
  return JsonRpcMessageSchema.parse(JSON.parse(text));
}
