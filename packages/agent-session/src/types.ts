// SPDX-License-Identifier: Apache-2.0

import type {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  AGENT_SESSION_PROTECTION_PROFILE_V2,
  AgentSessionEventPayloadMap,
  AgentSessionEventType,
  AgentSessionEvent,
  AgentModelBindingV1,
  CandidateId,
  Digest,
  Message,
  ProtectedTextV1,
  RunId,
  SessionId
} from "@mn/agent-protocol";

export interface AgentSessionHeaderV1 {
  readonly schemaVersion: 1;
  readonly sessionId: SessionId;
  readonly createdAt: string;
  readonly protectionProfile: typeof AGENT_SESSION_PROTECTION_PROFILE_V1;
  readonly protectionPolicyDigest: Digest;
  readonly protectedCwd?: ProtectedTextV1;
  readonly modelBinding?: AgentModelBindingV1;
}

export interface AgentSessionHeaderV2 {
  readonly schemaVersion: 2;
  readonly sessionId: SessionId;
  readonly createdAt: string;
  readonly protectionProfile: typeof AGENT_SESSION_PROTECTION_PROFILE_V2;
  readonly protectionPolicyDigest: Digest;
  readonly protectedCwd?: ProtectedTextV1;
  readonly modelBinding?: AgentModelBindingV1;
}

export type AgentSessionHeader = AgentSessionHeaderV1 | AgentSessionHeaderV2;

export interface CreateAgentSessionOptions {
  readonly schemaVersion?: 1 | 2;
  readonly sessionId?: SessionId;
  readonly cwd?: string;
  readonly labels?: Record<string, string>;
  readonly modelBinding?: AgentModelBindingV1;
}

export interface AgentEventMetadata {
  readonly runId?: RunId;
  readonly candidateId?: CandidateId;
}

export interface AgentSessionExclusiveView {
  readonly header: AgentSessionHeader;
  readonly events: readonly AgentSessionEvent[];
  append<T extends AgentSessionEventType>(
    type: T,
    payload: AgentSessionEventPayloadMap[T],
    metadata?: AgentEventMetadata
  ): Promise<AgentSessionEvent<T>>;
  flush(): Promise<void>;
}

export interface AgentSessionLike extends AgentSessionExclusiveView {
  runtimeMessages(): readonly Message[];
  runtimeCwd?(): string | undefined;
  withExclusive<T>(operation: (session: AgentSessionExclusiveView) => Promise<T>): Promise<T>;
}

export interface AgentSessionStore {
  create(options?: CreateAgentSessionOptions): Promise<AgentSession>;
  open(sessionId: SessionId): Promise<AgentSession>;
  listSessionIds?(): Promise<readonly SessionId[]>;
  dispose?(): void | Promise<void>;
}

export interface EventPersistence {
  commitDurable(
    event: AgentSessionEvent,
    runtimePayload?: AgentSessionEventPayloadMap[AgentSessionEventType]
  ): Promise<void>;
  flush(): Promise<void>;
}

export interface AgentSession extends AgentSessionLike {}
