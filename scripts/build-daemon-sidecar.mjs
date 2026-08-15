import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, "apps/api/src/sidecar.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
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
