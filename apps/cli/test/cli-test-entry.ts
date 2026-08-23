// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

import { controlOperationForMethod, type JsonValue } from "@mn/app-server-protocol";

import { installCliControlTransportForTest } from "../src/app-server-client.js";

process.env.NODE_ENV = "test";

async function apiUrl(): Promise<string> {
  if (process.env.MN_API_URL) return process.env.MN_API_URL.replace(/\/$/u, "");
  try {
    const config = JSON.parse(await readFile(".mn/config.json", "utf8")) as { apiUrl?: unknown };
    if (typeof config.apiUrl === "string" && config.apiUrl.trim()) return config.apiUrl.replace(/\/$/u, "");
  } catch {
    // The local test fixture may exercise commands that do not need the control transport.
  }
  return "http://127.0.0.1:7318";
}

function requestPath(template: string, values: Readonly<Record<string, JsonValue>> | undefined): string {
  return template.replace(/\{([^{}]+)\}/gu, (_match, key: string) => {
    const value = values?.[key];
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`missing path value: ${key}`);
    return encodeURIComponent(String(value));
  });
}

installCliControlTransportForTest(async ({ method, params }) => {
  const operation = controlOperationForMethod(method);
  if (!operation) throw new Error(`unknown control method: ${method}`);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === null || typeof item === "object") throw new Error(`invalid query value: ${key}`);
      query.append(key, String(item));
    }
  }
  const suffix = query.size > 0 ? `?${query}` : "";
  const response = await fetch(`${await apiUrl()}${requestPath(operation.path, params.path)}${suffix}`, {
    method: operation.verb.toUpperCase(),
    headers: {
      accept: "application/json",
      ...(params.body === undefined ? {} : { "content-type": "application/json" }),
      ...(params.idempotencyKey === undefined ? {} : { "idempotency-key": params.idempotencyKey }),
      ...(process.env.MN_API_TOKEN ? { authorization: `Bearer ${process.env.MN_API_TOKEN}` } : {})
    },
    ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) })
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.status === 204 || response.headers.get("content-length") === "0"
    ? null
    : response.json();
});

await import("../src/index.js");
