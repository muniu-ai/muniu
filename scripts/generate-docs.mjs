// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";
import { stringify as stringifyYaml } from "yaml";
import { loadApiContract } from "./lib/api-contract.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");
const generatedFiles = new Map();
const generatedBlocks = [];

function fail(message) {
  throw new Error(`0.2 文档生成失败：${message}`);
}

function addBlock(path, id, body) {
  generatedBlocks.push({ path: join(root, path), id, body: body.trimEnd() });
}

function addFile(path, content) {
  generatedFiles.set(join(root, path), content.endsWith("\n") ? content : `${content}\n`);
}

function operationTable(operations) {
  return [
    "| 方法 | 路径 | operationId | 幂等键 | stream version |",
    "| --- | --- | --- | --- | --- |",
    ...operations.map((operation) => [
      `| \`${operation.method.toUpperCase()}\``,
      `\`${operation.path}\``,
      `\`${operation.operationId}\``,
      operation.mutation ? "必需" : "—",
      operation.versioned ? "必需 |" : "— |",
    ].join(" | ")),
  ].join("\n");
}
async function pluginCatalog() {
  const pluginRoot = join(root, "plugins");
  const entries = [];
  for (const directory of await readdir(pluginRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const manifestPath = join(pluginRoot, directory.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (manifest.version !== "0.2.0") fail(`${relative(root, manifestPath)} 版本不是 0.2.0`);
    const runner = directory.name.startsWith("runner-");
    entries.push({
      id: directory.name,
      packageName: manifest.name,
      version: manifest.version,
      kind: runner ? "Runner Adapter" : "产品插件",
      activation: runner ? "可选，必须显式选择" : "随应用提供，按工作区启用",
    });
  }
  entries.sort((left, right) => Number(left.kind !== "产品插件") - Number(right.kind !== "产品插件")
    || left.id.localeCompare(right.id));
  if (entries.length === 0) fail("plugins/ 中没有 0.2 插件包");
  return [
    "| 插件 ID | 包 | 版本 | 类型 | 启用方式 |",
    "| --- | --- | --- | --- | --- |",
    ...entries.map((entry) => `| \`${entry.id}\` | \`${entry.packageName}\` | \`${entry.version}\` | ${entry.kind} | ${entry.activation} |`),
  ].join("\n");
}

const { API_OPERATIONS_V2: operations, createOpenApiDocument } = await loadApiContract();
addBlock("docs/reference/api-routes.md", "contracts-routes", operationTable(operations));
addFile("docs/reference/openapi.yaml", stringifyYaml(createOpenApiDocument(), { lineWidth: 0 }));

const cliSource = await readFile(join(root, "apps/cli/src/index.ts"), "utf8");
const cliHelp = /const HELP = `([\s\S]*?)`;/u.exec(cliSource)?.[1];
if (!cliHelp) fail("无法从 apps/cli/src/index.ts 读取 HELP");
addBlock("docs/reference/cli.md", "cli-help", `\`\`\`text\n${cliHelp.trimEnd()}\n\`\`\``);
addBlock("docs/reference/plugins.md", "plugin-catalog", await pluginCatalog());

let stale = false;
for (const block of generatedBlocks) {
  const source = await readFile(block.path, "utf8");
  const start = `<!-- generated:${block.id}:start -->`;
  const end = `<!-- generated:${block.id}:end -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) fail(`${relative(root, block.path)} 缺少 ${block.id} marker`);
  const replacement = `${start}\n\n${block.body}\n\n${end}`;
  const expected = `${source.slice(0, startIndex)}${replacement}${source.slice(endIndex + end.length)}`;
  if (source === expected) continue;
  if (check) {
    console.error(`生成内容未更新：${relative(root, block.path)}#${block.id}`);
    stale = true;
  } else {
    await writeFile(block.path, expected, "utf8");
  }
}

for (const [path, expected] of generatedFiles) {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    // A missing generated file is reported as stale in check mode.
  }
  if (current === expected) continue;
  if (check) {
    console.error(`生成文件未更新：${relative(root, path)}`);
    stale = true;
  } else {
    await writeFile(path, expected, "utf8");
  }
}

if (stale) process.exitCode = 1;
