// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { parseDocument } from "yaml";

export const OPENAI_CODEX_BASELINE_COMMIT = "99660ab3c7b861c916e467581fa9b8723504d66b";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UPSTREAM_PATH_PATTERN = /^codex-rs\/app-server-protocol\/[A-Za-z0-9._/-]+$/u;
const ADAPTATION_PATH_PATTERN = /^codex-rs\/(?:app-server-protocol|app-server|core|state|mcp-server|skills)\/[A-Za-z0-9._/-]+$/u;

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function computeSchemaFixtureDigest(fixtures) {
  const canonical = fixtures
    .map((fixture) => `${fixture.upstreamPath}\0${fixture.sha256}\n`)
    .sort()
    .join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function validateOpenAiCodexProvenance(source) {
  const failures = [];
  const document = parseDocument(source, { maxAliasCount: 0, prettyErrors: false });
  if (document.errors.length > 0) {
    return [`OpenAI Codex provenance is invalid YAML: ${document.errors[0].message.split("\n", 1)[0]}`];
  }

  const root = asRecord(document.toJS({ maxAliasCount: 0 }));
  if (!root) return ["OpenAI Codex provenance must be an object"];
  if (root.schemaVersion !== 1) failures.push("OpenAI Codex provenance schemaVersion must be 1");

  const upstream = asRecord(root.upstream);
  if (upstream?.name !== "OpenAI Codex") failures.push("upstream.name must be OpenAI Codex");
  if (upstream?.repository !== "https://github.com/openai/codex") {
    failures.push("upstream.repository must be the canonical OpenAI Codex repository");
  }
  if (upstream?.commit !== OPENAI_CODEX_BASELINE_COMMIT) {
    failures.push(`upstream.commit must pin fixed commit ${OPENAI_CODEX_BASELINE_COMMIT}`);
  }
  if (upstream?.license !== "Apache-2.0") failures.push("upstream.license must be Apache-2.0");

  const compatibility = asRecord(root.compatibility);
  if (compatibility?.protocol !== "app-server-v2") {
    failures.push("compatibility.protocol must be app-server-v2");
  }
  if (compatibility?.methodSet !== "core-stable-subset") {
    failures.push("compatibility.methodSet must be core-stable-subset");
  }
  if (compatibility?.implementation !== "clean-room-typescript-boundary") {
    failures.push("compatibility.implementation must be clean-room-typescript-boundary");
  }

  const schemaFixtures = asRecord(root.schemaFixtures);
  const fixtures = schemaFixtures?.files;
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    failures.push("schemaFixtures.files must be a non-empty array");
  } else {
    const normalized = [];
    const paths = new Set();
    fixtures.forEach((value, index) => {
      const fixture = asRecord(value);
      const label = `schemaFixtures.files[${index}]`;
      if (!fixture) {
        failures.push(`${label} must be an object`);
        return;
      }
      if (typeof fixture.upstreamPath !== "string" || !UPSTREAM_PATH_PATTERN.test(fixture.upstreamPath)) {
        failures.push(`${label}.upstreamPath must be inside codex-rs/app-server-protocol`);
      } else if (paths.has(fixture.upstreamPath)) {
        failures.push(`duplicate schema fixture path: ${fixture.upstreamPath}`);
      } else {
        paths.add(fixture.upstreamPath);
      }
      if (typeof fixture.sha256 !== "string" || !SHA256_PATTERN.test(fixture.sha256)) {
        failures.push(`${label}.sha256 must be a lowercase SHA-256 digest`);
      }
      if (typeof fixture.upstreamPath === "string" && typeof fixture.sha256 === "string") {
        normalized.push({ upstreamPath: fixture.upstreamPath, sha256: fixture.sha256 });
      }
    });
    const aggregate = computeSchemaFixtureDigest(normalized);
    if (schemaFixtures?.aggregateSha256 !== aggregate) {
      failures.push(`schema fixture aggregate digest must be ${aggregate}`);
    }
  }

  if (!Array.isArray(root.adaptations)) {
    failures.push("adaptations must be an array");
  } else {
    const localPaths = new Set();
    root.adaptations.forEach((value, index) => {
      const adaptation = asRecord(value);
      const label = `adaptations[${index}]`;
      if (!adaptation) {
        failures.push(`${label} must be an object`);
        return;
      }
      if (typeof adaptation.upstreamPath !== "string" || !ADAPTATION_PATH_PATTERN.test(adaptation.upstreamPath)) {
        failures.push(`${label}.upstreamPath is outside the reviewed Codex source scope`);
      }
      if (typeof adaptation.localPath !== "string" || adaptation.localPath.startsWith("/") || adaptation.localPath.includes("..")) {
        failures.push(`${label}.localPath must be a repository-relative path`);
      } else if (localPaths.has(adaptation.localPath)) {
        failures.push(`${label}.localPath duplicates ${adaptation.localPath}`);
      } else {
        localPaths.add(adaptation.localPath);
      }
      if (adaptation.upstreamCommit !== OPENAI_CODEX_BASELINE_COMMIT) {
        failures.push(`${label}.upstreamCommit must be ${OPENAI_CODEX_BASELINE_COMMIT}`);
      }
      if (adaptation.mode !== "copied" && adaptation.mode !== "adapted") {
        failures.push(`${label}.mode must be copied or adapted`);
      }
      if (typeof adaptation.summary !== "string" || adaptation.summary.trim().length === 0) {
        failures.push(`${label}.summary must explain the adaptation`);
      }
    });
  }

  return failures;
}
