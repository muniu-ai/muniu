// SPDX-License-Identifier: Apache-2.0

import type { Pool, PoolClient } from "pg";

import type {
  AgentExecutionBindingV1,
  ApprovalPolicy,
  EnterpriseBuiltinExecutionOutputV1,
  EnterpriseBuiltinExecutionViewV1,
  EnterpriseBuiltinToolCallV1,
  EnterpriseBuiltinToolResultV1
} from "@mn/core";
import type {
  AgentApprovalDecisionV1,
  AgentSessionEvent,
  AgentToolApprovalBindingV1
} from "@mn/agent-protocol";
import { sha256Canonical } from "@mn/governance";

export interface DurableBuiltinExecutionIdentity {
  readonly tenantId: string;
  readonly workerId: string;
  readonly claimDigest: string;
}

export interface DurableBuiltinExecutionOwnerKey extends DurableBuiltinExecutionIdentity {
  readonly executionId: string;
  readonly generation: number;
  readonly ownerInstanceId: string;
}

export interface DurableBuiltinExecutionAcquireInput extends DurableBuiltinExecutionIdentity {
  readonly executionId: string;
  readonly requestDigest: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly sessionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly executionBinding: AgentExecutionBindingV1;
  readonly humanApproval: ApprovalPolicy;
  readonly ownerInstanceId: string;
}

export interface DurableBuiltinExecutionSnapshot {
  readonly view: EnterpriseBuiltinExecutionViewV1;
  readonly generation: number;
  readonly ownerInstanceId: string;
  readonly ownerLeaseExpired: boolean;
}

export interface DurableBuiltinExecutionAcquireResult extends DurableBuiltinExecutionSnapshot {
  readonly owned: boolean;
}

interface ExecutionRow {
  tenant_id: string;
  execution_id: string;
  generation: number;
  run_id: string;
  candidate_id: string;
  session_id: string;
  worker_id: string;
  claim_digest: string;
  request_digest: string;
  provider_id: string;
  model_id: string;
  execution_binding: AgentExecutionBindingV1;
  human_approval: ApprovalPolicy;
  state: EnterpriseBuiltinExecutionViewV1["state"];
  revision: string;
  owner_instance_id: string;
  owner_lease_expires_at: Date;
  owner_lease_active: boolean;
  output: EnterpriseBuiltinExecutionOutputV1 | null;
  error: string | null;
}

interface ToolRow {
  call: EnterpriseBuiltinToolCallV1 | null;
  call_digest: string | null;
  result: EnterpriseBuiltinToolResultV1 | null;
  result_digest: string | null;
}

interface ApprovalRow {
  tenant_id: string;
  session_id: string;
  approval_id: string;
  execution_id: string;
  generation: number;
  request_event_id: string;
  request_digest: string;
  binding_digest: string;
  decision: AgentApprovalDecisionV1 | null;
  resolution: "decided" | "interrupted" | null;
  client_request_id: string | null;
  decision_digest: string | null;
}

const OWNER_LEASE_MS = 15_000;
const POLL_INTERVAL_MS = 100;

/** PostgreSQL is the cross-replica mailbox and owner-lease authority. Raw tool
 * payloads exist only while an execution generation is active; the protected
 * Agent session remains the long-term evidence record. */
export class EnterpriseBuiltinAgentPersistence {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mn_builtin_agent_executions (
        tenant_id text NOT NULL,
        execution_id text NOT NULL,
        generation integer NOT NULL CHECK (generation > 0),
        run_id text NOT NULL,
        candidate_id text NOT NULL,
        session_id text NOT NULL,
        worker_id text NOT NULL,
        claim_digest char(64) NOT NULL,
        request_digest char(64) NOT NULL,
        provider_id text NOT NULL,
        model_id text NOT NULL,
        execution_binding jsonb NOT NULL,
        human_approval text NOT NULL CHECK (human_approval IN ('never','on-risk','before-merge')),
        state text NOT NULL CHECK (state IN ('running','completed','failed','cancelled')),
        revision bigint NOT NULL CHECK (revision >= 0),
        owner_instance_id text NOT NULL,
        owner_lease_expires_at timestamptz NOT NULL,
        output jsonb,
        error text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        terminal_at timestamptz,
        PRIMARY KEY (tenant_id, execution_id, generation)
      );
      CREATE INDEX IF NOT EXISTS mn_builtin_agent_execution_current_idx
        ON mn_builtin_agent_executions (tenant_id, execution_id, generation DESC);
      CREATE INDEX IF NOT EXISTS mn_builtin_agent_execution_session_idx
        ON mn_builtin_agent_executions (tenant_id, session_id, generation DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS mn_builtin_agent_one_running_session_idx
        ON mn_builtin_agent_executions (tenant_id, session_id)
        WHERE state='running';
      CREATE TABLE IF NOT EXISTS mn_builtin_agent_tool_calls (
        tenant_id text NOT NULL,
        execution_id text NOT NULL,
        generation integer NOT NULL,
        call_id text NOT NULL,
        ordinal integer NOT NULL CHECK (ordinal > 0),
        call jsonb,
        call_digest char(64),
        result jsonb,
        result_digest char(64),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz,
        PRIMARY KEY (tenant_id, execution_id, generation, call_id),
        UNIQUE (tenant_id, execution_id, generation, ordinal),
        FOREIGN KEY (tenant_id, execution_id, generation)
          REFERENCES mn_builtin_agent_executions (tenant_id, execution_id, generation)
          ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mn_builtin_agent_one_pending_tool_idx
        ON mn_builtin_agent_tool_calls (tenant_id, execution_id, generation)
        WHERE result_digest IS NULL;
      ALTER TABLE mn_builtin_agent_tool_calls
        ADD COLUMN IF NOT EXISTS call_digest char(64),
        ALTER COLUMN call DROP NOT NULL;
      CREATE TABLE IF NOT EXISTS mn_builtin_agent_approvals (
        tenant_id text NOT NULL,
        session_id text NOT NULL,
        approval_id text NOT NULL,
        execution_id text NOT NULL,
        generation integer NOT NULL,
        request_event_id text NOT NULL,
        request_digest char(64) NOT NULL,
        binding_digest char(64) NOT NULL,
        decision text CHECK (decision IN ('approve_once','approve_session_scope','deny')),
        resolution text CHECK (resolution IN ('decided','interrupted')),
        client_request_id text,
        decision_digest char(64),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        decided_at timestamptz,
        PRIMARY KEY (tenant_id, session_id, approval_id),
        FOREIGN KEY (tenant_id, execution_id, generation)
          REFERENCES mn_builtin_agent_executions (tenant_id, execution_id, generation)
          ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS mn_builtin_agent_approval_execution_idx
        ON mn_builtin_agent_approvals (tenant_id, execution_id, generation);
      ALTER TABLE mn_builtin_agent_approvals
        DROP CONSTRAINT IF EXISTS mn_builtin_agent_approvals_resolution_check,
        ADD CONSTRAINT mn_builtin_agent_approvals_resolution_check
          CHECK (resolution IN ('decided','interrupted'));
    `);
  }

  async acquire(input: DurableBuiltinExecutionAcquireInput): Promise<DurableBuiltinExecutionAcquireResult> {
    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text,$2::text)::text, 0))",
        [input.tenantId, input.executionId]
      );
      const current = await this.latest(client, input.tenantId, input.executionId, true);
      if (!current) {
        const inserted = await client.query<ExecutionRow>(`
          INSERT INTO mn_builtin_agent_executions (
            tenant_id,execution_id,generation,run_id,candidate_id,session_id,
            worker_id,claim_digest,request_digest,provider_id,model_id,
            execution_binding,human_approval,state,revision,owner_instance_id,
            owner_lease_expires_at
          ) VALUES (
            $1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,'running',0,$13,
            clock_timestamp() + ($14::text || ' milliseconds')::interval
          ) RETURNING *, owner_lease_expires_at > clock_timestamp() AS owner_lease_active
        `, [
          input.tenantId,
          input.executionId,
          input.runId,
          input.candidateId,
          input.sessionId,
          input.workerId,
          input.claimDigest,
          input.requestDigest,
          input.providerId,
          input.modelId,
          JSON.stringify(input.executionBinding),
          input.humanApproval,
          input.ownerInstanceId,
          OWNER_LEASE_MS
        ]);
        return { ...(await this.snapshot(client, inserted.rows[0]!)), owned: true };
      }

      if (current.request_digest === input.requestDigest) {
        if (current.state !== "running") {
          return { ...(await this.snapshot(client, current)), owned: false };
        }
        if (current.owner_instance_id === input.ownerInstanceId) {
          const refreshed = await this.refreshOwner(client, current, input.ownerInstanceId);
          return { ...(await this.snapshot(client, refreshed)), owned: true };
        }
        if (current.owner_lease_active) {
          return { ...(await this.snapshot(client, current)), owned: false };
        }
        const taken = await this.replaceGeneration(client, current, input);
        return { ...(await this.snapshot(client, taken)), owned: true };
      }

      if (current.worker_id === input.workerId && current.claim_digest === input.claimDigest) {
        throw new Error("enterprise builtin execution identifier is already bound to different input");
      }
      const replaced = await this.replaceGeneration(client, current, input);
      return { ...(await this.snapshot(client, replaced)), owned: true };
    });
  }

  async view(
    executionId: string,
    identity: DurableBuiltinExecutionIdentity
  ): Promise<DurableBuiltinExecutionSnapshot> {
    const row = await this.latest(this.pool, identity.tenantId, executionId, false);
    this.assertIdentity(row, identity);
    return this.snapshot(this.pool, row!);
  }

  async waitForChange(
    executionId: string,
    identity: DurableBuiltinExecutionIdentity,
    afterRevision: number,
    waitMs: number
  ): Promise<DurableBuiltinExecutionSnapshot> {
    const deadline = Date.now() + Math.max(0, waitMs);
    do {
      const snapshot = await this.view(executionId, identity);
      if (
        snapshot.view.revision > afterRevision ||
        snapshot.view.state !== "running" ||
        snapshot.view.toolCall ||
        snapshot.ownerLeaseExpired
      ) return snapshot;
      if (Date.now() >= deadline) return snapshot;
      await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    } while (true);
  }

  async sessionIsActivelyOwned(tenantId: string, sessionId: string): Promise<boolean> {
    const result = await this.pool.query(`
      SELECT 1 FROM mn_builtin_agent_executions
      WHERE tenant_id=$1 AND session_id=$2 AND state='running'
        AND owner_lease_expires_at > clock_timestamp()
      ORDER BY generation DESC
      LIMIT 1
    `, [tenantId, sessionId]);
    return (result.rowCount ?? 0) === 1;
  }

  async waitForApproval(
    key: DurableBuiltinExecutionOwnerKey,
    request: AgentSessionEvent<"approval/requested">,
    binding: AgentToolApprovalBindingV1,
    signal?: AbortSignal
  ): Promise<AgentApprovalDecisionV1> {
    const bindingDigest = sha256Canonical(binding);
    await this.ensureApproval({
      tenantId: key.tenantId,
      executionId: key.executionId,
      generation: key.generation,
      sessionId: request.sessionId,
      approvalId: binding.approvalId,
      requestEventId: request.eventId,
      requestDigest: request.digest,
      bindingDigest
    });
    do {
      if (signal?.aborted) throw new Error("enterprise Agent approval wait was cancelled");
      if (!(await this.ownerRow(this.pool, key))) {
        throw new Error("enterprise builtin execution owner lease is unavailable");
      }
      const result = await this.pool.query<ApprovalRow>(`
        SELECT tenant_id,session_id,approval_id,execution_id,generation,
               request_event_id,request_digest,binding_digest,decision,resolution,
               client_request_id,decision_digest
        FROM mn_builtin_agent_approvals
        WHERE tenant_id=$1 AND session_id=$2 AND approval_id=$3
      `, [key.tenantId, request.sessionId, binding.approvalId]);
      const approval = result.rows[0];
      this.assertApprovalBinding(approval, {
        executionId: key.executionId,
        generation: key.generation,
        requestEventId: request.eventId,
        requestDigest: request.digest,
        bindingDigest
      });
      if (approval!.decision && approval!.resolution === "decided") {
        return approval!.decision;
      }
      await delay(POLL_INTERVAL_MS, signal);
    } while (true);
  }

  async decideApproval(input: {
    readonly tenantId: string;
    readonly request: AgentSessionEvent<"approval/requested">;
    readonly binding: AgentToolApprovalBindingV1;
    readonly clientRequestId: string;
    readonly decision: AgentApprovalDecisionV1;
  }): Promise<boolean> {
    const bindingDigest = sha256Canonical(input.binding);
    const decisionDigest = sha256Canonical({
      schemaVersion: 1,
      tenantId: input.tenantId,
      sessionId: input.request.sessionId,
      approvalId: input.binding.approvalId,
      requestEventId: input.request.eventId,
      requestDigest: input.request.digest,
      bindingDigest,
      clientRequestId: input.clientRequestId,
      decision: input.decision,
      resolution: "decided"
    });
    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text,$2::text,$3::text)::text, 0))",
        [input.tenantId, input.request.sessionId, input.binding.approvalId]
      );
      let currentResult = await client.query<ApprovalRow>(`
        SELECT tenant_id,session_id,approval_id,execution_id,generation,
               request_event_id,request_digest,binding_digest,decision,resolution,
               client_request_id,decision_digest
        FROM mn_builtin_agent_approvals
        WHERE tenant_id=$1 AND session_id=$2 AND approval_id=$3
        FOR UPDATE
      `, [input.tenantId, input.request.sessionId, input.binding.approvalId]);
      let current = currentResult.rows[0];
      if (current) {
        this.assertApprovalBinding(current, {
          executionId: current.execution_id,
          generation: current.generation,
          requestEventId: input.request.eventId,
          requestDigest: input.request.digest,
          bindingDigest
        });
        if (current.decision) {
          if (current.decision !== input.decision) {
            throw new Error("enterprise Agent approval is already bound to another decision");
          }
          return true;
        }
      }
      const executionResult = await client.query<ExecutionRow>(`
        SELECT *, owner_lease_expires_at > clock_timestamp() AS owner_lease_active
        FROM mn_builtin_agent_executions
        WHERE tenant_id=$1 AND session_id=$2 AND state='running'
          AND owner_lease_expires_at > clock_timestamp()
          ${current ? "AND execution_id=$3 AND generation=$4" : ""}
        ORDER BY generation DESC
        LIMIT 1
        FOR UPDATE
      `, current
        ? [input.tenantId, input.request.sessionId, current.execution_id, current.generation]
        : [input.tenantId, input.request.sessionId]);
      const execution = executionResult.rows[0];
      if (!execution) return false;
      if (!current) {
        await this.ensureApproval({
          tenantId: input.tenantId,
          executionId: execution.execution_id,
          generation: execution.generation,
          sessionId: input.request.sessionId,
          approvalId: input.binding.approvalId,
          requestEventId: input.request.eventId,
          requestDigest: input.request.digest,
          bindingDigest
        }, client);
        currentResult = await client.query<ApprovalRow>(`
          SELECT tenant_id,session_id,approval_id,execution_id,generation,
                 request_event_id,request_digest,binding_digest,decision,resolution,
                 client_request_id,decision_digest
          FROM mn_builtin_agent_approvals
          WHERE tenant_id=$1 AND session_id=$2 AND approval_id=$3
          FOR UPDATE
        `, [input.tenantId, input.request.sessionId, input.binding.approvalId]);
        current = currentResult.rows[0];
        this.assertApprovalBinding(current, {
          executionId: execution.execution_id,
          generation: execution.generation,
          requestEventId: input.request.eventId,
          requestDigest: input.request.digest,
          bindingDigest
        });
        if (current!.decision) {
          if (current!.decision !== input.decision) {
            throw new Error("enterprise Agent approval is already bound to another decision");
          }
          return true;
        }
      }
      if (!current) {
        throw new Error("enterprise Agent approval was not registered");
      }
      if (current.decision) {
        if (current.decision !== input.decision) {
          throw new Error("enterprise Agent approval is already bound to another decision");
        }
        return true;
      }
      await client.query(`
        UPDATE mn_builtin_agent_approvals
        SET decision=$4,resolution='decided',client_request_id=$5,
            decision_digest=$6,decided_at=clock_timestamp()
        WHERE tenant_id=$1 AND session_id=$2 AND approval_id=$3
      `, [
        input.tenantId,
        input.request.sessionId,
        input.binding.approvalId,
        input.decision,
        input.clientRequestId,
        decisionDigest
      ]);
      return true;
    });
  }

  async heartbeat(key: DurableBuiltinExecutionOwnerKey): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE mn_builtin_agent_executions
      SET owner_lease_expires_at=clock_timestamp() + ($6::text || ' milliseconds')::interval,
          updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3
        AND worker_id=$4 AND claim_digest=$5 AND owner_instance_id=$7
        AND state='running' AND owner_lease_expires_at > clock_timestamp()
    `, [
      key.tenantId,
      key.executionId,
      key.generation,
      key.workerId,
      key.claimDigest,
      OWNER_LEASE_MS,
      key.ownerInstanceId
    ]);
    return (result.rowCount ?? 0) === 1;
  }

  async relinquish(key: DurableBuiltinExecutionOwnerKey): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query(`
        UPDATE mn_builtin_agent_executions
        SET owner_lease_expires_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3
          AND worker_id=$4 AND claim_digest=$5 AND owner_instance_id=$6
          AND state='running'
      `, [
        key.tenantId,
        key.executionId,
        key.generation,
        key.workerId,
        key.claimDigest,
        key.ownerInstanceId
      ]);
      if ((result.rowCount ?? 0) === 1) await this.redactToolPayloads(client, key);
    });
  }

  async publishToolCall(
    key: DurableBuiltinExecutionOwnerKey,
    call: EnterpriseBuiltinToolCallV1,
    ordinal: number
  ): Promise<void> {
    await this.transaction(async (client) => {
      const row = await this.ownerRow(client, key);
      if (!row) throw new Error("enterprise builtin execution owner lease is unavailable");
      await client.query(`
        INSERT INTO mn_builtin_agent_tool_calls
          (tenant_id,execution_id,generation,call_id,ordinal,call,call_digest)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
      `, [
        key.tenantId,
        key.executionId,
        key.generation,
        call.callId,
        ordinal,
        JSON.stringify(call),
        sha256Canonical(call)
      ]);
      await client.query(`
        UPDATE mn_builtin_agent_executions
        SET revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3
      `, [key.tenantId, key.executionId, key.generation]);
    });
  }

  async waitForToolResult(
    key: DurableBuiltinExecutionOwnerKey,
    callId: string,
    signal?: AbortSignal
  ): Promise<EnterpriseBuiltinToolResultV1> {
    do {
      if (signal?.aborted) throw new Error("enterprise builtin tool call was cancelled");
      const execution = await this.ownerRow(this.pool, key);
      if (!execution) throw new Error("enterprise builtin execution owner lease is unavailable");
      const result = await this.pool.query<ToolRow>(`
        SELECT call,call_digest,result,result_digest
        FROM mn_builtin_agent_tool_calls
        WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3 AND call_id=$4
      `, [key.tenantId, key.executionId, key.generation, callId]);
      const tool = result.rows[0];
      if (!tool) throw new Error("enterprise builtin tool call disappeared");
      if (tool.result_digest && tool.result) return tool.result;
      await delay(POLL_INTERVAL_MS, signal);
    } while (true);
  }

  async submitToolResult(
    executionId: string,
    identity: DurableBuiltinExecutionIdentity,
    result: EnterpriseBuiltinToolResultV1,
    resultDigest: string
  ): Promise<DurableBuiltinExecutionSnapshot> {
    return this.transaction(async (client) => {
      const row = await this.latest(client, identity.tenantId, executionId, true);
      this.assertIdentity(row, identity);
      const toolResult = await client.query<ToolRow>(`
        SELECT call,call_digest,result,result_digest
        FROM mn_builtin_agent_tool_calls
        WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3 AND call_id=$4
        FOR UPDATE
      `, [identity.tenantId, executionId, row!.generation, result.callId]);
      const tool = toolResult.rows[0];
      if (!tool) throw new Error("enterprise builtin tool call is not awaiting this result");
      if (tool.result_digest) {
        if (tool.result_digest !== resultDigest) {
          throw new Error("enterprise builtin tool result conflicts with its committed result");
        }
        return this.snapshot(client, row!);
      }
      if (row!.state !== "running") {
        throw new Error("enterprise builtin tool result arrived after execution termination");
      }
      await client.query(`
        UPDATE mn_builtin_agent_tool_calls
        SET result=$5::jsonb,result_digest=$6,completed_at=clock_timestamp()
        WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3 AND call_id=$4
      `, [
        identity.tenantId,
        executionId,
        row!.generation,
        result.callId,
        JSON.stringify(result),
        resultDigest
      ]);
      const updated = await client.query<ExecutionRow>(`
        UPDATE mn_builtin_agent_executions
        SET revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3
        RETURNING *, owner_lease_expires_at > clock_timestamp() AS owner_lease_active
      `, [identity.tenantId, executionId, row!.generation]);
      return this.snapshot(client, updated.rows[0]!);
    });
  }

  async complete(
    key: DurableBuiltinExecutionOwnerKey,
    state: "completed" | "failed" | "cancelled",
    output?: EnterpriseBuiltinExecutionOutputV1,
    error?: string
  ): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query(`
        UPDATE mn_builtin_agent_executions
        SET state=$7,output=$8::jsonb,error=$9,revision=revision+1,
            updated_at=clock_timestamp(),terminal_at=clock_timestamp()
        WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3
          AND worker_id=$4 AND claim_digest=$5 AND owner_instance_id=$6
          AND state='running' AND owner_lease_expires_at > clock_timestamp()
      `, [
        key.tenantId,
        key.executionId,
        key.generation,
        key.workerId,
        key.claimDigest,
        key.ownerInstanceId,
        state,
        output === undefined ? null : JSON.stringify(output),
        error ?? null
      ]);
      if ((result.rowCount ?? 0) === 1) await this.redactToolPayloads(client, key);
    });
  }

  async cancel(
    executionId: string,
    identity: DurableBuiltinExecutionIdentity
  ): Promise<DurableBuiltinExecutionSnapshot> {
    return this.transaction(async (client) => {
      const row = await this.latest(client, identity.tenantId, executionId, true);
      this.assertIdentity(row, identity);
      let current = row!;
      if (current.state === "running") {
        const updated = await client.query<ExecutionRow>(`
          UPDATE mn_builtin_agent_executions
          SET state='cancelled',error='enterprise builtin execution was cancelled',
              revision=revision+1,updated_at=clock_timestamp(),terminal_at=clock_timestamp()
          WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3
          RETURNING *, owner_lease_expires_at > clock_timestamp() AS owner_lease_active
        `, [identity.tenantId, executionId, current.generation]);
        current = updated.rows[0]!;
        await this.redactToolPayloads(client, {
          tenantId: identity.tenantId,
          executionId,
          generation: current.generation
        });
      }
      return this.snapshot(client, current);
    });
  }

  private async ensureApproval(
    input: {
      readonly tenantId: string;
      readonly executionId: string;
      readonly generation: number;
      readonly sessionId: string;
      readonly approvalId: string;
      readonly requestEventId: string;
      readonly requestDigest: string;
      readonly bindingDigest: string;
    },
    client: Pick<Pool, "query"> | PoolClient = this.pool
  ): Promise<void> {
    await client.query(`
      INSERT INTO mn_builtin_agent_approvals (
        tenant_id,session_id,approval_id,execution_id,generation,
        request_event_id,request_digest,binding_digest
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (tenant_id,session_id,approval_id) DO NOTHING
    `, [
      input.tenantId,
      input.sessionId,
      input.approvalId,
      input.executionId,
      input.generation,
      input.requestEventId,
      input.requestDigest,
      input.bindingDigest
    ]);
    const result = await client.query<ApprovalRow>(`
      SELECT tenant_id,session_id,approval_id,execution_id,generation,
             request_event_id,request_digest,binding_digest,decision,resolution,
             client_request_id,decision_digest
      FROM mn_builtin_agent_approvals
      WHERE tenant_id=$1 AND session_id=$2 AND approval_id=$3
    `, [input.tenantId, input.sessionId, input.approvalId]);
    this.assertApprovalBinding(result.rows[0], input);
  }

  private assertApprovalBinding(
    approval: ApprovalRow | undefined,
    expected: {
      readonly executionId: string;
      readonly generation: number;
      readonly requestEventId: string;
      readonly requestDigest: string;
      readonly bindingDigest: string;
    }
  ): void {
    if (
      !approval ||
      approval.execution_id !== expected.executionId ||
      approval.generation !== expected.generation ||
      approval.request_event_id !== expected.requestEventId ||
      approval.request_digest !== expected.requestDigest ||
      approval.binding_digest !== expected.bindingDigest
    ) {
      throw new Error("enterprise Agent approval binding changed");
    }
  }

  private async replaceGeneration(
    client: PoolClient,
    current: ExecutionRow,
    input: DurableBuiltinExecutionAcquireInput
  ): Promise<ExecutionRow> {
    await client.query(`
      UPDATE mn_builtin_agent_executions
      SET state='cancelled',revision=revision+1,
          error='enterprise builtin execution ownership was superseded',
          updated_at=clock_timestamp(),terminal_at=clock_timestamp()
      WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3 AND state='running'
    `, [input.tenantId, input.executionId, current.generation]);
    await this.redactToolPayloads(client, {
      tenantId: input.tenantId,
      executionId: input.executionId,
      generation: current.generation
    });
    const inserted = await client.query<ExecutionRow>(`
      INSERT INTO mn_builtin_agent_executions (
        tenant_id,execution_id,generation,run_id,candidate_id,session_id,
        worker_id,claim_digest,request_digest,provider_id,model_id,
        execution_binding,human_approval,state,revision,owner_instance_id,
        owner_lease_expires_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,'running',0,$14,
        clock_timestamp() + ($15::text || ' milliseconds')::interval
      ) RETURNING *, owner_lease_expires_at > clock_timestamp() AS owner_lease_active
    `, [
      input.tenantId,
      input.executionId,
      current.generation + 1,
      input.runId,
      input.candidateId,
      input.sessionId,
      input.workerId,
      input.claimDigest,
      input.requestDigest,
      input.providerId,
      input.modelId,
      JSON.stringify(input.executionBinding),
      input.humanApproval,
      input.ownerInstanceId,
      OWNER_LEASE_MS
    ]);
    if (!inserted.rows[0]) throw new Error("enterprise builtin execution generation was not created");
    const interruptedApprovals = await client.query<ApprovalRow>(`
      SELECT tenant_id,session_id,approval_id,execution_id,generation,
             request_event_id,request_digest,binding_digest,decision,resolution,
             client_request_id,decision_digest
      FROM mn_builtin_agent_approvals
      WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3
        AND decision IS NULL
      FOR UPDATE
    `, [input.tenantId, input.executionId, current.generation]);
    for (const approval of interruptedApprovals.rows) {
      const clientRequestId = "owner-takeover";
      const decisionDigest = sha256Canonical({
        schemaVersion: 1,
        tenantId: approval.tenant_id,
        sessionId: approval.session_id,
        approvalId: approval.approval_id,
        requestEventId: approval.request_event_id,
        requestDigest: approval.request_digest,
        bindingDigest: approval.binding_digest,
        clientRequestId,
        decision: "deny",
        resolution: "interrupted"
      });
      await client.query(`
        UPDATE mn_builtin_agent_approvals
        SET decision='deny',resolution='interrupted',client_request_id=$4,
            decision_digest=$5,decided_at=clock_timestamp()
        WHERE tenant_id=$1 AND session_id=$2 AND approval_id=$3
      `, [
        approval.tenant_id,
        approval.session_id,
        approval.approval_id,
        clientRequestId,
        decisionDigest
      ]);
    }
    return inserted.rows[0];
  }

  private async redactToolPayloads(
    client: Pick<Pool, "query"> | PoolClient,
    key: { readonly tenantId: string; readonly executionId: string; readonly generation: number }
  ): Promise<void> {
    await client.query(`
      UPDATE mn_builtin_agent_tool_calls
      SET call=NULL,result=NULL
      WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3
    `, [key.tenantId, key.executionId, key.generation]);
  }

  private async refreshOwner(
    client: PoolClient,
    row: ExecutionRow,
    ownerInstanceId: string
  ): Promise<ExecutionRow> {
    const result = await client.query<ExecutionRow>(`
      UPDATE mn_builtin_agent_executions
      SET owner_instance_id=$4,
          owner_lease_expires_at=clock_timestamp() + ($5::text || ' milliseconds')::interval,
          revision=revision+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3 AND state='running'
      RETURNING *, owner_lease_expires_at > clock_timestamp() AS owner_lease_active
    `, [row.tenant_id, row.execution_id, row.generation, ownerInstanceId, OWNER_LEASE_MS]);
    if (!result.rows[0]) throw new Error("enterprise builtin execution owner takeover failed");
    return result.rows[0];
  }

  private async ownerRow(
    client: Pick<Pool, "query"> | PoolClient,
    key: DurableBuiltinExecutionOwnerKey
  ): Promise<ExecutionRow | undefined> {
    const result = await client.query<ExecutionRow>(`
      SELECT *, owner_lease_expires_at > clock_timestamp() AS owner_lease_active
      FROM mn_builtin_agent_executions
      WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3
        AND worker_id=$4 AND claim_digest=$5 AND owner_instance_id=$6
        AND state='running' AND owner_lease_expires_at > clock_timestamp()
    `, [
      key.tenantId,
      key.executionId,
      key.generation,
      key.workerId,
      key.claimDigest,
      key.ownerInstanceId
    ]);
    return result.rows[0];
  }

  private async latest(
    client: Pick<Pool, "query"> | PoolClient,
    tenantId: string,
    executionId: string,
    lock: boolean
  ): Promise<ExecutionRow | undefined> {
    const result = await client.query<ExecutionRow>(`
      SELECT *, owner_lease_expires_at > clock_timestamp() AS owner_lease_active
      FROM mn_builtin_agent_executions
      WHERE tenant_id=$1 AND execution_id=$2
      ORDER BY generation DESC
      LIMIT 1${lock ? " FOR UPDATE" : ""}
    `, [tenantId, executionId]);
    return result.rows[0];
  }

  private assertIdentity(
    row: ExecutionRow | undefined,
    identity: DurableBuiltinExecutionIdentity
  ): void {
    if (!row) throw new Error("enterprise builtin execution was not found");
    if (row.worker_id !== identity.workerId || row.claim_digest !== identity.claimDigest) {
      throw new Error("enterprise builtin execution claim binding changed");
    }
  }

  private async snapshot(
    client: Pick<Pool, "query"> | PoolClient,
    row: ExecutionRow
  ): Promise<DurableBuiltinExecutionSnapshot> {
    const toolResult = row.state === "running"
      ? await client.query<ToolRow>(`
          SELECT call,call_digest,result,result_digest
          FROM mn_builtin_agent_tool_calls
          WHERE tenant_id=$1 AND execution_id=$2 AND generation=$3 AND result_digest IS NULL
          ORDER BY ordinal
          LIMIT 1
        `, [row.tenant_id, row.execution_id, row.generation])
      : { rows: [] as ToolRow[] };
    const toolCall = toolResult.rows[0]?.call;
    return Object.freeze({
      generation: row.generation,
      ownerInstanceId: row.owner_instance_id,
      ownerLeaseExpired: row.state === "running" && !row.owner_lease_active,
      view: Object.freeze({
        schemaVersion: 1,
        executionId: row.execution_id,
        state: row.state,
        revision: Number(row.revision),
        providerId: row.provider_id,
        modelId: row.model_id,
        executionBinding: row.execution_binding,
        ...(toolCall ? { toolCall } : {}),
        ...(row.output ? { output: row.output } : {}),
        ...(row.error ? { error: row.error } : {})
      })
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("operation cancelled"));
      return;
    }
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = (): void => finish(new Error("operation cancelled"));
    const timer = setTimeout(() => finish(), Math.max(0, milliseconds));
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
  });
}
