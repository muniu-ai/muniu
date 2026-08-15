import { canonicalJson, deepFreeze, sha256Canonical } from "./canonical.js";
import { isStrictRfc3339Timestamp } from "./timestamp.js";
import { GOVERNANCE_SCOPE_ORDER } from "./types.js";
import type { PackLock, PackLockEntry } from "./types.js";
import type {
  RegistryIssue,
  RollbackPlan,
  SyncPlanDiff,
  SyncPlanEntry,
  SyncPlanStatus,
  TrustedPackLockHistoryEntry
} from "./registryTypes.js";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const EPOCH = "1970-01-01T00:00:00.000Z";
const PACK_LOCK_FIELDS = new Set(["schemaVersion", "generatedAt", "packs", "digest"]);
const PACK_LOCK_ENTRY_FIELDS = new Set([
  "id",
  "version",
  "digest",
  "sequence",
  "scope",
  "scopeId",
  "source"
]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface ParsedPackVersion {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: readonly string[];
}

function parsedPackVersion(version: string): ParsedPackVersion | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0"
    )
  ) {
    return undefined;
  }
  return {
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease
  };
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return compareStrings(left, right);
}

export function isValidPackVersion(version: unknown): version is string {
  return typeof version === "string" && parsedPackVersion(version) !== undefined;
}

function entryKey(entry: Pick<PackLockEntry, "scope" | "scopeId" | "id">): string {
  return `${entry.scope}\0${entry.scopeId}\0${entry.id}`;
}

function compareEntries(left: PackLockEntry, right: PackLockEntry): number {
  const scope =
    GOVERNANCE_SCOPE_ORDER.indexOf(left.scope) -
    GOVERNANCE_SCOPE_ORDER.indexOf(right.scope);
  return (
    scope ||
    compareStrings(left.scopeId, right.scopeId) ||
    compareStrings(left.id, right.id) ||
    compareStrings(left.version, right.version) ||
    compareStrings(left.digest, right.digest) ||
    (left.sequence ?? -1) - (right.sequence ?? -1) ||
    compareStrings(left.source ?? "", right.source ?? "")
  );
}

function normalizePackEntries(entries: readonly PackLockEntry[]): PackLockEntry[] {
  let safeEntries: unknown;
  try {
    safeEntries = JSON.parse(canonicalJson(entries));
  } catch (error) {
    throw new TypeError(
      error instanceof Error ? error.message : "Pack lock entries must be declarative JSON"
    );
  }
  if (!Array.isArray(safeEntries)) {
    throw new TypeError("Pack lock entries must be an array");
  }
  const byKey = new Map<string, PackLockEntry>();
  const releaseByVersionIdentity = new Map<
    string,
    { digest: string; sequence?: number }
  >();
  for (const [index, rawEntry] of safeEntries.entries()) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new TypeError(`Pack lock entry ${index} must be an object`);
    }
    const entry = rawEntry as Record<string, unknown>;
    for (const field of Object.keys(entry)) {
      if (!PACK_LOCK_ENTRY_FIELDS.has(field)) {
        throw new TypeError(`Pack lock entry ${index}.${field} is unsupported`);
      }
    }
    if (typeof entry.id !== "string" || !entry.id || entry.id !== entry.id.trim()) {
      throw new TypeError(`Pack lock entry ${index} id is required and must be trimmed`);
    }
    if (!isValidPackVersion(entry.version)) {
      throw new TypeError(`Pack lock entry ${index} version must be valid SemVer`);
    }
    if (typeof entry.digest !== "string" || !HEX_SHA256.test(entry.digest)) {
      throw new TypeError(`Pack lock entry ${index} digest must be lowercase SHA-256`);
    }
    if (
      entry.sequence !== undefined &&
      (!Number.isSafeInteger(entry.sequence) || Number(entry.sequence) < 1)
    ) {
      throw new TypeError(
        `Pack lock entry ${index} sequence must be a positive safe integer`
      );
    }
    if (!(GOVERNANCE_SCOPE_ORDER as readonly unknown[]).includes(entry.scope)) {
      throw new TypeError(`Pack lock entry ${index} has unsupported scope`);
    }
    if (
      typeof entry.scopeId !== "string" ||
      !entry.scopeId ||
      entry.scopeId !== entry.scopeId.trim()
    ) {
      throw new TypeError(`Pack lock entry ${index} scopeId is required and must be trimmed`);
    }
    if (
      entry.source !== undefined &&
      (typeof entry.source !== "string" ||
        !entry.source ||
        entry.source !== entry.source.trim())
    ) {
      throw new TypeError(`Pack lock entry ${index} source must be trimmed and non-empty`);
    }
    const normalized: PackLockEntry = {
      id: entry.id,
      version: entry.version,
      digest: entry.digest,
      ...(entry.sequence !== undefined
        ? { sequence: entry.sequence as number }
        : {}),
      scope: entry.scope as PackLockEntry["scope"],
      scopeId: entry.scopeId,
      ...(entry.source ? { source: entry.source } : {})
    };
    const versionIdentity = `${normalized.id}@${normalized.version}`;
    const knownRelease = releaseByVersionIdentity.get(versionIdentity);
    if (
      knownRelease !== undefined &&
      (knownRelease.digest !== normalized.digest ||
        (knownRelease.sequence !== undefined &&
          normalized.sequence !== undefined &&
          knownRelease.sequence !== normalized.sequence))
    ) {
      throw new TypeError(
        `Pack lock maps ${versionIdentity} to conflicting release identities`
      );
    }
    releaseByVersionIdentity.set(versionIdentity, {
      digest: normalized.digest,
      sequence: knownRelease?.sequence ?? normalized.sequence
    });
    const key = entryKey(normalized);
    const previous = byKey.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new TypeError(
        `Pack lock contains conflicting entries for ${normalized.id} at ${normalized.scope}:${normalized.scopeId}`
      );
    }
    byKey.set(key, normalized);
  }
  return [...byKey.values()].sort(compareEntries);
}

export function packLockDigest(entries: readonly PackLockEntry[]): string {
  return sha256Canonical({
    schemaVersion: 1,
    packs: normalizePackEntries(entries)
  });
}

export function createPackLock(
  entries: readonly PackLockEntry[],
  generatedAt:
    | string
    | Date
    | { readonly generatedAt?: string | Date } = EPOCH
): PackLock {
  const rawGeneratedAt =
    typeof generatedAt === "object" && !(generatedAt instanceof Date)
      ? generatedAt.generatedAt ?? EPOCH
      : generatedAt;
  const timestamp =
    rawGeneratedAt instanceof Date
      ? rawGeneratedAt.toISOString()
      : rawGeneratedAt;
  if (!isStrictRfc3339Timestamp(timestamp)) {
    throw new TypeError("Pack lock generatedAt must be a strict RFC3339 timestamp");
  }
  const packs = normalizePackEntries(entries);
  return deepFreeze({
    schemaVersion: 1 as const,
    generatedAt: timestamp,
    packs,
    digest: packLockDigest(packs)
  });
}

export function validatePackLock(lock: unknown): readonly RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  let normalized: unknown;
  try {
    normalized = JSON.parse(canonicalJson(lock));
  } catch (error) {
    return deepFreeze([
      {
        code: "LOCK_INVALID",
        message: error instanceof Error ? error.message : "Pack lock is not declarative"
      }
    ]);
  }
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return deepFreeze([
      { code: "LOCK_INVALID", message: "Pack lock must be an object" }
    ]);
  }
  const candidate = normalized as Partial<PackLock> & Record<string, unknown>;
  for (const field of Object.keys(candidate)) {
    if (!PACK_LOCK_FIELDS.has(field)) {
      issues.push({
        code: "LOCK_INVALID",
        message: `Pack lock field ${field} is unsupported`
      });
    }
  }
  if (candidate.schemaVersion !== 1) {
    issues.push({ code: "LOCK_INVALID", message: "Pack lock schemaVersion must be 1" });
  }
  if (!isStrictRfc3339Timestamp(candidate.generatedAt)) {
    issues.push({ code: "LOCK_INVALID", message: "Pack lock generatedAt is invalid" });
  }
  let expectedDigest: string | undefined;
  if (!Array.isArray(candidate.packs)) {
    issues.push({ code: "LOCK_INVALID", message: "Pack lock packs must be an array" });
  } else try {
    expectedDigest = packLockDigest(candidate.packs);
  } catch (error) {
    issues.push({
      code: "LOCK_INVALID",
      message: error instanceof Error ? error.message : String(error)
    });
  }
  if (!candidate.digest || !HEX_SHA256.test(candidate.digest)) {
    issues.push({ code: "LOCK_INVALID", message: "Pack lock digest is invalid" });
  } else if (expectedDigest && candidate.digest !== expectedDigest) {
    issues.push({
      code: "LOCK_DIGEST_MISMATCH",
      message: "Pack lock digest does not match its entries",
      details: { expected: expectedDigest, actual: candidate.digest }
    });
  }
  return deepFreeze(issues);
}

export function comparePackVersions(left: string, right: string): number {
  const leftVersion = parsedPackVersion(left);
  const rightVersion = parsedPackVersion(right);
  if (!leftVersion || !rightVersion) {
    return compareStrings(left, right);
  }
  for (const field of ["major", "minor", "patch"] as const) {
    const delta = compareNumericIdentifiers(leftVersion[field], rightVersion[field]);
    if (delta) return delta;
  }
  const leftPre = leftVersion.prerelease;
  const rightPre = rightVersion.prerelease;
  if (leftPre.length === 0 && rightPre.length === 0) return 0;
  if (leftPre.length === 0) return 1;
  if (rightPre.length === 0) return -1;
  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftPre[index];
    const rightIdentifier = rightPre[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return compareStrings(leftIdentifier, rightIdentifier);
  }
  return 0;
}

function diffLockEntries(
  current: PackLockEntry | undefined,
  target: PackLockEntry | undefined
): readonly SyncPlanDiff[] {
  const fields = [
    "version",
    "digest",
    "sequence",
    "scope",
    "scopeId",
    "source"
  ] as const;
  const diff: SyncPlanDiff[] = [];
  for (const field of fields) {
    const before = current?.[field];
    const after = target?.[field];
    if (before !== after) {
      diff.push({
        field,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {})
      });
    }
  }
  return diff;
}

function rollbackEntry(
  current: PackLockEntry | undefined,
  target: PackLockEntry | undefined
): SyncPlanEntry {
  const material = target ?? current!;
  let status: SyncPlanStatus;
  if (!current) status = "new";
  else if (!target) status = "update";
  else if (current.digest === target.digest && current.version === target.version) {
    status = "current";
  } else {
    status = comparePackVersions(target.version, current.version) < 0
      ? "downgrade"
      : "update";
  }
  return {
    id: material.id,
    version: material.version,
    digest: material.digest,
    ...(material.sequence !== undefined ? { sequence: material.sequence } : {}),
    scope: material.scope,
    scopeId: material.scopeId,
    ...(material.source ? { source: material.source } : {}),
    status,
    ...(current ? { current: { ...current } } : {}),
    ...(target ? { target: { ...target } } : {}),
    diff: diffLockEntries(current, target),
    signatureVerified: false,
    issues: []
  };
}

function rollbackDiff(current: PackLock, target: PackLock): readonly SyncPlanEntry[] {
  const currentByKey = new Map(current.packs.map((entry) => [entryKey(entry), entry]));
  const targetByKey = new Map(target.packs.map((entry) => [entryKey(entry), entry]));
  const keys = [...new Set([...currentByKey.keys(), ...targetByKey.keys()])].sort();
  return keys.map((key) => rollbackEntry(currentByKey.get(key), targetByKey.get(key)));
}

export function planStandardPackRollback(
  currentLock: PackLock,
  targetLockDigest: string,
  trustedHistory: readonly TrustedPackLockHistoryEntry[]
): RollbackPlan {
  const issues: RegistryIssue[] = [];
  let safeCurrentValue: unknown;
  let safeHistoryValue: unknown;
  try {
    safeCurrentValue = JSON.parse(canonicalJson(currentLock));
  } catch (error) {
    issues.push({
      code: "LOCK_INVALID",
      message: error instanceof Error ? error.message : "Current lock is not declarative"
    });
  }
  try {
    safeHistoryValue = JSON.parse(canonicalJson(trustedHistory));
  } catch (error) {
    issues.push({
      code: "TRUSTED_HISTORY_INVALID",
      message: error instanceof Error ? error.message : "Trusted history is not declarative"
    });
  }
  const safeCurrent =
    safeCurrentValue &&
    typeof safeCurrentValue === "object" &&
    !Array.isArray(safeCurrentValue)
      ? (safeCurrentValue as PackLock)
      : undefined;
  const safeHistory: TrustedPackLockHistoryEntry[] = [];
  if (!safeCurrent) {
    issues.push({ code: "LOCK_INVALID", message: "Current lock must be an object" });
  } else {
    issues.push(...validatePackLock(safeCurrent));
  }
  if (!Array.isArray(safeHistoryValue)) {
    issues.push({
      code: "TRUSTED_HISTORY_INVALID",
      message: "Trusted history must be an array"
    });
  } else {
    safeHistoryValue.forEach((entry, index) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.keys(entry).some(
          (field) => !["lock", "trustedAt", "approvedBy"].includes(field)
        ) ||
        !("lock" in entry) ||
        !entry.lock ||
        typeof entry.lock !== "object" ||
        Array.isArray(entry.lock) ||
        !isStrictRfc3339Timestamp(entry.trustedAt) ||
        typeof entry.approvedBy !== "string" ||
        !entry.approvedBy.trim() ||
        entry.approvedBy !== entry.approvedBy.trim()
      ) {
        issues.push({
          code: "TRUSTED_HISTORY_INVALID",
          message: `Trusted history entry ${index} is malformed`
        });
        return;
      }
      const normalizedEntry = entry as unknown as TrustedPackLockHistoryEntry;
      const historyLockIssues = validatePackLock(normalizedEntry.lock);
      if (historyLockIssues.length > 0) {
        issues.push(
          ...historyLockIssues.map((candidate) => ({
            ...candidate,
            message: `Trusted history entry ${index}: ${candidate.message}`
          }))
        );
        return;
      }
      safeHistory.push(normalizedEntry);
    });
  }
  if (!safeCurrent || issues.length > 0) {
    return deepFreeze({
      schemaVersion: 1 as const,
      valid: false,
      status: "invalid" as const,
      currentLockDigest: safeCurrent?.digest ?? "0".repeat(64),
      targetLockDigest,
      diff: [],
      issues
    });
  }
  const historical = safeHistory.find(
    (entry) => entry.lock.digest === targetLockDigest
  );
  if (!historical) {
    issues.push({
      code: "TRUSTED_HISTORY_NOT_FOUND",
      message: `Trusted pack lock history does not contain ${targetLockDigest}`
    });
    return deepFreeze({
      schemaVersion: 1 as const,
      valid: false,
      status: "invalid" as const,
      currentLockDigest: safeCurrent.digest,
      targetLockDigest,
      diff: [],
      issues
    });
  }
  if (
    !historical.approvedBy?.trim() ||
    historical.approvedBy !== historical.approvedBy.trim() ||
    !isStrictRfc3339Timestamp(historical.trustedAt)
  ) {
    issues.push({
      code: "TRUSTED_HISTORY_INVALID",
      message: "Trusted history entry requires approvedBy and a valid trustedAt"
    });
  }
  issues.push(...validatePackLock(historical.lock));
  if (
    issues.length === 0 &&
    historical.lock.digest !== safeCurrent.digest &&
    Date.parse(historical.lock.generatedAt) >= Date.parse(safeCurrent.generatedAt)
  ) {
    issues.push({
      code: "TRUSTED_HISTORY_INVALID",
      message: "Rollback target must have been generated before the current lock"
    });
  }
  if (
    issues.length === 0 &&
    Date.parse(historical.trustedAt) < Date.parse(historical.lock.generatedAt)
  ) {
    issues.push({
      code: "TRUSTED_HISTORY_INVALID",
      message: "Trusted history approval cannot predate its lock"
    });
  }
  if (issues.length === 0) {
    const currentByKey = new Map(
      safeCurrent.packs.map((entry) => [entryKey(entry), entry])
    );
    const releaseByIdentity = new Map<
      string,
      { digest: string; sequence?: number }
    >();
    for (const entry of [...safeCurrent.packs, ...historical.lock.packs]) {
      const identity = `${entry.id}@${entry.version}`;
      const knownRelease = releaseByIdentity.get(identity);
      if (
        knownRelease !== undefined &&
        (knownRelease.digest !== entry.digest ||
          (knownRelease.sequence !== undefined &&
            entry.sequence !== undefined &&
            knownRelease.sequence !== entry.sequence))
      ) {
        issues.push({
          code: "VERSION_DIGEST_CONFLICT",
          message: `Rollback history maps ${identity} to conflicting release identities`,
          entryId: entry.id
        });
      } else {
        releaseByIdentity.set(identity, {
          digest: entry.digest,
          sequence: knownRelease?.sequence ?? entry.sequence
        });
      }
    }
    for (const target of historical.lock.packs) {
      const current = currentByKey.get(entryKey(target));
      if (
        (current !== undefined &&
          comparePackVersions(target.version, current.version) > 0) ||
        (current !== undefined &&
          target.sequence !== undefined &&
          current.sequence !== undefined &&
          target.sequence > current.sequence)
      ) {
        issues.push({
          code: "TRUSTED_HISTORY_INVALID",
          message: `Rollback target contains a forward change for ${target.id}`,
          entryId: target.id
        });
      }
    }
  }
  if (issues.length > 0) {
    return deepFreeze({
      schemaVersion: 1 as const,
      valid: false,
      status: "invalid" as const,
      currentLockDigest: safeCurrent.digest,
      targetLockDigest,
      diff: [],
      issues
    });
  }
  const targetLock = createPackLock(
    historical.lock.packs,
    historical.lock.generatedAt
  );
  const status = targetLock.digest === safeCurrent.digest ? "current" : "rollback";
  return deepFreeze({
    schemaVersion: 1 as const,
    valid: true,
    status,
    currentLockDigest: safeCurrent.digest,
    targetLockDigest,
    targetLock,
    diff: rollbackDiff(safeCurrent, targetLock),
    issues: []
  });
}

export const planTrustedPackRollback = planStandardPackRollback;
