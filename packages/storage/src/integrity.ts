// SPDX-License-Identifier: Apache-2.0
import { verifyEventIntegrity, type KernelEventV1 } from "@mn/contracts";

export {
  canonicalJson,
  computeEventDigest,
  computeEventHmac,
  verifyEventIntegrity,
} from "@mn/contracts";

/** Authenticate a returned page and reject holes within the database's observed committed range. */
export function assertEventPageIntegrity(events: readonly KernelEventV1[], tenantId: string, afterPosition: number,
  limit: number, committedPosition: number, hmacKey: Uint8Array): void {
  let position = afterPosition;
  let previous: KernelEventV1 | undefined;
  for (const event of events) {
    if (event.tenantId !== tenantId || event.position !== ++position || !verifyEventIntegrity(event, hmacKey)
      || (previous !== undefined && event.previousDigest !== previous.digest)) throw new Error("Event page integrity check failed");
    previous = event;
  }
  if (position < Math.min(afterPosition + limit, committedPosition)) throw new Error("Event page integrity check found missing committed events");
}
