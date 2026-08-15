import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const publicDistribution = process.argv.includes("--public") || process.env.MNIU_MACOS_PUBLIC_DISTRIBUTION === "1";
const expectedIdentity = process.env.MNIU_MACOS_SIGNING_IDENTITY ?? process.env.APPLE_SIGNING_IDENTITY ?? "";
const notaryProfile = process.env.MNIU_NOTARY_KEYCHAIN_PROFILE ?? "";
const updaterKey = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || process.env.TAURI_SIGNING_PRIVATE_KEY || "";

function runResult(command, args = [], options = {}) {
  try {
    return {
      ok: true,
      output: execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options
      }).trim()
    };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim()
    };
  }
}

function run(command, args = []) {
  return runResult(command, args).output;
}

function commandAvailable(command) {
  return run("/usr/bin/xcrun", ["--find", command]).length > 0;
}

function updaterKeyConfigured(value) {
  if (!value) return false;
  if (value.includes("untrusted comment:") || value.includes("RW")) return true;
  return existsSync(path.resolve(value));
}

function validateNotaryProfile(profile) {
  if (!profile) return false;
  return runResult("/usr/bin/xcrun", [
    "notarytool",
    "history",
    "--keychain-profile",
    profile,
    "--output-format",
    "json"
  ]).ok;
}

function validateUpdaterKey(value) {
  if (!updaterKeyConfigured(value)) return false;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mniu-updater-key-"));
  const samplePath = path.join(tempDir, "sample.txt");
  const tauriCli = path.resolve("node_modules/.bin/tauri");
  writeFileSync(samplePath, "mniu updater signing preflight\n", "utf8");
  const keyArgs = existsSync(path.resolve(value))
    ? ["--private-key-path", path.resolve(value)]
    : ["--private-key", value];
  const signerEnv = { ...process.env };
  delete signerEnv.TAURI_SIGNING_PRIVATE_KEY;
  delete signerEnv.TAURI_SIGNING_PRIVATE_KEY_PATH;
  try {
    return runResult(tauriCli, ["signer", "sign", ...keyArgs, samplePath], {
      env: signerEnv
    }).ok;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const identityOutput = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
const identities = [...identityOutput.matchAll(/"(Developer ID Application:[^"]+)"/g)].map((match) => match[1]);
const identityReady = expectedIdentity ? identities.includes(expectedIdentity) : identities.length > 0;
const notaryReady = publicDistribution ? validateNotaryProfile(notaryProfile) : Boolean(notaryProfile);
const updaterKeyReady = publicDistribution ? validateUpdaterKey(updaterKey) : updaterKeyConfigured(updaterKey);
const checks = [
  ["Xcode command line tools", commandAvailable("codesign") && commandAvailable("notarytool")],
  ["Developer ID Application identity", identityReady],
  ["validated notarytool Keychain profile", notaryReady],
  ["validated Tauri updater private key", updaterKeyReady],
];

console.log(publicDistribution ? "Mode: public distribution" : "Mode: local development / self-use");
for (const [label, passed] of checks) {
  console.log(`${passed ? "PASS" : "MISSING"} ${label}`);
}
if (identities.length > 0) {
  console.log(`Detected identity: ${identities.join(", ")}`);
}

if (!publicDistribution) {
  console.log("Unsigned local builds are allowed. Run with --public to enforce release credentials.");
  process.exit(0);
}

const missing = checks.filter(([, passed]) => !passed);
if (missing.length > 0) {
  console.error("Public distribution preflight failed. See docs/release/apple-developer-id.md.");
  process.exit(1);
}
console.log("Public distribution signing preflight passed.");
