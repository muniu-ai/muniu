import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateLicenseInventory } from "./lib/open-source-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runJson(command, args) {
  return JSON.parse(
    execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    })
  );
}

const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const npmPackages = Object.entries(packageLock.packages)
  .filter(([location, entry]) => location.startsWith("node_modules/") && entry.link !== true)
  .map(([location, entry]) => ({
    name: `${entry.name ?? location.slice("node_modules/".length)}@${entry.version}`,
    license: entry.license ?? null
  }));

const cargoMetadata = runJson("cargo", [
  "metadata",
  "--locked",
  "--format-version",
  "1",
  "--manifest-path",
  "apps/desktop-mac/src-tauri/Cargo.toml"
]);
const cargoPackages = cargoMetadata.packages
  .filter((entry) => entry.source !== null)
  .map((entry) => ({
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
