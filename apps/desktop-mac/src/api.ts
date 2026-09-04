import type {
  AgentCatalog,
  AgentExecutionSummary,
  AgentThreadSummary,
  ActivitySummary,
  ApiFailure,
  AssetSummary,
  CodingReconciliationDecision,
  CodingReconciliationDecisionResult,
  CodingReconciliationView,
  CodingTaskSummary,
  DeliverableSummary,
  HomeSummary,
  InboxItemSummary,
  MemorySummary,
  OpcDeliverablePreview,
  OpcOpportunityCommand,
  OpportunityDetail,
  OpportunitySummary,
  PluginHealth,
  ProductPluginId,
  ThreadTurnsView,
  ViewMode,
  WorkspaceMemberSummary,
  WorkspaceSummary,
} from "./types";

const DEFAULT_API_URL = "http://127.0.0.1:7318";

export class AgentOsApiError extends Error {
  constructor(readonly detail: ApiFailure, readonly status: number) {
    super(detail.message);
    this.name = "AgentOsApiError";
  }
}

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class AgentOsClient {
  constructor(readonly baseUrl = import.meta.env.VITE_MN_API_URL ?? DEFAULT_API_URL) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (init.method && init.method !== "GET" && init.method !== "HEAD") {
      headers.set("Idempotency-Key", headers.get("Idempotency-Key") ?? idempotencyKey());
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const fallback: ApiFailure = {
        code: `HTTP_${response.status}`,
        message: "请求未完成",
        action: "稍后重试，或在收件箱查看故障详情",
        traceId: response.headers.get("x-trace-id") ?? "unknown",
        retryable: response.status >= 500,
      };
      let detail = fallback;
      try { detail = await response.json() as ApiFailure; } catch { /* 使用安全错误 */ }
      throw new AgentOsApiError(detail, response.status);
    }
    if (response.status === 204) return undefined as T;
    const body = await response.json() as { data?: T } | T;
    return typeof body === "object" && body !== null && "data" in body
      ? (body as { data: T }).data
      : body as T;
  }

  health(workspaceId?: string) {
    return this.request<{ readonly core: { readonly status: "healthy" }; readonly plugins: readonly PluginHealth[] }>(
      `/v2/health${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
    );
  }

  setup() {
    return this.request<{ readonly tenantId: string; readonly principalId: string }>("/v2/setup", {
      method: "POST", body: JSON.stringify({}),
    });
  }

  connectModel(presetId: string, apiKey: string) {
    return this.request<{ readonly id: string; readonly defaultModel: string; readonly discoveredModels: readonly string[] }>(
      "/v2/model-connections",
      { method: "POST", body: JSON.stringify({ presetId, apiKey }) },
    );
  }

  probeModel(connectionId: string, expectedStreamVersion = 1) {
    return this.request<{ readonly defaultModel: string; readonly status: "ready" }>(
      `/v2/model-connections/${encodeURIComponent(connectionId)}/probe`,
      { method: "POST", body: JSON.stringify({ expectedStreamVersion }) },
    );
  }

  createWorkspace(name: string, viewMode: ViewMode, pluginIds: readonly ProductPluginId[]) {
    return this.request<WorkspaceSummary>("/v2/workspaces", {
      method: "POST", body: JSON.stringify({ name, viewMode, pluginIds }),
    });
  }

  listWorkspaces() { return this.request<readonly WorkspaceSummary[]>("/v2/workspaces"); }
  workspaceMembers(workspaceId: string) {
    return this.request<readonly WorkspaceMemberSummary[]>(
      `/v2/workspaces/${encodeURIComponent(workspaceId)}/members`,
    );
  }
  agentCatalog(workspaceId: string) {
    return this.request<AgentCatalog>(
      `/v2/workspaces/${encodeURIComponent(workspaceId)}/agent-catalog`,
    );
  }

  threads(workspaceId: string) {
    return this.request<readonly AgentThreadSummary[]>(
      `/v2/workspaces/${encodeURIComponent(workspaceId)}/threads`,
    );
  }

  threadTurns(workspaceId: string, threadId: string) {
    return this.request<ThreadTurnsView>(
      `/v2/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(threadId)}/turns`,
    );
  }

  submitTurn(
    workspaceId: string,
    thread: Pick<AgentThreadSummary, "id" | "streamVersion">,
    message: string,
  ) {
    return this.request<AgentExecutionSummary>(
      `/v2/workspaces/${encodeURIComponent(workspaceId)}/threads/${encodeURIComponent(thread.id)}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedStreamVersion: thread.streamVersion,
          message,
        }),
      },
    );
  }

  watchWorkspaceEvents(workspaceId: string, onChange: () => void): () => void {
    const storageKey = `muniu:v2:event-cursor:${workspaceId}`;
    let cursor = storedEventCursor(storageKey);
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let consecutiveFailures = 0;

    const connect = () => {
      if (stopped) return;
      const eventUrl = new URL(
        `/v2/workspaces/${encodeURIComponent(workspaceId)}/events`,
        this.baseUrl,
      );
      eventUrl.searchParams.set("after", String(cursor));
      source = new EventSource(eventUrl);
      source.addEventListener("open", () => { consecutiveFailures = 0; });
      source.addEventListener("kernel", (event) => {
        cursor = Math.max(cursor, reportedEventPosition(event) ?? cursor);
        storeEventCursor(storageKey, cursor);
        onChange();
      });
      source.addEventListener("cursor", (event) => {
        const reported = reportedEventPosition(event);
        if (reported === undefined) return;
        const stateWasReset = reported < cursor;
        cursor = reported;
        storeEventCursor(storageKey, cursor);
        if (stateWasReset) onChange();
      });
      source.addEventListener("error", () => {
        source?.close();
        source = undefined;
        if (stopped) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 2 && cursor > 0) {
          cursor = 0;
          storeEventCursor(storageKey, cursor);
          onChange();
        }
        reconnectTimer = setTimeout(connect, Math.min(2_000, consecutiveFailures * 500));
      });
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }

  updateViewMode(workspace: WorkspaceSummary, viewMode: ViewMode) {
    return this.request<WorkspaceSummary>(`/v2/workspaces/${workspace.id}`, {
      method: "PATCH", body: JSON.stringify({ expectedStreamVersion: workspace.streamVersion, viewMode }),
    });
  }

  createFirstObject(workspaceId: string, pluginId: ProductPluginId, input: string) {
    const domain = pluginId === "opc" ? "opportunities" : "repositories";
    return this.request<unknown>(`/v2/plugins/${pluginId}/${domain}`, {
      method: "POST", body: JSON.stringify({ workspaceId, expectedStreamVersion: 0, input }),
    });
  }

  runReadOnlySample(workspaceId: string, pluginId: ProductPluginId) {
    return this.request<unknown>(`/v2/plugins/${pluginId}/samples/read-only`, {
      method: "POST", body: JSON.stringify({ workspaceId, expectedStreamVersion: 0 }),
    });
  }

  home(workspaceId: string) { return this.request<HomeSummary>(`/v2/workspaces/${workspaceId}/home`); }
  inbox(workspaceId: string) { return this.request<readonly InboxItemSummary[]>(`/v2/inbox?workspaceId=${encodeURIComponent(workspaceId)}`); }
  deliverables(workspaceId: string) { return this.request<readonly DeliverableSummary[]>(`/v2/deliverables?workspaceId=${encodeURIComponent(workspaceId)}`); }
  activity(workspaceId: string) { return this.request<readonly ActivitySummary[]>(`/v2/activity?workspaceId=${encodeURIComponent(workspaceId)}`); }
  memories(workspaceId: string) { return this.request<readonly MemorySummary[]>(`/v2/memories?workspaceId=${encodeURIComponent(workspaceId)}`); }
  opportunities(workspaceId: string) { return this.request<readonly OpportunitySummary[]>(`/v2/plugins/opc/opportunities?workspaceId=${encodeURIComponent(workspaceId)}`); }
  opportunity(workspaceId: string, opportunityId: string) {
    return this.request<OpportunityDetail>(
      `/v2/plugins/opc/opportunities/${encodeURIComponent(opportunityId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }
  commandOpportunity(
    workspaceId: string,
    opportunity: Pick<OpportunityDetail, "id" | "streamVersion">,
    command: OpcOpportunityCommand,
    input: Readonly<Record<string, unknown>> = {},
  ) {
    return this.request<OpportunityDetail>(
      `/v2/plugins/opc/opportunities/${encodeURIComponent(opportunity.id)}/commands`,
      {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          expectedStreamVersion: opportunity.streamVersion,
          command,
          input,
        }),
      },
    );
  }
  opportunityDeliverables(workspaceId: string, opportunityId: string) {
    return this.request<readonly OpcDeliverablePreview[]>(
      `/v2/plugins/opc/opportunities/${encodeURIComponent(opportunityId)}/deliverables?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }
  exportOpportunity(workspaceId: string, opportunity: Pick<OpportunityDetail, "id" | "streamVersion">) {
    return this.request<readonly DeliverableSummary[]>(
      `/v2/plugins/opc/opportunities/${encodeURIComponent(opportunity.id)}/exports`,
      {
        method: "POST",
        body: JSON.stringify({ workspaceId, expectedStreamVersion: opportunity.streamVersion }),
      },
    );
  }
  async uploadAsset(workspaceId: string, file: File, protectedValue: boolean) {
    const [asset] = await this.request<readonly AssetSummary[]>("/v2/assets", {
      method: "POST",
      body: JSON.stringify({
        workspaceId,
        expectedStreamVersion: 0,
        attachments: [{
          fileName: file.name,
          mediaType: attachmentMediaType(file),
          contentBase64: await fileBase64(file),
          protected: protectedValue,
        }],
      }),
    });
    if (!asset) throw new Error("Host 没有返回已上传附件");
    return asset;
  }
  codingTasks(workspaceId: string) { return this.request<readonly CodingTaskSummary[]>(`/v2/plugins/coding/tasks?workspaceId=${encodeURIComponent(workspaceId)}`); }

  codingReconciliation(executionId: string) {
    return this.request<CodingReconciliationView>(
      `/v2/plugins/coding/executions/${encodeURIComponent(executionId)}/reconciliation`,
    );
  }

  decideCodingReconciliation(
    reconciliation: CodingReconciliationView,
    decision: CodingReconciliationDecision,
  ) {
    return this.request<CodingReconciliationDecisionResult>(
      `/v2/plugins/coding/executions/${encodeURIComponent(reconciliation.executionId)}/reconciliation-decisions`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedStreamVersion: reconciliation.expectedStreamVersion,
          expectedCodingStreamVersion: reconciliation.expectedCodingStreamVersion,
          decision,
        }),
      },
    );
  }

  decideApproval(approvalId: string, streamVersion: number, decision: "approve_once" | "deny") {
    return this.request<unknown>(`/v2/approvals/${approvalId}/decisions`, {
      method: "POST", body: JSON.stringify({ expectedStreamVersion: streamVersion, decision }),
    });
  }

  decideMemory(memoryId: string, streamVersion: number, decision: "accept" | "reject") {
    return this.request<unknown>(`/v2/memories/${memoryId}/decisions`, {
      method: "POST", body: JSON.stringify({ expectedStreamVersion: streamVersion, decision }),
    });
  }

  reviseMemory(memoryId: string, streamVersion: number, summary: string, confidence: number) {
    return this.request<unknown>(`/v2/memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedStreamVersion: streamVersion, confidence, value: { summary } }),
    });
  }

  deleteMemory(memoryId: string, streamVersion: number, reason: string) {
    return this.request<unknown>(`/v2/memories/${encodeURIComponent(memoryId)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedStreamVersion: streamVersion, reason }),
    });
  }

  capture(workspaceId: string, pluginId: ProductPluginId, input: string) {
    const resource = pluginId === "opc" ? "opportunities" : "tasks";
    return this.request<unknown>(`/v2/plugins/${pluginId}/${resource}`, {
      method: "POST", body: JSON.stringify({ workspaceId, expectedStreamVersion: 0, input }),
    });
  }
}

function reportedEventPosition(event: Event): number | undefined {
  const candidate = Number((event as MessageEvent).lastEventId);
  return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function storedEventCursor(storageKey: string): number {
  try {
    const candidate = Number(sessionStorage.getItem(storageKey) ?? "0");
    return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
  } catch {
    return 0;
  }
}

function storeEventCursor(storageKey: string, cursor: number): void {
  try { sessionStorage.setItem(storageKey, String(cursor)); } catch { return; }
}

const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function attachmentMediaType(file: File): string {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  return MEDIA_TYPES_BY_EXTENSION[extension] ?? (file.type || "application/octet-stream");
}

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
