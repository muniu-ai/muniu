import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const sourcePath = join(desktopDir, "src", "App.tsx");
const tauriSourcePath = join(desktopDir, "src-tauri", "src", "lib.rs");
const source = await readFile(sourcePath, "utf8");
const tauriSource = await readFile(tauriSourcePath, "utf8");

const checks = [
  {
    label: "imports getCurrentWindow from Tauri window API",
    pattern: /import \{ getCurrentWindow \} from "@tauri-apps\/api\/window";/
  },
  {
    label: "keeps latest desktop settings in a ref",
    pattern: /desktopSettingsRef\.current = desktopSettings;/
  },
  {
    label: "registers a Tauri close-request listener",
    pattern: /getCurrentWindow\(\)[\s\S]*?\.onCloseRequested\(/
  },
  {
    label: "uses latest closeBehavior inside the close handler",
    pattern: /desktopSettingsRef\.current\.closeBehavior/
  },
  {
    label: "quit behavior allows the native close request",
    pattern: /if \(closeBehavior === "quit"\) return;[\s\S]*?event\.preventDefault\(\);/
  },
  {
    label: "tray hides while lightweight destroys the current window",
    pattern: /if \(closeBehavior === "lightweight"\) \{[\s\S]*?enterDesktopLightweightMode\(\)[\s\S]*?currentWindow\.destroy\(\)[\s\S]*?return;[\s\S]*?\}[\s\S]*?await currentWindow\.hide\(\);/
  },
  {
    label: "removes the close-request listener on unmount",
    pattern: /unlisten\?\.\(\);/
  },
  {
    label: "registers a native lightweight command",
    pattern: /enter_lightweight_mode[\s\S]*?window\.destroy\(\);/,
    source: tauriSource
  },
  {
    label: "tray open recreates a destroyed main window",
    pattern: /show_or_recreate_main_window[\s\S]*?WebviewWindowBuilder::from_config[\s\S]*?\.build\(\)/,
    source: tauriSource
  },
  {
    label: "tray lightweight destroys instead of hides the main window",
    pattern: /"light_mode"[\s\S]*?window\.destroy\(\);/,
    source: tauriSource
  }
];

const failures = checks.filter((check) => !check.pattern.test(check.source ?? source));
if (failures.length > 0) {
  throw new Error(
    [
      "Desktop close behavior source verification failed:",
      ...failures.map((failure) => `- ${failure.label}`)
    ].join("\n")
  );
}

console.log(JSON.stringify({ ok: true, sourcePath, tauriSourcePath, checks: checks.length }, null, 2));
