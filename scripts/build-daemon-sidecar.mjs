import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  closeSync,
  cpSync,
  mkdirSync,
  openSync,
  readFileSync,
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
await smokePackagedEventWriter(universalPath);
rmSync(buildDir, { recursive: true, force: true });
console.log(`daemon sidecars ready: ${arm64Path}, ${x64Path}, ${universalPath}`);

async function smokeSidecar(binaryPath) {
  const port = await freePort();
  const mniuRoot = await mkdtemp(path.join(tmpdir(), "mniu-sidecar-smoke-"));
  const child = spawn(binaryPath, [], {
    cwd: rootDir,
    env: {
      ...process.env,
      MN_API_HOST: "127.0.0.1",
      MN_API_PORT: String(port),
      MN_MNIU_ROOT: mniuRoot,
      MN_DESKTOP_PACKAGED: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
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
