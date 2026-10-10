// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmPackagesWithLicenseEvidence } from './lib/npm-license-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "package-lock.json");
const outputPath = join(root, "THIRD_PARTY_NPM_LICENSES.json");
const lockBytes = await readFile(lockPath);
const lock = JSON.parse(lockBytes.toString("utf8"));
const packages = npmPackagesWithLicenseEvidence(lock, root);
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
