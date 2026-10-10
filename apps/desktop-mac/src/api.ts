// SPDX-License-Identifier: Apache-2.0
import { apiPath, matchApiOperation, parseApiResponse, type ApiPath, type JsonApiOperationIdV2, type ApiOutputsV2 } from "@mn/contracts/client";
import type { SetGoalAssignmentV2, CommandNotificationV2, CreateGoalExportV2, CreateMcpConnectionV2, CommandMcpConnectionV2, CreateMcpRequestV2, CreateTeamSkillVersionV2, RegisterTeamSkillEvaluationV2, SubmitTeamSkillEvaluationV2, CommandTeamSkillV2, CreateFollowupV2, CommandFollowupV2, TeamSkillRefV2 } from "@mn/contracts";
import type { AgentSchedulingRequestV2, GoalDeliveryItemDecisionV2, GoalReworkPreviewV2, OpcBusinessCandidateDetailV2, OpcBusinessCandidateOriginV2, GoalUsageV2, BusinessCommandV1, BusinessPeriodV1, BusinessContextTargetV2, CodingRunnerId, ExternalCodingRunnerId, ConfirmCodingRunnerMutationBodyV2, GoalBudgetV2, GoalDeliverableSpecV2, GoalDetailV2, GoalResourceRefV2, GoalResponseV2, ProposeTeamGoalPlanV2 } from "@mn/contracts";
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

import { WorkspaceEventStream, type WorkspaceConnectionState } from "./workspace-events";

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
  private readonly eventStreams = new Map<string, WorkspaceEventStream>();
  business(workspaceId: string, period?: BusinessPeriodV1) {
    return this.request(apiPath("getOpcBusiness", {}, { workspaceId, ...(period ? { periodStart: period.start, periodEnd: period.end } : {}) }));
  }
  businessContext(workspaceId: string, target: BusinessContextTargetV2, versionRef?: GoalResourceRefV2) {
    return this.request(apiPath("getBusinessContext", { workspaceId, kind: target.kind, resourceId: target.resourceId }, versionRef ? {version:versionRef.streamVersion,digest:versionRef.digest} : {}));
  }
  commandBusiness(workspaceId: string, expectedStreamVersion: number, command: BusinessCommandV1, requestKey?: string) {
    return this.request(apiPath("commandOpcBusiness", {}), { method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({ workspaceId, expectedStreamVersion, command }) });
  }
  businessCandidates(workspaceId: string) { return this.request(apiPath("listOpcBusinessCandidates", {}, {workspaceId})); }
  businessCandidate(workspaceId: string, candidateId: string) { return this.request(apiPath("getOpcBusinessCandidate", {candidateId}, {workspaceId})); }
  createBusinessCandidate(workspaceId: string, origin: OpcBusinessCandidateOriginV2, proposalKey: string, requestKey: string) {
    return this.request(apiPath("createOpcBusinessCandidate", {}), {method:"POST",headers:{"Idempotency-Key":requestKey},body:JSON.stringify({workspaceId,expectedStreamVersion:0,origin,proposalKey})});
  }
  decideBusinessCandidate(detail: OpcBusinessCandidateDetailV2, decision: "apply"|"reject", requestKey: string) {
    return this.request(apiPath("decideOpcBusinessCandidate", {candidateId:detail.candidate.id}), {method:"POST",headers:{"Idempotency-Key":requestKey},body:JSON.stringify({workspaceId:detail.candidate.workspaceId,expectedStreamVersion:detail.streamVersion,expectedBusinessStreamVersion:detail.candidate.businessStreamVersion,candidateDigest:detail.candidate.digest,previewDigest:detail.candidate.previewDigest,decision})});
  }
  decideGoalDelivery(detail: GoalResponseV2, items: readonly GoalDeliveryItemDecisionV2[], requestKey: string) {
    return this.request(apiPath("decideGoalDelivery", {goalId:detail.goal.id}), {method:"POST",headers:{"Idempotency-Key":requestKey},body:JSON.stringify({workspaceId:detail.goal.workspaceId,expectedStreamVersion:detail.goal.streamVersion,deliverySetId:detail.deliverySet?.id,criteriaVersion:detail.deliverySet?.criteriaVersion,items})});
  }
  previewGoalRework(detail: GoalResponseV2, decisionId: string, requestKey: string) {
    return this.request(apiPath("previewGoalRework", {goalId:detail.goal.id}), {method:"POST",headers:{"Idempotency-Key":requestKey},body:JSON.stringify({workspaceId:detail.goal.workspaceId,expectedStreamVersion:detail.goal.streamVersion,decisionId})});
  }
  reworkGoal(detail: GoalResponseV2, preview: GoalReworkPreviewV2, requestKey: string) {
    return this.request(apiPath("reworkGoal", {goalId:detail.goal.id}), {method:"POST",headers:{"Idempotency-Key":requestKey},body:JSON.stringify({workspaceId:detail.goal.workspaceId,expectedStreamVersion:preview.expectedGoalStreamVersion,previewId:preview.id,previewDigest:preview.digest})});
  }
  goals(workspaceId: string) { return this.request(apiPath("listGoals", { workspaceId })); }
  goal(workspaceId: string, goalId: string) { return this.request(apiPath("getGoal", { goalId }, { workspaceId })); }
  goalAssignment(workspaceId: string, goalId: string) { return this.request(apiPath("getGoalAssignment", {goalId}, {workspaceId})); }
  setGoalAssignment(goalId: string, input: SetGoalAssignmentV2, key: string) { return this.request(apiPath("setGoalAssignment", {goalId}), {method:"PUT",headers:{"Idempotency-Key":key},body:JSON.stringify(input)}); }
  commandNotification(notificationId: string, input: CommandNotificationV2, key: string) { return this.request(apiPath("commandNotification", {notificationId}), {method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify(input)}); }
  goalExports(workspaceId: string, goalId: string) { return this.request(apiPath("listGoalExports", {goalId}, {workspaceId})); }
  goalExport(workspaceId: string, goalId: string, exportId: string) { return this.request(apiPath("getGoalExport", {goalId,exportId}, {workspaceId})); }
  createGoalExport(goalId: string, input: CreateGoalExportV2, key: string) { return this.request(apiPath("createGoalExport", {goalId}), {method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify(input)}); }
  mcpRequests(workspaceId: string) { return this.request(apiPath("listMcpRequests", {workspaceId})); }
  mcpConnections(workspaceId: string) { return this.request(apiPath("listMcpConnections", {workspaceId})); }
  createMcpConnection(workspaceId: string, input: CreateMcpConnectionV2, key: string) { return this.request(apiPath("createMcpConnection", {workspaceId}), {method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify(input)}); }
  commandMcpConnection(workspaceId: string, connectionId: string, input: CommandMcpConnectionV2, key: string) { return this.request(apiPath("commandMcpConnection", {workspaceId,connectionId}), {method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify(input)}); }
  createMcpRequest(workspaceId: string, connectionId: string, input: CreateMcpRequestV2, key: string) { return this.request(apiPath("createMcpRequest", {workspaceId,connectionId}), {method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify(input)}); }
  mcpRequest(workspaceId: string, requestId: string) { return this.request(apiPath("getMcpRequest", {workspaceId,requestId})); }
  teamTemplates(workspaceId: string) { return this.request(apiPath("listTeamTemplates", { workspaceId })); }
  goalNodes(workspaceId: string, goalId: string) { return this.request(apiPath("getGoalNodes", { goalId }, { workspaceId })); }
  createGoal(workspaceId: string, input: { threadId: string; objective: string; resourceRefs: readonly GoalResourceRefV2[]; budget: GoalBudgetV2; deliverables: readonly GoalDeliverableSpecV2[] }, requestKey?: string) {
    return this.request(apiPath("createGoal", { workspaceId }), { method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify(input) });
  }
  planGoal(detail: GoalResponseV2, selection: string | AgentSchedulingRequestV2, requestKey?: string) {
    return this.request(apiPath("proposeGoalPlan", { goalId: detail.goal.id }), { method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({
      workspaceId: detail.goal.workspaceId, expectedStreamVersion: detail.goal.streamVersion, ...(typeof selection === "string" ? { modelBindingId: selection } : { scheduling: selection }),
    }) });
  }
  planTeamGoal(detail: GoalResponseV2, selection: Pick<ProposeTeamGoalPlanV2, "templateId" | "templateVersion" | "modelBindingId"> & { readonly skillRef?: TeamSkillRefV2 }, requestKey?: string) {
    return this.request(apiPath("proposeGoalPlan", { goalId: detail.goal.id }), { method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({
      workspaceId: detail.goal.workspaceId, expectedStreamVersion: detail.goal.streamVersion, kind: "team-v1", ...selection,
    }) });
  }
  commandGoal(detail: GoalResponseV2, command: "start" | "refresh" | "cancel" | "pause" | "resume", requestKey?: string) {
    return this.request(apiPath("commandGoal", { goalId: detail.goal.id }), { method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({
      workspaceId: detail.goal.workspaceId, expectedStreamVersion: detail.goal.streamVersion, command,
      ...(command === "start" && detail.plan ? { planRevisionId: detail.plan.id, planDigest: detail.plan.digest } : {}),
    }) });
  }
  decideGoal(detail: GoalResponseV2, nodeId: string, decision: "continue" | "stop", requestKey?: string) {
    return this.request(apiPath("commandGoal", { goalId: detail.goal.id }), { method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({
      workspaceId: detail.goal.workspaceId, expectedStreamVersion: detail.goal.streamVersion, command: "decide", nodeId, decision,
    }) });
  }
  recordExternalUsage(detail: GoalResponseV2, usage: GoalUsageV2, source: string, requestKey?: string) {
    return this.request(apiPath("commandGoal", { goalId: detail.goal.id }), { method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({
      workspaceId: detail.goal.workspaceId, expectedStreamVersion: detail.goal.streamVersion, command: "record_external_usage", usage, source,
    }) });
  }
  acceptGoal(detail: GoalResponseV2, items: readonly { key: string; digest: string; reviewedCriterionIds: readonly string[] }[], requestKey?: string) {
    return this.request(apiPath("acceptGoalDelivery", { goalId: detail.goal.id }), { method: "POST", ...(requestKey ? {headers:{"Idempotency-Key":requestKey}} : {}), body: JSON.stringify({
      workspaceId: detail.goal.workspaceId, expectedStreamVersion: detail.goal.streamVersion,
      deliverySetId: detail.deliverySet?.id, criteriaVersion: detail.deliverySet?.criteriaVersion, items,
    }) });
  }
  workspace(workspaceId: string) { return this.request(apiPath("getWorkspace", { workspaceId: workspaceId })); }
  teamSkills(workspaceId: string, goalId?: string) { return this.request(apiPath("listTeamSkills", { workspaceId }, goalId ? { goalId } : {})); }
  teamSkill(workspaceId: string, skillId: string, version?: string) { return this.request(apiPath("getTeamSkill", { workspaceId, skillId }, version ? { version } : {})); }
  createTeamSkill(workspaceId: string, input: CreateTeamSkillVersionV2, key: string) { return this.request(apiPath("createTeamSkillVersion", { workspaceId }), { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(input) }); }
  registerSkillEvaluation(workspaceId: string, skillId: string, input: RegisterTeamSkillEvaluationV2, key: string) { return this.request(apiPath("registerTeamSkillEvaluation", { workspaceId, skillId }), { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(input) }); }
  submitSkillEvaluation(workspaceId: string, skillId: string, evaluationId: string, input: SubmitTeamSkillEvaluationV2, key: string) { return this.request(apiPath("submitTeamSkillEvaluation", { workspaceId, skillId, evaluationId }), { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(input) }); }
  commandTeamSkill(workspaceId: string, skillId: string, input: CommandTeamSkillV2, key: string) { return this.request(apiPath("commandTeamSkill", { workspaceId, skillId }), { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(input) }); }
  followups(workspaceId: string) { return this.request(apiPath("listFollowups", { workspaceId })); }
  followup(workspaceId: string, policyId: string) { return this.request(apiPath("getFollowup", { workspaceId, policyId })); }
  createFollowup(workspaceId: string, input: CreateFollowupV2, key: string) { return this.request(apiPath("createFollowup", { workspaceId }), { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(input) }); }
  commandFollowup(workspaceId: string, policyId: string, input: CommandFollowupV2, key: string) { return this.request(apiPath("commandFollowup", { workspaceId, policyId }), { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(input) }); }
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

  setup(requestKey?: string) {
    return this.request(apiPath("setup", { }), {
      method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({}),
    });
  }

  connectModel(presetId: string, apiKey: string, requestKey?: string) {
    return this.request(
      apiPath("createModelConnection", { }),
      { method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({ presetId, apiKey }) },
    );
  }

  modelPresets() { return this.request(apiPath("listModelPresets", {})); }
  modelConnections() { return this.request(apiPath("listModelConnections", {})); }
  selectModelConnectionModel(connectionId: string, expectedStreamVersion: number, modelName: string) {
    return this.request(apiPath("selectModelConnectionModel", { connectionId }), {
      method: "POST", body: JSON.stringify({ expectedStreamVersion, modelName }),
    });
  }
  agentReadiness(workspaceId: string) { return this.request(apiPath("getWorkspaceAgentReadiness", { workspaceId })); }

  probeModel(connectionId: string, expectedStreamVersion = 1, makeDefault = false, requestKey?: string) {
    return this.request(
      apiPath("probeModelConnection", { connectionId: connectionId }),
      { method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({ expectedStreamVersion, ...(makeDefault ? { makeDefault: true } : {}) }) },
    );
  }

  createWorkspace(name: string, viewMode: ViewMode, pluginIds: readonly ProductPluginId[], requestKey?: string) {
    return this.request(apiPath("createWorkspace", { }), {
      method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({ name, viewMode, pluginIds }),
    });
  }

  listWorkspaces(signal?: AbortSignal) { return this.request(apiPath("listWorkspaces", { }), signal ? { signal } : {}); }
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

  createBusinessThread(workspaceId: string, subject: string, requestKey: string) {
    return this.request(apiPath("createThread", { workspaceId }), { method: "POST", headers: { "Idempotency-Key": requestKey }, body: JSON.stringify({ pluginId: "opc", subject }) });
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

  watchWorkspaceEvents(workspaceId: string, onChange: () => void, onState?: (state: WorkspaceConnectionState) => void): () => void {
    let stream = this.eventStreams.get(workspaceId);
    if (!stream) {
      stream = new WorkspaceEventStream(new URL(apiPath("streamWorkspaceEvents", { workspaceId }), this.baseUrl),
        `muniu:v2:event-cursor:${this.baseUrl}:${workspaceId}`, () => this.eventStreams.delete(workspaceId));
      this.eventStreams.set(workspaceId, stream);
    }
    return stream.subscribe(onChange, onState);
  }

  updateViewMode(workspace: WorkspaceSummary, viewMode: ViewMode) {
    return this.request(apiPath("updateWorkspace", { workspaceId: workspace.id }), {
      method: "PATCH", body: JSON.stringify({ expectedStreamVersion: workspace.streamVersion, viewMode }),
    });
  }

  createFirstObject(workspaceId: string, pluginId: ProductPluginId, input: string, requestKey?: string) {
    return this.request(apiPath(pluginId === "opc" ? "createOpcOpportunity" : "createCodingRepository", {}), {
      method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({ workspaceId, expectedStreamVersion: 0, input }),
    });
  }

  runReadOnlySample(workspaceId: string, pluginId: ProductPluginId, requestKey?: string) {
    return this.request(apiPath(pluginId === "opc" ? "runOpcReadOnlySample" : "runCodingReadOnlySample", {}), {
      method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({ workspaceId, expectedStreamVersion: 0 }),
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
  asset(assetId: string) { return this.request(apiPath("getAsset", { assetId })); }
  assetExtraction(assetId: string) { return this.request(apiPath("getAssetExtraction", { assetId })); }
  async assetContent(assetId: string, signal?: AbortSignal, expectedBytes?: number): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}${apiPath("downloadAsset", { assetId })}`, { ...(signal ? { signal } : {}) });
    if (!response.ok) throw new AgentOsApiError({ code: `ASSET_HTTP_${response.status}`, message: "无法读取资料原文",
      action: "确认资料仍存在且拥有读取权限后重试", fieldIssues: [], traceId: response.headers.get("x-trace-id") ?? "unknown", retryable: response.status >= 500 }, response.status);
    if (expectedBytes === undefined) return response.blob();
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 20 * 1024 * 1024 || (response.headers.has("content-length") && Number(response.headers.get("content-length")) !== expectedBytes) || !response.body) throw new Error("成果下载大小无效");
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
    try { for (;;) { signal?.throwIfAborted(); const {value,done} = await reader.read(); if (done) break; size += value.byteLength; if (size > expectedBytes) { await reader.cancel(); throw new Error("成果下载超过记录大小"); } parts.push(value); } } finally { reader.releaseLock(); }
    if (size !== expectedBytes) throw new Error("成果下载不完整");
    return new Blob(parts, {type:response.headers.get("content-type")??"application/octet-stream"});
  }
  async uploadAsset(workspaceId: string, file: File, protectedValue: boolean, requestKey?: string) {
    const [asset] = await this.request(apiPath("createAssets", { }), {
      method: "POST",
      ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}),
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
  createCodingRepository(workspaceId: string, input: string, requestKey?: string) {
    return this.request(apiPath("createCodingRepository", {}), {
      method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}),
      body: JSON.stringify({ workspaceId, expectedStreamVersion: 0, input }),
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

  decideMemory(memoryId: string, streamVersion: number, decision: "accept" | "reject", requestKey?: string) {
    return this.request(apiPath("decideMemory", { memoryId: memoryId }), {
      method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({ expectedStreamVersion: streamVersion, decision }),
    });
  }

  reviseMemory(memoryId: string, streamVersion: number, summary: string, confidence: number, requestKey?: string) {
    return this.request(apiPath("reviseMemoryProposal", { memoryId: memoryId }), {
      method: "PATCH", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}),
      body: JSON.stringify({ expectedStreamVersion: streamVersion, confidence, value: { summary } }),
    });
  }

  deleteMemory(memoryId: string, streamVersion: number, reason: string, requestKey?: string) {
    return this.request(apiPath("deleteMemory", { memoryId: memoryId }), {
      method: "DELETE", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}),
      body: JSON.stringify({ expectedStreamVersion: streamVersion, reason }),
    });
  }

  capture(workspaceId: string, pluginId: ProductPluginId, input: string, repositoryId?: string, requestKey?: string) {
    return this.request(apiPath(pluginId === "opc" ? "createOpcOpportunity" : "createCodingTask", {}), {
      method: "POST", ...(requestKey ? { headers: { "Idempotency-Key": requestKey } } : {}), body: JSON.stringify({ workspaceId, expectedStreamVersion: 0, input, ...(pluginId === "coding" && repositoryId ? { repositoryId } : {}) }),
    });
  }
}

const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
