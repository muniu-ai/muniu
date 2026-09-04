// SPDX-License-Identifier: Apache-2.0

import {
  isPotentiallyAutoApprovable,
  type ToolCallIntent,
} from "@mn/contracts";

import type {
  JsonObject,
  ModelToolCall,
  ResourceRef,
  RuntimeAgentDefinition,
  RuntimeRecord,
  ToolEffectClass,
} from "./types.js";

export interface WaitingApprovalRecovery {
  readonly turn: number;
  readonly boundary: number;
  readonly generation: number;
  readonly calls: readonly ModelToolCall[];
  readonly pendingCallIndex: number;
  readonly intent: ToolCallIntent;
  readonly availableToolIds: readonly string[];
  readonly prompts: readonly string[];
}

export function parseWaitingApprovalRecovery(
  records: readonly RuntimeRecord[],
  executionId: string,
  definition: RuntimeAgentDefinition,
): WaitingApprovalRecovery {
  const unresolvedIntentRecords = findUnresolvedToolIntentRecords(records);
  if (unresolvedIntentRecords.length !== 1) {
    throw new Error("等待审批状态必须且只能有一个未闭合工具调用");
  }
  const intentRecord = unresolvedIntentRecords[0];
  if (intentRecord === undefined) throw new Error("等待审批的工具调用不存在");
  const turn = positiveIntegerField(intentRecord.payload, "turn");
  const boundary = positiveIntegerField(intentRecord.payload, "boundary");
  const intent = parseToolIntent(intentRecord, executionId);
  if (isPotentiallyAutoApprovable(intent.effectClass)) {
    throw new Error("自动授权工具不能处于等待人工审批状态");
  }

  const responseRecord = records
    .filter((record) => record.sequence < intentRecord.sequence && record.type === "model/response")
    .filter((record) => integerField(record.payload, "turn") === turn
      && integerField(record.payload, "boundary") === boundary)
    .at(-1);
  if (responseRecord === undefined) throw new Error("等待审批的模型响应不存在");
  if (integerField(responseRecord.payload, "generation") !== intent.generation) {
    throw new Error("模型响应与工具调用代次不一致");
  }
  const calls = modelToolCallsField(responseRecord.payload, "toolCalls");
  const matchingIndexes = calls
    .map((call, index) => call.id === intent.id ? index : -1)
    .filter((index) => index >= 0);
  if (matchingIndexes.length !== 1) throw new Error("模型响应中的工具调用续点不唯一");
  const pendingCallIndex = matchingIndexes[0];
  if (pendingCallIndex === undefined) throw new Error("模型响应中的工具调用续点不存在");
  const pendingCall = calls[pendingCallIndex];
  if (pendingCall === undefined || pendingCall.toolId !== intent.toolId) {
    throw new Error("模型响应与工具调用意图不一致");
  }
  const completedToolCallIds = new Set(records
    .filter((record) => record.type === "tool/result"
      && record.sequence > responseRecord.sequence
      && record.sequence < intentRecord.sequence)
    .map((record) => stringField(record.payload, "toolCallId")));
  for (const call of calls.slice(0, pendingCallIndex)) {
    if (!completedToolCallIds.has(call.id)) throw new Error("等待审批前存在未闭合的工具调用");
  }

  const requestRecord = records
    .filter((record) => record.sequence < responseRecord.sequence && record.type === "model/request")
    .filter((record) => integerField(record.payload, "turn") === turn
      && integerField(record.payload, "boundary") === boundary)
    .at(-1);
  if (requestRecord === undefined) throw new Error("等待审批的模型请求不存在");
  if (integerField(requestRecord.payload, "generation") !== intent.generation
    || stringField(requestRecord.payload, "agentId") !== definition.id
    || stringField(requestRecord.payload, "llmId") !== definition.llmId
    || !sameStringList(stringListField(requestRecord.payload, "promptIds"), definition.promptIds)) {
    throw new Error("恢复时 Agent 定义或固定代次已变化");
  }
  const availableToolIds = stringListField(requestRecord.payload, "availableToolIds");
  if (!availableToolIds.includes(intent.toolId)) {
    throw new Error("等待审批的工具不在已持久化工具范围内");
  }

  return {
    turn,
    boundary,
    generation: intent.generation,
    calls,
    pendingCallIndex,
    intent,
    availableToolIds,
    prompts: stringListField(requestRecord.payload, "prompts"),
  };
}

export function findUnresolvedToolIntentRecords(
  records: readonly RuntimeRecord[],
): readonly RuntimeRecord[] {
  const laterClosures = new Map<string, number>();
  const unresolved: RuntimeRecord[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) continue;
    if (record.type === "tool/result" || record.type === "tool/outcome_unknown") {
      const toolCallId = stringField(record.payload, "toolCallId");
      laterClosures.set(toolCallId, (laterClosures.get(toolCallId) ?? 0) + 1);
      continue;
    }
    if (record.type !== "tool/intent") continue;
    const toolCallId = stringField(record.payload, "toolCallId");
    const closureCount = laterClosures.get(toolCallId) ?? 0;
    if (closureCount === 0) {
      unresolved.push(record);
    } else if (closureCount === 1) {
      laterClosures.delete(toolCallId);
    } else {
      laterClosures.set(toolCallId, closureCount - 1);
    }
  }
  return unresolved.reverse();
}

function parseToolIntent(record: RuntimeRecord, executionId: string): ToolCallIntent {
  const effectClass = stringField(record.payload, "effectClass");
  if (!isToolEffectClass(effectClass)) throw new Error("持久化工具副作用类型无效");
  const expiresAt = stringField(record.payload, "expiresAt");
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error("持久化工具调用期限无效");
  return {
    id: stringField(record.payload, "toolCallId"),
    executionId,
    generation: positiveIntegerField(record.payload, "generation"),
    toolId: stringField(record.payload, "toolId"),
    toolVersion: stringField(record.payload, "toolVersion"),
    effectClass,
    intent: stringField(record.payload, "intent"),
    normalizedArguments: jsonObjectField(record.payload, "normalizedArguments"),
    argumentsDigest: stringField(record.payload, "argumentsDigest"),
    resourceRefs: resourceRefsField(record.payload, "resourceRefs"),
    resourcesDigest: stringField(record.payload, "resourcesDigest"),
    authorityCommitment: stringField(record.payload, "authorityCommitment"),
    expiresAt,
  };
}

function modelToolCallsField(payload: JsonObject, key: string): readonly ModelToolCall[] {
  const value = payload[key];
  if (!Array.isArray(value)) throw new Error(`持久化字段 ${key} 无效`);
  const calls = value.map((item) => {
    if (!isJsonObject(item)) throw new Error(`持久化字段 ${key} 无效`);
    const intent = item.intent;
    if (intent !== undefined && typeof intent !== "string") throw new Error(`持久化字段 ${key} 无效`);
    return {
      id: stringField(item, "id"),
      toolId: stringField(item, "toolId"),
      arguments: jsonObjectField(item, "arguments"),
      ...(intent === undefined ? {} : { intent }),
    };
  });
  if (new Set(calls.map((call) => call.id)).size !== calls.length) {
    throw new Error("模型响应包含重复的工具调用 id");
  }
  return calls;
}

function resourceRefsField(payload: JsonObject, key: string): readonly ResourceRef[] {
  const value = payload[key];
  if (!Array.isArray(value)) throw new Error(`持久化字段 ${key} 无效`);
  return value.map((item) => {
    if (!isJsonObject(item)) throw new Error(`持久化字段 ${key} 无效`);
    const digest = item.digest;
    if (digest !== undefined && typeof digest !== "string") throw new Error(`持久化字段 ${key} 无效`);
    return {
      namespace: stringField(item, "namespace"),
      resourceId: stringField(item, "resourceId"),
      ...(digest === undefined ? {} : { digest }),
    };
  });
}

function stringListField(payload: JsonObject, key: string): readonly string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`持久化字段 ${key} 无效`);
  }
  return [...value] as string[];
}

function integerField(payload: JsonObject, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value)) throw new Error(`持久化字段 ${key} 无效`);
  return value as number;
}

function positiveIntegerField(payload: JsonObject, key: string): number {
  const value = integerField(payload, key);
  if (value < 1) throw new Error(`持久化字段 ${key} 无效`);
  return value;
}

function jsonObjectField(payload: JsonObject, key: string): JsonObject {
  const value = payload[key];
  if (!isJsonObject(value)) throw new Error(`持久化字段 ${key} 无效`);
  return structuredClone(value) as JsonObject;
}

function stringField(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`持久化字段 ${key} 无效`);
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToolEffectClass(value: string): value is ToolEffectClass {
  return [
    "local_read", "external_read", "local_reversible_write", "local_irreversible_write",
    "external_side_effect", "financial", "privileged", "unknown",
  ].includes(value);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
