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
import {
  createAgentEventV3,
  verifyAgentEventV3Chain,
  type AgentEventV3,
  type NewAgentEventV3,
  type SessionId
} from "@mn/agent-protocol";
import {
  AgentThreadV3NotFoundError,
  projectThreadV3,
  type AgentEventV3ContinuationInput,
  type AgentEventV3Store,
  type ThreadProjectionV3
} from "@mn/agent-session";
import type { RequestContext } from "@mn/core";
import type { Pool, PoolClient } from "pg";

import type { S3CompatibleArtifactStore } from "./artifactRemoteStore.js";
import {
  loadEnterpriseAgentEventV3Object,
  storeEnterpriseAgentEventV3Object,
  type EnterpriseAgentEventV3ObjectReference
} from "./enterpriseAgentV3ObjectStore.js";
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
  ["thread/unsubscribe", { verb: "GET", path: "/v1/agent-sessions/{id}" }],
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

export function requestContextForConnectionIdentity(identity: ConnectionIdentity): RequestContext {
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
  return enterpriseRouteAllows(verb, path) && principalAllows(requestContextForConnectionIdentity(identity), verb, path);
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

interface PostgresAgentEventV3StoreOptions {
  readonly tenantId: string;
  readonly subject: string;
  readonly pool: Pool;
  readonly objectStore: S3CompatibleArtifactStore;
  readonly objectPrefix?: string;
  readonly kmsKeyId?: string;
}

interface AgentEventV3ReferenceRow {
  readonly thread_id: string;
  readonly sequence: string;
  readonly event_digest: string;
  readonly object_key: string;
  readonly object_sha256: string;
  readonly object_bytes: string;
}

export class PostgresAgentEventV3Store implements AgentEventV3Store {
  readonly #ready: Promise<void>;

  constructor(private readonly options: PostgresAgentEventV3StoreOptions) {
    if (!options.tenantId.trim()) throw new TypeError("V3 event tenant must not be empty");
    if (!options.subject.trim()) throw new TypeError("V3 event subject must not be empty");
    this.#ready = this.#migrate();
  }

  async create(initial: NewAgentEventV3): Promise<ThreadProjectionV3> {
    await this.#ready;
    const event = createAgentEventV3(initial);
    if (event.sequence !== 0 || event.type !== "thread/created") {
      throw new TypeError("V3 thread creation requires the initial creation event");
    }
    const projection = projectThreadV3([event]);
    const stored = await this.#storeEvent(event);
    await this.#transaction(async (client) => {
      const thread = await client.query(`
        INSERT INTO mn_agent_threads_v3
          (tenant_id,thread_id,owner_subject,migration_id,last_sequence,last_digest,
           source_header_digest,created_at,updated_at)
        VALUES ($1,$2,$3,NULL,0,$4,NULL,$5::timestamptz,$5::timestamptz)
        ON CONFLICT DO NOTHING RETURNING thread_id
      `, [
        this.options.tenantId,
        event.threadId,
        this.options.subject,
        event.digest,
        event.occurredAt
      ]);
      if (thread.rowCount !== 1) throw new Error("V3 thread already exists");
      await this.#insertEvent(client, event, stored);
    });
    return projection;
  }

  async append(threadId: SessionId, input: AgentEventV3ContinuationInput): Promise<AgentEventV3> {
    await this.#ready;
    return this.#transaction(async (client) => {
      const tail = await client.query<{ last_sequence: string; last_digest: string }>(`
        SELECT last_sequence::text,last_digest FROM mn_agent_threads_v3
        WHERE tenant_id=$1 AND thread_id=$2
          AND (owner_subject=$3 OR owner_subject IS NULL)
        FOR UPDATE
      `, [this.options.tenantId, threadId, this.options.subject]);
      if (!tail.rows[0]) throw new AgentThreadV3NotFoundError();
      const events = await this.#readWith(client, threadId);
      const previous = events.at(-1);
      if (!previous
        || previous.sequence !== Number(tail.rows[0].last_sequence)
        || previous.digest !== tail.rows[0].last_digest) {
        throw new Error("enterprise V3 thread tail does not match its event index");
      }
      const event = createAgentEventV3({
        ...input,
        threadId,
        sequence: previous.sequence + 1,
        causationId: previous.eventId,
        previousDigest: previous.digest
      });
      projectThreadV3([...events, event]);
      const stored = await this.#storeEvent(event);
      await this.#insertEvent(client, event, stored);
      const updated = await client.query(`
        UPDATE mn_agent_threads_v3
        SET last_sequence=$3,last_digest=$4,updated_at=$5::timestamptz
        WHERE tenant_id=$1 AND thread_id=$2 AND last_sequence=$6 AND last_digest=$7
      `, [
        this.options.tenantId,
        threadId,
        event.sequence,
        event.digest,
        event.occurredAt,
        previous.sequence,
        previous.digest
      ]);
      if (updated.rowCount !== 1) throw new Error("V3 event append conflicted");
      return event;
    });
  }

  async read(threadId: SessionId): Promise<readonly AgentEventV3[]> {
    await this.#ready;
    return this.#readWith(this.options.pool, threadId);
  }

  async list(): Promise<readonly ThreadProjectionV3[]> {
    await this.#ready;
    const result = await this.options.pool.query<AgentEventV3ReferenceRow>(`
      SELECT thread_id,sequence::text,event_digest,object_key,object_sha256,object_bytes::text
      FROM mn_agent_events_v3 AS event
      WHERE tenant_id=$1
        AND EXISTS (
          SELECT 1 FROM mn_agent_threads_v3 AS thread
          WHERE thread.tenant_id=event.tenant_id AND thread.thread_id=event.thread_id
            AND (thread.owner_subject=$2 OR thread.owner_subject IS NULL)
        )
      ORDER BY thread_id,sequence
    `, [this.options.tenantId, this.options.subject]);
    const grouped = new Map<string, AgentEventV3ReferenceRow[]>();
    for (const row of result.rows) {
      const rows = grouped.get(row.thread_id) ?? [];
      rows.push(row);
      grouped.set(row.thread_id, rows);
    }
    const projections: ThreadProjectionV3[] = [];
    for (const rows of grouped.values()) {
      const events = await this.#loadRows(rows);
      projections.push(projectThreadV3(events));
    }
    return Object.freeze(projections.sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  async #readWith(
    queryable: Pick<Pool, "query"> | Pick<PoolClient, "query">,
    threadId: SessionId
  ): Promise<readonly AgentEventV3[]> {
    const authorized = await queryable.query(`
      SELECT 1 FROM mn_agent_threads_v3
      WHERE tenant_id=$1 AND thread_id=$2
        AND (owner_subject=$3 OR owner_subject IS NULL)
    `, [this.options.tenantId, threadId, this.options.subject]);
    if (authorized.rowCount !== 1) throw new AgentThreadV3NotFoundError();
    const result = await queryable.query<AgentEventV3ReferenceRow>(`
      SELECT thread_id,sequence::text,event_digest,object_key,object_sha256,object_bytes::text
      FROM mn_agent_events_v3
      WHERE tenant_id=$1 AND thread_id=$2 ORDER BY sequence
    `, [this.options.tenantId, threadId]);
    if (result.rows.length === 0) throw new AgentThreadV3NotFoundError();
    const events = await this.#loadRows(result.rows);
    if (events.some((event) => event.threadId !== threadId)) throw new TypeError("stored V3 event thread does not match its index");
    verifyAgentEventV3Chain(events);
    return events;
  }

  async #loadRows(rows: readonly AgentEventV3ReferenceRow[]): Promise<readonly AgentEventV3[]> {
    const events: AgentEventV3[] = [];
    for (const row of rows) {
      const sequence = Number(row.sequence);
      const objectBytes = Number(row.object_bytes);
      if (!Number.isSafeInteger(sequence) || sequence < 0
        || !Number.isSafeInteger(objectBytes) || objectBytes < 1) {
        throw new TypeError("enterprise V3 event index contains invalid numeric fields");
      }
      events.push(await loadEnterpriseAgentEventV3Object(this.options.objectStore, {
        threadId: row.thread_id,
        sequence,
        eventDigest: row.event_digest,
        objectKey: row.object_key,
        objectSha256: row.object_sha256,
        objectBytes
      }));
    }
    verifyAgentEventV3Chain(events);
    return Object.freeze(events);
  }

  async #storeEvent(event: AgentEventV3): Promise<EnterpriseAgentEventV3ObjectReference> {
    const stored = await storeEnterpriseAgentEventV3Object({
      store: this.options.objectStore,
      input: { tenantId: this.options.tenantId, threadId: event.threadId, event },
      ...(this.options.objectPrefix === undefined ? {} : { prefix: this.options.objectPrefix }),
      ...(this.options.kmsKeyId === undefined ? {} : { kmsKeyId: this.options.kmsKeyId })
    });
    return { threadId: event.threadId, sequence: event.sequence, eventDigest: event.digest, ...stored };
  }

  async #insertEvent(
    client: Pick<PoolClient, "query">,
    event: AgentEventV3,
    stored: EnterpriseAgentEventV3ObjectReference
  ): Promise<void> {
    const result = await client.query(`
      INSERT INTO mn_agent_events_v3
        (tenant_id,thread_id,sequence,event_id,event_digest,source_event_digest,
         object_key,object_sha256,object_bytes,migration_id,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10::timestamptz)
      ON CONFLICT DO NOTHING RETURNING sequence
    `, [
      this.options.tenantId,
      event.threadId,
      event.sequence,
      event.eventId,
      event.digest,
      event.source?.eventDigest ?? null,
      stored.objectKey,
      stored.objectSha256,
      stored.objectBytes,
      event.occurredAt
    ]);
    if (result.rowCount !== 1) throw new Error("V3 event append conflicted");
  }

  async #migrate(): Promise<void> {
    await this.options.pool.query(`
      CREATE TABLE IF NOT EXISTS mn_agent_migrations_v3 (
        migration_id text PRIMARY KEY,
        status text NOT NULL CHECK (status IN ('applying','applied','rolled_back')),
        manifest jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mn_agent_threads_v3 (
        tenant_id text NOT NULL,
        thread_id text NOT NULL,
        owner_subject text,
        migration_id text REFERENCES mn_agent_migrations_v3(migration_id) ON DELETE RESTRICT,
        last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
        last_digest char(64) NOT NULL,
        source_header_digest char(64),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id,thread_id)
      );
      CREATE TABLE IF NOT EXISTS mn_agent_events_v3 (
        tenant_id text NOT NULL,
        thread_id text NOT NULL,
        sequence bigint NOT NULL CHECK (sequence >= 0),
        event_id text NOT NULL,
        event_digest char(64) NOT NULL,
        source_event_digest char(64),
        object_key text NOT NULL,
        object_sha256 char(64) NOT NULL,
        object_bytes bigint NOT NULL CHECK (object_bytes > 0),
        migration_id text REFERENCES mn_agent_migrations_v3(migration_id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id,thread_id,sequence),
        UNIQUE (tenant_id,thread_id,event_id),
        FOREIGN KEY (tenant_id,thread_id)
          REFERENCES mn_agent_threads_v3(tenant_id,thread_id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS mn_agent_events_v3_tenant_thread_idx
        ON mn_agent_events_v3 (tenant_id,thread_id,sequence);
      ALTER TABLE mn_agent_threads_v3 ALTER COLUMN migration_id DROP NOT NULL;
      ALTER TABLE mn_agent_threads_v3 ALTER COLUMN source_header_digest DROP NOT NULL;
      ALTER TABLE mn_agent_threads_v3 ADD COLUMN IF NOT EXISTS owner_subject text;
      CREATE INDEX IF NOT EXISTS mn_agent_threads_v3_owner_idx
        ON mn_agent_threads_v3 (tenant_id,owner_subject,updated_at DESC,thread_id);
    `);
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
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
    private readonly subject: string,
    private readonly pool: Pool,
    options: {
      readonly pollIntervalMs?: number;
      readonly onPollError?: (error: unknown) => void;
    } = {}
  ) {
    if (!tenantId.trim()) throw new TypeError("notification tenant must not be empty");
    if (!subject.trim()) throw new TypeError("notification subject must not be empty");
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
      INSERT INTO mn_app_server_notifications (tenant_id,subject_id,notification)
      VALUES ($1,$2,$3::jsonb) RETURNING sequence::text
    `, [this.tenantId, this.subject, JSON.stringify(notification)]);
    const sequence = result.rows[0]?.sequence;
    if (!sequence) throw new Error("notification append returned no cursor");
    return { cursor: sequence };
  }

  async readAfter(value?: string): Promise<readonly { cursor: string; notification: PersistedNotification }[]> {
    await this.#ready;
    const result = await this.pool.query<{ sequence: string; notification: unknown }>(`
      SELECT sequence::text,notification FROM mn_app_server_notifications
      WHERE tenant_id=$1 AND subject_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 10000
    `, [this.tenantId, this.subject, cursor(value)]);
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
        subject_id text NOT NULL,
        notification jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS mn_app_server_notification_tenant_idx
        ON mn_app_server_notifications (tenant_id,subject_id,sequence);
    `);
  }

  async #latestCursor(): Promise<string> {
    const result = await this.pool.query<{ sequence: string }>(`
      SELECT coalesce(max(sequence),0)::text AS sequence
      FROM mn_app_server_notifications WHERE tenant_id=$1 AND subject_id=$2
    `, [this.tenantId, this.subject]);
    return result.rows[0]?.sequence ?? "0";
  }
}

export function createEnterpriseAppServerGateway(options: {
  readonly auth: EnterpriseAuthOptions;
  readonly origins: readonly string[];
  readonly pool: Pool;
  readonly createConnectionOptions: (
    identity: ConnectionIdentity,
    notify: Parameters<EnterpriseAppServerGatewayOptions["createConnectionOptions"]>[1]
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
    createConnectionOptions: (identity, notify) => {
      const base = options.createConnectionOptions(identity, notify);
      return {
        ...base,
        notificationLog: new PostgresNotificationLog(identity.tenantId, identity.subject, options.pool)
      };
    },
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
    ...(options.maxRequestsPerMinute === undefined ? {} : { maxRequestsPerMinute: options.maxRequestsPerMinute })
  });
}
