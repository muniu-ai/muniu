// SPDX-License-Identifier: Apache-2.0

import { EventId, createSafeRandomPublicControlIdV1 } from "@mn/agent-protocol";

/** Produce a random identifier whose representation cannot resemble protected numeric material. */
export function createSafeRandomEventId(): EventId {
  return EventId(createSafeRandomPublicControlIdV1("evt"));
}
