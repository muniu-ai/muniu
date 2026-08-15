import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/muniu-ai/muniu";
const upstreamCommit = "47f943859bef60e4160492346772ded9b24f765a";
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
  "LICENSES/Apache-2.0.txt",
  "LICENSES/MIT.txt",
  "LICENSES/BSD-3-Clause.txt",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  "docs/upstream-provenance/deepseek-harness.yaml"
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
if (existsSync(provenancePath) && !readFileSync(provenancePath, "utf8").includes(upstreamCommit)) {
  fail("DeepSeek Harness provenance does not pin the approved commit");
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
for (const manifestPath of workspaceManifests) {
  const manifest = readJson(manifestPath);
  if (manifest.version !== "0.1.0") fail(manifestPath + " must use version 0.1.0");
  if (manifest.private !== true) fail(manifestPath + " must remain private for v0.1.0");
  if (manifest.license !== "Apache-2.0") fail(manifestPath + " must declare Apache-2.0");
  if (manifest.repository !== repository) fail(manifestPath + " has the wrong repository");
}

const rootPackage = readJson("package.json");
if (rootPackage.packageManager !== "npm@11.10.1") fail("packageManager must be npm@11.10.1");
if (rootPackage.engines?.node !== ">=22.19.0 <23") fail("Node engine must be >=22.19.0 <23");
if (rootPackage.engines?.npm !== ">=11.10.1 <12") fail("npm engine must be >=11.10.1 <12");

const cargoManifest = readFileSync(
  path.join(root, "apps/desktop-mac/src-tauri/Cargo.toml"),
  "utf8"
);
if (!/^version = "0\.1\.0"$/mu.test(cargoManifest)) {
  fail("desktop Cargo package must use version 0.1.0");
}
if (!/^license = "Apache-2\.0"$/mu.test(cargoManifest)) {
  fail("desktop Cargo package must declare Apache-2.0");
}
if (!/^repository = "https:\/\/github\.com\/muniu-ai\/muniu"$/mu.test(cargoManifest)) {
  fail("desktop Cargo package has the wrong repository");
}

const lockText = readFileSync(path.join(root, "package-lock.json"), "utf8");
if (lockText.includes(obsoleteRegistryHost)) fail("package-lock.json uses an obsolete registry mirror");

const tauriConfig = readJson("apps/desktop-mac/src-tauri/tauri.conf.json");
const tauriCapabilities = readJson("apps/desktop-mac/src-tauri/capabilities/default.json");
if (tauriConfig.bundle?.createUpdaterArtifacts !== false) {
  fail("v0.1.0 must disable Tauri updater artifacts");
}
if (tauriConfig.plugins?.updater) fail("v0.1.0 must not configure an updater endpoint");
if (tauriCapabilities.permissions.includes("updater:default")) {
  fail("v0.1.0 must not grant updater capabilities");
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const secretPatterns = [
  [
    "private key",
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  ],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["model API key", /\b(?:sk-[A-Za-z0-9]{32,}|sk-(?:ant|proj)-[A-Za-z0-9_-]{40,})\b/]
];
for (const relativePath of tracked) {
  const absolutePath = path.join(root, relativePath);
  const size = statSync(absolutePath).size;
  if (size > 5 * 1024 * 1024) fail("tracked file exceeds 5 MiB: " + relativePath);
  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  if (text.includes(localAbsolutePath)) fail("local absolute path in " + relativePath);
  if (text.includes(obsoleteRepositoryPath)) fail("obsolete repository URL in " + relativePath);
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) fail("possible " + label + " in " + relativePath);
  }
}

for (const name of readdirSync(path.join(root, ".github/workflows"))) {
  if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
  const workflow = readFileSync(path.join(root, ".github/workflows", name), "utf8");
  for (const line of workflow.split("\n")) {
    if (!line.includes("uses:")) continue;
    const revision = line.match(/uses:\s+[^@\s]+@([^\s#]+)/)?.[1];
    if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
      fail("GitHub Action is not pinned to a commit in .github/workflows/" + name + ": " + line.trim());
    }
  }
}

if (failures.length > 0) {
  console.error(failures.map((message) => "- " + message).join("\n"));
  process.exit(1);
}
console.log("Open-source baseline checks passed (" + tracked.length + " tracked files scanned).");
