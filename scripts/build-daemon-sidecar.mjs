import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const rootDir = process.cwd();
const binariesDir = path.join(rootDir, "apps/desktop-mac/src-tauri/binaries");
const buildDir = path.join(binariesDir, ".build");
const outDir = path.join(buildDir, "out");
const bundlePath = path.join(buildDir, "mn-api.cjs");
const pkgBin = path.join(rootDir, "node_modules/.bin/pkg");
const arm64Path = path.join(binariesDir, "mn-api-aarch64-apple-darwin");
const x64Path = path.join(binariesDir, "mn-api-x86_64-apple-darwin");
const universalPath = path.join(binariesDir, "mn-api-universal-apple-darwin");

await ensureNativeImageBindings();

execFileSync(process.execPath, [
  path.join(rootDir, "scripts/build-descriptor-lock-helper.mjs"),
  "--desktop"
], { cwd: rootDir, stdio: "inherit" });

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "apps/api/src/sidecar.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // Keep the native image decoder as a package boundary so pkg can collect
  // and extract the architecture-specific .node binding for each target.
  external: ["@napi-rs/image"],
  define: {
    "import.meta.url": "__mnBundleImportMetaUrl"
  },
  banner: {
    js: "const __mnBundleImportMetaUrl = require('node:url').pathToFileURL(__filename).href;"
  },
  sourcemap: false,
  logLevel: "info"
});

execFileSync(
  pkgBin,
  [
    bundlePath,
    "--targets",
    "node22-macos-arm64,node22-macos-x64",
    "--out-path",
    outDir,
    "--compress",
    "GZip"
  ],
  { cwd: rootDir, stdio: "inherit" }
);

cpSync(path.join(outDir, "mn-api-arm64"), arm64Path);
cpSync(path.join(outDir, "mn-api-x64"), x64Path);
writeFileSync(
  universalPath,
  `#!/bin/sh
set -eu

case "$(uname -m)" in
  arm64) target="mn-api-aarch64-apple-darwin" ;;
  x86_64) target="mn-api-x86_64-apple-darwin" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 64 ;;
esac

launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for candidate in "$launcher_dir/$target" "$launcher_dir/../Resources/$target"; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done

echo "Packaged daemon binary not found: $target" >&2
exit 66
`,
  "utf8"
);
execFileSync("chmod", ["755", arm64Path, x64Path, universalPath]);
execFileSync("lipo", [arm64Path, "-verify_arch", "arm64"]);
execFileSync("lipo", [x64Path, "-verify_arch", "x86_64"]);
execFileSync("codesign", ["--verify", "--strict", arm64Path]);
execFileSync("codesign", ["--verify", "--strict", x64Path]);

await smokeSidecar(universalPath);
await smokeSidecar(x64Path, "x86_64");
await smokePackagedEventWriter(universalPath);
rmSync(buildDir, { recursive: true, force: true });
console.log(`daemon sidecars ready: ${arm64Path}, ${x64Path}, ${universalPath}`);

async function smokeSidecar(binaryPath, architecture) {
  const port = await freePort();
  const mniuRoot = await mkdtemp(path.join(tmpdir(), "mniu-sidecar-smoke-"));
  const child = spawn(
    architecture === undefined ? binaryPath : "arch",
    architecture === undefined ? [] : [`-${architecture}`, binaryPath],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        MN_API_HOST: "127.0.0.1",
        MN_API_PORT: String(port),
        MN_MNIU_ROOT: mniuRoot,
        MN_DESKTOP_PACKAGED: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  try {
    const health = await waitForHealth(port, child);
    if (health.service !== "mn-api" || health.secretVaultBackend !== "keychain") {
      throw new Error(`unexpected sidecar health: ${JSON.stringify(health)}`);
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(mniuRoot, { recursive: true, force: true });
  }
}

async function ensureNativeImageBindings() {
  const lock = JSON.parse(readFileSync(path.join(rootDir, "package-lock.json"), "utf8"));
  for (const [packageName, bindingName] of [
    ["@napi-rs/image-darwin-arm64", "image.darwin-arm64.node"],
    ["@napi-rs/image-darwin-x64", "image.darwin-x64.node"]
  ]) {
    const target = path.join(rootDir, "node_modules", ...packageName.split("/"));
    const binding = path.join(target, bindingName);
    if (existsSync(binding)) {
      if (!lstatSync(binding).isFile()) throw new Error(`${packageName} binding is not a regular file`);
      continue;
    }
    if (existsSync(target)) {
      throw new Error(`${packageName} is incomplete; reinstall dependencies before building sidecars`);
    }
    const record = lock.packages?.[`node_modules/${packageName}`];
    if (!record || typeof record.version !== "string"
      || typeof record.resolved !== "string"
      || !record.resolved.startsWith("https://registry.npmjs.org/")
      || typeof record.integrity !== "string"
      || !record.integrity.startsWith("sha512-")) {
      throw new Error(`${packageName} is not pinned to an npm SHA-512 artifact`);
    }
    const response = await fetch(record.resolved);
    if (!response.ok) throw new Error(`failed to fetch ${packageName}: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.byteLength === 0 || archive.byteLength > 64 * 1024 * 1024) {
      throw new Error(`${packageName} archive exceeds its build-time size bound`);
    }
    const actualIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    if (actualIntegrity !== record.integrity) throw new Error(`${packageName} archive integrity mismatch`);
    const archivePath = path.join(tmpdir(), `${packageName.split("/").at(-1)}-${randomUUID()}.tgz`);
    const staging = `${target}.tmp-${randomUUID()}`;
    try {
      writeFileSync(archivePath, archive, { mode: 0o600 });
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      execFileSync("tar", ["-xzf", archivePath, "-C", staging, "--strip-components=1"]);
      const stagedPackage = JSON.parse(readFileSync(path.join(staging, "package.json"), "utf8"));
      const stagedBinding = path.join(staging, bindingName);
      if (stagedPackage.name !== packageName || stagedPackage.version !== record.version
        || !existsSync(stagedBinding) || !lstatSync(stagedBinding).isFile()) {
        throw new Error(`${packageName} archive contents do not match the lock file`);
      }
      renameSync(staging, target);
    } finally {
      rmSync(archivePath, { force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

async function smokePackagedEventWriter(binaryPath) {
  const smokeRoot = await mkdtemp(path.join(tmpdir(), "mniu-event-writer-smoke-"));
  const eventPath = path.join(smokeRoot, "events.jsonl");
  const lockPath = path.join(smokeRoot, "writer.lock");
  const eventFd = openSync(eventPath, "w+");
  const lockFd = openSync(lockPath, "w+");
  const nonce = randomUUID();
  const child = spawn(binaryPath, ["--mn-agent-session-event-writer", "3", "4", nonce], {
    cwd: rootDir,
    env: { ...process.env, MN_DESKTOP_PACKAGED: "1" },
    stdio: ["pipe", "pipe", "pipe", eventFd, lockFd]
  });
  const messages = createMessageReader(child);
  let output = "";
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  try {
    const ready = await messages.next();
    if (ready.nonce !== nonce || ready.status !== "ready" || ready.pid !== child.pid) {
      throw new Error(`unexpected event writer handshake: ${JSON.stringify(ready)}`);
    }

    const line = `${JSON.stringify({ smoke: "packaged-event-writer" })}\n`;
    await writeWriterRequest(child, messages, nonce, { operation: "append", line });
    await writeWriterRequest(child, messages, nonce, { operation: "close" });
    child.stdin.end();
    const result = await waitForChildExit(child);
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(`event writer exited abnormally (code=${String(result.code)}, signal=${String(result.signal)})`);
    }
    if (readFileSync(eventPath, "utf8") !== line) {
      throw new Error("packaged event writer did not persist the expected record");
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    closeSync(eventFd);
    closeSync(lockFd);
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

async function writeWriterRequest(child, messages, nonce, fields) {
  const requestId = randomUUID();
  child.stdin.write(`${JSON.stringify({ nonce, requestId, ...fields })}\n`);
  const response = await messages.next();
  if (response.nonce !== nonce || response.requestId !== requestId || response.status !== "ok") {
    throw new Error(`unexpected event writer acknowledgement: ${JSON.stringify(response)}`);
  }
}

function createMessageReader(child) {
  const queued = [];
  const pending = [];
  let buffer = "";
  let failure;

  const fail = (error) => {
    if (failure !== undefined) return;
    failure = error;
    while (pending.length > 0) pending.shift().reject(error);
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(frame);
        const waiter = pending.shift();
        if (waiter === undefined) queued.push(message);
        else waiter.resolve(message);
      } catch {
        fail(new Error("event writer returned invalid JSON"));
      }
      newline = buffer.indexOf("\n");
    }
  });
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    if (pending.length > 0) {
      fail(new Error(`event writer exited before replying (code=${String(code)}, signal=${String(signal)})`));
    }
  });

  return {
    next() {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (failure !== undefined) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("event writer response timed out")), 5_000);
        pending.push({
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    }
  };
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`sidecar exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return response.json();
    } catch {
      // The packaged daemon needs a short startup window.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("sidecar health check timed out");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}
