// SPDX-License-Identifier: Apache-2.0

import type { AgentEventV3 } from "@mn/agent-protocol";
import {
  projectThreadV3,
  type ThreadItemProjectionV3,
  type ThreadProjectionV3
} from "@mn/agent-session";

export class ItemProjector {
  project(events: readonly AgentEventV3[]): ThreadProjectionV3 {
    return projectThreadV3(events);
  }

  itemsAfter(events: readonly AgentEventV3[], sequence: number): readonly ThreadItemProjectionV3[] {
    if (!Number.isSafeInteger(sequence) || sequence < -1) {
      throw new TypeError("item projection cursor is invalid");
    }
    const changed = new Set(events
      .filter((event) => event.sequence > sequence && event.itemId !== undefined)
      .map((event) => event.itemId as string));
    return Object.freeze(this.project(events).items.filter((item) => changed.has(item.itemId)));
  }
}
