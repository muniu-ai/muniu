import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const tauriConfigPath = path.join(rootDir, "apps/desktop-mac/src-tauri/tauri.conf.json");
const desktopPackagePath = path.join(rootDir, "apps/desktop-mac/package.json");
const rootPackagePath = path.join(rootDir, "package.json");
const macReleaseScriptPath = path.join(rootDir, "apps/desktop-mac/scripts/build-macos-release.mjs");
const cargoManifestPath = path.join(rootDir, "apps/desktop-mac/src-tauri/Cargo.toml");
const cargoLockPath = path.join(rootDir, "apps/desktop-mac/src-tauri/Cargo.lock");
const tauriLibPath = path.join(rootDir, "apps/desktop-mac/src-tauri/src/lib.rs");
const tauriIconSourcePath = path.join(rootDir, "apps/desktop-mac/src-tauri/app-icon.svg");
const tauriIconDir = path.join(rootDir, "apps/desktop-mac/src-tauri/icons");
const tauriCapabilitiesPath = path.join(rootDir, "apps/desktop-mac/src-tauri/capabilities/default.json");
const tauriGeneratedSchemaPaths = [
  path.join(rootDir, "apps/desktop-mac/src-tauri/gen/schemas/acl-manifests.json"),
  path.join(rootDir, "apps/desktop-mac/src-tauri/gen/schemas/desktop-schema.json"),
  path.join(rootDir, "apps/desktop-mac/src-tauri/gen/schemas/macOS-schema.json"),
];
const caskPath = path.join(rootDir, "packaging/homebrew/Casks/mniu.rb");
const readmePath = path.join(rootDir, "README.md");
const technicalDesignPath = path.join(rootDir, "docs/TECHNICAL_DESIGN.md");
const releaseDocPath = path.join(rootDir, "docs/release/macos.md");
const developerIdDocPath = path.join(rootDir, "docs/release/apple-developer-id.md");
const dmgInstallGuidePath = path.join(rootDir, "packaging/macos/安装说明.txt");
const signingPreflightPath = path.join(rootDir, "scripts/preflight-macos-signing.mjs");
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

function assertExcludes(text, unexpected, label) {
  if (text.includes(unexpected)) {
    throw new Error(`${label} must not contain ${JSON.stringify(unexpected)}`);
  }
}

function assertMatch(text, pattern, label) {
  if (!pattern.test(text)) {
    throw new Error(`${label} does not match ${pattern}`);
  }
}

const tauriConfig = readJson(tauriConfigPath);
const desktopPackage = readJson(desktopPackagePath);
const rootPackage = readJson(rootPackagePath);
const tauriCapabilities = readJson(tauriCapabilitiesPath);
const macReleaseScript = readFileSync(macReleaseScriptPath, "utf8");
const cargoManifest = readFileSync(cargoManifestPath, "utf8");
const cargoLock = readFileSync(cargoLockPath, "utf8");
const tauriLib = readFileSync(tauriLibPath, "utf8");
const cask = readFileSync(caskPath, "utf8");
const readme = readFileSync(readmePath, "utf8");
const technicalDesign = readFileSync(technicalDesignPath, "utf8");
const releaseDoc = readFileSync(releaseDocPath, "utf8");
const developerIdDoc = readFileSync(developerIdDocPath, "utf8");
const dmgInstallGuide = readFileSync(dmgInstallGuidePath, "utf8");
const signingPreflight = readFileSync(signingPreflightPath, "utf8");
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

if (tauriConfig.bundle?.createUpdaterArtifacts !== false) {
  throw new Error("Tauri bundle.createUpdaterArtifacts must be false for v0.1.0");
}
if (tauriConfig.plugins?.updater !== undefined) {
  throw new Error("Tauri plugins.updater must be absent for v0.1.0");
}
if (desktopPackage.dependencies?.["@tauri-apps/plugin-updater"] !== undefined) {
  throw new Error("desktop updater JS dependency must be absent for v0.1.0");
}
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
for (const unexpected of ["updaterArchive", "generate-macos-updater-manifest", "TAURI_SIGNING_PRIVATE_KEY"]) {
  assertExcludes(macReleaseScript, unexpected, "macOS v0.1 release script");
}
assertIncludes(macReleaseScript, "ditto", "macOS ZIP release script");
assertIncludes(macReleaseScript, "CFBundleExecutable", "macOS artifact executable lookup");
assertIncludes(macReleaseScript, "-verify_arch", "macOS universal binary verification");
assertIncludes(macReleaseScript, 'run("unzip", ["-t", zipPath])', "macOS ZIP integrity verification");
assertIncludes(macReleaseScript, 'run("hdiutil", ["verify", dmgPath])', "macOS DMG integrity verification");
if (macReleaseScript.includes("osascript")) {
  throw new Error("macOS headless release script must not depend on osascript/Finder automation");
}
assertExcludes(cargoManifest, "tauri-plugin-updater", "desktop Cargo manifest");
assertExcludes(cargoLock, 'name = "tauri-plugin-updater"', "desktop Cargo lockfile");
assertIncludes(cargoManifest, 'tauri-plugin-process = "2"', "desktop Cargo manifest");
assertIncludes(cargoManifest, 'tauri-plugin-shell = "2"', "desktop Cargo manifest");
assertExcludes(tauriLib, "tauri_plugin_updater", "desktop Tauri plugin registration");
assertIncludes(tauriLib, "tauri_plugin_process::init()", "desktop Tauri process plugin registration");
assertIncludes(tauriLib, "tauri_plugin_shell::init()", "desktop Tauri shell plugin registration");
assertIncludes(tauriLib, "spawn_managed_daemon", "desktop managed daemon");
assertIncludes(tauriLib, '.sidecar("mn-api")', "desktop managed daemon");
assertIncludes(tauriLib, "MN_DESKTOP_PACKAGED", "desktop managed daemon Keychain mode");
assertIncludes(tauriLib, "MN_DESKTOP_PARENT_PID", "desktop managed daemon parent lifecycle");
assertIncludes(tauriLib, "MN_RUNTIME_BASE_PATH", "desktop managed daemon runtime bundle");
assertIncludes(tauriLib, "MN_RUNTIME_PROFILE_PATH", "desktop managed daemon runtime profile");
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
assertIncludes(
  JSON.stringify(tauriConfig.bundle?.resources ?? {}),
  "mn-descriptor-lock-aarch64-apple-darwin",
  "Tauri arm64 descriptor-lock resource"
);
assertIncludes(
  JSON.stringify(tauriConfig.bundle?.resources ?? {}),
  "mn-descriptor-lock-x86_64-apple-darwin",
  "Tauri x86_64 descriptor-lock resource"
);
for (const runtimeResource of [
  "runtime/base.yml",
  "runtime/profiles/local.yml",
  "runtime/profiles/enterprise-api.yml",
  "runtime/profiles/enterprise-worker.yml",
  "runtime/profiles/desktop.yml"
]) {
  assertIncludes(
    JSON.stringify(tauriConfig.bundle?.resources ?? {}),
    runtimeResource,
    "Tauri runtime profile resource"
  );
}
assertIncludes(rootPackage.devDependencies?.["@yao-pkg/pkg"] ?? "", "^6.", "daemon sidecar packager");
assertIncludes(rootPackage.devDependencies?.esbuild ?? "", "^0.28", "daemon sidecar bundler");
assertIncludes(rootPackage.optionalDependencies?.["ds-store"] ?? "", "^0.1", "optional macOS DMG Finder metadata writer");
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
  "build-descriptor-lock-helper.mjs",
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
  "muniu://import/provider",
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
if (tauriCapabilities.permissions.some((permission) => JSON.stringify(permission).includes("updater:"))) {
  throw new Error("default desktop capability must not allow updater permissions");
}
if (!tauriCapabilities.permissions.includes("process:allow-restart")) {
  throw new Error("default desktop capability must allow process restart");
}
const desktopAppSource = readFileSync(path.join(rootDir, "apps/desktop-mac/src/App.tsx"), "utf8");
for (const unexpected of ["@tauri-apps/plugin-updater", "checkForUpdate", "downloadAndInstall", "prepareDesktopUpdate", "updateBusy", "updateMessage", "检查更新"]) {
  assertExcludes(desktopAppSource, unexpected, "desktop v0.1 runtime");
}
for (const schemaPath of tauriGeneratedSchemaPaths) {
  const schema = readFileSync(schemaPath, "utf8");
  assertExcludes(schema, '"updater":', path.relative(rootDir, schemaPath));
  assertExcludes(schema, "updater:", path.relative(rootDir, schemaPath));
}

execFileSync("ruby", ["-c", caskPath], { stdio: "inherit" });

for (const expected of [
  "# macOS 发布指南",
  "Homebrew cask",
  "v0.1.0 Developer Preview 不包含运行时自动更新器",
  "Apple Developer 签名",
  "Apple 公证",
  "安装",
  "卸载",
  "安全要求",
  "muniu://",
  "mniu://",
  "brew tap-new",
  "brew install --cask --dry-run",
  "brew uninstall --cask --zap",
  "REPLACE_WITH_RELEASE_SHA256",
  "createUpdaterArtifacts",
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
  "v0.1.0 Developer Preview 不包含运行时自动更新器",
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
]) {
  assertIncludes(signingPreflight, expected, "macOS signing preflight");
}
assertExcludes(signingPreflight, "TAURI_SIGNING_PRIVATE_KEY", "macOS signing preflight");
assertExcludes(packagedAppVerifier, "updater", "packaged app verifier");

for (const [document, label] of [
  [readme, "README v0.1 release scope"],
  [technicalDesign, "technical design v0.1 release scope"],
]) {
  for (const obsoleteClaim of [
    "版本化 updater archive",
    "版本化 updater archive/manifest",
    "生成真实 `latest.json`",
    "packaging/updater/latest.dry-run.json",
  ]) {
    assertExcludes(document, obsoleteClaim, label);
  }
}
assertIncludes(readme, "v0.1.0 does not publish or enable a desktop runtime updater", "README v0.1 release scope");
assertIncludes(technicalDesign, "v0.1.0 不发布或启用桌面运行时 updater", "technical design v0.1 release scope");

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

console.log("macOS release packaging checks passed");
