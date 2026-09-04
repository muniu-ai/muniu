import type {
  ActivitySummary,
  ApiFailure,
  CodingTaskSummary,
  DeliverableSummary,
  HomeSummary,
  MemorySummary,
  OpportunitySummary,
  PluginHealth,
  ProductPluginId,
  ViewMode,
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

  updateViewMode(workspace: WorkspaceSummary, viewMode: ViewMode) {
    return this.request<WorkspaceSummary>(`/v2/workspaces/${workspace.id}`, {
      method: "PATCH", body: JSON.stringify({ expectedStreamVersion: workspace.streamVersion, viewMode }),
    });
  }

  createFirstObject(workspaceId: string, pluginId: ProductPluginId, input: string) {
    const domain = pluginId === "opc" ? "opportunities" : "repositories";
    return this.request<unknown>(`/v2/plugins/${pluginId}/${domain}`, {
      method: "POST", body: JSON.stringify({ workspaceId, input }),
    });
  }

  runReadOnlySample(workspaceId: string, pluginId: ProductPluginId) {
    return this.request<unknown>(`/v2/plugins/${pluginId}/samples/read-only`, {
      method: "POST", body: JSON.stringify({ workspaceId }),
    });
  }

  home(workspaceId: string) { return this.request<HomeSummary>(`/v2/workspaces/${workspaceId}/home`); }
  deliverables(workspaceId: string) { return this.request<readonly DeliverableSummary[]>(`/v2/deliverables?workspaceId=${encodeURIComponent(workspaceId)}`); }
  activity(workspaceId: string) { return this.request<readonly ActivitySummary[]>(`/v2/activity?workspaceId=${encodeURIComponent(workspaceId)}`); }
  memories(workspaceId: string) { return this.request<readonly MemorySummary[]>(`/v2/memories?workspaceId=${encodeURIComponent(workspaceId)}`); }
  opportunities(workspaceId: string) { return this.request<readonly OpportunitySummary[]>(`/v2/plugins/opc/opportunities?workspaceId=${encodeURIComponent(workspaceId)}`); }
  codingTasks(workspaceId: string) { return this.request<readonly CodingTaskSummary[]>(`/v2/plugins/coding/tasks?workspaceId=${encodeURIComponent(workspaceId)}`); }

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

  capture(workspaceId: string, pluginId: ProductPluginId, input: string) {
    const resource = pluginId === "opc" ? "opportunities" : "tasks";
    return this.request<unknown>(`/v2/plugins/${pluginId}/${resource}`, {
      method: "POST", body: JSON.stringify({ workspaceId, input }),
    });
  }
}
