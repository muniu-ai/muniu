#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findSecretFindings,
  findUnpinnedWorkflowActions,
  validateAttributionPolicy,
  validateWorkspaceSourceLicenses,
} from "./lib/open-source-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/muniu-ai/muniu";
const localAbsolutePath = ["", "Users", "wangxiaoming"].join("/");
const obsoleteRegistryHost = ["registry", "npmmirror", "com"].join(".");
const obsoleteRepositoryPath = ["muniu-dev", "mn"].join("/");
const failures = [];
const fail = (message) => failures.push(message);
const read = (file) => readFileSync(path.join(root, file), "utf8");
const readJson = (file) => JSON.parse(read(file));
const requiredFiles = [
  "LICENSE",
  "NOTICE",
  "DCO-1.1.txt",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_NPM_LICENSES.json",
  "THIRD_PARTY_CARGO_LICENSES.json",
  "LICENSES/Apache-2.0.txt",
  "LICENSES/MIT.txt",
  "LICENSES/BSD-3-Clause.txt",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  ".node-version",
  "rust-toolchain.toml",
  ".npmrc",
  ".gitleaks.toml",
  "deny.toml",
  "scripts/lib/open-source-policy.mjs",
  "scripts/lib/cargo-lock-license.mjs",
  "scripts/build-host-sidecar.mjs",
  "scripts/test/deployment-v2.test.mjs",
  "scripts/test/postgres-worker-store.test.mjs",
  "scripts/test/open-source-policy.test.mjs",
  "scripts/test/fixtures/allowed-fake-secrets.txt",
  "scripts/verify-third-party-licenses.mjs",
  "docs/security/redaction-policy.md",
  "docs/security/secret-scanning.md",
  "docs/upstream-provenance/deepseek-harness.yaml",
  "docs/upstream-provenance/deepseek-harness-cordis.yaml",
  "vendor/SOURCE_MANIFEST.sha256",
];
for (const file of requiredFiles) if (!existsSync(path.join(root, file))) fail(`required file is missing: ${file}`);

if (existsSync(path.join(root, "LICENSE")) && read("LICENSE") !== read("LICENSES/Apache-2.0.txt")) {
  fail("LICENSE and LICENSES/Apache-2.0.txt differ");
}
const provenance = read("docs/upstream-provenance/deepseek-harness.yaml");
for (const commit of [
  "47f943859bef60e4160492346772ded9b24f765a",
  "141eb6fef83422698aef7a981029e843e8161534",
]) {
  if (!provenance.includes(commit)) fail(`DeepSeek Harness provenance does not pin ${commit}`);
}
const cordisCommit = "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca";
if (!read("docs/upstream-provenance/deepseek-harness-cordis.yaml").includes(cordisCommit)) {
  fail("vendored Cordis provenance does not pin the approved commit");
}
const sourceManifest = read("vendor/SOURCE_MANIFEST.sha256");
if (!sourceManifest.includes(cordisCommit)) fail("vendored Cordis source manifest has the wrong commit");
for (const line of sourceManifest.split("\n")) {
  const match = /^([0-9a-f]{64})  (vendor\/[A-Za-z0-9._/-]+)$/u.exec(line);
  if (!match) continue;
  const file = path.join(root, match[2]);
  if (!existsSync(file)) fail(`vendored source is missing: ${match[2]}`);
  else if (createHash("sha256").update(readFileSync(file)).digest("hex") !== match[1]) {
    fail(`vendored source hash differs: ${match[2]}`);
  }
}
try {
  validateAttributionPolicy({ notice: read("NOTICE"), thirdParty: read("THIRD_PARTY_NOTICES.md"), provenance });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const rootPackage = readJson("package.json");
const releaseVersion = rootPackage.version;
if (releaseVersion !== "0.2.0") {
  fail(`root package must use release version 0.2.0, received ${String(releaseVersion)}`);
}
if (rootPackage.private !== true) fail("package.json must remain private");
if (rootPackage.license !== "Apache-2.0") fail("package.json must declare Apache-2.0");
if (rootPackage.repository !== repository) fail("package.json has the wrong repository");
const workspaceManifests = ["apps", "packages", "plugins"].flatMap((parent) =>
  readdirSync(path.join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, parent, entry.name, "package.json")))
    .map((entry) => `${parent}/${entry.name}/package.json`));
const workspaceManifestRecords = [];
for (const file of workspaceManifests) {
  const manifest = readJson(file);
  workspaceManifestRecords.push({ path: file, license: manifest.license });
  if (manifest.version !== releaseVersion) fail(`${file} version must match ${releaseVersion}`);
  if (manifest.private !== true) fail(`${file} must remain private`);
  if (manifest.repository !== repository) fail(`${file} has the wrong repository`);
}
if (rootPackage.packageManager !== "npm@11.10.1") fail("packageManager must be npm@11.10.1");
if (rootPackage.engines?.node !== ">=22.19.0 <22.20.0") fail("Node engine must stay within 22.19.x");
if (rootPackage.engines?.npm !== "11.10.1") fail("npm engine must be exactly 11.10.1");
if (rootPackage.devDependencies?.typescript !== "5.7.2") fail("TypeScript must be exactly 5.7.2");
if (rootPackage.devDependencies?.yaml !== "2.9.0") fail("the workflow policy parser must declare yaml 2.9.0 directly");
if (rootPackage.devDependencies?.["ds-store"] !== undefined) fail("ds-store must not be a required development dependency");
if (rootPackage.optionalDependencies?.["ds-store"] !== "^0.1.6") fail("ds-store must remain an optional macOS packaging dependency");
if (rootPackage.scripts?.["test:oss-policy"] !== "node --test scripts/test/open-source-policy.test.mjs") {
  fail("test:oss-policy must run the open-source policy regression suite");
}
if (rootPackage.scripts?.["verify:licenses"] !== "node scripts/generate-npm-license-inventory.mjs --check && node scripts/verify-third-party-licenses.mjs") {
  fail("verify:licenses must run the deterministic npm and Cargo license inventory");
}
if (read(".node-version").trim() !== "22.19.0") fail(".node-version must pin Node 22.19.0");
const npmrc = read(".npmrc");
if (!/^registry=https:\/\/registry\.npmjs\.org\/$/mu.test(npmrc)) fail(".npmrc must use registry.npmjs.org");
if (!/^audit=true$/mu.test(npmrc)) fail(".npmrc must keep npm audit enabled");
if (!/^engine-strict=true$/mu.test(npmrc)) fail(".npmrc must enforce the pinned Node and npm engines");
if (npmrc.includes(obsoleteRegistryHost)) fail(".npmrc uses an obsolete registry mirror");

const gitleaksConfig = read(".gitleaks.toml");
for (const expected of ["useDefault = true", "AKIA0000000000000000", "sk-test-not-a-real-secret"]) {
  if (!gitleaksConfig.includes(expected)) fail(`.gitleaks.toml is missing ${expected}`);
}
const gitleaksCommitDeclarations = [...gitleaksConfig.matchAll(/^commits\s*=/gmu)].length;
const gitleaksAllowlistCommits = [...gitleaksConfig.matchAll(/^commits\s*=\s*\[\s*"([0-9a-f]{40})"\s*\]/gmu)]
  .map((match) => match[1]);
if (gitleaksCommitDeclarations !== gitleaksAllowlistCommits.length) {
  fail("every gitleaks commit allowlist must contain one exact full commit id");
}
for (const commit of new Set(gitleaksAllowlistCommits)) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, stdio: "ignore" });
  } catch {
    fail(`gitleaks allowlist references an unreachable commit: ${commit}`);
  }
}
const denyConfig = read("deny.toml");
for (const expected of ["version = 2", '"Apache-2.0"', '"MIT"', "confidence-threshold"]) {
  if (!denyConfig.includes(expected)) fail(`deny.toml is missing ${expected}`);
}

for (const removed of [
  "apps/api",
  "packages/config-manager",
  "packages/local-proxy",
  "scripts/build-descriptor-lock-helper.mjs",
]) {
  if (existsSync(path.join(root, removed))) fail(`Agent OS 0.2 must not ship ${removed}`);
}

const tauri = readJson("apps/desktop-mac/src-tauri/tauri.conf.json");
if (tauri.bundle?.createUpdaterArtifacts !== false) fail("Tauri updater artifacts must remain disabled");
if (tauri.bundle?.externalBin?.join(",") !== "binaries/mn-host") fail("Desktop must package only mn-host");
if (tauri.plugins?.updater) fail("Tauri must not configure an updater endpoint");
const tauriCapabilities = readJson("apps/desktop-mac/src-tauri/capabilities/default.json");
if (tauriCapabilities.permissions.some((permission) => JSON.stringify(permission).includes("updater:"))) {
  fail("Desktop must not grant updater capabilities");
}
const desktopPackage = readJson("apps/desktop-mac/package.json");
if (desktopPackage.dependencies?.["@tauri-apps/plugin-updater"] !== undefined) {
  fail("Desktop must not depend on the Tauri updater JavaScript plugin");
}
const sidecar = read("scripts/build-host-sidecar.mjs");
if (!sidecar.includes("apps/host/src/main.ts") || sidecar.includes("descriptor-lock")) {
  fail("sidecar build must use the v2 Host entrypoint only");
}

const ciWorkflow = read(".github/workflows/ci.yml");
for (const required of [
  "fetch-depth: 0",
  "GITLEAKS_VERSION: 8.30.1",
  "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  "--log-opts=--all",
  "npm run verify:licenses",
  "EmbarkStudios/cargo-deny-action@3c6349835b2b7b196a839186cb8b78e02f7b5f25",
  "node --test scripts/test/deployment-v2.test.mjs",
  "scripts/verify-kind-sandbox.sh",
  "npm audit --omit=dev",
]) {
  if (!ciWorkflow.includes(required)) fail(`CI gate is missing ${required}`);
}

const cargoManifest = read("apps/desktop-mac/src-tauri/Cargo.toml");
if (/^version = "([^"]+)"$/mu.exec(cargoManifest)?.[1] !== releaseVersion) {
  fail(`desktop Cargo package must use release version ${String(releaseVersion)}`);
}
if (!/^license = "Apache-2\.0"$/mu.test(cargoManifest)) fail("desktop Cargo package must declare Apache-2.0");
if (!/^rust-version = "1\.88"$/mu.test(cargoManifest)) fail("desktop Cargo package must require Rust 1.88");
if (!/^repository = "https:\/\/github\.com\/muniu-ai\/muniu"$/mu.test(cargoManifest)) {
  fail("desktop Cargo package has the wrong repository");
}

const lockText = read("package-lock.json");
if (lockText.includes(obsoleteRegistryHost)) fail("package-lock.json uses an obsolete registry mirror");
if (lockText.includes("@tauri-apps/plugin-updater")) fail("package-lock.json must not retain the Tauri updater plugin");
const lock = JSON.parse(lockText);
if (lock.packages?.["node_modules/typescript"]?.version !== "5.7.2") {
  fail("package-lock.json must resolve TypeScript 5.7.2");
}

if (tauri.bundle?.createUpdaterArtifacts !== false) {
  fail("0.2.0 must disable Tauri updater artifacts");
}
if (tauri.plugins?.updater) fail("0.2.0 must not configure an updater endpoint");
if (tauriCapabilities.permissions.some((permission) => JSON.stringify(permission).includes("updater:"))) {
  fail("0.2.0 must not grant updater capabilities");
}
if (desktopPackage.dependencies?.["@tauri-apps/plugin-updater"] !== undefined) {
  fail("0.2.0 must not depend on the Tauri updater JavaScript plugin");
}
const updaterSourceFiles = [
  "apps/desktop-mac/src/App.tsx",
  "apps/desktop-mac/src-tauri/Cargo.toml",
  "apps/desktop-mac/src-tauri/Cargo.lock",
  "apps/desktop-mac/src-tauri/src/lib.rs",
  "apps/desktop-mac/src-tauri/gen/schemas/acl-manifests.json",
  "apps/desktop-mac/src-tauri/gen/schemas/desktop-schema.json",
  "apps/desktop-mac/src-tauri/gen/schemas/macOS-schema.json"
];
for (const sourcePath of updaterSourceFiles) {
  const text = readFileSync(path.join(root, sourcePath), "utf8");
  if (/tauri-plugin-updater|@tauri-apps\/plugin-updater|tauri_plugin_updater|updater:/u.test(text)) {
    fail("0.2.0 updater residue in " + sourcePath);
  }
}
for (const removedPath of [
  "scripts/generate-macos-updater-manifest.mjs",
  "packaging/updater/latest.dry-run.json"
]) {
  if (existsSync(path.join(root, removedPath))) fail("0.2.0 must not ship " + removedPath);
}

const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root }
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const workflowFiles = [];
const sourceFiles = [];
for (const requiredPath of requiredFiles) {
  if (!tracked.includes(requiredPath)) fail("required file is not tracked: " + requiredPath);
}
for (const relativePath of tracked) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) continue;
  const size = statSync(absolutePath).size;
  if (size > 5 * 1024 * 1024) fail("tracked file exceeds 5 MiB: " + relativePath);
  const buffer = readFileSync(absolutePath);
  const text = buffer.toString("utf8");
  if (text.includes(localAbsolutePath)) fail("local absolute path in " + relativePath);
  if (text.includes(obsoleteRepositoryPath)) fail("obsolete repository URL in " + relativePath);
  for (const finding of findSecretFindings(buffer, relativePath)) {
    fail("possible " + finding.label + " in " + finding.path);
  }
  workflowFiles.push({ path: relativePath, text });
  sourceFiles.push({ path: relativePath, text });
}

for (const sourceLicenseFailure of validateWorkspaceSourceLicenses({
  manifests: workspaceManifestRecords,
  provenance,
  sourceFiles
})) {
  fail(sourceLicenseFailure);
}

for (const actionFailure of findUnpinnedWorkflowActions(workflowFiles)) {
  fail("GitHub Action is not pinned to a commit in " + actionFailure);
}
if (failures.length > 0) {
  process.stderr.write(`${failures.map((message) => `- ${message}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Open-source baseline checks passed (${tracked.length} tracked files scanned).\n`);
