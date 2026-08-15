import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
for (const name of ["version", "archive", "signature", "output"]) {
  if (!options[name]) throw new Error(`missing required --${name}`);
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.version)) {
  throw new Error(`invalid updater version: ${options.version}`);
}
for (const filePath of [options.archive, options.signature]) {
  if (!existsSync(filePath)) throw new Error(`updater input does not exist: ${filePath}`);
}

const signature = readFileSync(options.signature, "utf8").trim();
if (!signature || signature.includes("REPLACE_WITH")) {
  throw new Error("updater signature is empty or still a placeholder");
}
const baseUrl = (options["base-url"] ?? `https://github.com/muniu-ai/muniu/releases/download/v${options.version}`)
  .replace(/\/$/, "");
const archiveUrl = `${baseUrl}/${encodeURIComponent(path.basename(options.archive))}`;
const platform = { signature, url: archiveUrl };
const manifest = {
  version: options.version,
  notes: options.notes ?? `Muniu ${options.version}`,
  pub_date: options["pub-date"] ?? new Date().toISOString(),
  platforms: {
    "darwin-aarch64": platform,
    "darwin-x86_64": platform,
  },
};

writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`macOS updater manifest written to ${options.output}`);

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    parsed[token.slice(2)] = value;
    index += 1;
  }
  return parsed;
}
