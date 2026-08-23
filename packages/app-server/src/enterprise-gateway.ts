// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";

import type { JsonRpcMessage } from "@mn/app-server-protocol";
import { WebSocketServer, type WebSocket } from "ws";

import {
  AppServerConnection,
  type AppServerConnectionOptions,
  type ConnectionIdentity
} from "./connection.js";
import { MAX_FRAME_BYTES } from "./outbound-queue.js";
import type { TransportPeer } from "./transports.js";

export interface ConnectionLease {
  readonly leaseId: string;
  readonly tenantId: string;
  readonly subject: string;
  readonly expiresAt: number;
}

export interface ConnectionLeaseStore {
  acquire(input: ConnectionLease): Promise<boolean>;
  renew(leaseId: string, expiresAt: number): Promise<boolean>;
  release(leaseId: string): Promise<void>;
}

export class InMemoryConnectionLeaseStore implements ConnectionLeaseStore {
  readonly #leases = new Map<string, ConnectionLease>();
  readonly #maxConnectionsPerSubject: number;

  constructor(options: { readonly maxConnectionsPerSubject?: number } = {}) {
    this.#maxConnectionsPerSubject = options.maxConnectionsPerSubject ?? 8;
    if (!Number.isSafeInteger(this.#maxConnectionsPerSubject) || this.#maxConnectionsPerSubject < 1) {
      throw new TypeError("connection lease limit must be a positive integer");
    }
  }

  get size(): number {
    this.#prune(Date.now());
    return this.#leases.size;
  }

  async acquire(input: ConnectionLease): Promise<boolean> {
    this.#prune(Date.now());
    const count = [...this.#leases.values()].filter((lease) =>
      lease.tenantId === input.tenantId && lease.subject === input.subject
    ).length;
    if (count >= this.#maxConnectionsPerSubject || this.#leases.has(input.leaseId)) return false;
    this.#leases.set(input.leaseId, Object.freeze({ ...input }));
    return true;
  }

  async renew(leaseId: string, expiresAt: number): Promise<boolean> {
    this.#prune(Date.now());
    const lease = this.#leases.get(leaseId);
    if (!lease) return false;
    this.#leases.set(leaseId, Object.freeze({ ...lease, expiresAt }));
    return true;
  }

  async release(leaseId: string): Promise<void> {
    this.#leases.delete(leaseId);
  }

  #prune(now: number): void {
    for (const [leaseId, lease] of this.#leases) {
      if (lease.expiresAt <= now) this.#leases.delete(leaseId);
    }
  }
}

export interface GatewayConnectionMetadata {
  readonly authorization?: string;
  readonly origin?: string;
  readonly secure: boolean;
  readonly remoteAddress?: string;
  readonly resumeCursor?: string;
}

export interface EnterpriseAppServerGatewayOptions {
  readonly origins: readonly string[];
  readonly authenticate: (authorization: string | undefined) => Promise<ConnectionIdentity>;
  readonly authorize: (
    identity: ConnectionIdentity,
    method: Parameters<NonNullable<AppServerConnectionOptions["authorizeRequest"]>>[0]
  ) => boolean | Promise<boolean>;
  readonly leases: ConnectionLeaseStore;
  readonly createConnectionOptions: (
    identity: ConnectionIdentity
  ) => Omit<AppServerConnectionOptions, "write" | "close" | "identity" | "authorizeRequest" | "resumeCursor">;
  readonly leaseTtlMs?: number;
  readonly maxRequestsPerMinute?: number;
  readonly now?: () => number;
}

export interface EnterpriseGatewayConnection {
  readonly identity: ConnectionIdentity;
  receiveText(text: string): Promise<void>;
  idle(): Promise<void>;
  close(): Promise<void>;
}

function identitySnapshot(identity: ConnectionIdentity): ConnectionIdentity {
  for (const [field, value] of [
    ["tenantId", identity.tenantId],
    ["subject", identity.subject],
    ["permissionProfile", identity.permissionProfile]
  ] as const) {
    if (!value.trim() || value !== value.trim()) {
      throw new TypeError(`connection identity ${field} must be a non-empty trimmed string`);
    }
  }
  const strings = (values: readonly string[] | undefined, field: string): readonly string[] | undefined => {
    if (values === undefined) return undefined;
    if (values.some((value) => !value.trim() || value !== value.trim())) {
      throw new TypeError(`connection identity ${field} must contain trimmed strings`);
    }
    return Object.freeze([...values]);
  };
  const roles = strings(identity.roles, "roles")!;
  const projectIds = strings(identity.projectIds, "projectIds");
  const scopes = strings(identity.scopes, "scopes");
  return Object.freeze({
    tenantId: identity.tenantId,
    subject: identity.subject,
    roles,
    permissionProfile: identity.permissionProfile,
    sandbox: Object.freeze({ ...identity.sandbox }),
    ...(projectIds === undefined ? {} : { projectIds }),
    ...(identity.principalType === undefined ? {} : { principalType: identity.principalType }),
    ...(scopes === undefined ? {} : { scopes })
  });
}

export class EnterpriseAppServerGateway {
  readonly #options: EnterpriseAppServerGatewayOptions;
  readonly #origins: ReadonlySet<string>;
  readonly #leaseTtlMs: number;
  readonly #maxRequestsPerMinute: number;

  constructor(options: EnterpriseAppServerGatewayOptions) {
    this.#options = options;
    this.#origins = new Set(options.origins);
    if (this.#origins.size === 0) throw new TypeError("enterprise gateway requires an origin allowlist");
    this.#leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.#maxRequestsPerMinute = options.maxRequestsPerMinute ?? 600;
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs < 1_000) {
      throw new TypeError("connection lease TTL must be at least one second");
    }
    if (!Number.isSafeInteger(this.#maxRequestsPerMinute) || this.#maxRequestsPerMinute < 1) {
      throw new TypeError("request rate limit must be a positive integer");
    }
  }

  async accept(metadata: GatewayConnectionMetadata, peer: TransportPeer): Promise<EnterpriseGatewayConnection> {
    if (!metadata.secure) throw new Error("Enterprise app-server requires TLS");
    if (metadata.origin !== undefined && !this.#origins.has(metadata.origin)) {
      throw new Error("Enterprise app-server origin is not allowed");
    }
    const identity = identitySnapshot(await this.#options.authenticate(metadata.authorization));
    const now = this.#options.now ?? Date.now;
    const leaseId = randomUUID();
    const acquired = await this.#options.leases.acquire({
      leaseId,
      tenantId: identity.tenantId,
      subject: identity.subject,
      expiresAt: now() + this.#leaseTtlMs
    });
    if (!acquired) throw new Error("Enterprise app-server connection lease was denied");

    let releasePromise: Promise<void> | undefined;
    const release = (closePeer: boolean): Promise<void> => {
      if (releasePromise !== undefined) return releasePromise;
      releasePromise = (async () => {
        try {
          await this.#options.leases.release(leaseId);
        } finally {
          if (closePeer) peer.close();
        }
      })();
      return releasePromise;
    };
    let server: AppServerConnection;
    try {
      server = new AppServerConnection({
        ...this.#options.createConnectionOptions(identity),
        identity,
        authorizeRequest: (method) => this.#options.authorize(identity, method),
        ...(metadata.resumeCursor === undefined ? {} : { resumeCursor: metadata.resumeCursor }),
        write: (message) => peer.send(message),
        close: () => { void release(true); }
      });
    } catch (error) {
      await release(true);
      throw error;
    }
    let windowStarted = now();
    let requests = 0;
    return {
      identity,
      receiveText: async (text) => {
        if (releasePromise !== undefined) throw new Error("Enterprise app-server connection is closed");
        let countsAsRequest = false;
        try {
          const value = JSON.parse(text) as unknown;
          countsAsRequest = value !== null && typeof value === "object" && !Array.isArray(value)
            && Object.hasOwn(value, "id") && Object.hasOwn(value, "method");
        } catch {
          countsAsRequest = true;
        }
        const current = now();
        if (current - windowStarted >= 60_000) {
          windowStarted = current;
          requests = 0;
        }
        if (countsAsRequest && ++requests > this.#maxRequestsPerMinute) {
          server.close();
          await release(true);
          throw new Error("Enterprise app-server request rate limit exceeded");
        }
        if (!await this.#options.leases.renew(leaseId, current + this.#leaseTtlMs)) {
          server.close();
          await release(true);
          throw new Error("Enterprise app-server connection lease expired");
        }
        await server.receiveText(text);
      },
      idle: () => server.idle(),
      close: async () => {
        server.close();
        await release(true);
      }
    };
  }
}

function rejectUpgrade(request: IncomingMessage, status: number, message: string): void {
  request.socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  request.socket.destroy();
}

function socketIsSecure(request: IncomingMessage): boolean {
  return Boolean((request.socket as TLSSocket).encrypted);
}

function sendWebSocket(socket: WebSocket, message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
      reject(new RangeError("RPC frame exceeds 16 MiB"));
      return;
    }
    socket.send(text, (error) => error ? reject(error) : resolve());
  });
}

export function attachEnterpriseWebSocketGateway(options: {
  readonly server: HttpServer;
  readonly gateway: EnterpriseAppServerGateway;
  readonly path?: string;
}): { close(): Promise<void> } {
  const path = options.path ?? "/app-server";
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const sockets = new Set<WebSocket>();
  const onUpgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "https://gateway.invalid");
    if (url.pathname !== path) return;
    let websocket: WebSocket | undefined;
    const peer: TransportPeer = {
      send: (message) => websocket === undefined
        ? Promise.reject(new Error("WebSocket upgrade is incomplete"))
        : sendWebSocket(websocket, message),
      close: () => websocket?.close()
    };
    void options.gateway.accept({
      authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      secure: socketIsSecure(request),
      remoteAddress: request.socket.remoteAddress,
      resumeCursor: url.searchParams.get("cursor") ?? undefined
    }, peer).then((connection) => {
      websocketServer.handleUpgrade(request, socket, head, (accepted) => {
        websocket = accepted;
        sockets.add(accepted);
        let chain = Promise.resolve();
        accepted.on("message", (data, isBinary) => {
          if (isBinary) {
            accepted.close(1003, "Text frames required");
            return;
          }
          chain = chain.then(() => connection.receiveText(data.toString())).catch(() => {
            accepted.close(1008, "Request rejected");
          });
        });
        accepted.once("close", () => {
          sockets.delete(accepted);
          void chain.finally(() => connection.close());
        });
        accepted.once("error", () => { void connection.close(); });
      });
    }).catch((error: unknown) => {
      rejectUpgrade(request, 401, error instanceof Error ? "Unauthorized" : "Unauthorized");
    });
  };
  options.server.on("upgrade", onUpgrade);
  return {
    close: async () => {
      options.server.off("upgrade", onUpgrade);
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    }
  };
}
