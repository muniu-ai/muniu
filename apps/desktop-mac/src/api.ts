import { invoke } from "@tauri-apps/api/core";
import type {
  AgentAppId,
  ArtifactStoreCleanupSummary,
  ArtifactStoreSummary,
  CapabilitiesDocument,
  DeepLinkImportResult,
  DesktopSettings,
  DesktopStatus,
  DryRunActionResult,
  EnvCleanupSource,
  EnvCleanupSummary,
  ExtensionSummary,
  EffectiveGovernanceSummary,
  GovernedProjectViewSummary,
  HarnessProfilesDocument,
  LearningProposalSummary,
  ManagedEnvName,
  McpServerInput,
  McpServerPatchInput,
  McpServerSummary,
  ObservabilitySummary,
  PromptPresetInput,
  PromptPresetSummary,
  ProviderInput,
  ProviderExportDocument,
  ProviderImportResult,
  ProviderHealthSummary,
  ProviderPatchInput,
  ProviderProbeSummary,
  ProxyRequestLogSummary,
  ProjectSummary,
  PolicyExplainSummary,
  ProviderSummary,
  RunArtifactDownloadSummary,
  RunArtifactFilters,
  RunArtifactSummary,
  RunEventSummary,
  RunJobWorkerListSummary,
  RunRecordSummary,
  RunResumeSummary,
  RuntimeStatus,
  SessionDetailSummary,
  SessionExportDocument,
  SessionListSummary,
  SessionSummary,
  SkillInput,
  SkillRegistryTrustProfileSummary,
  SkillRegistrySyncInput,
  SkillRegistrySyncResult,
  SkillSourceCandidate,
  SkillSummary,
  SkillSyncMode,
  SpecRefSummary,
  SpecRepositoryRecordSummary,
  SpecRevisionSummary,
  SpecSetSummary,
  SystemDiagnosticsSummary,
  SystemDoctorSummary,
  UsageSummary,
  VersionedGovernanceRef,
  WorkflowsDocument,
  WorkspaceCleanupSummary
} from "./types";

const defaultApiUrl = import.meta.env.VITE_MN_API_URL ?? "http://127.0.0.1:7318";
let configuredApiUrl = defaultApiUrl;
const desktopSettingsStorageKey = "mn.desktop.settings";
const defaultDesktopSettings: DesktopSettings = {
  theme: "system",
  closeBehavior: "tray",
  launchAtLogin: false,
  lightweightMode: false,
  apiUrl: defaultApiUrl
};

export function resolveApiUrl(): string {
  return configuredApiUrl;
}

export function configureApiUrl(apiUrl: string): void {
  configuredApiUrl = apiUrl.trim().replace(/\/+$/, "") || defaultApiUrl;
}

export async function fetchDesktopStatus(): Promise<DesktopStatus> {
  const response = await fetch(`${resolveApiUrl()}/v1/system/desktop`);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as DesktopStatus;
}

export async function fetchSystemDoctor(): Promise<SystemDoctorSummary> {
  return fetchJson<SystemDoctorSummary>("/v1/system/doctor");
}

export async function fetchSystemDiagnostics(): Promise<SystemDiagnosticsSummary> {
  return fetchJson<SystemDiagnosticsSummary>("/v1/system/diagnostics");
}

export async function fetchCapabilities(): Promise<CapabilitiesDocument> {
  return fetchJson<CapabilitiesDocument>("/v1/capabilities");
}

export async function fetchWorkflows(): Promise<WorkflowsDocument> {
  return fetchJson<WorkflowsDocument>("/v1/workflows");
}

export async function fetchHarnessProfiles(): Promise<HarnessProfilesDocument> {
  return fetchJson<HarnessProfilesDocument>("/v1/harness-profiles");
}

export async function cleanupEnvConflicts(input: {
  dryRun?: boolean;
  names?: ManagedEnvName[];
  sources?: EnvCleanupSource[];
} = {}): Promise<EnvCleanupSummary> {
  return sendJson<EnvCleanupSummary>("/v1/system/env-cleanup", "POST", input);
}

export async function fetchRuntimeStatus(): Promise<RuntimeStatus | null> {
  try {
    return await invoke<RuntimeStatus>("desktop_runtime_status");
  } catch {
    return null;
  }
}

export async function fetchDesktopSettings(): Promise<DesktopSettings> {
  try {
    return normalizeDesktopSettings(await invoke<DesktopSettings>("read_desktop_settings"));
  } catch {
    return readBrowserDesktopSettings();
  }
}

export async function saveDesktopSettings(settings: DesktopSettings): Promise<DesktopSettings> {
  const normalized = normalizeDesktopSettings(settings);
  try {
    return normalizeDesktopSettings(
      await invoke<DesktopSettings>("write_desktop_settings", { settings: normalized })
    );
  } catch {
    window.localStorage.setItem(desktopSettingsStorageKey, JSON.stringify(normalized));
    return normalized;
  }
}

export async function enterDesktopLightweightMode(): Promise<boolean> {
  try {
    await invoke("enter_lightweight_mode");
    return true;
  } catch {
    return false;
  }
}

export async function fetchProviders(app: AgentAppId): Promise<ProviderSummary[]> {
  const response = await fetch(`${resolveApiUrl()}/v1/providers?app=${app}`);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { providers: ProviderSummary[] };
  return body.providers;
}

export async function exportProviders(app: AgentAppId): Promise<ProviderExportDocument> {
  return fetchJson<ProviderExportDocument>(`/v1/providers/export${queryString({ app })}`);
}

export async function importProviders(
  input: unknown,
  dryRun: boolean
): Promise<ProviderImportResult> {
  const body = Array.isArray(input)
    ? { providers: input, dryRun }
    : { ...(input as Record<string, unknown>), dryRun };
  return sendJson<ProviderImportResult>("/v1/providers/import", "POST", body);
}

export async function previewDeepLinkImport(url: string): Promise<DeepLinkImportResult> {
  return sendJson<DeepLinkImportResult>("/v1/deep-links/preview", "POST", { url });
}

export async function importDeepLink(
  url: string,
  dryRun: boolean
): Promise<DeepLinkImportResult> {
  return sendJson<DeepLinkImportResult>("/v1/deep-links/import", "POST", { url, dryRun });
}

export async function createProvider(input: ProviderInput): Promise<ProviderSummary> {
  return sendJson<ProviderSummary>("/v1/providers", "POST", normalizeProviderInput(input));
}

export async function updateProvider(
  id: string,
  input: ProviderPatchInput
): Promise<ProviderSummary> {
  return sendJson<ProviderSummary>(
    `/v1/providers/${encodeURIComponent(id)}`,
    "PATCH",
    normalizeProviderPatch(input)
  );
}

export async function duplicateProvider(
  id: string,
  name?: string
): Promise<ProviderSummary> {
  return sendJson<ProviderSummary>(
    `/v1/providers/${encodeURIComponent(id)}/duplicate`,
    "POST",
    name ? { name } : {}
  );
}

export async function deleteProvider(id: string): Promise<void> {
  await sendDelete(`/v1/providers/${encodeURIComponent(id)}`);
}

export async function previewProviderEnable(
  providerId: string,
  app: AgentAppId
): Promise<DryRunActionResult> {
  return enableProvider(providerId, app, true);
}

export async function enableProvider(
  providerId: string,
  app: AgentAppId,
  dryRun = false
): Promise<DryRunActionResult> {
  const body = await sendJson<{
    provider: ProviderSummary;
    projection: {
      changed: boolean;
      targetPath: string;
      filePreviews?: DryRunActionResult["diffs"];
    };
  }>(`/v1/providers/${encodeURIComponent(providerId)}/enable`, "POST", {
    app,
    dryRun
  });
  return {
    label: `${body.provider.name} Provider`,
    changed: body.projection.changed,
    targetPath: body.projection.targetPath,
    diffs: body.projection.filePreviews
  };
}

export async function restoreProvider(
  providerId: string,
  app: AgentAppId,
  dryRun = true
): Promise<DryRunActionResult> {
  const body = await sendJson<{
    provider: ProviderSummary;
    restore: { restored: boolean; removed: boolean; targetPath: string };
  }>(`/v1/providers/${encodeURIComponent(providerId)}/restore`, "POST", {
    app,
    dryRun
  });
  return {
    label: `${body.provider.name} Provider 恢复`,
    changed: body.restore.restored,
    targetPath: body.restore.targetPath
  };
}

export async function testProviderEndpoint(providerId: string): Promise<ProviderProbeSummary> {
  return sendJson<ProviderProbeSummary>(
    `/v1/providers/${encodeURIComponent(providerId)}/test-endpoint`,
    "POST",
    {}
  );
}

export async function startLocalProxy(port?: number): Promise<DryRunActionResult> {
  const body = await sendJson<{
    proxy: { status: string; port: number };
    runtime: { running: boolean; port: number };
  }>("/v1/proxy/start", "POST", port === undefined ? {} : { port });
  return {
    label: "本地代理启动",
    changed: body.runtime.running,
    targetPath: `127.0.0.1:${body.runtime.port}`
  };
}

export async function stopLocalProxy(dryRun = false): Promise<DryRunActionResult> {
  const body = await sendJson<{
    proxy: { status: string; port: number };
    runtime: { running: boolean; port: number };
    restoration?: { files: Array<{ restored: boolean; targetPath: string }> };
    filePreviews?: DryRunActionResult["diffs"];
  }>("/v1/proxy/stop", "POST", { dryRun });
  return {
    label: dryRun ? "本地代理停止预览" : "本地代理停止",
    changed:
      body.runtime.running ||
      Boolean(body.restoration?.files.some((file) => file.restored)),
    targetPath: body.restoration?.files.length
      ? `${body.restoration.files.length} 个接管配置将恢复`
      : `127.0.0.1:${body.runtime.port}`,
    diffs: body.filePreviews
  };
}

export async function setProxyTakeover(
  app: AgentAppId,
  dryRun = true
): Promise<DryRunActionResult> {
  const body = await sendJson<{
    projection: {
      changed: boolean;
      targetPath: string;
      filePreviews?: DryRunActionResult["diffs"];
    };
  }>(`/v1/proxy/apps/${app}/takeover`, "POST", { dryRun });
  return {
    label: `${app} 代理接管`,
    changed: body.projection.changed,
    targetPath: body.projection.targetPath,
    diffs: body.projection.filePreviews
  };
}

export async function restoreProxyTakeover(
  app: AgentAppId,
  dryRun = true
): Promise<DryRunActionResult> {
  const body = await sendJson<{
    restore: { restored: boolean; targetPath: string };
  }>(`/v1/proxy/apps/${app}/restore`, "POST", { dryRun });
  return {
    label: `${app} 代理恢复`,
    changed: body.restore.restored,
    targetPath: body.restore.targetPath
  };
}

export async function fetchUsageSummary(app: AgentAppId) {
  const body = await fetchJson<{ summary: UsageSummary }>(
    `/v1/usage/summary${queryString({ app, limit: "100" })}`
  );
  return body.summary;
}

export async function fetchRunUsageSummary(runId: string) {
  const body = await fetchJson<{ summary: UsageSummary }>(
    `/v1/usage/summary${queryString({ runId, limit: "100" })}`
  );
  return body.summary;
}

export async function fetchProxyLogs(
  app: AgentAppId,
  limit = 8
): Promise<ProxyRequestLogSummary[]> {
  const body = await fetchJson<{ logs: ProxyRequestLogSummary[] }>(
    `/v1/proxy/logs${queryString({ app, limit: String(limit) })}`
  );
  return body.logs;
}

export async function fetchProxyHealth(app: AgentAppId): Promise<ProviderHealthSummary[]> {
  const body = await fetchJson<{ health: ProviderHealthSummary[] }>(
    `/v1/proxy/health${queryString({ app })}`
  );
  return body.health;
}

export async function resetProxyHealth(providerId: string, app: AgentAppId): Promise<{
  providerId: string;
  providerName: string;
  app?: AgentAppId;
  resetCount: number;
  reset: ProviderHealthSummary[];
}> {
  return sendJson(`/v1/proxy/health/reset`, "POST", { providerId, app });
}

export async function fetchSessions(
  app: AgentAppId,
  options: { limit?: number; offset?: number; query?: string; redact?: boolean } = {}
): Promise<SessionListSummary> {
  const limit = options.limit ?? 8;
  const offset = options.offset ?? 0;
  const body = await fetchJson<{
    sessions: SessionSummary[];
    pagination?: SessionListSummary["pagination"];
  }>(
    `/v1/sessions${queryString({
      app,
      limit: String(limit),
      offset: String(offset),
      query: options.query,
      redact: options.redact ? "true" : undefined
    })}`
  );
  return {
    sessions: body.sessions,
    pagination: body.pagination ?? {
      limit,
      offset,
      hasMore: body.sessions.length >= limit
    }
  };
}

export async function fetchSessionDetail(
  id: string,
  app: AgentAppId,
  options: { redact?: boolean } = {}
): Promise<SessionDetailSummary> {
  const body = await fetchJson<{ session: SessionDetailSummary }>(
    `/v1/sessions/${encodeURIComponent(id)}${queryString({
      app,
      redact: options.redact ? "true" : undefined
    })}`
  );
  return body.session;
}

export async function exportSession(
  id: string,
  app: AgentAppId,
  options: { redact?: boolean } = {}
): Promise<SessionExportDocument> {
  return fetchJson<SessionExportDocument>(
    `/v1/sessions/${encodeURIComponent(id)}/export${queryString({
      app,
      redact: options.redact === false ? "false" : "true"
    })}`
  );
}

export async function fetchObservability(
  app: AgentAppId,
  options: {
    sessionLimit?: number;
    sessionOffset?: number;
    sessionQuery?: string;
    sessionRedact?: boolean;
  } = {}
): Promise<ObservabilitySummary> {
  const [usage, providerHealth, proxyLogs, sessionPage] = await Promise.all([
    fetchUsageSummary(app),
    fetchProxyHealth(app),
    fetchProxyLogs(app),
    fetchSessions(app, {
      limit: options.sessionLimit ?? 8,
      offset: options.sessionOffset ?? 0,
      query: options.sessionQuery,
      redact: options.sessionRedact
    })
  ]);
  return {
    usage,
    providerHealth,
    proxyLogs,
    sessions: sessionPage.sessions,
    sessionPagination: sessionPage.pagination
  };
}

export async function createProject(input: {
  name: string;
  rootPath: string;
  defaultBranch?: string;
}): Promise<ProjectSummary> {
  return sendJson<ProjectSummary>("/v1/projects", "POST", {
    name: input.name,
    rootPath: input.rootPath,
    defaultBranch: input.defaultBranch ?? "main"
  });
}

export async function indexProject(projectId: string): Promise<ProjectSummary> {
  const body = await sendJson<{ project: ProjectSummary }>(
    `/v1/projects/${projectId}/index`,
    "POST",
    {}
  );
  return body.project;
}

export async function fetchSpecSets(): Promise<SpecRepositoryRecordSummary[]> {
  const body = await fetchJson<{ specSets: SpecSetSummary[] }>(
    "/v1/spec-sets"
  );
  return Promise.all(
    body.specSets.map((specSet) =>
      fetchJson<SpecRepositoryRecordSummary>(
        `/v1/spec-sets/${encodeURIComponent(specSet.id)}`
      )
    )
  );
}

export async function fetchSpecRevision(
  specSetId: string,
  revision: number
): Promise<SpecRevisionSummary> {
  return fetchJson<SpecRevisionSummary>(
    `/v1/spec-sets/${encodeURIComponent(specSetId)}/revisions/${revision}`
  );
}

export interface GovernanceBindingQuery {
  specRef?: SpecRefSummary;
  workflowRef?: VersionedGovernanceRef;
  harnessProfileRef?: VersionedGovernanceRef;
  serviceId?: string;
  taskId?: string;
}

export async function fetchEffectiveGovernance(
  projectId: string,
  bindings: GovernanceBindingQuery = {}
): Promise<EffectiveGovernanceSummary> {
  return fetchJson<EffectiveGovernanceSummary>(
    `/v1/projects/${encodeURIComponent(projectId)}/effective-governance${governanceQuery(bindings)}`
  );
}

export async function fetchPolicyExplain(
  projectId: string,
  bindings: GovernanceBindingQuery = {}
): Promise<PolicyExplainSummary> {
  return fetchJson<PolicyExplainSummary>(
    `/v1/projects/${encodeURIComponent(projectId)}/policy/explain${governanceQuery(bindings)}`
  );
}

export async function fetchLearningProposals(
  projectId: string
): Promise<LearningProposalSummary[]> {
  const body = await fetchJson<{ learningProposals: LearningProposalSummary[] }>(
    `/v1/learning-proposals${queryString({ projectId })}`
  );
  return body.learningProposals;
}

export async function fetchTraceGraphs(
  projectId: string
): Promise<GovernedProjectViewSummary["traceGraphs"]> {
  const body = await fetchJson<{
    traceGraphs: GovernedProjectViewSummary["traceGraphs"];
  }>(`/v1/trace-graphs${queryString({ projectId })}`);
  return body.traceGraphs;
}

export async function fetchGovernedProjectView(
  projectId: string,
  bindings: GovernanceBindingQuery = {}
): Promise<GovernedProjectViewSummary> {
  const [governance, policyExplain, traceGraphs, learningProposals, spec] =
    await Promise.all([
      fetchEffectiveGovernance(projectId, bindings),
      fetchPolicyExplain(projectId, bindings),
      fetchTraceGraphs(projectId),
      fetchLearningProposals(projectId),
      bindings.specRef
        ? fetchSpecRevision(bindings.specRef.specSetId, bindings.specRef.revision)
        : Promise.resolve(undefined)
    ]);
  return {
    projectId,
    ...(spec ? { spec } : {}),
    governance,
    policyExplain,
    traceGraphs,
    learningProposals
  };
}

export async function createTask(input: {
  projectId: string;
  title: string;
  prompt: string;
  targetServices: string[];
  acceptanceCriteria: string[];
  provider: AgentAppId;
  candidates?: number;
  requiredGates?: string[];
  humanApproval?: "never" | "on-risk" | "before-merge";
  timeoutSeconds?: number;
  specRef?: SpecRefSummary;
  workflowRef?: VersionedGovernanceRef;
  harnessProfileRef?: VersionedGovernanceRef;
}): Promise<{ id: string; specRef?: SpecRefSummary; workflowRef?: VersionedGovernanceRef }> {
  const strategy = {
    providers: [input.provider],
    ...(input.candidates !== undefined ? { candidates: input.candidates } : {}),
    sandbox: "isolated-worktree" as const,
    ...(input.requiredGates ? { requiredGates: input.requiredGates } : {}),
    ...(input.humanApproval ? { humanApproval: input.humanApproval } : {}),
    ...(input.timeoutSeconds !== undefined
      ? { timeoutSeconds: input.timeoutSeconds }
      : {})
  };
  return sendJson("/v1/tasks", "POST", {
    projectId: input.projectId,
    title: input.title,
    intent: "implement",
    targetServices: input.targetServices,
    prompt: input.prompt,
    acceptanceCriteria: input.acceptanceCriteria,
    ...(input.specRef ? { specRef: input.specRef } : {}),
    ...(input.workflowRef ? { workflowRef: input.workflowRef } : {}),
    ...(input.harnessProfileRef
      ? { harnessProfileRef: input.harnessProfileRef }
      : {}),
    strategy
  });
}

export async function createRun(taskId: string): Promise<RunRecordSummary> {
  return sendJson<RunRecordSummary>(`/v1/tasks/${taskId}/runs`, "POST", {
    wait: false
  });
}

export async function fetchRun(runId: string): Promise<RunRecordSummary> {
  return fetchJson<RunRecordSummary>(`/v1/runs/${runId}`);
}

export async function fetchRunArtifacts(
  runId: string,
  filters: RunArtifactFilters = {}
): Promise<RunArtifactSummary[]> {
  const query = queryString({
    candidateId: filters.candidateId,
    kind: filters.kind,
    persisted: filters.persisted
  });
  const body = await fetchJson<{ artifacts: RunArtifactSummary[] }>(
    `/v1/runs/${encodeURIComponent(runId)}/artifacts${query}`
  );
  return body.artifacts;
}

export async function fetchArtifactStore(): Promise<ArtifactStoreSummary> {
  return fetchJson<ArtifactStoreSummary>("/v1/artifacts/store");
}

export async function cleanupArtifactStore(input: {
  dryRun?: boolean;
  scope?: "local" | "remote" | "both";
  keepLatestRuns?: number;
  maxAgeDays?: number;
  maxBytes?: number;
}): Promise<ArtifactStoreCleanupSummary> {
  return sendJson<ArtifactStoreCleanupSummary>("/v1/artifacts/store/cleanup", "POST", input);
}

export async function downloadRunArtifact(
  runId: string,
  artifactId: string
): Promise<RunArtifactDownloadSummary> {
  const response = await fetch(
    `${resolveApiUrl()}/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const filename =
    filenameFromContentDisposition(response.headers.get("content-disposition")) ??
    `${artifactId.replace(/[^a-zA-Z0-9._-]/g, "_")}.txt`;
  const blob = await response.blob();
  const text = isPreviewableContentType(contentType) ? await blob.text() : undefined;

  return {
    artifactId,
    filename,
    contentType,
    bytes: blob.size,
    text,
    blob
  };
}

export async function downloadRunArtifactsArchive(
  runId: string,
  filters: RunArtifactFilters = {}
): Promise<RunArtifactDownloadSummary> {
  const query = queryString({
    candidateId: filters.candidateId,
    kind: filters.kind,
    persisted: filters.persisted
  });
  const response = await fetch(
    `${resolveApiUrl()}/v1/runs/${encodeURIComponent(runId)}/artifacts/archive${query}`
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }

  const contentType = response.headers.get("content-type") ?? "application/x-tar";
  const filename =
    filenameFromContentDisposition(response.headers.get("content-disposition")) ??
    `${runId.replace(/[^a-zA-Z0-9._-]/g, "_")}-artifacts.tar`;
  const blob = await response.blob();

  return {
    artifactId: "__archive__",
    filename,
    contentType,
    bytes: blob.size,
    blob
  };
}

export async function cancelRun(runId: string): Promise<RunRecordSummary> {
  return sendJson<RunRecordSummary>(`/v1/runs/${encodeURIComponent(runId)}/cancel`, "POST", {});
}

export async function decideRunApproval(
  runId: string,
  decision: "approve" | "reject",
  actorId = "desktop-user"
): Promise<RunRecordSummary> {
  return sendJson<RunRecordSummary>(
    `/v1/runs/${encodeURIComponent(runId)}/approve`,
    "POST",
    { decision, actorId }
  );
}

export async function resumeRun(runId: string): Promise<RunResumeSummary> {
  return sendJson<RunResumeSummary>(
    `/v1/runs/${encodeURIComponent(runId)}/resume`,
    "POST",
    {}
  );
}

export async function cleanupRunWorkspaces(
  runId: string
): Promise<WorkspaceCleanupSummary> {
  return sendJson<WorkspaceCleanupSummary>(
    `/v1/runs/${encodeURIComponent(runId)}/workspaces/cleanup`,
    "POST",
    {}
  );
}

export async function fetchRunEvents(runId: string): Promise<RunEventSummary[]> {
  const body = await fetchJson<{ events: RunEventSummary[] }>(`/v1/runs/${runId}/events`);
  return body.events;
}

export async function fetchRunJobWorkers(): Promise<RunJobWorkerListSummary> {
  return fetchJson<RunJobWorkerListSummary>("/v1/run-jobs/workers");
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${resolveApiUrl()}${path}`, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function queryString(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function governanceQuery(bindings: GovernanceBindingQuery): string {
  return queryString({
    serviceId: bindings.serviceId,
    taskId: bindings.taskId,
    specSetId: bindings.specRef?.specSetId,
    specRevision: bindings.specRef
      ? String(bindings.specRef.revision)
      : undefined,
    workflowId: bindings.workflowRef?.id,
    workflowVersion: bindings.workflowRef?.version,
    workflowDigest: bindings.workflowRef?.digest,
    harnessProfileId: bindings.harnessProfileRef?.id,
    harnessProfileVersion: bindings.harnessProfileRef?.version,
    harnessProfileDigest: bindings.harnessProfileRef?.digest
  });
}

function readBrowserDesktopSettings(): DesktopSettings {
  try {
    const raw = window.localStorage.getItem(desktopSettingsStorageKey);
    if (!raw) return defaultDesktopSettings;
    return normalizeDesktopSettings(JSON.parse(raw) as Partial<DesktopSettings>);
  } catch {
    return defaultDesktopSettings;
  }
}

function normalizeDesktopSettings(settings: Partial<DesktopSettings>): DesktopSettings {
  return {
    theme: isOneOf(settings.theme, ["system", "light", "dark"])
      ? settings.theme
      : defaultDesktopSettings.theme,
    closeBehavior: isOneOf(settings.closeBehavior, ["quit", "tray", "lightweight"])
      ? settings.closeBehavior
      : defaultDesktopSettings.closeBehavior,
    launchAtLogin: Boolean(settings.launchAtLogin),
    lightweightMode: Boolean(settings.lightweightMode),
    apiUrl:
      typeof settings.apiUrl === "string" && settings.apiUrl.trim()
        ? settings.apiUrl.trim()
        : defaultDesktopSettings.apiUrl
  };
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isPreviewableContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType.includes("json");
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1].replace(/"/g, ""));
  const match = value.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? null;
}

async function sendJson<T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown
): Promise<T> {
  return fetchJson<T>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function sendDelete(path: string): Promise<void> {
  const response = await fetch(`${resolveApiUrl()}${path}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
}

function normalizeProviderInput(input: ProviderInput): ProviderInput {
  return {
    ...input,
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim(),
    defaultModel: input.defaultModel.trim(),
    ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : { apiKey: undefined }),
    ...(input.apiKeyEnv?.trim() ? { apiKeyEnv: input.apiKeyEnv.trim() } : { apiKeyEnv: undefined })
  };
}

function normalizeProviderPatch(input: ProviderPatchInput): ProviderPatchInput {
  return {
    ...input,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel.trim() } : {}),
    ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : { apiKey: undefined }),
    ...(input.apiKeyEnv?.trim() ? { apiKeyEnv: input.apiKeyEnv.trim() } : { apiKeyEnv: undefined })
  };
}

export async function fetchMcpServers(app: AgentAppId): Promise<McpServerSummary[]> {
  const body = await fetchJson<{ servers: McpServerSummary[] }>(`/v1/mcp/servers?app=${app}`);
  return body.servers;
}

export async function fetchPromptPresets(app: AgentAppId): Promise<PromptPresetSummary[]> {
  const body = await fetchJson<{ prompts: PromptPresetSummary[] }>(
    `/v1/prompts/presets?app=${app}`
  );
  return body.prompts;
}

export async function fetchSkills(app: AgentAppId): Promise<SkillSummary[]> {
  const body = await fetchJson<{ skills: SkillSummary[] }>(`/v1/skills?app=${app}`);
  return body.skills;
}

export async function fetchDiscoveredSkills(): Promise<SkillSourceCandidate[]> {
  const body = await fetchJson<{ skills: SkillSourceCandidate[] }>("/v1/skills/discover");
  return body.skills;
}

export async function fetchSkillRegistryProfiles(): Promise<SkillRegistryTrustProfileSummary[]> {
  const body = await fetchJson<{ profiles: SkillRegistryTrustProfileSummary[] }>(
    "/v1/skills/registry/profiles"
  );
  return body.profiles;
}

export async function fetchExtensions(app: AgentAppId): Promise<ExtensionSummary> {
  const [mcpServers, promptPresets, skills, discoveredSkills, skillRegistryProfiles] =
    await Promise.all([
      fetchMcpServers(app),
      fetchPromptPresets(app),
      fetchSkills(app),
      fetchDiscoveredSkills(),
      fetchSkillRegistryProfiles()
    ]);
  return {
    mcpServers,
    promptPresets,
    skills,
    discoveredSkills,
    skillRegistryProfiles
  };
}

export async function previewMcpProjection(
  serverId: string,
  app: AgentAppId
): Promise<DryRunActionResult> {
  return projectMcpServer(serverId, app, true);
}

export async function projectMcpServer(
  serverId: string,
  app: AgentAppId,
  dryRun = false
): Promise<DryRunActionResult> {
  const body = await sendJson<{
    server: McpServerSummary;
    projections: Array<{ changed: boolean; targetPath: string }>;
  }>(`/v1/mcp/servers/${serverId}/project`, "POST", { apps: [app], dryRun });
  const projection = body.projections[0];
  return {
    label: `${body.server.name} MCP`,
    changed: projection?.changed,
    targetPath: projection?.targetPath
  };
}

export async function previewPromptActivation(
  promptId: string,
  app: AgentAppId
): Promise<DryRunActionResult> {
  return activatePromptPreset(promptId, app, true);
}

export async function activatePromptPreset(
  promptId: string,
  app: AgentAppId,
  dryRun = false
): Promise<DryRunActionResult> {
  const body = await sendJson<{
    prompt: PromptPresetSummary;
    projection: { changed: boolean; targetPath: string };
  }>(`/v1/prompts/presets/${promptId}/activate`, "POST", { app, dryRun });
  return {
    label: `${body.prompt.name} Prompt`,
    changed: body.projection.changed,
    targetPath: body.projection.targetPath
  };
}

export async function previewSkillInstall(
  skillId: string,
  app: AgentAppId,
  mode: SkillSyncMode
): Promise<DryRunActionResult> {
  return installSkill(skillId, app, mode, true);
}

export async function installSkill(
  skillId: string,
  app: AgentAppId,
  mode: SkillSyncMode,
  dryRun = false
): Promise<DryRunActionResult> {
  const body = await sendJson<{
    skill: SkillSummary;
    result: { changed: boolean; targetPath: string };
  }>(`/v1/skills/${skillId}/install`, "POST", { app, mode, dryRun });
  return {
    label: `${body.skill.name} Skill`,
    changed: body.result.changed,
    targetPath: body.result.targetPath
  };
}

export async function previewSkillRegistrySync(
  input: SkillRegistrySyncInput
): Promise<DryRunActionResult> {
  return syncSkillRegistry(input, true);
}

export async function syncSkillRegistry(
  input: SkillRegistrySyncInput,
  dryRun = false
): Promise<DryRunActionResult> {
  return skillRegistrySyncActionResult(
    await sendJson<SkillRegistrySyncResult>("/v1/skills/registry/sync", "POST", {
      registryUrl: input.registryUrl.trim(),
      dryRun,
      requireSignature: input.requireSignature,
      requireReleaseMetadata: input.requireReleaseMetadata,
      ...(input.publicKey?.trim() ? { publicKey: input.publicKey.trim() } : {}),
      ...(input.trustedPublicKeys?.length ? { trustedPublicKeys: input.trustedPublicKeys } : {}),
      ...(input.revokedPublicKeyIds?.length
        ? { revokedPublicKeyIds: input.revokedPublicKeyIds }
        : {})
    })
  );
}

export async function createSkillRegistryProfile(
  input: SkillRegistrySyncInput & { name: string }
): Promise<SkillRegistryTrustProfileSummary> {
  return sendJson<SkillRegistryTrustProfileSummary>(
    "/v1/skills/registry/profiles",
    "POST",
    {
      name: input.name.trim(),
      registryUrl: input.registryUrl.trim(),
      requireSignature: input.requireSignature,
      requireReleaseMetadata: input.requireReleaseMetadata,
      ...(input.publicKey?.trim() ? { publicKey: input.publicKey.trim() } : {}),
      ...(input.trustedPublicKeys?.length ? { trustedPublicKeys: input.trustedPublicKeys } : {}),
      ...(input.revokedPublicKeyIds?.length
        ? { revokedPublicKeyIds: input.revokedPublicKeyIds }
        : {})
    }
  );
}

export async function previewSkillRegistryProfileSync(
  profileId: string
): Promise<DryRunActionResult> {
  return syncSkillRegistryProfile(profileId, true);
}

export async function syncSkillRegistryProfile(
  profileId: string,
  dryRun = false
): Promise<DryRunActionResult> {
  return skillRegistrySyncActionResult(
    await sendJson<SkillRegistrySyncResult>(
      `/v1/skills/registry/profiles/${encodeURIComponent(profileId)}/sync`,
      "POST",
      { dryRun }
    )
  );
}

export async function createMcpServer(input: McpServerInput): Promise<McpServerSummary> {
  return sendJson<McpServerSummary>("/v1/mcp/servers", "POST", input);
}

export async function updateMcpServer(
  id: string,
  input: McpServerPatchInput
): Promise<McpServerSummary> {
  return sendJson<McpServerSummary>(`/v1/mcp/servers/${id}`, "PATCH", input);
}

export async function deleteMcpServer(id: string): Promise<void> {
  await sendDelete(`/v1/mcp/servers/${id}`);
}

export async function createPromptPreset(
  input: PromptPresetInput
): Promise<PromptPresetSummary> {
  return sendJson<PromptPresetSummary>("/v1/prompts/presets", "POST", input);
}

export async function updatePromptPreset(
  id: string,
  input: PromptPresetInput
): Promise<PromptPresetSummary> {
  return sendJson<PromptPresetSummary>(`/v1/prompts/presets/${id}`, "PATCH", input);
}

export async function deletePromptPreset(id: string): Promise<void> {
  await sendDelete(`/v1/prompts/presets/${id}`);
}

export async function createSkill(input: SkillInput): Promise<SkillSummary> {
  return sendJson<SkillSummary>("/v1/skills", "POST", input);
}

export async function updateSkill(id: string, input: SkillInput): Promise<SkillSummary> {
  return sendJson<SkillSummary>(`/v1/skills/${id}`, "PATCH", input);
}

export async function deleteSkill(id: string): Promise<void> {
  await sendDelete(`/v1/skills/${id}`);
}

export function offlineDesktopStatus(error: string): DesktopStatus {
  return {
    generatedAt: new Date().toISOString(),
    api: {
      ok: false,
      service: `mn-api: ${error}`,
      executorMode: "real",
      workspaceRoot: "-"
    },
    apps: [
      {
        id: "claude",
        name: "Claude Code",
        shortName: "Claude",
        binary: {
          ok: false,
          binary: "claude",
          detail: "waiting for mn-api"
        },
        currentProvider: "未连接",
        configPath: "~/.claude/settings.json",
        promptPath: "~/.claude/CLAUDE.md",
        skillPath: "~/.claude/skills",
        restartRequired: false
      },
      {
        id: "codex",
        name: "Codex",
        shortName: "Codex",
        binary: {
          ok: false,
          binary: "codex",
          detail: "waiting for mn-api"
        },
        currentProvider: "未连接",
        configPath: "~/.codex/config.toml",
        promptPath: "~/.codex/AGENTS.md",
        skillPath: "~/.codex/skills",
        restartRequired: true
      }
    ],
    proxy: {
      status: "stopped",
      port: 15721,
      takenOverApps: []
    },
    recentRuns: []
  };
}

function skillRegistrySyncActionResult(result: SkillRegistrySyncResult): DryRunActionResult {
  const changedCount = result.skills.filter((skill) => skill.changed).length;
  const appliedCount = result.skills.filter((skill) => skill.applied).length;
  const signatureCount = result.skills.filter((skill) => skill.signatureVerified).length;
  const releaseText = result.releaseMetadata?.signatureVerified ? " · release signed" : "";
  const statuses = result.skills
    .reduce<Record<string, number>>((summary, skill) => {
      summary[skill.status] = (summary[skill.status] ?? 0) + 1;
      return summary;
    }, {});
  const statusText = Object.entries(statuses)
    .map(([status, count]) => `${status}:${count}`)
    .join(" / ");
  const targetPath = result.dryRun
    ? `${changedCount} changes · ${statusText || "empty"} · ${signatureCount} signed${releaseText}`
    : `${appliedCount} applied · ${statusText || "empty"} · ${signatureCount} signed${releaseText}`;
  return {
    label: "Skill Registry",
    changed: result.dryRun ? changedCount > 0 : appliedCount > 0,
    targetPath
  };
}
