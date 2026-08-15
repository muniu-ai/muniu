// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";

import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export interface BusinessRedactionOptions {
  readonly businessRedaction?: boolean;
}

export type ProtectedJsonValue =
  | null
  | boolean
  | number
  | string
  | ProtectedJsonValue[]
  | { [key: string]: ProtectedJsonValue };

export const CREDENTIAL_MARKER = "[REDACTED CREDENTIAL]";
export const PHONE_MARKER = "[REDACTED PHONE]";
export const PRC_ID_MARKER = "[REDACTED PRC_ID]";
export const PRIVATE_KEY_MARKER = "[REDACTED PRIVATE KEY]";
export const UNSAFE_MARKER = "[REDACTED UNSAFE JSON]";

const SAFE_MARKERS = Object.freeze([
  CREDENTIAL_MARKER,
  PHONE_MARKER,
  PRC_ID_MARKER,
  PRIVATE_KEY_MARKER,
  UNSAFE_MARKER
]);

const MAX_TEXT_CODE_UNITS = 1_048_576;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_CODE_UNITS = 1_048_576;

const PRIVATE_KEY_PATTERN = /-----BEGIN ([^-\r\n]{0,64}PRIVATE KEY[^-\r\n]{0,64})-----[\s\S]*?(?:-----END \1-----|$)/giu;
const URI_CREDENTIAL_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]*@/giu;
const URI_MARKER_PREFIX_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)(\[REDACTED (?:CREDENTIAL|PRIVATE KEY|UNSAFE JSON)\])([^\s/@]+)@/giu;
const JWT_OR_JWE_PATTERN = /\beyJ[a-z0-9_-]{2,}(?:\.[a-z0-9_-]*){2,4}(?![a-z0-9_.-])/giu;
const AWS_KEY_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu;
const GITHUB_KEY_PATTERN = /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/giu;
const PROVIDER_KEY_PATTERN = /\bsk-(?:proj-|ant-)?[a-z0-9._-]{8,}\b/giu;
const E164_CANDIDATE_PATTERN = /(^|[^\p{L}\p{N}_+])(\+[1-9][0-9]{7,14})(?![\p{L}\p{N}_+])/gu;
const MAINLAND_MOBILE_CANDIDATE_PATTERN = /(^|[^\p{L}\p{N}_+])(1[0-9]{10})(?![\p{L}\p{N}_+])/gu;
const PRC_ID_CANDIDATE_PATTERN = /(^|[^\p{L}\p{N}_])([0-9]{17}[0-9Xx])(?![\p{L}\p{N}_])/gu;

const SENSITIVE_KEY_TERMS = Object.freeze([
  "apikey",
  "apisecret",
  "accesskeyid",
  "accesstoken",
  "authtoken",
  "authorization",
  "authorizationcode",
  "authcode",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "mfa",
  "mfasecret",
  "oauthcode",
  "otp",
  "passphrase",
  "passcode",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretaccesskey",
  "secretkey",
  "sessionid",
  "sessiontoken",
  "totp",
  "token",
  "口令",
  "密码",
  "密钥",
  "凭证",
  "令牌"
] as const);

const SAFE_METADATA_SUFFIXES = Object.freeze([
  "ref",
  "env",
  "digest",
  "hash",
  "usage",
  "count",
  "budget",
  "limit",
  "configured",
  "present"
] as const);

const ALWAYS_SENSITIVE_KEY_TERMS = Object.freeze([
  "apikeys",
  "apisecrets",
  "accesskeyids",
  "accesstokens",
  "authtokens",
  "bearertokens",
  "clientsecrets",
  "cookies",
  "credentials",
  "mfacodes",
  "otps",
  "passphrases",
  "passcodes",
  "passwords",
  "passwds",
  "privatekeys",
  "refreshtokens",
  "secretaccesskeys",
  "secretkeys",
  "secrets",
  "sessionids",
  "sessiontokens",
  "passwordconfirmation",
  "passwordconfirm",
  "passwordvalue",
  "clientsecretvalue",
  "privatekeyvalue",
  "secretvalue",
  "tokenvalue"
] as const);

const PRC_MAINLAND_PROVINCE_CODES = new Set([
  "11", "12", "13", "14", "15",
  "21", "22", "23",
  "31", "32", "33", "34", "35", "36", "37",
  "41", "42", "43", "44", "45", "46",
  "50", "51", "52", "53", "54",
  "61", "62", "63", "64", "65",
  "71"
]);
const PRC_HMT_RESIDENCE_CODES = new Set(["810000", "820000", "830000"]);
const PRC_ID_WEIGHTS = Object.freeze([7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]);
const PRC_ID_CHECKS = Object.freeze(["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface ProtectionState {
  codeUnits: number;
  nodes: number;
}

interface TextPatch {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

type CredentialKeyKind = "credential" | "numeric-token-metric" | "safe";
type CredentialMetadataKind = "ref" | "env" | "digest" | "number" | "boolean";

function resolveBusinessRedaction(options: BusinessRedactionOptions | undefined): boolean {
  if (options === undefined) return true;
  if (options === null || typeof options !== "object") {
    throw new TypeError("data protection options must be a plain object");
  }
  if (utilTypes.isProxy(options)) {
    throw new TypeError("data protection options cannot be a Proxy");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("data protection options must be a plain object");
  }
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => key !== "businessRedaction")) {
    throw new TypeError("businessRedaction is the only supported data protection option");
  }
  if (!Object.hasOwn(options, "businessRedaction")) return true;
  const descriptor = Object.getOwnPropertyDescriptor(options, "businessRedaction");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "boolean") {
    throw new TypeError("businessRedaction must be a boolean data property");
  }
  return descriptor.value;
}

function decodeKeyRepresentations(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 8; pass += 1) {
    const unicodeDecoded = decoded
      .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hex: string) => {
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          throw new RangeError("assignment key contains an invalid Unicode escape");
        }
        return String.fromCodePoint(codePoint);
      })
      .replace(/\\u([0-9a-f]{4})/giu, (_match, hex: string) => {
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          throw new RangeError("assignment key contains an invalid Unicode escape");
        }
        return String.fromCodePoint(codePoint);
      })
      .replace(/\\x([0-9a-f]{2})/giu, (_match, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)));
    let next: string;
    try {
      next = decodeURIComponent(unicodeDecoded);
    } catch {
      next = unicodeDecoded.replace(/%([0-7][0-9a-f])/giu, (_match, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)));
    }
    if (next === decoded) return decoded;
    if (pass === 7) {
      throw new RangeError("assignment key uses too many encoding layers");
    }
    decoded = next;
  }
  return decoded;
}

function normalizeCredentialKey(value: string): string {
  const unquoted = value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
  return decodeKeyRepresentations(unquoted)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{Cc}\p{Cf}\p{M}\p{P}\p{S}\p{Z}]/gu, "");
}

function isSensitiveNormalizedKey(value: string): boolean {
  if (value === "tokens" || value.endsWith("tokens")) return true;
  if (ALWAYS_SENSITIVE_KEY_TERMS.some((term) => value === term || value.endsWith(term))) {
    return true;
  }
  return SENSITIVE_KEY_TERMS.some((term) => value === term || value.endsWith(term));
}

function credentialMetadataKind(value: string): CredentialMetadataKind | undefined {
  const normalized = normalizeCredentialKey(value);
  const suffixes: ReadonlyArray<readonly [string, CredentialMetadataKind]> = [
    ["configured", "boolean"],
    ["present", "boolean"],
    ["digest", "digest"],
    ["budget", "number"],
    ["usage", "number"],
    ["count", "number"],
    ["limit", "number"],
    ["hash", "digest"],
    ["ref", "ref"],
    ["env", "env"]
  ];
  for (const [suffix, kind] of suffixes) {
    if (!normalized.endsWith(suffix)) continue;
    const base = normalized.slice(0, -suffix.length);
    return base.length > 0 && isSensitiveNormalizedKey(base) ? kind : undefined;
  }
  return undefined;
}

function credentialKeyKind(value: string): CredentialKeyKind {
  const normalized = normalizeCredentialKey(value);
  if (normalized.length === 0) return "safe";
  if (ALWAYS_SENSITIVE_KEY_TERMS.some((term) =>
    normalized === term || normalized.endsWith(term)
  )) return "credential";
  if (credentialMetadataKind(value) !== undefined) return "safe";
  if (normalized === "tokens" || normalized.endsWith("tokens")) {
    return "numeric-token-metric";
  }
  if (SAFE_METADATA_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return "safe";
  return SENSITIVE_KEY_TERMS.some((term) => normalized === term || normalized.endsWith(term))
    ? "credential"
    : "safe";
}

function isSafeCredentialMetadataValue(
  kind: CredentialMetadataKind,
  value: unknown
): boolean {
  if (kind === "number") {
    return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
  }
  if (kind === "boolean") return typeof value === "boolean";
  if (typeof value !== "string" || protectDirectCredentialText(value) !== value) return false;
  if (kind === "env") return /^[A-Z_][A-Z0-9_]{0,127}$/u.test(value);
  if (kind === "digest") {
    const match = /^(sha1|sha224|sha256|sha384|sha512|md5|blake2b|blake3):([a-f0-9]+)$/iu.exec(value);
    if (match === null) return false;
    const expectedLengths: Readonly<Record<string, number>> = {
      sha1: 40,
      sha224: 56,
      sha256: 64,
      sha384: 96,
      sha512: 128,
      md5: 32,
      blake2b: 128,
      blake3: 64
    };
    return match[2]?.length === expectedLengths[match[1]?.toLocaleLowerCase("en-US") ?? ""];
  }
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  return new RegExp(
    `^(?:${uuid}|(?:mniu:)?local_encrypted:${uuid}|(?:mniu:)?keychain:[a-z0-9_-]+|env:[A-Z_][A-Z0-9_]{0,127}|secret-store/[a-z0-9._/-]+)$`,
    "iu"
  ).test(value);
}

function isSafeAssignmentMetadataValue(
  kind: CredentialMetadataKind,
  value: string,
  quoted: boolean
): boolean {
  if (kind === "number") return !quoted && isJsonNumberLexeme(value);
  if (kind === "boolean") return !quoted && (value === "true" || value === "false");
  return isSafeCredentialMetadataValue(kind, value);
}

function isCompleteValueMarker(content: string, start: number, marker: string): boolean {
  const next = content[start + marker.length];
  return next === undefined || "\r\n,;&}]\"'".includes(next);
}

function applyTextPatches(content: string, patches: readonly TextPatch[]): string {
  if (patches.length === 0) return content;
  let output = "";
  let cursor = 0;
  for (const patch of patches) {
    if (patch.start < cursor || patch.end < patch.start || patch.end > content.length) {
      throw new TypeError("data protection generated overlapping text patches");
    }
    output += content.slice(cursor, patch.start);
    output += patch.replacement;
    cursor = patch.end;
  }
  return `${output}${content.slice(cursor)}`;
}

function isAssignmentBoundary(content: string, index: number): boolean {
  if (index === 0) return true;
  const previous = content[index - 1];
  return previous !== undefined && /[\s{[(,;&?]/u.test(previous);
}

function assignmentDelimiterLength(content: string, index: number): number {
  const character = content[index];
  if (character === ":" || character === "=" || character === "：" || character === "＝") {
    return 1;
  }
  return content.slice(index, index + 3).toLocaleLowerCase("en-US") === "%3d" ? 3 : 0;
}

function isUnquotedAssignmentKeyTerminator(content: string, index: number): boolean {
  const character = content[index];
  return character === undefined
    || /[\s:=：＝,;&?{}\[\]<>"']/u.test(character)
    || assignmentDelimiterLength(content, index) > 0;
}

function assignmentValueEnd(content: string, start: number): number {
  let index = start;
  const marker = SAFE_MARKERS.find((candidate) => content.startsWith(candidate, start));
  if (marker !== undefined) index += marker.length;
  while (index < content.length) {
    const character = content[index];
    if (character === "\r" || character === "\n" || ",;&}]".includes(character ?? "")) break;
    index += 1;
  }
  return index;
}

function quotedAssignmentValueEnd(
  content: string,
  start: number,
  quote: string
): { readonly contentEnd: number; readonly tokenEnd: number } {
  let index = start + 1;
  while (index < content.length && content[index] !== "\r" && content[index] !== "\n") {
    if (content[index] === "\\") {
      index = Math.min(index + 2, content.length);
      continue;
    }
    if (content[index] === quote) {
      return { contentEnd: index, tokenEnd: index + 1 };
    }
    index += 1;
  }
  return { contentEnd: index, tokenEnd: index };
}

function isJsonNumberLexeme(value: string): boolean {
  return /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value);
}

function hasEncodedSensitiveAssignment(rawToken: string): boolean {
  if (!rawToken.includes("%") && !rawToken.includes("\\")) return false;
  const decoded = decodeKeyRepresentations(rawToken);
  let delimiterIndex = -1;
  for (let index = 0; index < decoded.length; index += 1) {
    if (":=：＝".includes(decoded[index] ?? "")) {
      delimiterIndex = index;
      break;
    }
  }
  if (delimiterIndex <= 0) return false;
  const key = decoded.slice(0, delimiterIndex);
  const kind = credentialKeyKind(key);
  const metadataKind = credentialMetadataKind(key);
  if (kind === "credential") return true;
  if (metadataKind !== undefined) {
    return !isSafeAssignmentMetadataValue(
      metadataKind,
      decoded.slice(delimiterIndex + 1).trim(),
      false
    );
  }
  return kind === "numeric-token-metric"
    && !isJsonNumberLexeme(decoded.slice(delimiterIndex + 1).trim());
}

function redactAssignments(content: string): string {
  const patches: TextPatch[] = [];
  for (let index = 0; index < content.length;) {
    if (!isAssignmentBoundary(content, index) || /\s/u.test(content[index] ?? "")) {
      index += 1;
      continue;
    }

    const keyStart = index;
    const openingQuote = content[index];
    let keyEnd = index;
    let rawKeyEnd = index;
    if (openingQuote === '"' || openingQuote === "'") {
      keyEnd += 1;
      while (keyEnd < content.length && content[keyEnd] !== "\r" && content[keyEnd] !== "\n") {
        if (content[keyEnd] === "\\") {
          keyEnd = Math.min(keyEnd + 2, content.length);
          continue;
        }
        if (content[keyEnd] === openingQuote) break;
        keyEnd += 1;
      }
      if (content[keyEnd] !== openingQuote) {
        index += 1;
        continue;
      }
      keyEnd += 1;
      rawKeyEnd = keyEnd;
    } else {
      while (!isUnquotedAssignmentKeyTerminator(content, keyEnd)) {
        if (content[keyEnd] === "\\") {
          if (content.slice(keyEnd, keyEnd + 3).toLocaleLowerCase("en-US") === "\\u{") {
            let closingBrace = -1;
            const boundedEnd = Math.min(content.length, keyEnd + 17);
            for (let cursor = keyEnd + 3; cursor < boundedEnd; cursor += 1) {
              if (content[cursor] === "\r" || content[cursor] === "\n") break;
              if (content[cursor] === "}") {
                closingBrace = cursor;
                break;
              }
            }
            if (closingBrace !== -1) {
              keyEnd = closingBrace + 1;
              continue;
            }
          }
          keyEnd = Math.min(keyEnd + 2, content.length);
          continue;
        }
        keyEnd += 1;
      }
      rawKeyEnd = keyEnd;
      if (keyEnd === keyStart) {
        index += 1;
        continue;
      }
    }

    while (content[keyEnd] === " " || content[keyEnd] === "\t") keyEnd += 1;
    const delimiterLength = assignmentDelimiterLength(content, keyEnd);
    if (delimiterLength === 0) {
      try {
        if (hasEncodedSensitiveAssignment(content.slice(keyStart, rawKeyEnd))) {
          return UNSAFE_MARKER;
        }
      } catch {
        return UNSAFE_MARKER;
      }
      index += 1;
      continue;
    }

    const rawKey = content.slice(keyStart, rawKeyEnd);
    const innerKeyLength = openingQuote === '"' || openingQuote === "'"
      ? Math.max(0, rawKey.length - 2)
      : rawKey.length;
    let kind: CredentialKeyKind;
    let metadataKind: CredentialMetadataKind | undefined;
    try {
      kind = credentialKeyKind(rawKey);
      metadataKind = credentialMetadataKind(rawKey);
    } catch {
      return UNSAFE_MARKER;
    }
    if (innerKeyLength > 256 && (kind !== "safe" || metadataKind !== undefined)) {
      return UNSAFE_MARKER;
    }
    if (kind === "safe" && metadataKind === undefined) {
      index = keyEnd + delimiterLength;
      continue;
    }

    let valueStart = keyEnd + delimiterLength;
    while (content[valueStart] === " " || content[valueStart] === "\t") valueStart += 1;
    const valueQuote = content[valueStart];
    if (valueQuote === '"' || valueQuote === "'") {
      const bounds = quotedAssignmentValueEnd(content, valueStart, valueQuote);
      const value = content.slice(valueStart + 1, bounds.contentEnd);
      const marker = SAFE_MARKERS.find((candidate) => value.startsWith(candidate));
      const completeMarker = marker !== undefined && value === marker;
      const safeMetadata = metadataKind !== undefined
        && isSafeAssignmentMetadataValue(metadataKind, value, true);
      if ((!completeMarker && !safeMetadata) || kind === "numeric-token-metric") {
        patches.push({
          start: valueStart + 1,
          end: bounds.contentEnd,
          replacement: CREDENTIAL_MARKER
        });
      }
      index = bounds.tokenEnd;
      continue;
    }

    const valueEnd = assignmentValueEnd(content, valueStart);
    const rawValue = content.slice(valueStart, valueEnd).trimEnd();
    const marker = SAFE_MARKERS.find((candidate) => content.startsWith(candidate, valueStart));
    const completeMarker = marker !== undefined
      && isCompleteValueMarker(content, valueStart, marker);
    const safeMetric = kind === "numeric-token-metric" && isJsonNumberLexeme(rawValue);
    const safeMetadata = metadataKind !== undefined
      && isSafeAssignmentMetadataValue(metadataKind, rawValue, false);
    if (!completeMarker && !safeMetric && !safeMetadata) {
      patches.push({ start: valueStart, end: valueEnd, replacement: CREDENTIAL_MARKER });
    }
    index = Math.max(valueEnd, valueStart + 1);
  }
  return applyTextPatches(content, patches);
}

function redactJwtOrJwe(content: string): string {
  return content.replace(JWT_OR_JWE_PATTERN, (candidate) => {
    const segments = candidate.split(".").length;
    return segments === 3 || segments === 5 ? CREDENTIAL_MARKER : candidate;
  });
}

function basicValueContainsUserInfo(value: string): boolean {
  if (!/^[a-z0-9+/]+={0,2}$/iu.test(value) || value.length % 4 === 1) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length > 0 && decoded.includes(0x3a);
  } catch {
    return false;
  }
}

function redactAuthorizationLines(content: string): string {
  return content.replace(
    /(^|[\r\n])([ \t]*)(bearer|basic)([ \t]+)([^\r\n]*)/giu,
    (match, boundary: string, indentation: string, scheme: string, spacing: string, remainder: string) => {
      const marker = SAFE_MARKERS.find((candidate) => remainder.startsWith(candidate));
      if (marker !== undefined) {
        if (remainder.slice(marker.length).trim().length === 0) return match;
        return `${boundary}${indentation}${scheme}${spacing}${CREDENTIAL_MARKER}`;
      }

      const token = /^[^\s,;]+/u.exec(remainder)?.[0];
      if (token === undefined) return match;
      if (remainder.slice(token.length).trim().length > 0) return match;
      const isBearer = scheme.toLocaleLowerCase("en-US") === "bearer";
      const shouldProtect = isBearer
        ? /^[a-z0-9._~+/=-]+$/iu.test(token)
        : basicValueContainsUserInfo(token);
      if (!shouldProtect) return match;
      return `${boundary}${indentation}${scheme}${spacing}${CREDENTIAL_MARKER}${remainder.slice(token.length)}`;
    }
  );
}

function protectDirectCredentialText(content: string): string {
  const privateKeysProtected = content.replace(PRIVATE_KEY_PATTERN, PRIVATE_KEY_MARKER);
  const urisProtected = redactJwtOrJwe(privateKeysProtected)
    .replace(URI_CREDENTIAL_PATTERN, `$1${CREDENTIAL_MARKER}@`)
    .replace(URI_MARKER_PREFIX_PATTERN, `$1${CREDENTIAL_MARKER}@`);
  return redactAuthorizationLines(urisProtected)
    .replace(AWS_KEY_PATTERN, CREDENTIAL_MARKER)
    .replace(GITHUB_KEY_PATTERN, CREDENTIAL_MARKER)
    .replace(PROVIDER_KEY_PATTERN, CREDENTIAL_MARKER);
}

function protectCredentialText(content: string): string {
  return protectDirectCredentialText(redactAssignments(content));
}

function hasAcceptedMobileType(type: string | undefined): boolean {
  return type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE";
}

export function isMainlandMobile(value: string): boolean {
  if (typeof value !== "string") return false;
  if (!/^1[0-9]{10}$/u.test(value)) return false;
  try {
    const phone = parsePhoneNumberFromString(value, "CN");
    return phone !== undefined
      && phone.country === "CN"
      && phone.nationalNumber === value
      && phone.isValid()
      && hasAcceptedMobileType(phone.getType());
  } catch {
    return false;
  }
}

export function isCanonicalE164Mobile(value: string): boolean {
  if (typeof value !== "string") return false;
  if (!/^\+[1-9][0-9]{7,14}$/u.test(value)) return false;
  try {
    const phone = parsePhoneNumberFromString(value);
    return phone !== undefined
      && phone.number === value
      && phone.isValid()
      && hasAcceptedMobileType(phone.getType());
  } catch {
    return false;
  }
}

function hasRealPrcBirthDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1800 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  const now = new Date();
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && timestamp <= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function isPrcResidentIdentityNumber(value: string): boolean {
  if (typeof value !== "string") return false;
  if (!/^[0-9]{17}[0-9Xx]$/u.test(value)) return false;
  const address = value.slice(0, 6);
  const province = address.slice(0, 2);
  const isHmtResidenceCode = PRC_HMT_RESIDENCE_CODES.has(address);
  if (!isHmtResidenceCode) {
    if (!PRC_MAINLAND_PROVINCE_CODES.has(province)) return false;
    if (province === "81" || province === "82" || province === "83") return false;
    if (address.slice(2) === "0000") return false;
  }
  if (!hasRealPrcBirthDate(value.slice(6, 14))) return false;
  if (value.slice(14, 17) === "000") return false;
  let sum = 0;
  for (let index = 0; index < 17; index += 1) {
    sum += Number(value[index]) * (PRC_ID_WEIGHTS[index] ?? 0);
  }
  return value[17]?.toUpperCase() === PRC_ID_CHECKS[sum % 11];
}

function protectBusinessText(content: string): string {
  const identityProtected = content.replace(
    PRC_ID_CANDIDATE_PATTERN,
    (candidate, prefix: string, identity: string) =>
      isPrcResidentIdentityNumber(identity) ? `${prefix}${PRC_ID_MARKER}` : candidate
  );
  const e164Protected = identityProtected.replace(
    E164_CANDIDATE_PATTERN,
    (candidate, prefix: string, phone: string) =>
      isCanonicalE164Mobile(phone) ? `${prefix}${PHONE_MARKER}` : candidate
  );
  return e164Protected.replace(
    MAINLAND_MOBILE_CANDIDATE_PATTERN,
    (candidate, prefix: string, phone: string) =>
      isMainlandMobile(phone) ? `${prefix}${PHONE_MARKER}` : candidate
  );
}

function protectTextLeaf(content: string, businessRedaction: boolean): string {
  const credentialsProtected = protectCredentialText(content);
  return businessRedaction ? protectBusinessText(credentialsProtected) : credentialsProtected;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addCodeUnits(state: ProtectionState, count: number): void {
  state.codeUnits += count;
  if (state.codeUnits > MAX_JSON_CODE_UNITS) {
    throw new RangeError("JSON value exceeds the data protection size limit");
  }
}

function protectJsonNode(
  value: unknown,
  businessRedaction: boolean,
  state: ProtectionState,
  ancestors: Set<object>,
  depth: number
): ProtectedJsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new RangeError("JSON value exceeds the data protection depth limit");
  }
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) {
    throw new RangeError("JSON value exceeds the data protection node limit");
  }

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    addCodeUnits(state, value.length);
    return protectTextLeaf(value, businessRedaction);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
    if (Object.is(value, -0)) throw new TypeError("JSON numbers cannot contain negative zero");
    if (businessRedaction) {
      const representation = String(value);
      if (isMainlandMobile(representation)) return PHONE_MARKER;
      if (isPrcResidentIdentityNumber(representation)) return PRC_ID_MARKER;
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`lossless JSON cannot contain ${typeof value}`);
  }
  if (utilTypes.isProxy(value)) throw new TypeError("lossless JSON cannot contain a Proxy");
  if (ancestors.has(value)) throw new TypeError("lossless JSON cannot contain a circular reference");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError("lossless JSON arrays must use the intrinsic Array prototype");
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) {
        throw new TypeError("lossless JSON arrays must be dense and have no extra properties");
      }
      const output: ProtectedJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("lossless JSON arrays cannot be sparse");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("lossless JSON array items must be enumerable data properties");
        }
        output.push(protectJsonNode(
          descriptor.value,
          businessRedaction,
          state,
          ancestors,
          depth + 1
        ));
      }
      return output;
    }

    if (!isPlainObject(value)) throw new TypeError("lossless JSON objects must be plain JSON objects");
    const output: Record<string, ProtectedJsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") throw new TypeError("lossless JSON cannot contain symbol keys");
      addCodeUnits(state, key.length);
      if (DANGEROUS_KEYS.has(key)) throw new TypeError("lossless JSON contains an unsafe object key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("lossless JSON object fields must be enumerable data properties");
      }
      const keyKind = credentialKeyKind(key);
      const metadataKind = credentialMetadataKind(key);
      const safeMetadata = metadataKind !== undefined
        && isSafeCredentialMetadataValue(metadataKind, descriptor.value);
      const protectedValue = protectJsonNode(
        descriptor.value,
        (keyKind === "numeric-token-metric" && typeof descriptor.value === "number")
          || (metadataKind === "number" && safeMetadata)
          ? false
          : businessRedaction,
        state,
        ancestors,
        depth + 1
      );
      Object.defineProperty(output, key, {
        value: keyKind === "credential"
          || (keyKind === "numeric-token-metric" && typeof descriptor.value !== "number")
          || (metadataKind !== undefined && !safeMetadata)
          ? CREDENTIAL_MARKER
          : protectedValue,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function protectJsonValue(
  value: unknown,
  options?: BusinessRedactionOptions
): ProtectedJsonValue {
  const businessRedaction = resolveBusinessRedaction(options);
  return protectJsonNode(
    value,
    businessRedaction,
    { codeUnits: 0, nodes: 0 },
    new Set<object>(),
    0
  );
}

function skipJsonWhitespace(content: string, start: number): number {
  let index = start;
  while (
    content[index] === " "
    || content[index] === "\t"
    || content[index] === "\r"
    || content[index] === "\n"
  ) index += 1;
  return index;
}

function scanJsonStringEnd(content: string, start: number): number {
  if (content[start] !== '"') throw new SyntaxError("expected a JSON string");
  let index = start + 1;
  while (index < content.length) {
    if (content[index] === "\\") {
      index += 2;
      continue;
    }
    if (content[index] === '"') return index + 1;
    index += 1;
  }
  throw new SyntaxError("unterminated JSON string");
}

function decodeJsonString(content: string, start: number, end: number): string {
  const decoded = JSON.parse(content.slice(start, end)) as unknown;
  if (typeof decoded !== "string") throw new SyntaxError("expected a JSON string value");
  return decoded;
}

function scanJsonNumberEnd(content: string, start: number): number {
  let index = start;
  while (/[0-9eE+.-]/u.test(content[index] ?? "")) index += 1;
  if (!isJsonNumberLexeme(content.slice(start, index))) {
    throw new SyntaxError("invalid JSON number");
  }
  return index;
}

function encodedJsonMarker(marker: string): string {
  const encoded = JSON.stringify(marker);
  if (encoded === undefined) throw new TypeError("could not encode a data protection marker");
  return encoded;
}

function markerAt(content: string, index: number): string | undefined {
  return SAFE_MARKERS.find((marker) => content.startsWith(marker, index));
}

interface MarkerSpan {
  readonly start: number;
  readonly end: number;
  readonly marker: string;
}

function markerSpans(content: string): MarkerSpan[] {
  const spans: MarkerSpan[] = [];
  for (let index = 0; index < content.length;) {
    if (content[index] !== "[") {
      index += 1;
      continue;
    }
    const marker = markerAt(content, index);
    if (marker === undefined) {
      index += 1;
      continue;
    }
    spans.push({ start: index, end: index + marker.length, marker });
    index += marker.length;
  }
  return spans;
}

function deriveMarkerReplacementPatches(
  original: string,
  protectedValue: string
): TextPatch[] | undefined {
  const patches: TextPatch[] = [];
  const spans = markerSpans(protectedValue);
  let spanIndex = 0;
  let originalIndex = 0;
  let protectedIndex = 0;
  while (originalIndex < original.length || protectedIndex < protectedValue.length) {
    while (
      originalIndex < original.length
      && protectedIndex < protectedValue.length
      && original[originalIndex] === protectedValue[protectedIndex]
    ) {
      originalIndex += 1;
      protectedIndex += 1;
    }
    if (originalIndex === original.length && protectedIndex === protectedValue.length) break;

    while ((spans[spanIndex]?.end ?? Number.POSITIVE_INFINITY) <= protectedIndex) {
      spanIndex += 1;
    }
    if (spans[spanIndex]?.start !== protectedIndex) return undefined;

    let replacement = "";
    while (spans[spanIndex]?.start === protectedIndex) {
      const span = spans[spanIndex];
      if (span === undefined) break;
      replacement += span.marker;
      protectedIndex = span.end;
      spanIndex += 1;
    }
    if (replacement.length === 0) return undefined;

    let originalEnd: number;
    if (protectedIndex === protectedValue.length) {
      originalEnd = original.length;
    } else {
      const literalEnd = spans[spanIndex]?.start ?? protectedValue.length;
      const literal = protectedValue.slice(protectedIndex, literalEnd);
      if (literal.length === 0) return undefined;
      originalEnd = original.indexOf(literal, originalIndex);
      if (originalEnd === -1) return undefined;
    }

    patches.push({ start: originalIndex, end: originalEnd, replacement });
    originalIndex = originalEnd;
  }
  return applyTextPatches(original, patches) === protectedValue ? patches : undefined;
}

function jsonStringRawBoundaries(
  content: string,
  start: number,
  end: number,
  decodedLength: number
): number[] {
  const boundaries: number[] = [];
  let rawIndex = start + 1;
  let decodedIndex = 0;
  boundaries[0] = rawIndex;
  while (rawIndex < end - 1) {
    if (content[rawIndex] === "\\") {
      rawIndex += content[rawIndex + 1] === "u" ? 6 : 2;
    } else {
      rawIndex += 1;
    }
    decodedIndex += 1;
    boundaries[decodedIndex] = rawIndex;
  }
  if (decodedIndex !== decodedLength) {
    throw new TypeError("could not map decoded JSON string offsets safely");
  }
  return boundaries;
}

function encodedJsonStringContent(value: string): string {
  const encoded = encodedJsonMarker(value);
  return encoded.slice(1, -1);
}

function isSafeJsonMetadataValue(
  content: string,
  start: number,
  kind: CredentialMetadataKind
): boolean {
  if (content[start] === '"') {
    const end = scanJsonStringEnd(content, start);
    return isSafeCredentialMetadataValue(kind, decodeJsonString(content, start, end));
  }
  if (content[start] === "-" || /[0-9]/u.test(content[start] ?? "")) {
    const end = scanJsonNumberEnd(content, start);
    return isSafeCredentialMetadataValue(kind, Number(content.slice(start, end)));
  }
  if (content.startsWith("true", start)) return isSafeCredentialMetadataValue(kind, true);
  if (content.startsWith("false", start)) return isSafeCredentialMetadataValue(kind, false);
  return false;
}

function scanJsonValue(
  content: string,
  start: number,
  businessRedaction: boolean,
  state: ProtectionState,
  patches: TextPatch[],
  emitPatches: boolean,
  depth: number
): number {
  if (depth > MAX_JSON_DEPTH) {
    throw new RangeError("JSON text exceeds the data protection depth limit");
  }
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) {
    throw new RangeError("JSON text exceeds the data protection node limit");
  }

  const valueStart = skipJsonWhitespace(content, start);
  const first = content[valueStart];
  if (first === '"') {
    const end = scanJsonStringEnd(content, valueStart);
    const decoded = decodeJsonString(content, valueStart, end);
    addCodeUnits(state, decoded.length);
    if (emitPatches) {
      const protectedValue = protectTextLeaf(decoded, businessRedaction);
      if (protectedValue !== decoded) {
        const leafPatches = deriveMarkerReplacementPatches(decoded, protectedValue);
        if (leafPatches === undefined) {
          patches.push({
            start: valueStart,
            end,
            replacement: encodedJsonMarker(UNSAFE_MARKER)
          });
        } else {
          const boundaries = jsonStringRawBoundaries(
            content,
            valueStart,
            end,
            decoded.length
          );
          for (const leafPatch of leafPatches) {
            const rawStart = boundaries[leafPatch.start];
            const rawEnd = boundaries[leafPatch.end];
            if (rawStart === undefined || rawEnd === undefined) {
              throw new TypeError("could not map a protected JSON string span safely");
            }
            patches.push({
              start: rawStart,
              end: rawEnd,
              replacement: encodedJsonStringContent(leafPatch.replacement)
            });
          }
        }
      }
    }
    return end;
  }

  if (first === "{") {
    let index = skipJsonWhitespace(content, valueStart + 1);
    if (content[index] === "}") return index + 1;
    while (index < content.length) {
      const keyStart = index;
      const keyEnd = scanJsonStringEnd(content, keyStart);
      const key = decodeJsonString(content, keyStart, keyEnd);
      addCodeUnits(state, key.length);
      if (DANGEROUS_KEYS.has(key)) throw new TypeError("JSON text contains an unsafe object key");

      index = skipJsonWhitespace(content, keyEnd);
      if (content[index] !== ":") throw new SyntaxError("expected a JSON object colon");
      const childStart = skipJsonWhitespace(content, index + 1);
      const keyKind = credentialKeyKind(key);
      const metadataKind = credentialMetadataKind(key);
      let childEnd: number;
      if (keyKind === "credential") {
        childEnd = scanJsonValue(
          content,
          childStart,
          businessRedaction,
          state,
          patches,
          false,
          depth + 1
        );
        if (emitPatches) {
          patches.push({
            start: childStart,
            end: childEnd,
            replacement: encodedJsonMarker(CREDENTIAL_MARKER)
          });
        }
      } else if (keyKind === "numeric-token-metric") {
        const numericMetric = content[childStart] === "-"
          || /[0-9]/u.test(content[childStart] ?? "");
        childEnd = scanJsonValue(
          content,
          childStart,
          numericMetric ? false : businessRedaction,
          state,
          patches,
          false,
          depth + 1
        );
        if (emitPatches && !numericMetric) {
          patches.push({
            start: childStart,
            end: childEnd,
            replacement: encodedJsonMarker(CREDENTIAL_MARKER)
          });
        }
      } else if (metadataKind !== undefined) {
        const safeMetadata = isSafeJsonMetadataValue(content, childStart, metadataKind);
        childEnd = scanJsonValue(
          content,
          childStart,
          metadataKind === "number" && safeMetadata ? false : businessRedaction,
          state,
          patches,
          emitPatches && safeMetadata,
          depth + 1
        );
        if (emitPatches && !safeMetadata) {
          patches.push({
            start: childStart,
            end: childEnd,
            replacement: encodedJsonMarker(CREDENTIAL_MARKER)
          });
        }
      } else {
        childEnd = scanJsonValue(
          content,
          childStart,
          businessRedaction,
          state,
          patches,
          emitPatches,
          depth + 1
        );
      }

      index = skipJsonWhitespace(content, childEnd);
      if (content[index] === "}") return index + 1;
      if (content[index] !== ",") throw new SyntaxError("expected a JSON object comma");
      index = skipJsonWhitespace(content, index + 1);
    }
    throw new SyntaxError("unterminated JSON object");
  }

  if (first === "[") {
    let index = skipJsonWhitespace(content, valueStart + 1);
    if (content[index] === "]") return index + 1;
    while (index < content.length) {
      index = scanJsonValue(
        content,
        index,
        businessRedaction,
        state,
        patches,
        emitPatches,
        depth + 1
      );
      index = skipJsonWhitespace(content, index);
      if (content[index] === "]") return index + 1;
      if (content[index] !== ",") throw new SyntaxError("expected a JSON array comma");
      index = skipJsonWhitespace(content, index + 1);
    }
    throw new SyntaxError("unterminated JSON array");
  }

  if (first === "-" || /[0-9]/u.test(first ?? "")) {
    const end = scanJsonNumberEnd(content, valueStart);
    if (emitPatches && businessRedaction) {
      const rawNumber = content.slice(valueStart, end);
      const marker = isMainlandMobile(rawNumber)
        ? PHONE_MARKER
        : isPrcResidentIdentityNumber(rawNumber)
          ? PRC_ID_MARKER
          : undefined;
      if (marker !== undefined) {
        patches.push({ start: valueStart, end, replacement: encodedJsonMarker(marker) });
      }
    }
    return end;
  }

  for (const literal of ["true", "false", "null"] as const) {
    if (content.startsWith(literal, valueStart)) return valueStart + literal.length;
  }
  throw new SyntaxError("invalid JSON value");
}

function protectCompleteJson(content: string, businessRedaction: boolean): string {
  JSON.parse(content);
  const state: ProtectionState = { codeUnits: 0, nodes: 0 };
  const patches: TextPatch[] = [];
  const end = scanJsonValue(content, 0, businessRedaction, state, patches, true, 0);
  if (skipJsonWhitespace(content, end) !== content.length) {
    throw new SyntaxError("JSON text contains trailing content");
  }
  return applyTextPatches(content, patches);
}

function mightBeCompleteJson(content: string): boolean {
  const first = content[0];
  return first === "{" || first === "[" || first === '"';
}

export function protectText(
  content: string,
  options?: BusinessRedactionOptions
): string {
  if (typeof content !== "string") throw new TypeError("data protection text must be a string");
  const businessRedaction = resolveBusinessRedaction(options);
  if (content.length > MAX_TEXT_CODE_UNITS) return UNSAFE_MARKER;

  const trimmed = content.trim();
  if (trimmed.length > 0 && mightBeCompleteJson(trimmed)) {
    try {
      const protectedJson = protectCompleteJson(trimmed, businessRedaction);
      const start = content.length - content.trimStart().length;
      return `${content.slice(0, start)}${protectedJson}${content.slice(start + trimmed.length)}`;
    } catch (error) {
      if (error instanceof SyntaxError) {
        // Malformed or partial JSON still receives conservative textual protection.
      } else {
        return UNSAFE_MARKER;
      }
    }
  }
  return protectTextLeaf(content, businessRedaction);
}

export function containsCredential(content: string): boolean {
  if (typeof content !== "string") throw new TypeError("credential inspection text must be a string");
  if (content.length > MAX_TEXT_CODE_UNITS) return true;
  return protectText(content, { businessRedaction: false }) !== content;
}

export function safeErrorMessage(
  error: unknown,
  options?: BusinessRedactionOptions
): string {
  try {
    if (typeof error === "string") return protectText(error, options);
    if (typeof error === "object" && error !== null && utilTypes.isProxy(error)) {
      return "An error could not be inspected safely";
    }
    if (error instanceof Error) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
        return protectText(descriptor.value, options);
      }
      return "An error occurred";
    }
  } catch {
    return "An error could not be inspected safely";
  }
  return "An unknown error occurred";
}
