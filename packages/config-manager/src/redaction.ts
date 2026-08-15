import { parseToml, stringifyToml, type TomlValue } from "./toml.js";

const redactionMarker = "****";

export function redactConfigContent(input: string): string {
  if (!input) return input;

  const jsonResult = redactJson(input);
  if (jsonResult !== undefined) return jsonResult;

  try {
    const document = parseToml(input);
    let changed = false;
    for (const [key, value] of Object.entries(document.values)) {
      const redacted = redactValue(value, isSensitiveConfigKey(key));
      if (redacted.changed) {
        document.values[key] = redacted.value as TomlValue;
        changed = true;
      }
    }
    for (const [tableName, table] of Object.entries(document.tables)) {
      const tableSensitive = tableName.split(".").some(isSensitiveConfigKey);
      for (const [key, value] of Object.entries(table)) {
        const redacted = redactValue(value, tableSensitive || isSensitiveConfigKey(key));
        if (redacted.changed) {
          table[key] = redacted.value as TomlValue;
          changed = true;
        }
      }
    }
    return changed ? stringifyToml(document) : input;
  } catch {
    return redactUnstructuredConfig(input);
  }
}

function redactJson(input: string): string | undefined {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;

  try {
    const parsed = JSON.parse(input) as unknown;
    const redacted = redactValue(parsed, false);
    if (!redacted.changed) return input;
    const indent = detectJsonIndent(input);
    const trailingNewline = input.endsWith("\n") ? "\n" : "";
    return `${JSON.stringify(redacted.value, null, indent)}${trailingNewline}`;
  } catch {
    return undefined;
  }
}

function redactValue(
  value: unknown,
  parentSensitive: boolean
): { value: unknown; changed: boolean } {
  if (value === null || value === undefined || value instanceof Date) {
    return parentSensitive && value !== null && value !== undefined
      ? { value: redactionMarker, changed: true }
      : { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const redacted = value.map((item) => {
      const result = redactValue(item, parentSensitive);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? redacted : value, changed };
  }

  if (typeof value === "object") {
    let changed = false;
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = redactValue(item, parentSensitive || isSensitiveConfigKey(key));
      redacted[key] = result.value;
      changed ||= result.changed;
    }
    return { value: changed ? redacted : value, changed };
  }

  return parentSensitive
    ? { value: redactionMarker, changed: value !== redactionMarker }
    : { value, changed: false };
}

function isSensitiveConfigKey(key: string): boolean {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  if (
    [
      "auth",
      "authorization",
      "bearer",
      "credential",
      "credentials",
      "password",
      "passphrase",
      "secret",
      "secrets",
      "token",
      "tokens",
      "api_key",
      "apikey",
      "private_key"
    ].includes(normalized)
  ) {
    return true;
  }
  return /(?:^|_)(?:access_token|refresh_token|id_token|bearer_token|auth_token|token|secret|password|passphrase|api_key|apikey|private_key|credential|credentials|authorization)$/.test(
    normalized
  );
}

function detectJsonIndent(input: string): string | number {
  const match = input.match(/\n([\t ]+)\S/);
  return match?.[1] ?? 2;
}

function redactUnstructuredConfig(input: string): string {
  const assignment = /(?:^|[\n,{])\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9_.-]+))\s*[:=]/g;
  for (const match of input.matchAll(assignment)) {
    const key = match[1] ?? match[2] ?? match[3] ?? "";
    if (key.split(".").some(isSensitiveConfigKey) || isSensitiveConfigKey(key)) {
      return input.endsWith("\n")
        ? "[REDACTED INVALID CONFIG]\n"
        : "[REDACTED INVALID CONFIG]";
    }
  }
  return input.replace(/\b(Bearer\s+)[^\s"']+/gi, `$1${redactionMarker}`);
}
