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
