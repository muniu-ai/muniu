// SPDX-License-Identifier: Apache-2.0

import {
  SessionId,
  assertAgentModelBindingV1,
  createSafeRandomPublicControlIdV1,
  deepFreeze,
  snapshotJsonValue,
  type AgentModelBindingV1
} from "@mn/agent-protocol";

import type { CreateAgentSessionOptions } from "./types.js";

export interface CreateAgentSessionOptionsSnapshot {
  readonly schemaVersion: 1 | 2;
  readonly sessionId: SessionId;
  readonly cwd?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly modelBinding?: AgentModelBindingV1;
}

export function snapshotCreateAgentSessionOptions(
  options: CreateAgentSessionOptions = {}
): CreateAgentSessionOptionsSnapshot {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("create session options must be an object");
  }

  // Read each public option exactly once. A caller may supply accessors or
  // mutate the source object as soon as create() returns.
  const suppliedSessionId = options.sessionId;
  const schemaVersion = options.schemaVersion ?? 1;
  const cwd = options.cwd;
  const labels = options.labels;
  const modelBinding = options.modelBinding;
  if (suppliedSessionId !== undefined && (typeof suppliedSessionId !== "string" || suppliedSessionId.length === 0)) {
    throw new Error("session id must be a non-empty string");
  }
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new Error("session schema version must be 1 or 2");
  }
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new Error("session cwd must be a string");
  }

  let labelsSnapshot: Record<string, string> | undefined;
  if (labels !== undefined) {
    const snapshot = snapshotJsonValue(labels);
    if (snapshot === undefined || snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)
      || Object.values(snapshot).some((value) => typeof value !== "string")) {
      throw new Error("session labels must be a lossless JSON object of strings");
    }
    labelsSnapshot = snapshot;
    deepFreeze(labelsSnapshot);
  }

  return deepFreeze({
    schemaVersion,
    sessionId: suppliedSessionId ?? SessionId(createSafeRandomPublicControlIdV1("session")),
    ...(cwd === undefined ? {} : { cwd }),
    ...(labelsSnapshot === undefined ? {} : { labels: labelsSnapshot }),
    ...(modelBinding === undefined ? {} : { modelBinding: assertAgentModelBindingV1(modelBinding) })
  });
}
