export type SpecStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "rejected"
  | "superseded";

export type SpecSource = "native" | "legacy" | "spec-kit";

export type AcceptanceKind = "positive" | "negative" | "boundary";

export type SpecRiskLevel = "low" | "medium" | "high" | "critical";

export type StructuredContract = Record<string, unknown>;

export interface SpecContracts {
  interface: StructuredContract;
  data: StructuredContract;
  state: StructuredContract;
  permission: StructuredContract;
  exception: StructuredContract;
  quality: StructuredContract;
  observability: StructuredContract;
  metadata?: StructuredContract;
}

export interface AcceptanceCase {
  id: string;
  kind: AcceptanceKind;
  title: string;
  given: string[];
  when: string;
  then: string[];
  targetService?: string;
}

export interface SpecRisk {
  id: string;
  level: SpecRiskLevel;
  description: string;
  mitigation: string;
}

export interface SpecUnknown {
  id: string;
  description: string;
  owner: string;
  resolutionCriteria: string;
}

export interface SpecRevisionContent {
  title: string;
  hypothesis: string;
  outcomes: string[];
  nonGoals: string[];
  targetServices: string[];
  contracts: SpecContracts;
  acceptanceCases: AcceptanceCase[];
  risks: SpecRisk[];
  unknowns: SpecUnknown[];
}

export interface SpecRevision extends SpecRevisionContent {
  specSetId: string;
  revision: number;
  status: SpecStatus;
  source: SpecSource;
  createdAt: string;
  createdBy: string;
  approvedAt?: string;
  approvedBy?: string;
  digest?: string;
}

export interface SpecSet {
  id: string;
  title: string;
  description?: string;
  latestRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SpecRef {
  specSetId: string;
  revision: number;
  digest: string;
}

export type SpecValidationIssueCode =
  | "required"
  | "invalid_type"
  | "invalid_value"
  | "duplicate"
  | "digest_mismatch";

export interface SpecValidationIssue {
  path: string;
  code: SpecValidationIssueCode;
  message: string;
}

export interface SpecValidationResult {
  valid: boolean;
  issues: SpecValidationIssue[];
}

export interface LegacySpecRevisionInput {
  prompt: string;
  acceptanceCriteria: string[];
  taskId?: string;
  title?: string;
  targetServices?: string[];
  createdAt?: string;
  createdBy?: string;
}

export interface NextSpecRevisionChanges
  extends Partial<SpecRevisionContent> {
  createdAt?: string;
  createdBy?: string;
}

export interface ApproveSpecRevisionInput {
  approvedBy: string;
  approvedAt?: string;
  createdBy?: string;
}

export interface SpecRepositoryRecord {
  specSet: SpecSet;
  revisions: SpecRevision[];
}

export interface SpecKitImportOptions {
  specSetId?: string;
  revision?: number;
  targetServices?: string[];
  createdAt?: string;
  createdBy?: string;
}

export interface NativeSpecDocument {
  apiVersion: "mn.dev/spec/v1";
  kind: "SpecRevision";
  revision: SpecRevision;
}
