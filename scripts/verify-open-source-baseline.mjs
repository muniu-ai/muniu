import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  findSecretFindings,
  findUnpinnedWorkflowActions,
  validateAgentCoverageGate,
  validateAttributionPolicy,
  validateWorkspaceSourceLicenses
} from "./lib/open-source-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/muniu-ai/muniu";
const upstreamCommits = [
  "47f943859bef60e4160492346772ded9b24f765a",
  "141eb6fef83422698aef7a981029e843e8161534"
];
const cordisUpstreamCommit = "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca";
const localAbsolutePath = ["", "Users", "wangxiaoming"].join("/");
const obsoleteRepositoryPath = ["muniu-dev", "mn"].join("/");
const obsoleteRegistryHost = ["registry", "npmmirror", "com"].join(".");
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function requireFile(relativePath) {
  if (!existsSync(path.join(root, relativePath))) fail("required file is missing: " + relativePath);
}

const requiredFiles = [
  "LICENSE",
  "NOTICE",
  "DCO-1.1.txt",
  "THIRD_PARTY_NOTICES.md",
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
  "scripts/build-descriptor-lock-helper.mjs",
  "packages/agent-session/native/descriptor-lock.c",
  "scripts/test/open-source-policy.test.mjs",
  "scripts/test/fixtures/allowed-fake-secrets.txt",
  "scripts/verify-third-party-licenses.mjs",
  "docs/security/redaction-policy.md",
  "docs/security/secret-scanning.md",
  "docs/upstream-provenance/deepseek-harness.yaml",
  "docs/upstream-provenance/deepseek-harness-cordis.yaml"
];
requiredFiles.forEach(requireFile);

if (
  existsSync(path.join(root, "LICENSE")) &&
  existsSync(path.join(root, "LICENSES/Apache-2.0.txt")) &&
  readFileSync(path.join(root, "LICENSE"), "utf8") !==
    readFileSync(path.join(root, "LICENSES/Apache-2.0.txt"), "utf8")
) {
  fail("LICENSE and LICENSES/Apache-2.0.txt differ");
}

const provenancePath = path.join(root, "docs/upstream-provenance/deepseek-harness.yaml");
if (existsSync(provenancePath)) {
  const provenance = readFileSync(provenancePath, "utf8");
  for (const upstreamCommit of upstreamCommits) {
    if (!provenance.includes(upstreamCommit)) {
      fail(`DeepSeek Harness provenance does not pin approved commit ${upstreamCommit}`);
    }
  }
}

const cordisProvenancePath = path.join(
  root,
  "docs/upstream-provenance/deepseek-harness-cordis.yaml"
);
const cordisManifestPath = path.join(root, "vendor/SOURCE_MANIFEST.sha256");
if (!existsSync(cordisProvenancePath)
  || !readFileSync(cordisProvenancePath, "utf8").includes(cordisUpstreamCommit)) {
  fail("vendored Cordis provenance does not pin the approved commit");
}
if (!existsSync(cordisManifestPath)) {
  fail("vendored Cordis source manifest is missing");
} else {
  const manifest = readFileSync(cordisManifestPath, "utf8");
  if (!manifest.includes(cordisUpstreamCommit)) {
    fail("vendored Cordis source manifest has the wrong commit");
  }
  for (const line of manifest.split("\n")) {
    const match = /^([0-9a-f]{64})  (vendor\/[A-Za-z0-9._/-]+)$/u.exec(line);
    if (!match) continue;
    const [, expected, relativePath] = match;
    const absolutePath = path.join(root, relativePath);
    if (!existsSync(absolutePath)) {
      fail(`vendored Cordis manifest path is missing: ${relativePath}`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
    if (actual !== expected) fail(`vendored Cordis source hash differs: ${relativePath}`);
  }
}
try {
  validateAttributionPolicy({
    notice: readFileSync(path.join(root, "NOTICE"), "utf8"),
    thirdParty: readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    provenance: readFileSync(provenancePath, "utf8")
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const workspaceManifests = [
  "package.json",
  ...readdirSync(path.join(root, "apps"))
    .map((name) => "apps/" + name + "/package.json")
    .filter((relativePath) => existsSync(path.join(root, relativePath))),
  ...readdirSync(path.join(root, "packages"))
    .map((name) => "packages/" + name + "/package.json")
    .filter((relativePath) => existsSync(path.join(root, relativePath)))
];
const rootPackage = readJson("package.json");
const releaseVersion = rootPackage.version;
if (!/^0\.1\.\d+$/u.test(releaseVersion ?? "")) {
  fail(`root package must use a v0.1.x release version, received ${String(releaseVersion)}`);
}
const workspaceManifestRecords = [];
for (const manifestPath of workspaceManifests) {
  const manifest = readJson(manifestPath);
  workspaceManifestRecords.push({ path: manifestPath, license: manifest.license });
  if (manifest.version !== releaseVersion) {
    fail(`${manifestPath} must use release version ${String(releaseVersion)}`);
  }
  if (manifest.private !== true) fail(manifestPath + " must remain private for v0.1.x");
  if (manifest.repository !== repository) fail(manifestPath + " has the wrong repository");
}

if (rootPackage.packageManager !== "npm@11.10.1") fail("packageManager must be npm@11.10.1");
if (rootPackage.engines?.node !== ">=22.19.0 <22.20.0") {
  fail("Node engine must stay within the supported 22.19.x line");
}
if (rootPackage.engines?.npm !== "11.10.1") fail("npm engine must be exactly 11.10.1");
if (rootPackage.devDependencies?.typescript !== "5.7.2") fail("TypeScript must be pinned exactly to 5.7.2");
if (rootPackage.devDependencies?.yaml !== "2.9.0") {
  fail("the workflow policy parser must declare yaml 2.9.0 directly");
}
if (rootPackage.devDependencies?.["ds-store"] !== undefined) {
  fail("ds-store must not be a required cross-platform development dependency");
}
if (rootPackage.optionalDependencies?.["ds-store"] !== "^0.1.6") {
  fail("ds-store must be an optional macOS packaging dependency");
}
if (rootPackage.scripts?.["test:oss-policy"] !== "node --test scripts/test/open-source-policy.test.mjs") {
  fail("test:oss-policy must run the open-source policy regression suite");
}
if (
  rootPackage.scripts?.["verify:licenses"] !==
  "node scripts/generate-npm-license-inventory.mjs --check && node scripts/verify-third-party-licenses.mjs"
) {
  fail("verify:licenses must run the deterministic npm and Cargo license inventory");
}
if (!existsSync(path.join(root, "THIRD_PARTY_NPM_LICENSES.json"))) {
  fail("tracked npm license inventory is missing");
}

const npmrc = readFileSync(path.join(root, ".npmrc"), "utf8");
const nodeVersionPath = path.join(root, ".node-version");
if (existsSync(nodeVersionPath) && readFileSync(nodeVersionPath, "utf8").trim() !== "22.19.0") {
  fail(".node-version must pin Node 22.19.0");
}
if (!/^registry=https:\/\/registry\.npmjs\.org\/$/mu.test(npmrc)) {
  fail(".npmrc must pin the official npm registry used by installs and audit");
}
if (!/^audit=true$/mu.test(npmrc)) fail(".npmrc must keep npm audit enabled");
if (!/^engine-strict=true$/mu.test(npmrc)) fail(".npmrc must enforce the pinned Node and npm engines");
if (npmrc.includes(obsoleteRegistryHost)) fail(".npmrc uses an obsolete registry mirror");

const gitleaksConfig = readFileSync(path.join(root, ".gitleaks.toml"), "utf8");
for (const expected of ["useDefault = true", "AKIA0000000000000000", "sk-test-not-a-real-secret"]) {
  if (!gitleaksConfig.includes(expected)) fail(".gitleaks.toml is missing " + expected);
}
const gitleaksCommitDeclarations = [...gitleaksConfig.matchAll(/^commits\s*=/gmu)].length;
const gitleaksAllowlistCommits = [
  ...gitleaksConfig.matchAll(/^commits\s*=\s*\[\s*"([0-9a-f]{40})"\s*\]/gmu)
].map((match) => match[1]);
if (gitleaksCommitDeclarations !== gitleaksAllowlistCommits.length) {
  fail("every gitleaks commit allowlist must contain one exact full commit id");
}
for (const commit of new Set(gitleaksAllowlistCommits)) {
  try {
    execFileSync("git", ["cat-file", "-e", commit + "^{commit}"], {
      cwd: root,
      stdio: "ignore"
    });
  } catch {
    fail("gitleaks allowlist references an unreachable commit: " + commit);
  }
}
const denyConfig = readFileSync(path.join(root, "deny.toml"), "utf8");
for (const expected of ['version = 2', '"Apache-2.0"', '"MIT"', "confidence-threshold"]) {
  if (!denyConfig.includes(expected)) fail("deny.toml is missing " + expected);
}

const ciWorkflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
const agentWorkspaces = [
  "agent-protocol",
  "agent-session",
  "agent-llm",
  "agent-tools",
  "agent-kernel",
  "agent-host"
];
const workspacePackages = Object.fromEntries(agentWorkspaces.map((workspace) => [
  workspace,
  readJson(`packages/${workspace}/package.json`)
]));
for (const coverageFailure of validateAgentCoverageGate({
  rootPackage,
  workspacePackages,
  ciWorkflow
})) {
  fail(coverageFailure);
}
for (const expected of [
  "fetch-depth: 0",
  "GITLEAKS_VERSION: 8.30.1",
  "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  "--log-opts=--all",
  "npm run verify:licenses",
  "npm run test:coverage:agent",
  "EmbarkStudios/cargo-deny-action@3c6349835b2b7b196a839186cb8b78e02f7b5f25"
]) {
  if (!ciWorkflow.includes(expected)) fail("CI open-source gate is missing " + expected);
}

const cargoManifest = readFileSync(
  path.join(root, "apps/desktop-mac/src-tauri/Cargo.toml"),
  "utf8"
);
const cargoVersion = /^version = "([^"]+)"$/mu.exec(cargoManifest)?.[1];
if (cargoVersion !== releaseVersion) {
  fail(`desktop Cargo package must use release version ${String(releaseVersion)}`);
}
if (!/^license = "Apache-2\.0"$/mu.test(cargoManifest)) {
  fail("desktop Cargo package must declare Apache-2.0");
}
if (!/^rust-version = "1\.88"$/mu.test(cargoManifest)) {
  fail("desktop Cargo package must require Rust 1.88");
}
if (!/^repository = "https:\/\/github\.com\/muniu-ai\/muniu"$/mu.test(cargoManifest)) {
  fail("desktop Cargo package has the wrong repository");
}

const lockText = readFileSync(path.join(root, "package-lock.json"), "utf8");
if (lockText.includes(obsoleteRegistryHost)) fail("package-lock.json uses an obsolete registry mirror");
if (lockText.includes("@tauri-apps/plugin-updater")) {
  fail("package-lock.json must not retain the Tauri updater JavaScript plugin");
}
const lock = JSON.parse(lockText);
if (lock.packages?.["node_modules/typescript"]?.version !== "5.7.2") {
  fail("package-lock.json must resolve TypeScript 5.7.2");
}

const tauriConfig = readJson("apps/desktop-mac/src-tauri/tauri.conf.json");
const tauriCapabilities = readJson("apps/desktop-mac/src-tauri/capabilities/default.json");
const desktopPackage = readJson("apps/desktop-mac/package.json");
if (tauriConfig.bundle?.createUpdaterArtifacts !== false) {
  fail("v0.1.x must disable Tauri updater artifacts");
}
if (tauriConfig.plugins?.updater) fail("v0.1.x must not configure an updater endpoint");
if (tauriCapabilities.permissions.some((permission) => JSON.stringify(permission).includes("updater:"))) {
  fail("v0.1.x must not grant updater capabilities");
}
if (desktopPackage.dependencies?.["@tauri-apps/plugin-updater"] !== undefined) {
  fail("v0.1.x must not depend on the Tauri updater JavaScript plugin");
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
    fail("v0.1.x updater residue in " + sourcePath);
  }
}
for (const removedPath of [
  "scripts/generate-macos-updater-manifest.mjs",
  "packaging/updater/latest.dry-run.json"
]) {
  if (existsSync(path.join(root, removedPath))) fail("v0.1.x must not ship " + removedPath);
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
  provenance: readFileSync(provenancePath, "utf8"),
  sourceFiles
})) {
  fail(sourceLicenseFailure);
}

for (const actionFailure of findUnpinnedWorkflowActions(workflowFiles)) {
  fail("GitHub Action is not pinned to a commit in " + actionFailure);
}

if (failures.length > 0) {
  console.error(failures.map((message) => "- " + message).join("\n"));
  process.exit(1);
}
console.log("Open-source baseline checks passed (" + tracked.length + " tracked files scanned).");
