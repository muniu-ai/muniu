import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import DSStore from "ds-store";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopDir, "../..");
const tauriDir = path.join(desktopDir, "src-tauri");
const tauriConfigPath = path.join(tauriDir, "tauri.conf.json");
const tauriBin = path.join(repoRoot, "node_modules/.bin/tauri");
const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));

const target = process.env.MNIU_MACOS_TARGET ?? "universal-apple-darwin";
const shouldSign = process.env.MNIU_MACOS_SIGN === "1";
const shouldNotarize = process.env.MNIU_MACOS_NOTARIZE === "1";
const signingIdentity = process.env.MNIU_MACOS_SIGNING_IDENTITY ?? process.env.APPLE_SIGNING_IDENTITY;
const notaryProfile = process.env.MNIU_NOTARY_KEYCHAIN_PROFILE;
const archLabel = target === "universal-apple-darwin" ? "universal" : target.replace(/-apple-darwin$/, "");
const releaseDir = path.join(tauriDir, "target", target, "release");
const bundleDir = path.join(releaseDir, "bundle");
const macosBundleDir = path.join(bundleDir, "macos");
const dmgBundleDir = path.join(bundleDir, "dmg");
const appPath = path.join(macosBundleDir, `${config.productName}.app`);
const dmgName = `Muniu_${config.version}_${archLabel}.dmg`;
const dmgPath = path.join(dmgBundleDir, dmgName);
const zipName = `Muniu_${config.version}_${archLabel}.zip`;
const zipPath = path.join(macosBundleDir, zipName);
const notaryUploadPath = path.join(macosBundleDir, `.notary-${zipName}`);
const stagingDir = path.join(dmgBundleDir, ".headless-staging");
const mountDir = path.join(dmgBundleDir, ".headless-mount");
const writableDmgPath = path.join(dmgBundleDir, `.rw-${dmgName}`);
const installGuideName = "安装说明.txt";
const installGuideSourcePath = path.join(repoRoot, "packaging", "macos", installGuideName);
const backgroundDirName = ".background";
const backgroundName = "background.png";

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
    stdio: "inherit",
  });
}

function runCapture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
    encoding: "utf8",
  }).trim();
}

function writeFinderMetadata(volumePath) {
  const store = new DSStore();
  store.setBackgroundPath(path.join(volumePath, backgroundDirName, backgroundName));
  store.setBackgroundColor(0.957, 0.965, 0.973);
  store.setIconSize(104);
  store.setIconPos(`${config.productName}.app`, 160, 175);
  store.setIconPos("Applications", 440, 175);
  store.setIconPos(installGuideName, 300, 305);
  store.setWindowPos(120, 120);
  store.setWindowSize(600, 360);
  return new Promise((resolve, reject) => {
    store.write(path.join(volumePath, ".DS_Store"), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function verifyMountedDmg(volumePath) {
  const requiredFiles = [
    path.join(volumePath, `${config.productName}.app`),
    path.join(volumePath, backgroundDirName, backgroundName),
    path.join(volumePath, installGuideName),
    path.join(volumePath, ".DS_Store"),
  ];
  for (const filePath of requiredFiles) {
    if (!existsSync(filePath) || statSync(filePath).size <= 0) {
      throw new Error(`DMG is missing required content: ${filePath}`);
    }
  }
  const applicationsLink = path.join(volumePath, "Applications");
  if (!lstatSync(applicationsLink).isSymbolicLink()) {
    throw new Error("DMG Applications entry must be a symbolic link");
  }
  const instructions = readFileSync(path.join(volumePath, installGuideName), "utf8");
  if (!instructions.includes("Applications") || !instructions.includes(config.productName)) {
    throw new Error("DMG installation guide is incomplete");
  }
}

if (target === "universal-apple-darwin") {
  run("rustup", ["target", "add", "aarch64-apple-darwin", "x86_64-apple-darwin"]);
}

if (shouldSign && !signingIdentity) {
  throw new Error("MNIU_MACOS_SIGN=1 requires MNIU_MACOS_SIGNING_IDENTITY or APPLE_SIGNING_IDENTITY");
}
if (shouldNotarize && !shouldSign) {
  throw new Error("MNIU_MACOS_NOTARIZE=1 requires MNIU_MACOS_SIGN=1");
}
if (shouldNotarize && !notaryProfile) {
  throw new Error("MNIU_MACOS_NOTARIZE=1 requires MNIU_NOTARY_KEYCHAIN_PROFILE");
}
const tauriArgs = ["build", "--ci", "--bundles", "app", "--target", target];
if (!shouldSign) {
  tauriArgs.push("--no-sign");
} else {
  tauriArgs.push("--config", JSON.stringify({ bundle: { macOS: { signingIdentity } } }));
}
run(tauriBin, tauriArgs, { cwd: desktopDir });

const executableName = runCapture("plutil", [
  "-extract",
  "CFBundleExecutable",
  "raw",
  "-o",
  "-",
  path.join(appPath, "Contents", "Info.plist"),
]);
const appExecutablePath = path.join(appPath, "Contents", "MacOS", executableName);
if (target === "universal-apple-darwin") {
  run("lipo", [appExecutablePath, "-verify_arch", "x86_64", "arm64"]);
}

if (shouldSign) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

rmSync(zipPath, { force: true });
rmSync(notaryUploadPath, { force: true });
if (shouldNotarize) {
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, notaryUploadPath]);
  run("xcrun", ["notarytool", "submit", notaryUploadPath, "--keychain-profile", notaryProfile, "--wait"]);
  run("xcrun", ["stapler", "staple", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
  run("spctl", ["--assess", "--type", "execute", "--verbose", appPath]);
  rmSync(notaryUploadPath, { force: true });
}

run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
run("unzip", ["-t", zipPath]);

rmSync(dmgPath, { force: true });
rmSync(writableDmgPath, { force: true });
rmSync(stagingDir, { recursive: true, force: true });
rmSync(mountDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
mkdirSync(dmgBundleDir, { recursive: true });
cpSync(appPath, path.join(stagingDir, `${config.productName}.app`), {
  recursive: true,
  verbatimSymlinks: true,
});
symlinkSync("/Applications", path.join(stagingDir, "Applications"));
cpSync(installGuideSourcePath, path.join(stagingDir, installGuideName));
const backgroundDir = path.join(stagingDir, backgroundDirName);
const backgroundPath = path.join(backgroundDir, backgroundName);
mkdirSync(backgroundDir, { recursive: true });
cpSync(path.join(tauriDir, "icons", "128x128@2x.png"), backgroundPath);
run("sips", ["--resampleHeightWidth", "96", "96", backgroundPath]);
run("sips", ["--padToHeightWidth", "360", "600", "--padColor", "F4F6F8", backgroundPath]);

run("hdiutil", [
  "create",
  "-volname",
  config.productName,
  "-srcfolder",
  stagingDir,
  "-format",
  "UDRW",
  "-ov",
  writableDmgPath,
]);
mkdirSync(mountDir, { recursive: true });
run("hdiutil", [
  "attach",
  writableDmgPath,
  "-readwrite",
  "-noverify",
  "-noautoopen",
  "-mountpoint",
  mountDir,
]);
try {
  await writeFinderMetadata(mountDir);
  run("sync", []);
} finally {
  run("hdiutil", ["detach", mountDir]);
}
run("hdiutil", ["convert", writableDmgPath, "-format", "UDZO", "-ov", "-o", dmgPath]);
rmSync(writableDmgPath, { force: true });
rmSync(stagingDir, { recursive: true, force: true });
rmSync(mountDir, { recursive: true, force: true });

if (shouldSign) {
  run("codesign", ["--force", "--timestamp", "--sign", signingIdentity, dmgPath]);
  run("codesign", ["--verify", "--verbose=2", dmgPath]);
}

if (shouldNotarize) {
  run("xcrun", ["notarytool", "submit", dmgPath, "--keychain-profile", notaryProfile, "--wait"]);
  run("xcrun", ["stapler", "staple", dmgPath]);
  run("xcrun", ["stapler", "validate", dmgPath]);
  run("spctl", ["--assess", "--type", "open", "--verbose", dmgPath]);
}

run("hdiutil", ["verify", dmgPath]);
mkdirSync(mountDir, { recursive: true });
run("hdiutil", ["attach", dmgPath, "-readonly", "-nobrowse", "-noverify", "-mountpoint", mountDir]);
try {
  verifyMountedDmg(mountDir);
} finally {
  run("hdiutil", ["detach", mountDir]);
  rmSync(mountDir, { recursive: true, force: true });
}
run("shasum", ["-a", "256", zipPath]);
run("shasum", ["-a", "256", dmgPath]);
console.log(`macOS release artifacts written to ${bundleDir}`);
