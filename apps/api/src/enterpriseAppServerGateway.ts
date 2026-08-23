// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  EnterpriseAppServerGateway,
  type AppServerConnectionOptions,
  type ConnectionIdentity,
  type ConnectionLease,
  type ConnectionLeaseStore,
  type EnterpriseAppServerGatewayOptions,
  type NotificationLog,
  type PersistedNotification
} from "@mn/app-server";
import {
  SERVER_NOTIFICATION_SCHEMAS,
  controlOperationForMethod,
  isMuniuMethod,
  type ClientMethod,
  type MuniuMethod,
  type ServerNotificationMethod
} from "@mn/app-server-protocol";
import type { RequestContext } from "@mn/core";
import type { Pool, PoolClient } from "pg";

import { EnterpriseJwtAuthenticator, principalAllows, type EnterpriseAuthOptions } from "./enterpriseAuth.js";
import { enterpriseRouteAllows } from "./enterpriseSurface.js";

type RpcMethod = Exclude<ClientMethod, "initialize"> | MuniuMethod;

const COMPATIBLE_ROUTE = new Map<Exclude<ClientMethod, "initialize">, { verb: string; path: string }>([
  ["thread/start", { verb: "POST", path: "/v1/agent-sessions" }],
  ["thread/resume", { verb: "GET", path: "/v1/agent-sessions/{id}" }],
  ["thread/fork", { verb: "POST", path: "/v1/agent-sessions" }],
  ["thread/list", { verb: "GET", path: "/v1/agent-sessions" }],
  ["thread/loaded/list", { verb: "GET", path: "/v1/agent-sessions" }],
  ["thread/read", { verb: "GET", path: "/v1/agent-sessions/{id}" }],
  ["thread/archive", { verb: "POST", path: "/v1/agent-sessions/{id}/close" }],
  ["thread/unarchive", { verb: "POST", path: "/v1/agent-sessions/{id}/messages" }],
  ["thread/delete", { verb: "POST", path: "/v1/agent-sessions/{id}/close" }],
  ["thread/unsubscribe", { verb: "GET", path: "/v1/agent-sessions/{id}/events" }],
  ["thread/name/set", { verb: "POST", path: "/v1/agent-sessions/{id}/messages" }],
  ["thread/goal/set", { verb: "POST", path: "/v1/agent-sessions/{id}/messages" }],
  ["thread/goal/get", { verb: "GET", path: "/v1/agent-sessions/{id}" }],
  ["thread/goal/clear", { verb: "POST", path: "/v1/agent-sessions/{id}/messages" }],
  ["thread/compact/start", { verb: "POST", path: "/v1/agent-sessions/{id}/messages" }],
  ["turn/start", { verb: "POST", path: "/v1/agent-sessions/{id}/messages" }],
  ["turn/steer", { verb: "POST", path: "/v1/agent-sessions/{id}/messages" }],
  ["turn/interrupt", { verb: "POST", path: "/v1/agent-sessions/{id}/cancel" }],
  ["review/start", { verb: "POST", path: "/v1/agent-sessions" }],
  ["model/list", { verb: "GET", path: "/v1/providers" }],
  ["skills/list", { verb: "GET", path: "/v1/skills" }],
  ["skills/extraRoots/set", { verb: "POST", path: "/v1/skills" }],
  ["hooks/list", { verb: "GET", path: "/v1/runtime/plugins" }],
  ["config/read", { verb: "GET", path: "/v1/capabilities" }],
  ["config/mcpServer/reload", { verb: "POST", path: "/v1/mcp/servers" }],
  ["mcpServerStatus/list", { verb: "GET", path: "/v1/mcp/servers" }],
  ["mcpServer/resource/read", { verb: "GET", path: "/v1/mcp/servers/{id}" }],
  ["mcpServer/tool/call", { verb: "POST", path: "/v1/mcp/servers/{id}/project" }]
]);

function permissionProfile(context: RequestContext): string {
  return context.roles.some((role) => role === "org_admin" || role === "project_owner" || role === "developer")
    ? "workspace-write"
    : "read-only";
}

export function connectionIdentity(context: RequestContext): ConnectionIdentity {
  const profile = permissionProfile(context);
  return Object.freeze({
    tenantId: context.tenantId,
    subject: context.actorId,
    roles: Object.freeze([...context.roles]),
    projectIds: Object.freeze([...context.projectIds]),
    principalType: context.principalType,
    scopes: Object.freeze([...context.scopes]),
    permissionProfile: profile,
    sandbox: Object.freeze({ mode: profile, network: false })
  });
}

function requestContext(identity: ConnectionIdentity): RequestContext {
  return {
    tenantId: identity.tenantId,
    actorId: identity.subject,
    roles: [...identity.roles] as RequestContext["roles"],
    projectIds: [...(identity.projectIds ?? [])],
    principalType: identity.principalType ?? "human",
    scopes: [...(identity.scopes ?? [])] as RequestContext["scopes"],
    authentication: "oidc",
    traceId: randomUUID()
  };
}

export function enterpriseRpcMethodAllows(identity: ConnectionIdentity, method: RpcMethod): boolean {
  const route = isMuniuMethod(method)
    ? controlOperationForMethod(method)
    : COMPATIBLE_ROUTE.get(method);
  if (!route) return false;
  const verb = "verb" in route ? route.verb.toUpperCase() : "GET";
  const path = "path" in route ? route.path : "/";
  return enterpriseRouteAllows(verb, path) && principalAllows(requestContext(identity), verb, path);
}

export class PostgresConnectionLeaseStore implements ConnectionLeaseStore {
  readonly #ready: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly maxConnectionsPerSubject = 8
  ) {
    if (!Number.isSafeInteger(maxConnectionsPerSubject) || maxConnectionsPerSubject < 1) {
      throw new TypeError("connection lease limit must be a positive integer");
    }
    this.#ready = this.#migrate();
  }

  async acquire(input: ConnectionLease): Promise<boolean> {
    await this.#ready;
    return this.#transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${input.tenantId}\0${input.subject}`]);
      await client.query("DELETE FROM mn_app_server_leases WHERE expires_at <= now()");
      const count = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM mn_app_server_leases
        WHERE tenant_id=$1 AND subject_id=$2
      `, [input.tenantId, input.subject]);
      if (Number(count.rows[0]?.count ?? 0) >= this.maxConnectionsPerSubject) return false;
      const inserted = await client.query(`
        INSERT INTO mn_app_server_leases (lease_id,tenant_id,subject_id,expires_at)
        VALUES ($1,$2,$3,to_timestamp($4 / 1000.0))
        ON CONFLICT (lease_id) DO NOTHING
        RETURNING lease_id
      `, [input.leaseId, input.tenantId, input.subject, input.expiresAt]);
      return inserted.rowCount === 1;
    });
  }

  async renew(leaseId: string, expiresAt: number): Promise<boolean> {
    await this.#ready;
    const result = await this.pool.query(`
      UPDATE mn_app_server_leases SET expires_at=to_timestamp($2 / 1000.0)
      WHERE lease_id=$1 AND expires_at > now()
    `, [leaseId, expiresAt]);
    return result.rowCount === 1;
  }

  async release(leaseId: string): Promise<void> {
    await this.#ready;
    await this.pool.query("DELETE FROM mn_app_server_leases WHERE lease_id=$1", [leaseId]);
  }

  async #migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mn_app_server_leases (
        lease_id uuid PRIMARY KEY,
        tenant_id text NOT NULL,
        subject_id text NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mn_app_server_lease_subject_idx
        ON mn_app_server_leases (tenant_id,subject_id,expires_at);
    `);
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function cursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError("notification cursor is invalid");
  return parsed;
}

function persistedNotification(value: unknown): PersistedNotification {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("persisted notification is invalid");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.method !== "string" || !Object.hasOwn(SERVER_NOTIFICATION_SCHEMAS, record.method)) {
    throw new TypeError("persisted notification method is invalid");
  }
  const method = record.method as ServerNotificationMethod;
  return { method, params: SERVER_NOTIFICATION_SCHEMAS[method].parse(record.params) } as PersistedNotification;
}

export class PostgresNotificationLog implements NotificationLog {
  readonly #ready: Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #onPollError: (error: unknown) => void;

  constructor(
    private readonly tenantId: string,
    private readonly pool: Pool,
    options: {
      readonly pollIntervalMs?: number;
      readonly onPollError?: (error: unknown) => void;
    } = {}
  ) {
    if (!tenantId.trim()) throw new TypeError("notification tenant must not be empty");
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 25) {
      throw new TypeError("notification poll interval must be at least 25 ms");
    }
    this.#onPollError = options.onPollError ?? (() => undefined);
    this.#ready = this.#migrate();
  }

  async append(notification: PersistedNotification): Promise<{ cursor: string }> {
    await this.#ready;
    const result = await this.pool.query<{ sequence: string }>(`
      INSERT INTO mn_app_server_notifications (tenant_id,notification)
      VALUES ($1,$2::jsonb) RETURNING sequence::text
    `, [this.tenantId, JSON.stringify(notification)]);
    const sequence = result.rows[0]?.sequence;
    if (!sequence) throw new Error("notification append returned no cursor");
    return { cursor: sequence };
  }

  async readAfter(value?: string): Promise<readonly { cursor: string; notification: PersistedNotification }[]> {
    await this.#ready;
    const result = await this.pool.query<{ sequence: string; notification: unknown }>(`
      SELECT sequence::text,notification FROM mn_app_server_notifications
      WHERE tenant_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 10000
    `, [this.tenantId, cursor(value)]);
    return Object.freeze(result.rows.map((row) => ({
      cursor: row.sequence,
      notification: persistedNotification(row.notification)
    })));
  }

  async subscribeAfter(
    value: string | undefined,
    listener: (entry: { readonly cursor: string; readonly notification: PersistedNotification }) => void
  ): Promise<() => void> {
    await this.#ready;
    let current = value ?? await this.#latestCursor();
    let stopped = false;
    let polling = false;
    const poll = async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        for (const entry of await this.readAfter(current)) {
          if (stopped) break;
          listener(entry);
          current = entry.cursor;
        }
      } finally {
        polling = false;
      }
    };
    const schedulePoll = () => { void poll().catch(this.#onPollError); };
    const timer = setInterval(schedulePoll, this.#pollIntervalMs);
    timer.unref();
    schedulePoll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async #migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mn_app_server_notifications (
        sequence bigserial PRIMARY KEY,
        tenant_id text NOT NULL,
        notification jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS mn_app_server_notification_tenant_idx
        ON mn_app_server_notifications (tenant_id,sequence);
    `);
  }

  async #latestCursor(): Promise<string> {
    const result = await this.pool.query<{ sequence: string }>(`
      SELECT coalesce(max(sequence),0)::text AS sequence
      FROM mn_app_server_notifications WHERE tenant_id=$1
    `, [this.tenantId]);
    return result.rows[0]?.sequence ?? "0";
  }
}

export function createEnterpriseAppServerGateway(options: {
  readonly auth: EnterpriseAuthOptions;
  readonly origins: readonly string[];
  readonly pool: Pool;
  readonly createConnectionOptions: (
    identity: ConnectionIdentity
  ) => Omit<
    ReturnType<EnterpriseAppServerGatewayOptions["createConnectionOptions"]>,
    "notificationLog"
  >;
  readonly maxConnectionsPerSubject?: number;
  readonly leaseTtlMs?: number;
  readonly maxRequestsPerMinute?: number;
}): EnterpriseAppServerGateway {
  const authenticator = new EnterpriseJwtAuthenticator(options.auth);
  return new EnterpriseAppServerGateway({
    origins: options.origins,
    authenticate: async (authorization) => connectionIdentity(
      await authenticator.authenticate(authorization, randomUUID())
    ),
    authorize: enterpriseRpcMethodAllows,
    leases: new PostgresConnectionLeaseStore(options.pool, options.maxConnectionsPerSubject),
    createConnectionOptions: (identity) => {
      const base = options.createConnectionOptions(identity);
      return {
        ...base,
        notificationLog: new PostgresNotificationLog(identity.tenantId, options.pool)
      };
    },
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
    ...(options.maxRequestsPerMinute === undefined ? {} : { maxRequestsPerMinute: options.maxRequestsPerMinute })
  });
}
