// SPDX-License-Identifier: Apache-2.0

import type { ActionIntentV1 } from "@mn/operations";
import { canonicalFrozenClone, sha256Digest, type SpecJsonValue } from "@mn/specs";

import { exactRecord, identifier, identifiers, text, timestamp } from "./shared.js";
import type { EffectConnectorResultV1, EffectConnectorV1 } from "./types.js";

export interface ProtectedActionInputV1 {
  readonly inputDigest: string;
  readonly payload: SpecJsonValue;
}

export interface ProtectedActionInputLoaderV1 {
  load(tenantId: string, inputDigest: string): Promise<ProtectedActionInputV1 | undefined>;
}

export interface DingTalkTodoApiRequestV1 {
  readonly operatorId: string;
  readonly sourceId: string;
  readonly subject: string;
  readonly creatorId: string;
  readonly executorIds: readonly string[];
  readonly description?: string;
  readonly dueTime?: number;
  readonly detailUrl?: string;
}

export type DingTalkTodoApiResultV1 =
  | {
    readonly status: "succeeded";
    readonly taskId: string;
    readonly response?: SpecJsonValue;
  }
  | {
    readonly status: "failed";
    readonly errorCode: string;
    readonly response?: SpecJsonValue;
  };

export interface DingTalkTodoApiV1 {
  readonly idempotency: "sourceId";
  createTodo(input: DingTalkTodoApiRequestV1): Promise<DingTalkTodoApiResultV1>;
}

export class DingTalkTodoConnector implements EffectConnectorV1 {
  readonly id: string;
  readonly idempotency = "strong" as const;
  readonly effectIds = Object.freeze(["dingtalk.todo.create"]);
  private readonly inputLoader: ProtectedActionInputLoaderV1;
  private readonly api: DingTalkTodoApiV1;

  constructor(input: {
    readonly id: string;
    readonly inputLoader: ProtectedActionInputLoaderV1;
    readonly api: DingTalkTodoApiV1;
  }) {
    this.id = identifier(input.id, "connector.id");
    if (input.api.idempotency !== "sourceId") {
      throw new Error("DingTalk Todo API must guarantee sourceId idempotency");
    }
    this.inputLoader = input.inputLoader;
    this.api = input.api;
  }

  async execute(intent: ActionIntentV1): Promise<EffectConnectorResultV1> {
    if (intent.effectId !== "dingtalk.todo.create") {
      return failed("unsupported DingTalk effect", intent);
    }
    let protectedInput: ProtectedActionInputV1 | undefined;
    try {
      protectedInput = await this.inputLoader.load(intent.tenantId, intent.inputDigest);
    } catch (error) {
      return failed("protected input is unavailable", intent, error);
    }
    if (protectedInput === undefined || protectedInput.inputDigest !== intent.inputDigest) {
      return failed("protected input digest mismatch", intent);
    }
    let payload: Omit<DingTalkTodoApiRequestV1, "sourceId">;
    try {
      payload = todoPayload(protectedInput.payload);
    } catch (error) {
      return failed("protected input is invalid", intent, error);
    }
    const result = await this.api.createTodo(canonicalFrozenClone({
      ...payload,
      sourceId: intent.idempotencyKey
    }));
    if (result.status === "failed") {
      return {
        status: "failed",
        errorDigest: sha256Digest({
          connectorId: this.id,
          actionId: intent.id,
          errorCode: identifier(result.errorCode, "DingTalk.errorCode"),
          responseDigest: result.response === undefined ? null : sha256Digest(result.response)
        })
      };
    }
    const taskId = identifier(result.taskId, "DingTalk.taskId");
    return {
      status: "succeeded",
      externalRef: `dingtalk.todo:${taskId}`,
      responseDigest: sha256Digest({
        connectorId: this.id,
        actionId: intent.id,
        taskId,
        responseDigest: result.response === undefined ? null : sha256Digest(result.response)
      })
    };
  }
}

function todoPayload(value: SpecJsonValue): Omit<DingTalkTodoApiRequestV1, "sourceId"> {
  const record = exactRecord(value, "DingTalk Todo payload", [
    "operatorId", "creatorId", "executorIds", "subject"
  ], ["description", "dueAt", "detailUrl"]);
  const detailUrl = record.detailUrl === undefined ? undefined : requireHttpsUrl(record.detailUrl);
  const dueAt = record.dueAt === undefined ? undefined : timestamp(record.dueAt, "DingTalk.dueAt");
  return canonicalFrozenClone({
    operatorId: identifier(record.operatorId, "DingTalk.operatorId"),
    creatorId: identifier(record.creatorId, "DingTalk.creatorId"),
    executorIds: identifiers(record.executorIds, "DingTalk.executorIds", 1),
    subject: text(record.subject, "DingTalk.subject", 256),
    ...(record.description === undefined ? {} : {
      description: text(record.description, "DingTalk.description", 4_096)
    }),
    ...(dueAt === undefined ? {} : { dueTime: Date.parse(dueAt) }),
    ...(detailUrl === undefined ? {} : { detailUrl })
  });
}

function requireHttpsUrl(value: unknown): string {
  const bounded = text(value, "DingTalk.detailUrl", 2_048);
  let url: URL;
  try {
    url = new URL(bounded);
  } catch (error) {
    throw new TypeError("DingTalk.detailUrl must be an absolute HTTPS URL", { cause: error });
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError("DingTalk.detailUrl must be an absolute HTTPS URL without credentials");
  }
  return url.toString();
}

function failed(
  reason: string,
  intent: ActionIntentV1,
  error?: unknown
): EffectConnectorResultV1 {
  return {
    status: "failed",
    errorDigest: sha256Digest({
      reason,
      actionId: intent.id,
      inputDigest: intent.inputDigest,
      ...(error instanceof Error ? { errorName: error.name } : {})
    })
  };
}
