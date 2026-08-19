import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  cargoLockDigest,
  inventoryIdentity,
  parseCargoLockRegistryPackages
} from "./lib/cargo-lock-license.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "apps/desktop-mac/src-tauri/Cargo.lock");
const inventoryPath = path.join(root, "THIRD_PARTY_CARGO_LICENSES.json");
const userAgent = "muniu-license-inventory/0.1 (https://github.com/muniu-ai/muniu)";

const lockText = await readFile(lockPath, "utf8");
const locked = parseCargoLockRegistryPackages(lockText);
let existing = new Map();
try {
  const parsed = JSON.parse(await readFile(inventoryPath, "utf8"));
  existing = new Map(parsed.packages.map((entry) => [inventoryIdentity(entry), entry]));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

async function fetchLicense(record) {
  const cached = existing.get(inventoryIdentity(record));
  if (typeof cached?.license === "string" && cached.license.length > 0) return cached.license;
  const endpoint = `https://crates.io/api/v1/crates/${encodeURIComponent(record.name)}/${encodeURIComponent(record.version)}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json", "user-agent": userAgent },
      signal: AbortSignal.timeout(15_000)
    });
    if (response.ok) {
      const body = await response.json();
      const license = body?.version?.license;
      if (typeof license !== "string" || license.trim().length === 0) {
        throw new Error(`${record.name}@${record.version} has no declared crates.io license`);
      }
      return license;
    }
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`${endpoint} returned HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error(`${endpoint} did not succeed after bounded retries`);
}

const packages = new Array(locked.length);
let cursor = 0;
async function worker() {
  while (cursor < locked.length) {
    const index = cursor;
    cursor += 1;
    const record = locked[index];
    packages[index] = { ...record, license: await fetchLicense(record) };
  }
}
await Promise.all(Array.from({ length: 8 }, () => worker()));

await writeFile(inventoryPath, `${JSON.stringify({
  schemaVersion: 1,
  cargoLockSha256: cargoLockDigest(lockText),
  source: "crates.io version API",
  packages
}, null, 2)}\n`, "utf8");
console.log(`Wrote ${packages.length} locked Cargo license records.`);
