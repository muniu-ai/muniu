// SPDX-License-Identifier: Apache-2.0

import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

async function markdownFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["node_modules", ".git", "vendor", "dist", "dist-test"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await markdownFiles(path));
    else if (extname(entry.name) === ".md") result.push(path);
  }
  return result;
}

let failed = false;
for (const file of await markdownFiles(process.cwd())) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].replace(/^<|>$/gu, "").split("#")[0];
    if (!target || /^(?:https?:|mailto:|#)/u.test(target)) continue;
    try { await access(resolve(dirname(file), decodeURIComponent(target))); }
    catch {
      console.error(`${file}: broken link ${match[1]}`);
      failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
