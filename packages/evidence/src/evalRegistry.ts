import type { SpecRef } from "@mn/specs";
import {
  compareCodeUnits,
  declarativeClone,
  deepFreeze,
  digestCanonical,
  exactFields,
  requireDigest,
  requireIdentifier,
  requirePositiveRevision,
  requireTimestamp,
  uniqueIdentifiers
} from "./shared.js";

export type EvalAssetKind =
  | "acceptance_case"
  | "contract_test"
  | "golden_case"
  | "regression_slice"
  | "fixture"
  | "operational_probe";

export type EvalAssetSourceKind =
  | "spec"
  | "generated"
  | "incident"
  | "regression"
  | "manual";

export interface EvalAssetSource {
  readonly kind: EvalAssetSourceKind;
  readonly ref: string;
  readonly digest?: string;
}

export interface EvalAssetRevision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly kind: EvalAssetKind;
  readonly title: string;
  readonly specRef: SpecRef;
  readonly specClauseIds: readonly string[];
  readonly serviceIds: readonly string[];
  readonly owner: string;
  readonly source: EvalAssetSource;
  readonly contentRef: string;
  readonly contentDigest: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly supersedesDigest?: string;
  readonly digest: string;
}

export type CreateEvalAssetInput = Omit<EvalAssetRevision, "schemaVersion" | "digest">;

const ASSET_FIELDS = new Set([
  "id",
  "revision",
  "kind",
  "title",
  "specRef",
  "specClauseIds",
  "serviceIds",
  "owner",
  "source",
  "contentRef",
  "contentDigest",
  "createdAt",
  "createdBy",
  "supersedesDigest"
]);
const SPEC_REF_FIELDS = new Set(["specSetId", "revision", "digest"]);
const SOURCE_FIELDS = new Set(["kind", "ref", "digest"]);
const ASSET_KINDS = new Set<EvalAssetKind>([
  "acceptance_case",
  "contract_test",
  "golden_case",
  "regression_slice",
  "fixture",
  "operational_probe"
]);
const SOURCE_KINDS = new Set<EvalAssetSourceKind>([
  "spec",
  "generated",
  "incident",
  "regression",
  "manual"
]);

export function createEvalAssetRevision(input: CreateEvalAssetInput): EvalAssetRevision {
  const safe = declarativeClone(input) as unknown as Record<string, unknown>;
  exactFields(safe, ASSET_FIELDS, "asset");
  if (!ASSET_KINDS.has(safe.kind as EvalAssetKind)) {
    throw new TypeError("asset.kind is unsupported");
  }
  const specRef = normalizeSpecRef(safe.specRef);
  const source = normalizeSource(safe.source);
  const revision = requirePositiveRevision(safe.revision, "asset.revision");
  const supersedesDigest =
    safe.supersedesDigest === undefined
      ? undefined
      : requireDigest(safe.supersedesDigest, "asset.supersedesDigest");
  if (revision === 1 && supersedesDigest !== undefined) {
    throw new TypeError("asset revision 1 cannot supersede another revision");
  }
  if (revision > 1 && supersedesDigest === undefined) {
    throw new TypeError("asset revisions after 1 require supersedesDigest");
  }
  const semantic = {
    schemaVersion: 1 as const,
    id: requireIdentifier(safe.id, "asset.id"),
    revision,
    kind: safe.kind as EvalAssetKind,
    title: requireIdentifier(safe.title, "asset.title"),
    specRef,
    specClauseIds: requireNonEmptySet(safe.specClauseIds, "asset.specClauseIds"),
    serviceIds: requireNonEmptySet(safe.serviceIds, "asset.serviceIds"),
    owner: requireIdentifier(safe.owner, "asset.owner"),
    source,
    contentRef: requireIdentifier(safe.contentRef, "asset.contentRef"),
    contentDigest: requireDigest(safe.contentDigest, "asset.contentDigest"),
    createdAt: requireTimestamp(safe.createdAt, "asset.createdAt"),
    createdBy: requireIdentifier(safe.createdBy, "asset.createdBy"),
    ...(supersedesDigest ? { supersedesDigest } : {})
  };
  return deepFreeze({ ...semantic, digest: digestCanonical(semantic) });
}

export class EvalAssetRegistry {
  readonly #byId = new Map<string, EvalAssetRevision[]>();

  register(input: CreateEvalAssetInput): EvalAssetRevision {
    const revision = createEvalAssetRevision(input);
    const history = this.#byId.get(revision.id) ?? [];
    const current = history.at(-1);
    if (current === undefined) {
      if (revision.revision !== 1) throw new Error("first asset revision must be 1");
    } else {
      if (revision.revision !== current.revision + 1) {
        throw new Error(`asset ${revision.id} expected revision ${current.revision + 1}`);
      }
      if (revision.supersedesDigest !== current.digest) {
        throw new Error(`asset ${revision.id} does not supersede its current digest`);
      }
      if (Date.parse(revision.createdAt) < Date.parse(current.createdAt)) {
        throw new Error(`asset ${revision.id} createdAt cannot move backwards`);
      }
    }
    history.push(revision);
    this.#byId.set(revision.id, history);
    return revision;
  }

  get(id: string, revision?: number): EvalAssetRevision | undefined {
    const history = this.#byId.get(requireIdentifier(id, "asset id"));
    if (!history) return undefined;
    if (revision === undefined) return history.at(-1);
    requirePositiveRevision(revision, "asset revision");
    return history.find((candidate) => candidate.revision === revision);
  }

  list(filter: {
    kind?: EvalAssetKind;
    specClauseId?: string;
    serviceId?: string;
    owner?: string;
  } = {}): readonly EvalAssetRevision[] {
    const latest = [...this.#byId.values()]
      .map((history) => history.at(-1)!)
      .filter((asset) => filter.kind === undefined || asset.kind === filter.kind)
      .filter(
        (asset) =>
          filter.specClauseId === undefined ||
          asset.specClauseIds.includes(filter.specClauseId)
      )
      .filter(
        (asset) => filter.serviceId === undefined || asset.serviceIds.includes(filter.serviceId)
      )
      .filter((asset) => filter.owner === undefined || asset.owner === filter.owner)
      .sort((left, right) => compareCodeUnits(left.id, right.id));
    return deepFreeze(latest);
  }
}

function normalizeSpecRef(value: unknown): SpecRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("asset.specRef must be an object");
  }
  const ref = value as Record<string, unknown>;
  exactFields(ref, SPEC_REF_FIELDS, "asset.specRef");
  return {
    specSetId: requireIdentifier(ref.specSetId, "asset.specRef.specSetId"),
    revision: requirePositiveRevision(ref.revision, "asset.specRef.revision"),
    digest: requireDigest(ref.digest, "asset.specRef.digest")
  };
}

function normalizeSource(value: unknown): EvalAssetSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("asset.source must be an object");
  }
  const source = value as Record<string, unknown>;
  exactFields(source, SOURCE_FIELDS, "asset.source");
  if (!SOURCE_KINDS.has(source.kind as EvalAssetSourceKind)) {
    throw new TypeError("asset.source.kind is unsupported");
  }
  return {
    kind: source.kind as EvalAssetSourceKind,
    ref: requireIdentifier(source.ref, "asset.source.ref"),
    ...(source.digest === undefined
      ? {}
      : { digest: requireDigest(source.digest, "asset.source.digest") })
  };
}

function requireNonEmptySet(value: unknown, field: string): string[] {
  const result = uniqueIdentifiers(value, field);
  if (result.length === 0) throw new TypeError(`${field} cannot be empty`);
  return result;
}
