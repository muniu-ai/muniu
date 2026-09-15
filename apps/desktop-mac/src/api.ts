// SPDX-License-Identifier: Apache-2.0
import { apiPath, matchApiOperation, parseApiResponse, type ApiPath, type JsonApiOperationIdV2, type ApiOutputsV2 } from "@mn/contracts/client";
import type { CodingRunnerId, ExternalCodingRunnerId, ConfirmCodingRunnerMutationBodyV2 } from "@mn/contracts";
import type {
  AgentThreadSummary,
  ApiFailure,
  CodingReconciliationDecision,
  CodingReconciliationView,
  OpcOpportunityCommand,
  OpportunityDetail,
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
  workspace(workspaceId: string) { return this.request(apiPath("getWorkspace", { workspaceId: workspaceId })); }
  pluginSurfaces(workspaceId: string) { return this.request(apiPath("getPluginSurfaces", { workspaceId: workspaceId })); }
  pluginCatalog() { return this.request(apiPath("listPluginCatalog", { })); }
  pluginInstallations() { return this.request(apiPath("listPluginInstallations", { })); }
  codingRunners(workspaceId: string) { return this.request(apiPath("listCodingRunners", {}, { workspaceId })); }
  inspectCodingRunner(workspaceId: string, runnerId: ExternalCodingRunnerId, binaryPath: string) {
    return this.request(apiPath("inspectCodingRunner", { runnerId }), { method: "POST", body: JSON.stringify({ workspaceId, binaryPath }) });
  }
  confirmCodingRunner(runnerId: ExternalCodingRunnerId, input: ConfirmCodingRunnerMutationBodyV2) {
    return this.request(apiPath("confirmCodingRunner", { runnerId }), { method: "POST", body: JSON.stringify(input) });
  }
  installPlugin(pluginId: string, version: string, expectedStreamVersion?: number) { return this.request(expectedStreamVersion === undefined ? apiPath("installPlugin", { }) : apiPath("updatePlugin", { pluginId: pluginId }), { method: expectedStreamVersion === undefined ? "POST" : "PATCH", body: JSON.stringify(expectedStreamVersion === undefined ? { pluginId, version } : { version, expectedStreamVersion }) }); }
  setPluginActivation(workspaceId: string, pluginId: string, expectedStreamVersion: number, active: boolean) { return this.request(active ? apiPath("activatePlugin", { workspaceId }) : apiPath("deactivatePlugin", { workspaceId, pluginId }), { method: active ? "POST" : "DELETE", body: JSON.stringify(active ? { pluginId, expectedStreamVersion } : { expectedStreamVersion }) }); }
  pluginCommand(workspaceId: string, pluginId: string, commandId: string, expectedStreamVersion: number, input: Readonly<Record<string, unknown>>) { return this.request(apiPath("runPluginCommand", { pluginId, commandId }), { method: "POST", body: JSON.stringify({ ...input, workspaceId, expectedStreamVersion }) }); }
  constructor(readonly baseUrl = import.meta.env.VITE_MN_API_URL ?? DEFAULT_API_URL) {}

  async request<K extends JsonApiOperationIdV2>(path: ApiPath<K>, init: RequestInit = {}): Promise<ApiOutputsV2[K]> {
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
        fieldIssues: [],
        traceId: response.headers.get("x-trace-id") ?? "unknown",
        retryable: response.status >= 500,
      };
      let detail = fallback;
      try { detail = await response.json() as ApiFailure; } catch { /* 使用安全错误 */ }
      throw new AgentOsApiError(detail, response.status);
    }
    const operationId = matchApiOperation(init.method ?? "GET", new URL(path, this.baseUrl).pathname);
    if (!operationId) throw new Error("未知 API 操作");
    try { return parseApiResponse(operationId as K, await response.json()); }
    catch {
      throw new AgentOsApiError({
        code: "RESPONSE_CONTRACT_INVALID", message: "Host 响应不符合公共契约",
        action: "确认桌面应用与 Host 均为同一 0.2 版本后重试", fieldIssues: [],
        traceId: response.headers.get("X-Trace-Id") ?? "unknown", retryable: false,
      }, response.status);
    }
  }

  health(workspaceId?: string) {
    return this.request(
      apiPath("getHealth", {}, { workspaceId }),
    );
  }

  setup() {
    return this.request(apiPath("setup", { }), {
      method: "POST", body: JSON.stringify({}),
    });
  }

  connectModel(presetId: string, apiKey: string) {
    return this.request(
      apiPath("createModelConnection", { }),
      { method: "POST", body: JSON.stringify({ presetId, apiKey }) },
    );
  }

  modelPresets() { return this.request(apiPath("listModelPresets", {})); }
  modelConnections() { return this.request(apiPath("listModelConnections", {})); }

  probeModel(connectionId: string, expectedStreamVersion = 1, makeDefault = false) {
    return this.request(
      apiPath("probeModelConnection", { connectionId: connectionId }),
      { method: "POST", body: JSON.stringify({ expectedStreamVersion, ...(makeDefault ? { makeDefault: true } : {}) }) },
    );
  }

  createWorkspace(name: string, viewMode: ViewMode, pluginIds: readonly ProductPluginId[]) {
    return this.request(apiPath("createWorkspace", { }), {
      method: "POST", body: JSON.stringify({ name, viewMode, pluginIds }),
    });
  }

  listWorkspaces() { return this.request(apiPath("listWorkspaces", { })); }
  workspaceMembers(workspaceId: string) {
    return this.request(
      apiPath("listWorkspaceMembers", { workspaceId: workspaceId }),
    );
  }
  agentCatalog(workspaceId: string) {
    return this.request(
      apiPath("getWorkspaceAgentCatalog", { workspaceId: workspaceId }),
    );
  }

  threads(workspaceId: string) {
    return this.request(
      apiPath("listThreads", { workspaceId: workspaceId }),
    );
  }

  threadTurns(workspaceId: string, threadId: string) {
    return this.request(
      apiPath("listThreadTurns", { workspaceId: workspaceId, threadId: threadId }),
    );
  }

  submitTurn(
    workspaceId: string,
    thread: Pick<AgentThreadSummary, "id" | "streamVersion">,
    message: string,
    runnerId?: CodingRunnerId,
  ) {
    return this.request(
      apiPath("createTurn", { workspaceId: workspaceId, threadId: thread.id }),
      {
        method: "POST",
        body: JSON.stringify({
          expectedStreamVersion: thread.streamVersion,
          message,
          ...(runnerId ? { runnerId } : {}),
        }),
      },
    );
  }

  executionCommand(execution: { readonly id: string; readonly streamVersion: number }, command: "follow_up" | "steer" | "cancel" | "resume", message?: string) {
    return this.request(apiPath("commandExecution", { executionId: execution.id }), {
      method: "POST", body: JSON.stringify({ expectedStreamVersion: execution.streamVersion, command, ...(message ? { message } : {}) }),
    });
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
        apiPath("streamWorkspaceEvents", { workspaceId: workspaceId }),
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
    return this.request(apiPath("updateWorkspace", { workspaceId: workspace.id }), {
      method: "PATCH", body: JSON.stringify({ expectedStreamVersion: workspace.streamVersion, viewMode }),
    });
  }

  createFirstObject(workspaceId: string, pluginId: ProductPluginId, input: string) {
    return this.request(apiPath(pluginId === "opc" ? "createOpcOpportunity" : "createCodingRepository", {}), {
      method: "POST", body: JSON.stringify({ workspaceId, expectedStreamVersion: 0, input }),
    });
  }

  runReadOnlySample(workspaceId: string, pluginId: ProductPluginId) {
    return this.request(apiPath(pluginId === "opc" ? "runOpcReadOnlySample" : "runCodingReadOnlySample", {}), {
      method: "POST", body: JSON.stringify({ workspaceId, expectedStreamVersion: 0 }),
    });
  }

  home(workspaceId: string) { return this.request(apiPath("getWorkspaceHome", { workspaceId: workspaceId })); }
  inbox(workspaceId: string) { return this.request(apiPath("listInbox", {}, { workspaceId })); }
  retryKeyRevocation(revocationId: string, expectedStreamVersion: number) {
    return this.request(
      apiPath("retryKeyRevocation", { revocationId }), {
        method: "POST", body: JSON.stringify({ expectedStreamVersion, decision: "retry" }),
      });
  }
  deliverables(workspaceId: string) { return this.request(apiPath("listDeliverables", {}, { workspaceId })); }
  activity(workspaceId: string) { return this.request(apiPath("listActivity", {}, { workspaceId })); }
  memories(workspaceId: string) { return this.request(apiPath("listMemories", {}, { workspaceId })); }
  opportunities(workspaceId: string) { return this.request(apiPath("listOpcOpportunities", {}, { workspaceId })); }
  opportunity(workspaceId: string, opportunityId: string) {
    return this.request(
      apiPath("getOpcOpportunity", { opportunityId }, { workspaceId }),
    );
  }
  commandOpportunity(
    workspaceId: string,
    opportunity: Pick<OpportunityDetail, "id" | "streamVersion">,
    command: OpcOpportunityCommand,
    input: Readonly<Record<string, unknown>> = {},
  ) {
    return this.request(
      apiPath("commandOpcOpportunity", { opportunityId: opportunity.id }),
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
    return this.request(
      apiPath("previewOpcDeliverables", { opportunityId }, { workspaceId }),
    );
  }
  exportOpportunity(workspaceId: string, opportunity: Pick<OpportunityDetail, "id" | "streamVersion">) {
    return this.request(
      apiPath("exportOpcDeliverables", { opportunityId: opportunity.id }),
      {
        method: "POST",
        body: JSON.stringify({ workspaceId, expectedStreamVersion: opportunity.streamVersion }),
      },
    );
  }
  async uploadAsset(workspaceId: string, file: File, protectedValue: boolean) {
    const [asset] = await this.request(apiPath("createAssets", { }), {
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
  codingTasks(workspaceId: string) { return this.request(apiPath("listCodingTasks", {}, { workspaceId })); }
  codingRepositories(workspaceId: string) { return this.request(apiPath("listCodingRepositories", {}, { workspaceId })); }
  createCodingRepository(workspaceId: string, input: string) {
    return this.request(apiPath("createCodingRepository", {}), {
      method: "POST", body: JSON.stringify({ workspaceId, expectedStreamVersion: 0, input }),
    });
  }

  codingReconciliation(executionId: string) {
    return this.request(
      apiPath("getCodingReconciliation", { executionId: executionId }),
    );
  }

  decideCodingReconciliation(
    reconciliation: CodingReconciliationView,
    decision: CodingReconciliationDecision,
  ) {
    return this.request(
      apiPath("decideCodingReconciliation", { executionId: reconciliation.executionId }),
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
    return this.request(apiPath("decideApproval", { approvalId: approvalId }), {
      method: "POST", body: JSON.stringify({ expectedStreamVersion: streamVersion, decision }),
    });
  }

  decideMemory(memoryId: string, streamVersion: number, decision: "accept" | "reject") {
    return this.request(apiPath("decideMemory", { memoryId: memoryId }), {
      method: "POST", body: JSON.stringify({ expectedStreamVersion: streamVersion, decision }),
    });
  }

  reviseMemory(memoryId: string, streamVersion: number, summary: string, confidence: number) {
    return this.request(apiPath("reviseMemoryProposal", { memoryId: memoryId }), {
      method: "PATCH",
      body: JSON.stringify({ expectedStreamVersion: streamVersion, confidence, value: { summary } }),
    });
  }

  deleteMemory(memoryId: string, streamVersion: number, reason: string) {
    return this.request(apiPath("deleteMemory", { memoryId: memoryId }), {
      method: "DELETE",
      body: JSON.stringify({ expectedStreamVersion: streamVersion, reason }),
    });
  }

  capture(workspaceId: string, pluginId: ProductPluginId, input: string, repositoryId?: string) {
    return this.request(apiPath(pluginId === "opc" ? "createOpcOpportunity" : "createCodingTask", {}), {
      method: "POST", body: JSON.stringify({ workspaceId, expectedStreamVersion: 0, input, ...(pluginId === "coding" && repositoryId ? { repositoryId } : {}) }),
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
