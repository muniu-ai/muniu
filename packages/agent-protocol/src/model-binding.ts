// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "./freeze.js";
import { isSafePublicControlIdV1 } from "./public-control.js";
import { snapshotBoundedJsonValue } from "./strict-json.js";

export interface AgentModelBindingV1 {
  readonly schemaVersion: 1;
  readonly kind: "agent-model-binding";
  readonly providerId: string;
  readonly modelId: string;
}

export function inspectAgentModelBindingV1(value: unknown): AgentModelBindingV1 | undefined {
  try {
    const snapshot = snapshotBoundedJsonValue(value);
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)
      || Reflect.ownKeys(snapshot).length !== 4
      || !Object.hasOwn(snapshot, "schemaVersion")
      || !Object.hasOwn(snapshot, "kind")
      || !Object.hasOwn(snapshot, "providerId")
      || !Object.hasOwn(snapshot, "modelId")
      || snapshot.schemaVersion !== 1
      || snapshot.kind !== "agent-model-binding"
      || !isSafePublicControlIdV1(snapshot.providerId)
      || !isSafePublicControlIdV1(snapshot.modelId)) return undefined;
    return deepFreeze({
      schemaVersion: 1,
      kind: "agent-model-binding",
      providerId: snapshot.providerId,
      modelId: snapshot.modelId
    });
  } catch {
    return undefined;
  }
}

export function assertAgentModelBindingV1(value: unknown): AgentModelBindingV1 {
  const inspected = inspectAgentModelBindingV1(value);
  if (inspected === undefined) {
    throw new TypeError("agent model binding must be an exact v1 DTO");
  }
  return inspected;
}
