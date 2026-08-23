// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  CLIENT_METHODS,
  METHOD_SCHEMAS,
  SERVER_NOTIFICATION_METHODS,
  SERVER_NOTIFICATION_SCHEMAS,
  SERVER_REQUEST_METHODS,
  SERVER_REQUEST_SCHEMAS
} from "../dist/index.js";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = path.join(directory, "schema");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, nested]) => [key, stable(nested)])
    );
  }
  return value;
}

function schemaFor(schema, name) {
  return stable(zodToJsonSchema(schema, {
    name,
    target: "jsonSchema7",
    $refStrategy: "root",
    errorMessages: false,
    markdownDescription: false
  }));
}

function identifier(method) {
  return method
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join("");
}

const bundle = stable({
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Muniu app-server v2 core stable subset",
  protocolVersion: "2",
  compatibility: {
    protocol: "app-server-v2",
    baselineCommit: "99660ab3c7b861c916e467581fa9b8723504d66b",
    methodSet: "core-stable-subset"
  },
  methods: Object.fromEntries(CLIENT_METHODS.map((method) => [method, {
    params: schemaFor(METHOD_SCHEMAS[method].params, `${identifier(method)}Params`),
    result: schemaFor(METHOD_SCHEMAS[method].result, `${identifier(method)}Result`)
  }])),
  serverRequests: Object.fromEntries(SERVER_REQUEST_METHODS.map((method) => [method, {
    params: schemaFor(SERVER_REQUEST_SCHEMAS[method].params, `${identifier(method)}Params`),
    result: schemaFor(SERVER_REQUEST_SCHEMAS[method].result, `${identifier(method)}Result`)
  }])),
  notifications: Object.fromEntries(SERVER_NOTIFICATION_METHODS.map((method) => [
    method,
    schemaFor(SERVER_NOTIFICATION_SCHEMAS[method], `${identifier(method)}Notification`)
  ]))
});

const catalog = stable({
  protocolVersion: "2",
  baselineCommit: "99660ab3c7b861c916e467581fa9b8723504d66b",
  methodSet: "core-stable-subset",
  methods: CLIENT_METHODS,
  serverRequests: SERVER_REQUEST_METHODS,
  notifications: SERVER_NOTIFICATION_METHODS
});

const outputs = new Map([
  [path.join(schemaDirectory, "app-server-v2.json"), `${JSON.stringify(bundle, null, 2)}\n`],
  [path.join(schemaDirectory, "method-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`]
]);

await mkdir(schemaDirectory, { recursive: true });
let drift = false;
for (const [outputPath, content] of outputs) {
  if (process.argv.includes("--check")) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== content) {
      process.stderr.write(`Generated app-server schema differs: ${path.relative(directory, outputPath)}\n`);
      drift = true;
    }
  } else {
    await writeFile(outputPath, content, "utf8");
  }
}
if (drift) process.exitCode = 1;
