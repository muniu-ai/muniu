import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateLicenseInventory } from "./lib/open-source-policy.mjs";
import {
  cargoLockDigest,
  inventoryIdentity,
  parseCargoLockRegistryPackages
} from "./lib/cargo-lock-license.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const npmPackages = Object.entries(packageLock.packages)
  .filter(([location, entry]) => location.startsWith("node_modules/") && entry.link !== true)
  .map(([location, entry]) => ({
    name: `${entry.name ?? location.slice("node_modules/".length)}@${entry.version}`,
    license: entry.license ?? null
  }));

const cargoLockText = readFileSync(
  path.join(root, "apps/desktop-mac/src-tauri/Cargo.lock"),
  "utf8"
);
const lockedCargoPackages = parseCargoLockRegistryPackages(cargoLockText);
const cargoInventory = JSON.parse(
  readFileSync(path.join(root, "THIRD_PARTY_CARGO_LICENSES.json"), "utf8")
);
if (cargoInventory.schemaVersion !== 1
  || cargoInventory.cargoLockSha256 !== cargoLockDigest(cargoLockText)
  || !Array.isArray(cargoInventory.packages)) {
  throw new Error("Cargo license inventory is stale or malformed; regenerate it explicitly");
}
const lockedIdentities = lockedCargoPackages.map(inventoryIdentity);
const inventoryIdentities = cargoInventory.packages.map(inventoryIdentity);
if (JSON.stringify(lockedIdentities) !== JSON.stringify(inventoryIdentities)) {
  throw new Error("Cargo license inventory does not exactly match Cargo.lock");
}
const cargoPackages = cargoInventory.packages.map((entry) => ({
  name: `${entry.name}@${entry.version}`,
  license: entry.license ?? null
}));

const failures = [
  ...validateLicenseInventory(npmPackages).map((entry) => `npm ${entry}`),
  ...validateLicenseInventory(cargoPackages).map((entry) => `Cargo ${entry}`)
];

if (npmPackages.length === 0 || cargoPackages.length === 0) {
  failures.push("license inventory unexpectedly contained no third-party packages");
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(
  `Third-party license policy passed (${npmPackages.length} npm packages, ${cargoPackages.length} Cargo crates).`
);
