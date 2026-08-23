// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateOpenAiCodexProvenance } from "./lib/openai-codex-provenance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provenancePath = path.join(root, "docs/upstream-provenance/openai-codex.yaml");
const failures = validateOpenAiCodexProvenance(readFileSync(provenancePath, "utf8"));

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`OpenAI Codex provenance check failed: ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("OpenAI Codex provenance check passed.\n");
}
