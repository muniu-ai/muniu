import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const rootDir = process.cwd();
const appPath = path.join(
  rootDir,
  "apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle/macos/木牛.app"
);
const executablePath = path.join(appPath, "Contents/MacOS/mniu-desktop");
const launcherPath = path.join(appPath, "Contents/MacOS/mn-api");
const arm64Path = path.join(appPath, "Contents/Resources/mn-api-aarch64-apple-darwin");
const x64Path = path.join(appPath, "Contents/Resources/mn-api-x86_64-apple-darwin");
const dmgPath = path.join(
  rootDir,
  "apps/desktop-mac/src-tauri/target/universal-apple-darwin/release/bundle/dmg/Muniu_0.1.0_universal.dmg"
);
const home = mkdtempSync(path.join(tmpdir(), "mniu-packaged-home-"));
const keychainPath = path.join(home, "mniu-verification.keychain-db");
const keychainPassword = randomUUID();
let output = "";
let keychainAccount = "";

if (listenerPid()) {
  throw new Error("port 7318 is already in use; packaged app verification requires an isolated daemon");
}

verifyDmgContents();

assertArchitectures(executablePath, ["arm64", "x86_64"]);
assertArchitectures(arm64Path, ["arm64"]);
assertArchitectures(x64Path, ["x86_64"]);
const launcher = readFileSync(launcherPath, "utf8");
for (const expected of ["uname -m", "mn-api-aarch64-apple-darwin", "mn-api-x86_64-apple-darwin"]) {
  if (!launcher.includes(expected)) throw new Error(`packaged daemon launcher is missing ${expected}`);
}

execFileSync("/usr/bin/security", ["create-keychain", "-p", keychainPassword, keychainPath]);
execFileSync("/usr/bin/security", ["unlock-keychain", "-p", keychainPassword, keychainPath]);
execFileSync("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychainPath]);

const app = spawn(executablePath, [], {
  cwd: rootDir,
  env: {
    ...process.env,
    HOME: home,
    MN_SECRET_VAULT_KEYCHAIN_PATH: keychainPath
  },
  stdio: ["ignore", "pipe", "pipe"]
});
app.stdout.on("data", (chunk) => (output += chunk.toString()));
app.stderr.on("data", (chunk) => (output += chunk.toString()));

try {
  const health = await waitForHealth(app);
  if (health.service !== "mn-api" || health.secretVaultBackend !== "keychain") {
    throw new Error(`unexpected packaged daemon health: ${JSON.stringify(health)}`);
  }
  if (health.mniuRoot !== path.join(home, ".mniu")) {
    throw new Error(`packaged daemon escaped isolated HOME: ${health.mniuRoot}`);
  }

  const daemonPid = childDaemonPid(app.pid);
  if (!daemonPid) throw new Error(`managed daemon is not a child of desktop PID ${app.pid}`);

  const keychainSecret = `sk-mniu-packaged-${randomUUID()}`;
  const providerResponse = await fetch("http://127.0.0.1:7318/v1/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app: "codex",
      name: "Packaged Keychain Verification",
      kind: "openai_compatible",
      apiFormat: "openai_chat",
      baseUrl: "http://127.0.0.1:9/v1",
      defaultModel: "verification-model",
      apiKey: keychainSecret
    })
  });
  if (providerResponse.status !== 201) {
    throw new Error(`packaged provider creation failed: ${providerResponse.status} ${await providerResponse.text()}`);
  }
  const provider = await providerResponse.json();
  if (provider.apiKeyRef?.type !== "keychain" || !provider.apiKeyRef.ref?.startsWith("keychain:")) {
    throw new Error(`packaged provider did not use Keychain: ${JSON.stringify(provider)}`);
  }
  keychainAccount = Buffer.from(provider.apiKeyRef.ref.slice("keychain:".length), "base64url").toString("utf8");
  const storedSecret = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "dev.muniu.secrets", "-a", keychainAccount, "-w", keychainPath],
    { encoding: "utf8" }
  ).replace(/\r?\n$/, "");
  if (storedSecret !== keychainSecret) throw new Error("packaged daemon Keychain readback did not match");

  const deepLinkPayload = Buffer.from(
    JSON.stringify({
      provider: {
        app: "codex",
        name: "Packaged Deep Link Verification",
        kind: "openai_compatible",
        apiFormat: "openai_chat",
        baseUrl: "https://example.invalid/v1",
        defaultModel: "verification-model"
      }
    }),
    "utf8"
  ).toString("base64url");
  execFileSync("open", ["-a", appPath, `mniu://import/provider?payload=${deepLinkPayload}`]);
  const deepLinkAudit = await waitForDeepLinkPreview(
    path.join(home, ".mniu", "deeplink-imports", "last-preview.json")
  );
  if (deepLinkAudit.kind !== "providers" || deepLinkAudit.wouldImportCount !== 1) {
    throw new Error(
      `packaged deep link did not produce the expected preview: ${JSON.stringify(deepLinkAudit)}`
    );
  }
  if (app.exitCode !== null || app.signalCode !== null) {
    throw new Error("packaged desktop exited while handling mniu:// deep link");
  }

  const deleteResponse = await fetch(`http://127.0.0.1:7318/v1/providers/${provider.id}`, {
    method: "DELETE"
  });
  if (deleteResponse.status !== 204) {
    throw new Error(`packaged provider deletion failed: ${deleteResponse.status} ${await deleteResponse.text()}`);
  }
  if (keychainItemExists(keychainAccount)) {
    throw new Error("packaged provider deletion left its Keychain secret behind");
  }
  keychainAccount = "";

  const exit = waitForExit(app);
  app.kill("SIGTERM");
  await exit;
  await waitForShutdown(daemonPid);
  console.log(
    `packaged macOS app lifecycle passed: app=${app.pid}, daemon=${daemonPid}, backend=${health.secretVaultBackend}`
  );
} catch (error) {
  if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
} finally {
  if (keychainAccount) {
    try {
      execFileSync("/usr/bin/security", [
        "delete-generic-password",
        "-s",
        "dev.muniu.secrets",
        "-a",
        keychainAccount,
        keychainPath
      ]);
    } catch {
      // Best-effort cleanup after a failed verification.
    }
  }
  try {
    execFileSync("/usr/bin/security", ["delete-keychain", keychainPath]);
  } catch {
    // The temporary keychain may already be gone after an early failure.
  }
  rmSync(home, { recursive: true, force: true });
}

function assertArchitectures(filePath, expected) {
  const actual = execFileSync("lipo", ["-archs", filePath], { encoding: "utf8" }).trim().split(/\s+/).sort();
  if (actual.join(",") !== [...expected].sort().join(",")) {
    throw new Error(`unexpected architectures for ${filePath}: ${actual.join(", ")}`);
  }
}

function verifyDmgContents() {
  const mountPath = mkdtempSync(path.join(tmpdir(), "mniu-dmg-mount-"));
  execFileSync("hdiutil", ["attach", dmgPath, "-readonly", "-nobrowse", "-noverify", "-mountpoint", mountPath]);
  try {
    const requiredFiles = [
      path.join(mountPath, "木牛.app"),
      path.join(mountPath, ".background/background.png"),
      path.join(mountPath, ".DS_Store"),
      path.join(mountPath, "安装说明.txt"),
    ];
    for (const filePath of requiredFiles) {
      if (!existsSync(filePath) || statSync(filePath).size <= 0) {
        throw new Error(`packaged DMG is missing ${filePath}`);
      }
    }
    const applicationsLink = path.join(mountPath, "Applications");
    if (!lstatSync(applicationsLink).isSymbolicLink()) {
      throw new Error("packaged DMG Applications entry is not a symbolic link");
    }
    const guide = readFileSync(path.join(mountPath, "安装说明.txt"), "utf8");
    if (!guide.includes("Applications") || !guide.includes("Developer ID Application")) {
      throw new Error("packaged DMG installation guide is incomplete");
    }
  } finally {
    execFileSync("hdiutil", ["detach", mountPath]);
    rmSync(mountPath, { recursive: true, force: true });
  }
}

function listenerPid() {
  try {
    return execFileSync("lsof", ["-tiTCP:7318", "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function childDaemonPid(parentPid) {
  try {
    return Number.parseInt(
      execFileSync("pgrep", ["-P", String(parentPid), "-f", "mn-api-(aarch64|x86_64)-apple-darwin"], {
        encoding: "utf8"
      }).trim().split("\n")[0],
      10
    );
  } catch {
    return 0;
  }
}

function keychainItemExists(account) {
  try {
    execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "dev.muniu.secrets", "-a", account, keychainPath],
      { stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(appProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
      throw new Error(`desktop exited before daemon health check: ${appProcess.exitCode ?? appProcess.signalCode}`);
    }
    try {
      const response = await fetch("http://127.0.0.1:7318/healthz");
      if (response.ok) return response.json();
    } catch {
      // The packaged daemon needs a short startup window.
    }
    await delay(100);
  }
  throw new Error("packaged daemon health check timed out");
}

async function waitForExit(appProcess) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("desktop did not exit after SIGTERM")), 20_000);
    appProcess.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function waitForShutdown(daemonPid) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    let daemonAlive = true;
    try {
      process.kill(daemonPid, 0);
    } catch {
      daemonAlive = false;
    }
    if (!daemonAlive && !listenerPid()) return;
    await delay(100);
  }
  throw new Error(`managed daemon ${daemonPid} or port 7318 survived desktop exit`);
}

async function waitForDeepLinkPreview(auditPath) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(auditPath, "utf8"));
    } catch {
      await delay(100);
    }
  }
  throw new Error(`packaged deep link preview audit was not written: ${auditPath}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
