// SPDX-License-Identifier: Apache-2.0

import { digestRuntimeValue } from "./canonical.js";
import type {
  ResolvedRuntimeProfile,
  RuntimeProfileEntry,
  RuntimeProfileLayer
} from "./types.js";

function detachedEntry(entry: RuntimeProfileEntry): RuntimeProfileEntry {
  return structuredClone(entry);
}

export function resolveProfileLayers(
  layers: readonly RuntimeProfileLayer[]
): ResolvedRuntimeProfile {
  const ordered: RuntimeProfileEntry[] = [];
  const indexes = new Map<string, number>();

  for (const layer of layers) {
    for (const entry of layer.entries) {
      if (!entry.id.trim()) throw new TypeError("runtime profile entry id must not be empty");
      const next = detachedEntry(entry);
      const index = indexes.get(next.id);
      if (index === undefined) {
        indexes.set(next.id, ordered.length);
        ordered.push(next);
      } else {
        ordered[index] = next;
      }
    }
  }

  const layerIds = layers.map((layer) => layer.id);
  return Object.freeze({
    layers: Object.freeze(layerIds),
    entries: Object.freeze(ordered),
    digest: digestRuntimeValue({ layers: layerIds, entries: ordered })
  });
}
