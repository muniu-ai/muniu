const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [^-\r\n]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [^-\r\n]+)? PRIVATE KEY-----|$)/giu;
const ASSIGNMENT_PREFIX_PATTERN = /(^|[\s{[(,;&?])((?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|(?:(?:\\u\{[0-9a-f]{1,6}\}|\\u[0-9a-f]{4}|\\x[0-9a-f]{2})|[^\s:=：＝,;&?{}\[\]<>"']){1,256}))(\s*(?::|=|：|＝|%3d)\s*)/gimu;
const URI_CREDENTIAL_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/giu;
const STANDALONE_AUTH_PATTERN = /(\b(?:bearer|basic)\s+)[a-z0-9._~+/=-]{8,}/giu;
const JWT_PATTERN = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]+\.[a-z0-9_-]+\b/giu;
const COMMON_CREDENTIAL_PATTERN = /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[a-z0-9]{20,})\b/giu;
const PROVIDER_KEY_PATTERN = /\b(?:sk-(?:proj-|ant-)?[a-z0-9._-]{8,})\b/giu;
const REDACTED = "[REDACTED]";
const SAFE_REDACTION_MARKERS = Object.freeze([
  REDACTED,
  "[REDACTED PRIVATE KEY]",
  "[REDACTED UNSAFE JSON]"
]);

const SENSITIVE_KEY_TERMS = Object.freeze([
  "apikey",
  "accesstoken",
  "authtoken",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "secretaccesskey",
  "sessiontoken",
  "token",
  "口令",
  "密码",
  "密钥",
  "凭证",
  "令牌"
] as const);

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decodeKeyRepresentations(value: string): string {
  let decoded = value
    .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)));
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function normalizedCredentialKey(value: string): string {
  const unquoted = value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
  return decodeKeyRepresentations(unquoted)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{Cc}\p{Cf}\p{M}\p{P}\p{S}\p{Z}]/gu, "");
}

function isSensitivePropertyKey(value: string): boolean {
  const normalized = normalizedCredentialKey(value);
  return SENSITIVE_KEY_TERMS.some((term) =>
    normalized === term || normalized.endsWith(term)
  );
}

function redactAssignments(content: string): string {
  ASSIGNMENT_PREFIX_PATTERN.lastIndex = 0;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = ASSIGNMENT_PREFIX_PATTERN.exec(content)) !== null) {
    const key = match[2];
    if (key === undefined || !isSensitivePropertyKey(key)) continue;
    const valueStart = ASSIGNMENT_PREFIX_PATTERN.lastIndex;
    const existingMarker = SAFE_REDACTION_MARKERS.find((marker) =>
      content.startsWith(marker, valueStart)
    );
    if (existingMarker !== undefined) {
      const end = valueStart + existingMarker.length;
      output += content.slice(cursor, end);
      cursor = end;
      ASSIGNMENT_PREFIX_PATTERN.lastIndex = end;
      continue;
    }
    const quote = content[valueStart];
    let end = valueStart;
    if (quote === '"' || quote === "'") {
      end += 1;
      let closed = false;
      while (end < content.length && content[end] !== "\r" && content[end] !== "\n") {
        const character = content[end];
        if (character === "\\") {
          end += 2;
          continue;
        }
        if (character === quote) {
          closed = true;
          break;
        }
        end += 1;
      }
      output += `${content.slice(cursor, valueStart + 1)}${REDACTED}${quote}`;
      cursor = closed ? end + 1 : end;
      ASSIGNMENT_PREFIX_PATTERN.lastIndex = cursor;
      continue;
    }
    while (
      end < content.length &&
      content[end] !== "\r" &&
      content[end] !== "\n" &&
      !",;&}]".includes(content[end]!)
    ) {
      end += 1;
    }
    output += `${content.slice(cursor, valueStart)}${REDACTED}`;
    cursor = end;
    ASSIGNMENT_PREFIX_PATTERN.lastIndex = end;
  }
  return `${output}${content.slice(cursor)}`;
}

export function redactContextContent(content: string): string {
  const trimmed = content.trim();
  const first = trimmed[0];
  if (
    (first !== undefined && "{[\"-0123456789".includes(first)) ||
    /^(?:true|false|null)/u.test(trimmed)
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      let sanitized: unknown;
      try {
        sanitized = redactSensitiveValue(parsed);
      } catch {
        sanitized = "[REDACTED UNSAFE JSON]";
      }
      const encoded = JSON.stringify(sanitized);
      const start = content.indexOf(trimmed);
      return `${content.slice(0, start)}${encoded}${content.slice(start + trimmed.length)}`;
    } catch {
      // Not a complete JSON document; use conservative textual patterns below.
    }
  }
  return redactAssignments(content.replace(PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]"))
    .replace(URI_CREDENTIAL_PATTERN, "$1[REDACTED]@")
    .replace(STANDALONE_AUTH_PATTERN, "$1[REDACTED]")
    .replace(JWT_PATTERN, REDACTED)
    .replace(COMMON_CREDENTIAL_PATTERN, REDACTED)
    .replace(PROVIDER_KEY_PATTERN, REDACTED);
}

function cloneJsonValue(
  value: unknown,
  redactStrings: boolean,
  path: string,
  ancestors: Set<object>,
  sensitiveProperty: boolean
): unknown {
  if (sensitiveProperty) return REDACTED;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return redactStrings ? redactContextContent(value) : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} cannot contain ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a circular reference`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path} cannot contain sparse arrays`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`${path}[${index}] must be an enumerable data property`);
        }
        result.push(
          cloneJsonValue(
            descriptor.value,
            redactStrings,
            `${path}[${index}]`,
            ancestors,
            false
          )
        );
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (
          typeof key === "symbol" ||
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= value.length
        ) {
          throw new TypeError(`${path} cannot contain named or symbol array properties`);
        }
      }
      return result;
    }

    if (!isPlainObject(value)) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") throw new TypeError(`${path} cannot contain symbol keys`);
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`${path}.${key} is unsafe`);
      }
      if (redactStrings && containsSensitiveAssignmentInKey(key)) {
        throw new TypeError(`${path} contains a sensitive property key`);
      }
      if (redactStrings && isSensitivePropertyKey(key)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`${path}.${key} must be an enumerable data property`);
        }
        result[key] = REDACTED;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`);
      }
      result[key] = cloneJsonValue(
        descriptor.value,
        redactStrings,
        `${path}.${key}`,
        ancestors,
        false
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function containsSensitiveAssignmentInKey(key: string): boolean {
  const redacted = redactContextContent(key);
  return redacted !== key && redacted.includes("[REDACTED");
}

/** Strict JSON snapshot that rejects accessors, class instances and cycles. */
export function cloneSafeJsonValue<T>(value: T): T {
  return cloneJsonValue(value, false, "$", new Set<object>(), false) as T;
}

/** Strict JSON snapshot with recursive key-aware and string-aware redaction. */
export function redactSensitiveValue<T>(value: T): T {
  return cloneJsonValue(value, true, "$", new Set<object>(), false) as T;
}

export function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function safeRedactedErrorMessage(error: unknown): string {
  try {
    if (typeof error === "string") return redactContextContent(error);
    if (error instanceof Error) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
        return redactContextContent(descriptor.value);
      }
      return "Context source raised an Error";
    }
  } catch {
    return "Context source failure could not be inspected safely";
  }
  return "Context source raised a non-Error value";
}
