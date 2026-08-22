// SPDX-License-Identifier: Apache-2.0

import type { AgentHostOptions } from "@mn/agent-host";
import {
  assertAgentToolApprovalBindingV1,
  assertSafePublicControlIdV1,
  deepFreeze,
  digestJson,
  isAgentSessionEventV1,
  isAgentSessionEventV2,
  type AgentApprovalDecisionV1,
  type AgentApprovalResolutionV1,
  type AgentSessionEvent,
  type AgentToolApprovalBindingV1,
  type JsonValue
} from "@mn/agent-protocol";

type ToolAuthorizationRequest = Parameters<AgentHostOptions["authorizer"]["authorize"]>[0];
type ToolAuthorizationResult = Awaited<ReturnType<AgentHostOptions["authorizer"]["authorize"]>>;

interface PendingApproval {
  readonly request: AgentSessionEvent<"approval/requested">;
  readonly binding: AgentToolApprovalBindingV1;
  readonly resolve: (result: ToolAuthorizationResult) => void;
  readonly cleanup: () => void;
  state: "waiting" | "reserved" | "resolved";
  fallbackResolution?: "cancelled" | "closed" | "interrupted";
}

export interface AgentApprovalReservation {
  readonly commit: () => void;
  readonly rollback: () => void;
}

function approvalKey(sessionId: string, approvalId: string): string {
  assertSafePublicControlIdV1(sessionId, "session identifier");
  assertSafePublicControlIdV1(approvalId, "approval identifier");
  return `${sessionId}\u0000${approvalId}`;
}

function sameBinding(left: AgentToolApprovalBindingV1, right: AgentToolApprovalBindingV1): boolean {
  return digestJson(left as unknown as JsonValue) === digestJson(right as unknown as JsonValue);
}

function authorizationResult(
  decision: AgentApprovalDecisionV1,
  resolution: AgentApprovalResolutionV1
): ToolAuthorizationResult {
  return decision === "deny"
    ? deepFreeze({ decision: "deny", approvalDecision: "deny", resolution })
    : deepFreeze({ decision: "approve", approvalDecision: decision, resolution: "decided" });
}

export class AgentApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>();

  get activeApprovalCount(): number {
    return this.pending.size;
  }

  private settle(
    pending: PendingApproval,
    decision: AgentApprovalDecisionV1,
    resolution: AgentApprovalResolutionV1
  ): void {
    if (pending.state === "resolved") return;
    pending.state = "resolved";
    this.pending.delete(approvalKey(
      pending.request.sessionId,
      pending.binding.approvalId
    ));
    pending.cleanup();
    pending.resolve(authorizationResult(decision, resolution));
  }

  async authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult> {
    const durable = request.approvalRequest;
    const suppliedBinding = request.approvalBinding;
    if (durable === undefined || suppliedBinding === undefined
      || !isAgentSessionEventV1(durable) && !isAgentSessionEventV2(durable)
      || durable.type !== "approval/requested") {
      throw new TypeError("tool approval requires one exact durable request fact");
    }
    const binding = assertAgentToolApprovalBindingV1(durable.payload.publicControls.binding);
    if (!sameBinding(binding, suppliedBinding)
      || durable.sessionId !== request.context.sessionId
      || durable.runId !== binding.commitment.runId
      || durable.candidateId !== binding.commitment.candidateId) {
      throw new TypeError("tool approval request is not bound to the durable effect");
    }
    const key = approvalKey(durable.sessionId, binding.approvalId);
    if (this.pending.has(key)) throw new TypeError("tool approval request is already registered");
    return new Promise<ToolAuthorizationResult>((resolve) => {
      const signal = request.context.signal;
      const onAbort = (): void => {
        const pending = this.pending.get(key);
        if (pending === undefined || pending.state === "resolved") return;
        if (pending.state === "reserved") {
          pending.fallbackResolution ??= "cancelled";
          return;
        }
        this.settle(pending, "deny", "cancelled");
      };
      const cleanup = signal === undefined
        ? () => {}
        : () => { signal.removeEventListener("abort", onAbort); };
      this.pending.set(key, { request: durable, binding, resolve, cleanup, state: "waiting" });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
  }

  reserve(
    request: AgentSessionEvent<"approval/requested">,
    decision: AgentApprovalDecisionV1,
    resolution: AgentApprovalResolutionV1 = "decided"
  ): AgentApprovalReservation | undefined {
    const binding = request.payload.publicControls.binding;
    const pending = this.pending.get(approvalKey(request.sessionId, binding.approvalId));
    if (pending === undefined || pending.state !== "waiting"
      || pending.request.eventId !== request.eventId
      || pending.request.digest !== request.digest
      || !sameBinding(pending.binding, binding)) return undefined;
    return this.reservation([pending], decision, resolution);
  }

  reserveSession(
    sessionId: string,
    resolution: "cancelled" | "closed" | "interrupted"
  ): AgentApprovalReservation {
    assertSafePublicControlIdV1(sessionId, "session identifier");
    const candidates: PendingApproval[] = [];
    const fallbacks: PendingApproval[] = [];
    for (const pending of this.pending.values()) {
      if (pending.request.sessionId !== sessionId || pending.state === "resolved") continue;
      if (pending.state === "waiting") {
        candidates.push(pending);
      } else if (pending.fallbackResolution === undefined) {
        pending.fallbackResolution = resolution;
        fallbacks.push(pending);
      }
    }
    return this.reservation(candidates, "deny", resolution, fallbacks);
  }

  private reservation(
    pendingApprovals: readonly PendingApproval[],
    decision: AgentApprovalDecisionV1,
    resolution: AgentApprovalResolutionV1,
    fallbackMarks: readonly PendingApproval[] = []
  ): AgentApprovalReservation {
    for (const pending of pendingApprovals) pending.state = "reserved";
    let active = true;
    return Object.freeze({
      commit: () => {
        if (!active || pendingApprovals.some((pending) => pending.state !== "reserved")) return;
        active = false;
        for (const pending of pendingApprovals) {
          this.settle(pending, decision, resolution);
        }
      },
      rollback: () => {
        if (!active || pendingApprovals.some((pending) => pending.state !== "reserved")) return;
        active = false;
        for (const pending of fallbackMarks) {
          if (pending.state === "reserved" && pending.fallbackResolution === resolution) {
            delete pending.fallbackResolution;
          }
        }
        for (const pending of pendingApprovals) {
          pending.state = "waiting";
          const fallback = pending.fallbackResolution;
          if (fallback !== undefined) this.settle(pending, "deny", fallback);
        }
      }
    });
  }
}
