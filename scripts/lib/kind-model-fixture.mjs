// SPDX-License-Identifier: Apache-2.0

import { appendKernelEvent } from "@mn/kernel";

export function configureKindModelConnection(transaction, tenantId) {
  const connection = { id: "fixture-model", tenantId, streamVersion: 1,
    presetId: "deepseek", displayName: "Kind fixture", secretRef: "vault://muniu/v2/models/fixture",
    defaultModel: "", discoveredModels: [], status: "pending" };
  const event = { tenantId, aggregateType: "modelConnection", aggregateId: connection.id,
    actorId: "fixture-owner", generation: 0, correlationId: "kind-model-fixture" };
  transaction.putProjection("modelConnection", connection.id, connection);
  appendKernelEvent(transaction, { ...event, expectedStreamVersion: 0,
    type: "model_connection.saved", publicPayload: { presetId: connection.presetId } });
  // The model invoker is injected by the fixture; no provider request is needed.
  const ready = { ...connection, streamVersion: 2, status: "ready",
    defaultModel: "fixture-model", discoveredModels: ["fixture-model"] };
  transaction.putProjection("modelConnection", ready.id, ready);
  appendKernelEvent(transaction, { ...event, expectedStreamVersion: connection.streamVersion,
    type: "model_connection.probed", publicPayload: { defaultModel: ready.defaultModel, modelCount: ready.discoveredModels.length } });
  return ready;
}
