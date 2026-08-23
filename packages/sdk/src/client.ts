// SPDX-License-Identifier: Apache-2.0

import {
  InitializeResultSchema,
  JsonRpcMessageSchema,
  METHOD_SCHEMAS,
  MUNIU_CONTROL_OPERATIONS,
  MuniuControlResultSchema,
  SERVER_NOTIFICATION_SCHEMAS,
  SERVER_REQUEST_SCHEMAS,
  isMuniuMethod,
  type ClientMethod,
  type JsonRpcMessage,
  type JsonValue,
  type MethodParams,
  type MethodResult,
  type MuniuControlParams,
  type MuniuControlResult,
  type MuniuMethod,
  type RequestId,
  type ServerNotificationMethod,
  type ServerNotificationParams,
  type ServerRequestMethod,
  type ServerRequestParams,
  type ServerRequestResult,
  type Thread,
  type Turn
} from "@mn/app-server-protocol";
import type { z } from "zod";

import type { RpcChannel } from "./channel.js";

type OrdinaryMethod = Exclude<ClientMethod, "initialize">;
type Notification = {
  [M in ServerNotificationMethod]: { readonly method: M; readonly params: ServerNotificationParams<M> }
}[ServerNotificationMethod];

export interface MuniuClientOptions {
  readonly channel: RpcChannel;
  readonly clientInfo: { readonly name: string; readonly version: string; readonly title?: string };
  readonly capabilities?: MethodParams<"initialize">["capabilities"];
  readonly approvalHandler?: <M extends Extract<ServerRequestMethod, `${string}/requestApproval`>>(
    method: M,
    params: ServerRequestParams<M>
  ) => Promise<ServerRequestResult<M>>;
  readonly userInputHandler?: (
    params: ServerRequestParams<"item/tool/requestUserInput">
  ) => Promise<ServerRequestResult<"item/tool/requestUserInput">>;
  readonly dynamicToolHandler?: (
    params: ServerRequestParams<"item/tool/call">
  ) => Promise<ServerRequestResult<"item/tool/call">>;
  readonly mcpElicitationHandler?: (
    params: ServerRequestParams<"mcpServer/elicitation/request">
  ) => Promise<ServerRequestResult<"mcpServer/elicitation/request">>;
}

interface PendingRequest {
  readonly method: ClientMethod | MuniuMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly removeAbort?: () => void;
}

class EventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiting: Array<(value: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiting = this.#waiting.shift();
    if (waiting) waiting({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiting of this.#waiting.splice(0)) waiting({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => this.#waiting.push(resolve));
      }
    };
  }
}

type DomainMethod<D extends string> = Extract<MuniuMethod, `muniu/${D}/${string}`>;

export class ControlService<D extends string> {
  readonly methods: readonly DomainMethod<D>[];
  readonly #client: MuniuClient;

  constructor(client: MuniuClient, domain: D) {
    this.#client = client;
    this.methods = Object.freeze(MUNIU_CONTROL_OPERATIONS
      .map((operation) => operation.method)
      .filter((method): method is DomainMethod<D> => method.startsWith(`muniu/${domain}/`)));
  }

  call<M extends DomainMethod<D>>(method: M, params: MuniuControlParams = {}, signal?: AbortSignal): Promise<MuniuControlResult> {
    if (!this.methods.includes(method)) return Promise.reject(new TypeError(`Method does not belong to this service: ${method}`));
    return this.#client.callControl(method, params, signal);
  }
}

export class ThreadHandle {
  readonly #client: MuniuClient;
  readonly id: string;

  constructor(client: MuniuClient, id: string) {
    this.#client = client;
    this.id = id;
  }

  async read(): Promise<Thread> {
    return (await this.#client.call("thread/read", { threadId: this.id, includeTurns: true })).thread;
  }

  async run(input: Omit<MethodParams<"turn/start">, "threadId"> & { readonly signal?: AbortSignal }): Promise<Turn> {
    const streamed = await this.runStreamed(input);
    let completed = streamed.turn;
    for await (const event of streamed.events) {
      if (event.method === "turn/completed") completed = event.params.turn;
    }
    return completed;
  }

  async runStreamed(
    input: Omit<MethodParams<"turn/start">, "threadId"> & { readonly signal?: AbortSignal }
  ): Promise<{ readonly turn: Turn; readonly events: AsyncIterable<Notification> }> {
    const queue = new EventQueue<Notification>();
    let turnId: string | undefined;
    const unsubscribe = this.#client.onNotification((event) => {
      const params = event.params as { threadId?: string; turnId?: string; turn?: { id?: string } };
      if (params.threadId !== this.id) return;
      const eventTurnId = params.turnId ?? params.turn?.id;
      if (turnId !== undefined && eventTurnId !== undefined && eventTurnId !== turnId) return;
      queue.push(event);
      if (event.method === "turn/completed") {
        unsubscribe();
        queue.close();
      }
    });
    const { signal, ...params } = input;
    try {
      const response = await this.#client.call("turn/start", { ...params, threadId: this.id });
      turnId = response.turn.id;
      if (response.turn.status !== "inProgress") {
        unsubscribe();
        queue.close();
      } else if (signal) {
        const interrupt = () => { void this.interrupt(turnId).catch(() => undefined); };
        if (signal.aborted) interrupt();
        else signal.addEventListener("abort", interrupt, { once: true });
      }
      return { turn: response.turn, events: queue };
    } catch (error) {
      unsubscribe();
      queue.close();
      throw error;
    }
  }

  async steer(expectedTurnId: string, input: MethodParams<"turn/steer">["input"], clientUserMessageId?: string) {
    return this.#client.call("turn/steer", {
      threadId: this.id,
      expectedTurnId,
      input,
      ...(clientUserMessageId === undefined ? {} : { clientUserMessageId })
    });
  }

  async interrupt(turnId: string | undefined): Promise<void> {
    if (!turnId) return;
    await this.#client.call("turn/interrupt", { threadId: this.id, turnId });
  }

  setGoal(input: Omit<MethodParams<"thread/goal/set">, "threadId">) {
    return this.#client.call("thread/goal/set", { ...input, threadId: this.id });
  }
}

export class MuniuClient {
  readonly #options: MuniuClientOptions;
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #notifications = new Set<(event: Notification) => void>();
  #nextId = 1;
  #unsubscribe: (() => void) | undefined;
  #initialized = false;
  #initializeResult: MethodResult<"initialize"> | undefined;

  readonly projects = new ControlService(this, "project");
  readonly tasks = new ControlService(this, "task");
  readonly runs = new ControlService(this, "run");
  readonly runJobs = new ControlService(this, "runJob");
  readonly evidence = new ControlService(this, "evidence");
  readonly artifacts = new ControlService(this, "artifact");
  readonly providers = new ControlService(this, "provider");
  readonly modelCatalog = new ControlService(this, "modelCatalog");
  readonly policy = new ControlService(this, "policy");
  readonly approvals = new ControlService(this, "approval");
  readonly extensions = new ControlService(this, "extension");
  readonly skillRegistry = new ControlService(this, "skillRegistry");
  readonly config = new ControlService(this, "config");
  readonly diagnostics = new ControlService(this, "diagnostics");

  constructor(options: MuniuClientOptions) {
    this.#options = options;
  }

  get capabilities(): MethodResult<"initialize">["capabilities"] | undefined {
    return this.#initializeResult?.capabilities;
  }

  async connect(signal?: AbortSignal): Promise<MethodResult<"initialize">> {
    if (this.#initialized && this.#initializeResult) return this.#initializeResult;
    this.#unsubscribe ??= this.#options.channel.subscribe((message) => { void this.#receive(message); });
    const result = await this.#callRaw("initialize", {
      clientInfo: this.#options.clientInfo,
      ...(this.#options.capabilities === undefined ? {} : { capabilities: this.#options.capabilities })
    }, signal) as MethodResult<"initialize">;
    this.#initializeResult = InitializeResultSchema.parse(result);
    await this.#options.channel.send({ method: "initialized" });
    this.#initialized = true;
    return this.#initializeResult;
  }

  call<M extends OrdinaryMethod>(method: M, params: MethodParams<M>, signal?: AbortSignal): Promise<MethodResult<M>> {
    if (!this.#initialized) return Promise.reject(new Error("MuniuClient is not connected"));
    return this.#callRaw(method, params, signal) as Promise<MethodResult<M>>;
  }

  callControl<M extends MuniuMethod>(method: M, params: MuniuControlParams = {}, signal?: AbortSignal): Promise<MuniuControlResult> {
    if (!this.#initialized) return Promise.reject(new Error("MuniuClient is not connected"));
    return this.#callRaw(method, params, signal) as Promise<MuniuControlResult>;
  }

  async startThread(params: MethodParams<"thread/start"> = {}): Promise<ThreadHandle> {
    const result = await this.call("thread/start", params);
    return new ThreadHandle(this, result.thread.id);
  }

  async resumeThread(params: MethodParams<"thread/resume">): Promise<ThreadHandle> {
    const result = await this.call("thread/resume", params);
    return new ThreadHandle(this, result.thread.id);
  }

  async forkThread(params: MethodParams<"thread/fork">): Promise<ThreadHandle> {
    const result = await this.call("thread/fork", params);
    return new ThreadHandle(this, result.thread.id);
  }

  listThreads(params: MethodParams<"thread/list"> = {}) {
    return this.call("thread/list", params);
  }

  onNotification(listener: (event: Notification) => void): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#initialized = false;
    for (const pending of this.#pending.values()) pending.reject(new Error("MuniuClient closed"));
    this.#pending.clear();
    await this.#options.channel.close();
  }

  #callRaw(method: ClientMethod | MuniuMethod, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("RPC request aborted"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id);
        reject(signal?.reason ?? new Error("RPC request aborted"));
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        method,
        resolve,
        reject,
        ...(signal === undefined ? {} : { removeAbort: () => signal.removeEventListener("abort", abort) })
      });
      void this.#options.channel.send({ id, method, params: params as JsonValue }).catch((error: unknown) => {
        this.#pending.delete(id);
        if (signal) signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async #receive(value: unknown): Promise<void> {
    const message = JsonRpcMessageSchema.safeParse(value);
    if (!message.success) return;
    const data = message.data;
    if ("id" in data && !("method" in data)) {
      if (data.id === null) return;
      const pending = this.#pending.get(data.id);
      if (!pending) return;
      this.#pending.delete(data.id);
      pending.removeAbort?.();
      if ("error" in data) {
        pending.reject(new Error(`${data.error.code}: ${data.error.message}`));
        return;
      }
      try {
        const result = isMuniuMethod(pending.method)
          ? MuniuControlResultSchema.parse(data.result)
          : (METHOD_SCHEMAS[pending.method].result as z.ZodTypeAny).parse(data.result);
        pending.resolve(result);
      } catch {
        pending.reject(new Error("RPC response failed schema validation"));
      }
      return;
    }
    if (!("method" in data)) return;
    if ("id" in data) {
      await this.#handleServerRequest(data.id, data.method, data.params);
      return;
    }
    if (!Object.hasOwn(SERVER_NOTIFICATION_SCHEMAS, data.method)) return;
    const method = data.method as ServerNotificationMethod;
    const params = SERVER_NOTIFICATION_SCHEMAS[method].parse(data.params);
    const event = { method, params } as Notification;
    for (const listener of this.#notifications) listener(event);
  }

  async #handleServerRequest(id: RequestId, methodValue: string, paramsValue: unknown): Promise<void> {
    if (!Object.hasOwn(SERVER_REQUEST_SCHEMAS, methodValue)) {
      await this.#options.channel.send({ id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    const method = methodValue as ServerRequestMethod;
    try {
      const params = SERVER_REQUEST_SCHEMAS[method].params.parse(paramsValue);
      let result: unknown;
      if (method.endsWith("/requestApproval")) {
        if (!this.#options.approvalHandler) throw new Error("Approval handler is unavailable");
        result = await this.#options.approvalHandler(method as never, params as never);
      } else if (method === "item/tool/requestUserInput") {
        if (!this.#options.userInputHandler) throw new Error("User input handler is unavailable");
        result = await this.#options.userInputHandler(params as ServerRequestParams<typeof method>);
      } else if (method === "item/tool/call") {
        if (!this.#options.dynamicToolHandler) throw new Error("Dynamic tool handler is unavailable");
        result = await this.#options.dynamicToolHandler(params as ServerRequestParams<typeof method>);
      } else {
        if (!this.#options.mcpElicitationHandler) throw new Error("MCP elicitation handler is unavailable");
        result = await this.#options.mcpElicitationHandler(params as ServerRequestParams<"mcpServer/elicitation/request">);
      }
      const parsed = SERVER_REQUEST_SCHEMAS[method].result.parse(result);
      await this.#options.channel.send({ id, result: parsed } as JsonRpcMessage);
    } catch {
      await this.#options.channel.send({ id, error: { code: -32000, message: "Client handler failed" } });
    }
  }
}
