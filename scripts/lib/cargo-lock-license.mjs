// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export function cargoLockDigest(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function parseCargoLockRegistryPackages(text) {
  const records = [];
  const blocks = text.matchAll(/\[\[package\]\]\n([\s\S]*?)(?=\n\[\[package\]\]|$)/gu);
  for (const match of blocks) {
    const block = match[1];
    const source = /^source = "([^"]+)"$/mu.exec(block)?.[1];
    if (source === undefined) continue;
    if (!source.startsWith("registry+")) {
      throw new Error(`unsupported non-registry Cargo dependency source: ${source}`);
    }
    const name = /^name = "([^"]+)"$/mu.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/mu.exec(block)?.[1];
    const checksum = /^checksum = "([0-9a-f]{64})"$/mu.exec(block)?.[1];
    if (!name || !version || !checksum) {
      throw new Error("Cargo.lock registry package is missing name, version, or checksum");
    }
    records.push({ name, version, source, checksum });
  }
  return records.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)
  );
}

export function inventoryIdentity(record) {
  return `${record.name}@${record.version}|${record.source}|${record.checksum}`;
}
