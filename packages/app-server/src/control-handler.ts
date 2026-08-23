// SPDX-License-Identifier: Apache-2.0

import {
  controlOperationForMethod,
  type JsonValue,
  type MuniuControlParams
} from "@mn/app-server-protocol";

import type { MuniuControlHandler, RequestContext } from "./connection.js";

export interface ControlOperationInvocation {
  readonly operationId: string;
  readonly method: string;
  readonly verb: "get" | "post" | "put" | "patch" | "delete";
  readonly pathTemplate: string;
  readonly params: MuniuControlParams;
  readonly context: RequestContext;
}

export interface ControlOperationDispatcher {
  invoke(invocation: ControlOperationInvocation): JsonValue | Promise<JsonValue>;
}

export function createMuniuControlHandler(dispatcher: ControlOperationDispatcher): MuniuControlHandler {
  return async (method, params, context) => {
    const operation = controlOperationForMethod(method);
    if (!operation) throw new TypeError(`Unknown control RPC method: ${method}`);
    return dispatcher.invoke({
      operationId: operation.operationId,
      method,
      verb: operation.verb,
      pathTemplate: operation.path,
      params,
      context
    });
  };
}
