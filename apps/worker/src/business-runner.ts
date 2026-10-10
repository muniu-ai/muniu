// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { CODING_RUNNER_CONFIGURATION_NAMESPACE, type CodingRunnerConfigurationV1, type Execution, type ExecutionAuthority, type ExternalCodingRunnerId, type ToolCallIntent, type JsonObject, type Workspace } from "@mn/contracts";
import { sha256, type KernelStore } from "@mn/kernel";
import { RuntimeControlError, type ModelRequest, type ModelResponse, type RuntimeStore, type ToolApprovalPort } from "@mn/agent-runtime";
import { ControlledCodingSandbox, createExternalRunnerAdapter } from "./coding.js";

export function businessRunnerArguments(runner: ExternalCodingRunnerId): readonly string[] {
  return runner === "codex-cli"
    ? ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only",
      "-c", "features.shell_tool=false", "-c", "features.unified_exec=false", "-c", "features.multi_agent=false",
      "-c", 'web_search="disabled"', "-c", "mcp_servers={}", "-c", "features.apps=false", "-c", "analytics.enabled=false", "-c", "feedback.enabled=false", "-"]
    : ["-p", "--output-format", "stream-json", "--verbose", "--bare", "--tools", "", "--disallowedTools", "mcp__*",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-session-persistence"];
}

export function extractBusinessRunnerText(runner: ExternalCodingRunnerId, event: Readonly<Record<string, unknown>>): string | undefined {
  if (runner === "claude-cli") return event.type === "result" && event.subtype === "success" && event.is_error !== true && typeof event.result === "string" ? event.result : undefined;
  const item = event.item as Record<string, unknown> | undefined;
  return event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string" ? item.text : undefined;
}

export async function invokeBusinessRunner(input: {
  execution: Execution; authority: ExecutionAuthority; request: ModelRequest; store: KernelStore;
  runtime: RuntimeStore; approval: ToolApprovalPort; sandbox: ControlledCodingSandbox; signal: AbortSignal;
}): Promise<ModelResponse> {
  const { execution, authority, runtime, signal, sandbox } = input;
  const runnerId = execution.runnerId;
  if (execution.pluginId !== "opc" || (runnerId !== "codex-cli" && runnerId !== "claude-cli")) throw new Error("经营 CLI 执行者无效");
  const toolId = runnerId === "codex-cli" ? "runner.codex.execute" : "runner.claude.execute";
  const configuration = await input.store.transact(execution.tenantId, tx => {
    const config = tx.getProjection<CodingRunnerConfigurationV1>(CODING_RUNNER_CONFIGURATION_NAMESPACE, `${execution.workspaceId}:${runnerId}`);
    const workspace = tx.getProjection<Workspace>("workspace", execution.workspaceId);
    if (!config || config.status !== "confirmed" || config.tenantId !== execution.tenantId || config.identityDigest !== sha256(config.identity)
      || !workspace?.activePluginIds.includes(`runner-${runnerId}`) || !authority.toolIds.includes(toolId)) throw new Error("CLI 配置或授权已失效");
    return config;
  });
  const records = await runtime.readExecution(execution.id);
  if (records.some(record => record.type === "tool/started" && !records.some(result => result.type === "tool/result" && result.payload.toolCallId === record.payload.toolCallId))) {
    throw new RuntimeControlError("needs_reconciliation");
  }
  const preparedInput = JSON.stringify({ instructions: "仅依据以下对话与明确资料提供可审阅答复；禁止执行工具、外联或修改业务事实。", messages: input.request.messages });
  if (Buffer.byteLength(preparedInput) > 512 * 1024) throw new Error("经营任务上下文超过 CLI 输入上限");
  const normalizedArguments = { runnerId, identityDigest: configuration.identityDigest, inputDigest: sha256(preparedInput), mode: "business-text-v1" };
  const intent: ToolCallIntent = { id: `business-cli:${randomUUID()}`, executionId: execution.id, generation: execution.generation,
    toolId, toolVersion: "0.2.0", effectClass: "external_side_effect", intent: `调用 ${runnerId === "codex-cli" ? "Codex CLI" : "Claude Code"} 处理经营资料，费用使用 CLI 账户并待核对`,
    normalizedArguments, argumentsDigest: sha256(normalizedArguments), resourceRefs: [], resourcesDigest: sha256([]), authorityCommitment: authority.commitment,
    expiresAt: new Date(Date.now() + 300000).toISOString() };
  await runtime.append({ executionId: execution.id, type: "tool/intent", payload: { ...intent, toolCallId: intent.id } as unknown as JsonObject });
  const decision = await input.approval.authorize(intent, signal);
  if (decision.mode === "deny") {
    await runtime.append({ executionId: execution.id, type: "tool/result", payload: { toolCallId: intent.id, status: "denied" } });
    throw new Error("经营 CLI 调用已拒绝");
  }
  signal.throwIfAborted();
  const directory = await sandbox.createTaskDirectory();
  let artifact: Awaited<ReturnType<ControlledCodingSandbox["stageRunnerBinary"]>> | undefined;
  let supervision: Awaited<ReturnType<ControlledCodingSandbox["externalLauncher"]>>["supervision"] | undefined;
  let launched = false, stopped = false, settled = false;
  let adapter: ReturnType<typeof createExternalRunnerAdapter> | undefined, sessionId: string | undefined;
  const cancel = () => { if (adapter && sessionId) void adapter.cancel(sessionId).catch(() => undefined); };
  try {
    artifact = await sandbox.stageRunnerBinary(configuration.identity);
    await sandbox.verifyRunnerArtifact(artifact, configuration.identity.version, signal);
    const baseLaunch = await sandbox.externalLauncher(directory, artifact);
    supervision = baseLaunch.supervision;
    const launch = Object.assign((spec: Parameters<typeof baseLaunch>[0]) => baseLaunch({ ...spec, args: businessRunnerArguments(runnerId),
      env: { ...spec.env, DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }), { supervision });
    adapter = createExternalRunnerAdapter({ runnerId, identity: artifact.identity, launch });
    await runtime.append({ executionId: execution.id, type: "tool/started", payload: { toolCallId: intent.id, toolId, generation: execution.generation,
      identityDigest: configuration.identityDigest, inputDigest: sha256(preparedInput), supervision: supervision as unknown as JsonObject } });
    signal.throwIfAborted();
    launched = true;
    sessionId = (await adapter.start({ executionId: execution.id, repositoryPath: directory, expectedRepositoryRealPath: directory,
      resourceDigest: sha256(preparedInput), preparedInput, explicitlySelected: true })).sessionId;
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    let text = "", status: string | undefined;
    for await (const event of adapter.events(sessionId)) {
      if (event.type === "runner_event" && event.payload) {
        const fragment = extractBusinessRunnerText(runnerId, event.payload);
        if (fragment) text = fragment;
        if (Buffer.byteLength(text) > 512 * 1024) { cancel(); throw new Error("CLI 答复超过上限"); }
      }
      if (event.type === "result") status = event.status;
    }
    stopped = await sandbox.waitForRunnerStopped(supervision, new AbortController().signal);
    if (!stopped || signal.aborted || !status || status === "unknown" || status === "cancelled") throw new RuntimeControlError("needs_reconciliation");
    await runtime.append({ executionId: execution.id, type: "tool/result", payload: { toolCallId: intent.id, status: status === "completed" ? "completed" : "failed", result: { responseDigest: sha256(text), usageRequiresReconciliation: true } } });
    settled = true;
    if (status !== "completed" || !text.trim()) throw new Error("CLI 未生成完整经营答复");
    return { text, toolCalls: [] };
  } catch (error) {
    if (launched && !settled) {
      cancel();
      await runtime.append({ executionId: execution.id, type: "tool/outcome_unknown", payload: { toolCallId: intent.id, message: "CLI 结果未确认，禁止自动重试或更换执行者" } });
      throw new RuntimeControlError("needs_reconciliation");
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!launched || stopped) {
      await sandbox.cleanup(directory);
      if (artifact) await sandbox.cleanupRunnerArtifact(artifact);
      if (supervision && stopped) await sandbox.cleanupRunnerSupervision(supervision);
    }
  }
}
