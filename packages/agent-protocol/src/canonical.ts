// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { Digest } from "./ids.js";
import { snapshotJsonValue, type JsonValue } from "./json.js";

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(",")}}`;
}

export function digestJson(value: unknown): Digest {
  const snapshot = snapshotJsonValue(value);
  if (snapshot === undefined) throw new Error("value is not losslessly JSON-serializable");
  return Digest(createHash("sha256").update(canonicalJson(snapshot as JsonValue)).digest("hex"));
}
