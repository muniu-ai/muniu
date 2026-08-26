// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageDirectory, "../..");
const openApiPath = path.join(repositoryRoot, "docs/reference/openapi.yaml");
const fixturePath = path.join(packageDirectory, "schema/legacy-openapi-operations.json");
const mappingPath = path.join(packageDirectory, "schema/control-operation-map.json");
const generatedPath = path.join(packageDirectory, "src/control-methods.generated.ts");

const METHOD_OVERRIDES = Object.freeze({
  "get /v1/domains": "muniu/domain/domains/get",
  "post /v1/domain-runs": "muniu/domain/runs/post",
  "get /v1/domain-runs/{id}": "muniu/domain/runs/byId/get",
  "get /v1/domain-runs/{id}/events": "muniu/domain/runs/byId/events/get",
  "post /v1/opc-records": "muniu/opc/records/post",
  "post /v1/opc-records/{id}/revisions": "muniu/opc/records/byId/revisions/post",
  "post /v1/opc-commitments/{id}/approve": "muniu/opc/commitments/byId/approve/post",
  "post /v1/opc-commitments/{id}/runs": "muniu/opc/commitments/byId/runs/post",
  "get /v1/attention-items": "muniu/attention/items/get",
  "post /v1/attention-items/{id}/decide": "muniu/attention/items/byId/decide/post",
  "post /v1/action-intents/{id}/decide": "muniu/action/intents/byId/decide/post",
  "post /v1/opc-deliveries/{id}/acceptances": "muniu/opc/deliveries/byId/acceptances/post",
  "post /v1/opc-settlements": "muniu/opc/settlements/post",
  "get /v1/domain-runs/{id}/evidence-export": "muniu/evidence/domainRuns/byId/export/get",
  "get /v1/business-packs": "muniu/extension/businessPacks/get",
  "post /v1/business-packs/{id}/enable": "muniu/extension/businessPacks/byId/enable/post",
  "post /v1/publications": "muniu/sync/publications/post",
  "get /v1/publication-receipts": "muniu/sync/receipts/get"
});

const DOMAIN_RULES = [
  ["modelCatalog", /\/model-catalog(?:\/|$)/u],
  ["approval", /\/(?:approvals|approve)(?:\/|$)/u],
  ["artifact", /\/(?:artifacts|attachments)(?:\/|$)/u],
  ["runJob", /^\/v1\/run-jobs(?:\/|$)/u],
  ["project", /^\/v1\/projects(?:\/|$)/u],
  ["task", /^\/v1\/tasks(?:\/|$)/u],
  ["run", /^\/v1\/(?:runs|agent-sessions|sessions)(?:\/|$)/u],
  ["provider", /^\/v1\/(?:providers|provider-usage|usage)(?:\/|$)/u],
  ["skillRegistry", /^\/v1\/skills(?:\/|$)/u],
  ["policy", /^\/v1\/(?:spec-sets|standard-packs|waivers)(?:\/|$)/u],
  ["evidence", /^\/v1\/(?:audit-events|eval-assets|learning-proposals|maturity-report|trace-graphs)(?:\/|$)/u],
  ["extension", /^\/v1\/(?:apps|mcp|runtime)(?:\/|$)/u],
  ["diagnostics", /^\/v1\/(?:system|proxy)(?:\/|$)/u],
  ["config", /^\/v1\/(?:capabilities|deep-links|harness-profiles|prompts|workflows)(?:\/|$)/u]
];

function parseOpenApi(source) {
  const operations = [];
  let currentPath;
  let currentVerb;
  for (const line of source.split(/\r?\n/u)) {
    const pathMatch = /^  (\/[^:]+):$/u.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentVerb = undefined;
      continue;
    }
    const verbMatch = /^    (get|post|put|patch|delete):$/u.exec(line);
    if (verbMatch) {
      currentVerb = verbMatch[1];
      continue;
    }
    const operationMatch = /^      operationId: (\S+)$/u.exec(line);
    if (operationMatch && currentPath && currentVerb) {
      operations.push({ operationId: operationMatch[1], path: currentPath, verb: currentVerb });
    }
  }
  return operations;
}

function domainFor(operation) {
  for (const [domain, pattern] of DOMAIN_RULES) {
    if (pattern.test(operation.path)) return domain;
  }
  throw new Error(`No muniu RPC domain for ${operation.verb.toUpperCase()} ${operation.path}`);
}

function lowerCamel(value) {
  const words = value.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  return words.map((word, index) => index === 0
    ? `${word[0]?.toLowerCase()}${word.slice(1)}`
    : `${word[0]?.toUpperCase()}${word.slice(1)}`).join("");
}

function methodFor(operation) {
  const override = METHOD_OVERRIDES[`${operation.verb} ${operation.path}`];
  if (override !== undefined) return override;
  const segments = operation.path.split("/").filter(Boolean).slice(1).map((segment) => {
    const parameter = /^\{([^}]+)\}$/u.exec(segment);
    return parameter ? `by${lowerCamel(parameter[1]).replace(/^./u, (value) => value.toUpperCase())}` : lowerCamel(segment);
  });
  return `muniu/${domainFor(operation)}/${segments.join("/")}/${operation.verb}`;
}

async function operationFixture() {
  const openApi = await readFile(openApiPath, "utf8").catch(() => undefined);
  if (openApi !== undefined) return parseOpenApi(openApi).filter((operation) => operation.path !== "/healthz");
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

const operations = await operationFixture();
const mapping = operations.map((operation) => ({ ...operation, method: methodFor(operation) }));
if (operations.length !== 167) throw new Error(`Expected 167 control operations, received ${operations.length}`);
if (new Set(mapping.map((entry) => entry.operationId)).size !== mapping.length) throw new Error("Duplicate OpenAPI operationId");
if (new Set(mapping.map((entry) => entry.method)).size !== mapping.length) throw new Error("Duplicate muniu RPC method");

const fixture = `${JSON.stringify(operations, null, 2)}\n`;
const mapped = `${JSON.stringify(mapping, null, 2)}\n`;
const generated = `// SPDX-License-Identifier: Apache-2.0\n\n` +
  `export const MUNIU_CONTROL_OPERATIONS = ${JSON.stringify(mapping, null, 2)} as const;\n`;
const outputs = new Map([[fixturePath, fixture], [mappingPath, mapped], [generatedPath, generated]]);
let drift = false;
for (const [outputPath, content] of outputs) {
  if (process.argv.includes("--check")) {
    if (await readFile(outputPath, "utf8").catch(() => "") !== content) {
      process.stderr.write(`Generated control RPC mapping differs: ${path.relative(packageDirectory, outputPath)}\n`);
      drift = true;
    }
  } else {
    await writeFile(outputPath, content, "utf8");
  }
}
if (drift) process.exitCode = 1;
