import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const rootDir = process.cwd();
const tauriConfigPath = path.join(rootDir, "apps/desktop-mac/src-tauri/tauri.conf.json");
const desktopPackagePath = path.join(rootDir, "apps/desktop-mac/package.json");
const rootPackagePath = path.join(rootDir, "package.json");
const macReleaseScriptPath = path.join(rootDir, "apps/desktop-mac/scripts/build-macos-release.mjs");
const cargoManifestPath = path.join(rootDir, "apps/desktop-mac/src-tauri/Cargo.toml");
const tauriLibPath = path.join(rootDir, "apps/desktop-mac/src-tauri/src/lib.rs");
const tauriIconSourcePath = path.join(rootDir, "apps/desktop-mac/src-tauri/app-icon.svg");
const tauriIconDir = path.join(rootDir, "apps/desktop-mac/src-tauri/icons");
const tauriCapabilitiesPath = path.join(rootDir, "apps/desktop-mac/src-tauri/capabilities/default.json");
const caskPath = path.join(rootDir, "packaging/homebrew/Casks/mniu.rb");
const updaterManifestPath = path.join(rootDir, "packaging/updater/latest.dry-run.json");
const releaseDocPath = path.join(rootDir, "docs/release/macos.md");
const developerIdDocPath = path.join(rootDir, "docs/release/apple-developer-id.md");
const dmgInstallGuidePath = path.join(rootDir, "packaging/macos/安装说明.txt");
const signingPreflightPath = path.join(rootDir, "scripts/preflight-macos-signing.mjs");
const updaterManifestGeneratorPath = path.join(rootDir, "scripts/generate-macos-updater-manifest.mjs");
const daemonSidecarScriptPath = path.join(rootDir, "scripts/build-daemon-sidecar.mjs");
const packagedAppVerifierPath = path.join(rootDir, "scripts/verify-packaged-macos-app.mjs");
const apiSidecarPath = path.join(rootDir, "apps/api/src/sidecar.ts");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label} is missing ${JSON.stringify(expected)}`);
  }
}

function assertMatch(text, pattern, label) {
  if (!pattern.test(text)) {
    throw new Error(`${label} does not match ${pattern}`);
  }
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`invalid semver: ${version}`);
  }
  return match.slice(1, 4).map((part) => Number.parseInt(part, 10));
}

function assertGreaterVersion(candidate, current) {
  const candidateParts = parseSemver(candidate);
  const currentParts = parseSemver(current);
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] > currentParts[index]) {
      return;
    }
    if (candidateParts[index] < currentParts[index]) {
      throw new Error(`updater dry-run version ${candidate} is older than current ${current}`);
    }
  }
  throw new Error(`updater dry-run version ${candidate} must be newer than current ${current}`);
}

const tauriConfig = readJson(tauriConfigPath);
const desktopPackage = readJson(desktopPackagePath);
const rootPackage = readJson(rootPackagePath);
const tauriCapabilities = readJson(tauriCapabilitiesPath);
const macReleaseScript = readFileSync(macReleaseScriptPath, "utf8");
const cargoManifest = readFileSync(cargoManifestPath, "utf8");
const tauriLib = readFileSync(tauriLibPath, "utf8");
const cask = readFileSync(caskPath, "utf8");
const updaterManifest = readJson(updaterManifestPath);
const releaseDoc = readFileSync(releaseDocPath, "utf8");
const developerIdDoc = readFileSync(developerIdDocPath, "utf8");
const dmgInstallGuide = readFileSync(dmgInstallGuidePath, "utf8");
const signingPreflight = readFileSync(signingPreflightPath, "utf8");
const updaterManifestGenerator = readFileSync(updaterManifestGeneratorPath, "utf8");
const daemonSidecarScript = readFileSync(daemonSidecarScriptPath, "utf8");
const packagedAppVerifier = readFileSync(packagedAppVerifierPath, "utf8");
const apiSidecar = readFileSync(apiSidecarPath, "utf8");
const requiredTauriIcons = [
  tauriIconSourcePath,
  path.join(tauriIconDir, "icon.png"),
  path.join(tauriIconDir, "icon.icns"),
  path.join(tauriIconDir, "icon.ico"),
  path.join(tauriIconDir, "32x32.png"),
  path.join(tauriIconDir, "128x128.png"),
  path.join(tauriIconDir, "128x128@2x.png"),
];

for (const iconPath of requiredTauriIcons) {
  if (!existsSync(iconPath)) {
    throw new Error(`required Tauri icon asset is missing: ${path.relative(rootDir, iconPath)}`);
  }
  if (statSync(iconPath).size <= 0) {
    throw new Error(`required Tauri icon asset is empty: ${path.relative(rootDir, iconPath)}`);
  }
}

if (tauriConfig.version !== desktopPackage.version) {
  throw new Error(`Tauri version ${tauriConfig.version} does not match desktop package ${desktopPackage.version}`);
}

assertIncludes(cask, `version "${tauriConfig.version}"`, "Homebrew cask");
assertIncludes(cask, `app "${tauriConfig.productName}.app"`, "Homebrew cask");
assertIncludes(cask, `uninstall quit: "${tauriConfig.identifier}"`, "Homebrew cask");
assertIncludes(cask, "depends_on macos: :monterey", "Homebrew cask");
assertIncludes(cask, "REPLACE_WITH_RELEASE_SHA256", "Homebrew cask");
assertIncludes(cask, 'sha256 "0000000000000000000000000000000000000000000000000000000000000000"', "Homebrew cask");
assertMatch(cask, /url "https:\/\/github\.com\/[^"]+\/releases\/download\/v#\{version\}\/Muniu_#\{version\}_universal\.dmg"/, "Homebrew cask URL");

if (tauriConfig.bundle?.createUpdaterArtifacts !== true) {
  throw new Error("Tauri bundle.createUpdaterArtifacts must be true for updater dry-run artifacts");
}

const updaterConfig = tauriConfig.plugins?.updater;
if (!updaterConfig) {
  throw new Error("Tauri plugins.updater configuration is missing");
}
assertIncludes(desktopPackage.dependencies?.["@tauri-apps/plugin-updater"] ?? "", "^2.", "desktop updater JS dependency");
assertIncludes(desktopPackage.dependencies?.["@tauri-apps/plugin-process"] ?? "", "^2.", "desktop process JS dependency");
assertIncludes(desktopPackage.scripts?.["tauri:build"] ?? "", "scripts/build-macos-release.mjs", "desktop release script");
assertIncludes(desktopPackage.scripts?.["tauri:build:raw"] ?? "", "tauri build", "desktop raw Tauri build script");
assertIncludes(rootPackage.scripts?.["release:mac"] ?? "", "tauri:build -w @mn/desktop-mac", "root mac release script");
assertIncludes(rootPackage.scripts?.["release:mac"] ?? "", "build:daemon-sidecar", "root mac release script");
assertIncludes(rootPackage.scripts?.["build:daemon-sidecar"] ?? "", "build-daemon-sidecar.mjs", "daemon sidecar build script");
assertIncludes(rootPackage.scripts?.["verify:mac-packaged-app"] ?? "", "verify-packaged-macos-app.mjs", "packaged app verifier");
assertIncludes(rootPackage.scripts?.["preflight:mac-signing"] ?? "", "preflight-macos-signing.mjs", "root mac signing preflight");
assertIncludes(macReleaseScript, "universal-apple-darwin", "macOS headless release script");
assertIncludes(macReleaseScript, "--bundles", "macOS headless release script");
assertIncludes(macReleaseScript, "hdiutil", "macOS headless release script");
assertIncludes(macReleaseScript, "Muniu_", "macOS headless release script");
assertIncludes(macReleaseScript, "MNIU_MACOS_SIGNING_IDENTITY", "macOS headless release script");
assertIncludes(macReleaseScript, "MNIU_NOTARY_KEYCHAIN_PROFILE", "macOS headless release script");
assertIncludes(macReleaseScript, "MNIU_MACOS_NOTARIZE=1 requires MNIU_MACOS_SIGN=1", "macOS headless release script");
assertIncludes(macReleaseScript, "notarytool", "macOS headless release script");
assertIncludes(macReleaseScript, "stapler", "macOS headless release script");
assertIncludes(macReleaseScript, "updaterArchiveName", "macOS versioned updater archive");
assertIncludes(macReleaseScript, "versioned updater archive does not contain", "macOS updater archive integrity check");
assertIncludes(macReleaseScript, "generate-macos-updater-manifest.mjs", "macOS updater manifest generation");
assertIncludes(macReleaseScript, "requires a Tauri updater private key", "macOS public updater key gate");
assertIncludes(macReleaseScript, "ditto", "macOS ZIP release script");
assertIncludes(macReleaseScript, "CFBundleExecutable", "macOS artifact executable lookup");
assertIncludes(macReleaseScript, "-verify_arch", "macOS universal binary verification");
assertIncludes(macReleaseScript, 'run("unzip", ["-t", zipPath])', "macOS ZIP integrity verification");
assertIncludes(macReleaseScript, 'run("hdiutil", ["verify", dmgPath])', "macOS DMG integrity verification");
if (macReleaseScript.includes("osascript")) {
  throw new Error("macOS headless release script must not depend on osascript/Finder automation");
}
for (const expected of ["darwin-aarch64", "darwin-x86_64", "REPLACE_WITH", "encodeURIComponent"]) {
  assertIncludes(updaterManifestGenerator, expected, "macOS updater manifest generator");
}
assertIncludes(cargoManifest, 'tauri-plugin-updater = "2"', "desktop Cargo manifest");
assertIncludes(cargoManifest, 'tauri-plugin-process = "2"', "desktop Cargo manifest");
assertIncludes(cargoManifest, 'tauri-plugin-shell = "2"', "desktop Cargo manifest");
assertIncludes(tauriLib, "tauri_plugin_updater::Builder::new().build()", "desktop Tauri plugin registration");
assertIncludes(tauriLib, "tauri_plugin_process::init()", "desktop Tauri process plugin registration");
assertIncludes(tauriLib, "tauri_plugin_shell::init()", "desktop Tauri shell plugin registration");
assertIncludes(tauriLib, "spawn_managed_daemon", "desktop managed daemon");
assertIncludes(tauriLib, '.sidecar("mn-api")', "desktop managed daemon");
assertIncludes(tauriLib, "MN_DESKTOP_PACKAGED", "desktop managed daemon Keychain mode");
assertIncludes(tauriLib, "MN_DESKTOP_PARENT_PID", "desktop managed daemon parent lifecycle");
assertIncludes(tauriLib, "ExitRequested", "desktop managed daemon early shutdown");
assertIncludes(tauriLib, "tray-provider-preview", "desktop tray provider preview event");
assertIncludes(tauriLib, '"dryRun": true', "desktop tray provider preview request");
assertIncludes(tauriLib, "refresh_tray_providers", "desktop dynamic tray providers");
assertIncludes(tauriLib, '"toggle_proxy"', "desktop tray proxy control");
assertIncludes(tauriLib, '"tray-proxy-changed"', "desktop tray proxy status event");
assertIncludes(tauriConfig.bundle?.externalBin?.join(",") ?? "", "binaries/mn-api", "Tauri daemon externalBin");
assertIncludes(
  JSON.stringify(tauriConfig.bundle?.resources ?? {}),
  "mn-api-aarch64-apple-darwin",
  "Tauri arm64 daemon resource"
);
assertIncludes(
  JSON.stringify(tauriConfig.bundle?.resources ?? {}),
  "mn-api-x86_64-apple-darwin",
  "Tauri x86_64 daemon resource"
);
assertIncludes(rootPackage.devDependencies?.["@yao-pkg/pkg"] ?? "", "^6.", "daemon sidecar packager");
assertIncludes(rootPackage.devDependencies?.esbuild ?? "", "^0.28", "daemon sidecar bundler");
assertIncludes(rootPackage.devDependencies?.["ds-store"] ?? "", "^0.1", "headless DMG Finder metadata writer");
for (const expected of [
  "DSStore",
  "setBackgroundPath",
  "setIconPos",
  "安装说明.txt",
  '"UDRW"',
  '"convert"',
  "verifyMountedDmg",
]) {
  assertIncludes(macReleaseScript, expected, "macOS DMG presentation pipeline");
}
for (const expected of ["木牛安装说明", "Applications", "Developer ID Application", "Apple 公证"]) {
  assertIncludes(dmgInstallGuide, expected, "DMG installation guide");
}
for (const expected of [
  "node22-macos-arm64,node22-macos-x64",
  "secretVaultBackend",
  "MN_DESKTOP_PACKAGED",
  "lipo",
  "uname -m",
  "../Resources",
]) {
  assertIncludes(daemonSidecarScript, expected, "daemon sidecar build script");
}
for (const expected of ["MN_DESKTOP_PARENT_PID", "process.kill(desktopParentPid, 0)", "parentMonitor.unref()"] ) {
  assertIncludes(apiSidecar, expected, "daemon parent lifecycle monitor");
}
for (const expected of [
  "secretVaultBackend",
  "childDaemonPid",
  "waitForShutdown",
  "find-generic-password",
  "delete-generic-password",
  "mniu://import/provider",
  "x86_64",
  "arm64",
] ) {
  assertIncludes(packagedAppVerifier, expected, "packaged app verifier");
}
assertIncludes(tauriLib, "install_panic_log_hook();", "desktop panic log hook registration");
assertIncludes(tauriLib, "fn install_panic_log_hook()", "desktop panic log hook");
assertIncludes(tauriLib, "fn write_panic_log", "desktop panic log writer");
assertIncludes(tauriLib, 'join("Library")', "desktop panic log path");
assertIncludes(tauriLib, 'join("Logs")', "desktop panic log path");
assertIncludes(tauriLib, 'join("dev.muniu.desktop")', "desktop panic log path");
assertIncludes(tauriLib, 'join("panic.log")', "desktop panic log path");
assertIncludes(tauriLib, "sanitize_panic_message", "desktop panic message redaction");
if (!tauriCapabilities.permissions.includes("updater:default")) {
  throw new Error("default desktop capability must allow updater:default");
}
if (!tauriCapabilities.permissions.includes("process:allow-restart")) {
  throw new Error("default desktop capability must allow process restart");
}
const desktopAppSource = readFileSync(path.join(rootDir, "apps/desktop-mac/src/App.tsx"), "utf8");
for (const expected of ["checkForUpdate", "downloadAndInstall", "relaunch", "检查更新"]) {
  assertIncludes(desktopAppSource, expected, "desktop updater runtime");
}
if (!Array.isArray(updaterConfig.endpoints) || updaterConfig.endpoints.length !== 1) {
  throw new Error("Tauri updater must define exactly one release endpoint");
}
const updaterEndpoint = "https://github.com/muniu-ai/muniu/releases/latest/download/latest.json";
if (updaterConfig.endpoints[0] !== updaterEndpoint) {
  throw new Error(`unexpected updater endpoint: ${updaterConfig.endpoints[0]}`);
}
const decodedPubkey = Buffer.from(updaterConfig.pubkey ?? "", "base64").toString("utf8");
assertIncludes(decodedPubkey, "minisign public key", "Tauri updater pubkey");

assertGreaterVersion(updaterManifest.version, tauriConfig.version);
if (Number.isNaN(Date.parse(updaterManifest.pub_date))) {
  throw new Error("updater manifest pub_date must be a valid date");
}
for (const platform of ["darwin-aarch64", "darwin-x86_64"]) {
  const platformManifest = updaterManifest.platforms?.[platform];
  if (!platformManifest) {
    throw new Error(`updater manifest is missing ${platform}`);
  }
  assertIncludes(
    platformManifest.url,
    `https://github.com/muniu-ai/muniu/releases/download/v${updaterManifest.version}/Muniu_${updaterManifest.version}_universal.app.tar.gz`,
    `updater ${platform} URL`
  );
  assertIncludes(platformManifest.signature, "REPLACE_WITH_TAURI_UPDATER_SIGNATURE", `updater ${platform} signature`);
}

execFileSync("ruby", ["-c", caskPath], { stdio: "inherit" });

for (const expected of [
  "# macOS 发布指南",
  "Homebrew cask",
  "自动更新 dry-run",
  "Apple Developer 签名",
  "Apple 公证",
  "安装",
  "卸载",
  "安全要求",
  "mniu://",
  "brew tap-new",
  "brew install --cask --dry-run",
  "brew uninstall --cask --zap",
  "REPLACE_WITH_RELEASE_SHA256",
  "latest.dry-run.json",
  "createUpdaterArtifacts",
  "TAURI_SIGNING_PRIVATE_KEY_PATH",
  "apple-developer-id.md",
]) {
  assertIncludes(releaseDoc, expected, "macOS release guide");
}

for (const expected of [
  "# Developer ID 与 macOS 公证操作手册",
  "仅在当前开发 Mac 上运行",
  "Developer ID Application",
  "notarytool store-credentials",
  "preflight:mac-signing",
  "TAURI_SIGNING_PRIVATE_KEY",
  "npm run tauri -w @mn/desktop-mac -- signer generate",
  "codesign --verify",
  "stapler validate",
  "spctl --assess",
]) {
  assertIncludes(developerIdDoc, expected, "Developer ID guide");
}

for (const expected of [
  "--public",
  "security",
  "Developer ID Application",
  "MNIU_NOTARY_KEYCHAIN_PROFILE",
  "TAURI_SIGNING_PRIVATE_KEY_PATH",
]) {
  assertIncludes(signingPreflight, expected, "macOS signing preflight");
}

const fakePublicPreflight = spawnSync(
  process.execPath,
  [signingPreflightPath, "--public"],
  {
    cwd: rootDir,
    encoding: "utf8",
    env: {
      ...process.env,
      MNIU_MACOS_SIGNING_IDENTITY: "Developer ID Application: Fake (FAKE)",
      MNIU_NOTARY_KEYCHAIN_PROFILE: "mniu-nonexistent-preflight-profile",
      TAURI_SIGNING_PRIVATE_KEY_PATH: "",
      TAURI_SIGNING_PRIVATE_KEY: "RWFAKE"
    }
  }
);
if (fakePublicPreflight.status === 0) {
  throw new Error("macOS public signing preflight accepted fake credentials");
}
assertIncludes(
  `${fakePublicPreflight.stdout}${fakePublicPreflight.stderr}`,
  "Public distribution preflight failed",
  "macOS fake signing preflight"
);

const updaterKeyTempDir = mkdtempSync(path.join(os.tmpdir(), "mniu-release-verifier-updater-key-"));
try {
  const updaterKeyPath = path.join(updaterKeyTempDir, "updater.key");
  const updaterKeyPassword = "mniu-release-verifier-password";
  const updaterArchivePath = path.join(updaterKeyTempDir, "Muniu_9.8.7_universal.app.tar.gz");
  const generatedManifestPath = path.join(updaterKeyTempDir, "latest.json");
  execFileSync(
    path.join(rootDir, "node_modules/.bin/tauri"),
    ["signer", "generate", "--ci", "--password", updaterKeyPassword, "--write-keys", updaterKeyPath],
    { cwd: rootDir, stdio: "ignore" }
  );
  writeFileSync(updaterArchivePath, "temporary updater archive\n", "utf8");
  const updaterKeyEnv = {
    ...process.env,
    MNIU_MACOS_SIGNING_IDENTITY: "Developer ID Application: Fake (FAKE)",
    MNIU_NOTARY_KEYCHAIN_PROFILE: "mniu-nonexistent-preflight-profile",
    TAURI_SIGNING_PRIVATE_KEY_PATH: updaterKeyPath,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: updaterKeyPassword,
  };
  delete updaterKeyEnv.TAURI_SIGNING_PRIVATE_KEY;
  execFileSync(path.join(rootDir, "node_modules/.bin/tauri"), ["signer", "sign", updaterArchivePath], {
    cwd: rootDir,
    env: updaterKeyEnv,
    stdio: "ignore",
  });
  execFileSync(
    process.execPath,
    [
      updaterManifestGeneratorPath,
      "--version",
      "9.8.7",
      "--archive",
      updaterArchivePath,
      "--signature",
      `${updaterArchivePath}.sig`,
      "--output",
      generatedManifestPath,
      "--base-url",
      "https://downloads.example.test/releases/v9.8.7",
      "--pub-date",
      "2026-07-11T00:00:00Z",
    ],
    { cwd: rootDir, stdio: "ignore" }
  );
  const generatedManifest = readJson(generatedManifestPath);
  if (generatedManifest.version !== "9.8.7") throw new Error("generated updater manifest version mismatch");
  for (const platform of ["darwin-aarch64", "darwin-x86_64"]) {
    const entry = generatedManifest.platforms?.[platform];
    if (!entry?.signature || !entry.url.endsWith("/Muniu_9.8.7_universal.app.tar.gz")) {
      throw new Error(`generated updater manifest is invalid for ${platform}`);
    }
  }
  const realUpdaterKeyPreflight = spawnSync(process.execPath, [signingPreflightPath, "--public"], {
    cwd: rootDir,
    encoding: "utf8",
    env: updaterKeyEnv,
  });
  if (realUpdaterKeyPreflight.status === 0) {
    throw new Error("macOS public signing preflight unexpectedly passed without Apple credentials");
  }
  assertIncludes(
    `${realUpdaterKeyPreflight.stdout}${realUpdaterKeyPreflight.stderr}`,
    "PASS validated Tauri updater private key",
    "macOS real updater-key preflight"
  );
} finally {
  rmSync(updaterKeyTempDir, { recursive: true, force: true });
}

console.log("macOS release packaging checks passed");
