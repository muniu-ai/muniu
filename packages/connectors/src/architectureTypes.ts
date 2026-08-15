import type { ContractRef, Service } from "@mn/core";

export type DependencyKind = "sync" | "async" | "data";
export type DataResourceKind = "database" | "redis" | "topic" | "object-store";
export type DataResourceRole =
  | "owner"
  | "reader"
  | "writer"
  | "publisher"
  | "consumer";

export interface ManifestDependency {
  readonly service: string;
  readonly kind: DependencyKind;
  readonly contract?: string;
}

export interface ManifestDataResource {
  readonly kind: DataResourceKind;
  readonly name: string;
  readonly role: DataResourceRole;
  readonly lifecycle?: string;
}

export interface ManifestObservability {
  readonly metrics: readonly string[];
  readonly traces: readonly string[];
  readonly logs: readonly string[];
  readonly alerts: readonly string[];
}

export interface ManifestDeployment {
  readonly unit: string;
  readonly rollbackCommand?: string;
}

export interface ProjectManifestService {
  readonly id: string;
  readonly path: string;
  readonly owners: readonly string[];
  readonly language?: string;
  readonly contracts?: readonly ContractRef[];
  readonly dependencies: readonly ManifestDependency[];
  readonly data: readonly ManifestDataResource[];
  readonly commands: Readonly<Record<string, string>>;
  readonly observability: ManifestObservability;
  readonly deployment?: ManifestDeployment;
}

export interface ConsistencyBoundary {
  readonly id: string;
  readonly participants: readonly string[];
  readonly strategy: "saga" | "transactional-outbox" | "eventual" | "two-phase-commit";
}

export interface ProjectManifest {
  readonly apiVersion: "mn.dev/project/v1";
  readonly kind: "Project";
  readonly metadata: Readonly<{ id: string; owner?: string }>;
  readonly services: readonly ProjectManifestService[];
  readonly consistency: readonly ConsistencyBoundary[];
}

export interface ArchitectureDependency extends ManifestDependency {
  readonly source: string;
  readonly discoveredFrom: "manifest" | "package";
}

export interface ArchitectureService extends Service {
  readonly relativePath: string;
  readonly dependencies: readonly ArchitectureDependency[];
  readonly data: readonly ManifestDataResource[];
  readonly migrations: readonly string[];
  readonly commands: Readonly<Record<string, string>>;
  readonly observability: ManifestObservability;
  readonly deployment?: ManifestDeployment;
}

export type ImpactLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export type ArchitectureIssueCode =
  | "MISSING_OWNER"
  | "UNKNOWN_DEPENDENCY"
  | "SHARED_DATABASE"
  | "SHARED_REDIS_NAMESPACE"
  | "TOPIC_MULTI_OWNER"
  | "MISSING_ROLLBACK"
  | "MISSING_OBSERVABILITY"
  | "CROSS_SERVICE_WITHOUT_CONSISTENCY";

export interface ArchitectureIssue {
  readonly code: ArchitectureIssueCode;
  readonly level: ImpactLevel;
  readonly message: string;
  readonly services: readonly string[];
  readonly resource?: string;
}

export interface ArchitectureIndex {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly projectOwner?: string;
  readonly rootPath: string;
  readonly manifestPath?: string;
  readonly manifestDigest?: string;
  readonly codeownersPath?: string;
  readonly ciFiles: readonly string[];
  readonly services: readonly ArchitectureService[];
  readonly consistency: readonly ConsistencyBoundary[];
  readonly issues: readonly ArchitectureIssue[];
  readonly warnings: readonly string[];
  readonly digest: string;
}

export type ImpactDimension =
  | "interface"
  | "data"
  | "state"
  | "permission"
  | "exception"
  | "quality"
  | "observability"
  | "compatibility"
  | "regression"
  | "release";

export interface ImpactMatrixEntry {
  readonly dimension: ImpactDimension;
  readonly level: ImpactLevel;
  readonly services: readonly string[];
  readonly clauseIds: readonly string[];
  readonly reasons: readonly string[];
  readonly requiredGates: readonly string[];
}

export type ImpactFindingCode =
  | ArchitectureIssueCode
  | "UNKNOWN_TARGET_SERVICE"
  | "BREAKING_CONTRACT"
  | "CROSS_SERVICE_CHANGE"
  | "SPEC_REVISION_MISMATCH";

export interface ImpactFinding {
  readonly code: ImpactFindingCode;
  readonly level: ImpactLevel;
  readonly message: string;
  readonly services: readonly string[];
}

export interface SpecImpactReport {
  readonly schemaVersion: 1;
  readonly specRef: Readonly<{
    specSetId: string;
    revision: number;
    digest: string;
  }>;
  readonly architectureDigest: string;
  readonly previousSpecDigest?: string;
  readonly overallLevel: ImpactLevel;
  readonly impactedServices: readonly string[];
  readonly matrix: readonly ImpactMatrixEntry[];
  readonly findings: readonly ImpactFinding[];
  readonly requiredGates: readonly string[];
  readonly requiredApprovals: readonly string[];
  readonly trace: Readonly<{
    acceptanceCaseIds: readonly string[];
    contractDimensions: readonly string[];
  }>;
  readonly digest: string;
}
