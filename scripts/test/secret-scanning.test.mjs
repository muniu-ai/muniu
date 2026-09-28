// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = readFileSync(new URL("../../.gitleaks.toml", import.meta.url), "utf8");
const blocks = config.split("[[allowlists]]").slice(1);
const reviewed = [
  { commit: "466793846bf3296ae8cf3b44ea6d4f0ae6d39f88", path: "docs/industry-delivery/integration-results.json",
    kind: "operation-digest", lines: [121, 169, 186, 207, 228, 245, 266, 287, 304, 325, 346, 392, 409, 430, 451, 478] },
  { commit: "ad18e593c2a95ba92c32c5af1d01837373004bbe", path: "docs/industry-delivery/integration-results.json",
    kind: "operation-digest", lines: [522, 545, 572, 795] },
  { commit: "89eb29591a6f9294faa3aa379debb47a6d6bbc3c", path: "apps/host/src/execution-metering.ts",
    kind: "count-basis", lines: [16] },
  { commit: "89eb29591a6f9294faa3aa379debb47a6d6bbc3c", path: "apps/worker/src/model-invoker.ts",
    kind: "count-basis", lines: [96] },
  { commit: "89eb29591a6f9294faa3aa379debb47a6d6bbc3c", path: "apps/worker/test/model-usage.test.ts",
    kind: "count-basis", lines: [80] },
  { commit: "049203831723206ef08402c2bcd4f9b80cb7b58f", path: "docker-compose.enterprise.yml",
    kind: "fixture-hmac", lines: [14] },
  { commit: "049203831723206ef08402c2bcd4f9b80cb7b58f", path: "deploy/kind/enterprise-fixture.yaml",
    kind: "fixture-hmac", lines: [70] },
  { commit: "958a4612eb98def38ced61c43ff82c9c3aac5e83", path: "apps/api/src/migrateAppServerV3.ts",
    kind: "import-name", lines: [8] }
];

function array(block, field) {
  const body = new RegExp(`^${field}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m").exec(block)?.[1] ?? "";
  return [...body.matchAll(/'''([^']*)'''|"([^"]*)"/gu)].map(match => match[1] ?? match[2]);
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function reviewedValues(entry) {
  const source = execFileSync("git", ["show", `${entry.commit}:${entry.path}`], {
    cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024
  }).split("\n");
  return [...new Set(entry.lines.map(number => {
    const line = source[number - 1];
    let value;
    if (entry.kind === "operation-digest") value = /"operationKey": "([a-f0-9]{64})"/u.exec(line)?.[1];
    if (entry.kind === "count-basis") value = /"([a-z0-9_]+)"/u.exec(line)?.[1];
    if (entry.kind === "fixture-hmac") {
      value = /:\s*([A-Za-z0-9+/=]+)\s*$/u.exec(line)?.[1];
      assert.ok(value && /^enterprise-(e2e|kind)-hmac-fixture-key-02$/u.test(Buffer.from(value, "base64").toString()),
        `${entry.path}: reviewed fixture identity changed`);
    }
    if (entry.kind === "import-name") value = line.trim();
    assert.ok(value, `${entry.path}:${number}: reviewed source shape changed`);
    return value;
  }))];
}

test("gitleaks keeps the default rules and exact commit-bound reviewed exceptions", () => {
  assert.ok(/\[extend\]\s+useDefault = true/u.test(config), "default rules must remain enabled");
  for (const entry of reviewed) {
    const expectedPath = `^${escape(entry.path)}$`;
    const matches = blocks.filter(block => array(block, "commits").includes(entry.commit)
      && array(block, "paths").includes(expectedPath));
    const label = `${entry.commit.slice(0, 8)}:${entry.path}`;
    assert.equal(matches.length, 1, `${label}: missing or duplicate reviewed exception`);
    const block = matches[0];
    assert.ok(/^condition = "AND"$/mu.test(block), `${label}: dimensions must be combined`);
    assert.ok(array(block, "targetRules").length === 1 && array(block, "targetRules")[0] === "generic-api-key",
      `${label}: rule scope changed`);
    assert.ok(array(block, "commits").length === 1 && array(block, "commits")[0] === entry.commit,
      `${label}: commit scope changed`);
    assert.ok(array(block, "paths").length === 1 && array(block, "paths")[0] === expectedPath,
      `${label}: path scope changed`);
    const actual = array(block, "regexes").sort();
    const expected = reviewedValues(entry).map(value => `^${escape(value)}$`).sort();
    assert.ok(JSON.stringify(actual) === JSON.stringify(expected), `${label}: exact value scope changed`);
  }
});
