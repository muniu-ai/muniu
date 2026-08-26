// SPDX-License-Identifier: Apache-2.0

import type { PublicationEnvelopeV1 } from "@mn/opc";
import {
  assertAuthorityDecisionCurrent,
  type ActionIntentV1,
  type AuthorityDecisionV1
} from "@mn/operations";
import type { OpcAppendStore } from "@mn/opc-store";
import { canonicalFrozenClone, sha256Digest, type SpecJsonValue } from "@mn/specs";

import { digest, identifier, timestamp } from "./shared.js";
import type {
  DispatchStatusV1,
  EffectConnectorResultV1,
  EffectConnectorV1,
  EffectReceiptV1,
  PublicationReceiptV1,
  PublicationTransportResultV1,
  PublicationTransportV1
} from "./types.js";

const TERMINAL = new Set<DispatchStatusV1>(["succeeded", "failed", "unknown"]);

function errorDigest(error: unknown): string {
  return sha256Digest({
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : "external result unavailable"
  });
}

function connectorResult(value: EffectConnectorResultV1): EffectConnectorResultV1 {
  if (!TERMINAL.has(value.status)) throw new TypeError("effect connector status is invalid");
  return canonicalFrozenClone({
    status: value.status,
    ...(value.externalRef === undefined ? {} : { externalRef: identifier(value.externalRef, "externalRef") }),
    ...(value.responseDigest === undefined ? {} : { responseDigest: digest(value.responseDigest, "responseDigest") }),
    ...(value.errorDigest === undefined ? {} : { errorDigest: digest(value.errorDigest, "errorDigest") })
  });
}

function publicationResult(value: PublicationTransportResultV1): PublicationTransportResultV1 {
  if (!TERMINAL.has(value.status)) throw new TypeError("publication transport status is invalid");
  return canonicalFrozenClone({
    status: value.status,
    ...(value.remoteRef === undefined ? {} : { remoteRef: identifier(value.remoteRef, "remoteRef") }),
    ...(value.responseDigest === undefined ? {} : { responseDigest: digest(value.responseDigest, "responseDigest") }),
    ...(value.errorDigest === undefined ? {} : { errorDigest: digest(value.errorDigest, "errorDigest") })
  });
}

export class ControlledEffectDispatcher {
  constructor(private readonly store: OpcAppendStore) {}

  async dispatch(input: {
    readonly tenantId: string;
    readonly actionId: string;
    readonly dispatchId: string;
    readonly connector: EffectConnectorV1;
    readonly now: string;
  }): Promise<EffectReceiptV1> {
    const tenantId = identifier(input.tenantId, "tenantId");
    const actionId = identifier(input.actionId, "actionId");
    const dispatchId = identifier(input.dispatchId, "dispatchId");
    const now = timestamp(input.now, "now");
    const existing = await this.store.read<SpecJsonValue>(tenantId, "effect_receipt", actionId);
    if (existing !== undefined) {
      const receipt = existing.value as unknown as EffectReceiptV1;
      if (receipt.status !== "dispatching") return receipt;
      const unknown = canonicalFrozenClone({
        ...receipt,
        status: "unknown" as const,
        errorDigest: sha256Digest({ reason: "dispatch ownership was lost before receipt" }),
        observedAt: now
      });
      return (await this.store.append({
        tenantId,
        kind: "effect_receipt",
        id: actionId,
        expectedRevision: existing.revision,
        requestId: `effectRecovery.${dispatchId}`,
        value: unknown as unknown as SpecJsonValue,
        createdAt: now
      })).value as unknown as EffectReceiptV1;
    }
    const actionEntry = await this.store.read<SpecJsonValue>(tenantId, "action_intent", actionId);
    const decisionEntry = await this.store.read<SpecJsonValue>(tenantId, "authority_decision", actionId);
    if (actionEntry === undefined || decisionEntry === undefined) throw new Error("action approval is required");
    const action = actionEntry.value as unknown as ActionIntentV1;
    const decision = decisionEntry.value as unknown as AuthorityDecisionV1;
    if (action.tenantId !== tenantId || decision.tenantId !== tenantId) {
      throw new Error("action approval tenant binding is invalid");
    }
    if (!assertAuthorityDecisionCurrent(decision, action, now)) throw new Error("action approval is required");
    const connectorId = identifier(input.connector.id, "connector.id");
    if (input.connector.idempotency !== "strong") {
      throw new Error("connector must provide strong idempotency");
    }
    if (!input.connector.effectIds.includes(action.effectId)) throw new Error("connector cannot execute this effect");
    const dispatching: EffectReceiptV1 = canonicalFrozenClone({
      schemaVersion: 1,
      id: `effectReceipt.${sha256Digest({ tenantId, actionId })}`,
      tenantId,
      runId: action.runId,
      actionId,
      generation: action.generation,
      effectId: action.effectId,
      connectorId,
      idempotencyKey: action.idempotencyKey,
      dispatchId,
      status: "dispatching",
      attemptedAt: now,
      observedAt: now
    });
    await this.store.append({
      tenantId,
      kind: "effect_receipt",
      id: actionId,
      expectedRevision: 0,
      requestId: `effectDispatch.${dispatchId}`,
      value: dispatching as unknown as SpecJsonValue,
      createdAt: now
    });
    let result: EffectConnectorResultV1;
    try {
      result = connectorResult(await input.connector.execute(action));
    } catch (error) {
      result = { status: "unknown", errorDigest: errorDigest(error) };
    }
    const final: EffectReceiptV1 = canonicalFrozenClone({
      ...dispatching,
      ...result,
      observedAt: now
    });
    return (await this.store.append({
      tenantId,
      kind: "effect_receipt",
      id: actionId,
      expectedRevision: 1,
      requestId: `effectResult.${dispatchId}`,
      value: final as unknown as SpecJsonValue,
      createdAt: now
    })).value as unknown as EffectReceiptV1;
  }
}

export class ControlledPublicationDispatcher {
  constructor(private readonly store: OpcAppendStore) {}

  async publish(input: {
    readonly tenantId: string;
    readonly publicationId: string;
    readonly dispatchId: string;
    readonly transport: PublicationTransportV1;
    readonly now: string;
  }): Promise<PublicationReceiptV1> {
    const tenantId = identifier(input.tenantId, "tenantId");
    const publicationId = identifier(input.publicationId, "publicationId");
    const dispatchId = identifier(input.dispatchId, "dispatchId");
    const now = timestamp(input.now, "now");
    const existing = await this.store.read<SpecJsonValue>(tenantId, "publication_receipt", publicationId);
    if (existing !== undefined) {
      const receipt = existing.value as unknown as PublicationReceiptV1;
      if (receipt.status !== "dispatching") return receipt;
      const unknown = canonicalFrozenClone({
        ...receipt,
        status: "unknown" as const,
        errorDigest: sha256Digest({ reason: "publication ownership was lost before receipt" }),
        observedAt: now
      });
      return (await this.store.append({
        tenantId,
        kind: "publication_receipt",
        id: publicationId,
        expectedRevision: existing.revision,
        requestId: `publicationRecovery.${dispatchId}`,
        value: unknown as unknown as SpecJsonValue,
        createdAt: now
      })).value as unknown as PublicationReceiptV1;
    }
    const envelopeEntry = await this.store.read<SpecJsonValue>(tenantId, "publication_outbox", publicationId);
    if (envelopeEntry === undefined) throw new Error("publication outbox entry is missing");
    const envelope = envelopeEntry.value as unknown as PublicationEnvelopeV1;
    if (envelope.sourceTenantId !== tenantId) throw new Error("publication source tenant is invalid");
    if (Date.parse(now) >= Date.parse(envelope.retentionUntil)) {
      throw new Error("publication retention window has expired");
    }
    const transportId = identifier(input.transport.id, "transport.id");
    if (input.transport.idempotency !== "strong") {
      throw new Error("publication transport must provide strong idempotency");
    }
    const dispatching: PublicationReceiptV1 = canonicalFrozenClone({
      schemaVersion: 1,
      id: `publicationReceipt.${sha256Digest({ tenantId, publicationId })}`,
      sourceTenantId: tenantId,
      targetTenantId: envelope.targetTenantId,
      publicationId,
      sourceDigest: envelope.sourceDigest,
      transportId,
      idempotencyKey: envelope.idempotencyKey,
      dispatchId,
      status: "dispatching",
      attemptedAt: now,
      observedAt: now
    });
    await this.store.append({
      tenantId,
      kind: "publication_receipt",
      id: publicationId,
      expectedRevision: 0,
      requestId: `publicationDispatch.${dispatchId}`,
      value: dispatching as unknown as SpecJsonValue,
      createdAt: now
    });
    let result: PublicationTransportResultV1;
    try {
      result = publicationResult(await input.transport.publish(envelope));
    } catch (error) {
      result = { status: "unknown", errorDigest: errorDigest(error) };
    }
    const final: PublicationReceiptV1 = canonicalFrozenClone({
      ...dispatching,
      ...result,
      observedAt: now
    });
    return (await this.store.append({
      tenantId,
      kind: "publication_receipt",
      id: publicationId,
      expectedRevision: 1,
      requestId: `publicationResult.${dispatchId}`,
      value: final as unknown as SpecJsonValue,
      createdAt: now
    })).value as unknown as PublicationReceiptV1;
  }
}
