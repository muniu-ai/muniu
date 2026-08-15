// SPDX-License-Identifier: Apache-2.0

import type {
  AgentSessionEventPayloadMapV1,
  AgentSessionEventTypeV1,
  AgentSessionEventV1,
  CandidateId,
  RunId,
  SessionId
} from "@mn/agent-protocol";

export interface AgentSessionHeaderV1 {
  readonly schemaVersion: 1;
  readonly sessionId: SessionId;
  readonly createdAt: string;
  readonly cwd?: string;
}

export interface CreateAgentSessionOptions {
  readonly sessionId?: SessionId;
  readonly cwd?: string;
  readonly labels?: Record<string, string>;
}

export interface AgentEventMetadata {
  readonly runId?: RunId;
  readonly candidateId?: CandidateId;
}

export interface AgentSessionLike {
  readonly header: AgentSessionHeaderV1;
  readonly events: readonly AgentSessionEventV1[];
  append<T extends AgentSessionEventTypeV1>(
    type: T,
    payload: AgentSessionEventPayloadMapV1[T],
    metadata?: AgentEventMetadata
  ): Promise<AgentSessionEventV1<T>>;
  flush(): Promise<void>;
}

export interface AgentSessionStore {
  create(options?: CreateAgentSessionOptions): Promise<AgentSession>;
  open(sessionId: SessionId): Promise<AgentSession>;
}

export interface EventPersistence {
  append(event: AgentSessionEventV1): Promise<void>;
  flush(): Promise<void>;
}

export interface AgentSession extends AgentSessionLike {}
