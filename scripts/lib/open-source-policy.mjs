import parseSpdxExpression from "spdx-expression-parse";

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
    const match = pattern.exec(text);
    if (match && !allowedFakeSecretLocations.get(match[0])?.has(relativePath)) {
      findings.push({ label, path: relativePath });
    }
  }
  return findings;
}

export function findUnpinnedWorkflowActions(files) {
  const failures = [];
  for (const file of files) {
    if (!/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/u.test(file.path)) continue;
    for (const line of file.text.split("\n")) {
      if (!line.includes("uses:")) continue;
      const reference = line.match(/uses:\s+([^\s#]+)/u)?.[1];
      if (reference?.startsWith("./") || reference?.startsWith("docker://")) continue;
      const revision = reference?.match(/@([^@]+)$/u)?.[1];
      if (!revision || !/^[0-9a-f]{40}$/u.test(revision)) {
        failures.push(`${file.path}: ${line.trim()}`);
      }
    }
  }
  return failures;
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
