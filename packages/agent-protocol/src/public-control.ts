// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  isMainlandMobile,
  isPrcResidentIdentityNumber,
  protectText
} from "@mn/data-policy";

const PUBLIC_CONTROL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PUBLIC_CONTROL_LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9 -]{0,63}$/u;
const SAFE_RANDOM_PREFIX_PATTERN = /^[A-Za-z][A-Za-z._:-]{0,62}$/u;
const SAFE_QUATERNARY_ALPHABET = "wxyz";
const EMBEDDED_CREDENTIAL_PATTERN = /(?:sk-(?:proj-|ant-)?[a-z0-9._-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|eyJ[a-z0-9_-]{2,}(?:\.[a-z0-9_-]*){2,4}|[a-z][a-z0-9+.-]{0,31}:\/\/[^\s\/:@]{1,128}:[^\s\/@]{1,128}@|(?:api[-_]?key|api[-_]?secret|access[-_]?key[-_]?id|access[-_]?token|auth(?:orization)?(?:[-_]?(?:code|token))?|bearer|client[-_]?secret|cookie|credential|mfa(?:[-_]?(?:secret|code))?|oauth[-_]?code|otp|passphrase|passcode|password|passwd|private[-_]?key|refresh[-_]?token|secret(?:[-_]?access)?[-_]?key|session[-_]?(?:id|token)|totp|token|口令|密码|密钥|凭证|令牌):)/iu;

type PublicControlInspection = "safe" | "invalid" | "protected";

function containsProtectedPublicControlMaterial(value: string): boolean {
  try {
    if (protectText(value) !== value) return true;
    for (let index = 0; index <= value.length - 11; index += 1) {
      if (isMainlandMobile(value.slice(index, index + 11))) return true;
    }
    for (let index = 0; index <= value.length - 18; index += 1) {
      if (isPrcResidentIdentityNumber(value.slice(index, index + 18))) return true;
    }
    return EMBEDDED_CREDENTIAL_PATTERN.test(value);
  } catch {
    return true;
  }
}

function inspectPublicControlString(
  value: unknown,
  pattern: RegExp,
  maxCodeUnits: number
): PublicControlInspection {
  if (typeof value !== "string" || value.length > maxCodeUnits) return "invalid";
  if (containsProtectedPublicControlMaterial(value)) return "protected";
  return pattern.test(value) ? "safe" : "invalid";
}

function safePublicControlLabel(label: unknown): string {
  return typeof label === "string"
    && PUBLIC_CONTROL_LABEL_PATTERN.test(label)
    && !containsProtectedPublicControlMaterial(label)
    ? label
    : "public control identifier";
}

/** Internal shared validator for public control domains with a closed caller-owned pattern. */
export function isSafePublicControlStringV1(
  value: unknown,
  pattern: RegExp,
  maxCodeUnits: number
): value is string {
  try {
    return inspectPublicControlString(value, pattern, maxCodeUnits) === "safe";
  } catch {
    return false;
  }
}

/** Internal shared assertion used by every protocol structural-ID boundary. */
export function assertSafePublicControlStringV1(
  value: unknown,
  label: unknown,
  pattern: RegExp,
  maxCodeUnits: number
): asserts value is string {
  const safeLabel = safePublicControlLabel(label);
  const inspection = inspectPublicControlString(value, pattern, maxCodeUnits);
  if (inspection === "protected") throw new TypeError(`${safeLabel} contains protected material`);
  if (inspection !== "safe") throw new TypeError(`${safeLabel} is invalid`);
}

export function isSafePublicControlIdV1(value: unknown): value is string {
  return isSafePublicControlStringV1(value, PUBLIC_CONTROL_ID_PATTERN, 128);
}

export function assertSafePublicControlIdV1(
  value: unknown,
  label: unknown = "public control identifier"
): asserts value is string {
  assertSafePublicControlStringV1(value, label, PUBLIC_CONTROL_ID_PATTERN, 128);
}

/** Generate a random structural identifier whose representation cannot form phone or identity digits. */
export function createSafeRandomPublicControlIdV1(prefix: string): string {
  assertSafePublicControlStringV1(prefix, "random identifier prefix", SAFE_RANDOM_PREFIX_PATTERN, 63);
  const encoded = randomUUID().replaceAll("-", "").replace(/[0-9a-f]/gu, (character) => {
    const value = Number.parseInt(character, 16);
    return `${SAFE_QUATERNARY_ALPHABET[value >> 2]}${SAFE_QUATERNARY_ALPHABET[value & 3]}`;
  });
  return `${prefix}-${encoded}`;
}
