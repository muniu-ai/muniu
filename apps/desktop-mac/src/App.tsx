import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled
} from "@tauri-apps/plugin-autostart";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { save as showSaveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile as writeTauriFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Activity,
  BarChart3,
  BookOpen,
  Bot,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Copy,
  Cpu,
  Database,
  Download,
  FileText,
  FolderCog,
  FolderOpen,
  KeyRound,
  Link2,
  ListTree,
  MessageSquareText,
  MonitorCog,
  Network,
  PackageCheck,
  Pencil,
  Plus,
  PlugZap,
  Power,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Save,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  Trash2,
  Upload,
  Users,
  X,
  XCircle
} from "lucide-react";
import {
  activatePromptPreset,
  cleanupArtifactStore,
  cleanupEnvConflicts,
  cleanupRunWorkspaces,
  configureApiUrl,
  cancelRun,
  decideRunApproval,
  createProvider,
  createProject,
  createRun,
  createMcpServer,
  createPromptPreset,
  createSkill,
  createSkillRegistryProfile,
  createTask,
  deleteMcpServer,
  deletePromptPreset,
  deleteProvider,
  deleteSkill,
  duplicateProvider,
  downloadRunArtifact,
  downloadRunArtifactsArchive,
  enableProvider,
  enterDesktopLightweightMode,
  exportProviders,
  exportSession,
  fetchDesktopSettings,
  fetchDesktopStatus,
  fetchCapabilities,
  fetchExtensions,
  fetchArtifactStore,
  fetchObservability,
  fetchProviders,
  fetchRun,
  fetchRunArtifacts,
  fetchRunEvents,
  fetchRunJobWorkers,
  fetchRunUsageSummary,
  fetchRuntimeStatus,
  fetchGovernedProjectView,
  fetchHarnessProfiles,
  fetchSessionDetail,
  fetchSystemDiagnostics,
  fetchSystemDoctor,
  fetchSpecRevision,
  fetchSpecSets,
  fetchWorkflows,
  indexProject,
  importDeepLink,
  importProviders,
  installSkill,
  previewDeepLinkImport,
  restoreProvider,
  offlineDesktopStatus,
  previewMcpProjection,
  previewPromptActivation,
  previewProviderEnable,
  previewSkillInstall,
  previewSkillRegistryProfileSync,
  previewSkillRegistrySync,
  projectMcpServer,
  resolveApiUrl,
  resetProxyHealth,
  restoreProxyTakeover,
  resumeRun,
  saveDesktopSettings,
  setProxyTakeover,
  startLocalProxy,
  stopLocalProxy,
  syncSkillRegistryProfile,
  syncSkillRegistry,
  testProviderEndpoint,
  updateMcpServer,
  updatePromptPreset,
  updateProvider,
  updateSkill
} from "./api";
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
  EnvConflictSummary,
  ExtensionSummary,
  GovernedProjectViewSummary,
  HarnessProfilesDocument,
  ManagedAgentApp,
  McpServerInput,
  McpServerPatchInput,
  McpServerSummary,
  ObservabilitySummary,
  PromptPresetInput,
  PromptPresetSummary,
  ProxyRequestLogSummary,
  ProviderApiFormat,
  ProviderAppScope,
  ProviderHealthSummary,
  ProviderInput,
  ProviderImportResult,
  ProviderKind,
  ProviderModelSummary,
  ProviderPatchInput,
  ProviderSummary,
  ProviderProbeSummary,
  ProviderWireApi,
  RecentRun,
  RunArtifactDownloadSummary,
  RunArtifactFilters,
  RunArtifactSummary,
  RunEventSummary,
  RunJobWorkerListSummary,
  RunJobWorkerSummary,
  RunRecordSummary,
  RuntimeStatus,
  SessionDetailSummary,
  SessionSummary,
  SkillInput,
  SkillRegistryTrustProfileSummary,
  SkillRegistrySyncInput,
  SkillSourceCandidate,
  SkillSummary,
  SkillSyncMode,
  SpecRepositoryRecordSummary,
  SpecRevisionSummary,
  SystemDiagnosticsSummary,
  SystemDoctorSummary,
  TaskRunFormValues,
  UsageSummary,
  WorkflowsDocument
} from "./types";
import {
  GovernedRunDetail,
  GovernanceProjectPanel,
  isGovernedWorkflow,
  TaskGovernanceControls
} from "./GovernedTaskFusion";
import "./styles.css";

const agentOrder: AgentAppId[] = ["claude", "codex"];
const sessionPageSize = 8;
const mutationSkipped = Symbol("mutationSkipped");
const artifactKindOptions: RunArtifactSummary["kind"][] = [
  "log",
  "summary",
  "test-report",
  "verifier-report",
  "diff",
  "trace",
  "security-report"
];

interface SessionFilterState {
  query: string;
  draft: string;
  offset: number;
  redact: boolean;
}

interface ArtifactPreviewState {
  artifactId: string;
  filename: string;
  contentType: string;
  bytes: number;
  text?: string;
}

interface ArtifactFilterState {
  candidateId: string;
  kind: "" | RunArtifactSummary["kind"];
  persisted: "all" | "persisted" | "ephemeral";
}

interface DiagnosticsExportDocument {
  kind: "mniu.diagnostics";
  version: number;
  exportedAt: string;
  apiGeneratedAt: string;
  apiUrl: string;
  desktop: {
    tauri: boolean;
    userAgent: string;
    language: string;
  };
  settings: DesktopSettings;
  runtime: RuntimeStatus | null;
  doctor: SystemDoctorSummary | null;
  logs: SystemDiagnosticsSummary["logs"];
  crashReports: SystemDiagnosticsSummary["crashReports"];
  appLogs: SystemDiagnosticsSummary["appLogs"];
  logHints: string[];
}

type DownloadDisposition =
  | { status: "saved"; mode: "native"; path: string }
  | { status: "downloaded"; mode: "browser" }
  | { status: "cancelled" };

type LaunchAtLoginSyncResult =
  | { mode: "native"; enabled: boolean }
  | { mode: "browser"; enabled: boolean };

function emptySessionFilters(): Record<AgentAppId, SessionFilterState> {
  return {
    claude: { query: "", draft: "", offset: 0, redact: true },
    codex: { query: "", draft: "", offset: 0, redact: true }
  };
}

function toRunArtifactFilters(filters: ArtifactFilterState): RunArtifactFilters {
  return {
    ...(filters.candidateId ? { candidateId: filters.candidateId } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.persisted === "persisted" ? { persisted: "true" as const } : {}),
    ...(filters.persisted === "ephemeral" ? { persisted: "false" as const } : {})
  };
}

const defaultArtifactFilters: ArtifactFilterState = {
  candidateId: "",
  kind: "",
  persisted: "all"
};

const defaultTaskRunForm: TaskRunFormValues = {
  projectName: "desktop-demo",
  rootPath: "",
  title: "Desktop smoke task",
  prompt: "Make no changes. This is a desktop task fusion smoke run.",
  acceptanceText: "unit tests and typecheck pass",
  targetService: "",
  workflowId: "",
  harnessProfileId: "",
  specSetId: "",
  specRevision: "",
  specDigest: "",
  candidates: ""
};

const defaultDesktopSettings: DesktopSettings = {
  theme: "system",
  closeBehavior: "tray",
  launchAtLogin: false,
  lightweightMode: false,
  apiUrl: resolveApiUrl()
};

const defaultSkillRegistryForm: SkillRegistryFormValues = {
  profileId: "",
  profileName: "",
  registryUrl: "",
  requireSignature: false,
  requireReleaseMetadata: false,
  publicKey: "",
  trustedPublicKeysText: "",
  revokedPublicKeyIdsText: ""
};

function isRunTerminal(status: RunRecordSummary["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isRunResumable(status: RunRecordSummary["status"]): boolean {
  return status === "failed" || status === "cancelled";
}

function emptyExtensionSummary(): ExtensionSummary {
  return {
    mcpServers: [],
    promptPresets: [],
    skills: [],
    discoveredSkills: [],
    skillRegistryProfiles: []
  };
}

function emptyExtensionsByApp(): Record<AgentAppId, ExtensionSummary> {
  return {
    claude: emptyExtensionSummary(),
    codex: emptyExtensionSummary()
  };
}

function emptyUsageSummary(): UsageSummary {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    byApp: [],
    byProvider: [],
    byModel: [],
    byRun: [],
    byCandidate: []
  };
}

function emptyObservabilitySummary(): ObservabilitySummary {
  return {
    usage: emptyUsageSummary(),
    providerHealth: [],
    proxyLogs: [],
    sessions: [],
    sessionPagination: {
      limit: sessionPageSize,
      offset: 0,
      hasMore: false
    }
  };
}

function emptyObservabilityByApp(): Record<AgentAppId, ObservabilitySummary> {
  return {
    claude: emptyObservabilitySummary(),
    codex: emptyObservabilitySummary()
  };
}

function emptyRunJobWorkers(): RunJobWorkerListSummary {
  return {
    workers: [],
    summary: {
      total: 0,
      idle: 0,
      running: 0,
      stale: 0
    }
  };
}

const desktopEnvCleanupSources: EnvCleanupSource[] = [
  "shell_profile",
  "launch_agent",
  "ide_settings"
];

type EditorKind = "mcp" | "prompt" | "skill";
type EditorMode = "create" | "edit";

interface ProviderFormValues {
  app: ProviderAppScope;
  name: string;
  kind: ProviderKind;
  apiFormat: ProviderApiFormat;
  baseUrl: string;
  defaultModel: string;
  wireApi: "" | ProviderWireApi;
  apiKey: string;
  apiKeyEnv: string;
  healthFailureThreshold: string;
  healthCircuitOpenMs: string;
  replayToolCalls: boolean;
  replayReadonlyTools: string;
  replayIdempotentTools: string;
  replaySideEffectTools: string;
  modelCatalog: ProviderModelFormValue[];
  config: Record<string, unknown>;
}

interface ProviderModelFormValue {
  id: string;
  displayName: string;
  contextWindow: string;
  inputTokenUsdPerMillion: string;
  outputTokenUsdPerMillion: string;
  cachedInputTokenUsdPerMillion: string;
  cacheCreationInputTokenUsdPerMillion: string;
  cacheReadInputTokenUsdPerMillion: string;
  reasoningOutputTokenUsdPerMillion: string;
  extra: Record<string, unknown>;
}

interface ProviderEditorState {
  mode: EditorMode;
  item?: ProviderSummary;
  values: ProviderFormValues;
}

interface McpFormValues {
  name: string;
  command: string;
  argsText: string;
  envText: string;
  apps: AgentAppId[];
  enabled: boolean;
}

interface PromptFormValues {
  name: string;
  content: string;
  apps: AgentAppId[];
}

interface SkillFormValues {
  name: string;
  sourcePath: string;
  description: string;
  version: string;
  apps: AgentAppId[];
  enabled: boolean;
}

interface SkillRegistryFormValues {
  profileId: string;
  profileName: string;
  registryUrl: string;
  requireSignature: boolean;
  requireReleaseMetadata: boolean;
  publicKey: string;
  trustedPublicKeysText: string;
  revokedPublicKeyIdsText: string;
}

type ExtensionEditorState =
  | {
      kind: "mcp";
      mode: EditorMode;
      item?: McpServerSummary;
      values: McpFormValues;
    }
  | {
      kind: "prompt";
      mode: EditorMode;
      item?: PromptPresetSummary;
      values: PromptFormValues;
    }
  | {
      kind: "skill";
      mode: EditorMode;
      item?: SkillSummary;
      values: SkillFormValues;
    };

interface ConfirmAction {
  title: string;
  body: string;
  detail?: string;
  diffs?: DryRunActionResult["diffs"];
  confirmLabel: string;
  tone?: "danger" | "normal";
  run: () => Promise<DryRunActionResult | void>;
}

function App() {
  const [status, setStatus] = useState<DesktopStatus>(() =>
    offlineDesktopStatus("loading")
  );
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [providers, setProviders] = useState<Record<AgentAppId, ProviderSummary[]>>({
    claude: [],
    codex: []
  });
  const [providerProbes, setProviderProbes] = useState<Record<string, ProviderProbeSummary>>({});
  const [providerProbeBusy, setProviderProbeBusy] = useState<string | null>(null);
  const [extensions, setExtensions] = useState<Record<AgentAppId, ExtensionSummary>>(
    emptyExtensionsByApp
  );
  const [observability, setObservability] = useState<Record<AgentAppId, ObservabilitySummary>>(
    emptyObservabilityByApp
  );
  const [activeAppId, setActiveAppId] = useState<AgentAppId>("claude");
  const [loading, setLoading] = useState(false);
  const [observabilityLoading, setObservabilityLoading] = useState(false);
  const [proxyHealthResetBusy, setProxyHealthResetBusy] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [providerEditor, setProviderEditor] = useState<ProviderEditorState | null>(null);
  const [editor, setEditor] = useState<ExtensionEditorState | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const providerImportInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailSummary | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionFilters, setSessionFilters] =
    useState<Record<AgentAppId, SessionFilterState>>(emptySessionFilters);
  const [taskRunForm, setTaskRunForm] = useState<TaskRunFormValues>(
    defaultTaskRunForm
  );
  const [capabilities, setCapabilities] = useState<CapabilitiesDocument | null>(null);
  const [workflowCatalog, setWorkflowCatalog] = useState<WorkflowsDocument | null>(null);
  const [harnessProfileCatalog, setHarnessProfileCatalog] =
    useState<HarnessProfilesDocument | null>(null);
  const [specSets, setSpecSets] = useState<SpecRepositoryRecordSummary[]>([]);
  const [specPreview, setSpecPreview] = useState<SpecRevisionSummary | undefined>();
  const [taskControlPlaneLoading, setTaskControlPlaneLoading] = useState(false);
  const [governedProjectView, setGovernedProjectView] =
    useState<GovernedProjectViewSummary | null>(null);
  const [governedProjectLoading, setGovernedProjectLoading] = useState(false);
  const [governedProjectError, setGovernedProjectError] = useState<string | null>(null);
  const [runApprovalBusy, setRunApprovalBusy] = useState(false);
  const [taskRunBusy, setTaskRunBusy] = useState(false);
  const [taskRunError, setTaskRunError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<RunRecordSummary | null>(null);
  const [runEvents, setRunEvents] = useState<RunEventSummary[]>([]);
  const [activeRunUsage, setActiveRunUsage] = useState<UsageSummary>(emptyUsageSummary);
  const [runUsageLoading, setRunUsageLoading] = useState(false);
  const [runResumeBusy, setRunResumeBusy] = useState(false);
  const [workspaceCleanupBusy, setWorkspaceCleanupBusy] = useState(false);
  const [workspaceOpenBusy, setWorkspaceOpenBusy] = useState<string | null>(null);
  const [runArtifacts, setRunArtifacts] = useState<RunArtifactSummary[]>([]);
  const [runArtifactsLoading, setRunArtifactsLoading] = useState(false);
  const [artifactFilters, setArtifactFilters] =
    useState<ArtifactFilterState>(defaultArtifactFilters);
  const [artifactDownloadBusy, setArtifactDownloadBusy] = useState<string | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreviewState | null>(null);
  const [artifactStore, setArtifactStore] = useState<ArtifactStoreSummary | null>(null);
  const [artifactStoreLoading, setArtifactStoreLoading] = useState(false);
  const [artifactStoreCleanup, setArtifactStoreCleanup] =
    useState<ArtifactStoreCleanupSummary | null>(null);
  const [artifactStoreCleanupBusy, setArtifactStoreCleanupBusy] = useState(false);
  const [artifactStoreKeepLatest, setArtifactStoreKeepLatest] = useState("5");
  const [runJobWorkers, setRunJobWorkers] =
    useState<RunJobWorkerListSummary>(emptyRunJobWorkers);
  const [runJobWorkersLoading, setRunJobWorkersLoading] = useState(false);
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings>(
    defaultDesktopSettings
  );
  const desktopSettingsRef = useRef<DesktopSettings>(defaultDesktopSettings);
  const [skillRegistryForm, setSkillRegistryForm] =
    useState<SkillRegistryFormValues>(defaultSkillRegistryForm);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [systemDoctor, setSystemDoctor] = useState<SystemDoctorSummary | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [envCleanup, setEnvCleanup] = useState<EnvCleanupSummary | null>(null);
  const [envCleanupBusy, setEnvCleanupBusy] = useState<"refresh" | "preview" | null>(null);
  const [deepLinkDraft, setDeepLinkDraft] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);
  const [observabilityError, setObservabilityError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setObservabilityLoading(true);
    setArtifactStoreLoading(true);
    setRunJobWorkersLoading(true);
    const claudeSessionFilter = sessionFilters.claude;
    const codexSessionFilter = sessionFilters.codex;
    try {
      const [desktopStatus, runtimeStatus] = await Promise.all([
        fetchDesktopStatus(),
        fetchRuntimeStatus()
      ]);
      const [
        claudeProviders,
        codexProviders,
        claudeExtensions,
        codexExtensions,
        claudeObservability,
        codexObservability,
        artifactStoreSummary,
        workerFleet
      ] = await Promise.all([
        fetchProviders("claude"),
        fetchProviders("codex"),
        fetchExtensions("claude"),
        fetchExtensions("codex"),
        fetchObservability("claude", {
          sessionLimit: sessionPageSize,
          sessionOffset: claudeSessionFilter.offset,
          sessionQuery: claudeSessionFilter.query,
          sessionRedact: claudeSessionFilter.redact
        }),
        fetchObservability("codex", {
          sessionLimit: sessionPageSize,
          sessionOffset: codexSessionFilter.offset,
          sessionQuery: codexSessionFilter.query,
          sessionRedact: codexSessionFilter.redact
        }),
        fetchArtifactStore(),
        fetchRunJobWorkers()
      ]);
      setStatus(desktopStatus);
      setRuntime(runtimeStatus);
      setProviders({
        claude: claudeProviders,
        codex: codexProviders
      });
      setExtensions({
        claude: claudeExtensions,
        codex: codexExtensions
      });
      setObservability({
        claude: claudeObservability,
        codex: codexObservability
      });
      setArtifactStore(artifactStoreSummary);
      setRunJobWorkers(workerFleet);
      setLastError(null);
      setObservabilityError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(offlineDesktopStatus(message));
      setRuntime(null);
      setExtensions(emptyExtensionsByApp());
      setObservability(emptyObservabilityByApp());
      setArtifactStore(null);
      setRunJobWorkers(emptyRunJobWorkers());
      setSessionDetail(null);
      setLastError(message);
    } finally {
      setLoading(false);
      setObservabilityLoading(false);
      setArtifactStoreLoading(false);
      setRunJobWorkersLoading(false);
    }
  }

  async function loadSessionDetail(
    sessionId: string,
    app: AgentAppId,
    redact = sessionFilters[app].redact
  ) {
    setSessionLoading(true);
    setObservabilityError(null);
    try {
      const detail = await fetchSessionDetail(sessionId, app, { redact });
      setSessionDetail(detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessionDetail(null);
      setObservabilityError(message);
    } finally {
      setSessionLoading(false);
    }
  }

  async function loadSessionPage(
    app: AgentAppId,
    query: string,
    offset: number,
    redact = sessionFilters[app].redact
  ) {
    setObservabilityLoading(true);
    setObservabilityError(null);
    try {
      const next = await fetchObservability(app, {
        sessionLimit: sessionPageSize,
        sessionOffset: offset,
        sessionQuery: query,
        sessionRedact: redact
      });
      setObservability((current) => ({
        ...current,
        [app]: {
          ...current[app],
          sessions: next.sessions,
          sessionPagination: next.sessionPagination
        }
      }));
    } catch (error) {
      setObservabilityError(error instanceof Error ? error.message : String(error));
    } finally {
      setObservabilityLoading(false);
    }
  }

  async function resetProviderHealthState(app: AgentAppId, health: ProviderHealthSummary) {
    const busyKey = `${app}:${health.providerId}`;
    setProxyHealthResetBusy(busyKey);
    setObservabilityError(null);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await resetProxyHealth(health.providerId, app);
      const next = await fetchObservability(app, {
        sessionLimit: sessionPageSize,
        sessionOffset: sessionFilters[app].offset,
        sessionQuery: sessionFilters[app].query,
        sessionRedact: sessionFilters[app].redact
      });
      setObservability((current) => ({
        ...current,
        [app]: next
      }));
      setActionMessage(`Proxy health reset: ${result.providerName} (${result.resetCount})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setObservabilityError(message);
    } finally {
      setProxyHealthResetBusy(null);
    }
  }

  async function runProviderProbe(provider: ProviderSummary) {
    setProviderProbeBusy(provider.id);
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await testProviderEndpoint(provider.id);
      setProviderProbes((current) => ({
        ...current,
        [provider.id]: result
      }));
      setActionMessage(
        `${provider.name} ${result.ok ? "测速通过" : "测速失败"} · ${
          result.statusCode ?? result.error ?? "no status"
        }`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
    } finally {
      setProviderProbeBusy(null);
    }
  }

  function updateSessionDraft(app: AgentAppId, draft: string) {
    setSessionFilters((current) => ({
      ...current,
      [app]: {
        ...current[app],
        draft
      }
    }));
  }

  function searchSessions(app: AgentAppId) {
    const query = sessionFilters[app].draft.trim();
    setSessionFilters((current) => ({
      ...current,
      [app]: {
        ...current[app],
        query,
        draft: query,
        offset: 0
      }
    }));
    void loadSessionPage(app, query, 0);
  }

  function clearSessionSearch(app: AgentAppId) {
    setSessionFilters((current) => ({
      ...current,
      [app]: {
        query: "",
        draft: "",
        offset: 0,
        redact: current[app].redact
      }
    }));
    void loadSessionPage(app, "", 0);
  }

  function pageSessions(app: AgentAppId, offset: number) {
    const nextOffset = Math.max(0, offset);
    const query = sessionFilters[app].query;
    setSessionFilters((current) => ({
      ...current,
      [app]: {
        ...current[app],
        offset: nextOffset
      }
    }));
    void loadSessionPage(app, query, nextOffset);
  }

  function toggleSessionRedaction(app: AgentAppId, redact: boolean) {
    const filter = sessionFilters[app];
    setSessionFilters((current) => ({
      ...current,
      [app]: {
        ...current[app],
        redact
      }
    }));
    void loadSessionPage(app, filter.query, filter.offset, redact);
    if (selectedSessionId) {
      void loadSessionDetail(selectedSessionId, app, redact);
    }
  }

  async function loadTaskControlPlaneCatalog() {
    setTaskControlPlaneLoading(true);
    try {
      const [nextCapabilities, nextWorkflows, nextProfiles, nextSpecSets] =
        await Promise.all([
          fetchCapabilities(),
          fetchWorkflows(),
          fetchHarnessProfiles(),
          fetchSpecSets()
        ]);
      setCapabilities(nextCapabilities);
      setWorkflowCatalog(nextWorkflows);
      setHarnessProfileCatalog(nextProfiles);
      setSpecSets(nextSpecSets);
      setTaskRunForm((current) => {
        const workflow = nextWorkflows.workflows.find(
          (item) => item.id === current.workflowId && item.status === "available"
        ) ?? nextWorkflows.workflows.find(
          (item) => item.id === "classic-v1" && item.status === "available"
        ) ?? nextWorkflows.workflows.find((item) => item.status === "available");
        const profile = nextProfiles.harnessProfiles.find(
          (item) => item.id === current.harnessProfileId && item.status === "available"
        ) ?? nextProfiles.harnessProfiles.find(
          (item) => item.id === "local" && item.status === "available"
        ) ?? nextProfiles.harnessProfiles.find((item) => item.status === "available");
        return {
          ...current,
          workflowId: workflow?.id ?? current.workflowId,
          harnessProfileId: profile?.id ?? current.harnessProfileId
        };
      });
    } catch (error) {
      setTaskRunError(`Task capability catalog: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTaskControlPlaneLoading(false);
    }
  }

  async function validateSelectedSpec(): Promise<SpecRevisionSummary | undefined> {
    const revision = Number(taskRunForm.specRevision);
    if (!taskRunForm.specSetId.trim() || !Number.isInteger(revision) || revision < 1) {
      setTaskRunError("Spec set ID 和正整数 revision 必填");
      return undefined;
    }
    setTaskControlPlaneLoading(true);
    setTaskRunError(null);
    try {
      const spec = await fetchSpecRevision(taskRunForm.specSetId.trim(), revision);
      setSpecPreview(spec);
      if (spec.status !== "approved" || !spec.digest) {
        throw new Error(`Spec revision is ${spec.status}; governed runs require approved`);
      }
      if (taskRunForm.specDigest && spec.digest !== taskRunForm.specDigest.trim()) {
        throw new Error("Spec digest does not match the persisted approved revision");
      }
      setTaskRunForm((current) => ({ ...current, specDigest: spec.digest! }));
      return spec;
    } catch (error) {
      setTaskRunError(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setTaskControlPlaneLoading(false);
    }
  }

  async function loadProjectGovernance(
    projectId: string,
    run: RunRecordSummary
  ) {
    setGovernedProjectLoading(true);
    setGovernedProjectError(null);
    try {
      const specRef = run.governanceSnapshot?.specRef ?? run.harnessManifest?.specRef;
      const workflowRef = run.governanceSnapshot?.workflowRef ?? run.workflowRef;
      const harnessProfileRef = run.governanceSnapshot?.harnessProfileRef ??
        run.harnessManifest?.profile;
      setGovernedProjectView(await fetchGovernedProjectView(projectId, {
        ...(specRef ? { specRef } : {}),
        ...(workflowRef ? { workflowRef } : {}),
        ...(harnessProfileRef ? { harnessProfileRef } : {})
      }));
    } catch (error) {
      setGovernedProjectView(null);
      setGovernedProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setGovernedProjectLoading(false);
    }
  }

  async function createAndRunTask() {
    const rootPath = taskRunForm.rootPath.trim();
    const title = taskRunForm.title.trim();
    const prompt = taskRunForm.prompt.trim();
    if (!rootPath || !title || !prompt) {
      setTaskRunError("Project root、Title 和 Prompt 必填");
      return;
    }

    setTaskRunBusy(true);
    setTaskRunError(null);
    setActionMessage(null);
    setActionError(null);
    try {
      const workflow = workflowCatalog?.workflows.find(
        (item) => item.id === taskRunForm.workflowId && item.status === "available"
      );
      if (!workflow?.digest) {
        throw new Error("请选择 API 声明为 available 的 workflow");
      }
      const workflowCapability = capabilities?.workflows.find(
        (item) =>
          item.id === workflow.id &&
          item.version === workflow.version &&
          item.digest === workflow.digest &&
          item.status === "available"
      );
      if (!workflowCapability) {
        throw new Error("Workflow catalog and /v1/capabilities disagree; refusing to run");
      }
      const governed = isGovernedWorkflow(workflow.id, workflowCatalog);
      const spec = governed ? await validateSelectedSpec() : undefined;
      if (governed && (!spec || !spec.digest)) return;
      const profile = governed
        ? harnessProfileCatalog?.harnessProfiles.find(
            (item) =>
              item.id === taskRunForm.harnessProfileId && item.status === "available"
          )
        : undefined;
      if (governed && !profile?.digest) {
        throw new Error("Governed workflow 需要 API 声明为 available 的 Harness profile");
      }
      if (
        profile &&
        !capabilities?.harnessProfiles.some(
          (item) =>
            item.id === profile.id &&
            item.version === profile.version &&
            item.digest === profile.digest &&
            item.status === "available"
        )
      ) {
        throw new Error("Harness profile catalog and /v1/capabilities disagree; refusing to run");
      }
      const workflowRef = {
        id: workflow.id,
        version: workflow.version,
        digest: workflow.digest
      };
      const harnessProfileRef = profile?.digest
        ? { id: profile.id, version: profile.version, digest: profile.digest }
        : undefined;
      const specRef = spec?.digest
        ? { specSetId: spec.specSetId, revision: spec.revision, digest: spec.digest }
        : undefined;
      const projectName =
        taskRunForm.projectName.trim() || rootPath.split(/[\\/]/).filter(Boolean).at(-1) || "desktop-project";
      const project = await createProject({
        name: projectName,
        rootPath,
        defaultBranch: "main"
      });
      const indexedProject = await indexProject(project.id);
      const requestedService = taskRunForm.targetService.trim();
      const targetServices = requestedService
        ? [requestedService]
        : indexedProject.services[0]
          ? [indexedProject.services[0].name]
          : [];
      const acceptanceCriteria = taskRunForm.acceptanceText
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
      const controlPlaneView = await fetchGovernedProjectView(indexedProject.id, {
        ...(specRef ? { specRef } : {}),
        workflowRef,
        ...(harnessProfileRef ? { harnessProfileRef } : {})
      });
      setGovernedProjectView(controlPlaneView);
      setGovernedProjectError(null);
      const effectivePolicy = controlPlaneView.governance!.snapshot.policy;
      const providerCapability = capabilities?.providers.find(
        (item) => item.id === activeAppId && item.status === "available"
      );
      if (!providerCapability) {
        throw new Error(`${activeAppId} provider capability is not available`);
      }
      if (
        effectivePolicy.allowedProviders &&
        !effectivePolicy.allowedProviders.includes(activeAppId)
      ) {
        throw new Error(
          `${activeAppId} is denied by effective governance; allowed: ${effectivePolicy.allowedProviders.join(", ")}`
        );
      }
      const availableGates = new Set(
        capabilities?.gates
          .filter((gate) => gate.status === "available")
          .map((gate) => gate.id) ?? []
      );
      const missingGates = effectivePolicy.requiredGates.filter(
        (gate) => !availableGates.has(gate)
      );
      if (missingGates.length > 0) {
        throw new Error(`Required Gate runner unavailable: ${missingGates.join(", ")}`);
      }
      const candidateText = taskRunForm.candidates.trim();
      const candidates = candidateText ? Number(candidateText) : undefined;
      if (governed && candidates === undefined) {
        throw new Error("Governed workflow 需要显式 Candidates，并受有效规范上限约束");
      }
      if (candidates !== undefined && (!Number.isInteger(candidates) || candidates < 1)) {
        throw new Error("Candidates 必须是正整数或留空使用服务端默认值");
      }
      const maxCandidates = effectivePolicy.budgets.maxCandidates;
      if (candidates !== undefined && maxCandidates !== undefined && candidates > maxCandidates) {
        throw new Error(`Candidates ${candidates} exceeds effective governance max ${maxCandidates}`);
      }
      const task = await createTask({
        projectId: indexedProject.id,
        title,
        prompt,
        targetServices,
        acceptanceCriteria,
        provider: activeAppId,
        ...(candidates !== undefined ? { candidates } : {}),
        requiredGates: effectivePolicy.requiredGates,
        humanApproval: effectivePolicy.approvalMode,
        ...(specRef ? { specRef } : {}),
        workflowRef,
        ...(harnessProfileRef ? { harnessProfileRef } : {})
      });
      const run = await createRun(task.id);
      const events = await fetchRunEvents(run.id);
      setActiveRun(run);
      setRunEvents(events);
      setArtifactPreview(null);
      setArtifactFilters(defaultArtifactFilters);
      setSpecPreview(spec);
      void loadRunUsage(run.id);
      void loadRunArtifacts(run.id, defaultArtifactFilters);
      setActionMessage(`Run ${run.status}: ${run.id.slice(0, 8)}`);
      void loadProjectGovernance(indexedProject.id, run);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaskRunError(message);
    } finally {
      setTaskRunBusy(false);
    }
  }

  async function loadRunDetail(runId: string) {
    setTaskRunBusy(true);
    setRunUsageLoading(true);
    setTaskRunError(null);
    try {
      const [run, events, usage] = await Promise.all([
        fetchRun(runId),
        fetchRunEvents(runId),
        fetchRunUsageSummary(runId)
      ]);
      setActiveRun(run);
      setRunEvents(events);
      setActiveRunUsage(usage);
      setArtifactPreview(null);
      setArtifactFilters(defaultArtifactFilters);
      void loadRunArtifacts(run.id, defaultArtifactFilters);
      void loadProjectGovernance(run.projectId, run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaskRunError(message);
    } finally {
      setTaskRunBusy(false);
      setRunUsageLoading(false);
    }
  }

  async function loadRunUsage(runId: string) {
    setRunUsageLoading(true);
    try {
      setActiveRunUsage(await fetchRunUsageSummary(runId));
    } catch {
      setActiveRunUsage(emptyUsageSummary());
    } finally {
      setRunUsageLoading(false);
    }
  }

  async function loadRunArtifacts(
    runId: string,
    filters: ArtifactFilterState = artifactFilters
  ) {
    setRunArtifactsLoading(true);
    try {
      setRunArtifacts(await fetchRunArtifacts(runId, toRunArtifactFilters(filters)));
      void loadArtifactStore(true);
    } catch {
      setRunArtifacts([]);
    } finally {
      setRunArtifactsLoading(false);
    }
  }

  function updateArtifactFilters(filters: ArtifactFilterState) {
    setArtifactFilters(filters);
    setArtifactPreview(null);
    if (activeRun) void loadRunArtifacts(activeRun.id, filters);
  }

  async function loadArtifactStore(silent = false) {
    if (!silent) setArtifactStoreLoading(true);
    try {
      setArtifactStore(await fetchArtifactStore());
      if (!silent) setArtifactStoreCleanup(null);
    } catch (error) {
      if (!silent) {
        setTaskRunError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!silent) setArtifactStoreLoading(false);
    }
  }

  async function loadRunJobWorkers(silent = false) {
    if (!silent) setRunJobWorkersLoading(true);
    try {
      setRunJobWorkers(await fetchRunJobWorkers());
      if (!silent) setTaskRunError(null);
    } catch (error) {
      if (!silent) {
        setTaskRunError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!silent) setRunJobWorkersLoading(false);
    }
  }

  function parsedArtifactStoreKeepLatest(): number | null {
    const value = Number(artifactStoreKeepLatest);
    if (!Number.isInteger(value) || value < 0) return null;
    return value;
  }

  async function previewArtifactStoreCleanup() {
    const keepLatestRuns = parsedArtifactStoreKeepLatest();
    if (keepLatestRuns === null) {
      setTaskRunError("Keep latest runs 必须是非负整数");
      return;
    }
    setArtifactStoreCleanupBusy(true);
    setTaskRunError(null);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await cleanupArtifactStore({
        dryRun: true,
        keepLatestRuns
      });
      setArtifactStoreCleanup(result);
      setActionMessage(
        `Artifact store cleanup preview: ${result.candidateRuns} candidates`
      );
    } catch (error) {
      setTaskRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setArtifactStoreCleanupBusy(false);
    }
  }

  async function confirmArtifactStoreCleanup() {
    const keepLatestRuns = parsedArtifactStoreKeepLatest();
    if (keepLatestRuns === null) {
      setTaskRunError("Keep latest runs 必须是非负整数");
      return;
    }
    const confirmed = window.confirm(
      `Delete artifact store runs outside latest ${keepLatestRuns}?`
    );
    if (!confirmed) return;

    setArtifactStoreCleanupBusy(true);
    setTaskRunError(null);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await cleanupArtifactStore({
        dryRun: false,
        keepLatestRuns
      });
      setArtifactStoreCleanup(result);
      setActionMessage(
        `Artifact store cleanup: ${result.deleted.length} deleted`
      );
      await loadArtifactStore(true);
    } catch (error) {
      setTaskRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setArtifactStoreCleanupBusy(false);
    }
  }

  async function downloadActiveRunArtifact(artifact: RunArtifactSummary) {
    if (!activeRun) return;
    setArtifactDownloadBusy(artifact.id);
    setTaskRunError(null);
    setActionMessage(null);
    setActionError(null);
    try {
      const content = await downloadRunArtifact(activeRun.id, artifact.id);
      const disposition = await saveRunArtifactDownload(content);
      if (disposition.status === "cancelled") return;
      setArtifactPreview({
        artifactId: artifact.id,
        filename: content.filename,
        contentType: content.contentType,
        bytes: content.bytes,
        text: content.text
      });
      const verb = disposition.mode === "native" ? "saved" : "downloaded";
      setActionMessage(`Artifact ${verb}: ${content.filename}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaskRunError(message);
    } finally {
      setArtifactDownloadBusy(null);
    }
  }

  async function downloadActiveRunArtifactsArchive() {
    if (!activeRun) return;
    setArtifactDownloadBusy("__archive__");
    setTaskRunError(null);
    setActionMessage(null);
    setActionError(null);
    try {
      const content = await downloadRunArtifactsArchive(
        activeRun.id,
        toRunArtifactFilters(artifactFilters)
      );
      const disposition = await saveRunArtifactDownload(content);
      if (disposition.status === "cancelled") return;
      setArtifactPreview({
        artifactId: content.artifactId,
        filename: content.filename,
        contentType: content.contentType,
        bytes: content.bytes
      });
      const verb = disposition.mode === "native" ? "saved" : "downloaded";
      setActionMessage(`Artifacts archive ${verb}: ${content.filename}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaskRunError(message);
    } finally {
      setArtifactDownloadBusy(null);
    }
  }

  async function cancelActiveRun() {
    if (!activeRun || isRunTerminal(activeRun.status)) return;
    setTaskRunBusy(true);
    setTaskRunError(null);
    try {
      const run = await cancelRun(activeRun.id);
      const [events, usage] = await Promise.all([
        fetchRunEvents(run.id),
        fetchRunUsageSummary(run.id)
      ]);
      setActiveRun(run);
      setRunEvents(events);
      setActiveRunUsage(usage);
      setActionMessage(`Run cancelled: ${run.id.slice(0, 8)}`);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaskRunError(message);
    } finally {
      setTaskRunBusy(false);
    }
  }

  async function decideActiveRun(decision: "approve" | "reject") {
    if (!activeRun || activeRun.status !== "waiting_approval") return;
    setRunApprovalBusy(true);
    setTaskRunError(null);
    try {
      const run = await decideRunApproval(activeRun.id, decision);
      const [events, usage, artifacts] = await Promise.all([
        fetchRunEvents(run.id),
        fetchRunUsageSummary(run.id),
        fetchRunArtifacts(run.id)
      ]);
      setActiveRun(run);
      setRunEvents(events);
      setActiveRunUsage(usage);
      setRunArtifacts(artifacts);
      setActionMessage(
        decision === "approve"
          ? `Run approved: ${run.id.slice(0, 8)}`
          : `Run rejected: ${run.id.slice(0, 8)}`
      );
      void loadProjectGovernance(run.projectId, run);
      await refresh();
    } catch (error) {
      setTaskRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunApprovalBusy(false);
    }
  }

  async function resumeActiveRun() {
    if (!activeRun || !isRunResumable(activeRun.status)) return;
    setRunResumeBusy(true);
    setTaskRunError(null);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await resumeRun(activeRun.id);
      const nextFilters = defaultArtifactFilters;
      const [events, usage, artifacts] = await Promise.all([
        fetchRunEvents(result.run.id),
        fetchRunUsageSummary(result.run.id),
        fetchRunArtifacts(result.run.id, toRunArtifactFilters(nextFilters))
      ]);
      setActiveRun(result.run);
      setRunEvents(events);
      setActiveRunUsage(usage);
      setRunArtifacts(artifacts);
      setArtifactFilters(nextFilters);
      setArtifactPreview(null);
      setActionMessage(`Run resumed: ${result.run.id.slice(0, 8)}`);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaskRunError(message);
    } finally {
      setRunResumeBusy(false);
    }
  }

  async function cleanupActiveRun() {
    if (!activeRun || !isRunTerminal(activeRun.status)) return;
    const confirmed = window.confirm(
      `Clean workspaces for run ${activeRun.id.slice(0, 8)}?`
    );
    if (!confirmed) return;

    setWorkspaceCleanupBusy(true);
    setTaskRunError(null);
    setActionMessage(null);
    setActionError(null);
    try {
      const cleanup = await cleanupRunWorkspaces(activeRun.id);
      const [run, events, usage] = await Promise.all([
        fetchRun(activeRun.id),
        fetchRunEvents(activeRun.id),
        fetchRunUsageSummary(activeRun.id)
      ]);
      const deletedCount = cleanup.results.filter((item) => item.status === "deleted").length;
      const skippedCount = cleanup.results.length - deletedCount;
      setActiveRun(run);
      setRunEvents(events);
      setActiveRunUsage(usage);
      setActionMessage(
        `Workspace cleanup completed: ${deletedCount} deleted, ${skippedCount} skipped`
      );
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaskRunError(message);
    } finally {
      setWorkspaceCleanupBusy(false);
    }
  }

  async function openCandidateWorkspace(candidate: RunRecordSummary["candidates"][number]) {
    if (!candidate.worktreePath) return;
    setWorkspaceOpenBusy(candidate.id);
    setActionMessage(null);
    setActionError(null);
    try {
      if (isTauri()) {
        await openPath(candidate.worktreePath);
        setActionMessage(`Workspace opened: ${shortPath(candidate.worktreePath)}`);
      } else {
        setActionMessage(`Workspace path: ${candidate.worktreePath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`Workspace open failed: ${message}`);
    } finally {
      setWorkspaceOpenBusy(null);
    }
  }

  async function loadDesktopSettings() {
    try {
      const settings = await fetchDesktopSettings();
      configureApiUrl(settings.apiUrl);
      const launchAtLogin = await readLaunchAtLoginPreference(settings.launchAtLogin);
      setDesktopSettings({ ...settings, launchAtLogin });
      setSettingsError(null);
      await Promise.all([refresh(), loadTaskControlPlaneCatalog()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
    }
  }

  async function saveSettings() {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const saved = await saveDesktopSettings(desktopSettings);
      configureApiUrl(saved.apiUrl);
      const launchAtLogin = await syncLaunchAtLogin(saved.launchAtLogin);
      setDesktopSettings({ ...saved, launchAtLogin: launchAtLogin.enabled });
      const launchMessage =
        launchAtLogin.mode === "native"
          ? `开机自启已${launchAtLogin.enabled ? "启用" : "关闭"}`
          : "开机自启偏好已保存";
      setActionMessage(`桌面设置已保存；${launchMessage}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
    } finally {
      setSettingsBusy(false);
    }
  }

  async function loadSystemDoctor(silent = false) {
    if (!silent) setDoctorLoading(true);
    try {
      setSystemDoctor(await fetchSystemDoctor());
      if (!silent) setSettingsError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!silent) setSettingsError(message);
    } finally {
      if (!silent) setDoctorLoading(false);
    }
  }

  async function refreshSystemDoctor() {
    setEnvCleanupBusy("refresh");
    setEnvCleanup(null);
    await loadSystemDoctor();
    setEnvCleanupBusy(null);
  }

  async function exportDiagnostics() {
    setActionBusy("diagnostics:export");
    setSettingsError(null);
    setActionMessage(null);
    setActionError(null);
    try {
      const diagnostics = await fetchSystemDiagnostics();
      setSystemDoctor(diagnostics.doctor);
      const exportedAt = new Date().toISOString();
      const document = buildDiagnosticsExport({
        exportedAt,
        apiUrl: resolveApiUrl(),
        settings: desktopSettings,
        runtime,
        diagnostics
      });
      const disposition = await saveJsonDownload(
        `mniu-diagnostics-${exportedAt.replace(/[:.]/g, "-")}.json`,
        document
      );
      if (disposition.status === "cancelled") return;
      const verb = disposition.mode === "native" ? "saved" : "downloaded";
      setActionMessage(`Diagnostics ${verb}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(`Diagnostics export failed: ${message}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function previewEnvCleanup() {
    setEnvCleanupBusy("preview");
    setSettingsError(null);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await cleanupEnvConflicts({
        dryRun: true,
        sources: desktopEnvCleanupSources
      });
      setEnvCleanup(result);
      setActionMessage(
        `Env cleanup preview: ${result.removed.length} lines, ${result.manualActions?.length ?? 0} manual actions`
      );
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setEnvCleanupBusy(null);
    }
  }

  async function prepareEnvCleanupConfirm() {
    setActionBusy("env-cleanup:confirm");
    setActionMessage(null);
    setActionError(null);
    setSettingsError(null);
    try {
      const preview = envCleanup?.dryRun
        ? envCleanup
        : await cleanupEnvConflicts({ dryRun: true, sources: desktopEnvCleanupSources });
      setEnvCleanup(preview);
      const manualCount = preview.manualActions?.length ?? 0;
      if (preview.removed.length === 0 && manualCount === 0) {
        setActionMessage("Env cleanup: no managed env entries to remove");
        return;
      }
      if (preview.removed.length === 0) {
        setActionMessage(`Env cleanup: ${manualCount} manual process.env actions available`);
        return;
      }
      setConfirmAction({
        title: "确认环境变量清理",
        body: describeEnvCleanupResult(preview),
        detail: envCleanupDetail(preview),
        confirmLabel: "清理",
        tone: "danger",
        run: async () => {
          const result = await cleanupEnvConflicts({
            dryRun: false,
            sources: desktopEnvCleanupSources
          });
          setEnvCleanup(result);
          await loadSystemDoctor(true);
          return envCleanupActionResult(result);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`Env cleanup preview failed: ${message}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function runMutation(
    key: string,
    label: string,
    action: () => Promise<unknown>,
    options: { refreshAfter?: boolean } = {}
  ): Promise<boolean> {
    setActionBusy(key);
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await action();
      if (result === mutationSkipped) {
        return true;
      }
      if (options.refreshAfter ?? true) {
        await refresh();
      }
      setActionMessage(label);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
      return false;
    } finally {
      setActionBusy(null);
    }
  }

  async function prepareConfirmedWrite(
    key: string,
    title: string,
    dryRun: () => Promise<DryRunActionResult>,
    run: () => Promise<DryRunActionResult>
  ) {
    setActionBusy(key);
    setActionMessage(null);
    setActionError(null);
    try {
      const preview = await dryRun();
      setConfirmAction({
        title,
        body: describePreview(preview),
        detail: preview.targetPath,
        diffs: preview.diffs,
        confirmLabel: "确认写入",
        run
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`预览失败: ${message}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function confirmCurrentAction() {
    if (!confirmAction) return;
    const action = confirmAction;
    const ok = await runMutation("confirm:write", `${action.title} 已完成`, async () => {
      const result = await action.run();
      if (result && typeof result === "object" && "label" in result) {
        setActionMessage(describePreview(result));
      }
    });
    if (ok) setConfirmAction(null);
  }

  function openProviderCreateEditor() {
    setProviderEditor({
      mode: "create",
      values: defaultProviderValues(activeAppId)
    });
  }

  function openProviderEditEditor(provider: ProviderSummary) {
    setProviderEditor({
      mode: "edit",
      item: provider,
      values: providerValuesFromSummary(provider)
    });
  }

  async function saveProviderEditor() {
    if (!providerEditor) return;
    const validationError = validateProviderValues(providerEditor.values);
    if (validationError) {
      setActionError(validationError);
      return;
    }
    const key = `provider:form:${providerEditor.mode}`;
    const ok = await runMutation(key, "Provider 已保存", async () => {
      if (providerEditor.mode === "edit" && providerEditor.item) {
        await updateProvider(
          providerEditor.item.id,
          providerPatchInputFromValues(providerEditor.values)
        );
      } else {
        await createProvider(providerInputFromValues(providerEditor.values));
      }
    });
    if (ok) setProviderEditor(null);
  }

  function downloadProviderExport() {
    void runMutation(
      `provider:export:${activeAppId}`,
      "Provider 导出已下载",
      async () => {
        const document = await exportProviders(activeAppId);
        const disposition = await saveJsonDownload(
          `mniu-${activeAppId}-providers.json`,
          document
        );
        if (disposition.status === "cancelled") return mutationSkipped;
      },
      { refreshAfter: false }
    );
  }

  function downloadActiveSessionExport() {
    if (!selectedSessionId) return;
    const app = activeAppId;
    const sessionId = selectedSessionId;
    const redact = sessionFilters[app].redact;
    void runMutation(
      sessionExportActionKey(app, sessionId),
      "Session 导出已下载",
      async () => {
        const document = await exportSession(sessionId, app, { redact });
        const disposition = await saveJsonDownload(
          `mniu-${app}-session-${safeDownloadName(sessionId)}.json`,
          document
        );
        if (disposition.status === "cancelled") return mutationSkipped;
      },
      { refreshAfter: false }
    );
  }

  function openProviderImportPicker() {
    providerImportInputRef.current?.click();
  }

  async function handleProviderImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setActionBusy("provider:import");
    setActionMessage(null);
    setActionError(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const preview = await importProviders(parsed, true);
      setConfirmAction({
        title: "确认 Provider 导入",
        body: describeProviderImportResult(preview),
        detail: file.name,
        confirmLabel: "导入",
        run: async () => providerImportActionResult(await importProviders(parsed, false))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConfirmAction(null);
      setActionError(`导入预览失败: ${message}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function prepareDeepLinkImport(rawUrl = deepLinkDraft) {
    const url = rawUrl.trim();
    if (!url) {
      setActionError("Deep Link URL 必填");
      return;
    }
    setDeepLinkDraft(url);
    setActionBusy("deep-link:preview");
    setActionMessage(null);
    setActionError(null);
    try {
      const preview = await previewDeepLinkImport(url);
      setConfirmAction({
        title: "确认 Deep Link 导入",
        body: describeDeepLinkImportResult(preview),
        detail: url,
        confirmLabel: "导入",
        run: async () => deepLinkImportActionResult(await importDeepLink(url, false))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConfirmAction(null);
      setActionError(`Deep Link 预览失败: ${message}`);
    } finally {
      setActionBusy(null);
    }
  }

  function confirmProviderEnable(provider: ProviderSummary) {
    const appTarget = provider.app === "unified" ? activeAppId : provider.app;
    void prepareProviderEnablePreview(provider, appTarget);
  }

  async function prepareProviderEnablePreview(
    provider: ProviderSummary,
    appTarget: AgentAppId
  ) {
    setActionBusy(`provider:enable:${provider.id}`);
    setActionMessage(null);
    setActionError(null);
    try {
      const preview = await previewProviderEnable(provider.id, appTarget);
      setConfirmAction({
        title: "确认 Provider 启用",
        body: describePreview(preview),
        detail: preview.targetPath,
        diffs: preview.diffs,
        confirmLabel: "启用",
        run: async () => enableProvider(provider.id, appTarget)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConfirmAction(null);
      setActionError(`预览失败: ${message}`);
    } finally {
      setActionBusy(null);
    }
  }

  async function prepareProviderRestore(provider: ProviderSummary) {
    const appTarget = provider.app === "unified" ? activeAppId : provider.app;
    setActionBusy(`provider:restore:${provider.id}`);
    setActionMessage(null);
    setActionError(null);
    try {
      const preview = await restoreProvider(provider.id, appTarget, true);
      setConfirmAction({
        title: "恢复 Provider 配置",
        body: `${provider.name} 将恢复启用前的配置`,
        detail: preview.targetPath,
        confirmLabel: "恢复",
        run: async () => restoreProvider(provider.id, appTarget, false)
      });
    } catch (error) {
      setConfirmAction(null);
      setActionError(`恢复预览失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setActionBusy(null);
    }
  }

  function duplicateProviderRow(provider: ProviderSummary) {
    void runMutation(
      `provider:duplicate:${provider.id}`,
      `${provider.name} 已复制`,
      () => duplicateProvider(provider.id, `${provider.name} Copy`)
    );
  }

  function confirmDeleteProvider(provider: ProviderSummary) {
    setConfirmAction({
      title: "删除 Provider",
      body: provider.name,
      confirmLabel: "删除",
      tone: "danger",
      run: async () => {
        await deleteProvider(provider.id);
      }
    });
  }

  function openCreateEditor(kind: EditorKind) {
    setEditor(createEditor(kind, activeAppId));
  }

  function openEditEditor(item: McpServerSummary | PromptPresetSummary | SkillSummary, kind: EditorKind) {
    setEditor(editEditor(kind, item));
  }

  async function saveEditor() {
    if (!editor) return;
    const key = `form:${editor.kind}:${editor.mode}`;
    const ok = await runMutation(key, `${editorLabel(editor.kind)} 已保存`, async () => {
      if (editor.kind === "mcp") {
        if (editor.mode === "edit" && editor.item) {
          await updateMcpServer(editor.item.id, mcpPatchInputFromValues(editor.values));
        } else {
          await createMcpServer(mcpInputFromValues(editor.values));
        }
      } else if (editor.kind === "prompt") {
        const input = promptInputFromValues(editor.values);
        if (editor.mode === "edit" && editor.item) {
          await updatePromptPreset(editor.item.id, input);
        } else {
          await createPromptPreset(input);
        }
      } else {
        const input = skillInputFromValues(editor.values);
        if (editor.mode === "edit" && editor.item) {
          await updateSkill(editor.item.id, input);
        } else {
          await createSkill(input);
        }
      }
    });
    if (ok) setEditor(null);
  }

  function confirmDelete(kind: EditorKind, id: string, name: string) {
    setConfirmAction({
      title: `删除 ${editorLabel(kind)}`,
      body: name,
      confirmLabel: "删除",
      tone: "danger",
      run: async () => {
        if (kind === "mcp") {
          await deleteMcpServer(id);
        } else if (kind === "prompt") {
          await deletePromptPreset(id);
        } else {
          await deleteSkill(id);
        }
      }
    });
  }

  function selectSkillRegistryProfile(profileId: string) {
    if (!profileId) {
      setSkillRegistryForm({
        ...defaultSkillRegistryForm,
        registryUrl: skillRegistryForm.registryUrl,
        requireSignature: skillRegistryForm.requireSignature,
        requireReleaseMetadata: skillRegistryForm.requireReleaseMetadata,
        publicKey: skillRegistryForm.publicKey,
        trustedPublicKeysText: skillRegistryForm.trustedPublicKeysText,
        revokedPublicKeyIdsText: skillRegistryForm.revokedPublicKeyIdsText
      });
      return;
    }
    const profile = extensions[activeAppId].skillRegistryProfiles.find(
      (item) => item.id === profileId
    );
    if (!profile) return;
    setSkillRegistryForm(skillRegistryFormFromProfile(profile));
  }

  async function saveSkillRegistryProfile() {
    if (!skillRegistryForm.profileName.trim()) {
      setActionError("Registry profile name 不能为空");
      return;
    }
    const input = skillRegistryInputFromValues(skillRegistryForm);
    if (!input.registryUrl) {
      setActionError("Registry URL 不能为空");
      return;
    }
    const ok = await runMutation(
      "skill:registry:profile:save",
      "Registry profile 已保存",
      async () => {
        const profile = await createSkillRegistryProfile({
          name: skillRegistryForm.profileName,
          ...input
        });
        setSkillRegistryForm(skillRegistryFormFromProfile(profile));
      }
    );
    if (ok) {
      setActionError(null);
    }
  }

  async function prepareSkillRegistrySync() {
    const input = skillRegistryInputFromValues(skillRegistryForm);
    if (!input.registryUrl) {
      setActionError("Registry URL 不能为空");
      return;
    }
    if (skillRegistryForm.profileId) {
      await prepareConfirmedWrite(
        "skill:registry:sync",
        "确认 Skill Registry 同步",
        () => previewSkillRegistryProfileSync(skillRegistryForm.profileId),
        () => syncSkillRegistryProfile(skillRegistryForm.profileId)
      );
      return;
    }
    await prepareConfirmedWrite(
      "skill:registry:sync",
      "确认 Skill Registry 同步",
      () => previewSkillRegistrySync(input),
      () => syncSkillRegistry(input)
    );
  }

  useEffect(() => {
    void refresh();
    void loadDesktopSettings();
    void loadSystemDoctor();
    const daemonStartupRetry = window.setTimeout(() => void refresh(), 1_500);
    return () => window.clearTimeout(daemonStartupRetry);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    void Promise.all([
      listen<{ app: AgentAppId; providerId: string }>("tray-provider-preview", (event) => {
        void fetchProviders(event.payload.app)
          .then((items) => {
            const provider = items.find((item) => item.id === event.payload.providerId);
            if (!provider) {
              throw new Error("Provider 不存在或已被删除");
            }
            return prepareProviderEnablePreview(provider, event.payload.app);
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            setActionError(`托盘 Provider 预览失败: ${message}`);
          });
      }),
      listen<string>("tray-provider-error", (event) => {
        setActionError(`托盘 Provider 切换失败: ${event.payload}`);
      }),
      listen<string>("tray-action-error", (event) => {
        setActionError(`托盘操作失败: ${event.payload}`);
      }),
      listen<{ running: boolean }>("tray-proxy-changed", (event) => {
        setActionMessage(`本地代理已${event.payload.running ? "启动" : "停止"}`);
        void refresh();
      })
    ]).then((listeners) => {
      if (cancelled) listeners.forEach((cleanup) => cleanup());
      else cleanups.push(...listeners);
    });
    return () => {
      cancelled = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => {
    desktopSettingsRef.current = desktopSettings;
  }, [desktopSettings]);

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const currentWindow = getCurrentWindow();

    void currentWindow
      .onCloseRequested(async (event) => {
        const closeBehavior = desktopSettingsRef.current.closeBehavior;
        if (closeBehavior === "quit") return;

        event.preventDefault();
        try {
          if (closeBehavior === "lightweight") {
            setActionError(null);
            setActionMessage("主窗口已销毁，托盘保持轻量模式运行");
            const handledByNativeCommand = await enterDesktopLightweightMode();
            if (!handledByNativeCommand) {
              await currentWindow.destroy();
            }
            return;
          }

          await currentWindow.hide();
          setActionError(null);
          setActionMessage("窗口已隐藏到托盘");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setActionError(`Window close behavior failed: ${message}`);
        }
      })
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(`Window close behavior unavailable: ${message}`);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void getCurrent()
      .then((urls) => {
        const url = urls?.[0];
        if (!cancelled && url) void prepareDeepLinkImport(url);
      })
      .catch(() => {});

    void onOpenUrl((urls) => {
      const url = urls[0];
      if (url) void prepareDeepLinkImport(url);
    })
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!activeRun || isRunTerminal(activeRun.status)) return;
    let cancelled = false;
    let terminalRefreshDone = false;

    async function pollRun() {
      if (!activeRun || cancelled) return;
      try {
        const [run, events, usage] = await Promise.all([
          fetchRun(activeRun.id),
          fetchRunEvents(activeRun.id),
          fetchRunUsageSummary(activeRun.id)
        ]);
        if (cancelled) return;
        setActiveRun(run);
        setRunEvents(events);
        setActiveRunUsage(usage);
        if (isRunTerminal(run.status)) {
          void loadRunArtifacts(run.id);
          if (run.governanceSnapshot || run.stages?.length || run.gateResultsV2?.length) {
            void loadProjectGovernance(run.projectId, run);
          }
        }
        if (isRunTerminal(run.status) && !terminalRefreshDone) {
          terminalRefreshDone = true;
          await refresh();
        }
      } catch (error) {
        if (!cancelled) {
          setTaskRunError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void pollRun();
    const timer = window.setInterval(() => {
      void pollRun();
    }, 1_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRun?.id, activeRun?.status]);

  useEffect(() => {
    const sessions = observability[activeAppId].sessions;
    const nextSessionId = sessions.some((session) => session.id === selectedSessionId)
      ? selectedSessionId
      : sessions[0]?.id ?? null;
    setSelectedSessionId(nextSessionId);
    if (nextSessionId) {
      void loadSessionDetail(nextSessionId, activeAppId);
    } else {
      setSessionDetail(null);
    }
  }, [activeAppId, observability]);

  const activeApp = useMemo(
    () =>
      status.apps.find((app) => app.id === activeAppId) ??
      status.apps.find((app) => app.id === "claude")!,
    [activeAppId, status.apps]
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">木</div>
          <div>
            <h1>木牛</h1>
            <p>Claude Code / Codex</p>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          <a className="nav-item active" href="#overview">
            <Activity size={18} />
            <span>总览</span>
          </a>
          <a className="nav-item" href="#providers">
            <Database size={18} />
            <span>供应商</span>
          </a>
          <a className="nav-item" href="#extensions">
            <PlugZap size={18} />
            <span>扩展</span>
          </a>
          <a className="nav-item" href="#proxy">
            <Network size={18} />
            <span>本地代理</span>
          </a>
          <a className="nav-item" href="#observability">
            <BarChart3 size={18} />
            <span>观测</span>
          </a>
          <a className="nav-item" href="#tasks">
            <Bot size={18} />
            <span>任务</span>
          </a>
          <a className="nav-item" href="#settings">
            <Settings size={18} />
            <span>设置</span>
          </a>
        </nav>

        <div className="runtime-box">
          <div className="runtime-row">
            <MonitorCog size={17} />
            <span>{runtime?.runtime ?? "Browser preview"}</span>
          </div>
          <div className="runtime-row">
            <Power size={17} />
            <span>{status.proxy.status === "running" ? "Proxy running" : "Proxy stopped"}</span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Mac Desktop</p>
            <h2>Claude Code 与 Codex 控制台</h2>
          </div>
          <div className="topbar-actions">
            <StatusPill ok={status.api.ok} label={status.api.ok ? "API online" : "API offline"} />
            <button className="icon-button" type="button" title="刷新" onClick={refresh}>
              <RefreshCw size={18} className={loading ? "spin" : ""} />
            </button>
          </div>
        </header>

        <section className="summary-grid" id="overview">
          <MetricPanel
            icon={<Terminal size={21} />}
            label="API"
            value={status.api.service}
            detail={resolveApiUrl()}
            tone={status.api.ok ? "good" : "danger"}
          />
          <MetricPanel
            icon={<Network size={21} />}
            label="本地代理"
            value={`${status.proxy.status} :${status.proxy.port}`}
            detail={`${status.proxy.takenOverApps.length} apps taken over`}
            tone={status.proxy.status === "running" ? "good" : "neutral"}
          />
          <MetricPanel
            icon={<Cpu size={21} />}
            label="Executor"
            value={status.api.executorMode}
            detail={status.api.workspaceRoot}
            tone="accent"
          />
        </section>

        {lastError ? (
          <div className="notice" role="status">
            <CircleAlert size={18} />
            <span>{lastError}</span>
          </div>
        ) : null}

        {actionMessage ? (
          <div className="action-note" role="status">
            <CheckCircle2 size={18} />
            <span>{actionMessage}</span>
          </div>
        ) : null}

        {actionError ? (
          <div className="notice" role="status">
            <CircleAlert size={18} />
            <span>{actionError}</span>
          </div>
        ) : null}

        <section className="content-grid">
          <div className="panel agent-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Applications</p>
                <h3>托管应用</h3>
              </div>
              <div className="segmented" role="tablist" aria-label="托管应用">
                {agentOrder.map((id) => {
                  const item = status.apps.find((app) => app.id === id);
                  return (
                    <button
                      key={id}
                      className={id === activeAppId ? "selected" : ""}
                      type="button"
                      role="tab"
                      aria-selected={id === activeAppId}
                      onClick={() => setActiveAppId(id)}
                    >
                      {item?.shortName ?? id}
                    </button>
                  );
                })}
              </div>
            </div>

            <AgentDetail app={activeApp} />
          </div>

          <div className="panel" id="providers">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{activeApp.name}</p>
                <h3>供应商</h3>
              </div>
              <div className="panel-actions">
                <button
                  className="text-button"
                  type="button"
                  title={`导出 ${activeApp.shortName} providers`}
                  disabled={actionBusy === `provider:export:${activeApp.id}`}
                  onClick={downloadProviderExport}
                >
                  <Download size={17} />
                  <span>导出</span>
                </button>
                <button
                  className="text-button"
                  type="button"
                  title={`导入 ${activeApp.shortName} providers`}
                  disabled={actionBusy === "provider:import"}
                  onClick={openProviderImportPicker}
                >
                  <Upload size={17} />
                  <span>导入</span>
                </button>
                <button className="text-button" type="button" onClick={openProviderCreateEditor}>
                  <Plus size={17} />
                  <span>新增</span>
                </button>
              </div>
            </div>
            <input
              ref={providerImportInputRef}
              className="hidden-file-input"
              type="file"
              accept="application/json,.json"
              onChange={(event) => void handleProviderImportFile(event)}
            />

            <div className="provider-list">
              {providers[activeApp.id].length > 0 ? (
                providers[activeApp.id].map((provider) => {
                  const probe = providerProbes[provider.id];
                  return (
                    <div className="provider-row" key={provider.id}>
                      <div>
                        <strong>{provider.name}</strong>
                        <span>{provider.apiFormat} · {provider.defaultModel}</span>
                        {probe ? (
                          <span className={`provider-probe-result ${probe.ok ? "ok" : "failed"}`}>
                            {probe.statusCode ?? "ERR"} · {probe.latencyMs} ms
                          </span>
                        ) : null}
                      </div>
                      <div className="provider-row-actions">
                        <span className={provider.enabled ? "state-tag active" : "state-tag"}>
                          {provider.enabled ? "已启用" : provider.kind}
                        </span>
                        <button
                          className="mini-icon-button"
                          type="button"
                          title={`启用 ${provider.name}`}
                          disabled={provider.enabled || actionBusy === `provider:enable:${provider.id}`}
                          onClick={() => confirmProviderEnable(provider)}
                        >
                          <Link2 size={15} />
                        </button>
                        <button
                          className="mini-icon-button"
                          type="button"
                          title={`恢复 ${provider.name} 启用前配置`}
                          disabled={!provider.enabled || actionBusy === `provider:restore:${provider.id}`}
                          onClick={() => void prepareProviderRestore(provider)}
                        >
                          <RotateCcw size={15} />
                        </button>
                        <button
                          className="mini-icon-button"
                          type="button"
                          title={`测速 ${provider.name}`}
                          disabled={providerProbeBusy === provider.id}
                          onClick={() => void runProviderProbe(provider)}
                        >
                          <Activity size={15} />
                        </button>
                        <button
                          className="mini-icon-button"
                          type="button"
                          title={`编辑 ${provider.name}`}
                          onClick={() => openProviderEditEditor(provider)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="mini-icon-button"
                          type="button"
                          title={`复制 ${provider.name}`}
                          disabled={actionBusy === `provider:duplicate:${provider.id}`}
                          onClick={() => duplicateProviderRow(provider)}
                        >
                          <Copy size={15} />
                        </button>
                        <button
                          className="mini-icon-button danger"
                          type="button"
                          title={`删除 ${provider.name}`}
                          onClick={() => confirmDeleteProvider(provider)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="empty-state">
                  <div>
                    <strong>暂无供应商</strong>
                    <span>使用 CLI 或 API 添加 {activeApp.shortName} provider</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="panel extensions-panel" id="extensions">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{activeApp.name}</p>
                <h3>扩展</h3>
              </div>
              <StatusPill
                ok={extensions[activeApp.id].mcpServers.length + extensions[activeApp.id].promptPresets.length + extensions[activeApp.id].skills.length > 0}
                label={`${extensions[activeApp.id].mcpServers.length + extensions[activeApp.id].promptPresets.length + extensions[activeApp.id].skills.length} enabled`}
              />
            </div>

            <ExtensionsPanel
              app={activeApp}
              actionBusy={actionBusy}
              summary={extensions[activeApp.id]}
              onCreate={openCreateEditor}
              onEdit={openEditEditor}
              onDelete={confirmDelete}
              onRegisterSkill={(skill) => {
                setEditor({
                  kind: "skill",
                  mode: "create",
                  values: skillValuesFromCandidate(skill, activeApp.id)
                });
              }}
              onMcpWrite={(server) =>
                void prepareConfirmedWrite(
                  actionKey("mcp", activeApp.id, server.id),
                  "确认 MCP 投影",
                  () => previewMcpProjection(server.id, activeApp.id),
                  () => projectMcpServer(server.id, activeApp.id)
                )
              }
              onPromptWrite={(prompt) =>
                void prepareConfirmedWrite(
                  actionKey("prompt", activeApp.id, prompt.id),
                  "确认 Prompt 激活",
                  () => previewPromptActivation(prompt.id, activeApp.id),
                  () => activatePromptPreset(prompt.id, activeApp.id)
                )
              }
              onSkillWrite={(skill, mode) =>
                void prepareConfirmedWrite(
                  actionKey("skill", activeApp.id, skill.id, mode),
                  "确认 Skill 安装",
                  () => previewSkillInstall(skill.id, activeApp.id, mode),
                  () => installSkill(skill.id, activeApp.id, mode)
                )
              }
              skillRegistryValues={skillRegistryForm}
              onSkillRegistryChange={setSkillRegistryForm}
              onSkillRegistryProfileSelect={selectSkillRegistryProfile}
              onSkillRegistryProfileSave={() => void saveSkillRegistryProfile()}
              onSkillRegistrySync={() => void prepareSkillRegistrySync()}
            />
          </div>

          <div className="panel observability-panel" id="observability">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{activeApp.name}</p>
                <h3>观测</h3>
              </div>
              <StatusPill
                ok={!observabilityError}
                label={observabilityLoading ? "loading" : `${observability[activeApp.id].proxyLogs.length} logs`}
              />
            </div>

            <ObservabilityPanel
              app={activeApp}
              summary={observability[activeApp.id]}
              selectedSessionId={selectedSessionId}
              sessionDetail={sessionDetail}
              sessionLoading={sessionLoading}
              sessionFilter={sessionFilters[activeApp.id]}
              error={observabilityError}
              onSessionDraftChange={(value) => updateSessionDraft(activeApp.id, value)}
              onSessionSearch={() => searchSessions(activeApp.id)}
              onSessionClear={() => clearSessionSearch(activeApp.id)}
              onSessionPage={(offset) => pageSessions(activeApp.id, offset)}
              onSessionRedactChange={(redact) =>
                toggleSessionRedaction(activeApp.id, redact)
              }
              onSessionExport={downloadActiveSessionExport}
              sessionExporting={
                selectedSessionId
                  ? actionBusy === sessionExportActionKey(activeApp.id, selectedSessionId)
                  : false
              }
              onResetProviderHealth={(health) =>
                void resetProviderHealthState(activeApp.id, health)
              }
              proxyHealthResetBusy={proxyHealthResetBusy}
              onSelectSession={(session) => {
                setSelectedSessionId(session.id);
                void loadSessionDetail(session.id, activeApp.id);
              }}
            />
          </div>

          <div className="panel" id="proxy">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Routing</p>
                <h3>本地代理</h3>
              </div>
              <button
                className="icon-button"
                type="button"
                title={
                  status.proxy.status === "running"
                    ? "安全停止本地代理"
                    : "启动本地代理"
                }
                disabled={actionBusy === "proxy:runtime"}
                onClick={() =>
                  status.proxy.status === "running"
                    ? void prepareConfirmedWrite(
                        "proxy:runtime",
                        "确认安全停止本地代理",
                        () => stopLocalProxy(true),
                        () => stopLocalProxy(false)
                      )
                    : void runMutation(
                        "proxy:runtime",
                        "本地代理已启动",
                        () => startLocalProxy(status.proxy.port)
                      )
                }
              >
                <Power size={18} />
              </button>
            </div>

            {status.proxy.status !== "running" && status.proxy.takenOverApps.length > 0 ? (
              <div className="action-banner warning" role="alert">
                <CircleAlert size={16} />
                <span>
                  本地代理已停止，{status.proxy.takenOverApps.length} 个应用仍使用接管配置
                </span>
              </div>
            ) : null}

            <div className="proxy-layout">
              <div className="proxy-state">
                <Network size={24} />
                <strong>{status.proxy.status}</strong>
                <span>127.0.0.1:{status.proxy.port}</span>
              </div>
              <div className="takeover-list">
                {status.apps.map((app) => (
                  <div className="takeover-row" key={app.id}>
                    <span>{app.name}</span>
                    <div className="row-actions">
                      <StatusPill
                        ok={status.proxy.takenOverApps.includes(app.id)}
                        label={
                          status.proxy.takenOverApps.includes(app.id)
                            ? "taken over"
                            : "direct"
                        }
                      />
                      <button
                        className="icon-button small"
                        type="button"
                        title={
                          status.proxy.takenOverApps.includes(app.id)
                            ? `恢复 ${app.name} 接管前配置`
                            : `由本地代理接管 ${app.name}`
                        }
                        disabled={
                          actionBusy === `proxy:takeover:${app.id}` ||
                          (status.proxy.status !== "running" &&
                            !status.proxy.takenOverApps.includes(app.id))
                        }
                        onClick={() =>
                          void prepareConfirmedWrite(
                            `proxy:takeover:${app.id}`,
                            status.proxy.takenOverApps.includes(app.id)
                              ? `确认恢复 ${app.name}`
                              : `确认接管 ${app.name}`,
                            status.proxy.takenOverApps.includes(app.id)
                              ? () => restoreProxyTakeover(app.id, true)
                              : () => setProxyTakeover(app.id, true),
                            status.proxy.takenOverApps.includes(app.id)
                              ? () => restoreProxyTakeover(app.id, false)
                              : () => setProxyTakeover(app.id, false)
                          )
                        }
                      >
                        {status.proxy.takenOverApps.includes(app.id) ? (
                          <RotateCcw size={16} />
                        ) : (
                          <PlugZap size={16} />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="panel task-panel" id="tasks">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Runs</p>
                <h3>任务闭环</h3>
              </div>
              <Clock3 size={18} />
            </div>

            <TaskFusionPanel
              activeApp={activeApp}
              values={taskRunForm}
              capabilities={capabilities}
              workflows={workflowCatalog}
              harnessProfiles={harnessProfileCatalog}
              specSets={specSets}
              specPreview={specPreview}
              controlPlaneLoading={taskControlPlaneLoading}
              governedProjectView={governedProjectView}
              governedProjectLoading={governedProjectLoading}
              governedProjectError={governedProjectError}
              busy={taskRunBusy}
              error={taskRunError}
              recentRuns={status.recentRuns}
              activeRun={activeRun}
              events={runEvents}
              usage={activeRunUsage}
              usageLoading={runUsageLoading}
              artifacts={runArtifacts}
              artifactsLoading={runArtifactsLoading}
              artifactFilters={artifactFilters}
              artifactPreview={artifactPreview}
              artifactDownloadBusy={artifactDownloadBusy}
              artifactStore={artifactStore}
              artifactStoreLoading={artifactStoreLoading}
              artifactStoreCleanup={artifactStoreCleanup}
              artifactStoreCleanupBusy={artifactStoreCleanupBusy}
              artifactStoreKeepLatest={artifactStoreKeepLatest}
              runJobWorkers={runJobWorkers}
              runJobWorkersLoading={runJobWorkersLoading}
              resumeBusy={runResumeBusy}
              approvalBusy={runApprovalBusy}
              cleanupBusy={workspaceCleanupBusy}
              workspaceOpenBusy={workspaceOpenBusy}
              onChange={setTaskRunForm}
              onValidateSpec={() => void validateSelectedSpec()}
              onRun={() => void createAndRunTask()}
              onSelectRun={(runId) => void loadRunDetail(runId)}
              onCancelRun={() => void cancelActiveRun()}
              onResumeRun={() => void resumeActiveRun()}
              onApproveRun={() => void decideActiveRun("approve")}
              onRejectRun={() => void decideActiveRun("reject")}
              onCleanupRun={() => void cleanupActiveRun()}
              onOpenWorkspace={(candidate) => void openCandidateWorkspace(candidate)}
              onArtifactFiltersChange={updateArtifactFilters}
              onDownloadArtifact={(artifact) => void downloadActiveRunArtifact(artifact)}
              onDownloadArtifactsArchive={() => void downloadActiveRunArtifactsArchive()}
              onArtifactStoreKeepLatestChange={setArtifactStoreKeepLatest}
              onRefreshArtifactStore={() => void loadArtifactStore()}
              onRefreshRunJobWorkers={() => void loadRunJobWorkers()}
              onPreviewArtifactStoreCleanup={() => void previewArtifactStoreCleanup()}
              onConfirmArtifactStoreCleanup={() => void confirmArtifactStoreCleanup()}
            />
          </div>

          <div className="panel settings-panel" id="settings">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Preferences</p>
                <h3>设置</h3>
              </div>
              <div className="panel-actions">
                <button
                  className="text-button primary"
                  type="button"
                  disabled={settingsBusy}
                  onClick={() => void saveSettings()}
                >
                  <Save size={16} />
                  <span>{settingsBusy ? "保存中" : "保存"}</span>
                </button>
              </div>
            </div>
            <DesktopSettingsPanel
              settings={desktopSettings}
              error={settingsError}
              doctor={systemDoctor}
              doctorLoading={doctorLoading}
              envCleanup={envCleanup}
              envCleanupBusy={envCleanupBusy}
              envCleanupConfirmBusy={actionBusy === "env-cleanup:confirm" || actionBusy === "confirm:write"}
              diagnosticsExportBusy={actionBusy === "diagnostics:export"}
              deepLinkUrl={deepLinkDraft}
              deepLinkBusy={actionBusy === "deep-link:preview"}
              onChange={setDesktopSettings}
              onRefreshDoctor={() => void refreshSystemDoctor()}
              onExportDiagnostics={() => void exportDiagnostics()}
              onPreviewEnvCleanup={() => void previewEnvCleanup()}
              onConfirmEnvCleanup={() => void prepareEnvCleanupConfirm()}
              onDeepLinkUrlChange={setDeepLinkDraft}
              onPreviewDeepLink={() => void prepareDeepLinkImport()}
            />
          </div>
        </section>

        {providerEditor ? (
          <ProviderEditorDialog
            editor={providerEditor}
            busy={actionBusy === `provider:form:${providerEditor.mode}`}
            onChange={setProviderEditor}
            onClose={() => setProviderEditor(null)}
            onSave={() => void saveProviderEditor()}
          />
        ) : null}

        {editor ? (
          <ExtensionEditorDialog
            editor={editor}
            busy={actionBusy === `form:${editor.kind}:${editor.mode}`}
            onChange={setEditor}
            onClose={() => setEditor(null)}
            onSave={() => void saveEditor()}
          />
        ) : null}

        {confirmAction ? (
          <ConfirmDialog
            action={confirmAction}
            busy={actionBusy === "confirm:write"}
            onClose={() => setConfirmAction(null)}
            onConfirm={() => void confirmCurrentAction()}
          />
        ) : null}
      </main>
    </div>
  );
}

function DesktopSettingsPanel({
  settings,
  error,
  doctor,
  doctorLoading,
  envCleanup,
  envCleanupBusy,
  envCleanupConfirmBusy,
  diagnosticsExportBusy,
  deepLinkUrl,
  deepLinkBusy,
  onChange,
  onRefreshDoctor,
  onExportDiagnostics,
  onPreviewEnvCleanup,
  onConfirmEnvCleanup,
  onDeepLinkUrlChange,
  onPreviewDeepLink
}: {
  settings: DesktopSettings;
  error: string | null;
  doctor: SystemDoctorSummary | null;
  doctorLoading: boolean;
  envCleanup: EnvCleanupSummary | null;
  envCleanupBusy: "refresh" | "preview" | null;
  envCleanupConfirmBusy: boolean;
  diagnosticsExportBusy: boolean;
  deepLinkUrl: string;
  deepLinkBusy: boolean;
  onChange: (settings: DesktopSettings) => void;
  onRefreshDoctor: () => void;
  onExportDiagnostics: () => void;
  onPreviewEnvCleanup: () => void;
  onConfirmEnvCleanup: () => void;
  onDeepLinkUrlChange: (url: string) => void;
  onPreviewDeepLink: () => void;
}) {
  const envConflicts = doctor?.envConflicts ?? [];
  const shellConflicts = envConflicts.filter((conflict) => conflict.source === "shell_profile");
  const processConflicts = envConflicts.filter((conflict) => conflict.source === "process.env");
  const launchAgentConflicts = envConflicts.filter(
    (conflict) => conflict.source === "launch_agent"
  );
  const ideSettingsConflicts = envConflicts.filter(
    (conflict) => conflict.source === "ide_settings"
  );
  const readOnlyConflicts = envConflicts.filter((conflict) => conflict.source === "process.env");
  const cleanupableConflicts = [
    ...shellConflicts,
    ...launchAgentConflicts,
    ...ideSettingsConflicts
  ];
  const cleanupLineCount = envCleanup?.removed.length ?? cleanupableConflicts.length;
  const cleanupBusy = envCleanupBusy !== null || envCleanupConfirmBusy;
  return (
    <div className="settings-grid">
      <label className="form-field">
        <span>Theme</span>
        <select
          value={settings.theme}
          onChange={(event) =>
            onChange({ ...settings, theme: event.target.value as DesktopSettings["theme"] })
          }
        >
          <option value="system">Follow system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label className="form-field">
        <span>Close behavior</span>
        <select
          value={settings.closeBehavior}
          onChange={(event) =>
            onChange({
              ...settings,
              closeBehavior: event.target.value as DesktopSettings["closeBehavior"]
            })
          }
        >
          <option value="tray">Keep in tray</option>
          <option value="lightweight">Lightweight mode</option>
          <option value="quit">Quit</option>
        </select>
      </label>
      <label className="form-field wide">
        <span>API URL</span>
        <input
          value={settings.apiUrl}
          onChange={(event) => onChange({ ...settings, apiUrl: event.target.value })}
        />
      </label>
      <label className="toggle-row">
        <input
          checked={settings.launchAtLogin}
          type="checkbox"
          onChange={(event) =>
            onChange({ ...settings, launchAtLogin: event.target.checked })
          }
        />
        <span>开机自启</span>
      </label>
      <label className="toggle-row">
        <input
          checked={settings.lightweightMode}
          type="checkbox"
          onChange={(event) =>
            onChange({ ...settings, lightweightMode: event.target.checked })
          }
        />
        <span>轻量模式</span>
      </label>
      <label className="form-field wide deep-link-field">
        <span>Deep Link Import</span>
        <div className="inline-action-row">
          <input
            aria-label="Deep link URL"
            placeholder="mniu://import/provider|mcp|prompt?payload=..."
            value={deepLinkUrl}
            onChange={(event) => onDeepLinkUrlChange(event.target.value)}
          />
          <button
            className="text-button"
            type="button"
            disabled={deepLinkBusy}
            onClick={onPreviewDeepLink}
          >
            <Link2 size={16} />
            <span>{deepLinkBusy ? "预览中" : "预览导入"}</span>
          </button>
        </div>
      </label>
      {error ? (
        <div className="inline-alert" role="status">
          <CircleAlert size={16} />
          <span>{error}</span>
        </div>
      ) : null}
      <div className="settings-doctor-card wide">
        <div className="settings-doctor-heading">
          <div>
            <span>Doctor</span>
            <strong>环境变量冲突</strong>
          </div>
          <div className="settings-doctor-actions">
            <button
              className="icon-button"
              title="刷新 Doctor"
              type="button"
              disabled={cleanupBusy || doctorLoading}
              onClick={onRefreshDoctor}
            >
              <RefreshCw size={16} />
            </button>
            <button
              className="text-button"
              type="button"
              disabled={cleanupBusy || doctorLoading || diagnosticsExportBusy}
              onClick={onExportDiagnostics}
            >
              <Download size={16} />
              <span>{diagnosticsExportBusy ? "导出中" : "导出诊断"}</span>
            </button>
            <button
              className="text-button"
              type="button"
              disabled={cleanupBusy}
              onClick={onPreviewEnvCleanup}
            >
              <ScanSearch size={16} />
              <span>{envCleanupBusy === "preview" ? "预览中" : "预览清理"}</span>
            </button>
            <button
              className="text-button danger"
              type="button"
              disabled={cleanupBusy || cleanupLineCount === 0}
              onClick={onConfirmEnvCleanup}
            >
              <Trash2 size={16} />
              <span>{envCleanupConfirmBusy ? "清理中" : "确认清理"}</span>
            </button>
          </div>
        </div>

        <div className="env-conflict-summary">
          <span>shell {shellConflicts.length}</span>
          <span>process {processConflicts.length}</span>
          <span>launchd {launchAgentConflicts.length}</span>
          <span>IDE {ideSettingsConflicts.length}</span>
          <span>{doctorLoading ? "loading" : doctor ? "ready" : "offline"}</span>
        </div>

        {doctorLoading ? (
          <div className="empty-state compact">
            <strong>正在刷新 Doctor</strong>
            <span>读取本地配置和环境变量来源</span>
          </div>
        ) : envConflicts.length > 0 ? (
          <div className="env-conflict-list">
            {envConflicts.map((conflict) => (
              <div className="env-conflict-row" key={envConflictKey(conflict)}>
                <div>
                  <strong>{conflict.name}</strong>
                  <span title={envConflictLocation(conflict)}>
                    {envConflictSourceLabel(conflict)}
                  </span>
                </div>
                <span>{conflict.maskedValue}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state compact">
            <strong>暂无 managed env 冲突</strong>
            <span>Claude/Codex 配置不会被已知环境变量覆盖</span>
          </div>
        )}

        {readOnlyConflicts.length > 0 ? (
          <div className="env-boundary-note">
            <CircleAlert size={16} />
            <span>process.env 来源为只读报告；shell、launchd 和 IDE settings 可备份后清理。</span>
          </div>
        ) : null}

        {envCleanup ? (
          <div className="env-cleanup-result" role="status">
            <div>
              <strong>{envCleanup.dryRun ? "预览" : "已清理"}</strong>
              <span>{envCleanup.removed.length} lines</span>
            </div>
            {envCleanup.changedFiles.slice(0, 4).map((file) => (
              <span key={file.path} title={file.backupPath ?? file.path}>
                {file.removed.length} from {shortPath(file.path)}
                {file.backupPath ? ` · backup ${shortPath(file.backupPath)}` : ""}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TaskFusionPanel({
  activeApp,
  values,
  capabilities,
  workflows,
  harnessProfiles,
  specSets,
  specPreview,
  controlPlaneLoading,
  governedProjectView,
  governedProjectLoading,
  governedProjectError,
  busy,
  error,
  recentRuns,
  activeRun,
  events,
  usage,
  usageLoading,
  artifacts,
  artifactsLoading,
  artifactFilters,
  artifactPreview,
  artifactDownloadBusy,
  artifactStore,
  artifactStoreLoading,
  artifactStoreCleanup,
  artifactStoreCleanupBusy,
  artifactStoreKeepLatest,
  runJobWorkers,
  runJobWorkersLoading,
  resumeBusy,
  approvalBusy,
  cleanupBusy,
  workspaceOpenBusy,
  onChange,
  onValidateSpec,
  onRun,
  onSelectRun,
  onCancelRun,
  onResumeRun,
  onApproveRun,
  onRejectRun,
  onCleanupRun,
  onOpenWorkspace,
  onArtifactFiltersChange,
  onDownloadArtifact,
  onDownloadArtifactsArchive,
  onArtifactStoreKeepLatestChange,
  onRefreshArtifactStore,
  onRefreshRunJobWorkers,
  onPreviewArtifactStoreCleanup,
  onConfirmArtifactStoreCleanup
}: {
  activeApp: ManagedAgentApp;
  values: TaskRunFormValues;
  capabilities: CapabilitiesDocument | null;
  workflows: WorkflowsDocument | null;
  harnessProfiles: HarnessProfilesDocument | null;
  specSets: SpecRepositoryRecordSummary[];
  specPreview?: SpecRevisionSummary;
  controlPlaneLoading: boolean;
  governedProjectView: GovernedProjectViewSummary | null;
  governedProjectLoading: boolean;
  governedProjectError: string | null;
  busy: boolean;
  error: string | null;
  recentRuns: RecentRun[];
  activeRun: RunRecordSummary | null;
  events: RunEventSummary[];
  usage: UsageSummary;
  usageLoading: boolean;
  artifacts: RunArtifactSummary[];
  artifactsLoading: boolean;
  artifactFilters: ArtifactFilterState;
  artifactPreview: ArtifactPreviewState | null;
  artifactDownloadBusy: string | null;
  artifactStore: ArtifactStoreSummary | null;
  artifactStoreLoading: boolean;
  artifactStoreCleanup: ArtifactStoreCleanupSummary | null;
  artifactStoreCleanupBusy: boolean;
  artifactStoreKeepLatest: string;
  runJobWorkers: RunJobWorkerListSummary;
  runJobWorkersLoading: boolean;
  resumeBusy: boolean;
  approvalBusy: boolean;
  cleanupBusy: boolean;
  workspaceOpenBusy: string | null;
  onChange: (values: TaskRunFormValues) => void;
  onValidateSpec: () => void;
  onRun: () => void;
  onSelectRun: (runId: string) => void;
  onCancelRun: () => void;
  onResumeRun: () => void;
  onApproveRun: () => void;
  onRejectRun: () => void;
  onCleanupRun: () => void;
  onOpenWorkspace: (candidate: RunRecordSummary["candidates"][number]) => void;
  onArtifactFiltersChange: (filters: ArtifactFilterState) => void;
  onDownloadArtifact: (artifact: RunArtifactSummary) => void;
  onDownloadArtifactsArchive: () => void;
  onArtifactStoreKeepLatestChange: (value: string) => void;
  onRefreshArtifactStore: () => void;
  onRefreshRunJobWorkers: () => void;
  onPreviewArtifactStoreCleanup: () => void;
  onConfirmArtifactStoreCleanup: () => void;
}) {
  return (
    <div className="task-fusion-layout">
      <form
        className="task-run-form"
        onSubmit={(event) => {
          event.preventDefault();
          onRun();
        }}
      >
        <label className="form-field">
          <span>Project root</span>
          <input
            required
            value={values.rootPath}
            onChange={(event) => onChange({ ...values, rootPath: event.target.value })}
            placeholder="/tmp/mn-demo-repo"
          />
        </label>
        <label className="form-field">
          <span>Project name</span>
          <input
            value={values.projectName}
            onChange={(event) => onChange({ ...values, projectName: event.target.value })}
          />
        </label>
        <label className="form-field">
          <span>Title</span>
          <input
            required
            value={values.title}
            onChange={(event) => onChange({ ...values, title: event.target.value })}
          />
        </label>
        <label className="form-field">
          <span>Target service</span>
          <input
            value={values.targetService}
            onChange={(event) => onChange({ ...values, targetService: event.target.value })}
            placeholder="留空使用索引到的第一个服务"
          />
        </label>
        <label className="form-field">
          <span>Candidates</span>
          <input
            required={isGovernedWorkflow(values.workflowId, workflows)}
            inputMode="numeric"
            min="1"
            value={values.candidates}
            onChange={(event) => onChange({ ...values, candidates: event.target.value })}
            placeholder="服务端 / 企业规范默认"
          />
        </label>
        <label className="form-field wide">
          <span>Prompt</span>
          <textarea
            required
            rows={4}
            value={values.prompt}
            onChange={(event) => onChange({ ...values, prompt: event.target.value })}
          />
        </label>
        <label className="form-field wide">
          <span>Acceptance</span>
          <textarea
            rows={3}
            value={values.acceptanceText}
            onChange={(event) => onChange({ ...values, acceptanceText: event.target.value })}
          />
        </label>
        <TaskGovernanceControls
          values={values}
          capabilities={capabilities}
          workflows={workflows}
          harnessProfiles={harnessProfiles}
          specSets={specSets}
          specPreview={specPreview}
          loading={controlPlaneLoading}
          onChange={onChange}
          onValidateSpec={onValidateSpec}
        />
        <div className="task-run-actions">
          <span>
            {activeApp.shortName} · {values.workflowId || "loading workflow"} · effective governance
          </span>
          <button
            className="text-button primary"
            type="submit"
            disabled={busy || controlPlaneLoading || !values.workflowId}
          >
            <Bot size={16} />
            <span>{busy ? "运行中" : "运行任务"}</span>
          </button>
        </div>
        {error ? (
          <div className="inline-alert" role="status">
            <CircleAlert size={16} />
            <span>{error}</span>
          </div>
        ) : null}
      </form>

      <div className="task-run-side">
        <GovernanceProjectPanel
          view={governedProjectView}
          loading={governedProjectLoading}
          error={governedProjectError}
        />

        <ArtifactStorePanel
          store={artifactStore}
          loading={artifactStoreLoading}
          cleanup={artifactStoreCleanup}
          cleanupBusy={artifactStoreCleanupBusy}
          keepLatestRuns={artifactStoreKeepLatest}
          onKeepLatestRunsChange={onArtifactStoreKeepLatestChange}
          onRefresh={onRefreshArtifactStore}
          onPreviewCleanup={onPreviewArtifactStoreCleanup}
          onConfirmCleanup={onConfirmArtifactStoreCleanup}
        />

        <WorkerFleetPanel
          workers={runJobWorkers}
          loading={runJobWorkersLoading}
          onRefresh={onRefreshRunJobWorkers}
        />

        <section className="task-subpanel" aria-label="Recent runs">
          <div className="task-subpanel-heading">
            <strong>Recent Runs</strong>
            <span>{recentRuns.length}</span>
          </div>
          <div className="run-list">
            {recentRuns.length > 0 ? (
              recentRuns.map((run) => (
                <button
                  className="run-row"
                  key={run.id}
                  type="button"
                  onClick={() => onSelectRun(run.id)}
                >
                  <div>
                    <strong>{run.id.slice(0, 8)}</strong>
                    <span>{run.taskId.slice(0, 8)} · {run.candidates} candidates</span>
                  </div>
                  <span className="state-tag">{run.status}</span>
                </button>
              ))
            ) : (
              <div className="empty-state compact">暂无 run</div>
            )}
          </div>
        </section>

        <RunDetail
          run={activeRun}
          events={events}
          usage={usage}
          usageLoading={usageLoading}
          artifacts={artifacts}
          artifactsLoading={artifactsLoading}
          artifactFilters={artifactFilters}
          artifactPreview={artifactPreview}
          artifactDownloadBusy={artifactDownloadBusy}
          busy={busy}
          resumeBusy={resumeBusy}
          approvalBusy={approvalBusy}
          cleanupBusy={cleanupBusy}
          workspaceOpenBusy={workspaceOpenBusy}
          onCancel={onCancelRun}
          onResume={onResumeRun}
          onApprove={onApproveRun}
          onReject={onRejectRun}
          onCleanup={onCleanupRun}
          onOpenWorkspace={onOpenWorkspace}
          onArtifactFiltersChange={onArtifactFiltersChange}
          onDownloadArtifact={onDownloadArtifact}
          onDownloadArtifactsArchive={onDownloadArtifactsArchive}
          governedProjectView={governedProjectView}
        />
      </div>
    </div>
  );
}

function ArtifactStorePanel({
  store,
  loading,
  cleanup,
  cleanupBusy,
  keepLatestRuns,
  onKeepLatestRunsChange,
  onRefresh,
  onPreviewCleanup,
  onConfirmCleanup
}: {
  store: ArtifactStoreSummary | null;
  loading: boolean;
  cleanup: ArtifactStoreCleanupSummary | null;
  cleanupBusy: boolean;
  keepLatestRuns: string;
  onKeepLatestRunsChange: (value: string) => void;
  onRefresh: () => void;
  onPreviewCleanup: () => void;
  onConfirmCleanup: () => void;
}) {
  const latestRuns = store?.runs.slice(0, 3) ?? [];
  const cleanupRows = cleanup
    ? (cleanup.dryRun ? cleanup.candidates : cleanup.deleted).slice(0, 3)
    : [];

  return (
    <section className="task-subpanel artifact-store-panel" aria-label="Artifact store">
      <div className="task-subpanel-heading">
        <strong>Artifact Store</strong>
        <div className="run-detail-actions">
          <span>{loading ? "loading" : `${store?.totalRuns ?? 0} runs`}</span>
          <button
            className="icon-button"
            type="button"
            title="刷新 artifact store"
            disabled={loading || cleanupBusy}
            onClick={onRefresh}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {store ? (
        <>
          <div className="run-summary-grid">
            <MiniMetric
              icon={<Database size={16} />}
              label="Runs"
              value={formatNumber(store.totalRuns)}
              detail={`${formatBytes(store.totalBytes)} stored`}
            />
            <MiniMetric
              icon={<FileText size={16} />}
              label="Files"
              value={formatNumber(store.totalArtifacts)}
              detail="persisted artifacts"
            />
            {store.remote ? (
              <MiniMetric
                icon={<Upload size={16} />}
                label={store.remote.type.toUpperCase()}
                value={formatNumber(store.remote.totalRuns)}
                detail={`${formatBytes(store.remote.totalBytes)}${
                  store.remote.bucket ? ` · ${store.remote.bucket}` : ""
                }`}
              />
            ) : null}
          </div>

          <div className="artifact-store-controls">
            <label className="artifact-store-retention-field">
              <span>Keep latest runs</span>
              <input
                aria-label="Keep latest runs"
                min={0}
                step={1}
                type="number"
                value={keepLatestRuns}
                onChange={(event) => onKeepLatestRunsChange(event.target.value)}
              />
            </label>
            <div className="artifact-store-actions">
              <button
                className="text-button"
                type="button"
                disabled={cleanupBusy}
                onClick={onPreviewCleanup}
              >
                <ScanSearch size={15} />
                <span>{cleanupBusy ? "处理中" : "预览清理"}</span>
              </button>
              <button
                className="text-button danger"
                type="button"
                disabled={cleanupBusy}
                onClick={onConfirmCleanup}
              >
                <Trash2 size={15} />
                <span>确认清理</span>
              </button>
            </div>
          </div>

          {cleanup ? (
            <div className="artifact-cleanup-result" aria-label="Artifact cleanup result">
              <div>
                <strong>
                  {cleanup.dryRun
                    ? `${cleanup.candidateRuns} candidates`
                    : `${cleanup.deleted.length} deleted`}
                </strong>
                <span>{formatBytes(cleanup.candidateBytes)} matched</span>
              </div>
              {cleanupRows.map((run) => (
                <span key={`${cleanup.dryRun ? "candidate" : "deleted"}-${run.runId}`}>
                  {run.runId.slice(0, 8)} · {run.reasons.join(", ")}
                </span>
              ))}
            </div>
          ) : null}

          {latestRuns.length > 0 ? (
            <div className="artifact-store-run-list">
              {latestRuns.map((run) => (
                <div className="artifact-store-run-row" key={run.runId}>
                  <div>
                    <strong>{run.runId.slice(0, 8)}</strong>
                    <span>{formatDateTime(run.latestPersistedAt ?? run.updatedAt ?? "")}</span>
                  </div>
                  <span>{run.artifactCount} · {formatBytes(run.bytes)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state compact">暂无 persisted artifacts</div>
          )}
        </>
      ) : (
        <div className="empty-state compact">
          {loading ? "读取 artifact store" : "暂无 artifact store 数据"}
        </div>
      )}
    </section>
  );
}

function WorkerFleetPanel({
  workers,
  loading,
  onRefresh
}: {
  workers: RunJobWorkerListSummary;
  loading: boolean;
  onRefresh: () => void;
}) {
  const visibleWorkers = workers.workers.slice(0, 5);

  return (
    <section className="task-subpanel worker-fleet-panel" aria-label="Worker fleet">
      <div className="task-subpanel-heading">
        <strong>Worker Fleet</strong>
        <div className="run-detail-actions">
          <span>{loading ? "loading" : `${workers.summary.total} workers`}</span>
          <button
            className="icon-button"
            type="button"
            title="刷新 worker fleet"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      <div className="run-summary-grid">
        <MiniMetric
          icon={<Users size={16} />}
          label="Running"
          value={formatNumber(workers.summary.running)}
          detail={`${formatNumber(workers.summary.total)} total`}
        />
        <MiniMetric
          icon={<Clock3 size={16} />}
          label="Idle"
          value={formatNumber(workers.summary.idle)}
          detail={`${formatNumber(workers.summary.stale)} stale`}
        />
        <MiniMetric
          icon={<Activity size={16} />}
          label="Slots"
          value={formatNumber(workers.summary.availableSlots ?? 0)}
          detail={`${formatNumber(workers.summary.capacity ?? 0)} capacity`}
        />
      </div>

      {visibleWorkers.length > 0 ? (
        <div className="worker-fleet-list">
          {visibleWorkers.map((worker) => (
            <WorkerFleetRow worker={worker} key={worker.ownerId} />
          ))}
        </div>
      ) : (
        <div className="empty-state compact">
          {loading ? "读取 worker fleet" : "暂无 worker"}
        </div>
      )}
    </section>
  );
}

function WorkerFleetRow({ worker }: { worker: RunJobWorkerSummary }) {
  const stateClass = worker.state === "running" ? "active" : "";
  const activeRun = worker.activeRunId ? `run ${worker.activeRunId.slice(0, 8)}` : "no active run";
  const slotDetail = `${formatNumber(worker.activeRunCount ?? (worker.activeRunId ? 1 : 0))}/${formatNumber(worker.capacity ?? 1)} slots`;
  const errorDetail = worker.lastError ? ` · ${previewText(worker.lastError, 36)}` : "";
  return (
    <div className="worker-fleet-row">
      <div>
        <strong>{worker.ownerId}</strong>
        <span>{activeRun} · seen {formatDateTime(worker.lastSeenAt)}{errorDetail}</span>
      </div>
      <div className="worker-fleet-values">
        <span className={`state-tag ${stateClass}`}>{worker.state}</span>
        <span>{slotDetail}</span>
        <span>{worker.completedRunCount} ok</span>
        <span>{worker.failedRunCount + worker.cancelledRunCount} fail</span>
        <span>{worker.releasedRunCount} release</span>
      </div>
    </div>
  );
}

function RunDetail({
  run,
  events,
  governedProjectView,
  usage,
  usageLoading,
  artifacts,
  artifactsLoading,
  artifactFilters,
  artifactPreview,
  artifactDownloadBusy,
  busy,
  resumeBusy,
  approvalBusy,
  cleanupBusy,
  workspaceOpenBusy,
  onCancel,
  onResume,
  onApprove,
  onReject,
  onCleanup,
  onOpenWorkspace,
  onArtifactFiltersChange,
  onDownloadArtifact,
  onDownloadArtifactsArchive
}: {
  run: RunRecordSummary | null;
  events: RunEventSummary[];
  governedProjectView: GovernedProjectViewSummary | null;
  usage: UsageSummary;
  usageLoading: boolean;
  artifacts: RunArtifactSummary[];
  artifactsLoading: boolean;
  artifactFilters: ArtifactFilterState;
  artifactPreview: ArtifactPreviewState | null;
  artifactDownloadBusy: string | null;
  busy: boolean;
  resumeBusy: boolean;
  approvalBusy: boolean;
  cleanupBusy: boolean;
  workspaceOpenBusy: string | null;
  onCancel: () => void;
  onResume: () => void;
  onApprove: () => void;
  onReject: () => void;
  onCleanup: () => void;
  onOpenWorkspace: (candidate: RunRecordSummary["candidates"][number]) => void;
  onArtifactFiltersChange: (filters: ArtifactFilterState) => void;
  onDownloadArtifact: (artifact: RunArtifactSummary) => void;
  onDownloadArtifactsArchive: () => void;
}) {
  if (!run) {
    return (
      <section className="task-subpanel" aria-label="Run detail">
        <div className="empty-state compact">运行后显示 candidates、gates 和 events</div>
      </section>
    );
  }

  return (
    <section className="task-subpanel" aria-label="Run detail">
      <div className="task-subpanel-heading">
        <strong>Run Detail</strong>
        <div className="run-detail-actions">
          <span>{run.status}</span>
          {!isRunTerminal(run.status) ? (
            <button
              className="icon-button danger"
              type="button"
              title="取消 run"
              disabled={busy}
              onClick={onCancel}
            >
              <XCircle size={16} />
            </button>
          ) : null}
          {isRunResumable(run.status) ? (
            <button
              className="icon-button"
              type="button"
              title="恢复 run"
              disabled={busy || resumeBusy}
              onClick={onResume}
            >
              <RotateCcw size={16} />
            </button>
          ) : null}
          {isRunTerminal(run.status) ? (
            <button
              className="icon-button danger"
              type="button"
              title="清理 workspaces"
              disabled={busy || resumeBusy || cleanupBusy || run.candidates.length === 0}
              onClick={onCleanup}
            >
              <Trash2 size={16} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="run-summary-grid">
        <MiniMetric
          icon={<Clock3 size={16} />}
          label="Run"
          value={run.id.slice(0, 8)}
          detail={formatDateTime(run.updatedAt)}
        />
        <MiniMetric
          icon={<CheckCircle2 size={16} />}
          label="Winner"
          value={run.winnerCandidateId ?? "-"}
          detail={`${run.candidates.length} candidates`}
        />
      </div>

      <GovernedRunDetail
        run={run}
        view={governedProjectView}
        approvalBusy={approvalBusy}
        onApprove={onApprove}
        onReject={onReject}
      />

      <RunUsageBlock usage={usage} loading={usageLoading} />

      <RunArtifactsBlock
        run={run}
        artifacts={artifacts}
        loading={artifactsLoading}
        filters={artifactFilters}
        preview={artifactPreview}
        busyArtifactId={artifactDownloadBusy}
        onFiltersChange={onArtifactFiltersChange}
        onDownload={onDownloadArtifact}
        onDownloadArchive={onDownloadArtifactsArchive}
      />

      <div className="candidate-list">
        {run.candidates.map((candidate) => (
          <div className="candidate-row" key={candidate.id}>
            <div className="candidate-heading">
              <strong>{candidate.id}</strong>
              <div className="candidate-heading-actions">
                <span className="state-tag">{candidate.status}</span>
                <button
                  className="icon-button"
                  type="button"
                  title="打开 candidate workspace"
                  disabled={!candidate.worktreePath || workspaceOpenBusy === candidate.id}
                  onClick={() => onOpenWorkspace(candidate)}
                >
                  <FolderOpen size={15} />
                </button>
              </div>
            </div>
            <span>{candidate.worktreePath}</span>
            <div className="gate-list">
              {candidate.gates.map((gate) => (
                <span className={`gate-chip ${gate.status}`} key={`${candidate.id}-${gate.gate}`}>
                  {gate.gate}: {gate.status}
                </span>
              ))}
            </div>
            {candidate.result?.summary ? (
              <p>{candidate.result.summary}</p>
            ) : null}
          </div>
        ))}
      </div>

      <div className="event-list">
        {events.slice(-6).map((event, index) => (
          <div className="event-row" key={`${event.timestamp}-${index}`}>
            <span>{event.type}</span>
            <strong>{event.message}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function RunUsageBlock({
  usage,
  loading
}: {
  usage: UsageSummary;
  loading: boolean;
}) {
  const candidateBuckets = usage.byCandidate.slice(0, 4);
  return (
    <div className="run-usage-block" aria-label="Run usage">
      <div className="run-usage-heading">
        <strong>Run Usage</strong>
        <span>{loading ? "loading" : `${usage.requestCount} requests`}</span>
      </div>
      {usage.requestCount > 0 ? (
        <>
          <div className="run-summary-grid">
            <MiniMetric
              icon={<BarChart3 size={16} />}
              label="Tokens"
              value={formatNumber(usage.totalTokens)}
              detail={`${formatNumber(usage.inputTokens)} in / ${formatNumber(usage.outputTokens)} out`}
            />
            <MiniMetric
              icon={<SquareTerminal size={16} />}
              label="Cost"
              value={formatCost(usage.estimatedCostUsd)}
              detail="estimated"
            />
          </div>
          {candidateBuckets.length > 0 ? (
            <div className="candidate-usage-list">
              {candidateBuckets.map((bucket) => (
                <div className="candidate-usage-row" key={bucket.key}>
                  <span>{bucket.candidateId ?? bucket.key}</span>
                  <strong>{formatNumber(bucket.totalTokens)} tok</strong>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="empty-state compact">
          {loading ? "读取 run usage" : "暂无关联 usage"}
        </div>
      )}
    </div>
  );
}

function RunArtifactsBlock({
  run,
  artifacts,
  loading,
  filters,
  preview,
  busyArtifactId,
  onFiltersChange,
  onDownload,
  onDownloadArchive
}: {
  run: RunRecordSummary;
  artifacts: RunArtifactSummary[];
  loading: boolean;
  filters: ArtifactFilterState;
  preview: ArtifactPreviewState | null;
  busyArtifactId: string | null;
  onFiltersChange: (filters: ArtifactFilterState) => void;
  onDownload: (artifact: RunArtifactSummary) => void;
  onDownloadArchive: () => void;
}) {
  const visibleArtifacts = artifacts.slice(0, 8);
  return (
    <div className="run-artifacts-block" aria-label="Run artifacts">
      <div className="run-usage-heading">
        <strong>Run Artifacts</strong>
        <div className="run-artifact-heading-actions">
          <span>{loading ? "loading" : `${artifacts.length} files`}</span>
          <button
            className="mini-icon-button"
            type="button"
            title="下载全部 artifacts"
            disabled={loading || artifacts.length === 0 || busyArtifactId === "__archive__"}
            onClick={onDownloadArchive}
          >
            <Download size={14} />
          </button>
        </div>
      </div>
      <div className="artifact-filter-row" aria-label="Artifact filters">
        <label>
          <span>Candidate</span>
          <select
            aria-label="Artifact candidate filter"
            value={filters.candidateId}
            onChange={(event) =>
              onFiltersChange({ ...filters, candidateId: event.currentTarget.value })
            }
          >
            <option value="">All candidates</option>
            {run.candidates.map((candidate) => (
              <option value={candidate.id} key={candidate.id}>
                {candidate.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Kind</span>
          <select
            aria-label="Artifact kind filter"
            value={filters.kind}
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                kind: event.currentTarget.value as ArtifactFilterState["kind"]
              })
            }
          >
            <option value="">All kinds</option>
            {artifactKindOptions.map((kind) => (
              <option value={kind} key={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Stored</span>
          <select
            aria-label="Artifact persisted filter"
            value={filters.persisted}
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                persisted: event.currentTarget.value as ArtifactFilterState["persisted"]
              })
            }
          >
            <option value="all">All</option>
            <option value="persisted">Persisted</option>
            <option value="ephemeral">Ephemeral</option>
          </select>
        </label>
      </div>
      {visibleArtifacts.length > 0 ? (
        <div className="artifact-list">
          {visibleArtifacts.map((artifact) => (
            <div className="artifact-row" key={artifact.id}>
              <div>
                <strong>{artifact.label ?? artifact.id}</strong>
                <span>{artifactDetail(artifact)}</span>
              </div>
              <button
                className="mini-icon-button"
                type="button"
                title={`下载 artifact ${artifact.id}`}
                disabled={busyArtifactId === artifact.id}
                onClick={() => onDownload(artifact)}
              >
                <Download size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state compact">
          {loading ? "读取 artifacts" : "暂无 artifacts"}
        </div>
      )}
      {preview ? (
        <div className="artifact-preview" aria-label="Artifact preview">
          <div className="artifact-preview-heading">
            <strong>{preview.filename}</strong>
            <span>{formatBytes(preview.bytes)} · {preview.contentType}</span>
          </div>
          <pre>
            {preview.text
              ? clampPreview(preview.text)
              : `${formatBytes(preview.bytes)} binary artifact downloaded`}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function ProviderEditorDialog({
  editor,
  busy,
  onChange,
  onClose,
  onSave
}: {
  editor: ProviderEditorState;
  busy: boolean;
  onChange: (editor: ProviderEditorState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const title = `${editor.mode === "edit" ? "编辑" : "新增"} Provider`;
  const values = editor.values;
  const lockShape = editor.mode === "edit";
  const updateModel = (index: number, patch: Partial<ProviderModelFormValue>) => {
    const nextModels = values.modelCatalog.map((model, modelIndex) =>
      modelIndex === index ? { ...model, ...patch } : model
    );
    onChange({ ...editor, values: { ...values, modelCatalog: nextModels } });
  };
  const removeModel = (index: number) => {
    onChange({
      ...editor,
      values: {
        ...values,
        modelCatalog: values.modelCatalog.filter((_, modelIndex) => modelIndex !== index)
      }
    });
  };
  const addModel = () => {
    onChange({
      ...editor,
      values: {
        ...values,
        modelCatalog: [
          ...values.modelCatalog,
          {
            id: values.defaultModel,
            displayName: values.defaultModel,
            contextWindow: "",
            inputTokenUsdPerMillion: "",
            outputTokenUsdPerMillion: "",
            cachedInputTokenUsdPerMillion: "",
            cacheCreationInputTokenUsdPerMillion: "",
            cacheReadInputTokenUsdPerMillion: "",
            reasoningOutputTokenUsdPerMillion: "",
            extra: {}
          }
        ]
      }
    });
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Provider</p>
            <h3>{title}</h3>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form
          className="extension-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <label className="form-field">
            <span>名称</span>
            <input
              required
              value={values.name}
              onChange={(event) =>
                onChange({ ...editor, values: { ...values, name: event.target.value } })
              }
            />
          </label>
          <label className="form-field">
            <span>App</span>
            <select
              disabled={lockShape}
              value={values.app}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: { ...values, app: event.target.value as ProviderAppScope }
                })
              }
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="unified">Unified</option>
            </select>
          </label>
          <label className="form-field">
            <span>Kind</span>
            <select
              disabled={lockShape}
              value={values.kind}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: { ...values, kind: event.target.value as ProviderKind }
                })
              }
            >
              <option value="official">Official</option>
              <option value="openai_compatible">OpenAI compatible</option>
              <option value="anthropic_compatible">Anthropic compatible</option>
              <option value="relay">Relay</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="form-field">
            <span>API format</span>
            <select
              disabled={lockShape}
              value={values.apiFormat}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: {
                    ...values,
                    apiFormat: event.target.value as ProviderApiFormat
                  }
                })
              }
            >
              <option value="anthropic_messages">Anthropic Messages</option>
              <option value="openai_responses">OpenAI Responses</option>
              <option value="openai_chat">OpenAI Chat</option>
            </select>
          </label>
          <label className="form-field">
            <span>Base URL</span>
            <input
              required
              value={values.baseUrl}
              onChange={(event) =>
                onChange({ ...editor, values: { ...values, baseUrl: event.target.value } })
              }
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label className="form-field">
            <span>Default model</span>
            <input
              required
              value={values.defaultModel}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: { ...values, defaultModel: event.target.value }
                })
              }
            />
          </label>
          <div className="model-catalog-editor">
            <div className="model-catalog-heading">
              <span>Model catalog</span>
              <button className="mini-button" type="button" onClick={addModel}>
                <Plus size={15} />
                <span>新增 Model</span>
              </button>
            </div>
            {values.modelCatalog.length ? (
              values.modelCatalog.map((model, index) => (
                <div className="model-catalog-row" key={index}>
                  <label className="form-field">
                    <span>Model ID</span>
                    <input
                      value={model.id}
                      onChange={(event) => updateModel(index, { id: event.target.value })}
                    />
                  </label>
                  <label className="form-field">
                    <span>Display name</span>
                    <input
                      value={model.displayName}
                      onChange={(event) =>
                        updateModel(index, { displayName: event.target.value })
                      }
                    />
                  </label>
                  <label className="form-field">
                    <span>Context</span>
                    <input
                      inputMode="numeric"
                      min="1"
                      step="1"
                      type="number"
                      value={model.contextWindow}
                      onChange={(event) =>
                        updateModel(index, { contextWindow: event.target.value })
                      }
                    />
                  </label>
                  <label className="form-field">
                    <span>Input $/M</span>
                    <input
                      inputMode="decimal"
                      min="0"
                      step="0.000001"
                      type="number"
                      value={model.inputTokenUsdPerMillion}
                      onChange={(event) =>
                        updateModel(index, { inputTokenUsdPerMillion: event.target.value })
                      }
                    />
                  </label>
                  <label className="form-field">
                    <span>Output $/M</span>
                    <input
                      inputMode="decimal"
                      min="0"
                      step="0.000001"
                      type="number"
                      value={model.outputTokenUsdPerMillion}
                      onChange={(event) =>
                        updateModel(index, { outputTokenUsdPerMillion: event.target.value })
                      }
                    />
                  </label>
                  <label className="form-field">
                    <span>Cached input $/M</span>
                    <input
                      inputMode="decimal"
                      min="0"
                      step="0.000001"
                      type="number"
                      value={model.cachedInputTokenUsdPerMillion}
                      onChange={(event) =>
                        updateModel(index, {
                          cachedInputTokenUsdPerMillion: event.target.value
                        })
                      }
                    />
                  </label>
                  <label className="form-field">
                    <span>Cache create $/M</span>
                    <input
                      inputMode="decimal"
                      min="0"
                      step="0.000001"
                      type="number"
                      value={model.cacheCreationInputTokenUsdPerMillion}
                      onChange={(event) =>
                        updateModel(index, {
                          cacheCreationInputTokenUsdPerMillion: event.target.value
                        })
                      }
                    />
                  </label>
                  <label className="form-field">
                    <span>Cache read $/M</span>
                    <input
                      inputMode="decimal"
                      min="0"
                      step="0.000001"
                      type="number"
                      value={model.cacheReadInputTokenUsdPerMillion}
                      onChange={(event) =>
                        updateModel(index, {
                          cacheReadInputTokenUsdPerMillion: event.target.value
                        })
                      }
                    />
                  </label>
                  <label className="form-field">
                    <span>Reasoning output $/M</span>
                    <input
                      inputMode="decimal"
                      min="0"
                      step="0.000001"
                      type="number"
                      value={model.reasoningOutputTokenUsdPerMillion}
                      onChange={(event) =>
                        updateModel(index, {
                          reasoningOutputTokenUsdPerMillion: event.target.value
                        })
                      }
                    />
                  </label>
                  <button
                    className="mini-icon-button danger"
                    type="button"
                    title={`删除 model ${model.id || index + 1}`}
                    onClick={() => removeModel(index)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-state compact">暂无 model catalog</div>
            )}
          </div>
          <label className="form-field">
            <span>Wire API</span>
            <select
              value={values.wireApi}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: {
                    ...values,
                    wireApi: event.target.value as "" | ProviderWireApi
                  }
                })
              }
            >
              <option value="">Auto</option>
              <option value="responses">Responses</option>
              <option value="chat">Chat</option>
            </select>
          </label>
          <label className="form-field">
            <span>Failure threshold</span>
            <input
              inputMode="numeric"
              min="1"
              step="1"
              type="number"
              value={values.healthFailureThreshold}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: {
                    ...values,
                    healthFailureThreshold: event.target.value
                  }
                })
              }
              placeholder="3"
            />
          </label>
          <label className="form-field">
            <span>Circuit open ms</span>
            <input
              inputMode="numeric"
              min="1"
              step="1"
              type="number"
              value={values.healthCircuitOpenMs}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: {
                    ...values,
                    healthCircuitOpenMs: event.target.value
                  }
                })
              }
              placeholder="60000"
            />
          </label>
          <label className="toggle-row" title="Tool-call replay opt-in">
            <input
              type="checkbox"
              checked={values.replayToolCalls}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: {
                    ...values,
                    replayToolCalls: event.target.checked
                  }
                })
              }
            />
            <span>Replay tool calls</span>
          </label>
          <label className="form-field">
            <span>Readonly tools</span>
            <input
              value={values.replayReadonlyTools}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: {
                    ...values,
                    replayReadonlyTools: event.target.value
                  }
                })
              }
              placeholder="get_weather, list_models"
            />
          </label>
          <label className="form-field">
            <span>Idempotent tools</span>
            <input
              value={values.replayIdempotentTools}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: {
                    ...values,
                    replayIdempotentTools: event.target.value
                  }
                })
              }
              placeholder="cache_lookup"
            />
          </label>
          <label className="form-field">
            <span>Side-effect tools</span>
            <input
              value={values.replaySideEffectTools}
              onChange={(event) =>
                onChange({
                  ...editor,
                  values: {
                    ...values,
                    replaySideEffectTools: event.target.value
                  }
                })
              }
              placeholder="write_file, send_email"
            />
          </label>
          <label className="form-field">
            <span>API key env</span>
            <input
              value={values.apiKeyEnv}
              onChange={(event) =>
                onChange({ ...editor, values: { ...values, apiKeyEnv: event.target.value } })
              }
              placeholder="OPENAI_API_KEY"
            />
          </label>
          <label className="form-field">
            <span>{editor.mode === "edit" ? "API key override" : "API key"}</span>
            <input
              value={values.apiKey}
              onChange={(event) =>
                onChange({ ...editor, values: { ...values, apiKey: event.target.value } })
              }
              placeholder={editor.mode === "edit" ? "留空保留现有 secret" : "sk-..."}
              type="password"
            />
          </label>

          <div className="dialog-actions">
            <button className="text-button" type="button" onClick={onClose}>
              <X size={16} />
              <span>取消</span>
            </button>
            <button className="text-button primary" type="submit" disabled={busy}>
              <Save size={16} />
              <span>{busy ? "保存中" : "保存"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ExtensionEditorDialog({
  editor,
  busy,
  onChange,
  onClose,
  onSave
}: {
  editor: ExtensionEditorState;
  busy: boolean;
  onChange: (editor: ExtensionEditorState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const title = `${editor.mode === "edit" ? "编辑" : "新增"} ${editorLabel(editor.kind)}`;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">{editorLabel(editor.kind)}</p>
            <h3>{title}</h3>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form
          className="extension-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          {editor.kind === "mcp" ? (
            <McpEditorFields editor={editor} onChange={onChange} />
          ) : editor.kind === "prompt" ? (
            <PromptEditorFields editor={editor} onChange={onChange} />
          ) : (
            <SkillEditorFields editor={editor} onChange={onChange} />
          )}

          <div className="dialog-actions">
            <button className="text-button" type="button" onClick={onClose}>
              <X size={16} />
              <span>取消</span>
            </button>
            <button className="text-button primary" type="submit" disabled={busy}>
              <Save size={16} />
              <span>{busy ? "保存中" : "保存"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function McpEditorFields({
  editor,
  onChange
}: {
  editor: Extract<ExtensionEditorState, { kind: "mcp" }>;
  onChange: (editor: ExtensionEditorState) => void;
}) {
  const values = editor.values;
  return (
    <>
      <label className="form-field">
        <span>名称</span>
        <input
          required
          value={values.name}
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, name: event.target.value } })
          }
        />
      </label>
      <label className="form-field">
        <span>Command</span>
        <input
          required
          value={values.command}
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, command: event.target.value } })
          }
        />
      </label>
      <label className="form-field">
        <span>Args</span>
        <textarea
          rows={3}
          value={values.argsText}
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, argsText: event.target.value } })
          }
        />
      </label>
      <label className="form-field">
        <span>{editor.mode === "edit" ? "Env override" : "Env"}</span>
        <textarea
          rows={4}
          placeholder={editor.mode === "edit" ? "留空保持现有 env" : "KEY=value"}
          value={values.envText}
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, envText: event.target.value } })
          }
        />
      </label>
      <AppCheckboxes
        apps={values.apps}
        onChange={(apps) => onChange({ ...editor, values: { ...values, apps } })}
      />
      <label className="toggle-row">
        <input
          checked={values.enabled}
          type="checkbox"
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, enabled: event.target.checked } })
          }
        />
        <span>启用</span>
      </label>
    </>
  );
}

function PromptEditorFields({
  editor,
  onChange
}: {
  editor: Extract<ExtensionEditorState, { kind: "prompt" }>;
  onChange: (editor: ExtensionEditorState) => void;
}) {
  const values = editor.values;
  return (
    <>
      <label className="form-field">
        <span>名称</span>
        <input
          required
          value={values.name}
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, name: event.target.value } })
          }
        />
      </label>
      <label className="form-field">
        <span>Content</span>
        <textarea
          required
          rows={8}
          value={values.content}
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, content: event.target.value } })
          }
        />
      </label>
      <AppCheckboxes
        apps={values.apps}
        onChange={(apps) => onChange({ ...editor, values: { ...values, apps } })}
      />
    </>
  );
}

function SkillEditorFields({
  editor,
  onChange
}: {
  editor: Extract<ExtensionEditorState, { kind: "skill" }>;
  onChange: (editor: ExtensionEditorState) => void;
}) {
  const values = editor.values;
  return (
    <>
      <label className="form-field">
        <span>名称</span>
        <input
          required
          value={values.name}
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, name: event.target.value } })
          }
        />
      </label>
      <label className="form-field">
        <span>Source path</span>
        <input
          required
          value={values.sourcePath}
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, sourcePath: event.target.value } })
          }
        />
      </label>
      <label className="form-field">
        <span>Description</span>
        <input
          value={values.description}
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, description: event.target.value } })
          }
        />
      </label>
      <label className="form-field">
        <span>Version</span>
        <input
          value={values.version}
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, version: event.target.value } })
          }
        />
      </label>
      <AppCheckboxes
        apps={values.apps}
        onChange={(apps) => onChange({ ...editor, values: { ...values, apps } })}
      />
      <label className="toggle-row">
        <input
          checked={values.enabled}
          type="checkbox"
          onChange={(event) =>
            onChange({ ...editor, values: { ...values, enabled: event.target.checked } })
          }
        />
        <span>启用</span>
      </label>
    </>
  );
}

function AppCheckboxes({
  apps,
  onChange
}: {
  apps: AgentAppId[];
  onChange: (apps: AgentAppId[]) => void;
}) {
  return (
    <fieldset className="app-checkboxes">
      <legend>Apps</legend>
      {agentOrder.map((app) => (
        <label className="toggle-row" key={app}>
          <input
            checked={apps.includes(app)}
            type="checkbox"
            onChange={() => onChange(toggleApp(apps, app))}
          />
          <span>{app === "claude" ? "Claude" : "Codex"}</span>
        </label>
      ))}
    </fieldset>
  );
}

function ConfirmDialog({
  action,
  busy,
  onClose,
  onConfirm
}: {
  action: ConfirmAction;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-dialog confirm-dialog" role="dialog" aria-modal="true" aria-label={action.title}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Confirm</p>
            <h3>{action.title}</h3>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className={`confirm-body ${action.tone === "danger" ? "danger" : ""}`}>
          <CircleAlert size={20} />
          <div>
            <strong>{action.body}</strong>
            {action.detail ? <span>{action.detail}</span> : null}
          </div>
        </div>
        {action.diffs && action.diffs.length > 0 ? (
          <div className="config-diff-list" aria-label="配置变更预览">
            <strong>配置变更预览</strong>
            {action.diffs.map((diff) => (
              <section className="config-diff" key={diff.targetPath}>
                <strong>{diff.targetPath}</strong>
                <div className="config-diff-columns">
                  <div>
                    <span>Before</span>
                    <pre>{diff.before || "(new file)"}</pre>
                  </div>
                  <div>
                    <span>After</span>
                    <pre>{diff.after || "(removed)"}</pre>
                  </div>
                </div>
              </section>
            ))}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button className="text-button" type="button" onClick={onClose}>
            <X size={16} />
            <span>取消</span>
          </button>
          <button
            className={`text-button ${action.tone === "danger" ? "danger" : "primary"}`}
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {action.tone === "danger" ? <Trash2 size={16} /> : <Save size={16} />}
            <span>{busy ? "执行中" : action.confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ExtensionsPanel({
  app,
  summary,
  actionBusy,
  onCreate,
  onEdit,
  onDelete,
  onRegisterSkill,
  onMcpWrite,
  onPromptWrite,
  onSkillWrite,
  skillRegistryValues,
  onSkillRegistryChange,
  onSkillRegistryProfileSelect,
  onSkillRegistryProfileSave,
  onSkillRegistrySync
}: {
  app: ManagedAgentApp;
  summary: ExtensionSummary;
  actionBusy: string | null;
  onCreate: (kind: EditorKind) => void;
  onEdit: (
    item: McpServerSummary | PromptPresetSummary | SkillSummary,
    kind: EditorKind
  ) => void;
  onDelete: (kind: EditorKind, id: string, name: string) => void;
  onRegisterSkill: (skill: SkillSourceCandidate) => void;
  onMcpWrite: (server: McpServerSummary) => void;
  onPromptWrite: (prompt: PromptPresetSummary) => void;
  onSkillWrite: (skill: SkillSummary, mode: SkillSyncMode) => void;
  skillRegistryValues: SkillRegistryFormValues;
  onSkillRegistryChange: (values: SkillRegistryFormValues) => void;
  onSkillRegistryProfileSelect: (profileId: string) => void;
  onSkillRegistryProfileSave: () => void;
  onSkillRegistrySync: () => void;
}) {
  const registeredSourcePaths = new Set(summary.skills.map((skill) => skill.sourcePath));
  const discoveredSkills = summary.discoveredSkills
    .filter((skill) => !registeredSourcePaths.has(skill.sourcePath))
    .slice(0, 4);

  return (
    <div className="extension-grid">
      <section className="extension-column" aria-label={`${app.name} MCP`}>
        <ExtensionColumnHeader
          icon={<PlugZap size={18} />}
          title="MCP"
          count={summary.mcpServers.length}
          onCreate={() => onCreate("mcp")}
        />
        <div className="extension-list">
          {summary.mcpServers.length > 0 ? (
            summary.mcpServers.map((server) => {
              const key = actionKey("mcp", app.id, server.id);
              return (
                <div className="extension-row" key={server.id}>
                  <div className="extension-main">
                    <div className="extension-title-row">
                      <strong>{server.name}</strong>
                      <span className={server.enabled ? "state-tag active" : "state-tag"}>
                        {server.enabled ? "启用" : "停用"}
                      </span>
                    </div>
                    <span className="extension-command">
                      {formatCommand(server.command, server.args)}
                    </span>
                    <span className="extension-meta">
                      {formatApps(server.apps)} · {Object.keys(server.env).length} env
                    </span>
                  </div>
                  <div className="row-actions">
                    <button
                      className="mini-button"
                      type="button"
                      title="确认后投影"
                      disabled={!server.enabled || actionBusy === key}
                      onClick={() => onMcpWrite(server)}
                    >
                      <Link2 size={15} />
                      <span>{actionBusy === key ? "预览中" : "投影"}</span>
                    </button>
                    <button
                      className="mini-icon-button"
                      type="button"
                      title="编辑 MCP"
                      onClick={() => onEdit(server, "mcp")}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="mini-icon-button danger"
                      type="button"
                      title="删除 MCP"
                      onClick={() => onDelete("mcp", server.id, server.name)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty-state compact">暂无 MCP</div>
          )}
        </div>
      </section>

      <section className="extension-column" aria-label={`${app.name} Prompt`}>
        <ExtensionColumnHeader
          icon={<FileText size={18} />}
          title="Prompt"
          count={summary.promptPresets.length}
          onCreate={() => onCreate("prompt")}
        />
        <div className="extension-list">
          {summary.promptPresets.length > 0 ? (
            summary.promptPresets.map((prompt) => {
              const key = actionKey("prompt", app.id, prompt.id);
              return (
                <div className="extension-row" key={prompt.id}>
                  <div className="extension-main">
                    <div className="extension-title-row">
                      <strong>{prompt.name}</strong>
                      <span className="state-tag active">{formatApps(prompt.apps)}</span>
                    </div>
                    <span className="extension-command">{previewText(prompt.content)}</span>
                    <span className="extension-meta">{prompt.updatedAt}</span>
                  </div>
                  <div className="row-actions">
                    <button
                      className="mini-button"
                      type="button"
                      title="确认后激活"
                      disabled={actionBusy === key}
                      onClick={() => onPromptWrite(prompt)}
                    >
                      <BookOpen size={15} />
                      <span>{actionBusy === key ? "预览中" : "激活"}</span>
                    </button>
                    <button
                      className="mini-icon-button"
                      type="button"
                      title="编辑 Prompt"
                      onClick={() => onEdit(prompt, "prompt")}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="mini-icon-button danger"
                      type="button"
                      title="删除 Prompt"
                      onClick={() => onDelete("prompt", prompt.id, prompt.name)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty-state compact">暂无 Prompt</div>
          )}
        </div>
      </section>

      <section className="extension-column" aria-label={`${app.name} Skills`}>
        <ExtensionColumnHeader
          icon={<PackageCheck size={18} />}
          title="Skills"
          count={summary.skills.length}
          onCreate={() => onCreate("skill")}
        />
        <div className="extension-list">
          {summary.skills.length > 0 ? (
            summary.skills.map((skill) => (
              <div className="extension-row skill-row" key={skill.id}>
                <div className="extension-main">
                  <div className="extension-title-row">
                    <strong>{skill.name}</strong>
                    <span className={skill.enabled ? "state-tag active" : "state-tag"}>
                      {skill.version ?? (skill.enabled ? "启用" : "停用")}
                    </span>
                  </div>
                  <span className="extension-command">
                    {skill.description ?? "No description"}
                  </span>
                  <span className="extension-meta path-text">{skill.sourcePath}</span>
                </div>
                <div className="row-actions">
                  {(["copy", "symlink"] as const).map((mode) => {
                    const key = actionKey("skill", app.id, skill.id, mode);
                    return (
                      <button
                        className="mini-button"
                        type="button"
                        title={mode === "copy" ? "预览 copy 安装" : "预览 symlink 安装"}
                        disabled={!skill.enabled || actionBusy === key}
                        key={mode}
                        onClick={() => onSkillWrite(skill, mode)}
                      >
                        {mode === "copy" ? <Copy size={15} /> : <Link2 size={15} />}
                        <span>{actionBusy === key ? "预览中" : mode}</span>
                      </button>
                    );
                  })}
                  <button
                    className="mini-icon-button"
                    type="button"
                    title="编辑 Skill"
                    onClick={() => onEdit(skill, "skill")}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="mini-icon-button danger"
                    type="button"
                    title="删除 Skill"
                    onClick={() => onDelete("skill", skill.id, skill.name)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state compact">暂无 Skill</div>
          )}
        </div>

        <div className="skill-registry-sync" aria-label="Skill Registry Sync">
          <div className="source-list-heading">
            <Upload size={15} />
            <span>Registry</span>
          </div>
          <label className="skill-registry-field">
            <span>Profile</span>
            <select
              aria-label="Skill registry profile"
              value={skillRegistryValues.profileId}
              onChange={(event) => onSkillRegistryProfileSelect(event.target.value)}
            >
              <option value="">Manual registry</option>
              {summary.skillRegistryProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <label className="skill-registry-field">
            <span>Profile name</span>
            <input
              aria-label="Skill registry profile name"
              value={skillRegistryValues.profileName}
              onChange={(event) =>
                onSkillRegistryChange({
                  ...skillRegistryValues,
                  profileId: "",
                  profileName: event.target.value
                })
              }
            />
          </label>
          <label className="skill-registry-field">
            <span>Registry URL</span>
            <input
              aria-label="Skill registry URL"
              value={skillRegistryValues.registryUrl}
              onChange={(event) =>
                onSkillRegistryChange({
                  ...skillRegistryValues,
                  profileId: "",
                  registryUrl: event.target.value
                })
              }
            />
          </label>
          <label className="skill-registry-check">
            <input
              aria-label="Require signature"
              type="checkbox"
              checked={skillRegistryValues.requireSignature}
              onChange={(event) =>
                onSkillRegistryChange({
                  ...skillRegistryValues,
                  profileId: "",
                  requireSignature: event.target.checked
                })
              }
            />
            <span>Require signature</span>
          </label>
          <label className="skill-registry-check">
            <input
              aria-label="Require release metadata"
              type="checkbox"
              checked={skillRegistryValues.requireReleaseMetadata}
              onChange={(event) =>
                onSkillRegistryChange({
                  ...skillRegistryValues,
                  profileId: "",
                  requireReleaseMetadata: event.target.checked
                })
              }
            />
            <span>Require release metadata</span>
          </label>
          <label className="skill-registry-field">
            <span>Public key</span>
            <textarea
              aria-label="Registry public key"
              rows={2}
              value={skillRegistryValues.publicKey}
              onChange={(event) =>
                onSkillRegistryChange({
                  ...skillRegistryValues,
                  profileId: "",
                  publicKey: event.target.value
                })
              }
            />
          </label>
          <label className="skill-registry-field">
            <span>Trusted keys</span>
            <textarea
              aria-label="Registry trusted keys"
              rows={3}
              value={skillRegistryValues.trustedPublicKeysText}
              onChange={(event) =>
                onSkillRegistryChange({
                  ...skillRegistryValues,
                  profileId: "",
                  trustedPublicKeysText: event.target.value
                })
              }
            />
          </label>
          <label className="skill-registry-field">
            <span>Revoked key IDs</span>
            <textarea
              aria-label="Registry revoked key IDs"
              rows={2}
              value={skillRegistryValues.revokedPublicKeyIdsText}
              onChange={(event) =>
                onSkillRegistryChange({
                  ...skillRegistryValues,
                  profileId: "",
                  revokedPublicKeyIdsText: event.target.value
                })
              }
            />
          </label>
          <div className="skill-registry-actions">
            <button
              className="mini-button"
              type="button"
              title="保存 Registry profile"
              disabled={
                !skillRegistryValues.profileName.trim() ||
                !skillRegistryValues.registryUrl.trim() ||
                actionBusy === "skill:registry:profile:save"
              }
              onClick={onSkillRegistryProfileSave}
            >
              <Save size={15} />
              <span>{actionBusy === "skill:registry:profile:save" ? "保存中" : "保存"}</span>
            </button>
            <button
              className="mini-button"
              type="button"
              title="预览并同步 Registry"
              disabled={!skillRegistryValues.registryUrl.trim() || actionBusy === "skill:registry:sync"}
              onClick={onSkillRegistrySync}
            >
              <Upload size={15} />
              <span>{actionBusy === "skill:registry:sync" ? "预览中" : "同步"}</span>
            </button>
          </div>
        </div>

        {discoveredSkills.length > 0 ? (
          <div className="source-list">
            <div className="source-list-heading">
              <ScanSearch size={15} />
              <span>发现来源</span>
            </div>
            {discoveredSkills.map((skill) => (
              <SourceCandidateRow
                key={skill.sourcePath}
                skill={skill}
                onRegister={() => onRegisterSkill(skill)}
              />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ObservabilityPanel({
  app,
  summary,
  selectedSessionId,
  sessionDetail,
  sessionLoading,
  sessionFilter,
  error,
  onSessionDraftChange,
  onSessionSearch,
  onSessionClear,
  onSessionPage,
  onSessionRedactChange,
  onSessionExport,
  sessionExporting,
  onResetProviderHealth,
  proxyHealthResetBusy,
  onSelectSession
}: {
  app: ManagedAgentApp;
  summary: ObservabilitySummary;
  selectedSessionId: string | null;
  sessionDetail: SessionDetailSummary | null;
  sessionLoading: boolean;
  sessionFilter: SessionFilterState;
  error: string | null;
  onSessionDraftChange: (value: string) => void;
  onSessionSearch: () => void;
  onSessionClear: () => void;
  onSessionPage: (offset: number) => void;
  onSessionRedactChange: (redact: boolean) => void;
  onSessionExport: () => void;
  sessionExporting: boolean;
  onResetProviderHealth: (health: ProviderHealthSummary) => void;
  proxyHealthResetBusy: string | null;
  onSelectSession: (session: SessionSummary) => void;
}) {
  const usage = summary.usage;
  const topModels = usage.byModel.slice(0, 5);
  const providerHealth = summary.providerHealth.slice(0, 6);
  const unhealthyProviders = summary.providerHealth.filter(
    (health) => health.state === "degraded" || health.state === "circuit_open"
  ).length;
  const latestLogs = summary.proxyLogs.slice(0, 8);
  const latestSessions = summary.sessions;
  const pagination = summary.sessionPagination;
  const previousOffset = Math.max(0, pagination.offset - pagination.limit);
  const nextOffset = pagination.nextOffset ?? pagination.offset + pagination.limit;
  const pageRange = latestSessions.length > 0
    ? `${pagination.offset + 1}-${pagination.offset + latestSessions.length}`
    : "0";

  return (
    <div className="observability-layout">
      <div className="observability-metrics" aria-label={`${app.name} usage metrics`}>
        <MiniMetric
          icon={<BarChart3 size={18} />}
          label="Tokens"
          value={formatNumber(usage.totalTokens)}
          detail={`${formatNumber(usage.inputTokens)} in / ${formatNumber(usage.outputTokens)} out`}
        />
        <MiniMetric
          icon={<ListTree size={18} />}
          label="Requests"
          value={formatNumber(usage.requestCount)}
          detail={`${usage.byProvider.length} providers`}
        />
        <MiniMetric
          icon={<MessageSquareText size={18} />}
          label="Sessions"
          value={formatNumber(summary.sessions.length)}
          detail={summary.sessions[0]?.updatedAt ? formatDateTime(summary.sessions[0].updatedAt) : "No session"}
        />
        <MiniMetric
          icon={<Activity size={18} />}
          label="Proxy Health"
          value={formatNumber(summary.providerHealth.length)}
          detail={`${unhealthyProviders} attention`}
        />
        <MiniMetric
          icon={<SquareTerminal size={18} />}
          label="Cost"
          value={formatCost(usage.estimatedCostUsd)}
          detail="estimated"
        />
      </div>

      {error ? (
        <div className="inline-alert" role="status">
          <CircleAlert size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="observability-grid">
        <section className="observability-column" aria-label={`${app.name} usage by model`}>
          <ObservabilityColumnHeader icon={<BarChart3 size={17} />} title="Usage" count={topModels.length} />
          <div className="observability-list">
            {topModels.length > 0 ? (
              topModels.map((bucket) => (
                <div className="usage-row" key={bucket.key}>
                  <div>
                    <strong>{bucket.model ?? bucket.key}</strong>
                    <span>{bucket.providerId ?? "provider"} · {bucket.requestCount} requests</span>
                  </div>
                  <div className="usage-values">
                    <strong>{formatNumber(bucket.totalTokens)}</strong>
                    <span>{formatCost(bucket.estimatedCostUsd)}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state compact">暂无 usage</div>
            )}
          </div>
        </section>

        <section className="observability-column" aria-label={`${app.name} proxy health`}>
          <ObservabilityColumnHeader
            icon={<Activity size={17} />}
            title="Proxy Health"
            count={providerHealth.length}
          />
          <div className="observability-list">
            {providerHealth.length > 0 ? (
              providerHealth.map((health) => (
                <ProxyHealthRow
                  health={health}
                  key={`${health.app}:${health.providerId}`}
                  onReset={onResetProviderHealth}
                  resetting={proxyHealthResetBusy === `${health.app}:${health.providerId}`}
                />
              ))
            ) : (
              <div className="empty-state compact">暂无 provider health</div>
            )}
          </div>
        </section>

        <section className="observability-column" aria-label={`${app.name} sessions`}>
          <ObservabilityColumnHeader
            icon={<MessageSquareText size={17} />}
            title="Sessions"
            count={latestSessions.length}
          />
          <form
            className="session-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              onSessionSearch();
            }}
          >
            <input
              aria-label="Search sessions"
              className="session-search-input"
              value={sessionFilter.draft}
              placeholder="Search sessions"
              onChange={(event) => onSessionDraftChange(event.target.value)}
            />
            <button className="mini-icon-button" type="submit" title="搜索 session">
              <ScanSearch size={15} />
            </button>
            <button
              className="mini-icon-button"
              type="button"
              title="清除 session 搜索"
              disabled={!sessionFilter.draft && !sessionFilter.query}
              onClick={onSessionClear}
            >
              <X size={15} />
            </button>
            <label className="toggle-row session-redact-toggle" title="脱敏 session">
              <input
                aria-label="Redact sessions"
                type="checkbox"
                checked={sessionFilter.redact}
                onChange={(event) => onSessionRedactChange(event.target.checked)}
              />
              <span>脱敏</span>
            </label>
            <div className="session-page-controls">
              <button
                className="mini-icon-button"
                type="button"
                title="上一页"
                disabled={pagination.offset === 0}
                onClick={() => onSessionPage(previousOffset)}
              >
                <ChevronLeft size={15} />
              </button>
              <span>{pageRange}</span>
              <button
                className="mini-icon-button"
                type="button"
                title="下一页"
                disabled={!pagination.hasMore}
                onClick={() => onSessionPage(nextOffset)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </form>
          <div className="privacy-note">
            <ShieldCheck size={14} />
            <span>本地 session 内容，可能包含代码、密钥或私有路径</span>
          </div>
          <div className="observability-list">
            {latestSessions.length > 0 ? (
              latestSessions.map((session) => (
                <button
                  className={`session-row ${session.id === selectedSessionId ? "selected" : ""}`}
                  type="button"
                  key={session.id}
                  onClick={() => onSelectSession(session)}
                >
                  <div>
                    <strong>{session.title}</strong>
                    <span>{session.cwd ?? session.sourceRoot}</span>
                  </div>
                  <span className="session-meta">
                    {session.messageCount} msgs · {formatNumber(session.totalTokens)}
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-state compact">
                {sessionFilter.query ? "无匹配 session" : "暂无 session"}
              </div>
            )}
          </div>
          <SessionPreview
            detail={sessionDetail}
            loading={sessionLoading}
            exporting={sessionExporting}
            onExport={onSessionExport}
          />
        </section>

        <section className="observability-column" aria-label={`${app.name} proxy logs`}>
          <ObservabilityColumnHeader
            icon={<SquareTerminal size={17} />}
            title="Proxy Logs"
            count={latestLogs.length}
          />
          <div className="observability-list">
            {latestLogs.length > 0 ? (
              latestLogs.map((log) => <ProxyLogRow log={log} key={log.id} />)
            ) : (
              <div className="empty-state compact">暂无 proxy log</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function MiniMetric({
  icon,
  label,
  value,
  detail
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="mini-metric">
      <span className="mini-metric-icon">{icon}</span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function ObservabilityColumnHeader({
  icon,
  title,
  count
}: {
  icon: ReactNode;
  title: string;
  count: number;
}) {
  return (
    <div className="observability-column-header">
      <span className="extension-column-icon">{icon}</span>
      <strong>{title}</strong>
      <span className="extension-count">{count}</span>
    </div>
  );
}

function SessionPreview({
  detail,
  loading,
  exporting,
  onExport
}: {
  detail: SessionDetailSummary | null;
  loading: boolean;
  exporting: boolean;
  onExport: () => void;
}) {
  if (loading) {
    return <div className="session-preview muted">读取 session</div>;
  }
  if (!detail) return null;
  return (
    <div className="session-preview">
      <div className="session-preview-heading">
        <div>
          <strong>{detail.title}</strong>
          <span>{detail.model ?? detail.sourceRoot}</span>
        </div>
        <button
          className="mini-icon-button"
          type="button"
          title="导出 session"
          disabled={exporting}
          onClick={onExport}
        >
          <Download size={15} />
        </button>
      </div>
      {detail.messages.slice(0, 3).map((message, index) => (
        <div className="message-snippet" key={`${message.timestamp ?? message.role}-${index}`}>
          <span className={`role-chip ${message.role}`}>{roleLabel(message.role)}</span>
          <p>{message.text ? previewText(message.text) : message.rawType ?? "No text"}</p>
        </div>
      ))}
    </div>
  );
}

function ProxyHealthRow({
  health,
  onReset,
  resetting
}: {
  health: ProviderHealthSummary;
  onReset: (health: ProviderHealthSummary) => void;
  resetting: boolean;
}) {
  const stateClass = health.state === "healthy" ? "active" : "";
  const status = health.lastStatusCode ? String(health.lastStatusCode) : health.state;
  const canReset = health.state === "degraded" || health.state === "circuit_open";
  const detail = health.lastError
    ? previewText(health.lastError, 52)
    : health.lastSuccessAt
      ? formatDateTime(health.lastSuccessAt)
      : health.updatedAt
        ? formatDateTime(health.updatedAt)
        : "No event";
  return (
    <div className="proxy-health-row">
      <div>
        <strong>{health.providerName}</strong>
        <span>{providerHealthStateLabel(health.state)} · {detail}</span>
      </div>
      <div className="proxy-log-values">
        <span className={`state-tag ${stateClass}`}>{status}</span>
        <span>{health.consecutiveFailures} fail</span>
        <span>{health.lastLatencyMs ?? 0} ms</span>
        <button
          className="mini-icon-button"
          type="button"
          title={`重置 ${health.providerName} health`}
          disabled={!canReset || resetting}
          onClick={() => onReset(health)}
        >
          <RotateCcw size={15} />
        </button>
      </div>
    </div>
  );
}

function ProxyLogRow({ log }: { log: ProxyRequestLogSummary }) {
  const ok = log.statusCode >= 200 && log.statusCode < 400;
  const runLabel = log.runId
    ? ` · run ${log.runId.slice(0, 8)}${log.candidateId ? `/${log.candidateId}` : ""}`
    : "";
  const toolSummary = proxyLogToolSummary(log);
  return (
    <div className="proxy-log-row">
      <div>
        <strong>{log.model}</strong>
        <span>{log.providerId}{runLabel} · {formatDateTime(log.createdAt)}</span>
      </div>
      <div className="proxy-log-values">
        <span className={ok ? "state-tag active" : "state-tag"}>{log.statusCode}</span>
        <span>{log.latencyMs} ms</span>
        {toolSummary ? <span>{toolSummary}</span> : null}
        <span>{formatNumber(log.inputTokens + log.outputTokens)} tok</span>
      </div>
    </div>
  );
}

function proxyLogToolSummary(log: ProxyRequestLogSummary): string | null {
  if (!log.containsToolCall) return null;
  const calls = log.toolCalls ?? [];
  if (!calls.length) return "tools detected";
  const label = calls
    .slice(0, 2)
    .map((toolCall) => `${toolCall.name}:${formatToolReplayEffect(toolCall.effect)}`)
    .join(", ");
  const suffix = calls.length > 2 ? ` +${calls.length - 2}` : "";
  const unsafe = calls.some((toolCall) => !toolCall.replaySafe) ? " blocked" : "";
  return `tools ${label}${suffix}${unsafe}`;
}

function formatToolReplayEffect(effect: string): string {
  return effect === "side_effect" ? "side-effect" : effect;
}

function providerHealthStateLabel(state: ProviderHealthSummary["state"]): string {
  if (state === "healthy") return "healthy";
  if (state === "degraded") return "degraded";
  if (state === "circuit_open") return "circuit open";
  return "unknown";
}

function ExtensionColumnHeader({
  icon,
  title,
  count,
  onCreate
}: {
  icon: ReactNode;
  title: string;
  count: number;
  onCreate: () => void;
}) {
  return (
    <div className="extension-column-header">
      <span className="extension-column-icon">{icon}</span>
      <strong>{title}</strong>
      <span className="extension-count">{count}</span>
      <button
        className="mini-icon-button"
        type="button"
        title={`新增 ${title}`}
        onClick={onCreate}
      >
        <Plus size={15} />
      </button>
    </div>
  );
}

function SourceCandidateRow({
  skill,
  onRegister
}: {
  skill: SkillSourceCandidate;
  onRegister: () => void;
}) {
  return (
    <div className="source-row">
      <div>
        <strong>{skill.name}</strong>
        <span>{skill.version ?? skill.sourceRoot}</span>
      </div>
      <span className="path-text">{skill.sourcePath}</span>
      <button className="mini-button" type="button" onClick={onRegister}>
        <Plus size={15} />
        <span>登记</span>
      </button>
    </div>
  );
}

function AgentDetail({ app }: { app: ManagedAgentApp }) {
  const rows = [
    { icon: <Terminal size={18} />, label: "Binary", value: app.binary.binary },
    { icon: <KeyRound size={18} />, label: "Provider", value: app.currentProvider },
    { icon: <FolderCog size={18} />, label: "Config", value: app.configPath },
    { icon: <ShieldCheck size={18} />, label: "Prompt", value: app.promptPath },
    { icon: <Database size={18} />, label: "Skills", value: app.skillPath }
  ];

  return (
    <div className="agent-detail">
      <div className="agent-title">
        <div className={`agent-icon ${app.id}`}>
          <Bot size={23} />
        </div>
        <div>
          <h4>{app.name}</h4>
          <p>{app.binary.detail}</p>
        </div>
        {app.binary.ok ? (
          <CheckCircle2 className="status-icon good" size={22} />
        ) : (
          <XCircle className="status-icon danger" size={22} />
        )}
      </div>

      <div className="agent-facts">
        {rows.map((row) => (
          <div className="fact-row" key={row.label}>
            {row.icon}
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>

      <div className="restart-row">
        <StatusPill ok={!app.restartRequired} label={app.restartRequired ? "restart required" : "hot switch"} />
      </div>
    </div>
  );
}

function MetricPanel({
  icon,
  label,
  value,
  detail,
  tone
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: "good" | "danger" | "accent" | "neutral";
}) {
  return (
    <div className={`metric-panel ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function createEditor(kind: EditorKind, app: AgentAppId): ExtensionEditorState {
  if (kind === "mcp") {
    return {
      kind,
      mode: "create",
      values: {
        name: "",
        command: "",
        argsText: "",
        envText: "",
        apps: [app],
        enabled: true
      }
    };
  }
  if (kind === "prompt") {
    return {
      kind,
      mode: "create",
      values: {
        name: "",
        content: "",
        apps: [app]
      }
    };
  }
  return {
    kind,
    mode: "create",
    values: {
      name: "",
      sourcePath: "",
      description: "",
      version: "",
      apps: [app],
      enabled: true
    }
  };
}

function editEditor(
  kind: EditorKind,
  item: McpServerSummary | PromptPresetSummary | SkillSummary
): ExtensionEditorState {
  if (kind === "mcp") {
    const server = item as McpServerSummary;
    return {
      kind,
      mode: "edit",
      item: server,
      values: {
        name: server.name,
        command: server.command,
        argsText: server.args.join("\n"),
        envText: "",
        apps: server.apps,
        enabled: server.enabled
      }
    };
  }
  if (kind === "prompt") {
    const prompt = item as PromptPresetSummary;
    return {
      kind,
      mode: "edit",
      item: prompt,
      values: {
        name: prompt.name,
        content: prompt.content,
        apps: prompt.apps
      }
    };
  }
  const skill = item as SkillSummary;
  return {
    kind,
    mode: "edit",
    item: skill,
    values: {
      name: skill.name,
      sourcePath: skill.sourcePath,
      description: skill.description ?? "",
      version: skill.version ?? "",
      apps: skill.apps,
      enabled: skill.enabled
    }
  };
}

function defaultProviderValues(app: AgentAppId): ProviderFormValues {
  if (app === "claude") {
    return {
      app,
      name: "Claude Provider",
      kind: "anthropic_compatible",
      apiFormat: "anthropic_messages",
      baseUrl: "https://api.anthropic.com",
      defaultModel: "claude-sonnet-4-5",
      wireApi: "",
      apiKey: "",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      healthFailureThreshold: "",
      healthCircuitOpenMs: "",
      replayToolCalls: false,
      replayReadonlyTools: "",
      replayIdempotentTools: "",
      replaySideEffectTools: "",
      modelCatalog: [],
      config: {}
    };
  }
  return {
    app,
    name: "Codex Provider",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: "https://example.com/v1",
    defaultModel: "openai-compatible-model",
    wireApi: "chat",
    apiKey: "",
    apiKeyEnv: "OPENAI_API_KEY",
    healthFailureThreshold: "",
    healthCircuitOpenMs: "",
    replayToolCalls: false,
    replayReadonlyTools: "",
    replayIdempotentTools: "",
    replaySideEffectTools: "",
    modelCatalog: [],
    config: {}
  };
}

function providerValuesFromSummary(provider: ProviderSummary): ProviderFormValues {
  const config = plainRecord(provider.config);
  const healthPolicy = plainRecord(config.healthPolicy);
  const toolReplayPolicy = toolReplayPolicyValuesFromConfig(config);
  return {
    app: provider.app,
    name: provider.name,
    kind: provider.kind,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    wireApi: provider.wireApi ?? "",
    apiKey: "",
    apiKeyEnv: provider.apiKeyRef?.type === "env" ? provider.apiKeyRef.ref : "",
    healthFailureThreshold: positiveIntegerString(healthPolicy.failureThreshold),
    healthCircuitOpenMs: positiveIntegerString(healthPolicy.circuitOpenMs),
    replayToolCalls: config.replayToolCalls === true,
    replayReadonlyTools: toolReplayPolicy.readonly,
    replayIdempotentTools: toolReplayPolicy.idempotent,
    replaySideEffectTools: toolReplayPolicy.sideEffect,
    modelCatalog: (provider.modelCatalog ?? []).map(providerModelValuesFromSummary),
    config
  };
}

function providerInputFromValues(values: ProviderFormValues): ProviderInput {
  return {
    app: values.app,
    name: values.name.trim(),
    kind: values.kind,
    apiFormat: values.apiFormat,
    baseUrl: values.baseUrl.trim(),
    defaultModel: values.defaultModel.trim(),
    ...(values.wireApi ? { wireApi: values.wireApi } : {}),
    ...(values.apiKey.trim() ? { apiKey: values.apiKey.trim() } : {}),
    ...(values.apiKeyEnv.trim() ? { apiKeyEnv: values.apiKeyEnv.trim() } : {}),
    modelCatalog: providerModelCatalogFromValues(values.modelCatalog),
    config: providerConfigFromValues(values)
  };
}

function providerPatchInputFromValues(values: ProviderFormValues): ProviderPatchInput {
  return {
    name: values.name.trim(),
    baseUrl: values.baseUrl.trim(),
    defaultModel: values.defaultModel.trim(),
    ...(values.wireApi ? { wireApi: values.wireApi } : {}),
    ...(values.apiKey.trim() ? { apiKey: values.apiKey.trim() } : {}),
    ...(values.apiKeyEnv.trim() ? { apiKeyEnv: values.apiKeyEnv.trim() } : {}),
    modelCatalog: providerModelCatalogFromValues(values.modelCatalog),
    config: providerConfigFromValues(values)
  };
}

function validateProviderValues(values: ProviderFormValues): string | null {
  if (!values.name.trim() || !values.baseUrl.trim() || !values.defaultModel.trim()) {
    return "Provider 名称、Base URL 和 Default model 必填";
  }
  if (values.apiKey.trim() && values.apiKeyEnv.trim()) {
    return "API key 和 API key env 只能填写一个";
  }
  const thresholdError = validatePositiveIntegerField(
    values.healthFailureThreshold,
    "Failure threshold"
  );
  if (thresholdError) return thresholdError;
  const circuitError = validatePositiveIntegerField(values.healthCircuitOpenMs, "Circuit open ms");
  if (circuitError) return circuitError;
  const replayPolicyError = validateToolReplayPolicy(values);
  if (replayPolicyError) return replayPolicyError;
  for (const [index, model] of values.modelCatalog.entries()) {
    const prefix = `Model ${index + 1}`;
    const hasAnyValue =
      model.id.trim() ||
      model.displayName.trim() ||
      model.contextWindow.trim() ||
      model.inputTokenUsdPerMillion.trim() ||
      model.outputTokenUsdPerMillion.trim() ||
      model.cachedInputTokenUsdPerMillion.trim() ||
      model.cacheCreationInputTokenUsdPerMillion.trim() ||
      model.cacheReadInputTokenUsdPerMillion.trim() ||
      model.reasoningOutputTokenUsdPerMillion.trim();
    if (!hasAnyValue) continue;
    if (!model.id.trim()) return `${prefix} ID 必填`;
    const contextError = validatePositiveIntegerField(model.contextWindow, `${prefix} context`);
    if (contextError) return contextError;
    const inputPriceError = validateNonnegativeNumberField(
      model.inputTokenUsdPerMillion,
      `${prefix} input price`
    );
    if (inputPriceError) return inputPriceError;
    const outputPriceError = validateNonnegativeNumberField(
      model.outputTokenUsdPerMillion,
      `${prefix} output price`
    );
    if (outputPriceError) return outputPriceError;
    const cachedInputPriceError = validateNonnegativeNumberField(
      model.cachedInputTokenUsdPerMillion,
      `${prefix} cached input price`
    );
    if (cachedInputPriceError) return cachedInputPriceError;
    const cacheCreationPriceError = validateNonnegativeNumberField(
      model.cacheCreationInputTokenUsdPerMillion,
      `${prefix} cache creation price`
    );
    if (cacheCreationPriceError) return cacheCreationPriceError;
    const cacheReadPriceError = validateNonnegativeNumberField(
      model.cacheReadInputTokenUsdPerMillion,
      `${prefix} cache read price`
    );
    if (cacheReadPriceError) return cacheReadPriceError;
    const reasoningPriceError = validateNonnegativeNumberField(
      model.reasoningOutputTokenUsdPerMillion,
      `${prefix} reasoning output price`
    );
    if (reasoningPriceError) return reasoningPriceError;
  }
  return null;
}

function providerModelValuesFromSummary(model: ProviderModelSummary): ProviderModelFormValue {
  const {
    id,
    displayName,
    contextWindow,
    inputTokenUsdPerMillion,
    outputTokenUsdPerMillion,
    cachedInputTokenUsdPerMillion,
    cacheCreationInputTokenUsdPerMillion,
    cacheReadInputTokenUsdPerMillion,
    reasoningOutputTokenUsdPerMillion,
    ...extra
  } = model;
  return {
    id,
    displayName,
    contextWindow: positiveIntegerString(contextWindow),
    inputTokenUsdPerMillion: nonnegativeNumberString(inputTokenUsdPerMillion),
    outputTokenUsdPerMillion: nonnegativeNumberString(outputTokenUsdPerMillion),
    cachedInputTokenUsdPerMillion: nonnegativeNumberString(cachedInputTokenUsdPerMillion),
    cacheCreationInputTokenUsdPerMillion: nonnegativeNumberString(
      cacheCreationInputTokenUsdPerMillion
    ),
    cacheReadInputTokenUsdPerMillion: nonnegativeNumberString(
      cacheReadInputTokenUsdPerMillion
    ),
    reasoningOutputTokenUsdPerMillion: nonnegativeNumberString(
      reasoningOutputTokenUsdPerMillion
    ),
    extra
  };
}

function providerModelCatalogFromValues(
  values: ProviderModelFormValue[]
): ProviderModelSummary[] {
  return values
    .map((model) => {
      const id = model.id.trim();
      if (!id) return null;
      const displayName = model.displayName.trim() || id;
      const contextWindow = parsePositiveIntegerField(model.contextWindow);
      const inputTokenUsdPerMillion = parseNonnegativeNumberField(
        model.inputTokenUsdPerMillion
      );
      const outputTokenUsdPerMillion = parseNonnegativeNumberField(
        model.outputTokenUsdPerMillion
      );
      const cachedInputTokenUsdPerMillion = parseNonnegativeNumberField(
        model.cachedInputTokenUsdPerMillion
      );
      const cacheCreationInputTokenUsdPerMillion = parseNonnegativeNumberField(
        model.cacheCreationInputTokenUsdPerMillion
      );
      const cacheReadInputTokenUsdPerMillion = parseNonnegativeNumberField(
        model.cacheReadInputTokenUsdPerMillion
      );
      const reasoningOutputTokenUsdPerMillion = parseNonnegativeNumberField(
        model.reasoningOutputTokenUsdPerMillion
      );
      return {
        ...model.extra,
        id,
        displayName,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(inputTokenUsdPerMillion !== undefined ? { inputTokenUsdPerMillion } : {}),
        ...(outputTokenUsdPerMillion !== undefined ? { outputTokenUsdPerMillion } : {}),
        ...(cachedInputTokenUsdPerMillion !== undefined
          ? { cachedInputTokenUsdPerMillion }
          : {}),
        ...(cacheCreationInputTokenUsdPerMillion !== undefined
          ? { cacheCreationInputTokenUsdPerMillion }
          : {}),
        ...(cacheReadInputTokenUsdPerMillion !== undefined
          ? { cacheReadInputTokenUsdPerMillion }
          : {}),
        ...(reasoningOutputTokenUsdPerMillion !== undefined
          ? { reasoningOutputTokenUsdPerMillion }
          : {})
      };
    })
    .filter((model): model is ProviderModelSummary => model !== null);
}

function providerConfigFromValues(values: ProviderFormValues): Record<string, unknown> {
  const config = { ...values.config };
  delete config.healthPolicy;
  delete config.replayToolCalls;
  delete config.toolReplayPolicy;
  const healthPolicy: Record<string, number> = {};
  const failureThreshold = parsePositiveIntegerField(values.healthFailureThreshold);
  const circuitOpenMs = parsePositiveIntegerField(values.healthCircuitOpenMs);
  if (failureThreshold !== undefined) healthPolicy.failureThreshold = failureThreshold;
  if (circuitOpenMs !== undefined) healthPolicy.circuitOpenMs = circuitOpenMs;
  if (Object.keys(healthPolicy).length > 0) config.healthPolicy = healthPolicy;
  if (values.replayToolCalls) config.replayToolCalls = true;
  const replayTools = replayToolPolicyToolsFromValues(values);
  if (Object.keys(replayTools).length > 0) {
    config.toolReplayPolicy = { tools: replayTools };
  }
  return config;
}

function toolReplayPolicyValuesFromConfig(config: Record<string, unknown>): {
  readonly: string;
  idempotent: string;
  sideEffect: string;
} {
  const policy = plainRecord(config.toolReplayPolicy);
  const tools = plainRecord(policy.tools);
  const readonlyTools = new Set<string>();
  const idempotentTools = new Set<string>();
  const sideEffectTools = new Set<string>();
  for (const [name, effect] of Object.entries(tools)) {
    const normalizedName = name.trim();
    if (!normalizedName) continue;
    if (effect === "readonly") readonlyTools.add(normalizedName);
    if (effect === "idempotent") idempotentTools.add(normalizedName);
    if (effect === "side_effect") sideEffectTools.add(normalizedName);
  }
  addToolReplayPolicyArray(readonlyTools, policy.readonlyTools);
  addToolReplayPolicyArray(idempotentTools, policy.idempotentTools);
  addToolReplayPolicyArray(sideEffectTools, policy.sideEffectTools);
  return {
    readonly: Array.from(readonlyTools).join(", "),
    idempotent: Array.from(idempotentTools).join(", "),
    sideEffect: Array.from(sideEffectTools).join(", ")
  };
}

function addToolReplayPolicyArray(target: Set<string>, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (name) target.add(name);
  }
}

function replayToolPolicyToolsFromValues(values: ProviderFormValues): Record<string, string> {
  return {
    ...toolNamesWithEffect(values.replayReadonlyTools, "readonly"),
    ...toolNamesWithEffect(values.replayIdempotentTools, "idempotent"),
    ...toolNamesWithEffect(values.replaySideEffectTools, "side_effect")
  };
}

function toolNamesWithEffect(value: string, effect: string): Record<string, string> {
  const entries = parseToolNameList(value).map((name) => [name, effect] as const);
  return Object.fromEntries(entries);
}

function validateToolReplayPolicy(values: ProviderFormValues): string | null {
  const buckets = [
    { label: "Readonly tools", effect: "readonly", value: values.replayReadonlyTools },
    { label: "Idempotent tools", effect: "idempotent", value: values.replayIdempotentTools },
    { label: "Side-effect tools", effect: "side_effect", value: values.replaySideEffectTools }
  ];
  const seen = new Map<string, string>();
  for (const bucket of buckets) {
    for (const name of parseToolNameList(bucket.value)) {
      const previous = seen.get(name);
      if (previous && previous !== bucket.effect) {
        return `${name} 不能同时归类为 ${previous} 和 ${bucket.effect}`;
      }
      seen.set(name, bucket.effect);
    }
  }
  return null;
}

function parseToolNameList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function validatePositiveIntegerField(value: string, label: string): string | null {
  if (!value.trim()) return null;
  return parsePositiveIntegerField(value) === undefined ? `${label} 必须是正整数` : null;
}

function validateNonnegativeNumberField(value: string, label: string): string | null {
  if (!value.trim()) return null;
  return parseNonnegativeNumberField(value) === undefined ? `${label} 必须是非负数字` : null;
}

function parsePositiveIntegerField(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseNonnegativeNumberField(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function positiveIntegerString(value: unknown): string {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? String(value) : "";
}

function nonnegativeNumberString(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? String(value)
    : "";
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function skillValuesFromCandidate(
  skill: SkillSourceCandidate,
  app: AgentAppId
): SkillFormValues {
  return {
    name: skill.name,
    sourcePath: skill.sourcePath,
    description: skill.description ?? "",
    version: skill.version ?? "",
    apps: [app],
    enabled: true
  };
}

function mcpInputFromValues(values: McpFormValues): McpServerInput {
  return {
    name: values.name.trim(),
    command: values.command.trim(),
    args: parseLineList(values.argsText),
    env: parseEnv(values.envText),
    apps: normalizeApps(values.apps),
    enabled: values.enabled
  };
}

function mcpPatchInputFromValues(values: McpFormValues): McpServerPatchInput {
  return {
    name: values.name.trim(),
    command: values.command.trim(),
    args: parseLineList(values.argsText),
    ...(values.envText.trim() ? { env: parseEnv(values.envText) } : {}),
    apps: normalizeApps(values.apps),
    enabled: values.enabled
  };
}

function promptInputFromValues(values: PromptFormValues): PromptPresetInput {
  return {
    name: values.name.trim(),
    content: values.content,
    apps: normalizeApps(values.apps)
  };
}

function skillInputFromValues(values: SkillFormValues): SkillInput {
  return {
    name: values.name.trim(),
    sourcePath: values.sourcePath.trim(),
    ...(values.description.trim() ? { description: values.description.trim() } : {}),
    ...(values.version.trim() ? { version: values.version.trim() } : {}),
    apps: normalizeApps(values.apps),
    enabled: values.enabled
  };
}

function skillRegistryInputFromValues(values: SkillRegistryFormValues): SkillRegistrySyncInput {
  const trustedPublicKeys = parseTrustedPublicKeys(values.trustedPublicKeysText);
  const revokedPublicKeyIds = parseDelimitedList(values.revokedPublicKeyIdsText);
  return {
    registryUrl: values.registryUrl.trim(),
    requireSignature: values.requireSignature,
    requireReleaseMetadata: values.requireReleaseMetadata,
    ...(values.publicKey.trim() ? { publicKey: values.publicKey.trim() } : {}),
    ...(trustedPublicKeys.length > 0 ? { trustedPublicKeys } : {}),
    ...(revokedPublicKeyIds.length > 0 ? { revokedPublicKeyIds } : {})
  };
}

function skillRegistryFormFromProfile(
  profile: SkillRegistryTrustProfileSummary
): SkillRegistryFormValues {
  return {
    profileId: profile.id,
    profileName: profile.name,
    registryUrl: profile.registryUrl,
    requireSignature: profile.requireSignature,
    requireReleaseMetadata: profile.requireReleaseMetadata,
    publicKey: profile.publicKey ?? "",
    trustedPublicKeysText: trustedPublicKeysText(profile.trustedPublicKeys),
    revokedPublicKeyIdsText: profile.revokedPublicKeyIds.join("\n")
  };
}

function trustedPublicKeysText(
  publicKeys: SkillRegistryTrustProfileSummary["trustedPublicKeys"]
): string {
  return publicKeys.map((key) => `${key.id}=${key.publicKey}`).join("\n");
}

function parseTrustedPublicKeys(value: string): Array<{ id: string; publicKey: string }> {
  return parseLineList(value).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error("Trusted keys must use id=base64-spki");
    }
    const id = line.slice(0, separator).trim();
    const publicKey = line.slice(separator + 1).trim();
    if (!id || !publicKey) throw new Error("Trusted keys must include id and public key");
    return { id, publicKey };
  });
}

function parseDelimitedList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseLineList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of parseLineList(value)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Env must use KEY=value: ${line}`);
    }
    env[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return env;
}

function normalizeApps(apps: AgentAppId[]): AgentAppId[] {
  const next = agentOrder.filter((app) => apps.includes(app));
  if (next.length === 0) throw new Error("Select at least one app");
  return next;
}

function toggleApp(apps: AgentAppId[], app: AgentAppId): AgentAppId[] {
  return apps.includes(app)
    ? apps.filter((item) => item !== app)
    : agentOrder.filter((item) => [...apps, app].includes(item));
}

function editorLabel(kind: EditorKind): string {
  if (kind === "mcp") return "MCP";
  if (kind === "prompt") return "Prompt";
  return "Skill";
}

function actionKey(
  kind: "mcp" | "prompt" | "skill",
  app: AgentAppId,
  id: string,
  mode?: SkillSyncMode
): string {
  return [kind, app, id, mode].filter(Boolean).join(":");
}

function sessionExportActionKey(app: AgentAppId, id: string): string {
  return ["session", "export", app, id].join(":");
}

function safeDownloadName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "session";
}

function describePreview(result: DryRunActionResult): string {
  const state =
    result.changed === undefined ? "预览完成" : result.changed ? "将写入变更" : "无需变更";
  const target = result.targetPath ? ` -> ${result.targetPath}` : "";
  return `${result.label}: ${state}${target}`;
}

function describeProviderImportResult(result: ProviderImportResult): string {
  const importable = result.dryRun ? result.wouldImportCount : result.importedCount;
  const skipped = result.skippedCount ? `，跳过 ${result.skippedCount} 个重复项` : "";
  return `Provider 导入预览：${importable} 个可导入${skipped}`;
}

function providerImportActionResult(result: ProviderImportResult): DryRunActionResult {
  return {
    label: "Provider 导入",
    changed: result.importedCount > 0,
    targetPath: `${result.importedCount} imported / ${result.skippedCount} skipped`
  };
}

function describeDeepLinkImportResult(result: DeepLinkImportResult): string {
  const importable = result.result.dryRun
    ? result.result.wouldImportCount
    : result.result.importedCount;
  const skipped = result.result.skippedCount
    ? `，跳过 ${result.result.skippedCount} 个重复项`
    : "";
  return `Deep Link ${deepLinkKindLabel(result.kind)} 导入预览：${importable} 个可导入${skipped}`;
}

function deepLinkImportActionResult(result: DeepLinkImportResult): DryRunActionResult {
  const label = `Deep Link ${deepLinkKindLabel(result.kind)} 导入`;
  return {
    label,
    changed: result.result.importedCount > 0,
    targetPath: `${result.result.importedCount} imported / ${result.result.skippedCount} skipped`
  };
}

function deepLinkKindLabel(kind: DeepLinkImportResult["kind"]): string {
  if (kind === "mcp_servers") return "MCP";
  if (kind === "prompts") return "Prompt";
  return "Provider";
}

function envConflictKey(conflict: EnvConflictSummary): string {
  return [
    conflict.name,
    conflict.source,
    conflict.sourcePath ?? "",
    String(conflict.line ?? "")
  ].join(":");
}

function envConflictSourceLabel(conflict: EnvConflictSummary): string {
  if (conflict.source === "process.env") return "process.env";
  const line = conflict.line ? `:${conflict.line}` : "";
  if (conflict.source === "launch_agent") {
    return `launchd ${shortPath(conflict.sourcePath ?? "LaunchAgent")}${line}`;
  }
  if (conflict.source === "ide_settings") {
    return `IDE ${shortPath(conflict.sourcePath ?? "settings.json")}${line}`;
  }
  return `${shortPath(conflict.sourcePath ?? "shell profile")}${line}`;
}

function envConflictLocation(conflict: EnvConflictSummary): string {
  if (conflict.source === "process.env") return "process.env";
  const line = conflict.line ? `:${conflict.line}` : "";
  if (conflict.source === "launch_agent") {
    return `launchd ${conflict.sourcePath ?? "LaunchAgent"}${line}`;
  }
  if (conflict.source === "ide_settings") {
    return `IDE ${conflict.sourcePath ?? "settings.json"}${line}`;
  }
  return `${conflict.sourcePath ?? "shell profile"}${line}`;
}

function describeEnvCleanupResult(result: EnvCleanupSummary): string {
  const action = result.dryRun ? "Env cleanup preview" : "Env cleanup";
  const manualCount = result.manualActions?.length ?? 0;
  return `${action}: ${result.removed.length} lines across ${result.changedFiles.length} files, ${manualCount} manual actions`;
}

function envCleanupDetail(result: EnvCleanupSummary): string {
  const fileDetails = result.changedFiles
    .map((file) => {
      const backup = file.backupPath ? ` -> ${file.backupPath}` : "";
      return `${file.path}: ${file.removed.length}${backup}`;
    });
  const manualDetails = (result.manualActions ?? []).map((action) =>
    `${action.source} ${action.name}: ${action.command} (${action.note})`
  );
  const details = [...fileDetails, ...manualDetails];
  if (details.length === 0) return "No managed env changes";
  return details.join("\n");
}

function envCleanupActionResult(result: EnvCleanupSummary): DryRunActionResult {
  const manualCount = result.manualActions?.length ?? 0;
  return {
    label: "Env cleanup",
    changed: result.removed.length > 0 || manualCount > 0,
    targetPath: `${result.removed.length} removed / ${result.changedFiles.length} files / ${manualCount} manual`
  };
}

function buildDiagnosticsExport(input: {
  exportedAt: string;
  apiUrl: string;
  settings: DesktopSettings;
  runtime: RuntimeStatus | null;
  diagnostics: SystemDiagnosticsSummary;
}): DiagnosticsExportDocument {
  const logHints = [
    "~/Library/Logs/dev.muniu.desktop",
    "~/Library/Application Support/dev.muniu.desktop",
    input.diagnostics.doctor.api.mniuRoot
      ? `${input.diagnostics.doctor.api.mniuRoot}/logs`
      : undefined,
    input.diagnostics.doctor.api.workspaceRoot
  ].filter((item): item is string => Boolean(item));

  return {
    kind: "mniu.diagnostics",
    version: input.diagnostics.version,
    exportedAt: input.exportedAt,
    apiGeneratedAt: input.diagnostics.generatedAt,
    apiUrl: input.apiUrl,
    desktop: {
      tauri: isTauri(),
      userAgent: window.navigator.userAgent,
      language: window.navigator.language
    },
    settings: input.settings,
    runtime: input.runtime,
    doctor: input.diagnostics.doctor,
    logs: input.diagnostics.logs,
    crashReports: input.diagnostics.crashReports,
    appLogs: input.diagnostics.appLogs,
    logHints
  };
}

async function readLaunchAtLoginPreference(fallback: boolean): Promise<boolean> {
  if (!isTauri()) return fallback;
  try {
    return await isAutostartEnabled();
  } catch {
    return fallback;
  }
}

async function syncLaunchAtLogin(enabled: boolean): Promise<LaunchAtLoginSyncResult> {
  if (!isTauri()) return { mode: "browser", enabled };
  if (enabled) {
    await enableAutostart();
  } else {
    await disableAutostart();
  }
  return { mode: "native", enabled: await isAutostartEnabled() };
}

function shortPath(path: string): string {
  const home = "/Users/";
  const homeIndex = path.indexOf(home);
  if (homeIndex >= 0) {
    const parts = path.slice(homeIndex + home.length).split("/");
    if (parts.length > 1) return `~/${parts.slice(1).join("/")}`;
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-3).join("/")}`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].filter(Boolean).join(" ");
}

function formatApps(apps: AgentAppId[]): string {
  return apps
    .map((app) => (app === "claude" ? "Claude" : "Codex"))
    .join(" / ");
}

function previewText(value: string, maxLength = 96): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "Empty";
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function artifactDetail(artifact: RunArtifactSummary): string {
  const parts = [
    artifact.kind,
    artifact.candidateId,
    artifact.gate,
    artifact.bytes !== undefined ? formatBytes(artifact.bytes) : undefined,
    artifact.persisted ? "persisted" : undefined,
    artifact.truncated ? "truncated preview" : undefined
  ].filter(Boolean);
  return parts.join(" · ");
}

function clampPreview(value: string): string {
  const limit = 2_000;
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

async function saveRunArtifactDownload(
  content: RunArtifactDownloadSummary
): Promise<DownloadDisposition> {
  return saveBlobDownload(content.filename, content.blob);
}

async function saveJsonDownload(
  filename: string,
  value: unknown
): Promise<DownloadDisposition> {
  return saveBlobDownload(
    filename,
    new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" })
  );
}

async function saveBlobDownload(
  filename: string,
  blob: Blob
): Promise<DownloadDisposition> {
  if (isTauri()) {
    try {
      const path = await showSaveDialog({
        title: "保存文件",
        defaultPath: filename,
        canCreateDirectories: true,
        filters: dialogFiltersForDownload(filename, blob.type)
      });
      if (!path) return { status: "cancelled" };
      await writeTauriFile(path, new Uint8Array(await blob.arrayBuffer()));
      return { status: "saved", mode: "native", path };
    } catch (error) {
      console.warn("Native save failed; falling back to browser download.", error);
    }
  }

  triggerBlobDownload(blob, filename);
  return { status: "downloaded", mode: "browser" };
}

function dialogFiltersForDownload(
  filename: string,
  contentType: string
): Array<{ name: string; extensions: string[] }> | undefined {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "json" || contentType.includes("json")) {
    return [{ name: "JSON", extensions: ["json"] }];
  }
  if (extension === "tar") {
    return [{ name: "TAR archive", extensions: ["tar"] }];
  }
  if (extension === "txt" || contentType.startsWith("text/")) {
    return [{ name: "Text", extensions: ["txt", "log", "md"] }];
  }
  if (extension) {
    return [{ name: extension.toUpperCase(), extensions: [extension] }];
  }
  return undefined;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.target = "_blank";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCost(value: number | undefined): string {
  if (value === undefined) return "$0";
  if (value > 0 && value < 0.000001) return "<$0.000001";
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function roleLabel(role: SessionDetailSummary["messages"][number]["role"]): string {
  if (role === "assistant") return "AI";
  if (role === "system") return "SYS";
  if (role === "tool") return "TOOL";
  if (role === "user") return "USER";
  return "RAW";
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`status-pill ${ok ? "ok" : "warn"}`}>
      {ok ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
      {label}
    </span>
  );
}

export default App;
