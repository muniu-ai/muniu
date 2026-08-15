import path from "node:path";

import parseSpdxExpression from "spdx-expression-parse";
import { parseDocument } from "yaml";

const fakeSecretFixturePath = "scripts/test/fixtures/allowed-fake-secrets.txt";
const allowedFakeSecretLocations = new Map([
  [
    "AKIA0000000000000000",
    new Set([
      ".gitleaks.toml",
      fakeSecretFixturePath,
      "scripts/lib/open-source-policy.mjs",
      "scripts/test/open-source-policy.test.mjs",
      "scripts/verify-open-source-baseline.mjs"
    ])
  ],
  [
    "sk-test-not-a-real-secret",
    new Set([".gitleaks.toml", fakeSecretFixturePath, "scripts/lib/open-source-policy.mjs"])
  ]
]);

const secretPatterns = [
  {
    label: "private key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u
  },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  {
    label: "model API key",
    pattern: /\b(?:sk-[A-Za-z0-9]{32,}|sk-(?:ant|proj)-[A-Za-z0-9_-]{40,})\b/u
  }
];

const allowedLicenseTerms = new Set([
  "0BSD",
  "Apache-2.0",
  "Artistic-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "BSL-1.0",
  "CC0-1.0",
  "CC-BY-3.0",
  "CDLA-Permissive-2.0",
  "ISC",
  "LLVM-exception",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Python-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "WTFPL",
  "Zlib"
]);

const deepSeekHarnessCommit = "47f943859bef60e4160492346772ded9b24f765a";
const agentCoverageCommand = [
  "npm run test:coverage -w @mn/agent-protocol",
  "npm run test:coverage -w @mn/agent-session",
  "npm run test:coverage -w @mn/agent-llm",
  "npm run test:coverage -w @mn/agent-tools",
  "npm run test:coverage -w @mn/agent-kernel",
  "npm run test:coverage -w @mn/agent-host"
].join(" && ");

export function findSecretFindings(content, relativePath) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  const findings = [];
  for (const { label, pattern } of secretPatterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const matches = text.matchAll(new RegExp(pattern.source, flags));
    for (const match of matches) {
      if (allowedFakeSecretLocations.get(match[0])?.has(relativePath)) continue;
      findings.push({ label, path: relativePath });
    }
  }
  return findings;
}

export function findUnpinnedWorkflowActions(files) {
  const failures = [];
  for (const file of files) {
    if (!/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/u.test(file.path)) continue;
    let workflow;
    try {
      const document = parseDocument(file.text, {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true
      });
      if (document.errors.length > 0 || document.warnings.length > 0) {
        const issue = document.errors[0] ?? document.warnings[0];
        throw issue;
      }
      workflow = document.toJS({ maxAliasCount: 0 });
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
      failures.push(`${file.path}: invalid YAML (${detail})`);
      continue;
    }

    const references = [];
    collectWorkflowUses(workflow, references, new WeakSet());
    for (const reference of references) {
      if (isPinnedWorkflowReference(reference)) continue;
      failures.push(`${file.path}: ${formatWorkflowReference(reference)}`);
    }
  }
  return failures;
}

export function validateAgentCoverageGate({ rootPackage, ciWorkflow }) {
  const failures = [];
  if (rootPackage?.scripts?.["test:coverage:agent"] !== agentCoverageCommand) {
    failures.push("test:coverage:agent must serially run all six agent package coverage suites");
  }

  let workflow;
  try {
    const document = parseDocument(ciWorkflow, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw document.errors[0] ?? document.warnings[0];
    }
    workflow = document.toJS({ maxAliasCount: 0 });
  } catch {
    workflow = undefined;
  }
  const nodeSteps = workflow?.jobs?.node?.steps;
  const hasCoverageStep = Array.isArray(nodeSteps) && nodeSteps.some((step) => {
    return step !== null
      && typeof step === "object"
      && step.run === "npm run test:coverage:agent";
  });
  if (!hasCoverageStep) {
    failures.push("CI node job must explicitly run npm run test:coverage:agent");
  }
  return failures;
}

function collectWorkflowUses(value, references, seen) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("workflow YAML contains a cyclic value");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectWorkflowUses(entry, references, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "uses") references.push(entry);
    collectWorkflowUses(entry, references, seen);
  }
}

function isPinnedWorkflowReference(reference) {
  if (typeof reference !== "string" || reference.length === 0) return false;
  if (reference.startsWith("./")) {
    const relative = reference.slice(2);
    if (!relative || relative.includes("\\") || relative.includes("\0")) return false;
    const normalized = path.posix.normalize(relative);
    return normalized !== ".." && !normalized.startsWith("../") && !path.posix.isAbsolute(normalized);
  }
  if (reference.startsWith("docker://")) {
    return /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/u.test(reference);
  }
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u.test(
    reference
  );
}

function formatWorkflowReference(reference) {
  return typeof reference === "string" ? reference : `<non-string uses: ${typeof reference}>`;
}

export function validateAttributionPolicy({ notice, thirdParty, provenance }) {
  const hasImportedFiles = !/^files:\s*\[\s*\]\s*$/mu.test(provenance);
  if (!hasImportedFiles) {
    if (/DeepSeek Harness|deepseek-ai\/deepseek-harness/iu.test(notice)) {
      throw new Error("NOTICE must not claim DeepSeek Harness attribution before files are imported");
    }
    if (!/no DeepSeek Harness source file is copied/iu.test(thirdParty)) {
      throw new Error("THIRD_PARTY_NOTICES must state that no DeepSeek Harness source is currently copied");
    }
  }
  return true;
}

function workspaceManifestForSource(sourcePath) {
  const match = /^(packages|apps)\/([^/]+)\//u.exec(sourcePath);
  return match === null ? undefined : `${match[1]}/${match[2]}/package.json`;
}

function hasDeepSeekCopyrightNotice(text) {
  return /^[ \t]*(?:\/\*+|\*|\/\/|#)?[ \t]*Copyright \(c\) 2026 DeepSeek[ \t]*(?:\*\/)?[ \t]*$/mu.test(text);
}

function hasMitSpdxNotice(text) {
  return /^[ \t]*(?:\/\*+|\*|\/\/|#)?[ \t]*SPDX-License-Identifier:[ \t]*MIT[ \t]*(?:\*\/)?[ \t]*$/mu.test(text);
}

function parseProvenanceFiles(provenance, failures) {
  let value;
  try {
    const document = parseDocument(provenance, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw document.errors[0] ?? document.warnings[0];
    }
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    failures.push(`provenance is invalid YAML: ${error instanceof Error ? error.message.split("\n", 1)[0] : String(error)}`);
    return [];
  }
  if (!value || typeof value !== "object" || !Array.isArray(value.files)) {
    failures.push("provenance files must be an array");
    return [];
  }
  return value.files;
}

/** Enforce Apache-by-default and exact, provenance-backed DeepSeek MIT exceptions. */
export function validateWorkspaceSourceLicenses({ manifests, provenance, sourceFiles }) {
  const failures = [];
  const entries = parseProvenanceFiles(provenance, failures);
  const sources = new Map(sourceFiles.map((file) => [file.path, file.text]));
  const listed = new Map();
  const mixedManifests = new Set();

  for (const [index, rawEntry] of entries.entries()) {
    const label = `provenance files[${index}]`;
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      failures.push(`${label} must be an object`);
      continue;
    }
    const entry = rawEntry;
    if (typeof entry.localPath !== "string" || entry.localPath.length === 0) {
      failures.push(`${label} localPath must not be empty`);
      continue;
    }
    if (listed.has(entry.localPath)) failures.push(`${label} duplicates localPath ${entry.localPath}`);
    listed.set(entry.localPath, entry);
    if (entry.mode !== "copied" && entry.mode !== "adapted") {
      failures.push(`${label} mode must be copied or adapted`);
    }
    if (typeof entry.summary !== "string" || entry.summary.trim().length === 0) {
      failures.push(`${label} summary must not be empty`);
    }
    if (typeof entry.upstreamPath !== "string" || entry.upstreamPath.length === 0) {
      failures.push(`${label} upstreamPath must not be empty`);
    }
    const manifestPath = workspaceManifestForSource(entry.localPath);
    if (manifestPath === undefined) failures.push(`${label} localPath must belong to a workspace`);
    else mixedManifests.add(manifestPath);

    const text = sources.get(entry.localPath);
    if (text === undefined) {
      failures.push(`${entry.localPath} listed in provenance is missing`);
      continue;
    }
    if (!text.includes(deepSeekHarnessCommit)) {
      failures.push(`${entry.localPath} notice is missing the approved upstream commit`);
    }
    if (typeof entry.upstreamPath !== "string" || !text.includes(`Original path: ${entry.upstreamPath}`)) {
      failures.push(`${entry.localPath} notice is missing the original upstream path`);
    }
    if (!hasDeepSeekCopyrightNotice(text)) {
      failures.push(`${entry.localPath} notice is missing the DeepSeek copyright`);
    }
    if (!hasMitSpdxNotice(text)) {
      failures.push(`${entry.localPath} notice is missing SPDX-License-Identifier: MIT`);
    }
  }

  for (const file of sourceFiles) {
    if (!hasDeepSeekCopyrightNotice(file.text)) continue;
    if (!hasMitSpdxNotice(file.text)) continue;
    if (!listed.has(file.path)) failures.push(`${file.path} has an unlisted DeepSeek MIT notice`);
  }

  const manifestPaths = new Set(manifests.map((manifest) => manifest.path));
  for (const manifestPath of mixedManifests) {
    if (!manifestPaths.has(manifestPath)) failures.push(`${manifestPath} is missing for a listed MIT source`);
  }
  for (const manifest of manifests) {
    if (mixedManifests.has(manifest.path)) {
      if (manifest.license !== "Apache-2.0 AND MIT") {
        failures.push(`${manifest.path} must declare Apache-2.0 AND MIT for listed MIT source files`);
      }
    } else if (manifest.license !== "Apache-2.0") {
      const suffix = manifest.license === "Apache-2.0 AND MIT" ? " because it has no listed MIT source" : "";
      failures.push(`${manifest.path} must declare Apache-2.0${suffix}`);
    }
  }
  return failures.sort();
}

export function validateLicenseExpression(expression) {
  if (typeof expression !== "string" || expression.trim().length === 0) return false;
  try {
    const normalized = expression
      .replace(/\s*\/\s*/gu, " OR ")
      .replace(/\s+or\s+/giu, " OR ")
      .replace(/\s+and\s+/giu, " AND ");
    return licenseNodeAllowed(parseSpdxExpression(normalized));
  } catch {
    return false;
  }
}

export function validateLicenseInventory(packages) {
  return packages
    .filter((entry) => !validateLicenseExpression(entry.license ?? ""))
    .map((entry) => `${entry.name}: ${entry.license || "UNKNOWN"}`)
    .sort();
}

function licenseNodeAllowed(node) {
  if (node.license) {
    return (
      allowedLicenseTerms.has(node.license) &&
      (!node.exception || allowedLicenseTerms.has(node.exception))
    );
  }
  if (node.conjunction === "and") {
    return licenseNodeAllowed(node.left) && licenseNodeAllowed(node.right);
  }
  if (node.conjunction === "or") {
    return licenseNodeAllowed(node.left) || licenseNodeAllowed(node.right);
  }
  return false;
}
