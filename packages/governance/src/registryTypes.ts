import type {
  GovernanceScope,
  PackLock,
  PackLockEntry,
  StandardPackManifest,
  StandardPackSignature
} from "./types.js";

export type RegistryKeyStatus = "active" | "retired" | "revoked";

export interface PublicKey {
  readonly id: string;
  readonly publicKey: string;
  readonly status?: RegistryKeyStatus;
  /** Retired keys may only verify packs published before this instant. */
  readonly retiredAt?: string;
}

export interface RegistryEntry {
  readonly manifest: StandardPackManifest;
  /** SHA-256 of the strict canonical manifest payload, excluding signature. */
  readonly digest: string;
  readonly scope: GovernanceScope;
  readonly scopeId: string;
  readonly source?: string;
}

export interface ReleaseMetadata {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  /** Digest of RegistryIndex excluding release metadata. */
  readonly registryDigest: string;
  readonly signature?: StandardPackSignature;
}

export interface RegistryIndex {
  readonly schemaVersion: 1;
  readonly entries: readonly RegistryEntry[];
  /** Informational key catalogue. Trust still comes only from TrustProfile. */
  readonly publicKeys?: readonly PublicKey[];
  readonly revokedPublicKeyIds?: readonly string[];
  readonly release?: ReleaseMetadata;
}

export interface TrustProfile {
  readonly id: string;
  readonly requireSignature: boolean;
  readonly requireReleaseMetadata: boolean;
  readonly requireReleaseSignature?: boolean;
  readonly trustedPublicKeys: readonly PublicKey[];
  readonly revokedPublicKeyIds?: readonly string[];
  /** Reject release metadata below this sequence to prevent replay. */
  readonly minimumReleaseSequence?: number;
  /** Deterministic verification clock, primarily supplied by the caller/tests. */
  readonly verificationTime?: string;
}

export type RegistryIssueCode =
  | "INVALID_REGISTRY"
  | "INVALID_MANIFEST"
  | "NON_DECLARATIVE_VALUE"
  | "EXECUTABLE_FIELD_FORBIDDEN"
  | "UNKNOWN_FIELD"
  | "DIGEST_MISMATCH"
  | "SIGNATURE_REQUIRED"
  | "SIGNATURE_INVALID"
  | "SIGNATURE_KEY_REQUIRED"
  | "KEY_NOT_TRUSTED"
  | "KEY_REVOKED"
  | "KEY_RETIRED"
  | "KEY_AMBIGUOUS"
  | "KEY_STATUS_CONFLICT"
  | "RELEASE_REQUIRED"
  | "RELEASE_INVALID"
  | "RELEASE_DIGEST_MISMATCH"
  | "RELEASE_SIGNATURE_REQUIRED"
  | "RELEASE_SIGNATURE_INVALID"
  | "RELEASE_EXPIRED"
  | "RELEASE_SEQUENCE_ROLLBACK"
  | "PACK_RELEASE_INVALID"
  | "PACK_RELEASE_EXPIRED"
  | "PACK_RELEASE_CHAIN_INVALID"
  | "VERSION_DIGEST_CONFLICT"
  | "DOWNGRADE_REQUIRES_ROLLBACK"
  | "LOCK_INVALID"
  | "LOCK_DIGEST_MISMATCH"
  | "TRUSTED_HISTORY_INVALID"
  | "TRUSTED_HISTORY_NOT_FOUND";

export interface RegistryIssue {
  readonly code: RegistryIssueCode;
  readonly message: string;
  readonly path?: string;
  readonly entryId?: string;
  readonly keyId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface StandardPackValidationResult {
  readonly valid: boolean;
  readonly issues: readonly RegistryIssue[];
  readonly manifest?: StandardPackManifest;
}

export type SyncPlanStatus =
  | "new"
  | "update"
  | "current"
  | "downgrade"
  | "invalid";

export interface SyncPlanDiff {
  readonly field:
    | "version"
    | "digest"
    | "sequence"
    | "scope"
    | "scopeId"
    | "source";
  readonly before?: string | number;
  readonly after?: string | number;
}

export interface SyncPlanEntry {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly sequence?: number;
  readonly scope: GovernanceScope;
  readonly scopeId: string;
  readonly source?: string;
  readonly status: SyncPlanStatus;
  readonly current?: PackLockEntry;
  readonly target?: PackLockEntry;
  readonly diff: readonly SyncPlanDiff[];
  readonly signatureVerified: boolean;
  readonly publicKeyId?: string;
  readonly issues: readonly RegistryIssue[];
}

export interface ReleaseVerification {
  readonly sequence: number;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly registryDigest: string;
  readonly signatureVerified: boolean;
  readonly publicKeyId?: string;
}

export interface SyncPlan {
  readonly schemaVersion: 1;
  readonly dryRun: boolean;
  /** Always false: planning never writes state, including when dryRun is false. */
  readonly applied: false;
  readonly valid: boolean;
  readonly changed: boolean;
  readonly registryDigest: string;
  readonly release?: ReleaseVerification;
  readonly entries: readonly SyncPlanEntry[];
  readonly issues: readonly RegistryIssue[];
  readonly proposedLock?: PackLock;
}

export interface TrustedPackLockHistoryEntry {
  readonly lock: PackLock;
  readonly trustedAt: string;
  readonly approvedBy: string;
}

export type RollbackPlanStatus = "rollback" | "current" | "invalid";

export interface RollbackPlan {
  readonly schemaVersion: 1;
  readonly valid: boolean;
  readonly status: RollbackPlanStatus;
  readonly currentLockDigest: string;
  readonly targetLockDigest: string;
  readonly targetLock?: PackLock;
  readonly diff: readonly SyncPlanEntry[];
  readonly issues: readonly RegistryIssue[];
}
