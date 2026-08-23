// SPDX-License-Identifier: Apache-2.0

import {
  CLIENT_METHODS,
  InitializeParamsSchema,
  METHOD_SCHEMAS,
  MethodNotFoundError,
  SERVER_NOTIFICATION_METHODS,
  SERVER_NOTIFICATION_SCHEMAS,
  SERVER_REQUEST_METHODS,
  SERVER_REQUEST_SCHEMAS,
  JsonRpcRequestSchema,
  MUNIU_METHODS,
  MuniuControlResultSchema,
  RequestIdSchema,
  type ClientMethod,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type MethodParams,
  type MethodResult,
  type MuniuControlParams,
  type MuniuControlResult,
  type MuniuMethod,
  type ParsedClientRequest,
  type ParsedMuniuRequest,
  type RequestId,
  type ServerInfoSchema,
  type ServerNotificationMethod,
  type ServerNotificationParams,
  type ServerRequestMethod,
  type ServerRequestParams,
  type ServerRequestResult,
  isMuniuMethod,
  parseClientRequest
} from "@mn/app-server-protocol";
import type { z } from "zod";

import type { NotificationLog } from "./notification-log.js";
import {
  BoundedOutboundQueue,
  type OutboundQueueOptions,
  type QueueCloseReason
} from "./outbound-queue.js";

const BASELINE_COMMIT = "99660ab3c7b861c916e467581fa9b8723504d66b";

type OrdinaryClientMethod = Exclude<ClientMethod, "initialize">;

export interface RequestContext {
  clientInfo: z.infer<typeof InitializeParamsSchema>["clientInfo"];
  signal: AbortSignal;
  identity?: ConnectionIdentity;
}

export interface ConnectionIdentity {
  readonly tenantId: string;
  readonly subject: string;
  readonly roles: readonly string[];
  readonly permissionProfile: string;
  readonly sandbox: Readonly<Record<string, import("@mn/app-server-protocol").JsonValue>>;
  readonly projectIds?: readonly string[];
  readonly principalType?: "human" | "worker";
  readonly scopes?: readonly string[];
}

export type AppServerHandlers = {
  [M in OrdinaryClientMethod]: (
    params: MethodParams<M>,
    context: RequestContext
  ) => MethodResult<M> | Promise<MethodResult<M>>;
};

export type MuniuControlHandler = (
  method: MuniuMethod,
  params: MuniuControlParams,
  context: RequestContext
) => MuniuControlResult | Promise<MuniuControlResult>;

export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonRpcError["error"]["data"]
  ) {
    super(message);
    this.name = "RpcFault";
  }
}

export interface AppServerConnectionOptions extends Omit<OutboundQueueOptions, "write" | "close"> {
  serverInfo: z.infer<typeof ServerInfoSchema>;
  instructionSources: readonly string[];
  handlers: AppServerHandlers;
  controlHandler?: MuniuControlHandler;
  identity?: ConnectionIdentity;
  authorizeRequest?: (
    method: Exclude<ClientMethod, "initialize"> | MuniuMethod,
    context: RequestContext
  ) => boolean | Promise<boolean>;
  resumeCursor?: string;
  notificationLog: NotificationLog;
  write(message: JsonRpcMessage): Promise<void>;
  close(reason: QueueCloseReason): void;
  serverRequestTimeoutMs?: number;
}

interface PendingServerRequest {
  method: ServerRequestMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

type ConnectionState = "new" | "awaitingInitialized" | "ready" | "closed";

export class AppServerConnection {
  readonly #options: AppServerConnectionOptions;
  readonly #queue: BoundedOutboundQueue;
  readonly #pending = new Map<RequestId, PendingServerRequest>();
  readonly #abortController = new AbortController();
  #state: ConnectionState = "new";
  #clientInfo: RequestContext["clientInfo"] | undefined;
  #suppressedNotifications = new Set<string>();
  #nextServerRequestId = 1;
  #inbound = Promise.resolve();
  #notificationSubscription: (() => void) | undefined;
  readonly #seenCursors = new Set<string>();
  readonly #seenCursorOrder: string[] = [];

  constructor(options: AppServerConnectionOptions) {
    this.#options = options;
    this.#queue = new BoundedOutboundQueue({
      write: options.write,
      close: (reason) => {
        this.#notificationSubscription?.();
        this.#notificationSubscription = undefined;
        this.#state = "closed";
        this.#abortController.abort(reason.reason);
        this.#rejectPending(new RpcFault(-32000, "Connection closed"));
        options.close(reason);
      },
      maxFrameBytes: options.maxFrameBytes,
      maxPendingMessages: options.maxPendingMessages,
      maxPendingBytes: options.maxPendingBytes
    });
  }

  receive(value: unknown): Promise<void> {
    this.#inbound = this.#inbound.then(() => this.#process(value));
    return this.#inbound;
  }

  receiveText(text: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.#sendError(null, -32700, "Parse error");
      return Promise.resolve();
    }
    return this.receive(value);
  }

  async notify<M extends ServerNotificationMethod>(
    method: M,
    params: ServerNotificationParams<M>
  ): Promise<void> {
    const schema = SERVER_NOTIFICATION_SCHEMAS[method];
    const notification = { method, params: schema.parse(params) } as {
      method: M;
      params: ServerNotificationParams<M>;
    };
    const { cursor } = await this.#options.notificationLog.append(notification);
    this.#deliverPersisted({ cursor, notification });
  }

  requestClient<M extends ServerRequestMethod>(
    method: M,
    params: ServerRequestParams<M>
  ): Promise<ServerRequestResult<M>> {
    if (this.#state !== "ready") return Promise.reject(new RpcFault(-32002, "Server not initialized"));
    const definition = SERVER_REQUEST_SCHEMAS[method];
    const parsedParams = definition.params.parse(params);
    const id = `server-${this.#nextServerRequestId++}`;
    return new Promise<ServerRequestResult<M>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcFault(-32001, "Client request timed out"));
      }, this.#options.serverRequestTimeoutMs ?? 300_000);
      timeout.unref();
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as ServerRequestResult<M>),
        reject,
        timeout
      });
      if (!this.#queue.enqueue({ id, method, params: parsedParams })) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(new RpcFault(-32000, "Connection closed"));
      }
    });
  }

  async idle(): Promise<void> {
    await this.#inbound;
    await this.#queue.idle();
  }

  close(): void {
    this.#notificationSubscription?.();
    this.#notificationSubscription = undefined;
    this.#queue.close();
  }

  async #process(value: unknown): Promise<void> {
    if (this.#state === "closed" || value === null || typeof value !== "object" || Array.isArray(value)) {
      if (this.#state !== "closed") this.#sendError(null, -32600, "Invalid request");
      return;
    }
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, "method")) {
      if (Object.hasOwn(record, "id")) await this.#processRequest(value);
      else await this.#processNotification(record);
      return;
    }
    if (Object.hasOwn(record, "id") && (Object.hasOwn(record, "result") || Object.hasOwn(record, "error"))) {
      this.#processResponse(record);
      return;
    }
    this.#sendError(null, -32600, "Invalid request");
  }

  async #processRequest(value: unknown): Promise<void> {
    const envelope = JsonRpcRequestSchema.safeParse(value);
    if (!envelope.success) {
      const id = this.#safeId((value as Record<string, unknown>).id);
      this.#sendError(id, -32600, "Invalid request");
      return;
    }
    const { id, method } = envelope.data;
    if (method === "initialize") {
      this.#initialize(id, envelope.data.params);
      return;
    }
    if (this.#state !== "ready") {
      this.#sendError(id, -32002, "Server not initialized");
      return;
    }
    let request: ParsedClientRequest | ParsedMuniuRequest;
    try {
      request = parseClientRequest(envelope.data);
    } catch (error) {
      if (error instanceof MethodNotFoundError) this.#sendError(id, -32601, "Method not found");
      else this.#sendError(id, -32602, "Invalid params");
      return;
    }
    if (request.method === "initialize") {
      this.#sendError(id, -32600, "Already initialized");
      return;
    }
    const context = {
      clientInfo: this.#clientInfo!,
      signal: this.#abortController.signal,
      ...(this.#options.identity === undefined ? {} : { identity: this.#options.identity })
    };
    if (this.#options.authorizeRequest !== undefined
      && !await this.#options.authorizeRequest(request.method, context)) {
      this.#sendError(id, -32003, "Request is not authorized");
      return;
    }
    if (isMuniuMethod(request.method)) {
      if (this.#options.controlHandler === undefined) {
        this.#sendError(id, -32601, "Method not found");
        return;
      }
      try {
        const result = await this.#options.controlHandler(request.method, request.params as MuniuControlParams, context);
        this.#queue.enqueue({ id, result: MuniuControlResultSchema.parse(result) });
      } catch (error) {
        if (error instanceof RpcFault) this.#sendError(id, error.code, error.message, error.data);
        else this.#sendError(id, -32603, "Internal error");
      }
      return;
    }
    const clientRequest = request as ParsedClientRequest<OrdinaryClientMethod>;
    const handler = this.#options.handlers[clientRequest.method] as (
      params: MethodParams<typeof clientRequest.method>,
      context: RequestContext
    ) => unknown;
    try {
      const result = await handler(clientRequest.params, context);
      const schema = METHOD_SCHEMAS[clientRequest.method].result as z.ZodTypeAny;
      this.#queue.enqueue({ id, result: schema.parse(result) });
    } catch (error) {
      if (error instanceof RpcFault) this.#sendError(id, error.code, error.message, error.data);
      else this.#sendError(id, -32603, "Internal error");
    }
  }

  #initialize(id: RequestId, params: unknown): void {
    if (this.#state !== "new") {
      this.#sendError(id, -32600, "Already initialized");
      return;
    }
    const parsed = InitializeParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      this.#sendError(id, -32602, "Invalid params");
      return;
    }
    this.#clientInfo = parsed.data.clientInfo;
    this.#suppressedNotifications = new Set(
      parsed.data.capabilities?.optOutNotificationMethods ?? []
    );
    this.#state = "awaitingInitialized";
    this.#queue.enqueue({
      id,
      result: {
        serverInfo: this.#options.serverInfo,
        protocolVersion: "2",
        capabilities: {
          methods: [
            ...CLIENT_METHODS,
            ...(this.#options.controlHandler === undefined ? [] : MUNIU_METHODS)
          ],
          notifications: [...SERVER_NOTIFICATION_METHODS],
          serverRequests: [...SERVER_REQUEST_METHODS]
        },
        instructionSources: [...this.#options.instructionSources],
        muniu: {
          compatibility: {
            protocol: "app-server-v2",
            baselineCommit: BASELINE_COMMIT,
            methodSet: "core-stable-subset"
          }
        }
      }
    });
  }

  async #processNotification(record: Record<string, unknown>): Promise<void> {
    if (record.method === "initialized" && this.#state === "awaitingInitialized" && record.params === undefined) {
      this.#state = "ready";
      await this.#resumeNotifications();
    }
  }

  async #resumeNotifications(): Promise<void> {
    let cursor = this.#options.resumeCursor;
    if (cursor !== undefined && this.#options.notificationLog.readAfter) {
      const entries = await this.#options.notificationLog.readAfter(cursor);
      for (const entry of entries) {
        this.#deliverPersisted(entry);
        cursor = entry.cursor;
      }
    }
    if (this.#options.notificationLog.subscribeAfter) {
      const subscription = await this.#options.notificationLog.subscribeAfter(cursor, (entry) => {
        this.#deliverPersisted(entry);
      });
      this.#notificationSubscription = subscription ?? undefined;
    }
  }

  #deliverPersisted(entry: {
    readonly cursor: string;
    readonly notification: { readonly method: ServerNotificationMethod; readonly params: unknown };
  }): void {
    if (this.#seenCursors.has(entry.cursor)) return;
    this.#seenCursors.add(entry.cursor);
    this.#seenCursorOrder.push(entry.cursor);
    if (this.#seenCursorOrder.length > 10_000) {
      const oldest = this.#seenCursorOrder.shift();
      if (oldest !== undefined) this.#seenCursors.delete(oldest);
    }
    if (!this.#suppressedNotifications.has(entry.notification.method)) {
      this.#queue.enqueue(entry.notification as JsonRpcMessage, entry.cursor);
    }
  }

  #processResponse(record: Record<string, unknown>): void {
    const idResult = RequestIdSchema.safeParse(record.id);
    if (!idResult.success) return;
    const pending = this.#pending.get(idResult.data);
    if (!pending) return;
    this.#pending.delete(idResult.data);
    clearTimeout(pending.timeout);
    if (Object.hasOwn(record, "error")) {
      pending.reject(new RpcFault(-32000, "Client request failed"));
      return;
    }
    try {
      const definition = SERVER_REQUEST_SCHEMAS[pending.method];
      pending.resolve(definition.result.parse(record.result));
    } catch {
      pending.reject(new RpcFault(-32602, "Invalid client response"));
    }
  }

  #sendError(id: RequestId | null, code: number, message: string, data?: JsonRpcError["error"]["data"]): void {
    this.#queue.enqueue({
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) }
    });
  }

  #safeId(value: unknown): RequestId | null {
    const result = RequestIdSchema.safeParse(value);
    return result.success ? result.data : null;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
