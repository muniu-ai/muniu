import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync, type Dirent } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  cleanupShellEnvConflicts,
  inspectLocalConfig,
  projectClaudeProxyConfig,
  projectClaudeProvider,
  projectCodexProxyConfig,
  projectCodexProvider,
  redactConfigContent,
  restoreLiveConfigProjection,
  restoreLiveConfigProjectionSet
} from "@mn/config-manager";
import { indexRepository } from "@mn/connectors";
import {
  CLASSIC_WORKFLOW_REF,
  DEFAULT_POLICY,
  executionCandidateCount,
  executionRuntimeIds,
  executionTargets,
  isTerminalRunStatus,
  normalizeStrategy,
  resolveTaskWorkflowRef,
  validateTaskWorkflowBindings,
  validateTaskPolicy
} from "@mn/core";
import type {
  AgentProvider,
  AgentRuntimeId,
  AgentTask,
  ArtifactRef,
  GateArtifactV2,
  GateResultV2,
  Project,
  RunEvent,
  RunRecord
} from "@mn/core";
import {
  MockExecutor,
  createDefaultExecutors,
  type BuiltinAgentRunner
} from "@mn/executors";
import { createWorkspaceTools } from "@mn/agent-tools";
import {
  bootRuntime,
  type MuniuRuntime,
  type RuntimeProfileId
} from "@mn/runtime";
import {
  activatePromptPreset,
  discoverSkillSources,
  installSkill,
  projectMcpServer,
  syncSkillRegistry,
  uninstallSkill,
  type McpServerRecord
} from "@mn/extensions";
import {
  LocalProxyServer,
  type ProviderUsagePreparationIntent
} from "@mn/local-proxy";
import {
  createProviderInputFromPreset,
  maskSecret,
  normalizeProviderApp,
  providerSupportsApp
} from "@mn/provider-catalog";
import type {
  ManagedAgentApp,
  ProviderCreateInput,
  ProviderHealthRecord,
  ProviderModel,
  ProviderRecord,
  ProviderSecretRef
} from "@mn/provider-catalog";
import { FileLocalStore, LocalSecretVault, SqliteLocalStore, defaultMniuRoot } from "@mn/store";
import {
  createWorkspaceSnapshot,
  GovernedRunOrchestrator,
  RunOrchestrator,
  parseGateResultV2
} from "@mn/worker";
import {
  createApprovalDecision,
  validateGovernedRunStateAgainstHarness,
  type ApprovalDecision,
  type GovernedRunState,
  type LoopBudgetMeasurementProof
} from "@mn/loop";
import { RunJobLeaseManager, type RunJobLease } from "./runJobLease.js";
import {
  RunJobQueue,
  type PartialWorkerCapabilitySet,
  type PartialWorkerRequirements,
  type RunJobQueueItem,
  type SandboxEnforcementLevel
} from "./runJobQueue.js";
import {
  defaultControlPlaneSpecRepository,
  registerControlPlaneRoutes
} from "./controlPlane.js";
import {
  AgentApprovalCoordinator
} from "./agentApprovalCoordinator.js";
import {
  AgentSessionServiceError,
  LocalMockAgentSessionService
} from "./agentSessionService.js";
import { createProductionAgentRuntimeFactory } from "./agentRuntimeFactory.js";
import { registerAgentSessionRoutes } from "./agentSessionRoutes.js";
import { createEnterpriseAgentSessionStore } from "./enterpriseAgentSessionStore.js";
import { EnterpriseBuiltinAgentBroker } from "./enterpriseBuiltinAgentBroker.js";
import { EnterpriseBuiltinAgentPersistence } from "./enterpriseBuiltinAgentPersistence.js";
import { registerEnterpriseBuiltinAgentRoutes } from "./enterpriseBuiltinAgentRoutes.js";
import {
  registerEvidenceRoutes,
  type EvidenceRouteOptions
} from "./evidenceRoutes.js";
import type {
  EvidenceReferenceQuery,
  ResolvedEvidenceReference
} from "./evidenceTruth.js";
import { prepareGovernedRunBindings } from "./governedRunBindings.js";
import type { FileSpecRepository, SpecRef, SpecRevision } from "@mn/specs";
import {
  sha256Canonical,
  type TrustProfile,
  type VersionedGovernanceRef
} from "@mn/governance";
import type { RequestContext } from "@mn/core";
import type {
  SandboxLeaseAttestation,
  SandboxRuntimeImage
} from "@mn/harness";
import {
  RunJobWorkerRegistry,
  summarizeRunJobWorkers
} from "./runJobWorkers.js";
import {
  BUILTIN_DEFAULT_STANDARD_PACK,
  LOCAL_TENANT_ID,
  MemoryStore,
  type AuditEvent,
  type GateArtifactHandleRecord
} from "./store.js";
import {
  buildCapabilitiesDocument,
  buildHarnessProfilesDocument,
  buildWorkflowsDocument,
  createDefaultRuntimeCapabilityCatalog,
  normalizeRuntimeCapabilityCatalog,
  type RuntimeCapabilityDescriptor,
  type RuntimeCapabilityCatalog
} from "./capabilities.js";
import {
  exportLocalSession,
  estimateProxyRequestLogCostUsd,
  indexLocalSessions,
  pricingCatalogFromProviders,
  readLocalSession,
  summarizeProxyRequestLogs,
  usageModels
} from "@mn/usage";
import {
  EnterpriseJwtAuthenticator,
  localRequestContext,
  principalAllows,
  roleAllows,
  workerOwnerMatchesPrincipal,
  type EnterpriseAuthOptions
} from "./enterpriseAuth.js";
import {
  enterpriseRouteAllows,
  normalizeEnterpriseProjectRoots,
  resolveEnterpriseProjectRoot,
  validateEnterpriseExternalRunFilesystem
} from "./enterpriseSurface.js";
import {
  EnterprisePostgresRuntime,
  PendingProviderUsageReservationsError,
  ProviderUsageReconciliationConflictError,
  assertProviderUsageAccountingFinalized,
  type EnterpriseMetadataWrite,
  type EnterprisePostgresOptions,
  type ProviderUsageRequestSnapshot,
  type ProviderUsageReconciliationEvidence
} from "./enterprisePostgres.js";
import {
  ENTERPRISE_METADATA_KINDS,
  restoreEnterpriseSnapshot
} from "./enterpriseState.js";
import {
  S3CompatibleArtifactStore,
  s3CredentialsFromEnvironment,
  s3RegionFromEnvironment,
  type S3Credentials
} from "./artifactRemoteStore.js";
import {
  ProviderUsageTerminalJournal,
  type ProviderUsageTerminalJournalIntegrityProfile
} from "./providerUsageTerminalJournal.js";
import {
  OtlpHttpTelemetry,
  type HttpServerSpan,
  type OtlpHttpTelemetryOptions
} from "./telemetry.js";
import {
  finalizedDomainResource,
  parseDomainAuditResponse,
  prepareDomainAuditPlans,
  type DomainAuditPlan
} from "./domainAudit.js";
import {
  issueSandboxAttestation,
  verifyIssuedSandboxAttestation,
  verifySandboxAttestation
} from "./sandboxAttestation.js";
import { RunScopedCas, type RunScopedCasObjectRef } from "./runScopedCas.js";
import { sourceSnapshotRefFromPayload } from "./sourceSnapshotBinding.js";
import {
  createGateArtifactHandleRecord,
  findIdempotentGateArtifactRecord,
  gateArtifactFromRecord,
  resolveVerifiedGateArtifact,
  validateEnterpriseGateArtifactHandles
} from "./gateArtifactCas.js";
import {
  DockerRuntimeVerifier,
  type SandboxRuntimeVerifier
} from "./dockerRuntimeVerifier.js";
import {
  KubernetesRuntimeVerifier,
  type KubernetesRuntimeVerifierOptions
} from "./kubernetesRuntimeVerifier.js";
import { KubernetesAuthoritativeGateAuthority } from "./kubernetesAuthoritativeGateAuthority.js";
import {
  issueSandboxRuntimeProof,
  sandboxExecutionMatchesAttestation,
  verifyIssuedSandboxRuntimeProof,
  verifySandboxRuntimeProof
} from "./sandboxRuntimeProof.js";
import {
  applyFailClosedUnpricedCost,
  authoritativeProxyUsage,
  issueLoopBudgetMeasurement,
  verifyLoopBudgetMeasurement,
  type AuthoritativeProxyUsage
} from "./loopBudgetMeasurement.js";
import {
  LOOP_DIFF_MANIFEST_CONTENT_TYPE,
  measureAuthoritativeLoopWorkspaceDiff,
  resolveAuthoritativeCandidateWorkspace,
  measureLoopDiffManifest
} from "./loopDiffMeasurement.js";
import {
  createEnterpriseProviderUsageReceiptVerifier,
  issueProviderUsageReceipt
} from "./providerUsageReceipt.js";
import {
  authorizeEnterpriseGateCheckpoint,
  DockerAuthoritativeGateAuthority,
  verifiedReportedGateResultsDigest,
  verifyAuthoritativeGateReceipt,
  type AuthoritativeGateAuthority,
  type EnterpriseGateAuthorizationDecision
} from "./authoritativeGateVerification.js";
import {
  evaluateEnterpriseBudgetLease,
  type EnterpriseBudgetLeaseDecision
} from "./enterpriseBudgetLease.js";
import {
  createProviderUsageEvidenceVerifier,
  ProviderUsageEvidenceInvalidError,
  ProviderUsageEvidenceVerificationUnavailableError,
  type ProviderUsageEvidenceTrustProfile
} from "./providerUsageEvidenceTrust.js";

const execFileAsync = promisify(execFile);

export type ArtifactRemoteStoreType = "filesystem" | "s3" | "gcs";

export interface ArtifactRemoteStoreOptions {
  type?: ArtifactRemoteStoreType;
  rootDir?: string;
  bucket?: string;
  prefix?: string;
  endpointUrl?: string;
  region?: string;
  credentials?: S3Credentials;
  requestTimeoutMs?: number;
}

export interface ProviderModelCatalogSyncSchedulerOptions {
  intervalMs?: number;
  app?: ManagedAgentApp;
  providerIds?: string[];
  limit?: number;
}

export interface DiagnosticLogFileSummary {
  relativePath: string;
  bytes: number;
  modifiedAt: string;
  truncated: boolean;
  tail: string;
}

export interface DiagnosticLogCollectionSummary {
  root: string;
  maxFiles: number;
  maxTailBytes: number;
  files: DiagnosticLogFileSummary[];
  omittedFiles: number;
}

export interface BuildServerOptions {
  store?: MemoryStore;
  apiStatePath?: string;
  localStore?: FileLocalStore;
  secretVault?: LocalSecretVault;
  homeDir?: string;
  mniuRoot?: string;
  workspaceRoot?: string;
  useMockExecutors?: boolean;
  autoResumeRuns?: boolean;
  autoResumePendingRuns?: boolean;
  artifactStoreQuota?: {
    maxBytes?: number;
    keepLatestRuns?: number;
  };
  artifactRemoteStore?: ArtifactRemoteStoreOptions;
  /** Test/remote-broker seam. Production omits this and reads configured S3. */
  providerUsageEvidenceLoader?: (input: {
    readonly bucket: string;
    readonly key: string;
    readonly uri: string;
  }) => Promise<Buffer | undefined>;
  /** Provider/invoice authorities trusted to settle unknown dispatches exactly.
   * When omitted, conservative reconciliation remains available but exact
   * reconciliation fails closed. */
  providerUsageEvidenceTrustProfile?: ProviderUsageEvidenceTrustProfile;
  providerUsageTerminalJournalIntegrityProfile?:
    ProviderUsageTerminalJournalIntegrityProfile;
  providerModelCatalogSyncScheduler?:
    | false
    | ProviderModelCatalogSyncSchedulerOptions;
  capabilityCatalog?: RuntimeCapabilityCatalog;
  specRepository?: FileSpecRepository;
  runtimeProfile?: "local" | "enterprise";
  runtimeProfilePath?: string;
  runtimeCliPatchPath?: string;
  runtimeHmr?: boolean;
  /** Internal governed provider proxy started with the enterprise API. */
  enterpriseProxy?: {
    readonly host: string;
    readonly port: number;
    readonly publicBaseUrl: string;
  };
  bindHost?: string;
  auth?: EnterpriseAuthOptions;
  corsAllowlist?: readonly string[];
  /**
   * Enterprise metadata, transactional queue and append-only audit backend.
   * Passing false is reserved for isolated route/unit tests; the executable
   * enterprise profile never opts out.
   */
  enterprisePostgres?: EnterprisePostgresOptions | false;
  /** Stable replica identity used by the durable builtin execution owner
   * lease. Kubernetes supplies the API Pod name through the Downward API. */
  enterpriseBuiltinInstanceId?: string;
  /** false is reserved for isolated enterprise unit tests. */
  telemetry?: OtlpHttpTelemetryOptions | false;
  /** false is reserved for isolated enterprise unit tests. */
  standardPackTrustProfile?: TrustProfile | false;
  /** API-owned HMAC key for enterprise sandbox leases. false is reserved for
   * isolated tests that never claim governed work. */
  sandboxAttestationKey?: string | false;
  /** Control-plane approved immutable container image. Required whenever an
   * enterprise server issues sandbox attestations; worker CLI flags cannot
   * override this trust anchor. */
  enterpriseSandboxImage?: SandboxRuntimeImage | false;
  /** Trusted authority used to inspect enterprise runtimes. The default talks
   * to the server-controlled local Docker daemon; false is test-only. */
  sandboxRuntimeVerifier?: SandboxRuntimeVerifier | false;
  /** Enables API-authoritative Kubernetes Pod inspection. The same shared PVC
   * is mounted into API and Worker; candidate Pods receive only lease subPaths. */
  kubernetesSandbox?: KubernetesRuntimeVerifierOptions;
  /** API-side complete Gate plan authority. The default re-executes command
   * gates through the inspected Docker runtime. Injection is for tests and
   * remote broker implementations; false is isolated-test only. */
  authoritativeGateAuthority?: AuthoritativeGateAuthority | false;
  /** Trusted control-plane override used by remote Gate brokers and route
   * tests. Production defaults to the built-in API coordinator. */
  authoritativeGateCheckpointAuthorizer?: (input: {
    readonly existing: RunRecord | undefined;
    readonly incoming: RunRecord;
    readonly state: GovernedRunState | undefined;
    readonly previousState: GovernedRunState | undefined;
    readonly item: RunJobQueueItem;
    readonly tenantId: string;
    readonly ownerId: string;
    readonly claimToken: string;
  }) => Promise<EnterpriseGateAuthorizationDecision>;
  /**
   * Repository roots enterprise callers may register. The executable profile
   * requires at least one root; false is reserved for isolated route tests.
   */
  enterpriseProjectRoots?: readonly string[] | false;
  learningProposalSignatureVerifier?: EvidenceRouteOptions["verifyLearningProposalSignature"];
  /** Local-only test/embedding seam. The server owns disposal when supplied. */
  agentSessionService?: LocalMockAgentSessionService;
}

const projectSchema = z.object({
  name: z.string().min(1),
  rootPath: z.string().min(1),
  defaultBranch: z.string().default("main")
});

const specRefSchema = z.object({
  specSetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

const versionedGovernanceRefSchema = z.object({
  id: z.string().min(1).refine((value) => value === value.trim()),
  version: z.string().min(1).refine((value) => value === value.trim()),
  digest: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).strict();

const executionStrategyCommonSchema = {
  sandbox: z
    .enum(["read-only", "workspace-write", "isolated-worktree"])
    .optional(),
  requiredGates: z
    .array(z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u))
    .optional(),
  humanApproval: z.enum(["never", "on-risk", "before-merge"]).optional(),
  timeoutSeconds: z.number().int().positive().optional()
};

const executionStrategySchema = z.union([
  z.object({
    schemaVersion: z.literal(2),
    targets: z.array(z.object({
      runtimeId: z.enum(["builtin", "claude", "codex"]),
      providerId: z.string().min(1).optional(),
      modelId: z.string().min(1).optional(),
      candidates: z.number().int().positive()
    }).strict()).min(1),
    ...executionStrategyCommonSchema
  }).strict(),
  z.object({
    schemaVersion: z.literal(1).optional(),
    providers: z.array(z.enum(["claude", "codex"])).optional(),
    candidates: z.number().int().positive().optional(),
    ...executionStrategyCommonSchema
  }).strict()
]);

const taskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  intent: z
    .enum(["analyze", "design", "implement", "review", "repair"])
    .default("implement"),
  targetServices: z.array(z.string()).default([]),
  prompt: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
  specRef: specRefSchema.optional(),
  workflowRef: versionedGovernanceRefSchema.optional(),
  harnessProfileRef: versionedGovernanceRefSchema.optional(),
  strategy: executionStrategySchema.optional()
});

const providerConsumerSchema = z.enum(["claude", "codex", "agent"]);
const providerAppSchema = z.enum(["claude", "codex", "agent", "unified"]);
const managedAppSchema = z.enum(["claude", "codex"]);
const providerModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  inputTokenUsdPerMillion: z.number().nonnegative().optional(),
  outputTokenUsdPerMillion: z.number().nonnegative().optional(),
  cachedInputTokenUsdPerMillion: z.number().nonnegative().optional(),
  cacheCreationInputTokenUsdPerMillion: z.number().nonnegative().optional(),
  cacheReadInputTokenUsdPerMillion: z.number().nonnegative().optional(),
  reasoningOutputTokenUsdPerMillion: z.number().nonnegative().optional()
});
const providerModelCatalogModelsSchema = z
  .array(providerModelSchema)
  .min(1)
  .superRefine((models, context) => {
    const seen = new Set<string>();
    for (const [index, model] of models.entries()) {
      if (seen.has(model.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: `duplicate model id: ${model.id}`
        });
      }
      seen.add(model.id);
    }
  });
const providerModelCatalogDocumentSchema = z.union([
  providerModelCatalogModelsSchema,
  z.object({
    version: z.number().optional(),
    source: z.string().optional(),
    updatedAt: z.string().optional(),
    models: providerModelCatalogModelsSchema
  })
]);
const providerEnterpriseCapabilitiesSchema = z.object({
  idempotency: z.object({
    strength: z.literal("strong"),
    headerName: z.string().min(1).max(128)
      .regex(/^(?:idempotency-key|x-[a-z0-9-]*idempotency(?:-key)?)$/iu)
  }).strict().optional(),
  retryableFailureResponsesUnbilled: z.literal(true).optional()
}).strict();
const providerCreateSchema = z.object({
  presetId: z.string().optional(),
  app: providerAppSchema.optional(),
  name: z.string().optional(),
  kind: z
    .enum(["official", "openai_compatible", "anthropic_compatible", "relay", "custom"])
    .optional(),
  apiFormat: z
    .enum(["anthropic_messages", "openai_responses", "openai_chat"])
    .optional(),
  baseUrl: z.string().url().optional(),
  defaultModel: z.string().optional(),
  modelReasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  disableResponseStorage: z.boolean().optional(),
  wireApi: z.enum(["responses", "chat"]).optional(),
  modelCatalog: z.array(providerModelSchema).optional(),
  enterpriseCapabilities: providerEnterpriseCapabilitiesSchema.optional(),
  config: z.record(z.unknown()).optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional()
});

const providerPatchSchema = z.object({
  name: z.string().optional(),
  baseUrl: z.string().url().optional(),
  defaultModel: z.string().optional(),
  modelReasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  disableResponseStorage: z.boolean().optional(),
  wireApi: z.enum(["responses", "chat"]).optional(),
  modelCatalog: z.array(providerModelSchema).optional(),
  enterpriseCapabilities: providerEnterpriseCapabilitiesSchema.optional(),
  config: z.record(z.unknown()).optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional()
});

const providerExportQuerySchema = z.object({
  app: providerConsumerSchema.optional()
});

const providerImportSecretRefSchema = z.object({
  type: z.literal("env"),
  ref: z.string().min(1)
});

const providerImportItemSchema = z.object({
  app: providerAppSchema,
  name: z.string().min(1),
  kind: z.enum(["official", "openai_compatible", "anthropic_compatible", "relay", "custom"]),
  apiFormat: z.enum(["anthropic_messages", "openai_responses", "openai_chat"]),
  baseUrl: z.string().url(),
  defaultModel: z.string().min(1),
  modelReasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  disableResponseStorage: z.boolean().optional(),
  wireApi: z.enum(["responses", "chat"]).optional(),
  modelCatalog: z.array(providerModelSchema).optional(),
  enterpriseCapabilities: providerEnterpriseCapabilitiesSchema.optional(),
  config: z.record(z.unknown()).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  apiKeyRef: providerImportSecretRefSchema.optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional()
});

const providerImportSchema = z.object({
  version: z.number().optional(),
  dryRun: z.boolean().default(true),
  providers: z.array(providerImportItemSchema).min(1)
});

const providerModelCatalogSyncSchema = z
  .object({
    dryRun: z.boolean().default(true),
    mode: z.enum(["replace", "merge"]).default("replace"),
    maxAgeDays: z.coerce.number().int().positive().max(3650).default(30),
    savePolicy: z.boolean().default(false),
    refreshIntervalHours: z.coerce.number().int().positive().max(87_600).optional(),
    sourceUrl: z.string().url().optional(),
    catalog: providerModelCatalogDocumentSchema.optional()
  })
  .superRefine((body, context) => {
    if (Boolean(body.sourceUrl) === Boolean(body.catalog)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of sourceUrl or catalog is required.",
        path: ["sourceUrl"]
      });
    }
    if (body.savePolicy && !body.sourceUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "savePolicy requires sourceUrl.",
        path: ["savePolicy"]
      });
    }
  });
const providerModelCatalogAuditQuerySchema = z.object({
  maxAgeDays: z.coerce.number().int().positive().max(3650).optional()
});
const providerModelCatalogSyncDueSchema = z.object({
  dryRun: z.boolean().default(true),
  app: managedAppSchema.optional(),
  providerIds: z.array(z.string().min(1)).optional(),
  limit: z.coerce.number().int().positive().max(100).optional()
});

const deepLinkPreviewSchema = z.object({
  url: z.string().min(1)
});

const deepLinkImportSchema = deepLinkPreviewSchema.extend({
  dryRun: z.boolean().default(true)
});

const providerDuplicateSchema = z.object({
  name: z.string().optional(),
  app: providerAppSchema.optional(),
  enabled: z.boolean().default(false)
});

const providerEnableSchema = z.object({
  app: managedAppSchema.optional(),
  homeDir: z.string().optional(),
  dryRun: z.boolean().default(false),
  mode: z
    .enum([
      "official",
      "third_party_preserve_auth",
      "api_key_auth_file",
    "local_route"
  ])
  .optional()
});
const providerRestoreSchema = z.object({
  app: managedAppSchema.optional(),
  dryRun: z.boolean().default(true)
});
const providerTestEndpointSchema = z.object({
  timeoutMs: z.coerce.number().int().positive().max(30_000).default(5_000)
});
const proxyStartSchema = z.object({
  port: z.number().int().min(0).optional(),
  host: z.string().min(1).optional()
});
const proxyStopSchema = z.object({
  dryRun: z.boolean().default(false)
});
const proxyLogQuerySchema = z.object({
  app: managedAppSchema.optional(),
  providerId: z.string().optional(),
  runId: z.string().optional(),
  candidateId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional()
});
const usageQuerySchema = z.object({
  app: managedAppSchema.optional(),
  providerId: z.string().optional(),
  runId: z.string().optional(),
  candidateId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional()
});
type UsageRouteQuery = z.infer<typeof usageQuerySchema>;
const providerUsageReconciliationBaseSchema = z.object({
  expectedRecoveryDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  reason: z.string().min(1).max(4_096).refine((value) => value === value.trim()),
  ticket: z.string().min(1).max(512).refine((value) => value === value.trim()),
  evidence: z.object({
    uri: z.string().url().refine((value) => /^s3:/u.test(value)),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    kind: z.enum(["provider", "invoice"])
  }).strict()
});
const providerUsageReconciliationSchema = z.discriminatedUnion("decision", [
  providerUsageReconciliationBaseSchema.extend({
    decision: z.literal("conservative")
  }).strict(),
  providerUsageReconciliationBaseSchema.extend({
    decision: z.literal("exact"),
    app: managedAppSchema,
    providerId: z.string().min(1).max(512),
    providerAccountId: z.string().min(1).max(512).optional(),
    providerRequestId: z.string().min(1).max(512),
    model: z.string().min(1).max(512),
    statusCode: z.number().int().min(0).max(999),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().default(0),
    cacheCreationInputTokens: z.number().int().nonnegative().default(0),
    cacheReadInputTokens: z.number().int().nonnegative().default(0),
    reasoningOutputTokens: z.number().int().nonnegative().default(0),
    authoritativeCostUsd: z.number().nonnegative().finite()
  }).strict()
]);

export function enterpriseProviderUsageConservativeHold(run: RunRecord): {
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly basisDigest: string;
} {
  const maxTokens = run.harnessManifest?.stopConditions.maxTokens;
  const maxCostUsd = run.harnessManifest?.stopConditions.maxCostUsd;
  if (
    !run.harnessManifest ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens! <= 0 ||
    !Number.isFinite(maxCostUsd) ||
    maxCostUsd! <= 0
  ) {
    throw new Error(
      "enterprise provider request has no reliable positive immutable conservative hold"
    );
  }
  return Object.freeze({
    maxTokens: maxTokens!,
    maxCostUsd: maxCostUsd!,
    basisDigest: sha256Canonical({
      schemaVersion: 1,
      runId: run.id,
      harnessDigest: run.harnessManifest.digest,
      stopConditions: run.harnessManifest.stopConditions
    })
  });
}
const optionalBooleanQuerySchema = z.preprocess((value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return raw;
  return parseOptionalBoolean(raw) ?? raw;
}, z.boolean().optional());
const sessionQuerySchema = z.object({
  app: managedAppSchema.optional(),
  homeDir: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  query: z.string().optional(),
  redact: optionalBooleanQuerySchema
});
const runCreateSchema = z.object({
  wait: z.boolean().default(false),
  queueOnly: z.boolean().default(false),
  queuePriority: z.coerce.number().int().min(-1_000).max(1_000).default(0)
});
const runJobQueueStatusQuerySchema = z.object({
  status: z
    .enum(["queued", "running", "completed", "failed", "cancelled", "claimable"])
    .optional()
});
const workerCapabilityNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const workerCapabilitiesSchema = z
  .object({
    providers: z.array(z.enum(["builtin", "claude", "codex"])).default([]),
    languages: z.array(workerCapabilityNameSchema).default([]),
    gateRunnerIds: z.array(workerCapabilityNameSchema).default([]),
    sandboxBackends: z
      .array(
        z
          .object({
            backendId: workerCapabilityNameSchema,
            enforcement: z.enum(["none", "postcheck", "enforced"]),
            capabilities: z.array(workerCapabilityNameSchema).default([])
          })
          .strict()
      )
      .default([]),
    tenantIds: z.array(workerCapabilityNameSchema).default([]),
    tools: z.array(workerCapabilityNameSchema).default([])
  })
  .strict();
const runJobQueueClaimSchema = z.object({
  ownerId: z.string().min(1).optional(),
  capacity: z.coerce.number().int().min(1).max(256).default(1),
  ttlMs: z.coerce.number().int().min(1_000).max(86_400_000).default(30_000),
  capabilities: workerCapabilitiesSchema.optional()
});
const runJobQueueClaimTokenSchema = z.object({
  ownerId: z.string().min(1),
  claimToken: z.string().min(1),
  capacity: z.coerce.number().int().min(1).max(256).default(1),
  ttlMs: z.coerce.number().int().min(1_000).max(86_400_000).default(30_000)
});
const providerUsageReceiptRequestSchema = runJobQueueClaimTokenSchema.extend({
  app: managedAppSchema,
  candidateId: z.string().min(1).max(512).refine(
    (value) => value === value.trim() && !/[\0\r\n]/u.test(value),
    "candidateId must be a safe identifier"
  )
}).strict();
const sandboxRuntimeProofRequestSchema = runJobQueueClaimTokenSchema.extend({
  attestation: z.unknown().refine((value) => value !== undefined),
  runtimeId: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
const runJobWorkerQuerySchema = z.object({
  state: z.enum(["idle", "running", "stale"]).optional(),
  ownerId: z.string().optional()
});
const runJobWorkerHeartbeatSchema = z.object({
  ownerId: z.string().min(1),
  status: z.enum(["idle", "running"]).default("idle"),
  activeRunId: z.string().min(1).optional(),
  activeRunIds: z.array(z.string().min(1)).optional(),
  capacity: z.coerce.number().int().min(1).max(256).default(1),
  ttlMs: z.coerce.number().int().min(1_000).max(86_400_000).default(30_000),
  lastError: z.string().optional(),
  capabilities: workerCapabilitiesSchema.optional()
});
const runJobQueueEventSchema = runJobQueueClaimTokenSchema.extend({
  event: z.object({
    type: z.enum(["status", "stdout", "stderr", "gate", "error"]),
    message: z.string(),
    candidateId: z.string().optional(),
    timestamp: z.string().optional(),
    data: z.unknown().optional()
  })
});
const externalRunRecordSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    status: z.enum([
      "queued",
      "preparing",
      "running",
      "verifying",
      "waiting_approval",
      "completed",
      "failed",
      "cancelled"
    ]),
    candidates: z.array(z.unknown()),
    gates: z.array(z.unknown()),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .passthrough();
const runJobQueueUpdateSchema = runJobQueueClaimTokenSchema.extend({
  run: externalRunRecordSchema,
  governedLoopState: z.unknown().optional()
});
const maxGateArtifactBytes = 16 * 1024 * 1024;
const runJobGateArtifactSchema = runJobQueueClaimTokenSchema.extend({
  candidateId: z.string().min(1).max(512),
  gateResultId: z.string().min(1).max(512),
  gateId: z.string().min(1).max(512),
  artifact: z.object({
    id: z.string().min(1).max(512),
    kind: z.enum(["log", "sarif", "junit", "coverage", "contract", "other"]),
    contentType: z.string().min(1).max(256).refine(
      (value) => value === value.trim() && !/[\r\n\0]/u.test(value),
      "contentType must be a trimmed single-line value"
    ),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    byteLength: z.number().int().min(0).max(maxGateArtifactBytes),
    contentBase64: z.string()
      .max(Math.ceil(maxGateArtifactBytes / 3) * 4)
      .refine(isCanonicalBase64, "contentBase64 must be canonical base64")
  }).strict()
}).strict();
const runJobLoopMeasurementSchema = runJobQueueClaimTokenSchema.extend({
  stageAttemptId: z.string().min(1).max(1_024),
  stage: z.enum([
    "discovery",
    "specification",
    "impact_architecture",
    "implementation",
    "verification",
    "approval_demo",
    "learning"
  ]),
  attempt: z.number().int().positive().max(1_000_000),
  workspaceUri: z.string().min(1).max(4_096).optional(),
  candidateId: z.string().min(1).max(512).optional()
}).strict();
const runApprovalSchema = z.object({
  decision: z.enum(["approve", "reject"]).default("approve"),
  actorId: z.string().min(1).refine((value) => value === value.trim()).default("local-user")
});

function bindRuntimeCapabilityRef(
  ref: { readonly id: string; readonly version: string; readonly digest?: string },
  capabilities: readonly RuntimeCapabilityDescriptor[],
  field: "workflowRef" | "harnessProfileRef"
): VersionedGovernanceRef {
  const capability = capabilities.find(
    (candidate) => candidate.id === ref.id && candidate.version === ref.version
  );
  if (!capability?.digest) {
    throw new TypeError(
      `${field} ${ref.id}@${ref.version} is not a registered immutable capability`
    );
  }
  if (capability.status !== "available") {
    throw new TypeError(
      `${field} ${ref.id}@${ref.version} is not available in this runtime profile`
    );
  }
  if (ref.digest !== undefined && ref.digest !== capability.digest) {
    throw new TypeError(
      `${field} digest does not match ${ref.id}@${ref.version}`
    );
  }
  return Object.freeze({
    id: capability.id,
    version: capability.version,
    digest: capability.digest
  });
}

function workerRequirementsForRun(
  project: Project,
  task: AgentTask,
  run: RunRecord
): PartialWorkerRequirements | undefined {
  const governed =
    task.specRef !== undefined ||
    run.governanceSnapshot !== undefined ||
    run.harnessManifest !== undefined ||
    (run.workflowRef !== undefined && run.workflowRef.id !== CLASSIC_WORKFLOW_REF.id);
  if (!governed) return undefined;
  const manifest = run.harnessManifest;
  const requiredLanguages = project.services
    .filter(
      (service) =>
        task.targetServices.length === 0 || task.targetServices.includes(service.id)
    )
    .map((service) => service.language);
  const requiredGateRunnerIds = manifest
    ? manifest.gatePlan.map((gate) => gate.runnerId)
    : task.strategy.requiredGates;
  const profileId = task.harnessProfileRef?.id ?? "local";
  const minEnforcement: SandboxEnforcementLevel = manifest
    ? manifest.sandbox.enforcement === "enforced" ||
      manifest.sandbox.enforcement === "isolated"
      ? "enforced"
      : manifest.sandbox.enforcement === "postcheck"
        ? "postcheck"
        : "none"
    : profileId === "enterprise"
      ? "enforced"
      : "postcheck";
  return {
    requiredProviders: executionRuntimeIds(task.strategy),
    requiredLanguages: [...new Set(requiredLanguages)],
    requiredGateRunnerIds: [...new Set(requiredGateRunnerIds)],
    sandbox: {
      allowedBackendIds: manifest
        ? [manifest.sandbox.backendId]
        : profileId === "local"
          ? ["worktree-postcheck"]
          : [],
      minEnforcement,
      requiredCapabilities: manifest
        ? [...manifest.sandbox.capabilities]
        : profileId === "enterprise"
          ? [
              "mount-policy",
              "network-policy",
              "resource-limits",
              "secret-injection",
              "tool-allowlist"
            ]
          : ["source-isolation", "diff-postcheck"]
    },
    requiredTools: [...(manifest?.executionPolicy.commandAllowlist ?? [])]
  };
}
const proxyHealthQuerySchema = z.object({
  app: managedAppSchema.optional(),
  providerId: z.string().optional()
});
const proxyHealthResetSchema = z.object({
  app: managedAppSchema.optional(),
  providerId: z.string().min(1)
});
const proxyAppActionSchema = z.object({
  homeDir: z.string().optional(),
  dryRun: z.boolean().default(false)
});
const envCleanupSchema = z.object({
  dryRun: z.boolean().default(true),
  names: z
    .array(
      z.enum(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY"])
    )
    .optional(),
  sources: z
    .array(z.enum(["shell_profile", "launch_agent", "ide_settings"]))
    .optional()
});
const defaultProxyCircuitFailureThreshold = 3;
const defaultProxyCircuitOpenMs = 60_000;
const mcpLocalSecretPrefix = "mniu:local_encrypted:";
const mcpKeychainSecretPrefix = "mniu:keychain:";
const appBindingsSchema = z.array(managedAppSchema).min(1);
const extensionAppQuerySchema = z.object({
  app: managedAppSchema.optional()
});
const mcpServerCreateSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  apps: appBindingsSchema.default(["claude", "codex"]),
  enabled: z.boolean().default(true)
});
const mcpServerPatchSchema = z.object({
  name: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  apps: appBindingsSchema.optional(),
  enabled: z.boolean().optional()
});
const mcpProjectSchema = z.object({
  homeDir: z.string().optional(),
  dryRun: z.boolean().default(false),
  apps: appBindingsSchema.optional()
});
const promptPresetCreateSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
  apps: appBindingsSchema.default(["claude", "codex"])
});
const mcpDeepLinkImportSchema = z.object({
  mcpServers: z.array(mcpServerCreateSchema).min(1)
});
const promptDeepLinkImportSchema = z.object({
  prompts: z.array(promptPresetCreateSchema).min(1)
});
const promptPresetPatchSchema = z.object({
  name: z.string().min(1).optional(),
  content: z.string().optional(),
  apps: appBindingsSchema.optional()
});
const promptActivateSchema = z.object({
  app: managedAppSchema,
  homeDir: z.string().optional(),
  dryRun: z.boolean().default(false)
});
const skillSyncModeSchema = z.enum(["copy", "symlink"]);
const skillCreateSchema = z.object({
  name: z.string().min(1),
  sourcePath: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  apps: appBindingsSchema.default(["claude", "codex"]),
  enabled: z.boolean().default(true)
});
const skillPatchSchema = z.object({
  name: z.string().min(1).optional(),
  sourcePath: z.string().min(1).optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  apps: appBindingsSchema.optional(),
  enabled: z.boolean().optional()
});
const skillInstallSchema = z.object({
  app: managedAppSchema,
  homeDir: z.string().optional(),
  dryRun: z.boolean().default(false),
  mode: skillSyncModeSchema.default("copy")
});
const skillUninstallSchema = z.object({
  app: managedAppSchema,
  homeDir: z.string().optional(),
  dryRun: z.boolean().default(false)
});
const skillDiscoverQuerySchema = z.object({
  homeDir: z.string().optional()
});
const skillRegistryPublicKeySchema = z.object({
  id: z.string().min(1),
  publicKey: z.string().min(1),
  status: z.enum(["active", "retired", "revoked"]).optional()
});
const skillRegistrySyncSchema = z.object({
  registryUrl: z.string().min(1),
  dryRun: z.boolean().default(true),
  requireSignature: z.boolean().default(false),
  requireReleaseMetadata: z.boolean().default(false),
  publicKey: z.string().optional(),
  trustedPublicKeys: z.array(skillRegistryPublicKeySchema).optional(),
  revokedPublicKeyIds: z.array(z.string().min(1)).optional()
});
const skillRegistryTrustProfileSchema = z.object({
  name: z.string().min(1),
  registryUrl: z.string().min(1),
  requireSignature: z.boolean().default(false),
  requireReleaseMetadata: z.boolean().default(false),
  publicKey: z.string().optional(),
  trustedPublicKeys: z.array(skillRegistryPublicKeySchema).default([]),
  revokedPublicKeyIds: z.array(z.string().min(1)).default([])
});
const skillRegistryTrustProfilePatchSchema = z.object({
  name: z.string().min(1).optional(),
  registryUrl: z.string().min(1).optional(),
  requireSignature: z.boolean().optional(),
  requireReleaseMetadata: z.boolean().optional(),
  publicKey: z.string().optional(),
  trustedPublicKeys: z.array(skillRegistryPublicKeySchema).optional(),
  revokedPublicKeyIds: z.array(z.string().min(1)).optional()
});
const skillRegistryProfileSyncSchema = z.object({
  dryRun: z.boolean().default(true)
});
const artifactStoreCleanupSchema = z.object({
  dryRun: z.boolean().default(true),
  scope: z.enum(["local", "remote", "both"]).default("local"),
  maxAgeDays: z.number().nonnegative().optional(),
  keepLatestRuns: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().nonnegative().optional()
});

interface ArtifactStoreQuotaOptions {
  maxBytes: number;
  keepLatestRuns: number;
}

function normalizeArtifactStoreQuota(
  input?: BuildServerOptions["artifactStoreQuota"]
): ArtifactStoreQuotaOptions | undefined {
  const maxBytes = input?.maxBytes ?? readNonNegativeIntEnv("MN_ARTIFACT_STORE_MAX_BYTES");
  if (maxBytes === undefined) return undefined;
  return {
    maxBytes,
    keepLatestRuns:
      input?.keepLatestRuns ??
      readNonNegativeIntEnv("MN_ARTIFACT_STORE_QUOTA_KEEP_LATEST_RUNS") ??
      1
  };
}

function normalizeArtifactRemoteStore(
  input?: BuildServerOptions["artifactRemoteStore"]
): ArtifactRemoteStore | undefined {
  const type = input?.type ?? readArtifactRemoteStoreTypeEnv() ?? "filesystem";
  if (type === "filesystem") {
    const rootDir = input?.rootDir ?? process.env.MN_ARTIFACT_REMOTE_STORE_PATH;
    if (!rootDir || !rootDir.trim()) return undefined;
    return { type, rootDir: resolve(rootDir) };
  }

  const bucket = input?.bucket ?? process.env.MN_ARTIFACT_REMOTE_STORE_BUCKET;
  if (!bucket || !bucket.trim()) {
    throw new Error("Object artifact remote store requires a bucket");
  }
  const rootDir =
    input?.rootDir ??
    process.env.MN_ARTIFACT_OBJECT_STORE_LOCAL_BACKEND_PATH ??
    process.env.MN_ARTIFACT_REMOTE_STORE_PATH;
  if (!rootDir || !rootDir.trim()) {
    throw new Error("Object artifact remote store requires a local backend path");
  }
  const endpointUrl =
    input?.endpointUrl ?? process.env.MN_ARTIFACT_REMOTE_STORE_ENDPOINT_URL;
  const s3Client = type === "s3" && endpointUrl
    ? new S3CompatibleArtifactStore({
        endpointUrl,
        bucket: bucket.trim(),
        region: input?.region ?? s3RegionFromEnvironment(),
        credentials: input?.credentials ?? s3CredentialsFromEnvironment(),
        requestTimeoutMs:
          input?.requestTimeoutMs ??
          readPositiveIntEnv("MN_ARTIFACT_S3_REQUEST_TIMEOUT_MS")
      })
    : undefined;
  return {
    type,
    rootDir: resolve(rootDir),
    bucket: bucket.trim(),
    prefix: normalizeArtifactObjectPrefix(
      input?.prefix ?? process.env.MN_ARTIFACT_REMOTE_STORE_PREFIX
    ),
    endpointUrl,
    ...(s3Client ? { s3Client } : {})
  };
}

function normalizeProviderModelCatalogSyncScheduler(
  input?: BuildServerOptions["providerModelCatalogSyncScheduler"]
): ProviderModelCatalogSyncSchedulerOptions | undefined {
  if (input === false) return undefined;
  const intervalMs =
    input?.intervalMs ??
    readPositiveIntEnv("MN_PROVIDER_MODEL_CATALOG_SYNC_INTERVAL_MS");
  if (intervalMs === undefined) return undefined;
  return {
    intervalMs,
    app: input?.app ?? readManagedAppEnv("MN_PROVIDER_MODEL_CATALOG_SYNC_APP"),
    providerIds:
      input?.providerIds ??
      readCsvEnv("MN_PROVIDER_MODEL_CATALOG_SYNC_PROVIDER_IDS"),
    limit: input?.limit ?? readPositiveIntEnv("MN_PROVIDER_MODEL_CATALOG_SYNC_LIMIT")
  };
}

function readNonNegativeIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function readArtifactRemoteStoreTypeEnv(): ArtifactRemoteStoreType | undefined {
  const raw = process.env.MN_ARTIFACT_REMOTE_STORE_TYPE;
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "filesystem" || value === "s3" || value === "gcs") return value;
  throw new Error("MN_ARTIFACT_REMOTE_STORE_TYPE must be filesystem, s3 or gcs");
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readManagedAppEnv(name: string): ManagedAgentApp | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return managedAppSchema.parse(raw.trim());
}

function readCsvEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

const diagnosticLogExtensions = new Set([
  ".crash",
  ".err",
  ".jsonl",
  ".log",
  ".out",
  ".txt"
]);
const diagnosticAppLogExtensions = new Set([
  ".err",
  ".jsonl",
  ".log",
  ".out",
  ".txt"
]);
const diagnosticCrashReportExtensions = new Set([".crash", ".ips", ".log"]);

async function collectDiagnosticLogs(
  mniuRoot: string,
  options: { maxFiles?: number; maxTailBytes?: number } = {}
): Promise<DiagnosticLogCollectionSummary> {
  return collectDiagnosticFileTails(
    join(mniuRoot, "logs"),
    "logs",
    isDiagnosticLogName,
    { maxFiles: options.maxFiles ?? 20, maxTailBytes: options.maxTailBytes }
  );
}

async function collectDiagnosticCrashReports(
  homeDir: string,
  options: { maxFiles?: number; maxTailBytes?: number } = {}
): Promise<DiagnosticLogCollectionSummary> {
  return collectDiagnosticFileTails(
    join(homeDir, "Library", "Logs", "DiagnosticReports"),
    "DiagnosticReports",
    isMniuCrashReportName,
    { maxFiles: options.maxFiles ?? 10, maxTailBytes: options.maxTailBytes }
  );
}

async function collectDiagnosticAppLogs(
  homeDir: string,
  options: { maxFiles?: number; maxTailBytes?: number } = {}
): Promise<DiagnosticLogCollectionSummary> {
  return collectDiagnosticFileTails(
    join(homeDir, "Library", "Logs", "dev.muniu.desktop"),
    "ApplicationLogs/dev.muniu.desktop",
    isDiagnosticAppLogName,
    { maxFiles: options.maxFiles ?? 20, maxTailBytes: options.maxTailBytes }
  );
}

async function collectDiagnosticFileTails(
  root: string,
  relativeRoot: string,
  includeFile: (name: string) => boolean,
  options: { maxFiles?: number; maxTailBytes?: number } = {}
): Promise<DiagnosticLogCollectionSummary> {
  const maxFiles = options.maxFiles ?? 20;
  const maxTailBytes = options.maxTailBytes ?? 16 * 1024;
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return { root, maxFiles, maxTailBytes, files: [], omittedFiles: 0 };
    }
    throw error;
  }

  const candidates = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && includeFile(entry.name))
        .map(async (entry) => {
          const filePath = join(root, entry.name);
          const info = await stat(filePath);
          return { entry, filePath, info };
        })
    )
  ).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);

  const selected = candidates.slice(0, maxFiles);
  const files = await Promise.all(
    selected.map(async ({ entry, filePath, info }) => {
      const tail = await readFileTail(filePath, info.size, maxTailBytes);
      return {
        relativePath: join(relativeRoot, entry.name),
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        truncated: info.size > maxTailBytes,
        tail: redactDiagnosticText(tail)
      };
    })
  );

  return {
    root,
    maxFiles,
    maxTailBytes,
    files,
    omittedFiles: Math.max(0, candidates.length - selected.length)
  };
}

function isDiagnosticLogName(name: string): boolean {
  const lower = name.toLowerCase();
  return [...diagnosticLogExtensions].some((extension) => lower.endsWith(extension));
}

function isMniuCrashReportName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    (lower.includes("mniu") ||
      lower.includes("muniu") ||
      lower.includes("dev.muniu") ||
      name.includes("木牛")) &&
    [...diagnosticCrashReportExtensions].some((extension) =>
      lower.endsWith(extension)
    )
  );
}

function isDiagnosticAppLogName(name: string): boolean {
  const lower = name.toLowerCase();
  return [...diagnosticAppLogExtensions].some((extension) =>
    lower.endsWith(extension)
  );
}

async function readFileTail(
  filePath: string,
  size: number,
  maxTailBytes: number
): Promise<string> {
  if (size <= 0) return "";
  const start = Math.max(0, size - maxTailBytes);
  const length = size - start;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function redactDiagnosticText(input: string): string {
  return input
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
    .replace(
      /\b((?:OPENAI|ANTHROPIC|MNIU|MN)_[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[:=]\s*)(["']?)[^\s"']+/gi,
      "$1$2[REDACTED]"
    )
    .replace(
      /\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^\s"']+/gi,
      "$1$2[REDACTED]"
    );
}

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({ logger: true });
  const activeRunEventStreams = new Set<() => void>();
  const runtimeProfile = options.runtimeProfile ?? "local";
  const homeDir = options.homeDir ?? process.env.HOME ?? process.cwd();
  const mniuRoot =
    options.mniuRoot ?? process.env.MN_MNIU_ROOT ?? defaultMniuRoot(homeDir);
  const cordisProfileId: RuntimeProfileId = runtimeProfile === "enterprise"
    ? "enterprise-api"
    : "local";
  const configuredCordisProfilePath = options.runtimeProfilePath ??
    process.env.MN_RUNTIME_PROFILE_PATH ??
    resolve(process.cwd(), "config", "runtime", "profiles", `${cordisProfileId}.yml`);
  const runtimeProfileLayers = () => {
    const candidates = [
      {
        id: "base-bundle",
        path: process.env.MN_RUNTIME_BASE_PATH ??
          resolve(process.cwd(), "config", "runtime", "base.yml")
      },
      { id: "deployment-profile", path: configuredCordisProfilePath },
      { id: "user-directory-patch", path: join(mniuRoot, "runtime", "plugins.yml") },
      {
        id: "cli-patch",
        path: options.runtimeCliPatchPath ?? process.env.MN_RUNTIME_CLI_PATCH ?? ""
      }
    ];
    return candidates.filter((layer) => layer.path && existsSync(layer.path));
  };
  let cordisRuntime: MuniuRuntime | undefined;
  const startCordisRuntime = async (): Promise<MuniuRuntime> => {
    const next = await bootRuntime({
      scope: "api",
      profileId: cordisProfileId,
      profileLayers: runtimeProfileLayers(),
      enableHmr: options.runtimeHmr ?? process.env.MN_RUNTIME_HMR === "1"
    });
    cordisRuntime = next;
    return next;
  };
  const providerUsageEvidenceVerifier = createProviderUsageEvidenceVerifier(
    options.providerUsageEvidenceTrustProfile
  );
  const bindHost = options.bindHost ?? "127.0.0.1";
  if ((!isLoopbackHost(bindHost) || runtimeProfile === "enterprise") && !options.auth) {
    throw new Error(
      "Authentication is required for enterprise or non-loopback API binding"
    );
  }
  const authenticator = options.auth
    ? new EnterpriseJwtAuthenticator(options.auth)
    : undefined;
  const corsAllowlist = new Set(options.corsAllowlist ?? []);
  if (runtimeProfile === "enterprise" && corsAllowlist.size === 0) {
    throw new Error("Enterprise profile requires a non-empty CORS allowlist");
  }
  if (runtimeProfile === "enterprise" && options.enterprisePostgres === undefined) {
    throw new Error("Enterprise profile requires PostgreSQL configuration");
  }
  if (runtimeProfile === "enterprise" && options.telemetry === undefined) {
    throw new Error("Enterprise profile requires an OTLP telemetry endpoint");
  }
  if (
    runtimeProfile === "enterprise" &&
    options.standardPackTrustProfile === undefined
  ) {
    throw new Error("Enterprise profile requires a Standard Pack trust profile");
  }
  if (runtimeProfile === "enterprise" && options.enterpriseProjectRoots === undefined) {
    throw new Error("Enterprise profile requires a project root allowlist");
  }
  if (runtimeProfile === "enterprise" && options.sandboxAttestationKey === undefined) {
    throw new Error("Enterprise profile requires a sandbox attestation signing key");
  }
  const sandboxAttestationKey = typeof options.sandboxAttestationKey === "string"
    ? options.sandboxAttestationKey
    : undefined;
  if (sandboxAttestationKey && Buffer.byteLength(sandboxAttestationKey) < 32) {
    throw new Error("Sandbox attestation signing key must contain at least 32 bytes");
  }
  const enterpriseSandboxImage = options.enterpriseSandboxImage !== undefined &&
    options.enterpriseSandboxImage !== false
    ? normalizeSandboxRuntimeImage(options.enterpriseSandboxImage)
    : undefined;
  if (runtimeProfile === "enterprise" && sandboxAttestationKey && !enterpriseSandboxImage) {
    throw new Error(
      "Enterprise sandbox attestation requires an approved content-addressed runtime image"
    );
  }
  if (
    runtimeProfile === "enterprise" &&
    sandboxAttestationKey &&
    options.sandboxRuntimeVerifier === false
  ) {
    throw new Error("Enterprise sandbox attestation requires a trusted runtime verifier");
  }
  const sandboxRuntimeVerifier = sandboxAttestationKey && options.sandboxRuntimeVerifier !== false
    ? options.sandboxRuntimeVerifier ?? (
        options.kubernetesSandbox
          ? new KubernetesRuntimeVerifier(options.kubernetesSandbox)
          : new DockerRuntimeVerifier()
      )
    : undefined;
  if (
    runtimeProfile === "enterprise" &&
    sandboxAttestationKey &&
    options.authoritativeGateAuthority === false
  ) {
    throw new Error("Enterprise governed runs require an authoritative Gate executor");
  }
  const authoritativeGateAuthority =
    runtimeProfile === "enterprise" &&
    sandboxAttestationKey &&
    options.authoritativeGateAuthority !== false
      ? options.authoritativeGateAuthority ?? (
          options.kubernetesSandbox
            ? new KubernetesAuthoritativeGateAuthority(options.kubernetesSandbox)
            : new DockerAuthoritativeGateAuthority()
        )
      : undefined;
  const enterpriseProjectRoots =
    runtimeProfile === "enterprise" && options.enterpriseProjectRoots !== false
      ? normalizeEnterpriseProjectRoots(options.enterpriseProjectRoots ?? [])
      : undefined;
  const enterprisePostgres = options.enterprisePostgres !== undefined &&
    options.enterprisePostgres !== false
    ? new EnterprisePostgresRuntime(options.enterprisePostgres)
    : undefined;
  const telemetry = options.telemetry !== undefined && options.telemetry !== false
    ? new OtlpHttpTelemetry(options.telemetry)
    : undefined;
  const defaultCapabilityCatalog = createDefaultRuntimeCapabilityCatalog();
  const capabilityCatalog = normalizeRuntimeCapabilityCatalog(
    options.capabilityCatalog ??
      (runtimeProfile === "enterprise"
        ? {
            ...defaultCapabilityCatalog,
            harnessProfiles: defaultCapabilityCatalog.harnessProfiles.map((descriptor) => {
              if (descriptor.id !== "enterprise") return descriptor;
              const { reason: _reason, ...available } = descriptor;
              return { ...available, status: "available" as const };
            })
          }
        : defaultCapabilityCatalog)
  );
  const store =
    options.store ??
    new MemoryStore({
      statePath: options.apiStatePath ?? process.env.MN_API_STATE_PATH
    });
  const appendAuditEvent = async (event: AuditEvent): Promise<void> => {
    if (enterprisePostgres) await enterprisePostgres.appendAuditEvent(event);
    const existing = store.auditEvents.get(event.id);
    if (existing) {
      if (sha256Canonical(existing) !== sha256Canonical(event)) {
        throw new Error(`Audit event ${event.id} idempotency conflict`);
      }
      return;
    }
    store.appendAuditEvent(event);
  };
  const enterpriseMetadataWrite = (
    tenantId: string,
    kind: string,
    id: string,
    value: unknown
  ): EnterpriseMetadataWrite => {
    const payload = JSON.parse(JSON.stringify(value)) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError(`Enterprise metadata ${kind}/${id} must be an object`);
    }
    const metadataPayload = payload as Readonly<Record<string, unknown>>;
    return {
      tenantId,
      kind,
      id,
      payload: metadataPayload,
      digest: sha256Canonical(metadataPayload)
    };
  };
  const collectEnterpriseMetadata = async (): Promise<EnterpriseMetadataWrite[]> => {
    const records: Array<{
      tenantId: string;
      kind: string;
      id: string;
      payload: Readonly<Record<string, unknown>>;
    }> = [];
    const add = (
      tenantId: string,
      kind: string,
      id: string,
      value: unknown
    ) => {
      const payload = JSON.parse(JSON.stringify(value)) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError(`Enterprise metadata ${kind}/${id} must be an object`);
      }
      records.push({
        tenantId,
        kind,
        id,
        payload: payload as Readonly<Record<string, unknown>>
      });
    };
    for (const project of store.projects.values()) {
      add(project.tenantId ?? LOCAL_TENANT_ID, "project", project.id, project);
    }
    for (const task of store.tasks.values()) {
      const project = store.projects.get(task.projectId);
      add(
        task.tenantId ?? project?.tenantId ?? LOCAL_TENANT_ID,
        "task",
        task.id,
        task
      );
    }
    for (const run of store.runs.values()) {
      const project = store.projects.get(run.projectId);
      add(
        run.tenantId ?? project?.tenantId ?? LOCAL_TENANT_ID,
        "run",
        run.id,
        run
      );
    }
    for (const [runId, events] of store.events) {
      const run = store.runs.get(runId);
      if (!run) continue;
      const project = store.projects.get(run.projectId);
      add(
        run.tenantId ?? project?.tenantId ?? LOCAL_TENANT_ID,
        "run_events",
        runId,
        { runId, events }
      );
    }
    for (const [runId, state] of store.governedLoopStates) {
      const run = store.runs.get(runId);
      if (!run) continue;
      const project = store.projects.get(run.projectId);
      add(
        run.tenantId ?? project?.tenantId ?? LOCAL_TENANT_ID,
        "governed_loop_state",
        runId,
        state
      );
    }
    for (const record of store.standardPacks.values()) {
      add(record.tenantId ?? LOCAL_TENANT_ID, "standard_pack", record.key, record);
    }
    for (const record of store.governanceLayers.values()) {
      add(record.tenantId ?? LOCAL_TENANT_ID, "governance_layer", record.key, record);
    }
    for (const record of store.projectPackLocks.values()) {
      add(record.tenantId ?? LOCAL_TENANT_ID, "standards_lock", record.projectId, record);
    }
    for (const [storageKey, waiver] of store.waivers) {
      let tenantId = LOCAL_TENANT_ID;
      try {
        const scoped = JSON.parse(storageKey) as unknown;
        if (Array.isArray(scoped) && typeof scoped[0] === "string") {
          tenantId = scoped[0];
        }
      } catch {
        // Legacy v1/v2 waiver keys are implicitly local.
      }
      add(tenantId, "waiver", waiver.id, waiver);
    }
    for (const [specSetId, tenantId] of store.specSetTenants) {
      add(tenantId, "spec_set_owner", specSetId, { specSetId, tenantId });
    }
    for (const specSet of await specRepository.list()) {
      const tenantId = store.specSetTenants.get(specSet.id);
      if (!tenantId) continue;
      const record = await specRepository.get(specSet.id);
      if (record) add(tenantId, "spec_repository", specSet.id, record);
    }
    for (const record of store.evalAssets.values()) {
      add(record.tenantId, "eval_asset", `${record.asset.id}@${record.asset.revision}`, record);
    }
    for (const record of store.traceGraphs.values()) {
      add(record.tenantId, "trace_graph", record.id, record);
    }
    for (const record of store.learningProposals.values()) {
      add(
        record.tenantId,
        "learning_proposal",
        `${record.proposal.id}@${record.proposal.revision}`,
        record
      );
    }
    for (const record of store.maturityReports.values()) {
      add(record.tenantId, "maturity_report", record.id, record);
    }
    for (const record of store.gateArtifactHandles.values()) {
      add(record.tenantId, "gate_artifact_handle", record.handle, record);
    }
    for (const record of store.authoritativeGateReceipts.values()) {
      add(record.tenantId, "authoritative_gate_receipt", record.id, record);
    }
    for (const provider of await localStore.listProviders()) {
      const scope = provider.config.enterpriseScope;
      const tenantIds = scope && typeof scope === "object" && !Array.isArray(scope)
        ? (scope as Record<string, unknown>).tenantIds
        : undefined;
      if (!Array.isArray(tenantIds) || tenantIds.length !== 1 || typeof tenantIds[0] !== "string") {
        // Legacy/global providers remain a process-local compatibility read
        // model. Only uniquely tenant-scoped providers can be represented in
        // the enterprise PostgreSQL metadata keyspace without scope widening.
        continue;
      }
      add(tenantIds[0], "provider", provider.id, provider);
    }
    return records.map((record) => ({
      ...record,
      digest: sha256Canonical(record.payload)
    }));
  };
  const syncEnterpriseMetadata = async (): Promise<void> => {
    if (!enterprisePostgres) return;
    const durableRecords = await collectEnterpriseMetadata();
    await enterprisePostgres.reconcileMetadata({
      records: durableRecords,
      managedKinds: ENTERPRISE_METADATA_KINDS
    });
  };
  const migrateEnterpriseProviderMetadata = async (): Promise<boolean> => {
    if (!enterprisePostgres) return false;
    const providerRecords = (await collectEnterpriseMetadata()).filter(
      (record) => record.kind === "provider"
    );
    if (providerRecords.length === 0) return false;
    // Provider metadata was added after the original enterprise snapshot
    // format. Only append that new kind here: reconciling the whole in-memory
    // image before the PostgreSQL snapshot is restored could delete durable
    // records that this process has not loaded yet.
    for (const record of providerRecords) {
      await enterprisePostgres.upsertMetadata(record);
    }
    return true;
  };
  if (runtimeProfile === "enterprise" && options.agentSessionService) {
    throw new Error("Enterprise Agent sessions cannot replace the enforced PostgreSQL/S3 backend");
  }
  let agentSessionService = runtimeProfile === "local"
    ? options.agentSessionService
    : undefined;
  const enterpriseAgentSessionServices = new Map<string, LocalMockAgentSessionService>();
  const enterpriseBuiltinAgentBroker = new EnterpriseBuiltinAgentBroker(
    enterprisePostgres
      ? new EnterpriseBuiltinAgentPersistence(enterprisePostgres.pool)
      : undefined,
    options.enterpriseBuiltinInstanceId
  );
  let getAgentSessionService:
    | ((request?: FastifyRequest) => Promise<LocalMockAgentSessionService>)
    | undefined;
  const specRepository =
    options.specRepository ??
    defaultControlPlaneSpecRepository(join(mniuRoot, "control-plane"));
  const artifactStoreQuota = normalizeArtifactStoreQuota(options.artifactStoreQuota);
  const artifactRemoteStore = normalizeArtifactRemoteStore(options.artifactRemoteStore);
  if (
    runtimeProfile === "enterprise" &&
    (!artifactRemoteStore ||
      artifactRemoteStore.type !== "s3" ||
      !artifactRemoteStore.s3Client)
  ) {
    throw new Error(
      "Enterprise profile requires an enforced S3-compatible artifact store endpoint"
    );
  }
  const providerUsageTerminalJournal =
    runtimeProfile === "enterprise" &&
    artifactRemoteStore?.type === "s3" &&
    artifactRemoteStore.s3Client &&
    sandboxAttestationKey
      ? new ProviderUsageTerminalJournal({
          store: artifactRemoteStore.s3Client,
          prefix: artifactRemoteStore.prefix,
          integrity: options.providerUsageTerminalJournalIntegrityProfile ?? {
            activeKeyId: "sandbox-attestation-v1",
            keys: [{
              id: "sandbox-attestation-v1",
              secret: sandboxAttestationKey,
              status: "active"
            }]
          }
        })
      : undefined;
  const runScopedCas = new RunScopedCas({
    localRoot: join(mniuRoot, "artifacts", "cas"),
    ...(artifactRemoteStore?.type === "s3" && artifactRemoteStore.s3Client
      ? {
          remoteStore: artifactRemoteStore.s3Client,
          ...(artifactRemoteStore.prefix
            ? { remotePrefix: artifactRemoteStore.prefix }
            : {})
        }
      : {}),
    requireRemote: runtimeProfile === "enterprise"
  });
  const providerModelCatalogSyncScheduler =
    normalizeProviderModelCatalogSyncScheduler(
      options.providerModelCatalogSyncScheduler
    );
  const autoResumeRuns =
    options.autoResumeRuns ??
    options.autoResumePendingRuns ??
    (process.env.MN_API_AUTO_RESUME_RUNS === "1" ||
      process.env.MN_API_AUTO_RESUME_PENDING_RUNS === "1");
  const localStore = options.localStore ?? new SqliteLocalStore({ rootDir: mniuRoot });
  const authorizeExternalEnterpriseGates = async (input: {
    readonly existing: RunRecord | undefined;
    readonly incoming: RunRecord;
    readonly state: GovernedRunState | undefined;
    readonly previousState: GovernedRunState | undefined;
    readonly item: RunJobQueueItem;
    readonly tenantId: string;
    readonly ownerId: string;
    readonly claimToken: string;
  }): Promise<EnterpriseGateAuthorizationDecision> => {
    if (options.authoritativeGateCheckpointAuthorizer) {
      return options.authoritativeGateCheckpointAuthorizer(input);
    }
    if (!input.existing?.harnessManifest) {
      return Object.freeze({ newReceipts: Object.freeze([]) });
    }
    if (
      !input.state ||
      !sandboxAttestationKey ||
      !sandboxRuntimeVerifier ||
      !authoritativeGateAuthority ||
      !enterprisePostgres
    ) {
      return Object.freeze({
        error: "enterprise governed run requires API authoritative Gate execution",
        newReceipts: Object.freeze([])
      });
    }
    const project = store.projects.get(input.incoming.projectId);
    const task = store.tasks.get(input.incoming.taskId);
    if (!project || !task?.specRef) {
      return Object.freeze({
        error: "authoritative Gate Project, Task or Spec binding is unavailable",
        newReceipts: Object.freeze([])
      });
    }
    const specRecord = await specRepository.get(task.specRef.specSetId);
    const spec = specRecord?.revisions.find(
      (revision) =>
        revision.revision === task.specRef!.revision &&
        revision.digest === task.specRef!.digest &&
        revision.status === "approved"
    );
    if (!spec) {
      return Object.freeze({
        error: "authoritative Gate approved Spec revision is unavailable",
        newReceipts: Object.freeze([])
      });
    }
    const assertCurrentClaim = async (): Promise<boolean> => {
      const active = await enterprisePostgres.inspectClaim({
        runId: input.incoming.id,
        ownerId: input.ownerId,
        claimToken: input.claimToken
      });
      return Boolean(
        active &&
        active.item.tenantId === input.tenantId &&
        active.item.claimTokenHash === input.item.claimTokenHash &&
        active.item.workerCapabilityDigest === input.item.workerCapabilityDigest
      );
    };
    return authorizeEnterpriseGateCheckpoint({
      existing: input.existing,
      incoming: input.incoming,
      state: input.state,
      ...(input.previousState ? { previousState: input.previousState } : {}),
      item: input.item,
      tenantId: input.tenantId,
      workerId: input.ownerId,
      signingKey: sandboxAttestationKey,
      project,
      task,
      spec,
      authority: authoritativeGateAuthority,
      runtimeVerifier: sandboxRuntimeVerifier,
      store,
      cas: runScopedCas,
      assertCurrentClaim
    });
  };
  const enterpriseBudgetDecision = async (input: {
    item: RunJobQueueItem;
    requestedTtlMs: number;
    now?: string;
    state?: GovernedRunState;
    run?: RunRecord;
  }): Promise<EnterpriseBudgetLeaseDecision> => {
    if (!enterprisePostgres) {
      throw new Error("enterprise budget usage ledger is unavailable");
    }
    if (!input.item.tenantId) {
      throw new Error("enterprise budget item has no tenant binding");
    }
    const run = input.run ?? store.runs.get(input.item.runId);
    if (!run) throw new Error("enterprise budget Run binding is unavailable");
    const usage = await authoritativeUsageForRun(
      enterprisePostgres,
      localStore,
      input.item.tenantId,
      input.item.runId,
      run.harnessManifest?.stopConditions.maxCostUsd
    );
    return evaluateEnterpriseBudgetLease({
      run,
      state: input.state ?? store.governedLoopStates.get(input.item.runId),
      item: input.item,
      usage,
      requestedTtlMs: input.requestedTtlMs,
      ...(input.now ? { now: input.now } : {})
    });
  };
  const secretVault =
    options.secretVault ??
    new LocalSecretVault(mniuRoot, {
      backend: defaultSecretVaultBackend(process.env, process.platform),
      keychain: {
        keychainPath: process.env.MN_SECRET_VAULT_KEYCHAIN_PATH
      }
    });
  if (runtimeProfile === "local") {
    getAgentSessionService = async (): Promise<LocalMockAgentSessionService> => {
      if (agentSessionService !== undefined) return agentSessionService;
      const runtimeFactory = createProductionAgentRuntimeFactory({
        providerSource: {
          getProvider: (providerId) => localStore.getProvider(providerId)
        },
        resolveStoredSecret: (reference) => resolveStoredSecret(reference)
      });
      agentSessionService = new LocalMockAgentSessionService(
        join(mniuRoot, "agent-service"),
        {
          mode: "production",
          runtimeFactory,
          tools: createWorkspaceTools({
            allowedCommands: DEFAULT_POLICY.commandAllowlist
          })
        }
      );
      return agentSessionService;
    };
  } else if (enterprisePostgres && artifactRemoteStore?.type === "s3" && artifactRemoteStore.s3Client) {
    const enterpriseSessionObjectStore = artifactRemoteStore.s3Client;
    getAgentSessionService = async (request): Promise<LocalMockAgentSessionService> => {
      if (!request) {
        throw new AgentSessionServiceError(
          409,
          "TENANT_CONTEXT_REQUIRED",
          "enterprise Agent session execution requires an authenticated tenant context"
        );
      }
      const context = requestContexts.get(request);
      if (!context) {
        throw new AgentSessionServiceError(
          401,
          "TENANT_CONTEXT_REQUIRED",
          "enterprise Agent session execution requires an authenticated tenant context"
        );
      }
      const existing = enterpriseAgentSessionServices.get(context.tenantId);
      if (existing) return existing;
      const runtimeFactory = createProductionAgentRuntimeFactory({
        providerSource: {
          getProvider: (providerId) => localStore.getProvider(providerId)
        },
        resolveStoredSecret: (reference) => resolveStoredSecret(reference)
      });
      const durableApproval = enterpriseBuiltinAgentBroker.approvalBridgeForTenant(
        context.tenantId
      );
      const service = new LocalMockAgentSessionService(
        join(mniuRoot, "agent-service-cache", sha256(context.tenantId)),
        {
          mode: "production",
          runtimeFactory,
          tools: enterpriseBuiltinAgentBroker.toolsForTenant(context.tenantId),
          approvalCoordinator: new AgentApprovalCoordinator({
            autoApprove: (approval) => enterpriseBuiltinAgentBroker.shouldAutoApprove(
              context.tenantId,
              approval.context.sessionId,
              approval.risk
            ),
            ...(durableApproval ? { durable: durableApproval } : {})
          }),
          sessionStore: createEnterpriseAgentSessionStore({
            tenantId: context.tenantId,
            pool: enterprisePostgres.pool,
            objectStore: enterpriseSessionObjectStore,
            objectPrefix: artifactRemoteStore.prefix,
            ...(process.env.MN_AGENT_SESSION_KMS_KEY_ID
              ? { kmsKeyId: process.env.MN_AGENT_SESSION_KMS_KEY_ID }
              : {})
          }),
          shouldRecoverInterruptedSession: (sessionId) =>
            enterpriseBuiltinAgentBroker.shouldRecoverSession(context.tenantId, sessionId)
        }
      );
      enterpriseAgentSessionServices.set(context.tenantId, service);
      return service;
    };
  }
  const useMockExecutors = options.useMockExecutors ?? false;
  const runJobLeases = new RunJobLeaseManager({
    rootDir: join(mniuRoot, "run-job-leases")
  });
  const runJobQueue = new RunJobQueue({
    rootDir: join(mniuRoot, "run-job-queue")
  });
  const runJobWorkers = new RunJobWorkerRegistry({
    rootDir: join(mniuRoot, "run-job-workers")
  });
  let providerModelCatalogSyncSchedulerTimer:
    | ReturnType<typeof setInterval>
    | undefined;
  let providerModelCatalogSyncSchedulerRunning = false;
  let proxyServer: LocalProxyServer | undefined;
  const internalProxyBootstrapToken = randomUUID();
  const enterpriseProxy = runtimeProfile === "enterprise"
    ? options.enterpriseProxy
    : undefined;
  const activeRunJobs = new Map<
    string,
    { controller: AbortController; done: Promise<void>; lease: RunJobLease }
  >();
  const requestContexts = new WeakMap<object, RequestContext>();
  const requestSpans = new WeakMap<object, HttpServerSpan>();
  const requestDomainAuditPlans = new WeakMap<object, readonly DomainAuditPlan[]>();
  const requestDomainAuditEventIds = new WeakMap<object, readonly string[]>();
  const precommittedDomainAuditEvents = new WeakMap<object, readonly AuditEvent[]>();
  const completedDomainAudits = new WeakSet<object>();
  const bindDomainAuditResource = (
    request: object,
    action: string,
    resourceId: string,
    projectId?: string
  ): void => {
    const plans = requestDomainAuditPlans.get(request);
    if (!plans) return;
    requestDomainAuditPlans.set(
      request,
      plans.map((plan) =>
        plan.action === action
          ? {
              ...plan,
              resourceId,
              ...(projectId ? { projectId } : {})
            }
          : plan
      )
    );
  };
  const buildPrecommittedRunAudit = (input: {
    request: object;
    action: string;
    before: RunRecord | undefined;
    after: RunRecord;
    statusCode: number;
    timestamp: string;
  }): AuditEvent => {
    const plans = requestDomainAuditPlans.get(input.request) ?? [];
    const ordinal = plans.findIndex((plan) => plan.action === input.action);
    const plan = plans[ordinal];
    const context = requestContexts.get(input.request) ??
      localRequestContext(input.timestamp);
    if (!plan || ordinal < 0) {
      throw new Error(`Missing domain audit plan for ${input.action}`);
    }
    const layers = input.after.governanceSnapshot?.layers ??
      input.before?.governanceSnapshot?.layers;
    const packDigest = layers?.at(-1)?.source.digest;
    return {
      id: requestDomainAuditEventIds.get(input.request)?.[ordinal] ?? randomUUID(),
      tenantId: context.tenantId,
      actorId: context.actorId,
      action: input.action,
      resourceType: plan.resourceType,
      resourceId: plan.resourceId ?? input.after.id,
      projectId: plan.projectId ?? input.after.projectId,
      policyDecision: "allow",
      beforeDigest: plan.beforeDigest ?? sha256Canonical(input.before ?? null),
      afterDigest: sha256Canonical(input.after),
      ...(packDigest ? { packDigest } : {}),
      traceId: context.traceId,
      result: "success",
      timestamp: input.timestamp,
      statusCode: input.statusCode
    };
  };
  const workspaceRoot =
    options.workspaceRoot ?? join(process.cwd(), ".mn", "worktrees");
  const builtinRunner: BuiltinAgentRunner = {
    async run(input) {
      if (!getAgentSessionService) {
        throw new Error("embedded Agent runtime is unavailable in this API profile");
      }
      const available = (await localStore.listProviders("agent"))
        .filter((provider) => provider.enabled);
      const provider = input.providerId === "default"
        ? available[0]
        : available.find((candidate) => candidate.id === input.providerId);
      if (!provider) {
        throw new Error("No enabled Agent model provider is configured");
      }
      const providerId = provider.id;
      const modelId = input.modelId === "default" ? provider.defaultModel : input.modelId;
      if (!modelId.trim()) throw new Error("Embedded Agent model binding is unavailable");
      const executionBinding = Object.freeze({
        ...input.executionBinding,
        providerId,
        modelId
      });
      const service = await getAgentSessionService();
      const output = await service.executeCandidate({
        ...input,
        providerId,
        modelId,
        executionBinding
      });
      return { ...output, providerId, modelId, executionBinding };
    }
  };
  const executors = useMockExecutors
    ? {
        builtin: new MockExecutor("builtin"),
        claude: new MockExecutor("claude"),
        codex: new MockExecutor("codex")
      }
    : createDefaultExecutors(builtinRunner);
  const restartablePendingRunIds = autoResumeRuns
    ? store
        .findRestartablePendingRuns()
        .filter((runId) => {
          const run = store.runs.get(runId);
          return Boolean(
            run &&
              store.tasks.has(run.taskId) &&
              store.projects.has(run.projectId)
          );
        })
    : [];
  const restartableCheckpointRunIds = autoResumeRuns
    ? store
        .findRestartableCheckpointRuns()
        .filter((runId) => {
          const run = store.runs.get(runId);
          const task = run ? store.tasks.get(run.taskId) : undefined;
          const project = run ? store.projects.get(run.projectId) : undefined;
          return Boolean(
            run &&
              task &&
              project &&
              isCheckpointRunAutoResumable(run, task)
          );
        })
    : [];
  const recoveredRunIds = store.recoverInterruptedRuns(undefined, {
    skipRunIds: new Set([
      ...restartablePendingRunIds,
      ...restartableCheckpointRunIds
    ])
  });
  for (const runId of recoveredRunIds) {
    const recoveredRun = store.runs.get(runId);
    const recoveredJob = store.runJobs.get(runId);
    runJobQueue.markFinished(
      runId,
      "failed",
      recoveredJob?.finishedAt ?? recoveredJob?.updatedAt ?? new Date().toISOString()
    );
    if (recoveredRun) void persistRunArtifactsSafely(recoveredRun);
  }
  for (const runId of restartablePendingRunIds) {
    const run = store.runs.get(runId);
    if (!run) continue;
    const task = store.tasks.get(run.taskId);
    const project = store.projects.get(run.projectId);
    if (!task || !project) continue;
    startRunJob(project, task, { runId, recovered: true });
  }
  for (const runId of restartableCheckpointRunIds) {
    const run = store.runs.get(runId);
    if (!run) continue;
    const task = store.tasks.get(run.taskId);
    const project = store.projects.get(run.projectId);
    if (!task || !project) continue;
    startRunJob(project, task, {
      runId,
      recovered: true,
      resumeFrom: run
    });
  }

  if (providerModelCatalogSyncScheduler) {
    providerModelCatalogSyncSchedulerTimer = setInterval(() => {
      if (providerModelCatalogSyncSchedulerRunning) return;
      providerModelCatalogSyncSchedulerRunning = true;
      void syncDueProviderModelCatalogs({
        dryRun: false,
        app: providerModelCatalogSyncScheduler.app,
        providerIds: providerModelCatalogSyncScheduler.providerIds,
        limit: providerModelCatalogSyncScheduler.limit
      })
        .then((result) => {
          if (result.syncedCount > 0 || result.failedCount > 0) {
            app.log.info(
              {
                checkedCount: result.checkedCount,
                dueCount: result.dueCount,
                syncedCount: result.syncedCount,
                failedCount: result.failedCount
              },
              "provider model catalog sync scheduler tick"
            );
          }
        })
        .catch((error) => {
          app.log.warn(
            { error: errorDetail(error) },
            "provider model catalog sync scheduler failed"
          );
        })
        .finally(() => {
          providerModelCatalogSyncSchedulerRunning = false;
        });
    }, providerModelCatalogSyncScheduler.intervalMs);
    providerModelCatalogSyncSchedulerTimer.unref?.();
  }

  if (enterprisePostgres) {
    app.addHook("onReady", async () => {
      await enterprisePostgres.migrate();
      await enterpriseBuiltinAgentBroker.migrate();
      let snapshot = await enterprisePostgres.readStateSnapshot();
      if (snapshot.metadata.length === 0) {
        // One-time migration path for an existing local snapshot. Once any
        // enterprise metadata exists PostgreSQL remains authoritative.
        await syncEnterpriseMetadata();
        snapshot = await enterprisePostgres.readStateSnapshot();
      }
      if (
        !snapshot.metadata.some((record) => record.kind === "provider") &&
        await migrateEnterpriseProviderMetadata()
      ) {
        snapshot = await enterprisePostgres.readStateSnapshot();
      }
      await restoreEnterpriseSnapshot({ store, specRepository, localStore, snapshot });
      if (providerUsageTerminalJournal) {
        await providerUsageTerminalJournal.replayAll((log, ref) =>
          enterprisePostgres.appendProviderUsageLog(log, ref)
        );
      }
      await enterprisePostgres.checkReadWrite();
    });
  }

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? request.url;
    const telemetrySpan = telemetry?.startHttpSpan({
      method: request.method,
      route: pathname,
      ...(typeof request.headers.traceparent === "string"
        ? { traceparent: request.headers.traceparent }
        : {})
    });
    if (telemetrySpan) requestSpans.set(request, telemetrySpan);
    const traceId = telemetrySpan?.traceId ?? request.id ?? randomUUID();
    reply.header("x-trace-id", traceId);
    if (telemetrySpan) {
      reply.header(
        "traceparent",
        `00-${telemetrySpan.traceId}-${telemetrySpan.spanId}-01`
      );
    }
    const origin = typeof request.headers.origin === "string"
      ? request.headers.origin
      : undefined;
    if (
      runtimeProfile === "enterprise" &&
      origin !== undefined &&
      !corsAllowlist.has(origin)
    ) {
      return reply.code(403).send({ error: "origin is not allowed" });
    }
    reply.header(
      "access-control-allow-origin",
      runtimeProfile === "enterprise" ? origin ?? "null" : "*"
    );
    reply.header(
      "access-control-allow-headers",
      "authorization,content-type,idempotency-key,x-request-id"
    );
    reply.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    reply.header(
      "access-control-expose-headers",
      "content-disposition,content-length,content-type"
    );
    const internalProxyBootstrap =
      request.method === "POST" &&
      pathname === "/v1/proxy/start" &&
      request.headers["x-mn-internal-proxy-bootstrap"] === internalProxyBootstrapToken;
    if (
      runtimeProfile === "enterprise" &&
      request.url.startsWith("/v1/") &&
      !internalProxyBootstrap &&
      !enterpriseRouteAllows(request.method, pathname)
    ) {
      return reply.code(404).send({ error: "resource not found" });
    }
    if (internalProxyBootstrap) return;
    if (!request.url.startsWith("/v1/") || request.method === "OPTIONS") return;
    let context: RequestContext;
    try {
      context = authenticator
        ? await authenticator.authenticate(
            typeof request.headers.authorization === "string"
              ? request.headers.authorization
              : undefined,
            traceId
          )
        : localRequestContext(traceId);
    } catch (error) {
      await appendAuditEvent({
        id: randomUUID(),
        tenantId: "unknown",
        actorId: "anonymous",
        action: `${request.method} ${request.url.split("?")[0]}`,
        resourceType: "http_request",
        policyDecision: "deny",
        traceId,
        result: "failure",
        timestamp: new Date().toISOString(),
        statusCode: 401
      });
      return reply.code(401).send({
        error: error instanceof Error ? error.message : "authentication failed"
      });
    }
    requestContexts.set(request, context);
    const authorized = runtimeProfile === "enterprise"
      ? principalAllows(context, request.method, pathname)
      : roleAllows(context.roles, request.method, pathname);
    if (!authorized) {
      return reply.code(403).send({ error: "role is not authorized for this operation" });
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const context = requestContexts.get(request);
    if (!context) return;
    const pathname = request.url.split("?")[0] ?? request.url;
    if (
      runtimeProfile === "enterprise" &&
      context.principalType === "worker" &&
      request.method === "POST" &&
      /^\/v1\/run-jobs\//u.test(pathname)
    ) {
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? request.body as Record<string, unknown>
        : undefined;
      if (!workerOwnerMatchesPrincipal(body?.ownerId, context.actorId)) {
        return reply.code(403).send({
          error: "worker ownerId must match the authenticated machine principal or one of its instances"
        });
      }
    }
    const domainPlans = await prepareDomainAuditPlans({
      request,
      store,
      specRepository,
      tenantId: context.tenantId
    });
    if (domainPlans.length > 0) {
      requestDomainAuditPlans.set(request, domainPlans);
      requestDomainAuditEventIds.set(
        request,
        domainPlans.map(() => randomUUID())
      );
    }
    const project = projectForRequest(request, store);
    if (
      project &&
      ((project.tenantId ?? LOCAL_TENANT_ID) !== context.tenantId ||
        (context.projectIds.length > 0 &&
          !context.projectIds.includes(project.id) &&
          !context.roles.includes("org_admin") &&
          !context.roles.includes("governance_admin")))
    ) {
      return reply.code(404).send({ error: "resource not found" });
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const context = requestContexts.get(request);
    const domainPlans = requestDomainAuditPlans.get(request) ?? [];
    if (
      context &&
      domainPlans.length > 0 &&
      !completedDomainAudits.has(request)
    ) {
      const succeeded = reply.statusCode < 400;
      const response = parseDomainAuditResponse(payload);
      const timestamp = new Date().toISOString();
      const eventIds = requestDomainAuditEventIds.get(request) ?? [];
      const precommittedEvents = precommittedDomainAuditEvents.get(request);
      const domainEvents = precommittedEvents ?? domainPlans.map((plan, ordinal): AuditEvent => {
        const finalized = finalizedDomainResource({ plan, response, succeeded });
        return {
          id: eventIds[ordinal] ?? randomUUID(),
          tenantId: context.tenantId,
          actorId: context.actorId,
          action: plan.action,
          resourceType: plan.resourceType,
          ...(finalized.resourceId ? { resourceId: finalized.resourceId } : {}),
          ...(plan.projectId ||
          (plan.resourceType === "project" ? finalized.resourceId : undefined)
            ? {
                projectId: plan.projectId ?? finalized.resourceId!
              }
            : {}),
          policyDecision: succeeded ? "allow" : "deny",
          beforeDigest: plan.beforeDigest ?? sha256Canonical(null),
          ...(finalized.afterDigest ? { afterDigest: finalized.afterDigest } : {}),
          ...(finalized.packDigest ? { packDigest: finalized.packDigest } : {}),
          traceId: context.traceId,
          result: succeeded ? "success" : "failure",
          timestamp,
          statusCode: reply.statusCode
        };
      });
      if (precommittedEvents) {
        for (const event of precommittedEvents) {
          const existing = store.auditEvents.get(event.id);
          if (existing) {
            if (sha256Canonical(existing) !== sha256Canonical(event)) {
              throw new Error(`Audit event ${event.id} idempotency conflict`);
            }
          } else {
            store.appendAuditEvent(event);
          }
        }
        completedDomainAudits.add(request);
        return payload;
      }
      if (
        enterprisePostgres &&
        succeeded &&
        domainPlans.some((plan) => plan.mutates)
      ) {
        const records = await collectEnterpriseMetadata();
        try {
          await enterprisePostgres.reconcileMetadata({
            records,
            managedKinds: ENTERPRISE_METADATA_KINDS,
            auditEvents: domainEvents,
            now: timestamp
          });
        } catch (error) {
          // Route handlers update the in-process cache (and the file-backed
          // Spec repository) before onSend. PostgreSQL is authoritative in the
          // enterprise profile, so a failed atomic commit must restore that
          // durable image before the failed response is exposed to callers.
          const snapshot = await enterprisePostgres.readStateSnapshot();
          await restoreEnterpriseSnapshot({ store, specRepository, localStore, snapshot });
          const failedAt = new Date().toISOString();
          for (const domainEvent of domainEvents) {
            const {
              afterDigest: _afterDigest,
              result: _result,
              policyDecision: _policyDecision,
              statusCode: _statusCode,
              timestamp: _timestamp,
              ...identity
            } = domainEvent;
            await appendAuditEvent({
              ...identity,
              policyDecision: "deny",
              result: "failure",
              timestamp: failedAt,
              statusCode: 500
            });
          }
          completedDomainAudits.add(request);
          throw error;
        }
        for (const event of domainEvents) {
          const existing = store.auditEvents.get(event.id);
          if (!existing) store.appendAuditEvent(event);
        }
      } else {
        for (const event of domainEvents) await appendAuditEvent(event);
      }
      completedDomainAudits.add(request);
    } else if (
      enterprisePostgres &&
      request.url.startsWith("/v1/") &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "OPTIONS" &&
      reply.statusCode < 400
    ) {
      await syncEnterpriseMetadata();
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const context = requestContexts.get(request);
    if (request.url.startsWith("/v1/") && context) {
      const project = projectForRequest(request, store);
      const resourceId = auditResourceId(request);
      await appendAuditEvent({
        id: randomUUID(),
        tenantId: context.tenantId,
        actorId: context.actorId,
        action: `${request.method} ${request.url.split("?")[0]}`,
        resourceType: auditResourceType(request.url),
        ...(resourceId ? { resourceId } : {}),
        ...(project ? { projectId: project.id } : {}),
        policyDecision: reply.statusCode < 400 ? "allow" : "deny",
        traceId: context.traceId,
        result: reply.statusCode < 400 ? "success" : "failure",
        timestamp: new Date().toISOString(),
        statusCode: reply.statusCode
      });
    }
    const span = requestSpans.get(request);
    if (span && telemetry) {
      try {
        await telemetry.finishHttpSpan(span, {
          statusCode: reply.statusCode,
          ...(context ? { tenantId: context.tenantId, actorId: context.actorId } : {})
        });
      } catch (error) {
        app.log.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "OTLP trace export failed"
        );
      }
    }
  });

  app.options("/*", async (_request, reply) => reply.code(204).send());
  app.addHook("onReady", async () => {
    await startCordisRuntime();
  });
  app.addHook("preClose", async () => {
    for (const close of [...activeRunEventStreams]) close();
  });
  app.addHook("onClose", async () => {
    if (providerModelCatalogSyncSchedulerTimer) {
      clearInterval(providerModelCatalogSyncSchedulerTimer);
      providerModelCatalogSyncSchedulerTimer = undefined;
    }
    for (const job of activeRunJobs.values()) {
      job.controller.abort();
    }
    await Promise.allSettled([...activeRunJobs.values()].map((job) => job.done));
    activeRunJobs.clear();
    await enterpriseBuiltinAgentBroker.dispose();
    await agentSessionService?.dispose();
    await Promise.allSettled(
      [...enterpriseAgentSessionServices.values()].map((service) => service.dispose())
    );
    enterpriseAgentSessionServices.clear();
    await cordisRuntime?.dispose();
    cordisRuntime = undefined;
    await proxyServer?.stop();
    proxyServer = undefined;
    await enterprisePostgres?.close();
  });

  if (enterpriseProxy) {
    app.addHook("onListen", async () => {
      const result = await app.inject({
        method: "POST",
        url: "/v1/proxy/start",
        headers: {
          "x-mn-internal-proxy-bootstrap": internalProxyBootstrapToken
        },
        payload: { host: enterpriseProxy.host, port: enterpriseProxy.port }
      });
      if (result.statusCode !== 200) {
        throw new Error(`enterprise provider proxy bootstrap failed (${result.statusCode})`);
      }
    });
  }

  app.get("/healthz", async (_request, reply) => {
    let postgresHealthy = enterprisePostgres === undefined;
    if (enterprisePostgres) {
      try {
        await enterprisePostgres.checkReadWrite();
        postgresHealthy = true;
      } catch (error) {
        app.log.error(
          { error: error instanceof Error ? error.message : String(error) },
          "enterprise PostgreSQL read/write health probe failed"
        );
        reply.code(503);
      }
    }
    return {
      ok: postgresHealthy,
      service: "mn-api",
      runtimeProfile,
      cordis: cordisRuntime
        ? {
            profileId: cordisRuntime.snapshot.profileId,
            profileDigest: cordisRuntime.snapshot.profileDigest,
            plugins: cordisRuntime.snapshot.plugins.length
          }
        : { profileId: cordisProfileId, status: "starting" },
      metadataBackend: enterprisePostgres
        ? postgresHealthy ? "postgresql" : "unavailable"
        : "local",
      queueBackend: enterprisePostgres
        ? postgresHealthy ? "postgresql" : "unavailable"
        : "filesystem",
      ...(postgresHealthy ? {} : { reason: "postgresql_read_write_probe_failed" }),
      telemetry: telemetry
        ? {
            enabled: true,
            protocol: "otlp-http-json",
            ...(runtimeProfile === "local" ? { endpoint: telemetry.endpoint } : {})
          }
        : { enabled: false },
      ...(runtimeProfile === "local"
        ? {
            executorMode: useMockExecutors ? "mock" : "real",
            workspaceRoot,
            mniuRoot,
            secretVaultBackend: secretVault.backend,
            providerModelCatalogSyncScheduler: providerModelCatalogSyncScheduler
              ? {
                  enabled: true,
                  intervalMs: providerModelCatalogSyncScheduler.intervalMs,
                  app: providerModelCatalogSyncScheduler.app,
                  providerIds: providerModelCatalogSyncScheduler.providerIds,
                  limit: providerModelCatalogSyncScheduler.limit
                }
              : { enabled: false }
          }
        : {}),
      artifactRemoteStore: artifactRemoteStore
        ? runtimeProfile === "enterprise"
          ? artifactRemoteStorePublicDescriptor(artifactRemoteStore)
          : artifactRemoteStoreDescriptor(artifactRemoteStore)
        : null
    };
  });

  app.get("/v1/runtime", async () => ({
    runtime: cordisRuntime?.snapshot,
    audit: cordisRuntime?.audit.list() ?? []
  }));

  app.get("/v1/runtime/profiles", async () => ({
    selected: cordisProfileId,
    available: ["local", "enterprise-api", "enterprise-worker", "desktop"],
    resolutionOrder: ["base-bundle", "deployment-profile", "user-directory-patch", "cli-patch"],
    path: configuredCordisProfilePath,
    digest: cordisRuntime?.snapshot.profileDigest
  }));

  app.get("/v1/runtime/plugins", async () => ({
    profileId: cordisProfileId,
    plugins: cordisRuntime?.snapshot.plugins ?? []
  }));

  app.post("/v1/runtime/plugins/reload", async (request, reply) => {
    const context = requestContexts.get(request);
    if (
      runtimeProfile === "enterprise" &&
      (!context || !context.roles.includes("org_admin"))
    ) {
      return reply.code(403).send({ error: "org_admin role is required to reload plugins" });
    }
    const previous = cordisRuntime;
    const next = await bootRuntime({
      scope: "api",
      profileId: cordisProfileId,
      profileLayers: runtimeProfileLayers(),
      enableHmr: options.runtimeHmr ?? process.env.MN_RUNTIME_HMR === "1"
    });
    cordisRuntime = next;
    await previous?.dispose();
    return {
      reloaded: true,
      previousDigest: previous?.snapshot.profileDigest,
      runtime: next.snapshot
    };
  });

  app.get("/v1/capabilities", async () =>
    buildCapabilitiesDocument(capabilityCatalog)
  );

  app.get("/v1/workflows", async () =>
    buildWorkflowsDocument(capabilityCatalog)
  );

  app.get("/v1/harness-profiles", async () =>
    buildHarnessProfilesDocument(capabilityCatalog)
  );

  if (getAgentSessionService) {
    registerAgentSessionRoutes(app, { getService: getAgentSessionService });
  }
  registerEnterpriseBuiltinAgentRoutes(app, {
    runtimeProfile,
    ...(enterprisePostgres ? { postgres: enterprisePostgres } : {}),
    ...(sandboxAttestationKey ? { signingKey: sandboxAttestationKey } : {}),
    store,
    providerStore: localStore,
    broker: enterpriseBuiltinAgentBroker,
    requestContext: (request) => requestContexts.get(request),
    ...(getAgentSessionService ? { getAgentSessionService } : {})
  });

  registerControlPlaneRoutes(app, {
    store,
    specRepository,
    contextForRequest: (request) =>
      requestContexts.get(request) ?? localRequestContext(request.id),
    ...(options.standardPackTrustProfile !== undefined &&
      options.standardPackTrustProfile !== false
      ? { standardPackTrustProfile: options.standardPackTrustProfile }
      : {}),
    requireVerifiedStandardPacks:
      runtimeProfile === "enterprise" && options.standardPackTrustProfile !== false
  });
  registerEvidenceRoutes(app, {
    store,
    contextForRequest: (request) =>
      requestContexts.get(request) ?? localRequestContext(request.id),
    strictEnterpriseEvidence: runtimeProfile === "enterprise",
    ...(runtimeProfile === "enterprise"
      ? {
          evidenceTruthResolvers: {
            resolveApprovedSpecRevision: (input) =>
              resolveProjectApprovedSpecRevision(input, store, specRepository),
            listApprovedSpecRevisions: (input) =>
              listProjectApprovedSpecRevisions(input, store, specRepository),
            resolveEvidenceReference: (input) =>
              resolveServerEvidenceReference(
                input,
                store,
                mniuRoot,
                artifactRemoteStore,
                runScopedCas,
                sandboxAttestationKey
              )
          }
        }
      : {}),
    ...(options.learningProposalSignatureVerifier
      ? { verifyLearningProposalSignature: options.learningProposalSignatureVerifier }
      : {})
  });

  app.get("/v1/system/desktop", async () => {
    const [claude, codex] = await Promise.all([
      probeBinary(process.env.MN_CLAUDE_BINARY ?? "claude", ["--version"]),
      probeBinary(process.env.MN_CODEX_BINARY ?? "codex", ["--version"])
    ]);
    const [enabledClaude, enabledCodex, proxy] = await Promise.all([
      localStore.getEnabledProvider("claude"),
      localStore.getEnabledProvider("codex"),
      localStore.readProxy()
    ]);
    const recentRuns = [...store.runs.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5)
      .map((run) => ({
        id: run.id,
        taskId: run.taskId,
        status: run.status,
        candidates: run.candidates.length,
        updatedAt: run.updatedAt
      }));

    return {
      generatedAt: new Date().toISOString(),
      api: {
        ok: true,
        service: "mn-api",
        executorMode: useMockExecutors ? "mock" : "real",
        workspaceRoot,
        mniuRoot,
        secretVaultBackend: secretVault.backend,
        artifactRemoteStore: artifactRemoteStore
          ? artifactRemoteStoreDescriptor(artifactRemoteStore)
          : null
      },
      apps: [
        {
          id: "claude",
          name: "Claude Code",
          shortName: "Claude",
          binary: claude,
          currentProvider: enabledClaude?.name ?? "未配置",
          configPath: "~/.claude/settings.json",
          promptPath: "~/.claude/CLAUDE.md",
          skillPath: "~/.claude/skills",
          restartRequired: false
        },
        {
          id: "codex",
          name: "Codex",
          shortName: "Codex",
          binary: codex,
          currentProvider: enabledCodex?.name ?? "未配置",
          configPath: "~/.codex/config.toml",
          promptPath: "~/.codex/AGENTS.md",
          skillPath: "~/.codex/skills",
          restartRequired: true
        }
      ],
      proxy,
      recentRuns
    };
  });

  async function buildSystemDoctorSummary() {
    const [claude, codex, local] = await Promise.all([
      probeBinary(process.env.MN_CLAUDE_BINARY ?? "claude", ["--version"]),
      probeBinary(process.env.MN_CODEX_BINARY ?? "codex", ["--version"]),
      inspectLocalConfig(homeDir)
    ]);
    return {
      generatedAt: new Date().toISOString(),
      api: {
        ok: true,
        service: "mn-api",
        executorMode: useMockExecutors ? "mock" : "real",
        workspaceRoot,
        mniuRoot
      },
      binaries: { claude, codex },
      ...local
    };
  }

  app.get("/v1/system/doctor", async () => buildSystemDoctorSummary());

  app.get("/v1/system/diagnostics", async () => {
    const [doctor, logs, crashReports, appLogs] = await Promise.all([
      buildSystemDoctorSummary(),
      collectDiagnosticLogs(mniuRoot),
      collectDiagnosticCrashReports(homeDir),
      collectDiagnosticAppLogs(homeDir)
    ]);
    return {
      kind: "mniu.diagnostics",
      version: 1,
      generatedAt: new Date().toISOString(),
      doctor,
      logs,
      crashReports,
      appLogs
    };
  });

  app.post("/v1/system/env-cleanup", async (request) => {
    const body = envCleanupSchema.parse(request.body ?? {});
    return cleanupShellEnvConflicts(homeDir, {
      dryRun: body.dryRun,
      envNames: body.names,
      sources: body.sources,
      env: process.env,
      mniuRoot
    });
  });

  app.get("/v1/apps", async () => ({
    apps: [
      { id: "claude", name: "Claude Code" },
      { id: "codex", name: "Codex" }
    ]
  }));

  app.get("/v1/mcp/servers", async (request) => {
    const query = extensionAppQuerySchema.parse(request.query);
    return {
      servers: (await localStore.listMcpServers(query.app)).map(redactMcpServer)
    };
  });

  app.post("/v1/mcp/servers", async (request, reply) => {
    const body = mcpServerCreateSchema.parse(request.body);
    const server = await localStore.createMcpServer({
      ...body,
      env: await storeMcpEnv(body.env)
    });
    return reply.code(201).send(redactMcpServer(server));
  });

  app.get("/v1/mcp/servers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const server = await localStore.getMcpServer(id);
    if (!server) return reply.code(404).send({ error: "MCP server not found" });
    return redactMcpServer(server);
  });

  app.patch("/v1/mcp/servers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await localStore.getMcpServer(id);
    if (!existing) return reply.code(404).send({ error: "MCP server not found" });
    const patch = mcpServerPatchSchema.parse(request.body);
    return redactMcpServer(
      await localStore.updateMcpServer(id, {
        ...patch,
        ...(patch.env ? { env: await storeMcpEnv(patch.env) } : {})
      })
    );
  });

  app.post("/v1/mcp/servers/:id/project", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = mcpProjectSchema.parse(request.body ?? {});
    const server = await localStore.getMcpServer(id);
    if (!server) return reply.code(404).send({ error: "MCP server not found" });
    const serverForProjection = await resolveMcpServerEnv(server);
    const projections = await projectMcpServer(serverForProjection, {
      homeDir: body.homeDir ?? homeDir,
      mniuRoot,
      dryRun: body.dryRun,
      apps: body.apps
    });
    if (!body.dryRun) {
      await appendLiveConfigAudit({
        action: "mcp.project",
        apps: projections.map((projection) => projection.app),
        entityType: "mcp_server",
        entityId: server.id,
        targetPaths: projections.map((projection) => projection.targetPath)
      });
    }
    return {
      server: redactMcpServer(server),
      projections: projections.map((projection) => ({
        ...projection,
        projectedConfig: redactMcpProjectedConfig(projection.projectedConfig, serverForProjection.env)
      }))
    };
  });

  app.delete("/v1/mcp/servers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const server = await localStore.getMcpServer(id);
    if (!server) return reply.code(404).send({ error: "MCP server not found" });
    await localStore.deleteMcpServer(id);
    return reply.code(204).send();
  });

  app.get("/v1/prompts/presets", async (request) => {
    const query = extensionAppQuerySchema.parse(request.query);
    return {
      prompts: await localStore.listPromptPresets(query.app)
    };
  });

  app.post("/v1/prompts/presets", async (request, reply) => {
    const body = promptPresetCreateSchema.parse(request.body);
    const prompt = await localStore.createPromptPreset(body);
    return reply.code(201).send(prompt);
  });

  app.get("/v1/prompts/presets/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const prompt = await localStore.getPromptPreset(id);
    if (!prompt) return reply.code(404).send({ error: "prompt preset not found" });
    return prompt;
  });

  app.patch("/v1/prompts/presets/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await localStore.getPromptPreset(id);
    if (!existing) return reply.code(404).send({ error: "prompt preset not found" });
    return localStore.updatePromptPreset(
      id,
      promptPresetPatchSchema.parse(request.body)
    );
  });

  app.post("/v1/prompts/presets/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = promptActivateSchema.parse(request.body ?? {});
    const prompt = await localStore.getPromptPreset(id);
    if (!prompt) return reply.code(404).send({ error: "prompt preset not found" });
    const previousActivation = await localStore.getLatestPromptActivation(body.app);
    const projection = await activatePromptPreset(prompt, {
      app: body.app,
      homeDir: body.homeDir ?? homeDir,
      mniuRoot,
      dryRun: body.dryRun,
      previousActivation
    });
    let backfilledPrompt: unknown;
    if (!body.dryRun && projection.backfill) {
      const existing = await localStore.getPromptPreset(projection.backfill.promptId);
      if (existing) {
        backfilledPrompt = await localStore.updatePromptPreset(existing.id, {
          content: projection.backfill.content
        });
      }
    }
    const activation = body.dryRun
      ? undefined
      : await localStore.savePromptActivation({
          promptId: prompt.id,
          app: body.app,
          targetPath: projection.targetPath,
          liveConfigHash: projection.liveConfigHash,
          backupPath: projection.backupPath
        });
    if (!body.dryRun) {
      await appendLiveConfigAudit({
        action: "prompt.activate",
        apps: [body.app],
        entityType: "prompt",
        entityId: prompt.id,
        targetPaths: [projection.targetPath]
      });
    }
    return {
      prompt,
      activation,
      projection,
      ...(backfilledPrompt ? { backfilledPrompt } : {})
    };
  });

  app.delete("/v1/prompts/presets/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const prompt = await localStore.getPromptPreset(id);
    if (!prompt) return reply.code(404).send({ error: "prompt preset not found" });
    await localStore.deletePromptPreset(id);
    return reply.code(204).send();
  });

  app.get("/v1/skills/discover", async (request) => {
    const query = skillDiscoverQuerySchema.parse(request.query);
    return {
      skills: await discoverSkillSources({
        homeDir: query.homeDir ?? homeDir,
        mniuRoot
      })
    };
  });

  app.get("/v1/skills", async (request) => {
    const query = extensionAppQuerySchema.parse(request.query);
    return {
      skills: await localStore.listSkills(query.app)
    };
  });

  app.post("/v1/skills", async (request, reply) => {
    const body = skillCreateSchema.parse(request.body);
    const skill = await localStore.createSkill(body);
    return reply.code(201).send(skill);
  });

  async function runSkillRegistrySync(
    body: z.infer<typeof skillRegistrySyncSchema>,
    reply: FastifyReply
  ) {
    const existingSkills = await localStore.listSkills();
    let result: Awaited<ReturnType<typeof syncSkillRegistry>>;
    try {
      result = await syncSkillRegistry({
        registryUrl: body.registryUrl,
        homeDir,
        mniuRoot,
        dryRun: body.dryRun,
        installedSkills: existingSkills,
        requireSignature: body.requireSignature,
        requireReleaseMetadata: body.requireReleaseMetadata,
        publicKey: body.publicKey,
        trustedPublicKeys: body.trustedPublicKeys,
        revokedPublicKeyIds: body.revokedPublicKeyIds
      });
    } catch (error) {
      return reply.code(400).send({
        error: "invalid skill registry",
        details: [errorDetail(error)]
      });
    }
    const savedSkills = [];
    if (!body.dryRun) {
      for (const item of result.skills) {
        if (!item.applied) continue;
        const existing = existingSkills.find((skill) => skill.name === item.name);
        const input = {
          name: item.name,
          sourcePath: item.sourcePath,
          ...(item.description ? { description: item.description } : {}),
          version: item.version,
          apps: item.apps,
          enabled: true
        };
        savedSkills.push(
          existing
            ? await localStore.updateSkill(existing.id, input)
            : await localStore.createSkill(input)
        );
      }
    }
    return {
      ...result,
      ...(savedSkills.length > 0 ? { savedSkills } : {})
    };
  }

  app.get("/v1/skills/registry/profiles", async () => ({
    profiles: await localStore.listSkillRegistryTrustProfiles()
  }));

  app.post("/v1/skills/registry/profiles", async (request, reply) => {
    const body = skillRegistryTrustProfileSchema.parse(request.body ?? {});
    const profile = await localStore.createSkillRegistryTrustProfile(body);
    return reply.code(201).send(profile);
  });

  app.get("/v1/skills/registry/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = await localStore.getSkillRegistryTrustProfile(id);
    if (!profile) return reply.code(404).send({ error: "skill registry profile not found" });
    return profile;
  });

  app.patch("/v1/skills/registry/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await localStore.getSkillRegistryTrustProfile(id);
    if (!existing) return reply.code(404).send({ error: "skill registry profile not found" });
    return localStore.updateSkillRegistryTrustProfile(
      id,
      skillRegistryTrustProfilePatchSchema.parse(request.body ?? {})
    );
  });

  app.delete("/v1/skills/registry/profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await localStore.getSkillRegistryTrustProfile(id);
    if (!existing) return reply.code(404).send({ error: "skill registry profile not found" });
    await localStore.deleteSkillRegistryTrustProfile(id);
    return reply.code(204).send();
  });

  app.post("/v1/skills/registry/profiles/:id/sync", async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = await localStore.getSkillRegistryTrustProfile(id);
    if (!profile) return reply.code(404).send({ error: "skill registry profile not found" });
    const body = skillRegistryProfileSyncSchema.parse(request.body ?? {});
    return runSkillRegistrySync(
      {
        registryUrl: profile.registryUrl,
        dryRun: body.dryRun,
        requireSignature: profile.requireSignature,
        requireReleaseMetadata: profile.requireReleaseMetadata,
        publicKey: profile.publicKey,
        trustedPublicKeys: profile.trustedPublicKeys,
        revokedPublicKeyIds: profile.revokedPublicKeyIds
      },
      reply
    );
  });

  app.post("/v1/skills/registry/sync", async (request, reply) => {
    const body = skillRegistrySyncSchema.parse(request.body ?? {});
    return runSkillRegistrySync(body, reply);
  });

  app.get("/v1/skills/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const skill = await localStore.getSkill(id);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    return skill;
  });

  app.patch("/v1/skills/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await localStore.getSkill(id);
    if (!existing) return reply.code(404).send({ error: "skill not found" });
    return localStore.updateSkill(id, skillPatchSchema.parse(request.body));
  });

  app.post("/v1/skills/:id/install", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = skillInstallSchema.parse(request.body ?? {});
    const skill = await localStore.getSkill(id);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    const result = await installSkill(skill, {
      app: body.app,
      homeDir: body.homeDir ?? homeDir,
      mniuRoot,
      dryRun: body.dryRun,
      mode: body.mode
    });
    const installation = body.dryRun
      ? undefined
      : await localStore.saveSkillInstallation({
          skillId: skill.id,
          app: body.app,
          mode: body.mode,
          sourcePath: result.sourcePath ?? skill.sourcePath,
          targetPath: result.targetPath,
          installedHash: result.installedHash ?? "",
          backupPath: result.backupPath
        });
    if (!body.dryRun) {
      await appendLiveConfigAudit({
        action: "skill.install",
        apps: [body.app],
        entityType: "skill",
        entityId: skill.id,
        targetPaths: [result.targetPath]
      });
    }
    return {
      skill,
      result,
      ...(installation ? { installation } : {})
    };
  });

  app.post("/v1/skills/:id/uninstall", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = skillUninstallSchema.parse(request.body ?? {});
    const skill = await localStore.getSkill(id);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    const installation = await localStore.getSkillInstallation(skill.id, body.app);
    const result = await uninstallSkill(skill, {
      app: body.app,
      homeDir: body.homeDir ?? homeDir,
      mniuRoot,
      dryRun: body.dryRun,
      installation
    });
    if (!body.dryRun) {
      await localStore.deleteSkillInstallation(skill.id, body.app);
      await appendLiveConfigAudit({
        action: "skill.uninstall",
        apps: [body.app],
        entityType: "skill",
        entityId: skill.id,
        targetPaths: [result.targetPath]
      });
    }
    return { skill, result };
  });

  app.delete("/v1/skills/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const skill = await localStore.getSkill(id);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    await localStore.deleteSkill(id);
    return reply.code(204).send();
  });

  app.get("/v1/providers", async (request) => {
    const query = request.query as { app?: string };
    const appFilter = query.app ? providerConsumerSchema.parse(query.app) : undefined;
    const providers = await localStore.listProviders(appFilter);
    if (runtimeProfile === "enterprise") {
      const context = requestContexts.get(request) ?? localRequestContext(request.id);
      return {
        providers: providers.filter((provider) => {
          const scope = provider.config.enterpriseScope;
          if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
          const tenantIds = (scope as Record<string, unknown>).tenantIds;
          return Array.isArray(tenantIds) && tenantIds.includes(context.tenantId);
        })
      };
    }
    return {
      providers
    };
  });

  app.post("/v1/providers", async (request, reply) => {
    const body = providerCreateSchema.parse(request.body);
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    if (runtimeProfile === "enterprise") {
      const scope = body.config?.enterpriseScope;
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
        return reply.code(400).send({ error: "enterprise provider scope is required" });
      }
      const record = scope as Record<string, unknown>;
      const tenantIds = Array.isArray(record.tenantIds)
        ? record.tenantIds.filter((value): value is string => typeof value === "string")
        : [];
      const projectIds = Array.isArray(record.projectIds)
        ? record.projectIds.filter((value): value is string => typeof value === "string")
        : [];
      if (
        tenantIds.length !== 1 ||
        tenantIds[0] !== context.tenantId ||
        projectIds.some((projectId) => store.projects.get(projectId)?.tenantId !== context.tenantId)
      ) {
        return reply.code(400).send({ error: "enterprise provider scope crosses the authenticated tenant" });
      }
    }
    const apiKeyRef = await providerApiKeyRef(body.apiKey, body.apiKeyEnv);
    const input = buildProviderCreateInput(body, apiKeyRef);
    try {
      const provider = await localStore.createProvider(input);
      const redacted = redactProvider(provider);
      if (runtimeProfile === "enterprise") {
        await appendAuditEvent({
          id: randomUUID(),
          tenantId: context.tenantId,
          actorId: context.actorId,
          action: "provider.create",
          resourceType: "provider",
          resourceId: provider.id,
          policyDecision: "allow",
          afterDigest: sha256Canonical(JSON.parse(JSON.stringify(redacted))),
          traceId: context.traceId,
          result: "success",
          timestamp: new Date().toISOString(),
          statusCode: 201
        });
      }
      return reply.code(201).send(redacted);
    } catch (error) {
      if (apiKeyRef?.type === "local_encrypted" || apiKeyRef?.type === "keychain") {
        await secretVault.deleteSecret(apiKeyRef.ref, apiKeyRef.type);
      }
      throw error;
    }
  });

  app.get("/v1/providers/export", async (request) => {
    const query = providerExportQuerySchema.parse(request.query);
    const providers = await localStore.listProviders(query.app);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      secretPolicy: "env_refs_only",
      providers: providers.map(providerToExportItem)
    };
  });

  app.post("/v1/providers/import", async (request) => {
    const body = providerImportSchema.parse(request.body);
    return importProviders(body.providers, {
      dryRun: body.dryRun,
      existingProviders: await localStore.listProviders(),
      createProvider: (input) => localStore.createProvider(input)
    });
  });

  app.post("/v1/deep-links/preview", async (request, reply) => {
    const body = deepLinkPreviewSchema.parse(request.body);
    return handleDeepLinkImport(body.url, true, reply);
  });

  app.post("/v1/deep-links/import", async (request, reply) => {
    const body = deepLinkImportSchema.parse(request.body);
    return handleDeepLinkImport(body.url, body.dryRun, reply);
  });

  app.post("/v1/providers/model-catalog/sync-due", async (request, reply) => {
    const bodyResult = providerModelCatalogSyncDueSchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: "invalid model catalog sync-due request",
        details: bodyResult.error.issues.map((issue) => issue.message)
      });
    }
    if (bodyResult.data.providerIds) {
      const selectedProviders = await Promise.all(
        bodyResult.data.providerIds.map((id) => localStore.getProvider(id))
      );
      const agentProvider = selectedProviders.find(isAgentOnlyProvider);
      if (agentProvider) {
        return reply.code(400).send({
          error: `model catalog sync is unavailable for embedded agent provider ${agentProvider.name}`
        });
      }
    }
    return syncDueProviderModelCatalogs(bodyResult.data);
  });

  app.get("/v1/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const provider = await localStore.getProvider(id);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    return redactProvider(provider);
  });

  app.get("/v1/providers/:id/model-catalog/audit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = providerModelCatalogAuditQuerySchema.parse(request.query);
    const provider = await localStore.getProvider(id);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    if (isAgentOnlyProvider(provider)) {
      return reply.code(400).send({
        error: `model catalog audit is unavailable for embedded agent provider ${provider.name}`
      });
    }
    return buildProviderModelCatalogAudit(provider, query.maxAgeDays);
  });

  app.patch("/v1/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = providerPatchSchema.parse(request.body);
    const existing = await localStore.getProvider(id);
    if (!existing) return reply.code(404).send({ error: "provider not found" });
    const apiKeyRef = await providerApiKeyRef(body.apiKey, body.apiKeyEnv);
    let provider;
    try {
      provider = await localStore.updateProvider(id, {
        ...body,
        ...(apiKeyRef ? { apiKeyRef } : {})
      });
    } catch (error) {
      if (apiKeyRef?.type === "local_encrypted" || apiKeyRef?.type === "keychain") {
        await secretVault.deleteSecret(apiKeyRef.ref, apiKeyRef.type);
      }
      throw error;
    }
    if (apiKeyRef && existing.apiKeyRef && existing.apiKeyRef.ref !== apiKeyRef.ref) {
      await deleteProviderSecretIfUnused(existing.apiKeyRef);
    }
    return reply.send(redactProvider(provider));
  });

  app.post("/v1/providers/:id/model-catalog/sync", async (request, reply) => {
    const { id } = request.params as { id: string };
    const bodyResult = providerModelCatalogSyncSchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: "invalid model catalog sync request",
        details: bodyResult.error.issues.map((issue) => issue.message)
      });
    }

    const provider = await localStore.getProvider(id);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    if (isAgentOnlyProvider(provider)) {
      return reply.code(400).send({
        error: `model catalog sync is unavailable for embedded agent provider ${provider.name}`
      });
    }

    let incomingModels: ProviderModel[];
    try {
      incomingModels = bodyResult.data.catalog
        ? providerModelsFromCatalogDocument(bodyResult.data.catalog)
        : await providerModelsFromCatalogUrl(bodyResult.data.sourceUrl as string);
    } catch (error) {
      return reply.code(400).send({
        error: "invalid model catalog",
        details: [errorDetail(error)]
      });
    }

    const source = bodyResult.data.sourceUrl
      ? ({ type: "url", url: bodyResult.data.sourceUrl } as const)
      : ({ type: "inline" } as const);
    const sync = buildProviderModelCatalogSync(provider, incomingModels, bodyResult.data.mode);
    const syncMetadata = buildProviderModelCatalogSyncMetadata(sync.modelCatalog, {
      source,
      mode: bodyResult.data.mode,
      maxAgeDays: bodyResult.data.maxAgeDays,
      syncedAt: new Date().toISOString()
    });
    const syncPolicy =
      source.type === "url" && bodyResult.data.savePolicy
        ? buildProviderModelCatalogSyncPolicy({
            sourceUrl: source.url,
            mode: bodyResult.data.mode,
            maxAgeDays: bodyResult.data.maxAgeDays,
            refreshIntervalHours: bodyResult.data.refreshIntervalHours,
            updatedAt: syncMetadata.syncedAt
          })
        : readProviderModelCatalogSyncPolicy(provider.config.modelCatalogSyncPolicy);
    const syncedProvider = bodyResult.data.dryRun
      ? provider
      : await localStore.updateProvider(id, {
          modelCatalog: sync.modelCatalog,
          config: {
            ...provider.config,
            modelCatalogSync: syncMetadata,
            ...(source.type === "url" && bodyResult.data.savePolicy
              ? { modelCatalogSyncPolicy: syncPolicy }
              : {})
          }
        });

    return {
      dryRun: bodyResult.data.dryRun,
      mode: bodyResult.data.mode,
      source,
      syncMetadata,
      syncPolicy,
      syncMetadataPersisted: !bodyResult.data.dryRun,
      provider: redactProvider(syncedProvider),
      currentCount: provider.modelCatalog.length,
      incomingCount: incomingModels.length,
      finalCount: sync.modelCatalog.length,
      addedCount: sync.addedCount,
      updatedCount: sync.updatedCount,
      removedCount: sync.removedCount,
      unchangedCount: sync.unchangedCount,
      previewModelCatalog: sync.modelCatalog
    };
  });

  app.post("/v1/providers/:id/duplicate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = providerDuplicateSchema.parse(request.body ?? {});
    const source = await localStore.getProvider(id);
    if (!source) return reply.code(404).send({ error: "provider not found" });
    const provider = await localStore.createProvider({
      app: body.app ? normalizeProviderApp(body.app) : source.app,
      name: body.name?.trim() || `${source.name} Copy`,
      kind: source.kind,
      apiFormat: source.apiFormat,
      baseUrl: source.baseUrl,
      defaultModel: source.defaultModel,
      modelReasoningEffort: source.modelReasoningEffort,
      disableResponseStorage: source.disableResponseStorage,
      wireApi: source.wireApi,
      apiKeyRef: source.apiKeyRef,
      modelCatalog: source.modelCatalog,
      config: { ...source.config },
      enabled: body.enabled
    });
    return reply.code(201).send(redactProvider(provider));
  });

  app.post("/v1/providers/:id/enable", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = providerEnableSchema.parse(request.body ?? {});
    const provider = await localStore.getProvider(id);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    const appTarget = resolveProviderAppTarget(provider.app, body.app);
    if (!providerSupportsApp(provider, appTarget)) {
      return reply.code(400).send({ error: `${provider.name} does not support ${appTarget}` });
    }

    const projection =
      appTarget === "claude"
        ? await projectClaudeProvider(provider, {
            homeDir: body.homeDir ?? homeDir,
            mniuRoot,
            dryRun: body.dryRun,
            secretResolver: resolveStoredSecret
          })
        : await projectCodexProvider(provider, {
            homeDir: body.homeDir ?? homeDir,
            mniuRoot,
            dryRun: body.dryRun,
            mode: body.mode,
            secretResolver: resolveStoredSecret
          });

    const enabledProvider = body.dryRun
      ? provider
      : await localStore.enableProvider(id, appTarget);
    if (!body.dryRun && projection.changed) {
      await localStore.saveProjection({
        providerId: provider.id,
        app: appTarget,
        purpose: "provider",
        targetPath: projection.targetPath,
        liveConfigHash: projection.liveConfigHash,
        backupPath: projection.backupPath,
        files: projection.files,
        mode: body.mode
      });
      await appendLiveConfigAudit({
        action: "provider.enable",
        apps: [appTarget],
        entityType: "provider",
        entityId: provider.id,
        targetPaths: projection.files?.map((file) => file.targetPath) ?? [projection.targetPath]
      });
    }

    return {
      provider: redactProvider(enabledProvider),
      projection: {
        ...projection,
        projectedConfig: redactProjectedConfig(projection.projectedConfig),
        filePreviews: projection.filePreviews?.map((preview) => ({
          ...preview,
          before: redactProjectedConfig(preview.before),
          after: redactProjectedConfig(preview.after)
        }))
      }
    };
  });

  app.post("/v1/providers/:id/restore", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = providerRestoreSchema.parse(request.body ?? {});
    const provider = await localStore.getProvider(id);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    const appTarget = resolveProviderAppTarget(provider.app, body.app);
    const projection = await localStore.getLatestProjection({
      app: appTarget,
      purpose: "provider"
    });
    if (!projection?.targetPath || projection.providerId !== id) {
      return reply.code(404).send({
        error: `no current provider projection for ${provider.name} on ${appTarget}`
      });
    }
    const projectionFiles = projection.files?.length
      ? projection.files
      : [{
          targetPath: projection.targetPath,
          backupPath: projection.backupPath,
          liveConfigHash: projection.liveConfigHash
        }];
    const restoreSet = await restoreLiveConfigProjectionSet(
      projectionFiles.map((file) => ({
        targetPath: file.targetPath,
        backupPath: file.backupPath,
        expectedLiveConfigHash: file.liveConfigHash
      })),
      body.dryRun
    );
    if (restoreSet.conflict) {
      return reply.code(409).send({
        error: "live config changed after provider enable",
        restore: restoreSet.files[0],
        files: restoreSet.files
      });
    }
    const restoredProvider = body.dryRun
      ? provider
      : await localStore.disableProvider(id, appTarget);
    if (!body.dryRun) {
      await appendLiveConfigAudit({
        action: "provider.restore",
        apps: [appTarget],
        entityType: "provider",
        entityId: provider.id,
        targetPaths: projectionFiles.map((file) => file.targetPath)
      });
    }
    return {
      provider: redactProvider(restoredProvider),
      app: appTarget,
      restore: restoreSet.files[0],
      files: restoreSet.files
    };
  });

  app.post("/v1/providers/:id/test-endpoint", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = providerTestEndpointSchema.parse(request.body ?? {});
    const provider = await localStore.getProvider(id);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    if (provider.app === "agent") {
      return reply.code(400).send({
        error: "embedded agent providers do not use the legacy endpoint probe"
      });
    }
    const token = await resolveProviderToken(provider);
    const probe = await probeProviderEndpoint(provider, {
      token,
      timeoutMs: body.timeoutMs
    });
    await Promise.all(
      proxyHealthApps(provider.app).map((appTarget) => {
        const policy = providerHealthPolicy(provider);
        return localStore.recordProviderHealthEvent({
          providerId: provider.id,
          app: appTarget,
          ok: probe.ok,
          ...(probe.statusCode ? { statusCode: probe.statusCode } : {}),
          latencyMs: probe.latencyMs,
          ...(probe.error ? { error: probe.error } : {}),
          retryable: probe.retryable,
          occurredAt: probe.checkedAt,
          failureThreshold: policy.failureThreshold,
          circuitOpenMs: policy.circuitOpenMs
        });
      })
    );
    return {
      providerId: provider.id,
      ...probe
    };
  });

  app.delete("/v1/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const provider = await localStore.getProvider(id);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    await localStore.deleteProvider(id);
    if (provider.apiKeyRef) await deleteProviderSecretIfUnused(provider.apiKeyRef);
    return reply.code(204).send();
  });

  app.get("/v1/proxy/status", async () => readProxyStatus());

  app.post("/v1/proxy/start", async (request) => {
    const body = proxyStartSchema.parse(request.body ?? {});
    const current = await localStore.readProxy();
    const port = body.port ?? current.port;
    proxyServer = proxyServer ?? new LocalProxyServer({
      ...(body.host ? { host: body.host } : {}),
      port,
      resolveProvider: async (appTarget) => {
        const provider = await localStore.getEnabledProvider(appTarget);
        if (!provider) return undefined;
        return {
          app: appTarget,
          provider,
          bearerToken: await resolveProviderToken(provider)
        };
      },
      resolveProviders: async (appTarget, trustedAssociation) => {
        const providers = await localStore.listProviders(appTarget);
        const healthRecords = await localStore.listProviderHealth({ app: appTarget });
        const healthByProvider = new Map(
          healthRecords.map((health) => [health.providerId, health])
        );
        const enterpriseRun = runtimeProfile === "enterprise" && trustedAssociation
          ? store.runs.get(trustedAssociation.runId)
          : undefined;
        const enterpriseCandidate = enterpriseRun?.candidates.find(
          (candidate) => candidate.id === trustedAssociation?.candidateId
        );
        const enterpriseProject = enterpriseRun
          ? store.projects.get(enterpriseRun.projectId)
          : undefined;
        if (
          runtimeProfile === "enterprise" &&
          (!trustedAssociation ||
            trustedAssociation.tenantId !== enterpriseRun?.tenantId ||
            (enterpriseCandidate !== undefined &&
              enterpriseCandidate.provider !== appTarget) ||
            !enterpriseRun?.harnessManifest?.executionPolicy.allowedProviders
              ?.includes(appTarget) ||
            enterpriseProject?.tenantId !== trustedAssociation.tenantId)
        ) {
          return [];
        }
        const orderedProviders = (runtimeProfile === "enterprise"
          ? providers.filter((provider) => provider.enabled)
          : [
              ...providers.filter((provider) => provider.enabled),
              ...providers.filter((provider) => !provider.enabled)
            ])
          .filter((provider) => !isCircuitOpen(healthByProvider.get(provider.id)))
          .filter((provider) => {
            if (runtimeProfile !== "enterprise") return true;
            const scope = provider.config.enterpriseScope;
            if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
            const record = scope as Record<string, unknown>;
            const tenantIds = Array.isArray(record.tenantIds)
              ? record.tenantIds.filter((value): value is string => typeof value === "string")
              : [];
            const projectIds = Array.isArray(record.projectIds)
              ? record.projectIds.filter((value): value is string => typeof value === "string")
              : [];
            return tenantIds.includes(trustedAssociation!.tenantId) &&
              (projectIds.length === 0 || projectIds.includes(enterpriseRun!.projectId));
          });
        const resolved = await Promise.all(
          orderedProviders.map(async (provider) => ({
            app: appTarget,
            provider,
            bearerToken: await resolveProviderToken(provider)
          }))
        );
        if (runtimeProfile === "enterprise") {
          const plan = trustedAssociation!.providerPlan;
          if (
            !plan ||
            plan.projectId !== enterpriseRun!.projectId ||
            plan.app !== appTarget ||
            plan.providerIds.join("\0") !==
              orderedProviders.map((provider) => provider.id).join("\0")
          ) {
            return [];
          }
          const providersForDigest = resolved.map(({ provider, bearerToken }) => ({
            providerId: provider.id,
            providerAccountId:
              typeof provider.config.providerAccountId === "string"
                ? provider.config.providerAccountId
                : provider.id,
            baseUrl: provider.baseUrl,
            apiFormat: provider.apiFormat,
            defaultModel: provider.defaultModel,
            enterpriseCapabilities: provider.enterpriseCapabilities ?? null,
            credentialDigest: createHmac("sha256", sandboxAttestationKey!)
              .update(bearerToken ?? "")
              .digest("hex")
          }));
          const liveDigest = sha256Canonical({
            schemaVersion: 1,
            tenantId: trustedAssociation!.tenantId,
            projectId: enterpriseRun!.projectId,
            runId: enterpriseRun!.id,
            candidateId: trustedAssociation!.candidateId,
            app: appTarget,
            providers: providersForDigest
          });
          if (liveDigest !== plan.digest) return [];
        }
        return resolved;
      },
      appendLog: async (log) => {
        if (runtimeProfile === "enterprise") {
          if (!enterprisePostgres || !providerUsageTerminalJournal) {
            throw new Error("enterprise provider usage ledger is unavailable");
          }
          try {
            const journalRef = await providerUsageTerminalJournal.persist(log);
            await enterprisePostgres.appendProviderUsageLog(log, journalRef);
          } catch (error) {
            app.log.error({ err: error }, "enterprise provider usage terminal accounting failed");
            throw error;
          }
          return;
        }
        await localStore.appendProxyRequestLog(log);
      },
      ...(runtimeProfile === "enterprise"
        ? {
            requireTrustedUsageAssociation: true,
            semanticDigestKey: sandboxAttestationKey,
            verifyUsageAssociationReceipt: createEnterpriseProviderUsageReceiptVerifier({
              signingKey: sandboxAttestationKey,
              authority: enterprisePostgres
            }),
            reserveTrustedUsageAssociation: (
              association,
              intent?: ProviderUsagePreparationIntent
            ) => {
              const run = store.runs.get(association.runId);
              if (!intent || !run) {
                throw new Error(
                  "enterprise provider request has no reliable immutable conservative hold"
                );
              }
              const conservativeHold = enterpriseProviderUsageConservativeHold(run);
              return enterprisePostgres!.reserveProviderUsageAssociation(
                association,
                Object.freeze({ ...intent, conservativeHold })
              );
            },
            markProviderUsageAttemptDispatchStarted: (association, intent) =>
              enterprisePostgres!.markProviderUsageAttemptDispatchStarted(
                association,
                intent
              ),
            markProviderUsageAttemptUnknown: (association, intent) =>
              enterprisePostgres!.markProviderUsageAttemptUnknown(
                association,
                intent
              )
          }
        : {}),
      getReplay: (key) => localStore.getProxyReplayRecord(key),
      saveReplay: async (record) => {
        await localStore.saveProxyReplayRecord(record);
      },
      markReplayUsed: async (key) => {
        await localStore.markProxyReplayRecordReplayed(key);
      },
      recordProviderHealth: async (event) => {
        const provider = await localStore.getProvider(event.providerId);
        const policy = providerHealthPolicy(provider);
        await localStore.recordProviderHealthEvent({
          ...event,
          failureThreshold: policy.failureThreshold,
          circuitOpenMs: policy.circuitOpenMs
        });
      }
    });
    const runtime = await proxyServer.start();
    const proxy = await localStore.writeProxy({
      ...current,
      status: "running",
      port: runtime.port
    });
    return { proxy, runtime };
  });

  app.post("/v1/proxy/stop", async (request, reply) => {
    const body = proxyStopSchema.parse(request.body ?? {});
    const current = await localStore.readProxy();
    const runtimeBefore = proxyServer?.status() ?? {
      running: false,
      host: "127.0.0.1",
      port: current.port
    };
    const takeoverProjections = [];
    for (const appTarget of current.takenOverApps) {
      const projection = await localStore.getLatestProjection({
        app: appTarget,
        purpose: "proxy_takeover"
      });
      if (!projection?.targetPath) {
        return reply.code(409).send({
          error: `cannot safely stop: missing takeover projection for ${appTarget}`
        });
      }
      takeoverProjections.push({ app: appTarget, projection });
    }
    const restoreInputs = takeoverProjections.map(({ projection }) => ({
      targetPath: projection.targetPath as string,
      backupPath: projection.backupPath,
      expectedLiveConfigHash: projection.liveConfigHash
    }));
    const preview = await restoreLiveConfigProjectionSet(restoreInputs, true);
    if (preview.conflict) {
      return reply.code(409).send({
        error: "cannot safely stop: a taken-over live config changed",
        restoration: preview
      });
    }
    const filePreviews = await Promise.all(
      takeoverProjections.map(async ({ projection }) => ({
        targetPath: projection.targetPath as string,
        before: redactProjectedConfig(
          await readOptionalText(projection.targetPath as string)
        ),
        after: redactProjectedConfig(
          projection.backupPath ? await readOptionalText(projection.backupPath) : ""
        )
      }))
    );
    if (body.dryRun) {
      return {
        proxy: current,
        runtime: runtimeBefore,
        restoration: preview,
        filePreviews,
        dryRun: true
      };
    }
    const restoration = await restoreLiveConfigProjectionSet(restoreInputs, false);
    for (const { app: appTarget, projection } of takeoverProjections) {
      await appendLiveConfigAudit({
        action: "proxy.restore_on_stop",
        apps: [appTarget],
        entityType: "proxy_projection",
        entityId: projection.id,
        targetPaths: [projection.targetPath as string]
      });
    }
    const runtime = await proxyServer?.stop();
    proxyServer = undefined;
    const proxy = await localStore.writeProxy({
      ...current,
      status: "stopped",
      takenOverApps: []
    });
    return {
      proxy,
      runtime: runtime ?? { running: false, host: "127.0.0.1", port: current.port },
      restoration,
      filePreviews,
      dryRun: false
    };
  });

  app.post("/v1/proxy/apps/:app/takeover", async (request, reply) => {
    const { app: appParam } = request.params as { app: string };
    const body = proxyAppActionSchema.parse(request.body ?? {});
    const appTarget = managedAppSchema.parse(appParam);
    const current = await localStore.readProxy();
    const provider = await localStore.getEnabledProvider(appTarget);
    if (!provider) {
      return reply.code(404).send({ error: `no enabled provider for ${appTarget}` });
    }
    const runtime = proxyServer?.status() ?? {
      running: current.status === "running",
      host: "127.0.0.1",
      port: current.port
    };
    if (!runtime.running) {
      return reply.code(409).send({ error: "local proxy must be running before takeover" });
    }
    const proxyBaseUrl = `http://${runtime.host}:${runtime.port}`;
    const projection =
      appTarget === "claude"
        ? await projectClaudeProxyConfig(provider, {
            homeDir: body.homeDir ?? homeDir,
            mniuRoot,
            dryRun: body.dryRun,
            proxyBaseUrl
          })
        : await projectCodexProxyConfig(provider, {
            homeDir: body.homeDir ?? homeDir,
            mniuRoot,
            dryRun: body.dryRun,
            proxyBaseUrl
          });
    const takenOverApps = Array.from(new Set([...current.takenOverApps, appTarget]));
    if (!body.dryRun) {
      await localStore.saveProjection({
        providerId: provider.id,
        app: appTarget,
        purpose: "proxy_takeover",
        targetPath: projection.targetPath,
        liveConfigHash: projection.liveConfigHash,
        backupPath: projection.backupPath,
        mode: "local_route"
      });
      await appendLiveConfigAudit({
        action: "proxy.takeover",
        apps: [appTarget],
        entityType: "provider",
        entityId: provider.id,
        targetPaths: [projection.targetPath]
      });
    }
    return {
      proxy: body.dryRun
        ? current
        : await localStore.writeProxy({ ...current, takenOverApps }),
      projection: {
        ...projection,
        projectedConfig: redactProjectedConfig(projection.projectedConfig),
        filePreviews: projection.filePreviews?.map((preview) => ({
          ...preview,
          before: redactProjectedConfig(preview.before),
          after: redactProjectedConfig(preview.after)
        }))
      }
    };
  });

  app.post("/v1/proxy/apps/:app/restore", async (request, reply) => {
    const { app: appParam } = request.params as { app: string };
    const body = proxyAppActionSchema.parse(request.body ?? {});
    const appTarget = managedAppSchema.parse(appParam);
    const current = await localStore.readProxy();
    const projection = await localStore.getLatestProjection({
      app: appTarget,
      purpose: "proxy_takeover"
    });
    if (!projection?.targetPath) {
      return reply.code(404).send({ error: `no proxy takeover projection for ${appTarget}` });
    }
    const restore = await restoreLiveConfigProjection({
      targetPath: projection.targetPath,
      backupPath: projection.backupPath,
      expectedLiveConfigHash: projection.liveConfigHash,
      dryRun: body.dryRun
    });
    if (restore.conflict) {
      return reply.code(409).send({
        error: "live config changed after takeover",
        restore
      });
    }
    const takenOverApps = current.takenOverApps.filter((item) => item !== appTarget);
    if (!body.dryRun) {
      await appendLiveConfigAudit({
        action: "proxy.restore",
        apps: [appTarget],
        entityType: "proxy_projection",
        entityId: projection.id,
        targetPaths: [projection.targetPath]
      });
    }
    return {
      proxy: body.dryRun
        ? current
        : await localStore.writeProxy({ ...current, takenOverApps }),
      restore
    };
  });

  const readUsageRouteAccounting = async (
    tenantId: string,
    projectIds: readonly string[],
    query: UsageRouteQuery,
    defaultLimit: number
  ) => {
    if (runtimeProfile !== "enterprise") {
      return {
        source: "local" as const,
        logs: await localStore.listProxyRequestLogs({
          ...query,
          limit: query.limit ?? defaultLimit
        })
      };
    }
    if (!enterprisePostgres) return { source: "unavailable" as const };
    try {
      const accounting = await enterprisePostgres.queryProviderUsageAccounting({
        tenantId,
        app: query.app,
        providerId: query.providerId,
        runId: query.runId,
        candidateId: query.candidateId,
        projectIds,
        limit: query.limit ?? defaultLimit
      });
      return {
        source: "enterprise" as const,
        logs: accounting.usageLogs,
        accounting
      };
    } catch {
      // PostgreSQL is the enterprise SSOT. Runtime query faults are a service
      // availability condition, never a local fallback or an internal-error
      // detail exposed to the caller.
      return { source: "unavailable" as const };
    }
  };
  const usageAccountingUnavailable = (reply: FastifyReply) =>
    reply.code(503).send({
      error: "enterprise provider usage ledger is unavailable"
    });
  const pendingUsageAccounting = (
    reply: FastifyReply,
    result: Extract<
      Awaited<ReturnType<typeof readUsageRouteAccounting>>,
      { source: "enterprise" }
    >
  ) => reply.code(409).send({
    error: `provider usage accounting has ${result.accounting.pendingReservationCount} pending reservation(s) for tenant ${result.accounting.tenantId}`,
    accounting: {
      schemaVersion: 1,
      status: "pending",
      tenantId: result.accounting.tenantId,
      pendingReservationCount: result.accounting.pendingReservationCount,
      pendingReservations: result.accounting.pendingReservations
    }
  });
  const settledUsageAccounting = (
    result: Extract<
      Awaited<ReturnType<typeof readUsageRouteAccounting>>,
      { source: "enterprise" }
    >
  ) => ({
    schemaVersion: 1 as const,
    status: "settled" as const,
    tenantId: result.accounting.tenantId,
    pendingReservationCount: 0
  });
  type ProviderUsageReconciliationBody = z.infer<
    typeof providerUsageReconciliationSchema
  >;
  const verifyProviderUsageReconciliationEvidence = async (input: {
    request: ProviderUsageRequestSnapshot;
    body: ProviderUsageReconciliationBody;
  }): Promise<
    | { ok: true; evidence: ProviderUsageReconciliationEvidence }
    | { ok: false; statusCode: 400 | 409 | 503; error: string }
  > => {
    if (
      !artifactRemoteStore ||
      artifactRemoteStore.type !== "s3" ||
      !artifactRemoteStore.s3Client
    ) {
      return {
        ok: false,
        statusCode: 503,
        error: "enterprise provider usage evidence store is unavailable"
      };
    }
    const match = /^s3:\/\/([^/?#]+)\/(.+)$/u.exec(input.body.evidence.uri);
    if (!match?.[1] || !match[2] || /[%\\?#\u0000-\u001f\u007f]/u.test(match[2])) {
      return { ok: false, statusCode: 400, error: "provider usage evidence URI is invalid" };
    }
    const bucket = match[1];
    const key = match[2];
    const segments = key.split("/");
    if (
      bucket !== artifactRemoteStore.bucket ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      return {
        ok: false,
        statusCode: 400,
        error: "provider usage evidence is outside the configured store"
      };
    }
    const ownershipPrefix = [
      artifactRemoteStore.prefix,
      "tenants",
      input.request.tenantId,
      "runs",
      input.request.runId,
      "provider-usage",
      input.request.logicalRequestId
    ].filter((part): part is string => Boolean(part)).join("/");
    if (!key.startsWith(`${ownershipPrefix}/`)) {
      return {
        ok: false,
        statusCode: 400,
        error: "provider usage evidence ownership binding is invalid"
      };
    }
    let bytes: Buffer | undefined;
    try {
      bytes = options.providerUsageEvidenceLoader
        ? await options.providerUsageEvidenceLoader({
            bucket,
            key,
            uri: input.body.evidence.uri
          })
        : await artifactRemoteStore.s3Client.getObject(key);
    } catch {
      return {
        ok: false,
        statusCode: 503,
        error: "enterprise provider usage evidence store is unavailable"
      };
    }
    if (!bytes) {
      return { ok: false, statusCode: 400, error: "provider usage evidence does not exist" };
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== input.body.evidence.sha256) {
      return { ok: false, statusCode: 409, error: "provider usage evidence digest mismatch" };
    }
    if (bytes.byteLength > 1_048_576) {
      return { ok: false, statusCode: 400, error: "provider usage evidence is too large" };
    }
    let exactEnvelope: unknown;
    let verifiedExact: ReturnType<
      typeof providerUsageEvidenceVerifier.verify
    > | undefined;
    if (input.body.decision === "exact") {
      try {
        exactEnvelope = JSON.parse(bytes.toString("utf8"));
        const accountedAttemptIndexes = new Set(
          input.request.usageLogs
            .map((log) =>
              (log as { usageAttempt?: { index?: unknown } }).usageAttempt?.index
            )
            .filter((index): index is number =>
              typeof index === "number" && Number.isSafeInteger(index) && index > 0
            )
        );
        const dispatches = input.request.lifecycle
          .filter((event) => event.type === "attempt_dispatch_started");
        const dispatch = dispatches
          .filter((event) =>
            event.attemptIndex !== undefined &&
            !accountedAttemptIndexes.has(event.attemptIndex)
          )
          .at(-1) ?? (input.request.status === "finalized" ? dispatches.at(-1) : undefined);
        const legacyReservation =
          input.request.legacy &&
          !input.request.prepared &&
          !input.request.lifecycle.some(
            (event) => event.type === "attempt_dispatch_started"
          );
        const providerId = dispatch?.payload.providerId ??
          (legacyReservation ? input.body.providerId : undefined);
        const providerAccountId = dispatch?.payload.providerAccountId ??
          (legacyReservation ? input.body.providerAccountId : undefined);
        const dispatchRequestDigest = dispatch?.payload.requestDigest ??
          (legacyReservation ? input.request.recoveryDigest : undefined);
        const outboundRequestKeyDigest =
          dispatch?.payload.outboundIdempotencyKeyDigest;
        if (
          (!dispatch && !legacyReservation) ||
          typeof providerId !== "string" ||
          typeof providerAccountId !== "string" ||
          typeof dispatchRequestDigest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(dispatchRequestDigest) ||
          (outboundRequestKeyDigest !== undefined &&
            (typeof outboundRequestKeyDigest !== "string" ||
              !/^[a-f0-9]{64}$/u.test(outboundRequestKeyDigest)))
        ) {
          return {
            ok: false,
            statusCode: 409,
            error: "exact provider usage dispatch evidence is unavailable"
          };
        }
        const verifiedAt = new Date().toISOString();
        verifiedExact = providerUsageEvidenceVerifier.verify(exactEnvelope, {
          kind: input.body.evidence.kind,
          app: input.request.prepared?.app ?? input.body.app,
          tenantId: input.request.tenantId,
          runId: input.request.runId,
          logicalRequestId: input.request.logicalRequestId,
          providerId,
          providerAccountId,
          providerRequestId: input.body.providerRequestId,
          dispatchRequestDigest,
          ...(typeof outboundRequestKeyDigest === "string"
            ? { outboundRequestKeyDigest }
            : {}),
          model: input.body.model,
          statusCode: input.body.statusCode,
          tokens: {
            inputTokens: input.body.inputTokens,
            outputTokens: input.body.outputTokens,
            cachedInputTokens: input.body.cachedInputTokens,
            cacheCreationInputTokens: input.body.cacheCreationInputTokens,
            cacheReadInputTokens: input.body.cacheReadInputTokens,
            reasoningOutputTokens: input.body.reasoningOutputTokens
          },
          authoritativeCostUsd: input.body.authoritativeCostUsd,
          verificationTime: verifiedAt
        });
      } catch (error) {
        if (error instanceof ProviderUsageEvidenceVerificationUnavailableError) {
          return {
            ok: false,
            statusCode: 503,
            error: "exact provider usage evidence authority is unavailable"
          };
        }
        return {
          ok: false,
          statusCode: error instanceof ProviderUsageEvidenceInvalidError ? 409 : 400,
          error: "exact provider usage evidence verification failed"
        };
      }
    }
    const verifiedAt = new Date().toISOString();
    const envelopeDigest = exactEnvelope
      ? sha256Canonical(exactEnvelope)
      : undefined;
    const verification = {
      objectKey: key,
      byteLength: bytes.byteLength,
      verifiedAt,
      ...(envelopeDigest ? { envelopeDigest } : {}),
      ...(exactEnvelope
        ? {
            sourceReference: verifiedExact!.claims.sourceReference,
            issuedAt: verifiedExact!.claims.issuedAt,
            issuer: verifiedExact!.issuer,
            keyId: verifiedExact!.keyId,
            signatureDigest: verifiedExact!.signatureDigest,
            providerAccountId: verifiedExact!.claims.providerAccountId,
            providerRequestId: verifiedExact!.claims.providerRequestId,
            dispatchRequestDigest: verifiedExact!.claims.dispatchRequestDigest,
            ...(verifiedExact!.claims.outboundRequestKeyDigest
              ? {
                  outboundRequestKeyDigest:
                    verifiedExact!.claims.outboundRequestKeyDigest
                }
              : {})
          }
        : {})
    };
    return {
      ok: true,
      evidence: Object.freeze({
        ...input.body.evidence,
        verification: Object.freeze({
          ...verification,
          verificationDigest: sha256Canonical({
            schemaVersion: 1,
            tenantId: input.request.tenantId,
            runId: input.request.runId,
            logicalRequestId: input.request.logicalRequestId,
            uri: input.body.evidence.uri,
            sha256: actualSha256,
            kind: input.body.evidence.kind,
            objectKey: verification.objectKey,
            byteLength: verification.byteLength,
            ...(verification.envelopeDigest
              ? { envelopeDigest: verification.envelopeDigest }
              : {}),
            ...(verification.sourceReference
              ? { sourceReference: verification.sourceReference }
              : {}),
            ...(verification.issuedAt ? { issuedAt: verification.issuedAt } : {}),
            ...(verifiedExact
              ? {
                  issuer: verifiedExact.issuer,
                  keyId: verifiedExact.keyId,
                  signatureDigest: verifiedExact.signatureDigest,
                  providerAccountId: verifiedExact.claims.providerAccountId,
                  providerRequestId: verifiedExact.claims.providerRequestId,
                  dispatchRequestDigest: verifiedExact.claims.dispatchRequestDigest,
                  ...(verifiedExact.claims.outboundRequestKeyDigest
                    ? {
                        outboundRequestKeyDigest:
                          verifiedExact.claims.outboundRequestKeyDigest
                      }
                    : {})
                }
              : {})
          })
        })
      })
    };
  };

  app.get("/v1/provider-usage/requests/:id", async (request, reply) => {
    if (runtimeProfile !== "enterprise") {
      return reply.code(404).send({ error: "resource not found" });
    }
    if (!enterprisePostgres) return usageAccountingUnavailable(reply);
    const { id } = request.params as { id: string };
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    if (
      context.principalType !== "human" ||
      !context.roles.some((role) =>
        role === "org_admin" || role === "governance_admin" || role === "auditor"
      )
    ) {
      return reply.code(403).send({ error: "role is not authorized for this operation" });
    }
    try {
      const usageRequest = await enterprisePostgres.readProviderUsageRequest({
        tenantId: context.tenantId,
        logicalRequestId: id,
        ...(
          context.roles.includes("org_admin") ||
          context.roles.includes("governance_admin")
            ? {}
            : { projectIds: context.projectIds }
        )
      });
      if (!usageRequest) {
        return reply.code(404).send({ error: "provider usage request not found" });
      }
      return { request: usageRequest };
    } catch {
      return usageAccountingUnavailable(reply);
    }
  });

  app.post("/v1/provider-usage/requests/:id/reconcile", async (request, reply) => {
    if (runtimeProfile !== "enterprise") {
      return reply.code(404).send({ error: "resource not found" });
    }
    if (!enterprisePostgres) return usageAccountingUnavailable(reply);
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    if (
      context.principalType !== "human" ||
      !context.roles.includes("org_admin")
    ) {
      return reply.code(403).send({ error: "role is not authorized for this operation" });
    }
    const rawIdempotencyKey = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(rawIdempotencyKey)
      ? rawIdempotencyKey[0]
      : rawIdempotencyKey;
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length === 0 ||
      idempotencyKey !== idempotencyKey.trim()
    ) {
      return reply.code(400).send({ error: "Idempotency-Key is required" });
    }
    const { id } = request.params as { id: string };
    const body = providerUsageReconciliationSchema.parse(request.body ?? {});
    try {
      const current = await enterprisePostgres.readProviderUsageRequest({
        tenantId: context.tenantId,
        logicalRequestId: id
      });
      if (!current) {
        return reply.code(404).send({ error: "provider usage request not found" });
      }
      const evidenceVerification = await verifyProviderUsageReconciliationEvidence({
        request: current,
        body
      });
      if (!evidenceVerification.ok) {
        return reply.code(evidenceVerification.statusCode).send({
          error: evidenceVerification.error
        });
      }
      const reconciled = await enterprisePostgres.reconcileProviderUsageRequest({
        tenantId: context.tenantId,
        logicalRequestId: id,
        expectedRecoveryDigest: body.expectedRecoveryDigest,
        idempotencyKey,
        actorId: context.actorId,
        traceId: context.traceId,
        reason: body.reason,
        ticket: body.ticket,
        evidence: evidenceVerification.evidence,
        decision: body.decision === "exact"
          ? {
              kind: "exact",
              app: body.app,
              providerId: body.providerId,
              model: body.model,
              statusCode: body.statusCode,
              inputTokens: body.inputTokens,
              outputTokens: body.outputTokens,
              cachedInputTokens: body.cachedInputTokens,
              cacheCreationInputTokens: body.cacheCreationInputTokens,
              cacheReadInputTokens: body.cacheReadInputTokens,
              reasoningOutputTokens: body.reasoningOutputTokens,
              authoritativeCostUsd: body.authoritativeCostUsd
            }
          : { kind: "conservative" }
      });
      if (!reconciled) {
        return reply.code(404).send({ error: "provider usage request not found" });
      }
      const existingAudit = store.auditEvents.get(reconciled.auditEvent.id);
      if (existingAudit) {
        if (
          sha256Canonical(existingAudit) !==
          sha256Canonical(reconciled.auditEvent)
        ) {
          throw new Error("provider usage reconciliation audit mirror conflict");
        }
      } else {
        store.appendAuditEvent(reconciled.auditEvent);
      }
      return { request: reconciled.request };
    } catch (error) {
      if (error instanceof ProviderUsageReconciliationConflictError) {
        return reply.code(409).send({
          error: error.safeMessage,
          code: error.code
        });
      }
      return usageAccountingUnavailable(reply);
    }
  });

  app.get("/v1/proxy/logs", async (request, reply) => {
    const query = proxyLogQuerySchema.parse(request.query);
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const result = await readUsageRouteAccounting(
      context.tenantId,
      context.projectIds,
      query,
      100
    );
    if (result.source === "unavailable") return usageAccountingUnavailable(reply);
    if (
      result.source === "enterprise" &&
      result.accounting.pendingReservationCount > 0
    ) {
      return pendingUsageAccounting(reply, result);
    }
    return {
      logs: result.logs,
      ...(result.source === "enterprise"
        ? { accounting: settledUsageAccounting(result) }
        : {})
    };
  });

  app.get("/v1/proxy/health", async (request, reply) => {
    const queryResult = proxyHealthQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.code(400).send({
        error: "invalid proxy health query",
        details: queryResult.error.issues.map((issue) => issue.message)
      });
    }
    const query = queryResult.data;
    const allProviders = await localStore.listProviders();
    const selectedProvider = query.providerId
      ? allProviders.find((provider) => provider.id === query.providerId)
      : undefined;
    if (selectedProvider && isAgentOnlyProvider(selectedProvider)) {
      return reply.code(400).send({
        error: `proxy health is unavailable for embedded agent provider ${selectedProvider.name}`
      });
    }
    const agentProviderIds = new Set(
      allProviders.filter(isAgentOnlyProvider).map((provider) => provider.id)
    );
    const appFilter = query.app;
    const providers = appFilter
      ? allProviders.filter((provider) => providerSupportsApp(provider, appFilter))
      : allProviders;
    const healthRecords = (await localStore.listProviderHealth(query))
      .filter((health) => !agentProviderIds.has(health.providerId));
    const healthByProviderApp = new Map(
      healthRecords.map((health) => [providerHealthKey(health.providerId, health.app), health])
    );
    const providerAppRows = providers.flatMap((provider) =>
      proxyHealthApps(provider.app, query.app).map((appTarget) => ({
        provider,
        app: appTarget,
        health: healthByProviderApp.get(providerHealthKey(provider.id, appTarget))
      }))
    );
    const representedKeys = new Set(
      providerAppRows.map((row) => providerHealthKey(row.provider.id, row.app))
    );
    return {
      health: [
        ...providerAppRows.map(({ provider, app: appTarget, health }) => ({
          providerId: provider.id,
          providerName: provider.name,
          app: appTarget,
          state: health?.state ?? "unknown",
          consecutiveFailures: health?.consecutiveFailures ?? 0,
          lastStatusCode: health?.lastStatusCode,
          lastLatencyMs: health?.lastLatencyMs,
          lastError: health?.lastError,
          lastSuccessAt: health?.lastSuccessAt,
          lastFailureAt: health?.lastFailureAt,
          circuitOpenedAt: health?.circuitOpenedAt,
          circuitOpenUntil: health?.circuitOpenUntil,
          updatedAt: health?.updatedAt
        })),
        ...healthRecords
          .filter((health) => !representedKeys.has(providerHealthKey(health.providerId, health.app)))
          .map((health) => ({
            ...health,
            providerName: "deleted provider"
          }))
      ]
    };
  });

  app.post("/v1/proxy/health/reset", async (request, reply) => {
    const bodyResult = proxyHealthResetSchema.safeParse(request.body ?? {});
    if (!bodyResult.success) {
      return reply.code(400).send({
        error: "invalid proxy health reset request",
        details: bodyResult.error.issues.map((issue) => issue.message)
      });
    }
    const body = bodyResult.data;
    const provider = await localStore.getProvider(body.providerId);
    if (!provider) {
      return reply.code(404).send({ error: "provider not found" });
    }
    if (isAgentOnlyProvider(provider)) {
      return reply.code(400).send({
        error: `proxy health reset is unavailable for embedded agent provider ${provider.name}`
      });
    }
    const reset = await localStore.resetProviderHealth({
      providerId: body.providerId,
      app: body.app
    });
    return {
      providerId: body.providerId,
      providerName: provider.name,
      app: body.app,
      resetCount: reset.length,
      reset
    };
  });

  app.get("/v1/usage/summary", async (request, reply) => {
    const query = usageQuerySchema.parse(request.query);
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const result = await readUsageRouteAccounting(
      context.tenantId,
      context.projectIds,
      query,
      500
    );
    if (result.source === "unavailable") return usageAccountingUnavailable(reply);
    if (
      result.source === "enterprise" &&
      result.accounting.pendingReservationCount > 0
    ) {
      return pendingUsageAccounting(reply, result);
    }
    const pricing = pricingCatalogFromProviders(await localStore.listProviders());
    return {
      generatedAt: new Date().toISOString(),
      summary: summarizeProxyRequestLogs([...result.logs], { pricing }),
      ...(result.source === "enterprise"
        ? { accounting: settledUsageAccounting(result) }
        : {})
    };
  });

  app.get("/v1/usage/requests", async (request, reply) => {
    const query = usageQuerySchema.parse(request.query);
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const result = await readUsageRouteAccounting(
      context.tenantId,
      context.projectIds,
      query,
      100
    );
    if (result.source === "unavailable") return usageAccountingUnavailable(reply);
    if (
      result.source === "enterprise" &&
      result.accounting.pendingReservationCount > 0
    ) {
      return pendingUsageAccounting(reply, result);
    }
    return {
      requests: result.logs,
      ...(result.source === "enterprise"
        ? { accounting: settledUsageAccounting(result) }
        : {})
    };
  });

  app.get("/v1/usage/models", async (request, reply) => {
    const query = usageQuerySchema.parse(request.query);
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const result = await readUsageRouteAccounting(
      context.tenantId,
      context.projectIds,
      query,
      500
    );
    if (result.source === "unavailable") return usageAccountingUnavailable(reply);
    if (
      result.source === "enterprise" &&
      result.accounting.pendingReservationCount > 0
    ) {
      return pendingUsageAccounting(reply, result);
    }
    const pricing = pricingCatalogFromProviders(await localStore.listProviders());
    return {
      models: usageModels([...result.logs], { pricing }),
      ...(result.source === "enterprise"
        ? { accounting: settledUsageAccounting(result) }
        : {})
    };
  });

  app.get("/v1/sessions", async (request) => {
    const query = sessionQuerySchema.parse(request.query);
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const sessions = await indexLocalSessions({
      homeDir: query.homeDir ?? homeDir,
      ...(query.app ? { apps: [query.app] } : {}),
      limit: limit + 1,
      offset,
      query: query.query,
      redact: query.redact
    });
    const hasMore = sessions.length > limit;
    return {
      sessions: sessions.slice(0, limit),
      pagination: {
        limit,
        offset,
        hasMore,
        ...(hasMore ? { nextOffset: offset + limit } : {})
      }
    };
  });

  app.get("/v1/sessions/:id/export", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = sessionQuerySchema.parse(request.query);
    const document = await exportLocalSession(id, {
      homeDir: query.homeDir ?? homeDir,
      ...(query.app ? { apps: [query.app] } : {}),
      redact: query.redact ?? true
    });
    if (!document) return reply.code(404).send({ error: "session not found" });
    return document;
  });

  app.get("/v1/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = sessionQuerySchema.parse(request.query);
    const session = await readLocalSession(id, {
      homeDir: query.homeDir ?? homeDir,
      ...(query.app ? { apps: [query.app] } : {}),
      redact: query.redact
    });
    if (!session) return reply.code(404).send({ error: "session not found" });
    return { session };
  });

  app.post("/v1/projects", async (request, reply) => {
    const body = projectSchema.parse(request.body);
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    let rootPath = body.rootPath;
    if (enterpriseProjectRoots) {
      try {
        rootPath = await resolveEnterpriseProjectRoot(body.rootPath, enterpriseProjectRoots);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "project.rootPath is not allowed"
        });
      }
    }
    const project: Project = {
      id: randomUUID(),
      tenantId: context.tenantId,
      name: body.name,
      rootPath,
      defaultBranch: body.defaultBranch,
      services: [],
      policyId: BUILTIN_DEFAULT_STANDARD_PACK
    };
    store.projects.set(project.id, project);
    return reply.code(201).send(project);
  });

  app.get("/v1/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = store.projects.get(id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return project;
  });

  app.post("/v1/projects/:id/index", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = store.projects.get(id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    let rootPath = project.rootPath;
    if (enterpriseProjectRoots) {
      try {
        rootPath = await resolveEnterpriseProjectRoot(project.rootPath, enterpriseProjectRoots);
      } catch {
        return reply.code(404).send({ error: "project not found" });
      }
    }
    const index = await indexRepository(rootPath);
    const updated: Project = { ...project, rootPath, services: index.services };
    store.projects.set(id, updated);
    return { project: updated, warnings: index.warnings };
  });

  app.post("/v1/tasks", async (request, reply) => {
    const parsed = taskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid task payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }
    const body = parsed.data;
    const project = store.projects.get(body.projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    if (project.tenantId !== context.tenantId) {
      return reply.code(404).send({ error: "project not found" });
    }

    if (body.specRef) {
      if ((store.specSetTenants.get(body.specRef.specSetId) ?? LOCAL_TENANT_ID) !==
        context.tenantId) {
        return reply.code(404).send({ error: "spec revision not found" });
      }
      const specRecord = await specRepository.get(body.specRef.specSetId);
      const spec = specRecord?.revisions.find(
        (candidate) => candidate.revision === body.specRef!.revision
      );
      if (
        !spec ||
        spec.status !== "approved" ||
        spec.digest !== body.specRef.digest
      ) {
        return reply.code(400).send({
          error: "specRef must bind the exact persisted approved Spec revision"
        });
      }
    }

    let workflowRef: VersionedGovernanceRef;
    let harnessProfileRef: VersionedGovernanceRef | undefined;
    try {
      workflowRef = body.workflowRef
        ? bindRuntimeCapabilityRef(
            body.workflowRef,
            capabilityCatalog.workflows,
            "workflowRef"
          )
        : resolveTaskWorkflowRef({ specRef: body.specRef });
      harnessProfileRef = body.harnessProfileRef
        ? bindRuntimeCapabilityRef(
            body.harnessProfileRef,
            capabilityCatalog.harnessProfiles,
            "harnessProfileRef"
          )
        : body.specRef
          ? bindRuntimeCapabilityRef(
              {
                id: runtimeProfile === "enterprise" ? "enterprise" : "local",
                version: "1"
              },
              capabilityCatalog.harnessProfiles,
              "harnessProfileRef"
            )
          : undefined;
      if (
        runtimeProfile === "enterprise" &&
        body.specRef &&
        harnessProfileRef?.id !== "enterprise"
      ) {
        throw new TypeError(
          "enterprise governed tasks require the enforced enterprise Harness profile"
        );
      }
    } catch (error) {
      return reply.code(400).send({
        error: "invalid task workflow bindings",
        details: [error instanceof Error ? error.message : String(error)]
      });
    }

    const task: AgentTask = {
      id: randomUUID(),
      tenantId: context.tenantId,
      projectId: body.projectId,
      title: body.title,
      intent: body.intent,
      targetServices: body.targetServices,
      prompt: body.prompt,
      acceptanceCriteria: body.acceptanceCriteria,
      strategy: normalizeStrategy(body.strategy),
      createdAt: new Date().toISOString(),
      workflowRef,
      ...(body.specRef ? { specRef: body.specRef } : {}),
      ...(harnessProfileRef
        ? { harnessProfileRef }
        : {})
    };
    const bindingErrors = validateTaskWorkflowBindings(task);
    if (bindingErrors.length > 0) {
      return reply.code(400).send({
        error: "invalid task workflow bindings",
        details: bindingErrors
      });
    }
    const policyErrors = validateTaskPolicy(task);
    if (policyErrors.length > 0) {
      return reply.code(400).send({ error: "task violates policy", details: policyErrors });
    }
    store.tasks.set(task.id, task);
    return reply.code(201).send(task);
  });

  app.get("/v1/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = store.tasks.get(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    return task;
  });

  app.post("/v1/tasks/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = runCreateSchema.parse(request.body ?? {});
    const task = store.tasks.get(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const project = store.projects.get(task.projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });

    await mkdir(workspaceRoot, { recursive: true });
    if (body.wait && body.queueOnly) {
      return reply.code(400).send({ error: "wait cannot be used with queueOnly" });
    }
    if (runtimeProfile === "enterprise" && body.wait) {
      return reply.code(400).send({
        error: "enterprise runs are executed asynchronously by remote workers"
      });
    }
    let bindings: Partial<RunRecord> | undefined;
    try {
      bindings = task.specRef
        ? await prepareGovernedRunBindings(project, task, {
            store,
            specRepository,
            capabilityCatalog,
            ...(enterpriseSandboxImage ? { enterpriseSandboxImage } : {})
          })
        : undefined;
    } catch (error) {
      return reply.code(400).send({
        error: "governed run preparation failed",
        details: error instanceof Error ? error.message : String(error)
      });
    }
    const queueOnly = body.queueOnly || runtimeProfile === "enterprise";
    const run = queueOnly
      ? queueRunJob(project, task, {
          priority: body.queuePriority,
          ...(bindings ? { bindings } : {})
        })
        : startRunJob(project, task, {
          priority: body.queuePriority,
          ...(bindings ? { bindings } : {})
        });
    bindDomainAuditResource(request, "run.create", run.id, project.id);
    if (enterprisePostgres) {
      const auditEvent = buildPrecommittedRunAudit({
        request,
        action: "run.create",
        before: undefined,
        after: run,
        statusCode: 201,
        timestamp: new Date().toISOString()
      });
      await enqueueEnterpriseRunJob(project, task, run, {
        priority: body.queuePriority,
        auditEvent
      });
      precommittedDomainAuditEvents.set(request, [auditEvent]);
    }
    if (body.wait) {
      await activeRunJobs.get(run.id)?.done;
      return reply.code(201).send(store.runs.get(run.id) ?? run);
    }
    return reply.code(201).send(run);
  });

  app.get("/v1/run-jobs/queue", async (request) => {
    const query = runJobQueueStatusQuerySchema.parse(request.query);
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const items = enterprisePostgres
      ? await enterprisePostgres.listRunJobs({
          ...(query.status ? { status: query.status } : {}),
          tenantId: context.tenantId
        })
      : query.status === "claimable"
        ? runJobQueue.listClaimable()
        : runJobQueue
            .list()
            .filter((item) => !query.status || item.status === query.status);
    return { items };
  });

  app.get("/v1/run-jobs/workers", async (request) => {
    const query = runJobWorkerQuerySchema.parse(request.query);
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const workers = runJobWorkers
      .list(undefined, context.tenantId)
      .filter((worker) => !query.state || worker.state === query.state)
      .filter((worker) => !query.ownerId || worker.ownerId === query.ownerId);
    return { workers, summary: summarizeRunJobWorkers(workers) };
  });

  app.post("/v1/run-jobs/workers/heartbeat", async (request) => {
    const body = runJobWorkerHeartbeatSchema.parse(request.body ?? {});
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const capabilities = runtimeProfile === "enterprise"
      ? { ...(body.capabilities ?? {}), tenantIds: [context.tenantId] }
      : body.capabilities;
    const worker = runJobWorkers.heartbeat({
      ...body,
      ...(capabilities ? { capabilities } : {})
    }, context.tenantId);
    return { worker };
  });

  app.get("/v1/run-jobs/queue/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const item = enterprisePostgres
      ? await enterprisePostgres.readRunJob(id)
      : runJobQueue.read(id);
    if (!item) return reply.code(404).send({ error: "run job queue item not found" });
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    if (item.tenantId && item.tenantId !== context.tenantId) {
      return reply.code(404).send({ error: "run job queue item not found" });
    }
    return { item };
  });

  app.post("/v1/run-jobs/queue/:id/source-snapshot", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = runJobQueueClaimTokenSchema.parse(request.body ?? {});
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    if (runtimeProfile !== "enterprise" || !enterprisePostgres) {
      return reply.code(503).send({ error: "enterprise source snapshot authority is unavailable" });
    }
    const active = await enterprisePostgres.inspectClaim({
      runId: id,
      ownerId: body.ownerId,
      claimToken: body.claimToken
    });
    if (!active || active.item.tenantId !== context.tenantId) {
      return reply.code(409).send({ error: "run job claim is not active" });
    }
    let ref: RunScopedCasObjectRef;
    try {
      ref = sourceSnapshotRefFromPayload(active.payload, {
        tenantId: context.tenantId,
        projectId: active.item.projectId,
        runId: id
      });
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "source snapshot binding is invalid"
      });
    }
    let content: Buffer | undefined;
    try {
      content = await runScopedCas.readVerified(ref);
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "source snapshot integrity check failed"
      });
    }
    if (!content) {
      return reply.code(410).send({ error: "content-addressed source snapshot is unavailable" });
    }
    const stillActive = await enterprisePostgres.inspectClaim({
      runId: id,
      ownerId: body.ownerId,
      claimToken: body.claimToken
    });
    if (
      !stillActive ||
      stillActive.item.claimTokenHash !== active.item.claimTokenHash ||
      sourceSnapshotRefFromPayload(stillActive.payload, {
        tenantId: context.tenantId,
        projectId: stillActive.item.projectId,
        runId: id
      }).digest !== ref.digest
    ) {
      return reply.code(409).send({ error: "run job claim changed during source retrieval" });
    }
    return reply
      .header("content-type", ref.contentType)
      .header("content-length", String(ref.byteLength))
      .header("x-muniu-content-digest", ref.digest)
      .send(content);
  });

  app.post("/v1/run-jobs/queue/claim", async (request) => {
    const body = runJobQueueClaimSchema.parse(request.body ?? {});
    const ownerId = body.ownerId ?? `external-worker-${randomUUID()}`;
    const now = new Date().toISOString();
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const registeredWorker = runJobWorkers.read(ownerId, context.tenantId);
    const capabilities: PartialWorkerCapabilitySet | undefined =
      body.capabilities ?? registeredWorker?.capabilities;
    const claimCapabilities: PartialWorkerCapabilitySet | undefined = runtimeProfile === "enterprise"
      ? {
          ...(capabilities ?? {}),
          // A worker credential may only claim jobs in its authenticated tenant.
          tenantIds: [context.tenantId]
        }
      : capabilities;
    const capacity = runJobWorkers.hasClaimCapacity({
      ownerId,
      capacity: body.capacity,
      now
    }, context.tenantId);
    if (!capacity.available) {
      return {
        item: null,
        claimToken: null,
        reason: "worker_at_capacity",
        worker: capacity.worker ?? null
      };
    }
    const enterpriseClaim = enterprisePostgres
      ? await enterprisePostgres.claimRunJob({
          ownerId,
          ttlMs: body.ttlMs,
          now,
          capabilities: claimCapabilities ?? { tenantIds: [context.tenantId] }
        })
      : undefined;
    const localClaim = enterprisePostgres
      ? undefined
      : runJobQueue.claimNext({
          ownerId,
          ttlMs: body.ttlMs,
          now,
          ...(claimCapabilities ? { capabilities: claimCapabilities } : {})
        });
    const claimed = enterpriseClaim ?? localClaim;
    let sandboxAttestation: SandboxLeaseAttestation | undefined;
    if (
      claimed &&
      runtimeProfile === "enterprise" &&
      sandboxAttestationKey
    ) {
      const claimedRun = store.runs.get(claimed.item.runId);
      if (claimedRun?.harnessManifest) {
        if (
          !claimed.item.requirementsDigest ||
          !claimed.item.workerCapabilityDigest ||
          !claimed.item.claimTokenHash
        ) {
          if (enterprisePostgres) {
            await enterprisePostgres.releaseClaim({
              runId: claimed.item.runId,
              ownerId,
              claimToken: claimed.claimToken
            });
          }
          throw new Error("governed enterprise claim is missing immutable capability digests");
        }
        sandboxAttestation = issueSandboxAttestation({
          run: claimedRun,
          tenantId: context.tenantId,
          workerId: ownerId,
          requirementsDigest: claimed.item.requirementsDigest,
          workerCapabilityDigest: claimed.item.workerCapabilityDigest,
          claimDigest: claimed.item.claimTokenHash,
          signingKey: sandboxAttestationKey
        }, claimed.item.claimedAt ?? now);
      }
    }
    if (claimed) {
      runJobWorkers.markClaimed({
        ownerId,
        activeRunId: claimed.item.runId,
        capacity: body.capacity,
        ttlMs: body.ttlMs,
        now,
        ...(claimCapabilities ? { capabilities: claimCapabilities } : {})
      }, context.tenantId);
      store.markRunJobRunning(
        claimed.item.runId,
        claimed.item.claimedAt ?? claimed.item.updatedAt
      );
    } else {
      runJobWorkers.heartbeat({
        ownerId,
        status: "idle",
        capacity: body.capacity,
        ttlMs: body.ttlMs,
        now,
        ...(claimCapabilities ? { capabilities: claimCapabilities } : {})
      }, context.tenantId);
    }
    const claimableCount = !claimed
      ? enterprisePostgres
        ? (await enterprisePostgres.listRunJobs({
            status: "claimable",
            tenantId: context.tenantId,
            now
          })).length
        : runJobQueue.listClaimable(now).length
      : 0;
    return {
      item: claimed?.item ?? null,
      claimToken: claimed?.claimToken ?? null,
      ...(sandboxAttestation ? { sandboxAttestation } : {}),
      ...(enterpriseClaim ? { payload: enterpriseClaim.payload } : {}),
      ...(runtimeProfile === "enterprise" && enterpriseProxy
        ? { proxyBaseUrl: enterpriseProxy.publicBaseUrl }
        : {}),
      ...(!claimed && claimableCount > 0
        ? { reason: "no_compatible_job" }
        : {})
    };
  });

  app.post("/v1/run-jobs/queue/:id/usage-receipts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = providerUsageReceiptRequestSchema.parse(request.body ?? {});
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    if (
      runtimeProfile !== "enterprise" ||
      !enterprisePostgres ||
      !sandboxAttestationKey
    ) {
      return reply.code(503).send({
        error: "trusted enterprise provider usage receipt authority is unavailable"
      });
    }
    const active = await enterprisePostgres.inspectClaim({
      runId: id,
      ownerId: body.ownerId,
      claimToken: body.claimToken
    });
    const run = store.runs.get(id);
    if (
      !active ||
      active.item.tenantId !== context.tenantId ||
      !run?.harnessManifest ||
      !active.item.requirementsDigest ||
      !active.item.workerCapabilityDigest ||
      !active.item.claimTokenHash ||
      !active.item.claimedAt
    ) {
      return reply.code(409).send({
        error: "active governed claim bindings are unavailable"
      });
    }
    const authority = issueSandboxAttestation({
      run,
      tenantId: context.tenantId,
      workerId: body.ownerId,
      requirementsDigest: active.item.requirementsDigest,
      workerCapabilityDigest: active.item.workerCapabilityDigest,
      claimDigest: active.item.claimTokenHash,
      signingKey: sandboxAttestationKey
    }, active.item.claimedAt);
    const candidate = run.candidates.find((value) => value.id === body.candidateId);
    const task = store.tasks.get(run.taskId);
    const project = store.projects.get(run.projectId);
    if (
      !project ||
      project.tenantId !== context.tenantId ||
      !task ||
      !executionRuntimeIds(task.strategy).includes(body.app) ||
      !run.harnessManifest.executionPolicy.allowedProviders?.includes(body.app) ||
      (candidate !== undefined && candidate.provider !== body.app)
    ) {
      return reply.code(409).send({
        error: "candidate provider is not authorized by the immutable harness"
      });
    }
    const providerHealth = new Map(
      (await localStore.listProviderHealth({ app: body.app }))
        .map((health) => [health.providerId, health])
    );
    const scopedProviders = (await localStore.listProviders(body.app))
      .filter((provider) => provider.enabled)
      .filter((provider) => !isCircuitOpen(providerHealth.get(provider.id)))
      .filter((provider) => {
        const scope = provider.config.enterpriseScope;
        if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
        const record = scope as Record<string, unknown>;
        const tenantIds = Array.isArray(record.tenantIds)
          ? record.tenantIds.filter((value): value is string => typeof value === "string")
          : [];
        const projectIds = Array.isArray(record.projectIds)
          ? record.projectIds.filter((value): value is string => typeof value === "string")
          : [];
        return tenantIds.includes(context.tenantId) &&
          (projectIds.length === 0 || projectIds.includes(run.projectId));
      });
    if (scopedProviders.length === 0) {
      return reply.code(409).send({
        error: "no tenant-scoped provider is authorized for this candidate"
      });
    }
    const providerPlanPayload = await Promise.all(scopedProviders.map(async (provider) => ({
      providerId: provider.id,
      providerAccountId:
        typeof provider.config.providerAccountId === "string"
          ? provider.config.providerAccountId
          : provider.id,
      baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat,
      defaultModel: provider.defaultModel,
      enterpriseCapabilities: provider.enterpriseCapabilities ?? null,
      credentialDigest: createHmac("sha256", sandboxAttestationKey)
        .update((await resolveProviderToken(provider)) ?? "")
        .digest("hex")
    })));
    const providerPlan = Object.freeze({
      schemaVersion: 1 as const,
      projectId: run.projectId,
      app: body.app,
      providerIds: Object.freeze(scopedProviders.map((provider) => provider.id)),
      digest: sha256Canonical({
        schemaVersion: 1,
        tenantId: context.tenantId,
        projectId: run.projectId,
        runId: run.id,
        candidateId: body.candidateId,
        app: body.app,
        providers: providerPlanPayload
      })
    });
    const issued = issueProviderUsageReceipt({
      tenantId: context.tenantId,
      runId: id,
      candidateId: body.candidateId,
      workerId: body.ownerId,
      claimDigest: active.item.claimTokenHash,
      authorityExpiresAt: authority.expiresAt,
      signingKey: sandboxAttestationKey,
      providerPlan
    });
    return {
      receipt: issued.receipt,
      receiptDigest: issued.receiptDigest,
      expiresAt: issued.claims.expiresAt,
      ...(enterpriseProxy ? { proxyBaseUrl: enterpriseProxy.publicBaseUrl } : {})
    };
  });

  app.post("/v1/run-jobs/queue/:id/sandbox-runtime-proof", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = sandboxRuntimeProofRequestSchema.parse(request.body ?? {});
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    if (
      runtimeProfile !== "enterprise" ||
      !enterprisePostgres ||
      !sandboxAttestationKey ||
      !sandboxRuntimeVerifier
    ) {
      return reply.code(503).send({
        error: "trusted enterprise sandbox runtime authority is unavailable"
      });
    }
    const active = await enterprisePostgres.inspectClaim({
      runId: id,
      ownerId: body.ownerId,
      claimToken: body.claimToken
    });
    if (!active || active.item.tenantId !== context.tenantId) {
      return reply.code(409).send({ error: "run job claim is not active" });
    }
    const run = store.runs.get(id);
    const project = run ? store.projects.get(run.projectId) : undefined;
    if (!run?.harnessManifest || !project) {
      return reply.code(400).send({ error: "governed run bindings are unavailable" });
    }
    if (
      !active.item.requirementsDigest ||
      !active.item.workerCapabilityDigest ||
      !active.item.claimTokenHash
    ) {
      return reply.code(400).send({ error: "active claim capability binding is incomplete" });
    }
    const attestationVerification = verifySandboxAttestation(
      body.attestation,
      {
        run,
        tenantId: context.tenantId,
        workerId: body.ownerId,
        requirementsDigest: active.item.requirementsDigest,
        workerCapabilityDigest: active.item.workerCapabilityDigest,
        claimDigest: active.item.claimTokenHash,
        signingKey: sandboxAttestationKey
      }
    );
    if (!attestationVerification.valid) {
      return reply.code(400).send({
        error: `invalid API-issued sandbox attestation: ${attestationVerification.reason ?? "verification failed"}`
      });
    }
    const attestation = body.attestation as SandboxLeaseAttestation;
    let inspected;
    try {
      inspected = await sandboxRuntimeVerifier.verify({
        runtimeId: body.runtimeId,
        attestation,
        projectRoot: project.rootPath,
        ...(active.payload.version === 2
          ? {
              sourceSnapshotDigest: sourceSnapshotRefFromPayload(active.payload, {
                tenantId: context.tenantId,
                projectId: active.item.projectId,
                runId: id
              }).digest
            }
          : {})
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "sandbox runtime inspection failed"
      });
    }
    if (
      inspected.runtimeId !== body.runtimeId ||
      !/^[a-f0-9]{64}$/u.test(inspected.runtimeDigest)
    ) {
      return reply.code(500).send({ error: "trusted runtime verifier returned invalid evidence" });
    }
    // Re-check after the authority round trip so an expired, released, or
    // reclaimed lease cannot receive a proof after losing ownership.
    const stillActive = await enterprisePostgres.inspectClaim({
      runId: id,
      ownerId: body.ownerId,
      claimToken: body.claimToken
    });
    if (
      !stillActive ||
      stillActive.item.claimTokenHash !== active.item.claimTokenHash ||
      stillActive.item.workerCapabilityDigest !== active.item.workerCapabilityDigest
    ) {
      return reply.code(409).send({ error: "run job claim changed during runtime inspection" });
    }
    const runtimeProof = issueSandboxRuntimeProof({
      attestation,
      tenantId: context.tenantId,
      runId: id,
      workerId: body.ownerId,
      claimDigest: active.item.claimTokenHash,
      runtimeId: inspected.runtimeId,
      runtimeDigest: inspected.runtimeDigest,
      imageDigest: inspected.imageDigest,
      signingKey: sandboxAttestationKey
    });
    const sandboxExecution = {
      backendId: attestation.backend.id,
      backendVersion: attestation.backend.version,
      leaseId: attestation.leaseId,
      attestationDigest: attestation.digest,
      runtimeId: inspected.runtimeId,
      runtimeDigest: inspected.runtimeDigest,
      imageDigest: inspected.imageDigest,
      runtimeProof
    };
    return { sandboxExecution, runtimeProof };
  });

  app.post("/v1/run-jobs/queue/:id/heartbeat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = runJobQueueClaimTokenSchema.parse(request.body ?? {});
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    let renewalTtlMs = body.ttlMs;
    let item: RunJobQueueItem | undefined;
    if (enterprisePostgres) {
      const active = await enterprisePostgres.inspectClaim({
        runId: id,
        ownerId: body.ownerId,
        claimToken: body.claimToken
      });
      if (!active || active.item.tenantId !== context.tenantId) {
        return reply.code(409).send({ error: "run job claim is not active" });
      }
      let decision: EnterpriseBudgetLeaseDecision;
      try {
        decision = await enterpriseBudgetDecision({
          item: active.item,
          requestedTtlMs: body.ttlMs
        });
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "budget lease verification failed"
        });
      }
      if (decision.stop) {
        return { item: active.item, stop: decision.stop };
      }
      renewalTtlMs = decision.ttlMs;
      try {
        item = await enterprisePostgres.heartbeatClaim({
          runId: id,
          ownerId: body.ownerId,
          claimToken: body.claimToken,
          ttlMs: renewalTtlMs
        });
      } catch (error) {
        if (error instanceof PendingProviderUsageReservationsError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    } else {
      item = runJobQueue.heartbeat(id, {
        ownerId: body.ownerId,
        claimToken: body.claimToken,
        ttlMs: body.ttlMs
      });
    }
    if (!item) return reply.code(409).send({ error: "run job claim is not active" });
    runJobWorkers.heartbeat({
      ownerId: body.ownerId,
      status: "running",
      activeRunId: id,
      capacity: body.capacity,
      ttlMs: renewalTtlMs
    }, context.tenantId);
    return { item };
  });

  app.post("/v1/run-jobs/queue/:id/release", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = runJobQueueClaimTokenSchema.parse(request.body ?? {});
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const item = enterprisePostgres
      ? await enterprisePostgres.releaseClaim({
          runId: id,
          ownerId: body.ownerId,
          claimToken: body.claimToken
        })
      : runJobQueue.release(id, body);
    if (!item) return reply.code(409).send({ error: "run job claim is not active" });
    runJobWorkers.markReleased({
      ownerId: body.ownerId,
      runId: id,
      capacity: body.capacity,
      ttlMs: body.ttlMs
    }, context.tenantId, { allowUntrackedRun: Boolean(enterprisePostgres) });
    store.markRunJobQueued(id, item.updatedAt);
    return { item };
  });

  app.post("/v1/run-jobs/queue/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = runJobQueueEventSchema.parse(request.body ?? {});
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const item = enterprisePostgres
      ? (await enterprisePostgres.inspectClaim({
          runId: id,
          ownerId: body.ownerId,
          claimToken: body.claimToken
        }))?.item
      : runJobQueue.heartbeat(id, {
          ownerId: body.ownerId,
          claimToken: body.claimToken,
          ttlMs: body.ttlMs
        });
    if (!item) return reply.code(409).send({ error: "run job claim is not active" });
    runJobWorkers.heartbeat({
      ownerId: body.ownerId,
      status: "running",
      activeRunId: id,
      capacity: body.capacity,
      ttlMs: body.ttlMs
    }, context.tenantId);
    store.appendEvent({
      runId: id,
      type: body.event.type,
      message: body.event.message,
      timestamp: body.event.timestamp ?? new Date().toISOString(),
      ...(body.event.candidateId ? { candidateId: body.event.candidateId } : {}),
      ...(body.event.data !== undefined ? { data: body.event.data } : {})
    });
    return { item };
  });

  app.post(
    "/v1/run-jobs/queue/:id/artifacts",
    { bodyLimit: 24 * 1024 * 1024 },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = runJobGateArtifactSchema.parse(request.body ?? {});
      const context = requestContexts.get(request) ?? localRequestContext(request.id);
      const enterpriseClaim = enterprisePostgres
        ? await enterprisePostgres.inspectClaim({
            runId: id,
            ownerId: body.ownerId,
            claimToken: body.claimToken
          })
        : undefined;
      const item = enterprisePostgres
        ? enterpriseClaim?.item
        : runJobQueue.heartbeat(id, {
            ownerId: body.ownerId,
            claimToken: body.claimToken,
            ttlMs: body.ttlMs
          });
      if (!item) return reply.code(409).send({ error: "run job claim is not active" });
      if ((item.tenantId ?? LOCAL_TENANT_ID) !== context.tenantId) {
        return reply.code(404).send({ error: "run job queue item not found" });
      }
      const run = store.runs.get(id);
      if (
        !run ||
        run.projectId !== item.projectId ||
        (run.tenantId ?? LOCAL_TENANT_ID) !== context.tenantId
      ) {
        return reply.code(400).send({ error: "run job bindings are unavailable" });
      }
      const content = Buffer.from(body.artifact.contentBase64, "base64");
      const serverDigest = sha256(content);
      if (
        serverDigest !== body.artifact.digest ||
        content.byteLength !== body.artifact.byteLength
      ) {
        return reply.code(400).send({
          error: "Gate artifact declaration does not match uploaded bytes"
        });
      }
      const claimTokenHash = item.claimTokenHash ?? sha256(body.claimToken);
      const artifact: Omit<GateArtifactV2, "handle" | "path"> = {
        id: body.artifact.id,
        kind: body.artifact.kind,
        contentType: body.artifact.contentType,
        digest: serverDigest,
        byteLength: content.byteLength
      };
      const identityConflict = [...store.gateArtifactHandles.values()].find((record) =>
        record.tenantId === context.tenantId &&
        record.projectId === run.projectId &&
        record.runId === id &&
        record.candidateId === body.candidateId &&
        record.gateResultId === body.gateResultId &&
        record.gateId === body.gateId &&
        record.artifactId === artifact.id &&
        record.claimTokenHash === claimTokenHash &&
        (record.kind !== artifact.kind ||
          record.contentType !== artifact.contentType ||
          record.digest !== artifact.digest ||
          record.byteLength !== artifact.byteLength)
      );
      if (identityConflict) {
        return reply.code(409).send({
          error: "Gate artifact identity is already registered with different bytes or metadata"
        });
      }
      const cas = await runScopedCas.put({
        tenantId: context.tenantId,
        projectId: run.projectId,
        runId: id,
        contentType: artifact.contentType,
        content
      });
      const roundTripped = await runScopedCas.readVerified(cas);
      if (!roundTripped) {
        return reply.code(502).send({
          error: "Gate artifact CAS object was not retrievable after upload"
        });
      }
      if (enterprisePostgres) {
        const stillActive = await enterprisePostgres.inspectClaim({
          runId: id,
          ownerId: body.ownerId,
          claimToken: body.claimToken
        });
        if (
          !stillActive ||
          stillActive.item.tenantId !== context.tenantId ||
          stillActive.item.claimTokenHash !== claimTokenHash
        ) {
          return reply.code(409).send({
            error: "run job claim changed during Gate artifact upload"
          });
        }
      }
      const registration = {
        tenantId: context.tenantId,
        projectId: run.projectId,
        runId: id,
        candidateId: body.candidateId,
        gateResultId: body.gateResultId,
        gateId: body.gateId,
        artifact,
        claimTokenHash,
        ownerId: body.ownerId
      } as const;
      let record: GateArtifactHandleRecord | undefined =
        findIdempotentGateArtifactRecord({ registration, cas, store });
      const created = record === undefined;
      if (!record) {
        record = createGateArtifactHandleRecord({
          ...registration,
          cas,
          registeredAt: new Date().toISOString()
        });
        store.gateArtifactHandles.set(record.handle, record);
      }
      return reply.code(created ? 201 : 200).send({
        id: record.handle,
        artifact: gateArtifactFromRecord(record)
      });
    }
  );

  app.post(
    "/v1/run-jobs/queue/:id/measurements",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsedBody = runJobLoopMeasurementSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({ error: "invalid authoritative Loop measurement request" });
      }
      const body = parsedBody.data;
      const context = requestContexts.get(request) ?? localRequestContext(request.id);
      if (
        runtimeProfile !== "enterprise" ||
        !enterprisePostgres ||
        !sandboxAttestationKey
      ) {
        return reply.code(503).send({
          error: "authoritative enterprise Loop measurement is unavailable"
        });
      }
      const active = await enterprisePostgres.inspectClaim({
        runId: id,
        ownerId: body.ownerId,
        claimToken: body.claimToken
      });
      if (!active || active.item.tenantId !== context.tenantId) {
        return reply.code(409).send({ error: "run job claim is not active" });
      }
      const run = store.runs.get(id);
      const project = run ? store.projects.get(run.projectId) : undefined;
      const state = store.governedLoopStates.get(id);
      if (
        !run?.harnessManifest ||
        !project ||
        !state ||
        (run.tenantId ?? LOCAL_TENANT_ID) !== context.tenantId
      ) {
        return reply.code(409).send({
          error: "the stage running checkpoint must be durable before measurement"
        });
      }
      const runningAttempt = state.attempts.at(-1);
      if (
        state.status !== "running" ||
        runningAttempt?.status !== "running" ||
        runningAttempt.id !== body.stageAttemptId ||
        runningAttempt.stage !== body.stage ||
        runningAttempt.attempt !== body.attempt
      ) {
        return reply.code(409).send({
          error: "measurement request does not match the durable running stage attempt"
        });
      }
      if (!active.item.claimTokenHash || !active.item.claimedAt) {
        return reply.code(409).send({ error: "active claim measurement binding is incomplete" });
      }
      const completedAttempts = state.attempts.slice(0, -1);
      if (
        completedAttempts.some(
          (attempt) => attempt.status !== "running" && !attempt.budgetMeasurement
        )
      ) {
        return reply.code(409).send({
          error: "enterprise measurement chain contains an unsigned historical attempt"
        });
      }
      const previousMeasurement = [...completedAttempts]
        .reverse()
        .find((attempt) => attempt.budgetMeasurement)
        ?.budgetMeasurement;
      if (previousMeasurement) {
        const previousVerification = verifyLoopBudgetMeasurement(
          previousMeasurement,
          {
            tenantId: context.tenantId,
            runId: id,
            signingKey: sandboxAttestationKey
          }
        );
        if (!previousVerification.valid) {
          return reply.code(409).send({
            error: `previous Loop measurement is invalid: ${previousVerification.reason ?? "verification failed"}`
          });
        }
      }

      let usage: AuthoritativeProxyUsage;
      try {
        usage = await authoritativeUsageForRun(
          enterprisePostgres,
          localStore,
          context.tenantId,
          id,
          run.harnessManifest.stopConditions.maxCostUsd
        );
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "provider usage verification failed"
        });
      }
      if (
        previousMeasurement &&
        previousMeasurement.usageRequestIds.some(
          (requestId) => !usage.requestIds.includes(requestId)
        )
      ) {
        return reply.code(409).send({
          error: "authoritative provider usage moved backwards"
        });
      }
      const previousTokens = previousMeasurement?.cumulative.tokens ?? 0;
      const previousCost = previousMeasurement?.cumulative.costUsd ?? 0;
      if (usage.tokens < previousTokens || usage.costUsd < previousCost) {
        return reply.code(409).send({
          error: "authoritative provider usage is lower than the durable measurement ledger"
        });
      }

      let diffMeasurement:
        | Awaited<ReturnType<typeof measureAuthoritativeLoopWorkspaceDiff>>
        | undefined;
      let diffCas: RunScopedCasObjectRef | undefined;
      let diffDomain: {
        candidateId: string;
        workspaceUri: string;
        leaseId: string;
        runtimeId: string;
        runtimeProofDigest: string;
        projectSnapshotDigest: string;
        candidateSnapshotDigest: string;
      } | undefined;
      if (body.stage === "implementation") {
        if (!body.workspaceUri || !body.candidateId) {
          return reply.code(400).send({
            error: "implementation measurement requires a winner workspaceUri and candidateId"
          });
        }
        const task = store.tasks.get(run.taskId);
        const attestation = run.sandboxAttestation;
        const execution = run.sandboxExecution;
        if (
          !task ||
          !attestation ||
          !execution ||
          !sandboxRuntimeVerifier ||
          !active.item.requirementsDigest ||
          !active.item.workerCapabilityDigest
        ) {
          return reply.code(409).send({
            error: "authoritative implementation runtime bindings are unavailable"
          });
        }
        const expectedCandidateIds = new Set(
          selectRunRuntimes(task).map((runtimeId, index) => `${runtimeId}-${index + 1}`)
        );
        if (!expectedCandidateIds.has(body.candidateId)) {
          return reply.code(400).send({
            error: "candidateId is not declared by the immutable task strategy"
          });
        }
        const attestationVerification = verifySandboxAttestation(attestation, {
          run,
          tenantId: context.tenantId,
          workerId: body.ownerId,
          requirementsDigest: active.item.requirementsDigest,
          workerCapabilityDigest: active.item.workerCapabilityDigest,
          claimDigest: active.item.claimTokenHash,
          signingKey: sandboxAttestationKey
        });
        if (!attestationVerification.valid || !sandboxExecutionMatchesAttestation(
          execution,
          attestation
        )) {
          return reply.code(409).send({
            error: `implementation sandbox binding is invalid: ${
              attestationVerification.reason ?? "execution does not match attestation"
            }`
          });
        }
        const runtimeProofVerification = verifySandboxRuntimeProof(
          execution.runtimeProof,
          {
            attestation,
            tenantId: context.tenantId,
            runId: id,
            workerId: body.ownerId,
            claimDigest: active.item.claimTokenHash,
            runtimeId: execution.runtimeId,
            runtimeDigest: execution.runtimeDigest,
            imageDigest: execution.imageDigest,
            signingKey: sandboxAttestationKey
          }
        );
        if (!runtimeProofVerification.valid) {
          return reply.code(409).send({
            error: `implementation runtime proof is invalid: ${
              runtimeProofVerification.reason ?? "verification failed"
            }`
          });
        }
        try {
          const inspected = await sandboxRuntimeVerifier.verify({
            runtimeId: execution.runtimeId,
            attestation,
            projectRoot: project.rootPath
          });
          if (
            inspected.runtimeId !== execution.runtimeId ||
            inspected.runtimeDigest !== execution.runtimeDigest
          ) {
            throw new Error("runtime inspection no longer matches the API-issued proof");
          }
          const candidateRoot = await resolveAuthoritativeCandidateWorkspace({
            workspaceUri: body.workspaceUri,
            leaseId: attestation.leaseId,
            scratchRoot: inspected.scratchRoot,
            runId: id,
            implementationAttempt: body.attempt,
            candidateId: body.candidateId
          });
          diffMeasurement = await measureAuthoritativeLoopWorkspaceDiff({
            projectRoot: inspected.projectRoot,
            candidateRoot
          });
          const reinspection = await sandboxRuntimeVerifier.verify({
            runtimeId: execution.runtimeId,
            attestation,
            projectRoot: project.rootPath
          });
          if (
            reinspection.runtimeDigest !== inspected.runtimeDigest ||
            reinspection.projectRoot !== inspected.projectRoot ||
            reinspection.scratchRoot !== inspected.scratchRoot
          ) {
            throw new Error("runtime mount binding changed during diff measurement");
          }
          diffDomain = {
            candidateId: body.candidateId,
            workspaceUri: body.workspaceUri,
            leaseId: attestation.leaseId,
            runtimeId: execution.runtimeId,
            runtimeProofDigest: execution.runtimeProof.digest,
            projectSnapshotDigest: diffMeasurement.projectSnapshotDigest,
            candidateSnapshotDigest: diffMeasurement.candidateSnapshotDigest
          };
        } catch (error) {
          return reply.code(400).send({
            error: error instanceof Error ? error.message : "authoritative Loop diff failed"
          });
        }
        const stillActive = await enterprisePostgres.inspectClaim({
          runId: id,
          ownerId: body.ownerId,
          claimToken: body.claimToken
        });
        if (
          !stillActive ||
          stillActive.item.tenantId !== context.tenantId ||
          stillActive.item.claimTokenHash !== active.item.claimTokenHash ||
          stillActive.item.workerCapabilityDigest !== active.item.workerCapabilityDigest
        ) {
          return reply.code(409).send({
            error: "run job claim changed during authoritative diff measurement"
          });
        }
        diffCas = await runScopedCas.put({
          tenantId: context.tenantId,
          projectId: run.projectId,
          runId: id,
          contentType: LOOP_DIFF_MANIFEST_CONTENT_TYPE,
          content: diffMeasurement.content
        });
      } else if (body.workspaceUri !== undefined || body.candidateId !== undefined) {
        return reply.code(400).send({
          error: "only implementation attempts may submit a workspace reference"
        });
      }

      const finalActive = await enterprisePostgres.inspectClaim({
        runId: id,
        ownerId: body.ownerId,
        claimToken: body.claimToken
      });
      if (
        !finalActive ||
        finalActive.item.tenantId !== context.tenantId ||
        finalActive.item.claimTokenHash !== active.item.claimTokenHash ||
        finalActive.item.workerCapabilityDigest !== active.item.workerCapabilityDigest
      ) {
        return reply.code(409).send({
          error: "run job claim changed before Loop measurement issuance"
        });
      }
      const measuredAt = new Date().toISOString();
      const intervalStartedAt = previousMeasurement?.claimDigest === active.item.claimTokenHash
        ? previousMeasurement.measuredAt
        : active.item.claimedAt;
      const durationSeconds = Math.max(
        0,
        Math.ceil((Date.parse(measuredAt) - Date.parse(intervalStartedAt)) / 1_000)
      );
      const delta = {
        durationSeconds,
        tokens: usage.tokens - previousTokens,
        costUsd: Number((usage.costUsd - previousCost).toFixed(8)),
        changedFiles: diffMeasurement?.changedFiles ?? 0,
        changedLines: diffMeasurement?.changedLines ?? 0
      };
      const proof = issueLoopBudgetMeasurement({
        tenantId: context.tenantId,
        runId: id,
        workerId: body.ownerId,
        claimDigest: active.item.claimTokenHash,
        stageAttemptId: body.stageAttemptId,
        stage: body.stage,
        attempt: body.attempt,
        intervalStartedAt,
        measuredAt,
        usageRequestIds: usage.requestIds,
        usageDigest: usage.digest,
        ...(diffCas && diffDomain
          ? {
              diffArtifact: {
                id: diffCas.objectKey,
                uri: `mn://cas/loop-diffs/${encodeURIComponent(diffCas.objectKey)}`,
                digest: diffCas.digest,
                byteLength: diffCas.byteLength,
                ...diffDomain
              }
            }
          : {}),
        delta,
        ...(previousMeasurement ? { previousMeasurement } : {}),
        signingKey: sandboxAttestationKey
      });
      return {
        measurement: { delta: proof.delta, proof }
      };
    }
  );

  app.post("/v1/run-jobs/queue/:id/update", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = runJobQueueUpdateSchema.parse(request.body ?? {});
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const enterpriseClaim = enterprisePostgres
      ? await enterprisePostgres.inspectClaim({
          runId: id,
          ownerId: body.ownerId,
          claimToken: body.claimToken
        })
      : undefined;
    let item = enterprisePostgres
      ? enterpriseClaim?.item
      : runJobQueue.heartbeat(id, {
          ownerId: body.ownerId,
          claimToken: body.claimToken,
          ttlMs: body.ttlMs
        });
    if (!item) return reply.code(409).send({ error: "run job claim is not active" });
    if (body.run.id !== id) {
      return reply.code(400).send({ error: "run id does not match queue item" });
    }
    const existing = store.runs.get(id);
    const normalizedEvidence = normalizeExternalGateEvidence(
      body.run as RunRecord,
      (body.run as RunRecord).status === "waiting_approval"
    );
    if (typeof normalizedEvidence === "string") {
      return reply.code(400).send({ error: normalizedEvidence });
    }
    const incoming = normalizedEvidence;
    const bindingError = validateExternalRunBindings(existing, incoming);
    if (bindingError) return reply.code(400).send({ error: bindingError });
    if (runtimeProfile === "enterprise") {
      const sandboxError = validateEnterpriseSandboxEvidence({
        existing,
        incoming,
        item,
        tenantId: context.tenantId,
        workerId: body.ownerId,
        signingKey: sandboxAttestationKey
      });
      if (sandboxError) return reply.code(400).send({ error: sandboxError });
      const project = store.projects.get(incoming.projectId);
      const filesystemError = project
        ? validateEnterpriseExternalRunFilesystem(incoming, project.rootPath)
        : "external run project does not exist";
      if (filesystemError) return reply.code(400).send({ error: filesystemError });
      const gateArtifactError = await validateEnterpriseGateArtifactHandles({
        existing,
        incoming,
        tenantId: context.tenantId,
        ownerId: body.ownerId,
        claimTokenHash: item.claimTokenHash,
        store,
        cas: runScopedCas
      });
      if (gateArtifactError) {
        return reply.code(400).send({ error: gateArtifactError });
      }
    }
    const checkpoint = validateExternalGovernedCheckpoint(
      existing,
      incoming,
      body.governedLoopState,
      store.governedLoopStates.get(id),
      false,
      enterpriseClaim
        ? approvalDecisionFromClaimPayload(enterpriseClaim.payload)
        : undefined
    );
    if (typeof checkpoint === "string") {
      request.log.warn(
        { runId: id, reason: checkpoint },
        "enterprise governed checkpoint rejected"
      );
      return reply.code(400).send({ error: checkpoint });
    }
    let gateAuthorization: EnterpriseGateAuthorizationDecision = {
      newReceipts: Object.freeze([])
    };
    if (runtimeProfile === "enterprise") {
      const measurementError = await validateEnterpriseLoopBudgetMeasurements({
        state: checkpoint,
        previous: store.governedLoopStates.get(id),
        run: incoming,
        item,
        tenantId: context.tenantId,
        workerId: body.ownerId,
        signingKey: sandboxAttestationKey,
        usageLedger: enterprisePostgres!,
        providerStore: localStore,
        cas: runScopedCas
      });
      if (measurementError) {
        request.log.warn(
          { runId: id, reason: measurementError },
          "enterprise Loop measurement rejected"
        );
        return reply.code(400).send({ error: measurementError });
      }
    }
    if (
      runtimeProfile === "enterprise" ||
      options.authoritativeGateCheckpointAuthorizer
    ) {
      gateAuthorization = await authorizeExternalEnterpriseGates({
        existing,
        incoming,
        state: checkpoint,
        previousState: store.governedLoopStates.get(id),
        item,
        tenantId: context.tenantId,
        ownerId: body.ownerId,
        claimToken: body.claimToken
      });
      if (gateAuthorization.error) {
        request.log.warn(
          { runId: id, reason: gateAuthorization.error },
          "authoritative Gate checkpoint rejected"
        );
        return reply.code(400).send({ error: gateAuthorization.error });
      }
    }
    let checkpointLeaseDecision: EnterpriseBudgetLeaseDecision | undefined;
    if (
      enterprisePostgres &&
      checkpoint?.attempts.at(-1)?.status === "running"
    ) {
      try {
        checkpointLeaseDecision = await enterpriseBudgetDecision({
          item,
          run: incoming,
          state: checkpoint,
          requestedTtlMs: body.ttlMs
        });
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "budget lease verification failed"
        });
      }
    }
    if (enterprisePostgres && enterpriseClaim) {
      const durablePayload: Readonly<Record<string, unknown>> = {
        ...enterpriseClaim.payload,
        version: 1,
        run: incoming,
        ...(checkpoint ? { governedResumeState: checkpoint } : {})
      };
      const auditEvent = buildPrecommittedRunAudit({
        request,
        action: "run.checkpoint",
        before: existing,
        after: incoming,
        statusCode: 200,
        timestamp: new Date().toISOString()
      });
      let durableItem: RunJobQueueItem | undefined;
      try {
        durableItem = await enterprisePostgres.checkpointClaim({
          runId: id,
          ownerId: body.ownerId,
          claimToken: body.claimToken,
          payload: durablePayload,
          checkpointDigest: sha256Canonical(durablePayload),
          expectedCheckpointDigest: enterpriseClaim.checkpointDigest,
          metadataRecords: [
            enterpriseMetadataWrite(context.tenantId, "run", id, incoming),
            ...(checkpoint
              ? [enterpriseMetadataWrite(
                  context.tenantId,
                  "governed_loop_state",
                  id,
                  checkpoint
                )]
              : []),
            ...gateAuthorization.newReceipts.map((record) =>
              enterpriseMetadataWrite(
                context.tenantId,
                "authoritative_gate_receipt",
                record.id,
                record
              )
            )
          ],
          auditEvent,
          ttlMs: checkpointLeaseDecision?.ttlMs || body.ttlMs,
          ...(checkpointLeaseDecision?.stop ? { renewLease: false } : {})
        });
      } catch (error) {
        if (error instanceof PendingProviderUsageReservationsError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
      if (!durableItem) {
        return reply.code(409).send({ error: "run job checkpoint changed or claim expired" });
      }
      item = durableItem;
      precommittedDomainAuditEvents.set(request, [auditEvent]);
    }
    store.runs.set(id, incoming);
    if (checkpoint) store.governedLoopStates.set(id, checkpoint);
    for (const record of gateAuthorization.newReceipts) {
      store.authoritativeGateReceipts.set(record.id, record);
    }
    store.markRunJobRunning(id, item.updatedAt);
    runJobWorkers.heartbeat({
      ownerId: body.ownerId,
      status: "running",
      activeRunId: id,
      capacity: body.capacity,
      ttlMs: checkpointLeaseDecision?.ttlMs || body.ttlMs
    }, context.tenantId);
    return {
      run: store.runs.get(id),
      item,
      ...(checkpointLeaseDecision?.stop
        ? { stop: checkpointLeaseDecision.stop }
        : {})
    };
  });

  app.post("/v1/run-jobs/queue/:id/finish", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = runJobQueueUpdateSchema.parse(request.body ?? {});
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const existingRun = store.runs.get(id);
    const enterpriseClaim = enterprisePostgres
      ? await enterprisePostgres.inspectClaim({
          runId: id,
          ownerId: body.ownerId,
          claimToken: body.claimToken
        })
      : undefined;
    const item = enterprisePostgres
      ? enterpriseClaim?.item
      : runJobQueue.heartbeat(id, {
          ownerId: body.ownerId,
          claimToken: body.claimToken,
          ttlMs: body.ttlMs
        });
    if (!item) return reply.code(409).send({ error: "run job claim is not active" });
    if (body.run.id !== id) {
      return reply.code(400).send({ error: "run id does not match queue item" });
    }
    const normalizedEvidence = normalizeExternalGateEvidence(
      body.run as RunRecord,
      true
    );
    if (typeof normalizedEvidence === "string") {
      return reply.code(400).send({ error: normalizedEvidence });
    }
    const run = normalizedEvidence;
    const bindingError = validateExternalRunBindings(existingRun, run);
    if (bindingError) return reply.code(400).send({ error: bindingError });
    if (runtimeProfile === "enterprise") {
      const sandboxError = validateEnterpriseSandboxEvidence({
        existing: existingRun,
        incoming: run,
        item,
        tenantId: context.tenantId,
        workerId: body.ownerId,
        signingKey: sandboxAttestationKey
      });
      if (sandboxError) return reply.code(400).send({ error: sandboxError });
      const project = store.projects.get(run.projectId);
      const filesystemError = project
        ? validateEnterpriseExternalRunFilesystem(run, project.rootPath)
        : "external run project does not exist";
      if (filesystemError) return reply.code(400).send({ error: filesystemError });
      const gateArtifactError = await validateEnterpriseGateArtifactHandles({
        existing: existingRun,
        incoming: run,
        tenantId: context.tenantId,
        ownerId: body.ownerId,
        claimTokenHash: item.claimTokenHash,
        store,
        cas: runScopedCas
      });
      if (gateArtifactError) {
        return reply.code(400).send({ error: gateArtifactError });
      }
    }
    const checkpoint = validateExternalGovernedCheckpoint(
      existingRun,
      run,
      body.governedLoopState,
      store.governedLoopStates.get(id),
      true,
      enterpriseClaim
        ? approvalDecisionFromClaimPayload(enterpriseClaim.payload)
        : undefined
    );
    if (typeof checkpoint === "string") {
      request.log.warn(
        { runId: id, reason: checkpoint },
        "enterprise governed finish checkpoint rejected"
      );
      return reply.code(400).send({ error: checkpoint });
    }
    let gateAuthorization: EnterpriseGateAuthorizationDecision = {
      newReceipts: Object.freeze([])
    };
    if (runtimeProfile === "enterprise") {
      const measurementError = await validateEnterpriseLoopBudgetMeasurements({
        state: checkpoint,
        previous: store.governedLoopStates.get(id),
        run,
        item,
        tenantId: context.tenantId,
        workerId: body.ownerId,
        signingKey: sandboxAttestationKey,
        usageLedger: enterprisePostgres!,
        providerStore: localStore,
        cas: runScopedCas
      });
      if (measurementError) {
        request.log.warn(
          { runId: id, reason: measurementError },
          "enterprise finish Loop measurement rejected"
        );
        return reply.code(400).send({ error: measurementError });
      }
    }
    if (
      runtimeProfile === "enterprise" ||
      options.authoritativeGateCheckpointAuthorizer
    ) {
      gateAuthorization = await authorizeExternalEnterpriseGates({
        existing: existingRun,
        incoming: run,
        state: checkpoint,
        previousState: store.governedLoopStates.get(id),
        item,
        tenantId: context.tenantId,
        ownerId: body.ownerId,
        claimToken: body.claimToken
      });
      if (gateAuthorization.error) {
        request.log.warn(
          { runId: id, reason: gateAuthorization.error },
          "authoritative Gate finish rejected"
        );
        return reply.code(400).send({ error: gateAuthorization.error });
      }
    }
    if (!isTerminalRunStatus(run.status)) {
      return reply.code(400).send({ error: "run must be terminal before finish" });
    }
    await persistRunArtifactsSafely(run);
    const finishedAt = new Date().toISOString();
    const terminalStatus = runJobStatusFromRun(run.status);
    const durablePayload: Readonly<Record<string, unknown>> | undefined =
      enterpriseClaim
        ? {
            ...enterpriseClaim.payload,
            version: 1,
            run,
            ...(checkpoint ? { governedResumeState: checkpoint } : {})
          }
        : undefined;
    let finishedItem: RunJobQueueItem | undefined;
    if (enterprisePostgres && enterpriseClaim && durablePayload) {
      const auditEvent = buildPrecommittedRunAudit({
        request,
        action: "run.finish",
        before: existingRun,
        after: run,
        statusCode: 200,
        timestamp: finishedAt
      });
      try {
        finishedItem = await enterprisePostgres.finishRunJob({
          runId: id,
          ownerId: body.ownerId,
          claimToken: body.claimToken,
          status: terminalStatus,
          payload: durablePayload,
          checkpointDigest: sha256Canonical(durablePayload),
          expectedCheckpointDigest: enterpriseClaim.checkpointDigest,
          metadataRecords: [
            enterpriseMetadataWrite(context.tenantId, "run", id, run),
            ...(checkpoint
              ? [enterpriseMetadataWrite(
                  context.tenantId,
                  "governed_loop_state",
                  id,
                  checkpoint
                )]
                : []),
            ...gateAuthorization.newReceipts.map((record) =>
              enterpriseMetadataWrite(
                context.tenantId,
                "authoritative_gate_receipt",
                record.id,
                record
              )
            )
          ],
          auditEvent,
          now: finishedAt
        });
      } catch (error) {
        if (error instanceof PendingProviderUsageReservationsError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
      if (finishedItem) precommittedDomainAuditEvents.set(request, [auditEvent]);
    } else {
      finishedItem = runJobQueue.markFinished(id, terminalStatus, finishedAt);
    }
    if (!finishedItem) {
      return reply.code(409).send({ error: "run job claim is not active" });
    }
    store.finishRun(run, terminalStatus, finishedAt);
    if (checkpoint) store.governedLoopStates.set(id, checkpoint);
    for (const record of gateAuthorization.newReceipts) {
      store.authoritativeGateReceipts.set(record.id, record);
    }
    runJobWorkers.markFinished({
      ownerId: body.ownerId,
      runId: id,
      status: runJobStatusFromRun(run.status),
      capacity: body.capacity,
      ttlMs: body.ttlMs,
      now: finishedAt
    }, context.tenantId, { allowUntrackedRun: Boolean(enterprisePostgres) });
    return { run: store.runs.get(id), item: finishedItem };
  });

  app.get("/v1/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.runs.get(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });

  app.get("/v1/audit-events", async (request) => {
    const context = requestContexts.get(request) ?? localRequestContext(request.id);
    const query = z.object({
      actorId: z.string().optional(),
      traceId: z.string().optional(),
      projectId: z.string().optional(),
      after: z.string().optional(),
      result: z.enum(["success", "failure"]).optional(),
      limit: z.coerce.number().int().positive().max(10_000).default(1_000)
    }).parse(request.query);
    const tenantWideAudit =
      context.roles.includes("org_admin") ||
      context.roles.includes("governance_admin") ||
      context.projectIds.length === 0;
    const authorizedProjects = tenantWideAudit
      ? undefined
      : new Set(context.projectIds);
    let auditEvents = [...store.auditEvents.values()]
      .filter((event) => event.tenantId === context.tenantId)
      // Project-scoped principals may narrow their view, but a query parameter
      // can never expand the project scope carried by the authenticated token.
      // Tenant-wide audit events are intentionally hidden from such tokens as
      // they can contain evidence URIs, incident reasons and ticket details.
      .filter((event) =>
        !authorizedProjects ||
        (event.projectId !== undefined && authorizedProjects.has(event.projectId))
      )
      .filter((event) => !query.projectId || event.projectId === query.projectId)
      .filter((event) => !query.actorId || event.actorId === query.actorId)
      .filter((event) => !query.traceId || event.traceId === query.traceId)
      .filter((event) => !query.result || event.result === query.result)
      .sort((left, right) =>
        left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)
      );
    if (query.after) {
      const cursor = auditEvents.findIndex((event) => event.id === query.after);
      auditEvents = cursor < 0 ? [] : auditEvents.slice(cursor + 1);
    }
    auditEvents = auditEvents.slice(-query.limit);
    return { auditEvents };
  });

  app.get("/v1/runs/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    return { events: store.events.get(id) ?? [] };
  });

  app.get("/v1/runs/:id/events/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.runs.get(id);
    if (!run) return reply.code(404).send({ error: "run not found" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin":
        runtimeProfile === "enterprise"
          ? (typeof request.headers.origin === "string"
              ? request.headers.origin
              : "null")
          : "*"
    });

    let closed = false;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(keepAlive);
      activeRunEventStreams.delete(close);
      reply.raw.end();
    };
    const write = (event: RunEvent) => {
      if (closed) return;
      writeSseEvent(reply.raw, event);
      const current = store.runs.get(id);
      if (current && isTerminalRunStatus(current.status)) {
        setImmediate(close);
      }
    };
    const keepAlive = setInterval(() => {
      if (!closed) reply.raw.write(": keep-alive\n\n");
    }, 15_000);

    unsubscribe = store.subscribeEvents(id, write);
    activeRunEventStreams.add(close);
    request.raw.on("close", close);

    for (const event of store.events.get(id) ?? []) {
      write(event);
    }
    const current = store.runs.get(id);
    if (current && isTerminalRunStatus(current.status)) {
      setImmediate(close);
    }
  });

  app.post("/v1/runs/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.runs.get(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    if (run.status !== "waiting_approval") {
      return reply.code(409).send({ error: "run is not waiting for approval" });
    }
    const task = store.tasks.get(run.taskId);
    const project = store.projects.get(run.projectId);
    const loopState = store.governedLoopStates.get(id);
    if (task?.specRef && project && loopState) {
      const body = runApprovalSchema.parse(request.body ?? {});
      const context = requestContexts.get(request) ?? localRequestContext(request.id);
      const actorId = context.authentication === "local"
        ? body.actorId
        : context.actorId;
      const waitingAttempt = loopState.attempts.at(-1);
      if (
        loopState.status !== "waiting_approval" ||
        waitingAttempt?.stage !== "approval_demo" ||
        waitingAttempt.status !== "waiting_approval"
      ) {
        return reply.code(409).send({ error: "governed run has no bound approval attempt" });
      }
      const decision = createApprovalDecision({
        runId: id,
        stageAttemptId: waitingAttempt.id,
        decision: body.decision,
        actorId,
        decidedAt: new Date().toISOString()
      });
      if (enterprisePostgres) {
        const queued = queueRunJob(project, task, {
          runId: id,
          resumeFrom: run
        });
        const auditEvent = buildPrecommittedRunAudit({
          request,
          action: "run.approve",
          before: run,
          after: queued,
          statusCode: 202,
          timestamp: decision.decidedAt
        });
        await enqueueEnterpriseRunJob(project, task, queued, {
          governedResumeState: loopState,
          approvalDecision: decision,
          auditEvent
        });
        precommittedDomainAuditEvents.set(request, [auditEvent]);
        return reply.code(202).send(queued);
      }
      startRunJob(project, task, {
        runId: id,
        resumeFrom: run,
        governedResumeState: loopState,
        approvalDecision: decision
      });
      await activeRunJobs.get(id)?.done;
      return store.runs.get(id);
    }
    const updated = {
      ...run,
      status: "completed" as const,
      updatedAt: new Date().toISOString()
    };
    store.runs.set(id, updated);
    await persistRunArtifactsSafely(updated);
    return updated;
  });

  app.post("/v1/runs/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.runs.get(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    if (isTerminalRunStatus(run.status)) {
      return run;
    }

    activeRunJobs.get(id)?.controller.abort();
    const updated = {
      ...run,
      status: "cancelled" as const,
      candidates: run.candidates.map((candidate) =>
        candidate.status === "queued" || candidate.status === "running"
          ? { ...candidate, status: "cancelled" as const }
          : candidate
      ),
      updatedAt: new Date().toISOString()
    };
    const cancellationEvents: RunEvent[] = [
      {
        runId: id,
        type: "status",
        message: "Run cancellation requested",
        timestamp: updated.updatedAt
      },
      {
        runId: id,
        type: "status",
        message: "Run cancelled",
        timestamp: new Date().toISOString()
      }
    ];
    if (enterprisePostgres) {
      const context = requestContexts.get(request) ?? localRequestContext(request.id);
      const auditEvent = buildPrecommittedRunAudit({
        request,
        action: "run.cancel",
        before: run,
        after: updated,
        statusCode: 200,
        timestamp: updated.updatedAt
      });
      const cancelledItem = await enterprisePostgres.cancelRunJob({
        runId: id,
        tenantId: context.tenantId,
        metadataRecords: [
          enterpriseMetadataWrite(context.tenantId, "run", id, updated),
          enterpriseMetadataWrite(context.tenantId, "run_events", id, {
            runId: id,
            events: [...(store.events.get(id) ?? []), ...cancellationEvents]
          })
        ],
        auditEvent,
        now: updated.updatedAt
      });
      if (!cancelledItem) {
        return reply.code(409).send({ error: "enterprise run job cannot be cancelled" });
      }
      precommittedDomainAuditEvents.set(request, [auditEvent]);
    } else {
      runJobQueue.markFinished(id, "cancelled", updated.updatedAt);
    }
    store.finishRun(updated, "cancelled", updated.updatedAt);
    for (const event of cancellationEvents) store.appendEvent(event);
    await persistRunArtifactsSafely(updated);
    return updated;
  });

  app.post("/v1/runs/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.runs.get(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    if (run.status !== "failed" && run.status !== "cancelled") {
      return reply.code(409).send({ error: "only failed or cancelled runs can be resumed" });
    }
    const task = store.tasks.get(run.taskId);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const project = store.projects.get(run.projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });

    await mkdir(workspaceRoot, { recursive: true });
    let bindings: Partial<RunRecord> | undefined;
    try {
      bindings = task.specRef
        ? await prepareGovernedRunBindings(project, task, {
            store,
            specRepository,
            capabilityCatalog,
            ...(enterpriseSandboxImage ? { enterpriseSandboxImage } : {})
          })
        : undefined;
    } catch (error) {
      return reply.code(400).send({
        error: "governed run preparation failed",
        details: error instanceof Error ? error.message : String(error)
      });
    }
    const resumedRun = enterprisePostgres
      ? queueRunJob(project, task, {
          ...(bindings ? { bindings } : {})
        })
      : startRunJob(project, task, {
          ...(bindings ? { bindings } : {})
        });
    const now = new Date().toISOString();
    const sourceResumeEvent: RunEvent = {
      runId: id,
      type: "status",
      message: `Run resumed as ${resumedRun.id}`,
      timestamp: now,
      data: { resumedRunId: resumedRun.id }
    };
    const resumedRunEvent: RunEvent = {
      runId: resumedRun.id,
      type: "status",
      message: `Run resumed from ${id}`,
      timestamp: now,
      data: { sourceRunId: id }
    };
    if (enterprisePostgres) {
      const auditEvent = buildPrecommittedRunAudit({
        request,
        action: "run.resume",
        before: run,
        after: resumedRun,
        statusCode: 201,
        timestamp: now
      });
      // Both sides of the resume relationship must be durable in the same
      // transaction as the new queue row and its domain audit.
      store.appendEvent(sourceResumeEvent);
      store.appendEvent(resumedRunEvent);
      await enqueueEnterpriseRunJob(project, task, resumedRun, {
        auditEvent,
        relatedRunEventIds: [id]
      });
      precommittedDomainAuditEvents.set(request, [auditEvent]);
    } else {
      store.appendEvent(sourceResumeEvent);
      store.appendEvent(resumedRunEvent);
    }
    return reply.code(201).send({
      resumedFromRunId: id,
      run: resumedRun
    });
  });

  app.get("/v1/runs/:id/artifacts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.runs.get(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    const filters = parseRunArtifactFilters(request.query);
    return {
      artifacts: filterRunArtifacts(
        await listRunArtifacts(
          run,
          mniuRoot,
          artifactRemoteStore,
          enforceArtifactStoreQuotaSafely
        ),
        filters
      ),
      filters
    };
  });

  app.get("/v1/runs/:id/artifacts/archive", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.runs.get(id);
    if (!run) return reply.code(404).send({ error: "run not found" });

    const filters = parseRunArtifactFilters(request.query);
    const artifacts = filterRunArtifacts(
      await listRunArtifacts(
        run,
        mniuRoot,
        artifactRemoteStore,
        enforceArtifactStoreQuotaSafely
      ),
      filters
    );
    const archiveEntries: TarArchiveEntry[] = [];
    const manifestArtifacts: Array<RunArtifactSummary & { archivePath?: string }> = [];
    const usedNames = new Set<string>();
    for (const artifact of artifacts) {
      const content = await resolveRunArtifactContent(
        run,
        mniuRoot,
        artifact,
        artifactRemoteStore
      );
      if (!content) {
        manifestArtifacts.push(artifact);
        continue;
      }
      const archivePath = uniqueArchivePath(artifact, usedNames);
      archiveEntries.push({
        name: archivePath,
        content
      });
      manifestArtifacts.push({
        ...artifact,
        archivePath,
        bytes: content.byteLength
      });
    }

    const manifest = Buffer.from(
      JSON.stringify(
        {
          runId: run.id,
          generatedAt: new Date().toISOString(),
          filters,
          artifacts: manifestArtifacts.map(({ inlineText, ...artifact }) => artifact)
        },
        null,
        2
      ),
      "utf8"
    );
    const archive = createTarArchive([
      {
        name: "manifest.json",
        content: manifest
      },
      ...archiveEntries
    ]);
    const filename = `${safePathSegment(run.id)}-artifacts.tar`;
    reply.header("content-type", "application/x-tar");
    reply.header("content-length", String(archive.byteLength));
    reply.header("content-disposition", `attachment; filename="${filename}"`);
    return reply.send(archive);
  });

  app.get("/v1/runs/:id/artifacts/:artifactId", async (request, reply) => {
    const { id, artifactId } = request.params as { id: string; artifactId: string };
    const run = store.runs.get(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    const artifact = (
      await listRunArtifacts(
        run,
        mniuRoot,
        artifactRemoteStore,
        enforceArtifactStoreQuotaSafely
      )
    ).find((item) => item.id === artifactId);
    if (!artifact) return reply.code(404).send({ error: "artifact not found" });

    const content = await resolveRunArtifactContent(
      run,
      mniuRoot,
      artifact,
      artifactRemoteStore
    );
    if (content) {
      return sendArtifactContent(reply, artifact, content);
    }

    return reply.code(409).send({
      error: "artifact content is not available from current run record",
      artifact
    });
  });

  app.get("/v1/artifacts/store", async () =>
    summarizeArtifactStore(mniuRoot, artifactRemoteStore)
  );

  app.post("/v1/artifacts/store/cleanup", async (request, reply) => {
    const input = artifactStoreCleanupSchema.parse(request.body ?? {});
    if (
      input.maxAgeDays === undefined &&
      input.keepLatestRuns === undefined &&
      input.maxBytes === undefined
    ) {
      return reply.code(400).send({
        error: "cleanup requires maxAgeDays, keepLatestRuns or maxBytes"
      });
    }
    const includeLocal = input.scope !== "remote";
    const includeRemote = input.scope !== "local";
    if (includeRemote && !artifactRemoteStore) {
      return reply.code(400).send({
        error: "remote artifact store cleanup requires artifact remote store configuration"
      });
    }

    const local = includeLocal
      ? await executeArtifactStoreCleanup(
          await planArtifactStoreCleanup(mniuRoot, input),
          input.dryRun,
          "local"
        )
      : emptyArtifactStoreCleanupScopeResult();
    const remote = includeRemote && artifactRemoteStore
      ? await executeArtifactStoreCleanup(
          await planRemoteArtifactStoreCleanup(artifactRemoteStore, input),
          input.dryRun,
          "remote",
          artifactRemoteStore
        )
      : undefined;
    const cleanupScopes = [local, ...(remote ? [remote] : [])];
    const cleanup = {
      dryRun: input.dryRun,
      scope: input.scope,
      policy: {
        maxAgeDays: input.maxAgeDays,
        keepLatestRuns: input.keepLatestRuns,
        maxBytes: input.maxBytes,
        scope: input.scope
      },
      totalRuns: cleanupScopes.reduce((total, scope) => total + scope.totalRuns, 0),
      candidateRuns: cleanupScopes.reduce((total, scope) => total + scope.candidateRuns, 0),
      candidateBytes: cleanupScopes.reduce((total, scope) => total + scope.candidateBytes, 0),
      candidates: cleanupScopes.flatMap((scope) => scope.candidates),
      deleted: cleanupScopes.flatMap((scope) => scope.deleted),
      ...(includeLocal ? { local } : {}),
      ...(remote && artifactRemoteStore
        ? { remote: { ...artifactRemoteStoreDescriptor(artifactRemoteStore), ...remote } }
        : {})
    };
    const audit = await recordArtifactStoreCleanup(mniuRoot, {
      trigger: "manual",
      cleanup,
      persistPolicy: true
    });
    return {
      ...cleanup,
      audit
    };
  });

  app.post("/v1/runs/:id/workspaces/cleanup", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.runs.get(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    if (!isTerminalRunStatus(run.status)) {
      return reply.code(409).send({ error: "run is not terminal" });
    }

    const project = store.projects.get(run.projectId);
    const results = await cleanupRunWorkspaces(run, workspaceRoot, project?.rootPath);
    const deletedCount = results.filter((result) => result.status === "deleted").length;
    const skippedCount = results.length - deletedCount;
    store.appendEvent({
      runId: id,
      type: "status",
      message: `Workspace cleanup completed: ${deletedCount} deleted, ${skippedCount} skipped`,
      timestamp: new Date().toISOString(),
      data: { results }
    });
    return {
      runId: id,
      workspaceRoot: resolve(workspaceRoot),
      results
    };
  });

  return app;

  async function persistRunArtifactsSafely(run: RunRecord): Promise<void> {
    if (!isTerminalRunStatus(run.status)) return;
    try {
      await persistRunArtifacts(run, mniuRoot, artifactRemoteStore);
      await enforceArtifactStoreQuotaSafely();
    } catch (error) {
      store.appendEvent({
        runId: run.id,
        type: "error",
        message: `Artifact persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date().toISOString()
      });
    }
  }

  async function enforceArtifactStoreQuotaSafely(): Promise<void> {
    if (!artifactStoreQuota) return;
    try {
      const plan = await planArtifactStoreCleanup(mniuRoot, {
        dryRun: false,
        maxBytes: artifactStoreQuota.maxBytes,
        protectLatestRuns: artifactStoreQuota.keepLatestRuns
      });
      if (plan.candidates.length === 0) return;

      const local = await executeArtifactStoreCleanup(plan, false, "local");
      await recordArtifactStoreCleanup(mniuRoot, {
        trigger: "quota",
        cleanup: {
          dryRun: false,
          scope: "local",
          policy: {
            maxBytes: artifactStoreQuota.maxBytes,
            keepLatestRuns: artifactStoreQuota.keepLatestRuns,
            scope: "local"
          },
          totalRuns: local.totalRuns,
          candidateRuns: local.candidateRuns,
          candidateBytes: local.candidateBytes,
          candidates: local.candidates,
          deleted: local.deleted,
          local
        },
        persistPolicy: false
      });
      app.log.info(
        {
          maxBytes: artifactStoreQuota.maxBytes,
          keepLatestRuns: artifactStoreQuota.keepLatestRuns,
          deletedRuns: local.deleted.map((run) => run.runId)
        },
        "artifact store quota cleanup completed"
      );
    } catch (error) {
      app.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "artifact store quota cleanup failed"
      );
    }
  }

  function queueRunJob(
    project: Project,
    task: AgentTask,
    options: {
      runId?: string;
      recovered?: boolean;
      resumeFrom?: RunRecord;
      priority?: number;
      bindings?: Partial<RunRecord>;
    } = {}
  ): RunRecord {
    const runId = options.runId ?? randomUUID();
    const now = new Date().toISOString();
    const existing = store.runs.get(runId);
    const queuedWithoutBindings: RunRecord =
      options.resumeFrom
        ? { ...options.resumeFrom, status: "queued", gates: [], updatedAt: now }
      : existing && existing.candidates.length === 0
        ? { ...existing, status: "queued", gates: [], updatedAt: now }
        : {
            id: runId,
            taskId: task.id,
            projectId: project.id,
            status: "queued",
            candidates: [],
            gates: [],
            createdAt: now,
            updatedAt: now,
            ...(options.bindings ?? {})
          };
    const queued = withTaskRunBindings(queuedWithoutBindings, project, task);
    store.runs.set(runId, queued);
    const queuedJob = store.queueRunJob({
      runId,
      projectId: project.id,
      taskId: task.id,
      priority: options.priority,
      recovered: Boolean(options.recovered || options.resumeFrom),
      now,
      ...(options.resumeFrom ? { resumeFromRunId: options.resumeFrom.id } : {})
    });
    const workerRequirements = workerRequirementsForRun(project, task, queued);
    if (!enterprisePostgres) {
      runJobQueue.enqueue({
        ...queuedJob,
        ...(workerRequirements
          ? {
              version: 2 as const,
              tenantId: queued.tenantId ?? task.tenantId ??
                project.tenantId ?? LOCAL_TENANT_ID,
              requirements: workerRequirements
            }
          : {})
      });
    }
    store.appendEvent({
      runId,
      type: "status",
      message: options.resumeFrom
        ? "Run resumed from checkpoint after API restart"
        : options.recovered
          ? "Run requeued after API restart"
          : "Run queued",
      timestamp: now
    });
    return queued;
  }

  async function enqueueEnterpriseRunJob(
    project: Project,
    task: AgentTask,
    run: RunRecord,
    options: {
      priority?: number;
      governedResumeState?: GovernedRunState;
      approvalDecision?: ApprovalDecision;
      auditEvent?: AuditEvent;
      relatedRunEventIds?: readonly string[];
    } = {}
  ): Promise<void> {
    if (!enterprisePostgres) return;
    const requirements = workerRequirementsForRun(project, task, run);
    const tenantId = run.tenantId ?? task.tenantId ??
      project.tenantId ?? LOCAL_TENANT_ID;
    let sourceSnapshot: RunScopedCasObjectRef | undefined;
    if (task.specRef) {
      const snapshot = await createWorkspaceSnapshot(project.rootPath);
      sourceSnapshot = await runScopedCas.put({
        tenantId,
        projectId: project.id,
        runId: run.id,
        contentType: snapshot.contentType,
        content: snapshot.content
      });
      if (
        sourceSnapshot.digest !== snapshot.digest ||
        sourceSnapshot.byteLength !== snapshot.byteLength
      ) {
        throw new Error("source snapshot CAS returned an inconsistent immutable binding");
      }
    }
    const executionContext = await enterpriseWorkerExecutionContext({
      tenantId,
      project,
      task,
      run,
      store,
      specRepository,
      ...(sourceSnapshot ? { sourceSnapshot } : {})
    });
    const events = store.events.get(run.id) ?? [];
    const metadataRecords = [
      enterpriseMetadataWrite(tenantId, "run", run.id, run),
      enterpriseMetadataWrite(tenantId, "run_events", run.id, {
        runId: run.id,
        events
      }),
      ...(options.relatedRunEventIds ?? []).map((relatedRunId) =>
        enterpriseMetadataWrite(tenantId, "run_events", relatedRunId, {
          runId: relatedRunId,
          events: store.events.get(relatedRunId) ?? []
        })
      ),
      ...(options.governedResumeState
        ? [enterpriseMetadataWrite(
            tenantId,
            "governed_loop_state",
            run.id,
            options.governedResumeState
          )]
        : [])
    ];
    try {
      await enterprisePostgres.enqueueRunJob({
        runId: run.id,
        tenantId,
        projectId: project.id,
        taskId: task.id,
        priority: options.priority,
        ...(requirements ? { requirements } : {}),
        payload: {
          version: 2,
          run,
          ...(executionContext ? { executionContext } : {}),
          ...(options.governedResumeState
            ? { governedResumeState: options.governedResumeState }
            : {}),
          ...(options.approvalDecision
            ? { approvalDecision: options.approvalDecision }
            : {})
        },
        metadataRecords,
        ...(options.auditEvent ? { auditEvent: options.auditEvent } : {})
      });
    } catch (error) {
      const snapshot = await enterprisePostgres.readStateSnapshot();
      await restoreEnterpriseSnapshot({ store, specRepository, localStore, snapshot });
      throw error;
    }
  }

  function startRunJob(
    project: Project,
    task: AgentTask,
    options: {
      runId?: string;
      recovered?: boolean;
      resumeFrom?: RunRecord;
      priority?: number;
      bindings?: Partial<RunRecord>;
      governedResumeState?: GovernedRunState;
      approvalDecision?: ApprovalDecision;
    } = {}
  ): RunRecord {
    const runId = options.runId ?? randomUUID();
    if (activeRunJobs.has(runId)) {
      return store.runs.get(runId)!;
    }
    const lease = runJobLeases.acquire(runId);
    if (!lease) {
      const current = store.runs.get(runId);
      if (current) {
        store.appendEvent({
          runId,
          type: "status",
          message: "Run job lease is held by another API process; skipping local start.",
          timestamp: new Date().toISOString()
        });
        return current;
      }
      throw new Error(`Run job lease is held for ${runId}`);
    }
    try {
      const queued = queueRunJob(project, task, { ...options, runId });
      startQueuedRunJob(project, task, queued, lease, {
        resumeFromQueued: Boolean(options.resumeFrom),
        ...(options.governedResumeState
          ? { governedResumeState: options.governedResumeState }
          : {}),
        ...(options.approvalDecision
          ? { approvalDecision: options.approvalDecision }
          : {})
      });
      return queued;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  function startQueuedRunJob(
    project: Project,
    task: AgentTask,
    queued: RunRecord,
    lease: RunJobLease,
    options: {
      resumeFromQueued?: boolean;
      governedResumeState?: GovernedRunState;
      approvalDecision?: ApprovalDecision;
    } = {}
  ): void {
    const runId = queued.id;
    const controller = new AbortController();
    const orchestrator = new RunOrchestrator({
      workspaceRoot,
      executors,
      proxyBaseUrl: currentProxyBaseUrl(),
      onEvent: (event) => store.appendEvent(event),
      onUpdate: (record) => {
        if (isTerminalRunStatus(record.status)) return;
        store.runs.set(record.id, withTaskRunBindings(record, project, task));
      }
    });
    const done = Promise.resolve()
      .then(async () => {
        const startedAt = new Date().toISOString();
        store.markRunJobRunning(runId, startedAt);
        runJobQueue.markRunning(runId, startedAt, lease.ownerId);
        let orchestratorRun: RunRecord;
        if (
          task.specRef &&
          queued.governanceSnapshot &&
          queued.harnessManifest
        ) {
          const governed = new GovernedRunOrchestrator({
            workspaceRoot,
            executors,
            proxyBaseUrl: currentProxyBaseUrl(),
            onEvent: (event) => store.appendEvent(event),
            onUpdate: (record) => {
              if (isTerminalRunStatus(record.status)) return;
              store.runs.set(record.id, withTaskRunBindings(record, project, task));
            },
            onLoopCheckpoint: (state) => {
              store.governedLoopStates.set(state.runId, state);
            },
            resolveSpecRevision: async (ref) => {
              const record = await specRepository.get(ref.specSetId);
              return record?.revisions.find(
                (revision) =>
                  revision.revision === ref.revision &&
                  revision.digest === ref.digest
              );
            }
          });
          const result = await governed.run(project, task, queued, {
            ...(options.governedResumeState
              ? { resumeFrom: options.governedResumeState }
              : {}),
            ...(options.approvalDecision
              ? { approvalDecision: options.approvalDecision }
              : {}),
            abortSignal: controller.signal
          });
          orchestratorRun = result.run;
          store.governedLoopStates.set(runId, result.state);
        } else if (task.specRef) {
          throw new Error(
            "Governed run was queued without immutable Governance and Harness snapshots"
          );
        } else {
          orchestratorRun = await orchestrator.run(project, task, {
            runId,
            resumeFrom: options.resumeFromQueued ? queued : undefined,
            abortSignal: controller.signal
          });
        }
        const finalRun = withTaskRunBindings(orchestratorRun, project, task);
        await persistRunArtifactsSafely(finalRun);
        const finishedAt = new Date().toISOString();
        runJobQueue.markFinished(
          runId,
          runJobStatusFromRun(finalRun.status),
          finishedAt
        );
        store.finishRun(
          finalRun,
          runJobStatusFromRun(finalRun.status),
          finishedAt
        );
      })
      .catch(async (error: unknown) => {
        const current = store.runs.get(runId) ?? queued;
        if (isTerminalRunStatus(current.status)) {
          await persistRunArtifactsSafely(current);
          const finishedAt = new Date().toISOString();
          runJobQueue.markFinished(
            runId,
            runJobStatusFromRun(current.status),
            finishedAt
          );
          store.finishRun(
            current,
            runJobStatusFromRun(current.status),
            finishedAt
          );
          return;
        }
        const updated: RunRecord = {
          ...current,
          status: controller.signal.aborted ? "cancelled" : "failed",
          updatedAt: new Date().toISOString()
        };
        runJobQueue.markFinished(
          runId,
          runJobStatusFromRun(updated.status),
          updated.updatedAt
        );
        store.finishRun(
          updated,
          runJobStatusFromRun(updated.status),
          updated.updatedAt
        );
        store.appendEvent({
          runId,
          type: controller.signal.aborted ? "status" : "error",
          message: controller.signal.aborted
            ? "Run cancelled"
            : error instanceof Error
              ? error.message
            : String(error),
          timestamp: updated.updatedAt
        });
        await persistRunArtifactsSafely(updated);
      })
      .finally(() => {
        lease.release();
        activeRunJobs.delete(runId);
      });
    activeRunJobs.set(runId, { controller, done, lease });
  }

  function currentProxyBaseUrl(): string | undefined {
    const runtime = proxyServer?.status();
    if (!runtime?.running) return undefined;
    return `http://${runtime.host}:${runtime.port}`;
  }

  function runJobStatusFromRun(
    status: RunRecord["status"]
  ): "completed" | "failed" | "cancelled" {
    if (status === "failed") return "failed";
    if (status === "cancelled") return "cancelled";
    return "completed";
  }

  async function syncDueProviderModelCatalogs(options: {
    dryRun: boolean;
    app?: ManagedAgentApp;
    providerIds?: string[];
    limit?: number;
  }): Promise<{
    dryRun: boolean;
    checkedCount: number;
    policyCount: number;
    dueCount: number;
    syncedCount: number;
    failedCount: number;
    results: ProviderModelCatalogSyncDueRow[];
  }> {
    const providerIdFilter = options.providerIds
      ? new Set(options.providerIds)
      : undefined;
    const providers = (await localStore.listProviders(options.app))
      .filter((provider) => !isAgentOnlyProvider(provider))
      .filter((provider) => providerIdFilter ? providerIdFilter.has(provider.id) : true);
    const results: ProviderModelCatalogSyncDueRow[] = [];
    let policyCount = 0;
    let dueCount = 0;
    let syncedCount = 0;
    let failedCount = 0;

    for (const provider of providers) {
      if (options.limit && results.length >= options.limit) break;
      const policy = readProviderModelCatalogSyncPolicy(
        provider.config.modelCatalogSyncPolicy
      );
      if (!policy) continue;
      policyCount += 1;
      const due = providerModelCatalogSyncDueState(provider, policy);
      if (!due.due) {
        results.push({
          providerId: provider.id,
          providerName: provider.name,
          status: "skipped",
          reason: due.reason,
          nextSyncAt: due.nextSyncAt,
          policy,
          audit: buildProviderModelCatalogAudit(provider, policy.maxAgeDays)
        });
        continue;
      }

      dueCount += 1;
      if (options.dryRun) {
        results.push({
          providerId: provider.id,
          providerName: provider.name,
          status: "would_sync",
          reason: due.reason,
          nextSyncAt: due.nextSyncAt,
          policy,
          audit: buildProviderModelCatalogAudit(provider, policy.maxAgeDays)
        });
        continue;
      }

      try {
        const incomingModels = await providerModelsFromCatalogUrl(policy.sourceUrl);
        const sync = buildProviderModelCatalogSync(provider, incomingModels, policy.mode);
        const syncMetadata = buildProviderModelCatalogSyncMetadata(sync.modelCatalog, {
          source: { type: "url", url: policy.sourceUrl },
          mode: policy.mode,
          maxAgeDays: policy.maxAgeDays,
          syncedAt: new Date().toISOString()
        });
        const syncedProvider = await localStore.updateProvider(provider.id, {
          modelCatalog: sync.modelCatalog,
          config: {
            ...provider.config,
            modelCatalogSync: syncMetadata,
            modelCatalogSyncPolicy: {
              ...policy,
              updatedAt: policy.updatedAt
            }
          }
        });
        syncedCount += 1;
        results.push({
          providerId: provider.id,
          providerName: provider.name,
          status: "synced",
          reason: due.reason,
          policy,
          sync: {
            currentCount: provider.modelCatalog.length,
            incomingCount: incomingModels.length,
            finalCount: sync.modelCatalog.length,
            addedCount: sync.addedCount,
            updatedCount: sync.updatedCount,
            removedCount: sync.removedCount,
            unchangedCount: sync.unchangedCount,
            syncMetadata
          },
          audit: buildProviderModelCatalogAudit(syncedProvider, policy.maxAgeDays)
        });
      } catch (error) {
        failedCount += 1;
        results.push({
          providerId: provider.id,
          providerName: provider.name,
          status: "failed",
          reason: due.reason,
          policy,
          error: errorDetail(error),
          audit: buildProviderModelCatalogAudit(provider, policy.maxAgeDays)
        });
      }
    }

    return {
      dryRun: options.dryRun,
      checkedCount: providers.length,
      policyCount,
      dueCount,
      syncedCount,
      failedCount,
      results
    };
  }

  async function providerApiKeyRef(apiKey?: string, apiKeyEnv?: string) {
    if (apiKey && apiKeyEnv) {
      throw new Error("Use either apiKey or apiKeyEnv, not both.");
    }
    if (apiKey) return secretVault.saveSecret(apiKey);
    if (apiKeyEnv) {
      return {
        type: "env" as const,
        ref: apiKeyEnv,
        maskedValue: process.env[apiKeyEnv] ? maskSecret(process.env[apiKeyEnv]) : undefined
      };
    }
    return undefined;
  }

  async function resolveStoredSecret(secretRef: {
    type: string;
    ref: string;
  }): Promise<string | undefined> {
    if (secretRef.type === "local_encrypted" || secretRef.type === "keychain") {
      return secretVault.readSecret(secretRef.ref, secretRef.type);
    }
    return undefined;
  }

  async function deleteProviderSecretIfUnused(secretRef: {
    type: string;
    ref: string;
  }): Promise<void> {
    if (secretRef.type !== "local_encrypted" && secretRef.type !== "keychain") return;
    const stillUsed = (await localStore.listProviders()).some(
      (provider) =>
        provider.apiKeyRef?.type === secretRef.type && provider.apiKeyRef.ref === secretRef.ref
    );
    if (!stillUsed) await secretVault.deleteSecret(secretRef.ref, secretRef.type);
  }

  async function appendLiveConfigAudit(entry: {
    action: string;
    apps: readonly string[];
    entityType: string;
    entityId: string;
    targetPaths: readonly string[];
  }): Promise<void> {
    const logDir = join(mniuRoot, "logs");
    await mkdir(logDir, { recursive: true });
    await appendFile(
      join(logDir, "live-config-audit.jsonl"),
      `${JSON.stringify({
        version: 1,
        recordedAt: new Date().toISOString(),
        action: entry.action,
        apps: [...entry.apps],
        entityType: entry.entityType,
        entityId: entry.entityId,
        targetPaths: [...entry.targetPaths]
      })}\n`
    );
  }

  async function readOptionalText(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
  }

  async function resolveProviderToken(provider: {
    apiKeyRef?: { type: string; ref: string };
  }): Promise<string | undefined> {
    const secretRef = provider.apiKeyRef;
    if (!secretRef) return undefined;
    if (secretRef.type === "env") return process.env[secretRef.ref];
    return resolveStoredSecret(secretRef);
  }

  async function handleDeepLinkImport(
    rawUrl: string,
    dryRun: boolean,
    reply: FastifyReply
  ) {
    try {
      const deepLink = parseMniuImportDeepLink(rawUrl);
      const result =
        deepLink.kind === "providers"
          ? await importProviders(providerImportItemsFromDeepLinkPayload(deepLink.payload), {
              dryRun,
              existingProviders: await localStore.listProviders(),
              createProvider: (input) => localStore.createProvider(input)
            })
          : deepLink.kind === "mcp_servers"
            ? await importMcpServers(mcpImportItemsFromDeepLinkPayload(deepLink.payload), {
                dryRun,
                existingServers: await localStore.listMcpServers(),
                createServer: async (input) =>
                  localStore.createMcpServer({
                    ...input,
                    env: await storeMcpEnv(input.env)
                  })
              })
            : await importPromptPresets(promptImportItemsFromDeepLinkPayload(deepLink.payload), {
                dryRun,
                existingPrompts: await localStore.listPromptPresets(),
                createPrompt: (input) => localStore.createPromptPreset(input)
              });
      if (dryRun) {
        const auditDir = join(mniuRoot, "deeplink-imports");
        await mkdir(auditDir, { recursive: true });
        await writeFile(
          join(auditDir, "last-preview.json"),
          `${JSON.stringify({
            version: 1,
            previewedAt: new Date().toISOString(),
            kind: deepLink.kind,
            wouldImportCount: result.wouldImportCount
          }, null, 2)}\n`
        );
      }
      return {
        scheme: deepLink.scheme,
        action: deepLink.action,
        kind: deepLink.kind,
        trusted: false,
        requiresConfirmation: true,
        dryRun,
        result
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  }

  async function storeMcpEnv(env: Record<string, string>): Promise<Record<string, string>> {
    const entries = await Promise.all(
      Object.entries(env).map(async ([key, value]) => {
        if (isMcpLocalSecretRef(value)) return [key, value] as const;
        return [key, mcpSecretValue(await secretVault.saveSecret(value))] as const;
      })
    );
    return Object.fromEntries(entries);
  }

  async function resolveMcpServerEnv(server: McpServerRecord): Promise<McpServerRecord> {
    const entries = await Promise.all(
      Object.entries(server.env).map(async ([key, value]) => {
        const secretRef = parseMcpSecretRef(value);
        if (!secretRef) return [key, value] as const;
        const secret = await secretVault.readSecret(secretRef.ref, secretRef.type);
        if (secret === undefined) throw new Error(`MCP env secret not found: ${key}`);
        return [key, secret] as const;
      })
    );
    return {
      ...server,
      env: Object.fromEntries(entries)
    };
  }

  async function readProxyStatus() {
    const persisted = await localStore.readProxy();
    const runtime = proxyServer?.status() ?? {
      running: false,
      host: "127.0.0.1",
      port: persisted.port
    };
    return {
      proxy: {
        ...persisted,
        status: runtime.running ? "running" : "stopped",
        port: runtime.port
      },
      runtime
    };
  }
}

export function defaultSecretVaultBackend(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): "local_encrypted" | "keychain" {
  if (env.MN_SECRET_VAULT_BACKEND === "keychain") return "keychain";
  if (env.MN_SECRET_VAULT_BACKEND === "local_encrypted") return "local_encrypted";
  return env.MN_DESKTOP_PACKAGED === "1" && platform === "darwin"
    ? "keychain"
    : "local_encrypted";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

interface ResourceScopedRequest {
  readonly url: string;
  readonly params: unknown;
  readonly body: unknown;
  readonly query: unknown;
}

function stringId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function projectForRequest(
  request: ResourceScopedRequest,
  store: MemoryStore
): Project | undefined {
  const pathname = request.url.split("?")[0] ?? request.url;
  const params =
    request.params && typeof request.params === "object"
      ? request.params as Record<string, unknown>
      : {};
  const body =
    request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
  const query =
    request.query && typeof request.query === "object" && !Array.isArray(request.query)
      ? request.query as Record<string, unknown>
      : {};
  if (pathname === "/v1/tasks") {
    return store.projects.get(stringId(body.projectId) ?? "");
  }
  if (/^\/v1\/projects\//u.test(pathname)) {
    return store.projects.get(stringId(params.id) ?? "");
  }
  if (/^\/v1\/tasks\//u.test(pathname)) {
    const task = store.tasks.get(stringId(params.id) ?? "");
    return task ? store.projects.get(task.projectId) : undefined;
  }
  if (/^\/v1\/(?:runs|run-jobs\/queue)\//u.test(pathname)) {
    const run = store.runs.get(stringId(params.id) ?? "");
    return run ? store.projects.get(run.projectId) : undefined;
  }
  if (
    /^\/v1\/(?:eval-assets|trace-graphs|learning-proposals|maturity-report)(?:\/|$)/u.test(
      pathname
    )
  ) {
    return store.projects.get(
      stringId(body.projectId) ?? stringId(query.projectId) ?? ""
    );
  }
  return undefined;
}

function auditResourceType(url: string): string {
  const segment = url.split("?")[0]?.split("/").filter(Boolean)[1];
  return segment ?? "http_request";
}

function auditResourceId(request: ResourceScopedRequest): string | undefined {
  const params =
    request.params && typeof request.params === "object"
      ? request.params as Record<string, unknown>
      : {};
  return stringId(params.id) ?? stringId(params.runId);
}

function validateExternalRunBindings(
  existing: RunRecord | undefined,
  incoming: RunRecord
): string | undefined {
  if (!existing) return "queued run does not exist";
  for (const field of ["id", "taskId", "projectId", "createdAt"] as const) {
    if (incoming[field] !== existing[field]) {
      return `external worker cannot change run ${field}`;
    }
  }
  if (
    (incoming.tenantId ?? LOCAL_TENANT_ID) !==
    (existing.tenantId ?? LOCAL_TENANT_ID)
  ) {
    return "external worker cannot change run tenant binding";
  }
  const immutableRefs = [
    ["workflow", existing.workflowRef, incoming.workflowRef],
    ["governance", existing.governanceSnapshot, incoming.governanceSnapshot],
    ["harness", existing.harnessManifest, incoming.harnessManifest]
  ] as const;
  for (const [field, before, after] of immutableRefs) {
    if (
      Boolean(before) !== Boolean(after) ||
      (before && after &&
        ((before.digest ?? undefined) !== (after.digest ?? undefined) ||
          sha256Canonical(before) !== sha256Canonical(after)))
    ) {
      return `external worker cannot change run ${field} binding`;
    }
  }
  if (
    Date.parse(incoming.updatedAt) < Date.parse(existing.updatedAt) ||
    !Number.isFinite(Date.parse(incoming.updatedAt))
  ) {
    return "external worker cannot move the run clock backwards";
  }
  if (isTerminalRunStatus(existing.status) && sha256Canonical(existing) !== sha256Canonical(incoming)) {
    return "external worker cannot mutate a terminal run";
  }
  if (existing.status !== "queued" && incoming.status === "queued") {
    return "external worker cannot move an active run back to queued";
  }
  for (const field of ["specDigest", "governanceDigest", "harnessDigest"] as const) {
    if (existing.trace?.[field] !== incoming.trace?.[field]) {
      return `external worker cannot change run trace ${field}`;
    }
  }
  return undefined;
}

async function authoritativeUsageForRun(
  usageLedger: Pick<EnterprisePostgresRuntime, "readProviderUsageAccounting">,
  providerStore: Pick<FileLocalStore, "listProviders">,
  tenantId: string,
  runId: string,
  maxCostUsd?: number
): Promise<AuthoritativeProxyUsage> {
  const accounting = await usageLedger.readProviderUsageAccounting({ tenantId, runId });
  assertProviderUsageAccountingFinalized(accounting);
  const logs = accounting.usageLogs;
  if (logs.some((log) => {
    const association = log.trustedAssociation;
    return (
      !association ||
      association.issuer !== "mn-api" ||
      association.tenantId !== tenantId ||
      association.runId !== runId ||
      association.candidateId !== log.candidateId ||
      log.runId !== runId ||
      !log.candidateId
    );
  })) {
    throw new TypeError(
      "provider usage is not bound to an API-issued tenant/run/candidate receipt"
    );
  }
  const pricing = pricingCatalogFromProviders(await providerStore.listProviders());
  const usage = authoritativeProxyUsage(
    logs,
    new Map(
      logs.map((log) => [
        log.id,
        estimateProxyRequestLogCostUsd(log, pricing)
      ])
    )
  );
  return applyFailClosedUnpricedCost(usage, maxCostUsd);
}

export async function validateEnterpriseLoopBudgetMeasurements(input: {
  readonly state: GovernedRunState | undefined;
  readonly previous: GovernedRunState | undefined;
  readonly run: RunRecord;
  readonly item: RunJobQueueItem;
  readonly tenantId: string;
  readonly workerId: string;
  readonly signingKey: string | undefined;
  readonly usageLedger: Pick<EnterprisePostgresRuntime, "readProviderUsageAccounting">;
  readonly providerStore: Pick<FileLocalStore, "listProviders">;
  readonly cas: RunScopedCas;
  readonly now?: string;
}): Promise<string | undefined> {
  if (!input.state) return "enterprise governed run requires a measured Loop state";
  if (!input.signingKey) {
    return "enterprise governed run requires API Loop measurement enforcement";
  }
  if (!input.item.claimTokenHash || !input.item.claimedAt || !input.item.claimExpiresAt) {
    return "active claim is missing authoritative Loop measurement bindings";
  }
  const currentTime = Date.parse(input.now ?? new Date().toISOString());
  let lastProof: LoopBudgetMeasurementProof | undefined;
  for (const [index, attempt] of input.state.attempts.entries()) {
    if (attempt.status === "running") continue;
    const proof = attempt.budgetMeasurement;
    if (!proof) {
      return `Loop attempt ${attempt.id} has no API-issued budget measurement`;
    }
    const before = input.previous?.attempts[index];
    const newlyMeasured = before?.budgetMeasurement?.digest !== proof.digest;
    const verification = verifyLoopBudgetMeasurement(
      proof,
      {
        tenantId: input.tenantId,
        runId: input.run.id,
        signingKey: input.signingKey,
        ...(newlyMeasured
          ? {
              workerId: input.workerId,
              claimDigest: input.item.claimTokenHash
            }
          : {})
      }
    );
    if (!verification.valid) {
      return `Loop attempt ${attempt.id} has invalid measurement: ${verification.reason ?? "verification failed"}`;
    }
    const expectedDuration = Math.max(
      0,
      Math.ceil(
        (Date.parse(proof.measuredAt) - Date.parse(proof.intervalStartedAt)) /
          1_000
      )
    );
    if (proof.delta.durationSeconds !== expectedDuration) {
      return `Loop attempt ${attempt.id} duration does not match the server clock interval`;
    }
    if (newlyMeasured) {
      const measuredAt = Date.parse(proof.measuredAt);
      const expectedIntervalStartedAt = lastProof?.claimDigest === input.item.claimTokenHash
        ? lastProof.measuredAt
        : input.item.claimedAt;
      if (
        proof.intervalStartedAt !== expectedIntervalStartedAt ||
        measuredAt < Date.parse(input.item.claimedAt) ||
        measuredAt > Date.parse(input.item.claimExpiresAt) ||
        measuredAt > currentTime + 5_000 ||
        currentTime - measuredAt > 30_000
      ) {
        return `Loop attempt ${attempt.id} measurement is outside the active claim freshness window`;
      }
    }
    if (attempt.stage === "implementation") {
      if (!proof.diffArtifact) {
        return `implementation attempt ${attempt.id} has no authoritative diff artifact`;
      }
      if (newlyMeasured) {
        const candidate = input.run.candidates.find(
          (entry) => entry.id === proof.diffArtifact?.candidateId
        );
        if (
          !candidate ||
          candidate.worktreePath !== proof.diffArtifact.workspaceUri ||
          (input.run.winnerCandidateId !== undefined &&
            input.run.winnerCandidateId !== proof.diffArtifact.candidateId)
        ) {
          return `implementation attempt ${attempt.id} diff source is not bound to the reported winner workspace`;
        }
      }
      const runtimeBindings = [
        ...(input.run.sandboxEvidenceHistory ?? []).map((binding) => binding.execution),
        ...(input.run.sandboxExecution ? [input.run.sandboxExecution] : [])
      ];
      const runtime = runtimeBindings.find(
        (execution) =>
          execution.leaseId === proof.diffArtifact?.leaseId &&
          execution.runtimeId === proof.diffArtifact.runtimeId &&
          execution.runtimeProof.digest === proof.diffArtifact.runtimeProofDigest
      );
      if (
        !runtime ||
        runtime.runtimeProof.claimDigest !== proof.claimDigest ||
        runtime.runtimeProof.runId !== input.run.id ||
        runtime.runtimeProof.tenantId !== input.tenantId
      ) {
        return `implementation attempt ${attempt.id} diff source runtime domain is invalid`;
      }
      const expectedUri = `mn://cas/loop-diffs/${encodeURIComponent(proof.diffArtifact.id)}`;
      if (proof.diffArtifact.uri !== expectedUri) {
        return `implementation attempt ${attempt.id} diff artifact URI is invalid`;
      }
      const ref: RunScopedCasObjectRef = {
        schemaVersion: 1,
        objectKey: proof.diffArtifact.id,
        digest: proof.diffArtifact.digest,
        byteLength: proof.diffArtifact.byteLength,
        contentType: LOOP_DIFF_MANIFEST_CONTENT_TYPE
      };
      let content: Buffer | undefined;
      try {
        content = await input.cas.readVerified(ref);
      } catch (error) {
        return `implementation attempt ${attempt.id} diff CAS verification failed: ${
          error instanceof Error ? error.message : "invalid CAS object"
        }`;
      }
      if (!content) {
        return `implementation attempt ${attempt.id} diff CAS object is missing`;
      }
      let measured;
      try {
        measured = measureLoopDiffManifest(content);
      } catch (error) {
        return `implementation attempt ${attempt.id} diff manifest is invalid: ${
          error instanceof Error ? error.message : "invalid diff manifest"
        }`;
      }
      if (
        proof.delta.changedFiles !== measured.changedFiles ||
        proof.delta.changedLines !== measured.changedLines
      ) {
        return `implementation attempt ${attempt.id} change usage does not match CAS bytes`;
      }
    } else if (
      proof.diffArtifact !== undefined ||
      proof.delta.changedFiles !== 0 ||
      proof.delta.changedLines !== 0
    ) {
      return `non-implementation attempt ${attempt.id} cannot report source changes`;
    }
    lastProof = proof;
  }

  let usage: AuthoritativeProxyUsage;
  try {
    usage = await authoritativeUsageForRun(
      input.usageLedger,
      input.providerStore,
      input.tenantId,
      input.run.id,
      input.run.harnessManifest?.stopConditions.maxCostUsd
    );
  } catch (error) {
    return error instanceof Error ? error.message : "provider usage verification failed";
  }
  if (!lastProof) {
    return usage.tokens === 0 && input.state.attempts.every((attempt) => attempt.status === "running")
      ? undefined
      : "Loop state has no authoritative measurement ledger";
  }
  if (
    lastProof.cumulative.tokens !== usage.tokens ||
    Math.abs(lastProof.cumulative.costUsd - usage.costUsd) > 0.000000005 ||
    lastProof.usageDigest !== usage.digest ||
    sha256Canonical(lastProof.usageRequestIds) !== sha256Canonical(usage.requestIds)
  ) {
    return "Loop measurement under-reports current authoritative provider usage";
  }
  return undefined;
}

function validateEnterpriseSandboxEvidence(input: {
  readonly existing: RunRecord | undefined;
  readonly incoming: RunRecord;
  readonly item: RunJobQueueItem;
  readonly tenantId: string;
  readonly workerId: string;
  readonly signingKey: string | undefined;
}): string | undefined {
  if (!input.existing?.harnessManifest) return undefined;
  if (!input.signingKey) {
    return "enterprise governed run requires API sandbox attestation enforcement";
  }
  if (
    !input.item.requirementsDigest ||
    !input.item.workerCapabilityDigest ||
    !input.item.claimTokenHash
  ) {
    return "active claim is missing immutable sandbox capability digests";
  }
  const verification = verifySandboxAttestation(
    input.incoming.sandboxAttestation,
    {
      run: input.existing,
      tenantId: input.tenantId,
      workerId: input.workerId,
      requirementsDigest: input.item.requirementsDigest,
      workerCapabilityDigest: input.item.workerCapabilityDigest,
      claimDigest: input.item.claimTokenHash,
      signingKey: input.signingKey
    }
  );
  if (!verification.valid) {
    return `invalid API-issued sandbox attestation: ${verification.reason ?? "verification failed"}`;
  }
  const attestation = input.incoming.sandboxAttestation!;
  const execution = input.incoming.sandboxExecution;
  if (!execution) return "enterprise governed run requires inspected sandbox execution evidence";
  if (!sandboxExecutionMatchesAttestation(execution, attestation)) {
    return "sandbox execution evidence does not match the API-issued lease";
  }
  const runtimeVerification = verifySandboxRuntimeProof(
    execution.runtimeProof,
    {
      attestation,
      tenantId: input.tenantId,
      runId: input.existing.id,
      workerId: input.workerId,
      claimDigest: input.item.claimTokenHash,
      runtimeId: execution.runtimeId,
      runtimeDigest: execution.runtimeDigest,
      imageDigest: execution.imageDigest,
      signingKey: input.signingKey
    }
  );
  if (!runtimeVerification.valid) {
    return `invalid API-issued sandbox runtime proof: ${runtimeVerification.reason ?? "verification failed"}`;
  }
  const history = input.incoming.sandboxEvidenceHistory;
  if (!Array.isArray(history) || history.length === 0) {
    return "enterprise governed run requires append-only sandbox evidence history";
  }
  const previousHistory = input.existing.sandboxEvidenceHistory ?? [];
  if (history.length < previousHistory.length || history.length > previousHistory.length + 1) {
    return "sandbox evidence history must append at most one lease per checkpoint";
  }
  for (let index = 0; index < previousHistory.length; index += 1) {
    if (sha256Canonical(history[index]) !== sha256Canonical(previousHistory[index])) {
      return "sandbox evidence history cannot rewrite a persisted lease";
    }
  }
  const incomingResults = new Map(
    (input.incoming.gateResultsV2 ?? []).map((result) => [result.id, result])
  );
  for (const oldResult of input.existing.gateResultsV2 ?? []) {
    const current = incomingResults.get(oldResult.id);
    if (!current || sha256Canonical(current) !== sha256Canonical(oldResult)) {
      return `sandbox resume cannot rewrite historical GateResultV2 ${oldResult.id}`;
    }
  }
  const stageIds = new Set((input.incoming.stages ?? []).map((stage) => stage.id));
  const boundGateIds = new Set<string>();
  let currentLeasePresent = false;
  for (const [index, rawBinding] of history.entries()) {
    if (!rawBinding || typeof rawBinding !== "object" || Array.isArray(rawBinding)) {
      return `sandboxEvidenceHistory[${index}] must be an object`;
    }
    const binding = rawBinding;
    const trusted = verifyIssuedSandboxAttestation(
      binding.attestation,
      {
        run: input.existing,
        tenantId: input.tenantId,
        requirementsDigest: input.item.requirementsDigest,
        signingKey: input.signingKey
      }
    );
    if (!trusted.valid) {
      return `invalid historical sandbox attestation: ${trusted.reason ?? "verification failed"}`;
    }
    if (!sandboxExecutionMatchesAttestation(binding.execution, binding.attestation)) {
      return `sandboxEvidenceHistory[${index}] execution does not match its lease`;
    }
    const trustedRuntime = verifyIssuedSandboxRuntimeProof(
      binding.execution.runtimeProof,
      {
        attestation: binding.attestation,
        tenantId: input.tenantId,
        runId: input.existing.id,
        signingKey: input.signingKey
      }
    );
    if (!trustedRuntime.valid) {
      return `invalid historical sandbox runtime proof: ${trustedRuntime.reason ?? "verification failed"}`;
    }
    if (
      !Array.isArray(binding.gateResultIds) ||
      new Set(binding.gateResultIds).size !== binding.gateResultIds.length ||
      binding.gateResultIds.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      return `sandboxEvidenceHistory[${index}].gateResultIds is invalid`;
    }
    if (
      !Array.isArray(binding.stageAttemptIds) ||
      binding.stageAttemptIds.length === 0 ||
      new Set(binding.stageAttemptIds).size !== binding.stageAttemptIds.length ||
      binding.stageAttemptIds.some((id) => typeof id !== "string" || !stageIds.has(id))
    ) {
      return `sandboxEvidenceHistory[${index}].stageAttemptIds is invalid`;
    }
    for (const gateResultId of binding.gateResultIds) {
      if (boundGateIds.has(gateResultId)) {
        return `GateResultV2 ${gateResultId} is bound to multiple sandbox leases`;
      }
      const result = incomingResults.get(gateResultId);
      if (
        !result?.sandboxExecution ||
        sha256Canonical(result.sandboxExecution) !== sha256Canonical(binding.execution)
      ) {
        return `GateResultV2 ${gateResultId} is not bound to its historical sandbox runtime`;
      }
      boundGateIds.add(gateResultId);
    }
    const isCurrent =
      sha256Canonical(binding.attestation) === sha256Canonical(attestation) &&
      sha256Canonical(binding.execution) === sha256Canonical(execution);
    if (isCurrent) currentLeasePresent = true;
    if (index >= previousHistory.length && !isCurrent) {
      return "new sandbox evidence must be bound to the active claim";
    }
  }
  if (!currentLeasePresent) {
    return "active sandbox lease is missing from append-only evidence history";
  }
  for (const resultId of incomingResults.keys()) {
    if (!boundGateIds.has(resultId)) {
      return `GateResultV2 ${resultId} has no sandbox evidence history binding`;
    }
  }
  return undefined;
}

function validateExternalGovernedCheckpoint(
  existing: RunRecord | undefined,
  incoming: RunRecord,
  value: unknown,
  previous: GovernedRunState | undefined,
  terminal: boolean,
  serverApproval: ApprovalDecision | null | string | undefined = undefined
): GovernedRunState | string | undefined {
  const governed = Boolean(
    existing?.governanceSnapshot || existing?.harnessManifest
  );
  if (value === undefined) {
    return governed
      ? "external governed run updates require governedLoopState"
      : undefined;
  }
  if (!governed || !existing?.governanceSnapshot || !existing.harnessManifest) {
    return "classic run cannot report governedLoopState";
  }
  let state: GovernedRunState;
  try {
    state = validateGovernedRunStateAgainstHarness(
      value,
      existing.harnessManifest
    );
  } catch (error) {
    return error instanceof Error
      ? `Invalid governedLoopState: ${error.message}`
      : "Invalid governedLoopState";
  }
  if (state.runId !== incoming.id) {
    return "governedLoopState is bound to a different run";
  }
  if (typeof serverApproval === "string") return serverApproval;
  if (serverApproval === null && state.approval !== undefined) {
    return "governedLoopState approval was not issued by the server approval endpoint";
  }
  if (
    serverApproval !== undefined &&
    serverApproval !== null &&
    sha256Canonical(state.approval) !== sha256Canonical(serverApproval)
  ) {
    return "governedLoopState approval does not match the server-issued decision";
  }
  const boundSpec = existing.harnessManifest.specRef;
  if (
    state.bindings.governanceDigest !== existing.governanceSnapshot.digest ||
    state.bindings.harnessDigest !== existing.harnessManifest.digest ||
    state.bindings.specRef.specSetId !== boundSpec.specSetId ||
    state.bindings.specRef.revision !== boundSpec.revision ||
    state.bindings.specRef.digest !== boundSpec.digest
  ) {
    return "governedLoopState immutable bindings do not match queued run";
  }
  const allowedStatuses: Readonly<
    Record<GovernedRunState["status"], readonly RunRecord["status"][]>
  > = {
    running: ["preparing", "running", "verifying"],
    waiting_approval: ["waiting_approval"],
    completed: ["completed"],
    failed: ["failed"],
    needs_human: ["failed"],
    cancelled: ["cancelled"]
  };
  if (!allowedStatuses[state.status].includes(incoming.status)) {
    return `governedLoopState status ${state.status} conflicts with run status ${incoming.status}`;
  }
  if (terminal && !["completed", "failed", "needs_human", "cancelled"].includes(state.status)) {
    return "terminal run requires a terminal governedLoopState";
  }
  if (previous) {
    if (
      Date.parse(state.updatedAt) < Date.parse(previous.updatedAt) ||
      state.attempts.length < previous.attempts.length
    ) {
      return "governedLoopState cannot move its checkpoint backwards";
    }
    for (let index = 0; index < previous.attempts.length; index += 1) {
      const before = previous.attempts[index];
      const after = state.attempts[index];
      const completesIndeterminateAttempt =
        index === previous.attempts.length - 1 &&
        before?.status === "running" &&
        after !== undefined &&
        after.id === before.id &&
        after.runId === before.runId &&
        after.stage === before.stage &&
        after.attempt === before.attempt &&
        after.inputDigest === before.inputDigest &&
        after.startedAt === before.startedAt &&
        after.status !== "running";
      const completesApprovedAttempt =
        index === previous.attempts.length - 1 &&
        before?.stage === "approval_demo" &&
        before.status === "waiting_approval" &&
        after !== undefined &&
        state.approval?.decision === "approve" &&
        state.approval.runId === state.runId &&
        state.approval.stageAttemptId === before.id &&
        after.status === "completed" &&
        after.finishedAt === state.approval.decidedAt &&
        sha256Canonical(after) ===
          sha256Canonical({
            ...before,
            status: "completed",
            finishedAt: state.approval.decidedAt
          });
      const completesRejectedAttempt =
        index === previous.attempts.length - 1 &&
        before?.stage === "approval_demo" &&
        before.status === "waiting_approval" &&
        after !== undefined &&
        state.approval?.decision === "reject" &&
        state.approval.runId === state.runId &&
        state.approval.stageAttemptId === before.id &&
        after.status === "failed" &&
        after.failure?.kind === "approval_rejected" &&
        after.finishedAt === state.approval.decidedAt &&
        sha256Canonical(after) ===
          sha256Canonical({
            ...before,
            status: "failed",
            failure: after.failure,
            finishedAt: state.approval.decidedAt
          });
      if (
        !completesIndeterminateAttempt &&
        !completesApprovedAttempt &&
        !completesRejectedAttempt &&
        sha256Canonical(after) !== sha256Canonical(before)
      ) {
        return "governedLoopState cannot rewrite a persisted stage attempt";
      }
    }
  }
  const verificationAttempts = new Set(
    state.attempts
      .filter((attempt) => attempt.stage === "verification")
      .map((attempt) => attempt.id)
  );
  for (const binding of incoming.verificationEvidence ?? []) {
    if (!verificationAttempts.has(binding.stageAttemptId)) {
      return `verificationEvidence references unknown Loop attempt ${binding.stageAttemptId}`;
    }
  }
  if (!incoming.stages || incoming.stages.length !== state.attempts.length) {
    return "governed run stages must mirror governedLoopState attempts";
  }
  for (let index = 0; index < state.attempts.length; index += 1) {
    const stage = incoming.stages[index];
    const attempt = state.attempts[index];
    if (
      !stage ||
      !attempt ||
      stage.id !== attempt.id ||
      stage.stage !== attempt.stage ||
      stage.attempt !== attempt.attempt ||
      stage.status !== attempt.status ||
      stage.inputDigest !== attempt.inputDigest ||
      stage.outputDigest !== attempt.outputDigest ||
      stage.startedAt !== attempt.startedAt ||
      stage.finishedAt !== attempt.finishedAt ||
      sha256Canonical(stage.budgetUsage) !== sha256Canonical(attempt.budgetUsage)
    ) {
      return "governed run stages diverge from governedLoopState attempts";
    }
  }
  if (
    incoming.budgetUsage === undefined ||
    sha256Canonical(incoming.budgetUsage) !== sha256Canonical(state.budgetUsage)
  ) {
    return "governed run budgetUsage diverges from governedLoopState";
  }
  const resultsById = new Map(
    (incoming.gateResultsV2 ?? []).map((result) => [result.id, result])
  );
  const evidenceByAttempt = new Map(
    (incoming.verificationEvidence ?? []).map((binding) => [
      binding.stageAttemptId,
      binding.gateResultIds
        .map((id) => resultsById.get(id))
        .filter((result): result is GateResultV2 => Boolean(result))
    ])
  );
  const requiredGateIds = new Set(
    existing.harnessManifest.gatePlan.map((gate) => gate.id)
  );
  for (const attempt of state.attempts.filter(
    (candidate) => candidate.stage === "verification"
  )) {
    if (attempt.status === "running") continue;
    const results = evidenceByAttempt.get(attempt.id);
    if (!results) return `verification attempt ${attempt.id} has no evidence binding`;
    if (attempt.status === "completed") {
      const passed = new Set<string>();
      for (const result of results) {
        if (result.status !== "pass") {
          return `completed verification attempt ${attempt.id} contains non-pass evidence`;
        }
        passed.add(result.gateId);
      }
      const missing = [...requiredGateIds].filter((gateId) => !passed.has(gateId));
      if (missing.length > 0) {
        return `completed verification attempt ${attempt.id} is missing required gates: ${missing.join(", ")}`;
      }
    } else if (
      attempt.status === "failed" &&
      results.length > 0 &&
      results.every((result) => result.status === "pass")
    ) {
      return `failed verification attempt ${attempt.id} has no failing GateResultV2`;
    }
  }
  return state;
}

function approvalDecisionFromClaimPayload(
  payload: Readonly<Record<string, unknown>>
): ApprovalDecision | null | string {
  if (!Object.hasOwn(payload, "approvalDecision")) return null;
  const raw = payload.approvalDecision;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "enterprise approvalDecision payload is malformed";
  }
  const record = raw as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (
    fields.length !== 6 ||
    fields[0] !== "actorId" ||
    fields[1] !== "decidedAt" ||
    fields[2] !== "decision" ||
    fields[3] !== "digest" ||
    fields[4] !== "runId" ||
    fields[5] !== "stageAttemptId" ||
    typeof record.runId !== "string" ||
    typeof record.stageAttemptId !== "string" ||
    (record.decision !== "approve" && record.decision !== "reject") ||
    typeof record.actorId !== "string" ||
    typeof record.decidedAt !== "string" ||
    typeof record.digest !== "string"
  ) {
    return "enterprise approvalDecision payload is malformed";
  }
  try {
    const decision = createApprovalDecision({
      runId: record.runId,
      stageAttemptId: record.stageAttemptId,
      decision: record.decision,
      actorId: record.actorId,
      decidedAt: record.decidedAt
    });
    return decision.digest === record.digest
      ? decision
      : "enterprise approvalDecision digest is invalid";
  } catch {
    return "enterprise approvalDecision payload is malformed";
  }
}

function normalizeExternalGateEvidence(
  incoming: RunRecord,
  terminal: boolean
): RunRecord | string {
  const rawResults = (incoming as unknown as Record<string, unknown>).gateResultsV2;
  if (rawResults === undefined) return incoming;
  if (!Array.isArray(rawResults)) return "run gateResultsV2 must be an array";
  let gateResults;
  try {
    gateResults = rawResults.map((result) => parseGateResultV2(result));
  } catch (error) {
    return error instanceof Error ? error.message : "invalid GateResultV2 evidence";
  }
  const ids = new Set<string>();
  const candidateIds = new Set(incoming.candidates.map((candidate) => candidate.id));
  const manifestGates = new Map(
    incoming.harnessManifest?.gatePlan.map((gate) => [gate.id, gate]) ?? []
  );
  for (const result of gateResults) {
    if (ids.has(result.id)) return `duplicate GateResultV2 id ${result.id}`;
    ids.add(result.id);
    if (result.runId !== incoming.id) {
      return `GateResultV2 ${result.id} is bound to a different run`;
    }
    if (!candidateIds.has(result.candidateId)) {
      return `GateResultV2 ${result.id} is bound to an unknown candidate`;
    }
    if (incoming.harnessManifest) {
      const planned = manifestGates.get(result.gateId);
      if (!result.required || !planned) {
        return `GateResultV2 ${result.id} is not a required Harness gate`;
      }
      if (
        result.runnerId !== planned.runnerId ||
        result.runnerVersion !== planned.runnerVersion
      ) {
        return `GateResultV2 ${result.id} runner identity does not match the immutable Harness plan`;
      }
    }
  }

  const rawBindings = (incoming as unknown as Record<string, unknown>)
    .verificationEvidence;
  if (rawBindings === undefined) {
    if (gateResults.length > 0 && terminal) {
      return "terminal governed evidence requires verificationEvidence bindings";
    }
    return { ...incoming, gateResultsV2: gateResults };
  }
  if (!Array.isArray(rawBindings)) {
    return "run verificationEvidence must be an array";
  }
  const stageAttemptIds = new Set<string>();
  const referenced = new Set<string>();
  const bindings: NonNullable<RunRecord["verificationEvidence"]> = [];
  for (const [index, raw] of rawBindings.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return `verificationEvidence[${index}] must be an object`;
    }
    const record = raw as Record<string, unknown>;
    const fields = Object.keys(record).sort();
    if (
      fields.length !== 2 ||
      fields[0] !== "gateResultIds" ||
      fields[1] !== "stageAttemptId"
    ) {
      return `verificationEvidence[${index}] contains unsupported fields`;
    }
    const attemptPrefix = `${incoming.id}:verification:`;
    const attemptSuffix = typeof record.stageAttemptId === "string"
      ? record.stageAttemptId.slice(attemptPrefix.length)
      : "";
    if (
      typeof record.stageAttemptId !== "string" ||
      !record.stageAttemptId.startsWith(attemptPrefix) ||
      !/^[1-9]\d*$/u.test(attemptSuffix) ||
      stageAttemptIds.has(record.stageAttemptId)
    ) {
      return `verificationEvidence[${index}].stageAttemptId is invalid or duplicated`;
    }
    if (
      !Array.isArray(record.gateResultIds) ||
      record.gateResultIds.some((id) => typeof id !== "string") ||
      new Set(record.gateResultIds).size !== record.gateResultIds.length
    ) {
      return `verificationEvidence[${index}].gateResultIds is invalid`;
    }
    for (const id of record.gateResultIds as string[]) {
      if (!ids.has(id) || referenced.has(id)) {
        return `verificationEvidence[${index}] references unknown or duplicate GateResultV2 ${id}`;
      }
      referenced.add(id);
    }
    stageAttemptIds.add(record.stageAttemptId);
    bindings.push({
      stageAttemptId: record.stageAttemptId,
      gateResultIds: [...record.gateResultIds] as string[]
    });
  }
  if (terminal && referenced.size !== gateResults.length) {
    return "terminal verificationEvidence must bind every GateResultV2 exactly once";
  }
  return {
    ...incoming,
    gateResultsV2: gateResults,
    verificationEvidence: bindings
  };
}

function mcpSecretValue(secretRef: ProviderSecretRef): string {
  if (secretRef.type === "local_encrypted") {
    return `${mcpLocalSecretPrefix}${secretRef.ref}`;
  }
  if (secretRef.type === "keychain") {
    return `${mcpKeychainSecretPrefix}${secretRef.ref}`;
  }
  if (secretRef.type !== "env") {
    throw new Error(`Unsupported MCP secret ref type: ${secretRef.type}`);
  }
  throw new Error("MCP env secrets cannot be stored as env refs.");
}

function isCheckpointRunAutoResumable(run: RunRecord, task: AgentTask): boolean {
  if (
    run.status !== "preparing" &&
    run.status !== "running" &&
    run.status !== "verifying"
  ) {
    return false;
  }
  if (run.candidates.length === 0) return false;

  const expectedProviders = selectRunRuntimes(task);
  if (run.candidates.length > expectedProviders.length) return false;

  return run.candidates.every((candidate, index) => {
    const expectedProvider = expectedProviders[index];
    const isCompletedCheckpoint =
      candidate.status === "completed" && Boolean(candidate.result);
    const isQueuedCheckpoint =
      candidate.status === "queued" && !candidate.result;
    return (
      Boolean(expectedProvider) &&
      candidate.id === `${expectedProvider}-${index + 1}` &&
      candidate.provider === expectedProvider &&
      (isCompletedCheckpoint || isQueuedCheckpoint)
    );
  });
}

function selectRunRuntimes(task: AgentTask) {
  return executionTargets(task.strategy).flatMap((target) =>
    Array.from({ length: target.candidates }, () => target.runtimeId)
  );
}

function isMcpLocalSecretRef(value: string): boolean {
  return parseMcpSecretRef(value) !== undefined;
}

function parseMcpSecretRef(value: string):
  | { type: "local_encrypted" | "keychain"; ref: string }
  | undefined {
  if (value.startsWith(mcpLocalSecretPrefix)) {
    return { type: "local_encrypted", ref: value.slice(mcpLocalSecretPrefix.length) };
  }
  if (value.startsWith(mcpKeychainSecretPrefix)) {
    return { type: "keychain", ref: value.slice(mcpKeychainSecretPrefix.length) };
  }
  return undefined;
}

type ProviderCreateBody = z.infer<typeof providerCreateSchema>;
type ProviderImportItem = z.infer<typeof providerImportItemSchema>;
type ProviderImportStatus = "would_import" | "imported" | "skipped";
type McpImportItem = z.infer<typeof mcpServerCreateSchema>;
type PromptImportItem = z.infer<typeof promptPresetCreateSchema>;
type DeepLinkKind = "providers" | "mcp_servers" | "prompts";

interface ProviderImportRow {
  index: number;
  app: ProviderImportItem["app"];
  name: string;
  status: ProviderImportStatus;
  providerId?: string;
  reason?: string;
}

interface DeepLinkImportRow {
  index: number;
  name: string;
  status: ProviderImportStatus;
  itemId?: string;
  reason?: string;
}

interface ParsedMniuImportDeepLink {
  scheme: "muniu" | "mniu";
  action: "import";
  kind: DeepLinkKind;
  payload: unknown;
}

function buildProviderCreateInput(
  body: ProviderCreateBody,
  apiKeyRef: ProviderCreateInput["apiKeyRef"]
): ProviderCreateInput {
  if (body.presetId) {
    return createProviderInputFromPreset(body.presetId, {
      app: body.app,
      name: body.name,
      kind: body.kind,
      apiFormat: body.apiFormat,
      baseUrl: body.baseUrl,
      defaultModel: body.defaultModel,
      modelReasoningEffort: body.modelReasoningEffort,
      disableResponseStorage: body.disableResponseStorage,
      wireApi: body.wireApi,
      modelCatalog: body.modelCatalog,
      enterpriseCapabilities: body.enterpriseCapabilities,
      config: body.config,
      apiKeyRef,
      enabled: body.enabled,
      sortOrder: body.sortOrder
    });
  }

  if (!body.app || !body.name || !body.kind || !body.apiFormat || !body.baseUrl || !body.defaultModel) {
    throw new Error(
      "Custom providers require app, name, kind, apiFormat, baseUrl and defaultModel."
    );
  }

  return {
    app: normalizeProviderApp(body.app),
    name: body.name,
    kind: body.kind,
    apiFormat: body.apiFormat,
    baseUrl: body.baseUrl,
    defaultModel: body.defaultModel,
    modelReasoningEffort: body.modelReasoningEffort,
    disableResponseStorage: body.disableResponseStorage,
    wireApi: body.wireApi,
    apiKeyRef,
    modelCatalog: body.modelCatalog ?? [{ id: body.defaultModel, displayName: body.defaultModel }],
    enterpriseCapabilities: body.enterpriseCapabilities,
    config: body.config ?? {},
    enabled: body.enabled,
    sortOrder: body.sortOrder
  };
}

function providerHealthPolicy(provider?: ProviderRecord): {
  failureThreshold: number;
  circuitOpenMs: number;
} {
  const healthPolicy = provider?.config.healthPolicy;
  if (!healthPolicy || typeof healthPolicy !== "object" || Array.isArray(healthPolicy)) {
    return {
      failureThreshold: defaultProxyCircuitFailureThreshold,
      circuitOpenMs: defaultProxyCircuitOpenMs
    };
  }
  const policy = healthPolicy as Record<string, unknown>;
  return {
    failureThreshold: readPositiveIntegerConfig(
      policy.failureThreshold,
      defaultProxyCircuitFailureThreshold
    ),
    circuitOpenMs: readPositiveIntegerConfig(policy.circuitOpenMs, defaultProxyCircuitOpenMs)
  };
}

function readPositiveIntegerConfig(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function providerToExportItem(provider: ProviderRecord): Record<string, unknown> {
  const apiKeyEnv = provider.apiKeyRef?.type === "env" ? provider.apiKeyRef.ref : undefined;
  return {
    app: provider.app,
    name: provider.name,
    kind: provider.kind,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    ...(provider.modelReasoningEffort ? { modelReasoningEffort: provider.modelReasoningEffort } : {}),
    ...(provider.disableResponseStorage !== undefined
      ? { disableResponseStorage: provider.disableResponseStorage }
      : {}),
    ...(provider.wireApi ? { wireApi: provider.wireApi } : {}),
    ...(provider.enterpriseCapabilities
      ? { enterpriseCapabilities: provider.enterpriseCapabilities }
      : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(provider.apiKeyRef && !apiKeyEnv ? { secretOmitted: true } : {}),
    modelCatalog: provider.modelCatalog,
    config: provider.config,
    enabled: provider.enabled,
    sortOrder: provider.sortOrder
  };
}

async function importProviders(
  providers: ProviderImportItem[],
  options: {
    dryRun: boolean;
    existingProviders: ProviderRecord[];
    createProvider: (input: ProviderCreateInput) => Promise<ProviderRecord>;
  }
): Promise<{
  dryRun: boolean;
  importedCount: number;
  wouldImportCount: number;
  skippedCount: number;
  results: ProviderImportRow[];
}> {
  const seenKeys = new Set(options.existingProviders.map(providerImportKey));
  const results: ProviderImportRow[] = [];
  let importedCount = 0;
  let wouldImportCount = 0;
  let skippedCount = 0;

  for (const [index, provider] of providers.entries()) {
    const key = providerImportKey(provider);
    if (seenKeys.has(key)) {
      skippedCount += 1;
      results.push({
        index,
        app: provider.app,
        name: provider.name,
        status: "skipped",
        reason: "duplicate_provider"
      });
      continue;
    }

    seenKeys.add(key);
    if (options.dryRun) {
      wouldImportCount += 1;
      results.push({
        index,
        app: provider.app,
        name: provider.name,
        status: "would_import"
      });
      continue;
    }

    const created = await options.createProvider(importedProviderInput(provider));
    importedCount += 1;
    results.push({
      index,
      app: provider.app,
      name: provider.name,
      status: "imported",
      providerId: created.id
    });
  }

  return {
    dryRun: options.dryRun,
    importedCount,
    wouldImportCount,
    skippedCount,
    results
  };
}

function importedProviderInput(provider: ProviderImportItem): ProviderCreateInput {
  const apiKeyEnv = provider.apiKeyEnv ?? provider.apiKeyRef?.ref;
  return {
    app: normalizeProviderApp(provider.app),
    name: provider.name.trim(),
    kind: provider.kind,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl.trim(),
    defaultModel: provider.defaultModel.trim(),
    modelReasoningEffort: provider.modelReasoningEffort,
    disableResponseStorage: provider.disableResponseStorage,
    wireApi: provider.wireApi,
    apiKeyRef: apiKeyEnv
      ? {
          type: "env",
          ref: apiKeyEnv,
          maskedValue: process.env[apiKeyEnv] ? maskSecret(process.env[apiKeyEnv]) : undefined
        }
      : undefined,
    modelCatalog: provider.modelCatalog ?? [
      { id: provider.defaultModel.trim(), displayName: provider.defaultModel.trim() }
    ],
    enterpriseCapabilities: provider.enterpriseCapabilities,
    config: provider.config ?? {},
    enabled: false,
    sortOrder: provider.sortOrder
  };
}

type ProviderModelCatalogSyncMode = "replace" | "merge";
type ProviderModelCatalogAuditStatus = "never_synced" | "fresh" | "stale" | "changed";
type ProviderModelCatalogSyncSource =
  | { type: "inline" }
  | { type: "url"; url: string };

interface ProviderModelCatalogSyncPreview {
  modelCatalog: ProviderModel[];
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  unchangedCount: number;
}

interface ProviderModelCatalogSyncMetadata {
  source: ProviderModelCatalogSyncSource;
  mode: ProviderModelCatalogSyncMode;
  syncedAt: string;
  modelsHash: string;
  modelCount: number;
  maxAgeDays: number;
}

interface ProviderModelCatalogSyncPolicy {
  sourceUrl: string;
  mode: ProviderModelCatalogSyncMode;
  maxAgeDays: number;
  refreshIntervalHours: number;
  updatedAt: string;
}

type ProviderModelCatalogSyncDueStatus = "skipped" | "would_sync" | "synced" | "failed";

interface ProviderModelCatalogSyncDueRow {
  providerId: string;
  providerName: string;
  status: ProviderModelCatalogSyncDueStatus;
  reason: string;
  nextSyncAt?: string;
  policy: ProviderModelCatalogSyncPolicy;
  audit: ReturnType<typeof buildProviderModelCatalogAudit>;
  sync?: {
    currentCount: number;
    incomingCount: number;
    finalCount: number;
    addedCount: number;
    updatedCount: number;
    removedCount: number;
    unchangedCount: number;
    syncMetadata: ProviderModelCatalogSyncMetadata;
  };
  error?: string;
}

const providerModelCatalogFetchTimeoutMs = 10_000;
const providerModelCatalogMaxBytes = 1024 * 1024;
const providerModelCatalogDefaultMaxAgeDays = 30;
const providerModelCatalogDefaultRefreshIntervalHours = 24;

function providerModelsFromCatalogDocument(input: unknown): ProviderModel[] {
  const parsed = providerModelCatalogDocumentSchema.parse(input);
  return Array.isArray(parsed) ? parsed : parsed.models;
}

async function providerModelsFromCatalogUrl(sourceUrl: string): Promise<ProviderModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerModelCatalogFetchTimeoutMs);
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`catalog fetch failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > providerModelCatalogMaxBytes) {
      throw new Error("catalog response is too large");
    }
    return providerModelsFromCatalogDocument(JSON.parse(text));
  } finally {
    clearTimeout(timeout);
  }
}

function buildProviderModelCatalogSyncMetadata(
  modelCatalog: ProviderModel[],
  input: {
    source: ProviderModelCatalogSyncSource;
    mode: ProviderModelCatalogSyncMode;
    syncedAt: string;
    maxAgeDays: number;
  }
): ProviderModelCatalogSyncMetadata {
  return {
    source: input.source,
    mode: input.mode,
    syncedAt: input.syncedAt,
    modelsHash: providerModelCatalogHash(modelCatalog),
    modelCount: modelCatalog.length,
    maxAgeDays: input.maxAgeDays
  };
}

function buildProviderModelCatalogAudit(
  provider: Pick<ProviderRecord, "id" | "modelCatalog" | "config">,
  requestedMaxAgeDays?: number
): {
  providerId: string;
  status: ProviderModelCatalogAuditStatus;
  stale: boolean;
  currentCount: number;
  modelCount: number | null;
  syncedAt: string | null;
  ageDays: number | null;
  maxAgeDays: number;
  source: ProviderModelCatalogSyncSource | null;
  mode: ProviderModelCatalogSyncMode | null;
  modelsHash: string | null;
  currentModelsHash: string;
  hashMatches: boolean;
} {
  const metadata = readProviderModelCatalogSyncMetadata(provider.config.modelCatalogSync);
  const maxAgeDays =
    requestedMaxAgeDays ??
    metadata?.maxAgeDays ??
    providerModelCatalogDefaultMaxAgeDays;
  const currentModelsHash = providerModelCatalogHash(provider.modelCatalog);

  if (!metadata) {
    return {
      providerId: provider.id,
      status: "never_synced",
      stale: true,
      currentCount: provider.modelCatalog.length,
      modelCount: null,
      syncedAt: null,
      ageDays: null,
      maxAgeDays,
      source: null,
      mode: null,
      modelsHash: null,
      currentModelsHash,
      hashMatches: false
    };
  }

  const syncedAtMs = Date.parse(metadata.syncedAt);
  const ageDays = Number.isFinite(syncedAtMs)
    ? Math.max(0, (Date.now() - syncedAtMs) / 86_400_000)
    : Number.POSITIVE_INFINITY;
  const hashMatches = metadata.modelsHash === currentModelsHash;
  const status: ProviderModelCatalogAuditStatus = !hashMatches
    ? "changed"
    : ageDays > maxAgeDays
      ? "stale"
      : "fresh";

  return {
    providerId: provider.id,
    status,
    stale: status !== "fresh",
    currentCount: provider.modelCatalog.length,
    modelCount: metadata.modelCount,
    syncedAt: metadata.syncedAt,
    ageDays: Number.isFinite(ageDays) ? Number(ageDays.toFixed(3)) : null,
    maxAgeDays,
    source: metadata.source,
    mode: metadata.mode,
    modelsHash: metadata.modelsHash,
    currentModelsHash,
    hashMatches
  };
}

function readProviderModelCatalogSyncMetadata(
  value: unknown
): ProviderModelCatalogSyncMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  const source = readProviderModelCatalogSyncSource(metadata.source);
  if (!source) return null;
  if (metadata.mode !== "replace" && metadata.mode !== "merge") return null;
  if (typeof metadata.syncedAt !== "string" || Number.isNaN(Date.parse(metadata.syncedAt))) {
    return null;
  }
  if (
    typeof metadata.modelsHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.modelsHash)
  ) {
    return null;
  }
  if (
    typeof metadata.modelCount !== "number" ||
    !Number.isInteger(metadata.modelCount) ||
    metadata.modelCount < 0
  ) {
    return null;
  }
  if (
    typeof metadata.maxAgeDays !== "number" ||
    !Number.isInteger(metadata.maxAgeDays) ||
    metadata.maxAgeDays <= 0
  ) {
    return null;
  }
  return {
    source,
    mode: metadata.mode,
    syncedAt: metadata.syncedAt,
    modelsHash: metadata.modelsHash,
    modelCount: metadata.modelCount,
    maxAgeDays: metadata.maxAgeDays
  };
}

function readProviderModelCatalogSyncSource(
  value: unknown
): ProviderModelCatalogSyncSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.type === "inline") return { type: "inline" };
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "url", url: source.url };
  }
  return null;
}

function buildProviderModelCatalogSyncPolicy(input: {
  sourceUrl: string;
  mode: ProviderModelCatalogSyncMode;
  maxAgeDays: number;
  refreshIntervalHours?: number;
  updatedAt: string;
}): ProviderModelCatalogSyncPolicy {
  return {
    sourceUrl: input.sourceUrl,
    mode: input.mode,
    maxAgeDays: input.maxAgeDays,
    refreshIntervalHours:
      input.refreshIntervalHours ?? providerModelCatalogDefaultRefreshIntervalHours,
    updatedAt: input.updatedAt
  };
}

function readProviderModelCatalogSyncPolicy(
  value: unknown
): ProviderModelCatalogSyncPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (typeof policy.sourceUrl !== "string") return null;
  try {
    new URL(policy.sourceUrl);
  } catch {
    return null;
  }
  if (policy.mode !== "replace" && policy.mode !== "merge") return null;
  if (
    typeof policy.maxAgeDays !== "number" ||
    !Number.isInteger(policy.maxAgeDays) ||
    policy.maxAgeDays <= 0
  ) {
    return null;
  }
  if (
    typeof policy.refreshIntervalHours !== "number" ||
    !Number.isInteger(policy.refreshIntervalHours) ||
    policy.refreshIntervalHours <= 0
  ) {
    return null;
  }
  if (typeof policy.updatedAt !== "string" || Number.isNaN(Date.parse(policy.updatedAt))) {
    return null;
  }
  return {
    sourceUrl: policy.sourceUrl,
    mode: policy.mode,
    maxAgeDays: policy.maxAgeDays,
    refreshIntervalHours: policy.refreshIntervalHours,
    updatedAt: policy.updatedAt
  };
}

function providerModelCatalogSyncDueState(
  provider: Pick<ProviderRecord, "modelCatalog" | "config">,
  policy: ProviderModelCatalogSyncPolicy,
  now = new Date()
): { due: boolean; reason: string; nextSyncAt?: string } {
  const metadata = readProviderModelCatalogSyncMetadata(provider.config.modelCatalogSync);
  if (!metadata) {
    return { due: true, reason: "never_synced" };
  }

  const audit = buildProviderModelCatalogAudit(
    { id: "audit", modelCatalog: provider.modelCatalog, config: provider.config },
    policy.maxAgeDays
  );
  if (audit.status === "changed") {
    return { due: true, reason: "catalog_changed" };
  }
  if (audit.status === "stale") {
    return { due: true, reason: "stale" };
  }

  const syncedAtMs = Date.parse(metadata.syncedAt);
  if (!Number.isFinite(syncedAtMs)) {
    return { due: true, reason: "invalid_synced_at" };
  }
  const nextSyncAt = new Date(
    syncedAtMs + policy.refreshIntervalHours * 3_600_000
  ).toISOString();
  if (Date.parse(nextSyncAt) <= now.getTime()) {
    return { due: true, reason: "interval_elapsed", nextSyncAt };
  }
  return { due: false, reason: "not_due", nextSyncAt };
}

function providerModelCatalogHash(modelCatalog: ProviderModel[]): string {
  return createHash("sha256")
    .update(JSON.stringify(modelCatalog.map(providerModelHashPayload)))
    .digest("hex");
}

function providerModelHashPayload(model: ProviderModel): Record<string, unknown> {
  return {
    id: model.id,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    inputTokenUsdPerMillion: model.inputTokenUsdPerMillion,
    outputTokenUsdPerMillion: model.outputTokenUsdPerMillion,
    cachedInputTokenUsdPerMillion: model.cachedInputTokenUsdPerMillion,
    cacheCreationInputTokenUsdPerMillion: model.cacheCreationInputTokenUsdPerMillion,
    cacheReadInputTokenUsdPerMillion: model.cacheReadInputTokenUsdPerMillion,
    reasoningOutputTokenUsdPerMillion: model.reasoningOutputTokenUsdPerMillion
  };
}

function buildProviderModelCatalogSync(
  provider: Pick<ProviderRecord, "modelCatalog">,
  incomingModels: ProviderModel[],
  mode: ProviderModelCatalogSyncMode
): ProviderModelCatalogSyncPreview {
  const currentById = new Map(provider.modelCatalog.map((model) => [model.id, model]));
  const incomingById = new Map(incomingModels.map((model) => [model.id, model]));
  let addedCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let removedCount = 0;

  for (const incoming of incomingModels) {
    const current = currentById.get(incoming.id);
    if (!current) {
      addedCount += 1;
      continue;
    }
    if (providerModelCompareKey(current) === providerModelCompareKey(incoming)) {
      unchangedCount += 1;
    } else {
      updatedCount += 1;
    }
  }

  if (mode === "replace") {
    for (const current of provider.modelCatalog) {
      if (!incomingById.has(current.id)) removedCount += 1;
    }
    return {
      modelCatalog: incomingModels,
      addedCount,
      updatedCount,
      removedCount,
      unchangedCount
    };
  }

  const modelCatalog = provider.modelCatalog.map((current) =>
    incomingById.get(current.id) ?? current
  );
  for (const incoming of incomingModels) {
    if (!currentById.has(incoming.id)) modelCatalog.push(incoming);
  }
  return {
    modelCatalog,
    addedCount,
    updatedCount,
    removedCount: 0,
    unchangedCount
  };
}

function providerModelCompareKey(model: ProviderModel): string {
  return JSON.stringify({
    id: model.id,
    displayName: model.displayName,
    contextWindow: model.contextWindow,
    inputTokenUsdPerMillion: model.inputTokenUsdPerMillion,
    outputTokenUsdPerMillion: model.outputTokenUsdPerMillion,
    cachedInputTokenUsdPerMillion: model.cachedInputTokenUsdPerMillion,
    cacheCreationInputTokenUsdPerMillion: model.cacheCreationInputTokenUsdPerMillion,
    cacheReadInputTokenUsdPerMillion: model.cacheReadInputTokenUsdPerMillion,
    reasoningOutputTokenUsdPerMillion: model.reasoningOutputTokenUsdPerMillion
  });
}

async function importMcpServers(
  servers: McpImportItem[],
  options: {
    dryRun: boolean;
    existingServers: Array<{ name: string; command: string; args: string[]; apps: string[] }>;
    createServer: (input: McpImportItem) => Promise<{ id: string }>;
  }
): Promise<{
  dryRun: boolean;
  importedCount: number;
  wouldImportCount: number;
  skippedCount: number;
  results: DeepLinkImportRow[];
}> {
  const seenKeys = new Set(options.existingServers.map(mcpImportKey));
  const results: DeepLinkImportRow[] = [];
  let importedCount = 0;
  let wouldImportCount = 0;
  let skippedCount = 0;

  for (const [index, server] of servers.entries()) {
    const key = mcpImportKey(server);
    if (seenKeys.has(key)) {
      skippedCount += 1;
      results.push({
        index,
        name: server.name,
        status: "skipped",
        reason: "duplicate_mcp_server"
      });
      continue;
    }

    seenKeys.add(key);
    if (options.dryRun) {
      wouldImportCount += 1;
      results.push({
        index,
        name: server.name,
        status: "would_import"
      });
      continue;
    }

    const created = await options.createServer(server);
    importedCount += 1;
    results.push({
      index,
      name: server.name,
      status: "imported",
      itemId: created.id
    });
  }

  return {
    dryRun: options.dryRun,
    importedCount,
    wouldImportCount,
    skippedCount,
    results
  };
}

async function importPromptPresets(
  prompts: PromptImportItem[],
  options: {
    dryRun: boolean;
    existingPrompts: Array<{ name: string; apps: string[] }>;
    createPrompt: (input: PromptImportItem) => Promise<{ id: string }>;
  }
): Promise<{
  dryRun: boolean;
  importedCount: number;
  wouldImportCount: number;
  skippedCount: number;
  results: DeepLinkImportRow[];
}> {
  const seenKeys = new Set(options.existingPrompts.map(promptImportKey));
  const results: DeepLinkImportRow[] = [];
  let importedCount = 0;
  let wouldImportCount = 0;
  let skippedCount = 0;

  for (const [index, prompt] of prompts.entries()) {
    const key = promptImportKey(prompt);
    if (seenKeys.has(key)) {
      skippedCount += 1;
      results.push({
        index,
        name: prompt.name,
        status: "skipped",
        reason: "duplicate_prompt"
      });
      continue;
    }

    seenKeys.add(key);
    if (options.dryRun) {
      wouldImportCount += 1;
      results.push({
        index,
        name: prompt.name,
        status: "would_import"
      });
      continue;
    }

    const created = await options.createPrompt(prompt);
    importedCount += 1;
    results.push({
      index,
      name: prompt.name,
      status: "imported",
      itemId: created.id
    });
  }

  return {
    dryRun: options.dryRun,
    importedCount,
    wouldImportCount,
    skippedCount,
    results
  };
}

function parseMniuImportDeepLink(rawUrl: string): ParsedMniuImportDeepLink {
  const url = new URL(rawUrl);
  if (url.protocol !== "muniu:" && url.protocol !== "mniu:") {
    throw new Error("Only muniu:// deep links (or the legacy mniu:// alias) are supported.");
  }

  const segments = [url.hostname, ...url.pathname.split("/").filter(Boolean)];
  const action = segments[0];
  if (action !== "import") {
    throw new Error("Only muniu://import deep links are supported.");
  }

  const kind = normalizeDeepLinkKind(
    url.searchParams.get("kind") ?? url.searchParams.get("type") ?? segments[1]
  );
  if (!kind) {
    throw new Error("Only provider, MCP and prompt import deep links are supported.");
  }

  return {
    scheme: url.protocol === "muniu:" ? "muniu" : "mniu",
    action: "import",
    kind,
    payload: decodeDeepLinkPayload(url)
  };
}

function normalizeDeepLinkKind(value: string | null | undefined): DeepLinkKind | undefined {
  if (value === "provider" || value === "providers") return "providers";
  if (
    value === "mcp" ||
    value === "mcp_server" ||
    value === "mcp_servers" ||
    value === "mcp-server" ||
    value === "mcp-servers"
  ) {
    return "mcp_servers";
  }
  if (
    value === "prompt" ||
    value === "prompts" ||
    value === "prompt_preset" ||
    value === "prompt_presets" ||
    value === "prompt-preset" ||
    value === "prompt-presets"
  ) {
    return "prompts";
  }
  return undefined;
}

function decodeDeepLinkPayload(url: URL): unknown {
  const json = url.searchParams.get("json");
  if (json) return JSON.parse(json);

  const encoded = url.searchParams.get("payload") ?? url.searchParams.get("data");
  if (!encoded) {
    throw new Error("Deep link import requires payload, data or json.");
  }

  const trimmed = encoded.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const raw = Buffer.from(`${normalized}${"=".repeat(padding)}`, "base64").toString("utf8");
  return JSON.parse(raw);
}

function providerImportItemsFromDeepLinkPayload(payload: unknown): ProviderImportItem[] {
  const normalized = normalizeDeepLinkProviderPayload(payload);
  return providerImportSchema.parse({
    ...(normalized as Record<string, unknown>),
    dryRun: true
  }).providers;
}

function mcpImportItemsFromDeepLinkPayload(payload: unknown): McpImportItem[] {
  const normalized = normalizeDeepLinkMcpPayload(payload);
  return mcpDeepLinkImportSchema.parse(normalized).mcpServers;
}

function promptImportItemsFromDeepLinkPayload(payload: unknown): PromptImportItem[] {
  const normalized = normalizeDeepLinkPromptPayload(payload);
  return promptDeepLinkImportSchema.parse(normalized).prompts;
}

function normalizeDeepLinkProviderPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return { providers: payload };
  if (isUnknownRecord(payload)) {
    if (Array.isArray(payload.providers)) return payload;
    if (payload.provider !== undefined) return { providers: [payload.provider] };
    if (typeof payload.app === "string" && typeof payload.name === "string") {
      return { providers: [payload] };
    }
  }
  return payload;
}

function normalizeDeepLinkMcpPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return { mcpServers: payload };
  if (isUnknownRecord(payload)) {
    if (Array.isArray(payload.mcpServers)) return payload;
    if (Array.isArray(payload.servers)) return { mcpServers: payload.servers };
    if (payload.mcpServer !== undefined) return { mcpServers: [payload.mcpServer] };
    if (payload.server !== undefined) return { mcpServers: [payload.server] };
    if (typeof payload.name === "string" && typeof payload.command === "string") {
      return { mcpServers: [payload] };
    }
  }
  return payload;
}

function normalizeDeepLinkPromptPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return { prompts: payload };
  if (isUnknownRecord(payload)) {
    if (Array.isArray(payload.prompts)) return payload;
    if (Array.isArray(payload.promptPresets)) return { prompts: payload.promptPresets };
    if (payload.prompt !== undefined) return { prompts: [payload.prompt] };
    if (payload.promptPreset !== undefined) return { prompts: [payload.promptPreset] };
    if (typeof payload.name === "string" && typeof payload.content === "string") {
      return { prompts: [payload] };
    }
  }
  return payload;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerImportKey(provider: {
  app: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
}): string {
  return [
    provider.app,
    provider.name.trim().toLowerCase(),
    provider.baseUrl.trim().replace(/\/+$/, ""),
    provider.defaultModel.trim()
  ].join("\u0000");
}

function mcpImportKey(server: {
  name: string;
  command: string;
  args: string[];
  apps: string[];
}): string {
  return [
    server.name.trim().toLowerCase(),
    server.command.trim(),
    server.args.join("\u0001"),
    [...server.apps].sort().join("\u0001")
  ].join("\u0000");
}

function promptImportKey(prompt: { name: string; apps: string[] }): string {
  return [
    prompt.name.trim().toLowerCase(),
    [...prompt.apps].sort().join("\u0001")
  ].join("\u0000");
}

function resolveProviderAppTarget(
  providerApp: string,
  requested?: ManagedAgentApp
): ManagedAgentApp {
  if (requested) return requested;
  if (providerApp === "claude" || providerApp === "codex") return providerApp;
  throw new Error("Unified providers require an explicit app when enabling.");
}

function isCircuitOpen(health?: ProviderHealthRecord): boolean {
  return Boolean(
    health?.state === "circuit_open" &&
    health.circuitOpenUntil &&
    Date.parse(health.circuitOpenUntil) > Date.now()
  );
}

interface ProviderEndpointProbeOptions {
  token?: string;
  timeoutMs: number;
}

interface ProviderEndpointProbeResult {
  ok: boolean;
  mode: "live_http_probe";
  apiFormat: ProviderRecord["apiFormat"];
  baseUrl: string;
  targetUrl: string;
  model: string;
  checkedAt: string;
  latencyMs: number;
  retryable: boolean;
  statusCode?: number;
  error?: string;
}

async function probeProviderEndpoint(
  provider: ProviderRecord,
  options: ProviderEndpointProbeOptions
): Promise<ProviderEndpointProbeResult> {
  const checkedAt = new Date().toISOString();
  const targetUrl = joinProviderUrl(provider.baseUrl, providerProbePath(provider));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: providerProbeHeaders(provider, options.token),
      body: JSON.stringify(providerProbeBody(provider)),
      signal: controller.signal
    });
    await response.arrayBuffer();
    const latencyMs = Date.now() - startedAt;
    return {
      ok: response.ok,
      mode: "live_http_probe",
      apiFormat: provider.apiFormat,
      baseUrl: new URL(provider.baseUrl).toString(),
      targetUrl,
      model: provider.defaultModel,
      checkedAt,
      latencyMs,
      retryable: isRetryableProbeStatus(response.status),
      statusCode: response.status,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` })
    };
  } catch (error) {
    return {
      ok: false,
      mode: "live_http_probe",
      apiFormat: provider.apiFormat,
      baseUrl: new URL(provider.baseUrl).toString(),
      targetUrl,
      model: provider.defaultModel,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      retryable: true,
      error: summarizeProbeError(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function providerProbePath(provider: ProviderRecord): string {
  if (provider.apiFormat === "anthropic_messages") return "/v1/messages";
  if (provider.apiFormat === "openai_responses") return "/v1/responses";
  return "/v1/chat/completions";
}

function providerProbeHeaders(
  provider: ProviderRecord,
  token: string | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (provider.apiFormat === "anthropic_messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (token) headers["x-api-key"] = token;
  } else if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function providerProbeBody(provider: ProviderRecord): Record<string, unknown> {
  if (provider.apiFormat === "anthropic_messages") {
    return {
      model: provider.defaultModel,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }]
    };
  }
  if (provider.apiFormat === "openai_responses") {
    return {
      model: provider.defaultModel,
      input: "ping",
      max_output_tokens: 1,
      stream: false
    };
  }
  return {
    model: provider.defaultModel,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false
  };
}

function joinProviderUrl(baseUrl: string, requestUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path}`;
}

function isRetryableProbeStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function summarizeProbeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "probe timeout";
  if (error instanceof Error) return error.message;
  return String(error);
}

function providerHealthKey(providerId: string, app: ManagedAgentApp): string {
  return `${app}:${providerId}`;
}

function isAgentOnlyProvider(
  provider: ProviderRecord | undefined
): boolean {
  return provider?.app === "agent";
}

function proxyHealthApps(
  providerApp: string,
  requested?: ManagedAgentApp
): ManagedAgentApp[] {
  if (providerApp === "agent") return [];
  if (requested) return [requested];
  if (providerApp === "claude" || providerApp === "codex") return [providerApp];
  return ["claude", "codex"];
}

function redactProvider<T extends { apiKeyRef?: { maskedValue?: string } }>(
  provider: T
): T {
  return provider;
}

function redactProjectedConfig(config: string): string {
  return redactConfigContent(config);
}

function redactMcpServer<T extends { env: Record<string, string> }>(server: T): T {
  return {
    ...server,
    env: Object.fromEntries(Object.keys(server.env).map((key) => [key, "****"]))
  };
}

function redactMcpProjectedConfig(
  config: string,
  env: Record<string, string>
): string {
  return Object.values(env).reduce(
    (redacted, value) => value ? redacted.split(value).join("****") : redacted,
    config
  );
}

interface WorkspaceCleanupResult {
  candidateId: string;
  path: string;
  status: "deleted" | "skipped";
  reason?: string;
  cleanupMethod?: "git_worktree_remove" | "rm";
}

async function cleanupRunWorkspaces(
  run: RunRecord,
  workspaceRoot: string,
  projectRoot?: string
): Promise<WorkspaceCleanupResult[]> {
  const rootPath = resolve(workspaceRoot);
  return Promise.all(
    run.candidates.map(async (candidate) => {
      const candidatePath = resolve(candidate.worktreePath);
      if (!isPathInside(candidatePath, rootPath)) {
        return {
          candidateId: candidate.id,
          path: candidate.worktreePath,
          status: "skipped",
          reason: "outside_workspace_root"
        };
      }

      const removedGitWorktree = projectRoot
        ? await removeGitWorktree(
            projectRoot,
            candidatePath,
            `mn/${run.id}/${candidate.id}`
          )
        : false;
      if (!removedGitWorktree) {
        await rm(candidatePath, { recursive: true, force: true });
      }
      return {
        candidateId: candidate.id,
        path: candidate.worktreePath,
        status: "deleted",
        cleanupMethod: removedGitWorktree ? "git_worktree_remove" : "rm"
      };
    })
  );
}

async function removeGitWorktree(
  projectRoot: string,
  worktreePath: string,
  branchName: string
): Promise<boolean> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: projectRoot,
      timeout: 60_000
    });
    await execFileAsync("git", ["branch", "-D", branchName], {
      cwd: projectRoot,
      timeout: 60_000
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const normalizedChild = resolve(childPath);
  const normalizedParent = resolve(parentPath);
  const parentRelativePath = relative(normalizedParent, normalizedChild);
  return Boolean(parentRelativePath) &&
    !parentRelativePath.startsWith("..") &&
    !isAbsolute(parentRelativePath);
}

const inlineArtifactTextLimit = 8_000;

type RunArtifactSummary = ArtifactRef & {
  candidateId?: string;
  provider?: AgentRuntimeId;
  gate?: string;
  source?: string;
  label?: string;
  summary?: string;
  inlineText?: string;
  bytes?: number;
  truncated?: boolean;
  persisted?: boolean;
  remote?: PersistedRunArtifactRemoteRef;
};

interface RunArtifactFilters {
  candidateId?: string;
  provider?: AgentRuntimeId;
  kind?: string;
  gate?: string;
  source?: string;
  persisted?: boolean;
}

interface PersistedRunArtifactEntry {
  artifactId: string;
  fileName: string;
  contentType?: string;
  bytes: number;
  sha256: string;
  persistedAt: string;
  summary: RunArtifactSummary;
  remote?: PersistedRunArtifactRemoteRef;
}

interface PersistedRunArtifactIndex {
  version: 1;
  runId: string;
  updatedAt: string;
  artifacts: PersistedRunArtifactEntry[];
}

interface PersistedRunArtifactRemoteRef {
  type: ArtifactRemoteStoreType;
  key: string;
  uri: string;
  bytes: number;
  sha256: string;
  mirroredAt: string;
  bucket?: string;
  prefix?: string;
  endpointUrl?: string;
}

interface FileSystemArtifactRemoteStore {
  type: "filesystem";
  rootDir: string;
}

interface ObjectArtifactRemoteStore {
  type: "s3" | "gcs";
  rootDir: string;
  bucket: string;
  prefix?: string;
  endpointUrl?: string;
  s3Client?: S3CompatibleArtifactStore;
}

type ArtifactRemoteStore = FileSystemArtifactRemoteStore | ObjectArtifactRemoteStore;

interface ArtifactRemoteStoreDescriptor {
  type: ArtifactRemoteStoreType;
  rootDir: string;
  bucket?: string;
  prefix?: string;
  endpointUrl?: string;
  uriPrefix?: string;
}

interface ArtifactStoreRunEntry {
  runId: string;
  dirName: string;
  storeDir: string;
  artifactCount: number;
  bytes: number;
  updatedAt?: string;
  latestPersistedAt?: string;
}

type ArtifactStoreRunCleanupSummary = Omit<ArtifactStoreRunEntry, "dirName" | "storeDir"> & {
  scope?: ArtifactStoreCleanupScope;
  reasons: string[];
};

type ArtifactStoreCleanupScope = "local" | "remote" | "both";

interface ArtifactStoreCleanupPlan {
  entries: ArtifactStoreRunEntry[];
  candidates: Array<ArtifactStoreRunEntry & { reasons: string[] }>;
}

interface ArtifactStoreCleanupScopeResult {
  totalRuns: number;
  candidateRuns: number;
  candidateBytes: number;
  candidates: ArtifactStoreRunCleanupSummary[];
  deleted: ArtifactStoreRunCleanupSummary[];
}

type ArtifactStoreRemoteCleanupScopeResult = ArtifactStoreCleanupScopeResult &
  ArtifactRemoteStoreDescriptor;

interface ArtifactStoreCleanupPolicySnapshot {
  maxAgeDays?: number;
  keepLatestRuns?: number;
  maxBytes?: number;
  scope: ArtifactStoreCleanupScope;
}

interface ArtifactStoreCleanupResponse {
  dryRun: boolean;
  scope: ArtifactStoreCleanupScope;
  policy: ArtifactStoreCleanupPolicySnapshot;
  totalRuns: number;
  candidateRuns: number;
  candidateBytes: number;
  candidates: ArtifactStoreRunCleanupSummary[];
  deleted: ArtifactStoreRunCleanupSummary[];
  local?: ArtifactStoreCleanupScopeResult;
  remote?: ArtifactStoreRemoteCleanupScopeResult;
}

type ArtifactStoreCleanupTrigger = "manual" | "quota";

interface ArtifactStoreCleanupAuditRecord {
  version: 1;
  id: string;
  at: string;
  trigger: ArtifactStoreCleanupTrigger;
  dryRun: boolean;
  scope: ArtifactStoreCleanupScope;
  policy: ArtifactStoreCleanupPolicySnapshot;
  totalRuns: number;
  candidateRuns: number;
  candidateBytes: number;
  deletedRuns: number;
  deletedBytes: number;
  candidates: ArtifactStoreRunCleanupSummary[];
  deleted: ArtifactStoreRunCleanupSummary[];
  local?: ArtifactStoreCleanupScopeAuditSummary;
  remote?: ArtifactStoreCleanupScopeAuditSummary & ArtifactRemoteStoreDescriptor;
}

interface ArtifactStoreCleanupScopeAuditSummary {
  totalRuns: number;
  candidateRuns: number;
  candidateBytes: number;
  deletedRuns: number;
  deletedBytes: number;
}

interface PersistedArtifactStoreCleanupPolicy {
  version: 1;
  updatedAt: string;
  dryRun: boolean;
  policy: ArtifactStoreCleanupPolicySnapshot;
}

interface TarArchiveEntry {
  name: string;
  content: Buffer;
}

interface ArtifactStoreCleanupPolicy {
  dryRun: boolean;
  maxAgeDays?: number;
  keepLatestRuns?: number;
  maxBytes?: number;
  protectLatestRuns?: number;
}

async function listRunArtifacts(
  run: RunRecord,
  mniuRoot: string,
  remoteStore?: ArtifactRemoteStore,
  onPersist?: () => Promise<void>
): Promise<RunArtifactSummary[]> {
  if (isTerminalRunStatus(run.status)) {
    await persistRunArtifacts(run, mniuRoot, remoteStore)
      .then(() => onPersist?.())
      .catch(() => undefined);
  }

  const artifacts = buildRunArtifacts(run);
  const index = await readRunArtifactIndex(mniuRoot, run.id);
  if (!index) return artifacts;

  const currentById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const persistedById = new Map(index.artifacts.map((entry) => [entry.artifactId, entry]));
  const merged = artifacts.map((artifact) => {
    const persisted = persistedById.get(artifact.id);
    if (!persisted) return artifact;
    return {
      ...artifact,
      persisted: true,
      bytes: artifact.bytes ?? persisted.bytes,
      sha256: artifact.sha256 ?? persisted.sha256,
      remote: persisted.remote ?? artifact.remote
    };
  });

  for (const entry of index.artifacts) {
    if (currentById.has(entry.artifactId)) continue;
    merged.push({
      ...entry.summary,
      id: entry.artifactId,
      persisted: true,
      bytes: entry.bytes,
      sha256: entry.sha256,
      contentType: entry.contentType ?? entry.summary.contentType,
      remote: entry.remote ?? entry.summary.remote
    });
  }

  return merged;
}

function parseRunArtifactFilters(query: unknown): RunArtifactFilters {
  const values = (query ?? {}) as Record<string, unknown>;
  const candidateId = firstQueryValue(values.candidateId ?? values.candidate);
  const provider = firstQueryValue(values.provider);
  const kind = firstQueryValue(values.kind);
  const gate = firstQueryValue(values.gate);
  const source = firstQueryValue(values.source);
  const persisted = parseOptionalBoolean(firstQueryValue(values.persisted));
  return {
    ...(candidateId ? { candidateId } : {}),
    ...(provider === "claude" || provider === "codex" ? { provider } : {}),
    ...(kind ? { kind } : {}),
    ...(gate ? { gate } : {}),
    ...(source ? { source } : {}),
    ...(persisted !== undefined ? { persisted } : {})
  };
}

function filterRunArtifacts(
  artifacts: RunArtifactSummary[],
  filters: RunArtifactFilters
): RunArtifactSummary[] {
  return artifacts.filter((artifact) => {
    if (filters.candidateId && artifact.candidateId !== filters.candidateId) return false;
    if (filters.provider && artifact.provider !== filters.provider) return false;
    if (filters.kind && artifact.kind !== filters.kind) return false;
    if (filters.gate && artifact.gate !== filters.gate) return false;
    if (filters.source && artifact.source !== filters.source) return false;
    if (
      filters.persisted !== undefined &&
      Boolean(artifact.persisted) !== filters.persisted
    ) {
      return false;
    }
    return true;
  });
}

function firstQueryValue(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  return undefined;
}

async function persistRunArtifacts(
  run: RunRecord,
  mniuRoot: string,
  remoteStore?: ArtifactRemoteStore
): Promise<PersistedRunArtifactIndex> {
  const dir = runArtifactStoreDir(mniuRoot, run.id);
  const filesDir = join(dir, "files");
  await mkdir(filesDir, { recursive: true });

  const existing = await readRunArtifactIndex(mniuRoot, run.id);
  const entries = new Map(
    (existing?.artifacts ?? []).map((entry) => [entry.artifactId, entry])
  );

  for (const artifact of buildRunArtifacts(run)) {
    const inlineText = synthesizedArtifactText(run, artifact.id);
    const content =
      inlineText !== undefined
        ? Buffer.from(inlineText, "utf8")
        : await readArtifactFile(run, artifact);
    if (!content) continue;

    const fileName = persistedArtifactFileName(artifact);
    const filePath = join(filesDir, fileName);
    await writeFile(filePath, content);
    const digest = sha256(content);
    const mirroredAt = new Date().toISOString();
    const remote = remoteStore
      ? await writeRemoteArtifact(remoteStore, run.id, fileName, content, digest, mirroredAt)
      : entries.get(artifact.id)?.remote;
    const persistedSummary: RunArtifactSummary = {
      ...artifact,
      persisted: true,
      bytes: content.byteLength,
      sha256: digest,
      ...(remote ? { remote } : {})
    };
    entries.set(artifact.id, {
      artifactId: artifact.id,
      fileName,
      contentType: artifact.contentType,
      bytes: content.byteLength,
      sha256: digest,
      persistedAt: mirroredAt,
      summary: persistedSummary,
      ...(remote ? { remote } : {})
    });
  }

  const index: PersistedRunArtifactIndex = {
    version: 1,
    runId: run.id,
    updatedAt: new Date().toISOString(),
    artifacts: [...entries.values()].sort((a, b) => a.artifactId.localeCompare(b.artifactId))
  };
  await writeFile(runArtifactIndexPath(mniuRoot, run.id), `${JSON.stringify(index, null, 2)}\n`);
  if (remoteStore) await writeRemoteArtifactIndex(remoteStore, run.id, index);
  return index;
}

async function summarizeArtifactStore(
  mniuRoot: string,
  remoteStore?: ArtifactRemoteStore
) {
  const runs = await listArtifactStoreRunEntries(mniuRoot);
  const cleanup = await readArtifactStoreCleanupSummary(mniuRoot);
  const summary = {
    totalRuns: runs.length,
    totalArtifacts: runs.reduce((total, run) => total + run.artifactCount, 0),
    totalBytes: sumArtifactStoreBytes(runs),
    runs: runs.map(toArtifactStoreRunSummary),
    cleanup
  };
  if (!remoteStore) return summary;
  const remoteRuns = await listRemoteArtifactStoreRunEntries(remoteStore);
  return {
    ...summary,
    remote: {
      ...artifactRemoteStoreDescriptor(remoteStore),
      totalRuns: remoteRuns.length,
      totalArtifacts: remoteRuns.reduce((total, run) => total + run.artifactCount, 0),
      totalBytes: sumArtifactStoreBytes(remoteRuns),
      runs: remoteRuns.map(toArtifactStoreRunSummary)
    }
  };
}

async function recordArtifactStoreCleanup(
  mniuRoot: string,
  input: {
    trigger: ArtifactStoreCleanupTrigger;
    cleanup: ArtifactStoreCleanupResponse;
    persistPolicy: boolean;
  }
): Promise<{ id: string; at: string; trigger: ArtifactStoreCleanupTrigger }> {
  const at = new Date().toISOString();
  const record: ArtifactStoreCleanupAuditRecord = {
    version: 1,
    id: randomUUID(),
    at,
    trigger: input.trigger,
    dryRun: input.cleanup.dryRun,
    scope: input.cleanup.scope,
    policy: compactArtifactStoreCleanupPolicy(input.cleanup.policy),
    totalRuns: input.cleanup.totalRuns,
    candidateRuns: input.cleanup.candidateRuns,
    candidateBytes: input.cleanup.candidateBytes,
    deletedRuns: input.cleanup.deleted.length,
    deletedBytes: sumArtifactStoreBytes(input.cleanup.deleted),
    candidates: input.cleanup.candidates,
    deleted: input.cleanup.deleted,
    ...(input.cleanup.local
      ? { local: summarizeArtifactStoreCleanupScope(input.cleanup.local) }
      : {}),
    ...(input.cleanup.remote
      ? {
          remote: {
            ...artifactRemoteStoreDescriptorFromSummary(input.cleanup.remote),
            ...summarizeArtifactStoreCleanupScope(input.cleanup.remote)
          }
        }
      : {})
  };
  await mkdir(dirname(artifactStoreCleanupAuditPath(mniuRoot)), { recursive: true });
  if (input.persistPolicy) {
    const policy: PersistedArtifactStoreCleanupPolicy = {
      version: 1,
      updatedAt: at,
      dryRun: input.cleanup.dryRun,
      policy: record.policy
    };
    await writeFile(
      artifactStoreCleanupPolicyPath(mniuRoot),
      `${JSON.stringify(policy, null, 2)}\n`
    );
  }
  await appendFile(artifactStoreCleanupAuditPath(mniuRoot), `${JSON.stringify(record)}\n`);
  return { id: record.id, at: record.at, trigger: record.trigger };
}

async function readArtifactStoreCleanupSummary(
  mniuRoot: string,
  limit = 10
): Promise<{
  totalRecords: number;
  recent: ArtifactStoreCleanupAuditRecord[];
  latest?: ArtifactStoreCleanupAuditRecord;
  policy?: PersistedArtifactStoreCleanupPolicy;
}> {
  const [records, policy] = await Promise.all([
    readArtifactStoreCleanupAuditRecords(mniuRoot),
    readArtifactStoreCleanupPolicy(mniuRoot)
  ]);
  return {
    totalRecords: records.length,
    recent: records.slice(-limit).reverse(),
    ...(records.length > 0 ? { latest: records.at(-1) } : {}),
    ...(policy ? { policy } : {})
  };
}

async function readArtifactStoreCleanupAuditRecords(
  mniuRoot: string
): Promise<ArtifactStoreCleanupAuditRecord[]> {
  try {
    const raw = await readFile(artifactStoreCleanupAuditPath(mniuRoot), "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as ArtifactStoreCleanupAuditRecord;
          return parsed.version === 1 && parsed.id && parsed.at ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function readArtifactStoreCleanupPolicy(
  mniuRoot: string
): Promise<PersistedArtifactStoreCleanupPolicy | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(artifactStoreCleanupPolicyPath(mniuRoot), "utf8")
    ) as PersistedArtifactStoreCleanupPolicy;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeArtifactStoreCleanupScope(
  scope: ArtifactStoreCleanupScopeResult
): ArtifactStoreCleanupScopeAuditSummary {
  return {
    totalRuns: scope.totalRuns,
    candidateRuns: scope.candidateRuns,
    candidateBytes: scope.candidateBytes,
    deletedRuns: scope.deleted.length,
    deletedBytes: sumArtifactStoreBytes(scope.deleted)
  };
}

function compactArtifactStoreCleanupPolicy(
  policy: ArtifactStoreCleanupPolicySnapshot
): ArtifactStoreCleanupPolicySnapshot {
  return {
    ...(policy.maxAgeDays !== undefined ? { maxAgeDays: policy.maxAgeDays } : {}),
    ...(policy.keepLatestRuns !== undefined ? { keepLatestRuns: policy.keepLatestRuns } : {}),
    ...(policy.maxBytes !== undefined ? { maxBytes: policy.maxBytes } : {}),
    scope: policy.scope
  };
}

async function planArtifactStoreCleanup(
  mniuRoot: string,
  policy: ArtifactStoreCleanupPolicy
): Promise<ArtifactStoreCleanupPlan> {
  return planArtifactStoreCleanupFromEntries(await listArtifactStoreRunEntries(mniuRoot), policy);
}

async function planRemoteArtifactStoreCleanup(
  remoteStore: ArtifactRemoteStore,
  policy: ArtifactStoreCleanupPolicy
): Promise<ArtifactStoreCleanupPlan> {
  return planArtifactStoreCleanupFromEntries(
    await listRemoteArtifactStoreRunEntries(remoteStore),
    policy
  );
}

function planArtifactStoreCleanupFromEntries(
  entries: ArtifactStoreRunEntry[],
  policy: ArtifactStoreCleanupPolicy
): ArtifactStoreCleanupPlan {
  const keepLatestSet =
    policy.keepLatestRuns === undefined
      ? undefined
      : new Set(
          [...entries]
            .sort(compareArtifactStoreRunsNewestFirst)
            .slice(0, policy.keepLatestRuns)
            .map((entry) => entry.dirName)
        );
  const cutoff = policy.maxAgeDays === undefined
    ? undefined
    : Date.now() - policy.maxAgeDays * 24 * 60 * 60 * 1000;

  const candidates = new Map<string, ArtifactStoreRunEntry & { reasons: string[] }>();
  const markCandidate = (entry: ArtifactStoreRunEntry, reason: string) => {
    const existing = candidates.get(entry.dirName);
    if (existing) {
      existing.reasons.push(reason);
      return;
    }
    candidates.set(entry.dirName, { ...entry, reasons: [reason] });
  };

  for (const entry of entries) {
    if (keepLatestSet && !keepLatestSet.has(entry.dirName)) {
      markCandidate(entry, `outside latest ${policy.keepLatestRuns} runs`);
    }
    if (cutoff !== undefined) {
      const timestamp = Date.parse(entry.latestPersistedAt ?? entry.updatedAt ?? "");
      if (!Number.isFinite(timestamp) || timestamp < cutoff) {
        markCandidate(entry, `older than ${policy.maxAgeDays} days`);
      }
    }
  }

  if (policy.maxBytes !== undefined) {
    let remainingBytes = sumArtifactStoreBytes(
      entries.filter((entry) => !candidates.has(entry.dirName))
    );
    const protectedLatest = new Set(
      [...entries]
        .sort(compareArtifactStoreRunsNewestFirst)
        .slice(0, policy.protectLatestRuns ?? policy.keepLatestRuns ?? 1)
        .map((entry) => entry.dirName)
    );
    const oldestFirst = [...entries].sort(
      (left, right) =>
        artifactStoreRunTime(left) - artifactStoreRunTime(right) ||
        left.runId.localeCompare(right.runId)
    );
    for (const entry of oldestFirst) {
      if (remainingBytes <= policy.maxBytes) break;
      if (candidates.has(entry.dirName) || protectedLatest.has(entry.dirName)) continue;
      markCandidate(entry, `over max ${policy.maxBytes} bytes`);
      remainingBytes -= entry.bytes;
    }
  }

  return {
    entries,
    candidates: [...candidates.values()].sort(compareArtifactStoreRunsNewestFirst)
  };
}

async function executeArtifactStoreCleanup(
  plan: ArtifactStoreCleanupPlan,
  dryRun: boolean,
  scope: Exclude<ArtifactStoreCleanupScope, "both">,
  remoteStore?: ArtifactRemoteStore
): Promise<ArtifactStoreCleanupScopeResult> {
  const deleted: ArtifactStoreRunCleanupSummary[] = [];
  if (!dryRun) {
    for (const candidate of plan.candidates) {
      if (scope === "remote" && remoteStore?.type === "s3" && remoteStore.s3Client) {
        const runPrefix = artifactRemoteKey(remoteStore, "runs", candidate.dirName);
        await remoteStore.s3Client.deletePrefix(`${runPrefix}/`);
      }
      await rm(candidate.storeDir, { recursive: true, force: true });
      deleted.push(toArtifactStoreRunCleanupSummary(candidate, scope));
    }
  }
  return {
    totalRuns: plan.entries.length,
    candidateRuns: plan.candidates.length,
    candidateBytes: sumArtifactStoreBytes(plan.candidates),
    candidates: plan.candidates.map((candidate) =>
      toArtifactStoreRunCleanupSummary(candidate, scope)
    ),
    deleted
  };
}

function emptyArtifactStoreCleanupScopeResult(): ArtifactStoreCleanupScopeResult {
  return {
    totalRuns: 0,
    candidateRuns: 0,
    candidateBytes: 0,
    candidates: [],
    deleted: []
  };
}

async function listArtifactStoreRunEntries(mniuRoot: string): Promise<ArtifactStoreRunEntry[]> {
  return listArtifactStoreRunEntriesFromRoot(runArtifactStoreRoot(mniuRoot));
}

async function listRemoteArtifactStoreRunEntries(
  remoteStore: ArtifactRemoteStore
): Promise<ArtifactStoreRunEntry[]> {
  return listArtifactStoreRunEntriesFromRoot(artifactRemoteRunsRoot(remoteStore));
}

async function listArtifactStoreRunEntriesFromRoot(
  root: string
): Promise<ArtifactStoreRunEntry[]> {
  let dirEntries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    dirEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs: ArtifactStoreRunEntry[] = [];
  for (const dirEntry of dirEntries) {
    if (!dirEntry.isDirectory()) continue;
    const storeDir = join(root, dirEntry.name);
    try {
      const raw = await readFile(join(storeDir, "index.json"), "utf8");
      const index = JSON.parse(raw) as PersistedRunArtifactIndex;
      runs.push({
        runId: index.runId,
        dirName: dirEntry.name,
        storeDir,
        artifactCount: index.artifacts.length,
        bytes: index.artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
        updatedAt: index.updatedAt,
        latestPersistedAt: latestPersistedAt(index)
      });
    } catch {
      continue;
    }
  }
  return runs.sort(compareArtifactStoreRunsNewestFirst);
}

function compareArtifactStoreRunsNewestFirst(
  left: ArtifactStoreRunEntry,
  right: ArtifactStoreRunEntry
): number {
  return artifactStoreRunTime(right) - artifactStoreRunTime(left) ||
    right.runId.localeCompare(left.runId);
}

function artifactStoreRunTime(entry: ArtifactStoreRunEntry): number {
  const value = Date.parse(entry.latestPersistedAt ?? entry.updatedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function latestPersistedAt(index: PersistedRunArtifactIndex): string | undefined {
  return index.artifacts
    .map((artifact) => artifact.persistedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
}

function toArtifactStoreRunSummary(
  entry: ArtifactStoreRunEntry
): Omit<ArtifactStoreRunEntry, "dirName" | "storeDir"> {
  return {
    runId: entry.runId,
    artifactCount: entry.artifactCount,
    bytes: entry.bytes,
    updatedAt: entry.updatedAt,
    latestPersistedAt: entry.latestPersistedAt
  };
}

function toArtifactStoreRunCleanupSummary(
  entry: ArtifactStoreRunEntry & { reasons: string[] },
  scope?: Exclude<ArtifactStoreCleanupScope, "both">
): ArtifactStoreRunCleanupSummary {
  return {
    ...toArtifactStoreRunSummary(entry),
    ...(scope ? { scope } : {}),
    reasons: entry.reasons
  };
}

function sumArtifactStoreBytes(entries: Pick<ArtifactStoreRunEntry, "bytes">[]): number {
  return entries.reduce((total, entry) => total + entry.bytes, 0);
}

function projectBoundSpecRefs(
  input: { readonly tenantId: string; readonly projectId: string },
  store: MemoryStore
): SpecRef[] {
  const refs: SpecRef[] = [];
  for (const task of store.tasks.values()) {
    if (
      task.projectId === input.projectId &&
      (task.tenantId ?? LOCAL_TENANT_ID) === input.tenantId &&
      task.specRef
    ) {
      refs.push(task.specRef);
    }
  }
  for (const run of store.runs.values()) {
    if (
      run.projectId === input.projectId &&
      (run.tenantId ?? LOCAL_TENANT_ID) === input.tenantId &&
      run.harnessManifest?.specRef
    ) {
      refs.push(run.harnessManifest.specRef);
    }
  }
  const unique = new Map(
    refs.map((ref) => [`${ref.specSetId}\0${ref.revision}\0${ref.digest}`, ref])
  );
  return [...unique.values()].sort(
    (left, right) =>
      left.specSetId.localeCompare(right.specSetId) || left.revision - right.revision
  );
}

async function resolveProjectApprovedSpecRevision(
  input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly specRef: SpecRef;
  },
  store: MemoryStore,
  specRepository: FileSpecRepository
): Promise<SpecRevision | undefined> {
  const project = store.projects.get(input.projectId);
  if (
    !project ||
    (project.tenantId ?? LOCAL_TENANT_ID) !== input.tenantId ||
    (store.specSetTenants.get(input.specRef.specSetId) ?? LOCAL_TENANT_ID) !== input.tenantId
  ) {
    return undefined;
  }
  const isProjectBound = projectBoundSpecRefs(input, store).some(
    (ref) =>
      ref.specSetId === input.specRef.specSetId &&
      ref.revision === input.specRef.revision &&
      ref.digest === input.specRef.digest
  );
  if (!isProjectBound) return undefined;
  const record = await specRepository.get(input.specRef.specSetId);
  const revision = record?.revisions.find(
    (candidate) => candidate.revision === input.specRef.revision
  );
  return revision?.status === "approved" && revision.digest === input.specRef.digest
    ? revision
    : undefined;
}

/**
 * Builds the complete, immutable data-plane input for one governed claim.
 * Machine principals receive this object only inside the active claim
 * response; they do not gain the human Project/Task/Spec read surfaces.
 */
async function enterpriseWorkerExecutionContext(input: {
  readonly tenantId: string;
  readonly project: Project;
  readonly task: AgentTask;
  readonly run: RunRecord;
  readonly store: MemoryStore;
  readonly specRepository: FileSpecRepository;
  readonly sourceSnapshot?: RunScopedCasObjectRef;
}): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (!input.task.specRef) return undefined;
  if (!input.run.governanceSnapshot || !input.run.harnessManifest) {
    throw new TypeError(
      "Governed enterprise queue payload requires immutable Governance and Harness bindings"
    );
  }
  if (!input.sourceSnapshot) {
    throw new TypeError("Governed enterprise queue payload requires a source snapshot");
  }
  const specRevision = await resolveProjectApprovedSpecRevision(
    {
      tenantId: input.tenantId,
      projectId: input.project.id,
      specRef: input.task.specRef
    },
    input.store,
    input.specRepository
  );
  if (!specRevision) {
    throw new TypeError(
      "Governed enterprise queue payload requires the exact approved Spec revision"
    );
  }
  const semantic = {
    schemaVersion: 2 as const,
    project: structuredClone(input.project),
    task: structuredClone(input.task),
    specRevision: structuredClone(specRevision),
    sourceSnapshot: structuredClone(input.sourceSnapshot),
    bindings: {
      tenantId: input.tenantId,
      runId: input.run.id,
      projectId: input.project.id,
      taskId: input.task.id,
      specRef: structuredClone(input.task.specRef),
      governanceDigest: input.run.governanceSnapshot.digest,
      harnessDigest: input.run.harnessManifest.digest,
      workflowRef: structuredClone(input.run.workflowRef ?? input.task.workflowRef)
    }
  };
  return Object.freeze({
    ...semantic,
    digest: sha256Canonical(semantic)
  });
}

async function listProjectApprovedSpecRevisions(
  input: { readonly tenantId: string; readonly projectId: string },
  store: MemoryStore,
  specRepository: FileSpecRepository
): Promise<SpecRevision[]> {
  const revisions = await Promise.all(
    projectBoundSpecRefs(input, store).map((specRef) =>
      resolveProjectApprovedSpecRevision({ ...input, specRef }, store, specRepository)
    )
  );
  return revisions.filter((revision): revision is SpecRevision => revision !== undefined);
}

async function resolveServerEvidenceReference(
  input: EvidenceReferenceQuery,
  store: MemoryStore,
  mniuRoot: string,
  remoteStore: ArtifactRemoteStore | undefined,
  runScopedCas: RunScopedCas,
  authoritativeGateSigningKey: string | undefined
): Promise<ResolvedEvidenceReference | undefined> {
  const runs = [...store.runs.values()]
    .filter(
      (run) =>
        (run.tenantId ?? LOCAL_TENANT_ID) === input.tenantId &&
        run.projectId === input.projectId &&
        (input.runId === undefined || run.id === input.runId)
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const run of runs) {
    for (const gate of run.gateResultsV2 ?? []) {
      if (!await gateHasAuthoritativeReceipt({
        run,
        gate,
        tenantId: input.tenantId,
        projectId: input.projectId,
        store,
        cas: runScopedCas,
        signingKey: authoritativeGateSigningKey
      })) {
        // Migrated/legacy Gate metadata may still be displayed, but it is not
        // trusted as enterprise Eval/Trace/Learning evidence.
        continue;
      }
      if (evidencePairMatches(input, [gate.id, `gate-result:${gate.id}`], gate.outputDigest)) {
        const verifiedArtifacts = await Promise.all(gate.artifacts.map((artifact) =>
          resolveVerifiedGateArtifact({
            tenantId: input.tenantId,
            projectId: input.projectId,
            runId: run.id,
            gate,
            artifact,
            store,
            cas: runScopedCas
          })
        ));
        if (verifiedArtifacts.every((artifact) => artifact !== undefined)) {
          return {
            runId: run.id,
            kind: "gate_result",
            ref: gate.id,
            digest: gate.outputDigest
          };
        }
      }
      for (const artifact of gate.artifacts) {
        if (!evidencePairMatches(
          input,
          [artifact.id, artifact.handle],
          artifact.digest
        )) continue;
        const verified = await resolveVerifiedGateArtifact({
          tenantId: input.tenantId,
          projectId: input.projectId,
          runId: run.id,
          gate,
          artifact,
          store,
          cas: runScopedCas
        });
        if (!verified) continue;
        return {
          runId: run.id,
          kind: "gate_artifact",
          ref: artifact.handle ?? artifact.id,
          digest: artifact.digest
        };
      }
    }

    const loopState = store.governedLoopStates.get(run.id);
    for (const artifact of loopState?.attempts.flatMap((attempt) => [
      ...attempt.inputArtifacts,
      ...attempt.outputArtifacts
    ]) ?? []) {
      if (evidencePairMatches(input, [artifact.id, artifact.path], artifact.digest)) {
        return {
          runId: run.id,
          kind: "loop_artifact",
          ref: artifact.id,
          digest: artifact.digest
        };
      }
    }

    const index = await readRunArtifactIndex(mniuRoot, run.id);
    for (const entry of index?.artifacts ?? []) {
      const refs = [
        entry.artifactId,
        entry.summary.id,
        entry.summary.path,
        entry.remote?.key,
        entry.remote?.uri
      ];
      if (!evidencePairMatches(input, refs, entry.sha256)) continue;
      const persisted = await readPersistedArtifactContent(
        mniuRoot,
        run.id,
        entry.artifactId,
        remoteStore
      );
      if (!persisted || sha256(persisted.content) !== entry.sha256) continue;
      return {
        runId: run.id,
        kind: "run_artifact",
        ref: entry.remote?.uri ?? entry.artifactId,
        digest: entry.sha256
      };
    }
  }
  return undefined;
}

export async function gateHasAuthoritativeReceipt(input: {
  readonly run: RunRecord;
  readonly gate: GateResultV2;
  readonly tenantId: string;
  readonly projectId: string;
  readonly store: MemoryStore;
  readonly cas: RunScopedCas;
  readonly signingKey: string | undefined;
}): Promise<boolean> {
  if (!input.signingKey) return false;
  const binding = input.run.verificationEvidence?.find((candidate) =>
    candidate.gateResultIds.includes(input.gate.id)
  );
  if (!binding) return false;
  const records = [...input.store.authoritativeGateReceipts.values()].filter(
    (record) =>
      record.tenantId === input.tenantId &&
      record.projectId === input.projectId &&
      record.runId === input.run.id &&
      record.stageAttemptId === binding.stageAttemptId
  );
  if (records.length !== 1) return false;
  const record = records[0]!;
  const verification = verifyAuthoritativeGateReceipt(
    record.receipt,
    input.signingKey
  );
  const receipt = verification.receipt;
  if (
    !verification.valid ||
    !receipt ||
    record.id !== receipt.digest ||
    receipt.tenantId !== input.tenantId ||
    receipt.projectId !== input.projectId ||
    receipt.runId !== input.run.id ||
    receipt.stageAttemptId !== binding.stageAttemptId ||
    receipt.specDigest !== input.run.harnessManifest?.specRef.digest ||
    receipt.governanceDigest !== input.run.governanceSnapshot?.digest ||
    receipt.harnessDigest !== input.run.harnessManifest?.digest
  ) {
    return false;
  }
  const attempt = input.store.governedLoopStates
    .get(input.run.id)
    ?.attempts.find((candidate) => candidate.id === binding.stageAttemptId);
  if (
    !attempt ||
    attempt.stage !== "verification" ||
    attempt.status === "running" ||
    receipt.passed !== (attempt.status === "completed")
  ) {
    return false;
  }
  const resultsById = new Map(
    (input.run.gateResultsV2 ?? []).map((result) => [result.id, result])
  );
  const results = binding.gateResultIds
    .map((id) => resultsById.get(id))
    .filter((result): result is GateResultV2 => Boolean(result));
  if (results.length !== binding.gateResultIds.length) return false;
  try {
    const digest = await verifiedReportedGateResultsDigest({
      results,
      resolveReportedArtifact: async (gate, artifact) =>
        (await resolveVerifiedGateArtifact({
          tenantId: input.tenantId,
          projectId: input.projectId,
          runId: input.run.id,
          gate,
          artifact,
          store: input.store,
          cas: input.cas
        }))?.content
    });
    if (digest !== receipt.reportedResultsDigest) return false;
  } catch {
    return false;
  }
  const runtimeBinding = input.run.sandboxEvidenceHistory?.find((candidate) =>
    candidate.stageAttemptIds.includes(binding.stageAttemptId) &&
    binding.gateResultIds.every((id) => candidate.gateResultIds.includes(id))
  );
  return Boolean(
    runtimeBinding &&
    runtimeBinding.execution.leaseId === receipt.leaseId &&
    runtimeBinding.execution.runtimeId === receipt.runtimeId &&
    runtimeBinding.execution.runtimeDigest === receipt.runtimeDigest &&
    runtimeBinding.execution.runtimeProof.digest === receipt.runtimeProofDigest
  );
}

function evidencePairMatches(
  input: Pick<EvidenceReferenceQuery, "ref" | "digest">,
  refs: readonly (string | undefined)[],
  digest: string
): boolean {
  return refs.some((ref) => ref === input.ref) &&
    (input.digest === undefined || input.digest === digest);
}

function normalizeSandboxRuntimeImage(
  value: SandboxRuntimeImage
): SandboxRuntimeImage {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.reference !== "string" ||
    value.reference.length === 0 ||
    value.reference.length > 1_024 ||
    value.reference !== value.reference.trim() ||
    /[\0\r\n\s]/u.test(value.reference) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digest)
  ) {
    throw new TypeError(
      "enterpriseSandboxImage requires a safe reference and SHA-256 content digest"
    );
  }
  return Object.freeze({ reference: value.reference, digest: value.digest });
}

async function readRunArtifactIndex(
  mniuRoot: string,
  runId: string
): Promise<PersistedRunArtifactIndex | undefined> {
  try {
    const raw = await readFile(runArtifactIndexPath(mniuRoot, runId), "utf8");
    const parsed = JSON.parse(raw) as PersistedRunArtifactIndex;
    return parsed.version === 1 && parsed.runId === runId ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readPersistedArtifactContent(
  mniuRoot: string,
  runId: string,
  artifactId: string,
  remoteStore?: ArtifactRemoteStore
): Promise<{ entry: PersistedRunArtifactEntry; content: Buffer } | undefined> {
  const index = await readRunArtifactIndex(mniuRoot, runId);
  const entry = index?.artifacts.find((item) => item.artifactId === artifactId);
  if (!entry) return undefined;
  try {
    const content = await readFile(join(runArtifactStoreDir(mniuRoot, runId), "files", entry.fileName));
    if (sha256(content) === entry.sha256) return { entry, content };
  } catch {
    // Fall through to the configured mirror/object store.
  }
  if (!remoteStore || !entry.remote) return undefined;
  const remoteContent = await readRemoteArtifact(
    remoteStore,
    entry.remote.key,
    entry.sha256
  );
  if (!remoteContent || sha256(remoteContent) !== entry.sha256) return undefined;
  return { entry, content: remoteContent };
}

async function resolveRunArtifactContent(
  run: RunRecord,
  mniuRoot: string,
  artifact: RunArtifactSummary,
  remoteStore?: ArtifactRemoteStore
): Promise<Buffer | undefined> {
  const persistedContent = await readPersistedArtifactContent(
    mniuRoot,
    run.id,
    artifact.id,
    remoteStore
  );
  if (persistedContent) return persistedContent.content;

  const inlineText = synthesizedArtifactText(run, artifact.id);
  if (inlineText !== undefined) return Buffer.from(inlineText, "utf8");

  return (await readArtifactFile(run, artifact)) ?? undefined;
}

function runArtifactStoreDir(mniuRoot: string, runId: string): string {
  return join(runArtifactStoreRoot(mniuRoot), safePathSegment(runId));
}

function runArtifactIndexPath(mniuRoot: string, runId: string): string {
  return join(runArtifactStoreDir(mniuRoot, runId), "index.json");
}

function runArtifactStoreRoot(mniuRoot: string): string {
  return join(mniuRoot, "artifacts", "runs");
}

function artifactStoreCleanupAuditPath(mniuRoot: string): string {
  return join(mniuRoot, "artifacts", "cleanup-audit.jsonl");
}

function artifactStoreCleanupPolicyPath(mniuRoot: string): string {
  return join(mniuRoot, "artifacts", "cleanup-policy.json");
}

function artifactRemoteRunsRoot(remoteStore: ArtifactRemoteStore): string {
  return artifactRemotePath(remoteStore, artifactRemoteKey(remoteStore, "runs"));
}

function artifactRemoteFileKey(
  remoteStore: ArtifactRemoteStore,
  runId: string,
  fileName: string
): string {
  return artifactRemoteKey(remoteStore, "runs", safePathSegment(runId), "files", fileName);
}

function artifactRemoteIndexKey(remoteStore: ArtifactRemoteStore, runId: string): string {
  return artifactRemoteKey(remoteStore, "runs", safePathSegment(runId), "index.json");
}

function artifactRemotePath(remoteStore: ArtifactRemoteStore, key: string): string {
  return join(artifactRemoteLocalRoot(remoteStore), key);
}

function artifactRemoteLocalRoot(remoteStore: ArtifactRemoteStore): string {
  if (remoteStore.type === "filesystem") return remoteStore.rootDir;
  return join(remoteStore.rootDir, safePathSegment(remoteStore.bucket));
}

function artifactRemoteKey(remoteStore: ArtifactRemoteStore, ...parts: string[]): string {
  const prefixParts = remoteStore.type === "filesystem" || !remoteStore.prefix
    ? []
    : remoteStore.prefix.split("/");
  return [...prefixParts, ...parts].filter(Boolean).join("/");
}

function artifactRemoteUri(remoteStore: ArtifactRemoteStore, key: string, path: string): string {
  if (remoteStore.type === "filesystem") return pathToFileURL(path).href;
  const scheme = remoteStore.type === "s3" ? "s3" : "gs";
  return `${scheme}://${remoteStore.bucket}/${key}`;
}

function artifactRemoteStoreDescriptor(
  remoteStore: ArtifactRemoteStore
): ArtifactRemoteStoreDescriptor {
  if (remoteStore.type === "filesystem") {
    return {
      type: "filesystem",
      rootDir: remoteStore.rootDir,
      uriPrefix: pathToFileURL(remoteStore.rootDir.endsWith("/")
        ? remoteStore.rootDir
        : `${remoteStore.rootDir}/`).href
    };
  }
  const scheme = remoteStore.type === "s3" ? "s3" : "gs";
  const uriPrefix = `${scheme}://${remoteStore.bucket}${remoteStore.prefix ? `/${remoteStore.prefix}` : ""}/`;
  return {
    type: remoteStore.type,
    rootDir: remoteStore.rootDir,
    bucket: remoteStore.bucket,
    ...(remoteStore.prefix ? { prefix: remoteStore.prefix } : {}),
    ...(remoteStore.endpointUrl ? { endpointUrl: remoteStore.endpointUrl } : {}),
    uriPrefix
  };
}

function artifactRemoteStorePublicDescriptor(
  remoteStore: ArtifactRemoteStore
): Pick<ArtifactRemoteStoreDescriptor, "type" | "bucket" | "prefix"> {
  const descriptor = artifactRemoteStoreDescriptor(remoteStore);
  return {
    type: descriptor.type,
    ...(descriptor.bucket ? { bucket: descriptor.bucket } : {}),
    ...(descriptor.prefix ? { prefix: descriptor.prefix } : {})
  };
}

function artifactRemoteStoreDescriptorFromSummary(
  summary: ArtifactRemoteStoreDescriptor
): ArtifactRemoteStoreDescriptor {
  return {
    type: summary.type,
    rootDir: summary.rootDir,
    ...(summary.bucket ? { bucket: summary.bucket } : {}),
    ...(summary.prefix ? { prefix: summary.prefix } : {}),
    ...(summary.endpointUrl ? { endpointUrl: summary.endpointUrl } : {}),
    ...(summary.uriPrefix ? { uriPrefix: summary.uriPrefix } : {})
  };
}

function normalizeArtifactObjectPrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined || prefix.trim() === "") return undefined;
  const parts = prefix
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("Artifact remote store prefix cannot contain . or .. segments");
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

async function writeRemoteArtifact(
  remoteStore: ArtifactRemoteStore,
  runId: string,
  fileName: string,
  content: Buffer,
  digest: string,
  mirroredAt: string
): Promise<PersistedRunArtifactRemoteRef> {
  const key = artifactRemoteFileKey(remoteStore, runId, fileName);
  const path = artifactRemotePath(remoteStore, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (remoteStore.type === "s3" && remoteStore.s3Client) {
    const stored = await remoteStore.s3Client.putObject(key, content);
    if (stored.sha256 !== digest) {
      throw new Error("S3 artifact digest did not match the local mirror");
    }
  }
  return {
    type: remoteStore.type,
    key,
    uri: artifactRemoteUri(remoteStore, key, path),
    bytes: content.byteLength,
    sha256: digest,
    mirroredAt,
    ...(remoteStore.type !== "filesystem"
      ? {
          bucket: remoteStore.bucket,
          ...(remoteStore.prefix ? { prefix: remoteStore.prefix } : {}),
          ...(remoteStore.endpointUrl ? { endpointUrl: remoteStore.endpointUrl } : {})
        }
      : {})
  };
}

async function writeRemoteArtifactIndex(
  remoteStore: ArtifactRemoteStore,
  runId: string,
  index: PersistedRunArtifactIndex
): Promise<void> {
  const key = artifactRemoteIndexKey(remoteStore, runId);
  const path = artifactRemotePath(remoteStore, key);
  const content = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (remoteStore.type === "s3" && remoteStore.s3Client) {
    await remoteStore.s3Client.putObject(key, content, {
      contentType: "application/json"
    });
  }
}

async function readRemoteArtifact(
  remoteStore: ArtifactRemoteStore,
  key: string,
  expectedSha256?: string
): Promise<Buffer | undefined> {
  try {
    const localRoot = artifactRemoteLocalRoot(remoteStore);
    const path = resolve(localRoot, key);
    if (!isPathInside(path, localRoot) && path !== resolve(localRoot)) {
      return undefined;
    }
    const content = await readFile(path);
    if (expectedSha256 === undefined || sha256(content) === expectedSha256) {
      return content;
    }
  } catch {
    // Fall through to S3 when the compatibility mirror is unavailable.
  }
  return remoteStore.type === "s3" && remoteStore.s3Client
    ? remoteStore.s3Client.getObject(key)
    : undefined;
}

function persistedArtifactFileName(artifact: RunArtifactSummary): string {
  const digest = sha256(artifact.id).slice(0, 16);
  const name = artifactFilename(artifact).slice(0, 96);
  return `${digest}-${name || "artifact.bin"}`;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function uniqueArchivePath(
  artifact: RunArtifactSummary,
  usedNames: Set<string>
): string {
  const digest = sha256(artifact.id).slice(0, 12);
  const baseName = artifactFilename(artifact).slice(0, 72) || "artifact.bin";
  const firstPath = `files/${digest}-${baseName}`;
  let candidate = firstPath;
  let index = 2;
  while (usedNames.has(candidate)) {
    candidate = `files/${digest}-${index}-${baseName}`.slice(0, 100);
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function createTarArchive(entries: TarArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(createTarHeader(entry.name, entry.content.byteLength));
    chunks.push(entry.content);
    const remainder = entry.content.byteLength % 512;
    if (remainder > 0) chunks.push(Buffer.alloc(512 - remainder));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function createTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name.slice(0, 100));
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  writeTarString(header, 265, 32, "mn");
  writeTarString(header, 297, 32, "mn");
  const checksum = header.reduce((total, value) => total + value, 0);
  writeTarChecksum(header, 148, 8, checksum);
  return header;
}

function writeTarString(
  header: Buffer,
  offset: number,
  length: number,
  value: string
): void {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), "ascii");
}

function writeTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0").slice(-(length - 1))}\0`;
  header.write(encoded, offset, length, "ascii");
}

function writeTarChecksum(
  header: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  const encoded = `${value.toString(8).padStart(6, "0").slice(-6)}\0 `;
  header.write(encoded, offset, length, "ascii");
}

function buildRunArtifacts(run: RunRecord): RunArtifactSummary[] {
  return run.candidates.flatMap((candidate) => {
    const artifacts: RunArtifactSummary[] = [
      ...(candidate.result?.artifacts ?? []).map((artifact) => ({
        ...artifact,
        candidateId: candidate.id,
        provider: candidate.provider,
        source: "executor_artifact"
      })),
      ...candidate.gates.flatMap((gate) =>
        gate.evidence.map((artifact) => ({
          ...artifact,
          candidateId: candidate.id,
          provider: candidate.provider,
          gate: gate.gate,
          source: "gate_evidence"
        }))
      )
    ];

    if (candidate.result) {
      artifacts.push(inlineRunArtifact({
        id: `${candidate.id}:summary`,
        kind: "summary",
        path: `mn://runs/${run.id}/candidates/${candidate.id}/summary.json`,
        label: `${candidate.id} summary`,
        inlineText: candidateSummaryText(candidate),
        contentType: "application/json",
        candidateId: candidate.id,
        provider: candidate.provider,
        source: "candidate_result",
        summary: candidate.result.summary
      }));

      if (candidate.result.stdout.trim()) {
        artifacts.push(inlineRunArtifact({
          id: `${candidate.id}:stdout`,
          kind: "log",
          path: `mn://runs/${run.id}/candidates/${candidate.id}/stdout.txt`,
          label: `${candidate.id} stdout`,
          inlineText: candidate.result.stdout,
          contentType: "text/plain",
          candidateId: candidate.id,
          provider: candidate.provider,
          source: "candidate_result",
          summary: firstLine(candidate.result.stdout) || "stdout"
        }));
      }

      if (candidate.result.stderr.trim()) {
        artifacts.push(inlineRunArtifact({
          id: `${candidate.id}:stderr`,
          kind: "log",
          path: `mn://runs/${run.id}/candidates/${candidate.id}/stderr.txt`,
          label: `${candidate.id} stderr`,
          inlineText: candidate.result.stderr,
          contentType: "text/plain",
          candidateId: candidate.id,
          provider: candidate.provider,
          source: "candidate_result",
          summary: firstLine(candidate.result.stderr) || "stderr"
        }));
      }
    }

    for (const gate of candidate.gates) {
      artifacts.push(inlineRunArtifact({
        id: `${candidate.id}:gate:${gate.gate}`,
        kind: gate.gate === "llm_verifier" ? "verifier-report" : "test-report",
        path: `mn://runs/${run.id}/candidates/${candidate.id}/gates/${gate.gate}.json`,
        label: `${candidate.id} ${gate.gate}`,
        inlineText: gateReportText(candidate, gate),
        contentType: "application/json",
        candidateId: candidate.id,
        provider: candidate.provider,
        gate: gate.gate,
        source: "gate_result",
        summary: gate.summary
      }));
    }

    return artifacts;
  });
}

function synthesizedArtifactText(run: RunRecord, artifactId: string): string | undefined {
  for (const candidate of run.candidates) {
    if (artifactId === `${candidate.id}:summary` && candidate.result) {
      return candidateSummaryText(candidate);
    }
    if (artifactId === `${candidate.id}:stdout` && candidate.result?.stdout.trim()) {
      return candidate.result.stdout;
    }
    if (artifactId === `${candidate.id}:stderr` && candidate.result?.stderr.trim()) {
      return candidate.result.stderr;
    }
    for (const gate of candidate.gates) {
      if (artifactId === `${candidate.id}:gate:${gate.gate}`) {
        return gateReportText(candidate, gate);
      }
    }
  }
  return undefined;
}

function candidateSummaryText(candidate: RunRecord["candidates"][number]): string {
  if (!candidate.result) return "{}";
  return JSON.stringify({
    candidateId: candidate.id,
    provider: candidate.provider,
    status: candidate.result.status,
    exitCode: candidate.result.exitCode,
    summary: candidate.result.summary,
    startedAt: candidate.result.startedAt,
    finishedAt: candidate.result.finishedAt
  }, null, 2);
}

function gateReportText(
  candidate: RunRecord["candidates"][number],
  gate: RunRecord["gates"][number]
): string {
  return JSON.stringify({
    candidateId: candidate.id,
    provider: candidate.provider,
    gate: gate.gate,
    status: gate.status,
    summary: gate.summary
  }, null, 2);
}

async function readArtifactFile(
  run: RunRecord,
  artifact: RunArtifactSummary
): Promise<Buffer | null> {
  if (!artifact.candidateId || artifact.path.startsWith("mn://")) return null;
  const candidate = run.candidates.find((item) => item.id === artifact.candidateId);
  if (!candidate) return null;
  const candidateRoot = resolve(candidate.worktreePath);
  const artifactPath = isAbsolute(artifact.path)
    ? resolve(artifact.path)
    : resolve(candidateRoot, artifact.path);
  if (!isPathInside(artifactPath, candidateRoot) && artifactPath !== candidateRoot) {
    return null;
  }
  try {
    return await readFile(artifactPath);
  } catch {
    return null;
  }
}

function sendArtifactContent(
  reply: FastifyReply,
  artifact: RunArtifactSummary,
  content: Buffer
) {
  const contentType = artifact.contentType ?? "application/octet-stream";
  reply.header("content-type", contentType);
  reply.header("content-length", String(content.byteLength));
  reply.header(
    "content-disposition",
    `attachment; filename="${artifactFilename(artifact)}"`
  );
  return reply.send(content);
}

function artifactFilename(artifact: RunArtifactSummary): string {
  const pathName = artifact.path.startsWith("mn://")
    ? artifact.path.split("/").filter(Boolean).at(-1)
    : basename(artifact.path);
  const fallback = `${artifact.id}.txt`;
  return (pathName || artifact.label || fallback).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function inlineRunArtifact(options: {
  id: string;
  kind: "log" | "summary" | "test-report" | "verifier-report";
  path: string;
  label: string;
  inlineText: string;
  contentType: string;
  candidateId: string;
  provider: AgentRuntimeId;
  gate?: string;
  source: string;
  summary: string;
}): RunArtifactSummary {
  const inline = truncateInlineText(options.inlineText);
  return {
    id: options.id,
    kind: options.kind,
    path: options.path,
    contentType: options.contentType,
    sha256: sha256(options.inlineText),
    label: options.label,
    candidateId: options.candidateId,
    provider: options.provider,
    ...(options.gate ? { gate: options.gate } : {}),
    source: options.source,
    summary: options.summary,
    inlineText: inline.text,
    bytes: Buffer.byteLength(options.inlineText, "utf8"),
    truncated: inline.truncated
  };
}

function truncateInlineText(text: string): { text: string; truncated: boolean } {
  if (text.length <= inlineArtifactTextLimit) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(-inlineArtifactTextLimit),
    truncated: true
  };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isCanonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function withTaskRunBindings(
  run: RunRecord,
  project: Project,
  task: AgentTask
): RunRecord {
  return {
    ...run,
    tenantId: run.tenantId ?? task.tenantId ?? project.tenantId ?? LOCAL_TENANT_ID,
    workflowRef: run.workflowRef ?? resolveTaskWorkflowRef(task)
  };
}

function writeSseEvent(
  stream: { write(chunk: string): unknown },
  event: RunEvent
): void {
  stream.write(`event: ${event.type}\n`);
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function probeBinary(
  binary: string,
  args: string[]
): Promise<{ ok: boolean; binary: string; detail: string }> {
  try {
    const result = await execFileAsync(binary, args, { timeout: 5000 });
    return {
      ok: true,
      binary,
      detail: firstLine(`${result.stdout}${result.stderr}`) || "available"
    };
  } catch (error) {
    return {
      ok: false,
      binary,
      detail: errorDetail(error)
    };
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const withOutput = error as Error & { stdout?: string; stderr?: string };
    return firstLine(`${withOutput.stdout ?? ""}${withOutput.stderr ?? ""}`) ||
      error.message;
  }
  return String(error);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
