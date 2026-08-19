// SPDX-License-Identifier: Apache-2.0

import type {
  RuntimeAuditEvent,
  RuntimeAuditEventType,
  RuntimeScopeMetadata
} from "./types.js";

export class RuntimeAuditLog {
  private readonly events: RuntimeAuditEvent[] = [];
  private sequence = 0;

  constructor(
    private readonly metadata: RuntimeScopeMetadata,
    private readonly sink?: (event: RuntimeAuditEvent) => void | Promise<void>
  ) {}

  record(
    type: RuntimeAuditEventType,
    detail: Omit<RuntimeAuditEvent, "schemaVersion" | "sequence" | "timestamp" | "type" | "scope" | "profileId"> = {}
  ): RuntimeAuditEvent {
    const event: RuntimeAuditEvent = Object.freeze({
      schemaVersion: 1,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      type,
      scope: this.metadata.scope,
      profileId: this.metadata.profileId,
      ...detail
    });
    this.events.push(event);
    try {
      const task = this.sink?.(event);
      if (task && typeof (task as Promise<void>).catch === "function") {
        void (task as Promise<void>).catch(() => undefined);
      }
    } catch {
      // The in-memory audit fact is authoritative for lifecycle safety. A sink
      // failure must not prevent plugin cleanup.
    }
    return event;
  }

  list(): readonly RuntimeAuditEvent[] {
    return Object.freeze([...this.events]);
  }
}
