#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(rootDir, "apps/desktop-mac/src-tauri/binaries");
const outputArgument = process.argv.find((argument) => argument.startsWith("--output-dir="));
const binariesDir = outputArgument ? path.resolve(outputArgument.slice("--output-dir=".length)) : defaultOutput;
const smoke = process.argv.includes("--smoke");
const unknown = process.argv.slice(2).filter((argument) => argument !== "--smoke" && !argument.startsWith("--output-dir="));
if (unknown.length > 0) throw new Error(`未知参数：${unknown.join(", ")}`);

const buildDir = realpathSync(await mkdtemp(path.join(tmpdir(), "mn-host-sidecar-")));
const bundlePath = path.join(buildDir, "mn-host.cjs");
const entryPath = path.join(buildDir, "mn-host-entry.ts");
const pdfChildBundlePath = path.join(buildDir, "pdf-extraction-child.cjs");
const packageConfigPath = path.join(buildDir, "package.json");
const packagedDir = path.join(buildDir, "pkg");
const pkgBin = path.join(rootDir, "node_modules/.bin/pkg");
const arm64Path = path.join(binariesDir, "mn-host-aarch64-apple-darwin");
const x64Path = path.join(binariesDir, "mn-host-x86_64-apple-darwin");
const universalPath = path.join(binariesDir, "mn-host-universal-apple-darwin");
const manifestPath = path.join(binariesDir, "mn-host-build.json");

try {
  if (process.platform !== "darwin") throw new Error("mn-host macOS sidecar 只能在 macOS 构建");
  mkdirSync(packagedDir, { recursive: true });
  mkdirSync(binariesDir, { recursive: true });
  writeFileSync(entryPath, `import { extractDocument } from ${JSON.stringify(path.join(rootDir, "apps/host/src/document-extraction.ts"))};
if (process.argv.includes("--mn-pdf-smoke")) {
  extractDocument({ fileName: "smoke.pdf", mediaType: "application/pdf", bytes: Buffer.from(${JSON.stringify(smokePdfBytes().toString("base64"))}, "base64") })
    .then(result => process.stdout.write(JSON.stringify(result)))
    .catch(error => { process.stderr.write("Packaged PDF extraction failed: " + (error?.code ?? "UNKNOWN") + " " + (error?.message ?? "") + "\\n"); process.exitCode = 1; });
} else { void import(${JSON.stringify(path.join(rootDir, "apps/host/src/main.ts"))}); }
`);
  await build({
    entryPoints: [path.join(rootDir, "apps/host/src/document-extraction-pdf-worker.ts")],
    outfile: pdfChildBundlePath, bundle: true, platform: "node", format: "cjs", target: "node22",
    sourcemap: false, legalComments: "eof",
    define: { "import.meta.url": "__mnHostImportMetaUrl" },
    banner: { js: "const __mnHostImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    logLevel: "info",
  });
  await build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    legalComments: "eof",
    define: { "import.meta.url": "__mnHostImportMetaUrl" },
    banner: { js: "const __mnHostImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    logLevel: "info",
  });
  writeFileSync(packageConfigPath, JSON.stringify({ private: true, pkg: { assets: ["pdf-extraction-child.cjs"] } }));
  execFileSync(pkgBin, [
    bundlePath,
    "--config", packageConfigPath,
    "--targets", "node22-macos-arm64,node22-macos-x64",
    "--out-path", packagedDir,
    "--compress", "GZip",
  ], {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "0", TZ: "UTC" },
  });

  cpSync(path.join(packagedDir, "mn-host-arm64"), arm64Path);
  cpSync(path.join(packagedDir, "mn-host-x64"), x64Path);
  execFileSync("chmod", ["755", arm64Path, x64Path]);
  execFileSync("lipo", [arm64Path, "-verify_arch", "arm64"]);
  execFileSync("lipo", [x64Path, "-verify_arch", "x86_64"]);
  execFileSync("lipo", ["-create", arm64Path, x64Path, "-output", universalPath]);
  execFileSync("chmod", ["755", universalPath]);
  execFileSync("codesign", ["--force", "--sign", "-", universalPath]);
  relocatePkgPayloads(universalPath, { arm64: arm64Path, x64: x64Path });
  execFileSync("codesign", ["--force", "--sign", "-", universalPath]);
  execFileSync("lipo", [universalPath, "-verify_arch", "arm64", "x86_64"]);
  execFileSync("codesign", ["--verify", "--strict", universalPath]);
  const manifest = {
    schemaVersion: 1,
    service: "mn-host",
    source: "apps/host/src/main.ts",
    node: "22",
    targets: {
      "aarch64-apple-darwin": sha256(arm64Path),
      "x86_64-apple-darwin": sha256(x64Path),
      "universal-apple-darwin": sha256(universalPath),
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  if (smoke) {
    const extracted = JSON.parse(execFileSync(universalPath, ["--mn-pdf-smoke"], {
      timeout: 15_000, encoding: "utf8", env: { TZ: "UTC" },
    }));
    if (extracted.status !== "complete" || extracted.blocks[0]?.text !== "packaged PDF extraction") throw new Error("打包后的 PDF 子进程提取结果不符");
    process.stdout.write("打包 PDF 子进程提取验证通过\n");
    await smokeCurrentArchitecture(universalPath);
  }
  process.stdout.write(`mn-host sidecar 已生成：${binariesDir}\n`);
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function relocatePkgPayloads(universal, thinBinaries) {
  const detail = execFileSync("lipo", ["-detailed_info", universal], { encoding: "utf8" });
  const output = readFileSync(universal);
  const labels = { arm64: "arm64", x64: "x86_64" };
  for (const arch of ["arm64", "x64"]) {
    const section = detail.slice(detail.indexOf(`architecture ${labels[arch]}`));
    const offsetMatch = section.match(/\n\s*offset (\d+)/u);
    if (!offsetMatch) throw new Error(`无法读取 universal ${labels[arch]} slice 偏移`);
    const sliceOffset = Number(offsetMatch[1]);
    const thin = readFileSync(thinBinaries[arch]);
    for (const placeholderOffset of pkgPositionFields(thin)) {
      const fieldLength = "// PRELUDE_POSITION //".length;
      const field = thin.subarray(placeholderOffset, placeholderOffset + fieldLength).toString("ascii");
      const originalPosition = Number.parseInt(field, 10);
      if (!Number.isSafeInteger(originalPosition) || !/^\d+\s+$/u.test(field)) {
        throw new Error(`pkg ${labels[arch]} payload 偏移无效`);
      }
      const relocated = String(originalPosition + sliceOffset).padEnd(fieldLength, " ");
      if (relocated.length !== fieldLength) throw new Error(`pkg ${labels[arch]} 偏移超出预留空间`);
      Buffer.from(relocated, "ascii").copy(output, sliceOffset + placeholderOffset);
    }
  }
  writeFileSync(universal, output, { mode: 0o755 });
}

function pkgPositionFields(binary) {
  const fieldLength = "// PRELUDE_POSITION //".length;
  const matches = [...binary.toString("latin1").matchAll(/\d{7,20} +/gu)]
    .filter((match) => match[0].length === fieldLength)
    .map((match) => match.index);
  const pairs = matches.filter((offset) => matches.includes(offset + 72));
  if (pairs.length !== 1) throw new Error("pkg runtime payload/prelude 偏移字段不存在或不唯一");
  return [pairs[0], pairs[0] + 72];
}

async function smokeCurrentArchitecture(binary) {
  if (process.platform !== "darwin") throw new Error("--smoke 只支持 macOS");
  const stateRoot = await mkdtemp(path.join(tmpdir(), "mn-host-smoke-"));
  const child = spawn(binary, [], {
    cwd: rootDir,
    env: { ...process.env, MN_V2_STATE_ROOT: stateRoot, MN_DESKTOP_PARENT_PID: String(process.pid) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`mn-host 提前退出：${output}`);
      try {
        const response = await fetch("http://127.0.0.1:7318/v2/health");
        const body = await response.json();
        if (response.ok && body?.data?.core?.status === "healthy") {
          await smokePdfExtraction();
          return;
        }
      } catch {
        // Host startup is bounded by the deadline above.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`mn-host 健康检查超时：${output}`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

async function smokePdfExtraction() {
  const send = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:7318${route}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": `pdf-smoke-${route}` }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`PDF sidecar smoke ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result.data;
  };
  const workspace = await send("/v2/workspaces", { name: "PDF 打包验证", viewMode: "business", pluginIds: [] });
  const assets = await send("/v2/assets", { workspaceId: workspace.id, expectedStreamVersion: 0,
    attachments: [{ fileName: "smoke.pdf", mediaType: "application/pdf", protected: true, contentBase64: smokePdfBytes().toString("base64") }] });
  const extracted = await send(`/v2/assets/${assets[0].id}/extraction`);
  if (extracted.status !== "complete" || extracted.blocks[0]?.text !== "packaged PDF extraction") throw new Error("打包后的 PDF 提取结果不符");
}

function smokePdfBytes() {
  const stream = "BT /F1 12 Tf 40 700 Td (packaged PDF extraction) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.7\n"; const offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
