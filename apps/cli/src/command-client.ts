// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

const DEFAULT_API_URL = "http://127.0.0.1:7318";

export class CliApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: string
  ) {
    super(`API request failed (${statusCode}): ${body}`);
    this.name = "CliApiError";
  }
}

async function apiUrl(): Promise<string> {
  if (process.env.MN_API_URL) return process.env.MN_API_URL.replace(/\/$/u, "");
  try {
    const config = JSON.parse(await readFile(".mn/config.json", "utf8")) as {
      apiUrl?: unknown;
    };
    if (typeof config.apiUrl === "string" && config.apiUrl.trim()) {
      return config.apiUrl.replace(/\/$/u, "");
    }
  } catch {
    // The API's loopback default remains authoritative when no project exists.
  }
  return DEFAULT_API_URL;
}

export async function requestJson<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`${await apiUrl()}${path}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(process.env.MN_API_TOKEN
        ? { authorization: `Bearer ${process.env.MN_API_TOKEN}` }
        : {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  if (!response.ok) throw new CliApiError(response.status, await response.text());
  return await response.json() as T;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}
