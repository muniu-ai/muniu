// SPDX-License-Identifier: Apache-2.0
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "assets/brand/muniu-logo.png");
const tauri = path.join(root, "apps/desktop-mac/src-tauri");
const svg = path.join(tauri, "app-icon.svg");
const image = readFileSync(source).toString("base64");

writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#fff"/>
  <image x="96" y="108" width="832" height="832" xlink:href="data:image/png;base64,${image}"/>
</svg>
`);
execFileSync(process.execPath, [path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), "icon", svg, "--output", path.join(tauri, "icons")], { cwd: root, stdio: "inherit" });
for (const directory of ["apps/desktop-mac/public/brand", "docs/public/brand"]) {
  const destination = path.join(root, directory);
  mkdirSync(destination, { recursive: true });
  copyFileSync(source, path.join(destination, "muniu-logo.png"));
  copyFileSync(path.join(tauri, "icons/128x128@2x.png"), path.join(destination, "app-icon.png"));
}
console.log("品牌 Logo 与白底应用图标已同步");
