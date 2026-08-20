// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parse as parseYaml } from "yaml";

import { validateReleaseContract } from "./lib/release-contract.mjs";

function parseArguments(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--tag" && args[1]) {
    return { tag: args[1] };
  }
  throw new Error("usage: node scripts/verify-release-contract.mjs [--tag vX.Y.Z]");
}

async function readJson(rootDir, relativePath) {
  return JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));
}

async function readWorkspacePackages(rootDir) {
  const workspaces = [];
  for (const parent of ["apps", "packages"]) {
    const entries = await readdir(path.join(rootDir, parent), { withFileTypes: true });
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = `${parent}/${entry.name}/package.json`;
      workspaces.push({
        path: relativePath,
        manifest: await readJson(rootDir, relativePath)
      });
    }
  }
  return workspaces;
}

const rootDir = process.cwd();
const options = parseArguments(process.argv.slice(2));
const input = {
  rootPackage: await readJson(rootDir, "package.json"),
  workspacePackages: await readWorkspacePackages(rootDir),
  cargoManifest: await readFile(path.join(rootDir, "apps/desktop-mac/src-tauri/Cargo.toml"), "utf8"),
  tauriConfig: await readJson(rootDir, "apps/desktop-mac/src-tauri/tauri.conf.json"),
  chart: parseYaml(await readFile(path.join(rootDir, "deploy/helm/muniu/Chart.yaml"), "utf8")),
  ciWorkflow: await readFile(path.join(rootDir, ".github/workflows/ci.yml"), "utf8"),
  releaseWorkflow: await readFile(path.join(rootDir, ".github/workflows/release.yml"), "utf8"),
  technicalDesign: await readFile(path.join(rootDir, "docs/TECHNICAL_DESIGN.md"), "utf8")
};

const failures = validateReleaseContract(input, options);
if (failures.length > 0) {
  console.error("Release contract verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Release contract verified for v${input.rootPackage.version}`);
}
