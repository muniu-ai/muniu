// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "package-lock.json");
const outputPath = join(root, "THIRD_PARTY_NPM_LICENSES.json");
const lockBytes = await readFile(lockPath);
const lock = JSON.parse(lockBytes.toString("utf8"));
const packages = Object.entries(lock.packages ?? {})
  .filter(([location, entry]) => location.includes("node_modules/") && entry.link !== true)
  .map(([location, entry]) => ({
    name: entry.name ?? packageNameFromLocation(location),
    version: entry.version,
    license: entry.license ?? null,
    resolved: entry.resolved ?? null,
    integrity: entry.integrity ?? null
  }))
  .sort((left, right) =>
    compare(left.name, right.name) ||
    compare(left.version, right.version) ||
    compare(left.resolved ?? "", right.resolved ?? "")
  );
const inventory = {
  schemaVersion: 1,
  packageLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
  packages
};
const output = `${JSON.stringify(inventory, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== output) {
    throw new Error("npm license inventory is stale; run npm run generate:npm-license-inventory");
  }
} else {
  await writeFile(outputPath, output, "utf8");
}

function packageNameFromLocation(location) {
  const marker = "node_modules/";
  const tail = location.slice(location.lastIndexOf(marker) + marker.length);
  if (!tail || tail.includes("/node_modules/")) {
    throw new Error(`Cannot resolve npm package name from ${location}`);
  }
  return tail;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
