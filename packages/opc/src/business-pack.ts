// SPDX-License-Identifier: Apache-2.0

import type {
  BusinessPackManifestV1,
  BusinessPackRegistryV1,
  BusinessPackTransitionV1
} from "./types.js";
import {
  canonicalFrozenClone,
  requireIdentifier,
  requireStrings
} from "./shared.js";

const ROOT_FIELDS = new Set([
  "schemaVersion",
  "id",
  "version",
  "domainId",
  "recordSchemas",
  "states",
  "transitions",
  "workflows",
  "gates",
  "approvalTemplates",
  "connectors",
  "renderers",
  "externalEffects",
  "acceptanceCases"
]);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${field} must be a plain record`);
  }
  return value as Record<string, unknown>;
}

function references(
  value: unknown,
  allowed: readonly string[],
  field: string
): readonly string[] {
  const result = requireStrings(value, field, 0, true);
  const allowlist = new Set(allowed);
  const missing = result.filter((item) => !allowlist.has(item));
  if (missing.length > 0) throw new TypeError(`${field} is not registered: ${missing.join(", ")}`);
  return result;
}

function transitions(value: unknown, states: readonly string[]): readonly BusinessPackTransitionV1[] {
  if (!Array.isArray(value)) throw new TypeError("transitions must be an array");
  const stateSet = new Set(states);
  const seen = new Set<string>();
  const result = value.map((candidate, index) => {
    const item = record(candidate, `transitions[${index}]`);
    if (Object.keys(item).length !== 2 || !Object.hasOwn(item, "from") || !Object.hasOwn(item, "to")) {
      throw new TypeError(`transitions[${index}] has unsupported fields`);
    }
    const from = requireIdentifier(item.from, `transitions[${index}].from`);
    const to = requireIdentifier(item.to, `transitions[${index}].to`);
    if (!stateSet.has(from) || !stateSet.has(to) || from === to) {
      throw new TypeError(`transitions[${index}] references an invalid state`);
    }
    const key = `${from}:${to}`;
    if (seen.has(key)) throw new TypeError("transitions contains duplicates");
    seen.add(key);
    return { from, to };
  });
  return Object.freeze(result);
}

export function parseBusinessPackManifest(
  value: unknown,
  registry: BusinessPackRegistryV1
): BusinessPackManifestV1 {
  const input = record(value, "business pack manifest");
  const fields = Object.keys(input);
  if (fields.length !== ROOT_FIELDS.size || fields.some((field) => !ROOT_FIELDS.has(field))) {
    throw new TypeError("business pack manifest has unsupported or missing fields");
  }
  if (input.schemaVersion !== 1 || typeof input.version !== "string" || !VERSION_PATTERN.test(input.version)) {
    throw new TypeError("business pack manifest version is invalid");
  }
  const states = requireStrings(input.states, "states", 1, true);
  return canonicalFrozenClone({
    schemaVersion: 1,
    id: requireIdentifier(input.id, "id"),
    version: input.version,
    domainId: requireIdentifier(input.domainId, "domainId"),
    recordSchemas: references(input.recordSchemas, registry.recordSchemas, "recordSchemas"),
    states,
    transitions: transitions(input.transitions, states),
    workflows: references(input.workflows, registry.workflows, "workflows"),
    gates: references(input.gates, registry.gates, "gates"),
    approvalTemplates: requireStrings(input.approvalTemplates, "approvalTemplates", 0, true),
    connectors: references(input.connectors, registry.connectors, "connectors"),
    renderers: references(input.renderers, registry.renderers, "renderers"),
    externalEffects: references(input.externalEffects, registry.externalEffects, "externalEffects"),
    acceptanceCases: requireStrings(input.acceptanceCases, "acceptanceCases", 1, true)
  });
}
