// SPDX-License-Identifier: Apache-2.0

import type {
  AGENT_SESSION_PROTECTION_PROFILE_V1,
  AgentSessionEventPayloadMapV1,
  AgentSessionEventTypeV1,
  AgentSessionEventV1,
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

export interface CreateAgentSessionOptions {
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
  readonly header: AgentSessionHeaderV1;
  readonly events: readonly AgentSessionEventV1[];
  append<T extends AgentSessionEventTypeV1>(
    type: T,
    payload: AgentSessionEventPayloadMapV1[T],
    metadata?: AgentEventMetadata
  ): Promise<AgentSessionEventV1<T>>;
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
    event: AgentSessionEventV1,
    runtimePayload?: AgentSessionEventPayloadMapV1[AgentSessionEventTypeV1]
  ): Promise<void>;
  flush(): Promise<void>;
}

export interface AgentSession extends AgentSessionLike {}
