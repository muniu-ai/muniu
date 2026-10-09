// SPDX-License-Identifier: Apache-2.0
import type { ModelConnectionV2 } from "@mn/contracts";
import { appendKernelEvent, findModelPrice, KernelError, StreamVersionConflictError as KernelStreamVersionConflictError, type KernelTransaction, type ModelConnection } from "@mn/kernel";

export function publicModelConnection(connection: ModelConnection, preferredId?: string): ModelConnectionV2 {
  const { secretRef: _secretRef, defaultForNewExecutions: _previousDefault, ...value } = connection;
  return { ...value, defaultForNewExecutions: connection.id === preferredId,
    modelOptions: connection.discoveredModels.map(modelName => ({ modelName,
    selectable: Boolean(findModelPrice(connection.presetId, modelName)),
    ...(!findModelPrice(connection.presetId, modelName) ? { reason: "尚未配置此模型的计费策略，暂不能用于任务" } : {}),
  })) };
}

interface ModelPreference {
  readonly id: "default";
  readonly tenantId: string;
  readonly connectionId: string;
  readonly streamVersion: number;
}

export function preferredModelConnectionId(transaction: KernelTransaction): string | undefined {
  return transaction.getProjection<ModelPreference>("modelPreference", "default")?.connectionId;
}

export function setDefaultModelConnection(transaction: KernelTransaction, input: {
  readonly tenantId: string;
  readonly actorId: string;
  readonly connectionId: string;
  readonly nextId: (kind: string) => string;
}): void {
  const current = transaction.getProjection<ModelPreference>("modelPreference", "default");
  if (current?.connectionId === input.connectionId) return;
  const next: ModelPreference = { id: "default", tenantId: input.tenantId,
    connectionId: input.connectionId, streamVersion: (current?.streamVersion ?? 0) + 1 };
  transaction.putProjection("modelPreference", next.id, next);
  appendKernelEvent(transaction, { tenantId: input.tenantId, aggregateType: "modelPreference", aggregateId: next.id,
    expectedStreamVersion: current?.streamVersion ?? 0, type: "model_preference.selected", actorId: input.actorId,
    generation: 0, correlationId: input.nextId("correlation"), publicPayload: { connectionId: next.connectionId } });
}

export function selectModelConnection(input: {
  readonly transaction: KernelTransaction; readonly tenantId: string; readonly actorId: string;
  readonly connectionId: string; readonly expectedStreamVersion: number; readonly modelName: string;
  readonly nextId: (kind: string) => string;
}): ModelConnection {
  const { transaction, tenantId, actorId } = input;
  const current = transaction.getProjection<ModelConnection>("modelConnection", input.connectionId);
  if (!current) throw new KernelError("MODEL_CONNECTION_NOT_FOUND", "模型连接不存在", "刷新模型连接列表");
  if (current.streamVersion !== input.expectedStreamVersion) throw new KernelStreamVersionConflictError(input.expectedStreamVersion, current.streamVersion);
  if (current.status !== "ready") throw new KernelError("MODEL_CONNECTION_NOT_READY", "模型连接尚未通过探测", "先检查连接");
  if (!current.discoveredModels.includes(input.modelName)) throw new KernelError("MODEL_NOT_DISCOVERED", "所选模型不在发现列表中", "重新检查连接并选择列表中的模型");
  if (!findModelPrice(current.presetId, input.modelName)) throw new KernelError("MODEL_PRICE_UNAVAILABLE", "所选模型尚未配置计费策略", "选择已有计费策略的模型");
  const { defaultForNewExecutions: _previousDefault, ...binding } = current;
  const next: ModelConnection = { ...binding, id: input.nextId("model-connection"), defaultModel: input.modelName,
    displayName: `${current.displayName.split(" · ")[0]} · ${input.modelName}`, streamVersion: 1 };
  transaction.putProjection("modelConnection", next.id, next);
  appendKernelEvent(transaction, { tenantId, aggregateType: "modelConnection", aggregateId: next.id,
    expectedStreamVersion: 0, type: "model_connection.model_selected", actorId,
    generation: 0, correlationId: input.nextId("correlation"),
    publicPayload: { sourceConnectionId: current.id, presetId: next.presetId, defaultModel: next.defaultModel } });
  setDefaultModelConnection(transaction, { tenantId, actorId, connectionId: next.id, nextId: input.nextId });
  return next;
}
