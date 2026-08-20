// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  PROTECTION_POLICY_DIGEST_V1,
  SessionId,
  deepFreeze,
  inspectAgentModelBindingV1,
  isAgentSessionEventV1,
  isCanonicalRfc3339,
  isProtectedTextV1,
  type AgentSessionEventPayloadMapV1,
  type AgentSessionEventTypeV1,
  type AgentSessionEventV1
} from "@mn/agent-protocol";
import {
  AgentSessionNotFoundError,
  RemoteAgentSessionStore,
  type AgentSessionHeaderV1,
  type RemoteAgentSessionBackend,
  type RemoteAgentSessionSnapshot
} from "@mn/agent-session";
import type { S3CompatibleArtifactStore } from "./artifactRemoteStore.js";

interface EnterpriseAgentSessionBackendOptions {
  readonly tenantId: string;
  readonly pool: Pool;
  readonly objectStore: S3CompatibleArtifactStore;
  readonly objectPrefix?: string;
  readonly kmsKeyId?: string;
}

interface EventEnvelope {
  readonly schemaVersion: 1;
  readonly event: AgentSessionEventV1;
  readonly runtimePayload: AgentSessionEventPayloadMapV1[AgentSessionEventTypeV1];
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectKey(prefix: string, sessionId: string, event: AgentSessionEventV1): string {
  return [prefix, "agent-sessions", sessionId, "events", `${String(event.seq).padStart(12, "0")}-${event.digest}.json`]
    .filter(Boolean)
    .join("/");
}

function validateHeader(value: unknown, sessionId: string): AgentSessionHeaderV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid enterprise session header");
  const header = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "sessionId",
    "createdAt",
    "protectionProfile",
    "protectionPolicyDigest",
    "protectedCwd",
    "modelBinding"
  ]);
  if (Object.keys(header).some((key) => !allowed.has(key))
    || header.schemaVersion !== 1
    || header.sessionId !== sessionId
    || header.protectionProfile !== AGENT_SESSION_PROTECTION_PROFILE_V1
    || header.protectionPolicyDigest !== PROTECTION_POLICY_DIGEST_V1
    || !isCanonicalRfc3339(header.createdAt)
    || (header.protectedCwd !== undefined && !isProtectedTextV1(header.protectedCwd))
    || (header.modelBinding !== undefined && inspectAgentModelBindingV1(header.modelBinding) === undefined)) {
    throw new Error("invalid enterprise session header");
  }
  return deepFreeze(header as unknown as AgentSessionHeaderV1);
}

export class EnterpriseAgentSessionBackend implements RemoteAgentSessionBackend {
  private readonly prefix: string;
  private readonly ready: Promise<void>;

  constructor(private readonly options: EnterpriseAgentSessionBackendOptions) {
    if (!options.tenantId.trim()) throw new TypeError("enterprise Agent session tenant must not be empty");
    this.prefix = (options.objectPrefix ?? "").replace(/^\/+|\/+$/gu, "");
    this.ready = this.migrate();
  }

  private async migrate(): Promise<void> {
    await this.options.pool.query(`
      CREATE TABLE IF NOT EXISTS mn_agent_sessions (
        tenant_id text NOT NULL,
        session_id text NOT NULL,
        header jsonb NOT NULL,
        last_seq bigint NOT NULL CHECK (last_seq >= 0),
        last_digest char(64) NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS mn_agent_session_events (
        tenant_id text NOT NULL,
        session_id text NOT NULL,
        seq bigint NOT NULL CHECK (seq >= 0),
        event_digest char(64) NOT NULL,
        object_key text NOT NULL,
        object_sha256 char(64) NOT NULL,
        object_bytes bigint NOT NULL CHECK (object_bytes > 0),
        created_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_id, session_id, seq),
        UNIQUE (tenant_id, session_id, event_digest),
        FOREIGN KEY (tenant_id, session_id)
          REFERENCES mn_agent_sessions (tenant_id, session_id)
          ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS mn_agent_session_updated_idx
        ON mn_agent_sessions (tenant_id, updated_at DESC, session_id);
    `);
  }

  async create(input: {
    readonly header: AgentSessionHeaderV1;
    readonly event: AgentSessionEventV1<"session/created">;
    readonly runtimePayload: AgentSessionEventPayloadMapV1["session/created"];
  }): Promise<void> {
    await this.ready;
    const stored = await this.storeEnvelope(input.event, input.runtimePayload);
    await this.transaction(async (client) => {
      await client.query(`
        INSERT INTO mn_agent_sessions
          (tenant_id,session_id,header,last_seq,last_digest,created_at,updated_at)
        VALUES ($1,$2,$3::jsonb,0,$4,$5::timestamptz,$5::timestamptz)
      `, [
        this.options.tenantId,
        input.header.sessionId,
        JSON.stringify(input.header),
        input.event.digest,
        input.header.createdAt
      ]);
      await this.insertEvent(client, input.event, stored);
    });
  }

  async append(
    event: AgentSessionEventV1,
    runtimePayload?: AgentSessionEventPayloadMapV1[AgentSessionEventTypeV1]
  ): Promise<void> {
    await this.ready;
    if (runtimePayload === undefined) throw new Error("enterprise Agent session events require a runtime overlay");
    const stored = await this.storeEnvelope(event, runtimePayload);
    await this.transaction(async (client) => {
      const result = await client.query<{ last_seq: string; last_digest: string }>(`
        SELECT last_seq::text,last_digest
        FROM mn_agent_sessions
        WHERE tenant_id=$1 AND session_id=$2
        FOR UPDATE
      `, [this.options.tenantId, event.sessionId]);
      const current = result.rows[0];
      if (!current) throw new AgentSessionNotFoundError();
      if (Number(current.last_seq) + 1 !== event.seq || current.last_digest !== event.previousDigest) {
        throw new Error("enterprise Agent session append compare-and-swap conflict");
      }
      await this.insertEvent(client, event, stored);
      await client.query(`
        UPDATE mn_agent_sessions
        SET last_seq=$3,last_digest=$4,updated_at=$5::timestamptz
        WHERE tenant_id=$1 AND session_id=$2
      `, [this.options.tenantId, event.sessionId, event.seq, event.digest, event.occurredAt]);
    });
  }

  async load(sessionId: SessionId): Promise<RemoteAgentSessionSnapshot> {
    await this.ready;
    const session = await this.options.pool.query<{ header: unknown; last_seq: string }>(`
      SELECT header,last_seq::text
      FROM mn_agent_sessions
      WHERE tenant_id=$1 AND session_id=$2
    `, [this.options.tenantId, sessionId]);
    if (!session.rows[0]) throw new AgentSessionNotFoundError();
    const refs = await this.options.pool.query<{
      seq: string;
      event_digest: string;
      object_key: string;
      object_sha256: string;
      object_bytes: string;
    }>(`
      SELECT events.seq::text,events.event_digest,events.object_key,
             events.object_sha256,events.object_bytes::text
      FROM mn_agent_session_events AS events
      WHERE events.tenant_id=$1 AND events.session_id=$2
      ORDER BY events.seq
    `, [this.options.tenantId, sessionId]);
    if (refs.rows.length !== Number(session.rows[0].last_seq) + 1 || refs.rows.length > 100_000) {
      throw new Error("enterprise Agent session event index is incomplete or exceeds its bound");
    }
    const events: AgentSessionEventV1[] = [];
    const overlays = new Map<number, AgentSessionEventPayloadMapV1[AgentSessionEventTypeV1]>();
    for (const ref of refs.rows) {
      const bytes = await this.options.objectStore.getObject(ref.object_key);
      if (!bytes || bytes.byteLength !== Number(ref.object_bytes) || sha256(bytes) !== ref.object_sha256) {
        throw new Error("enterprise Agent session object is missing or has been tampered with");
      }
      const envelope = JSON.parse(bytes.toString("utf8")) as EventEnvelope;
      if (envelope.schemaVersion !== 1 || !isAgentSessionEventV1(envelope.event)
        || envelope.event.sessionId !== sessionId
        || envelope.event.seq !== Number(ref.seq)
        || envelope.event.digest !== ref.event_digest
        || envelope.runtimePayload === undefined) {
        throw new Error("enterprise Agent session object does not match its PostgreSQL index");
      }
      events.push(envelope.event);
      overlays.set(envelope.event.seq, envelope.runtimePayload);
    }
    return {
      header: validateHeader(session.rows[0].header, sessionId),
      events: Object.freeze(events),
      runtimePayloads: overlays
    };
  }

  async listSessionIds(): Promise<readonly SessionId[]> {
    await this.ready;
    const result = await this.options.pool.query<{ session_id: string }>(`
      SELECT session_id
      FROM mn_agent_sessions
      WHERE tenant_id=$1
      ORDER BY updated_at DESC,session_id
      LIMIT 500
    `, [this.options.tenantId]);
    return Object.freeze(result.rows.map((row) => SessionId(row.session_id)));
  }

  private async storeEnvelope(
    event: AgentSessionEventV1,
    runtimePayload: AgentSessionEventPayloadMapV1[AgentSessionEventTypeV1]
  ) {
    const key = objectKey(this.prefix, event.sessionId, event);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, event, runtimePayload } satisfies EventEnvelope));
    const stored = await this.options.objectStore.putObject(key, bytes, {
      contentType: "application/json",
      ifNoneMatch: "*",
      ...(this.options.kmsKeyId
        ? { serverSideEncryption: "aws:kms" as const, kmsKeyId: this.options.kmsKeyId }
        : {}),
      metadata: {
        tenant: this.options.tenantId,
        session: event.sessionId,
        sequence: String(event.seq),
        digest: event.digest
      }
    });
    if (stored.sha256 !== sha256(bytes)) throw new Error("S3 returned a mismatched Agent session digest");
    return stored;
  }

  private async insertEvent(
    client: PoolClient,
    event: AgentSessionEventV1,
    stored: { key: string; sha256: string; bytes: number }
  ): Promise<void> {
    await client.query(`
      INSERT INTO mn_agent_session_events
        (tenant_id,session_id,seq,event_digest,object_key,object_sha256,object_bytes,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)
    `, [
      this.options.tenantId,
      event.sessionId,
      event.seq,
      event.digest,
      stored.key,
      stored.sha256,
      stored.bytes,
      event.occurredAt
    ]);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createEnterpriseAgentSessionStore(options: EnterpriseAgentSessionBackendOptions) {
  return new RemoteAgentSessionStore(new EnterpriseAgentSessionBackend(options));
}
