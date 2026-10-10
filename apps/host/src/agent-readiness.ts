// SPDX-License-Identifier: Apache-2.0

import {
  CODING_RUNNER_CONFIGURATION_NAMESPACE,
  type AgentReadinessReportV1,
  type AgentReadinessV1,
  type CodingRunnerConfigurationV1,
  type ExternalCodingRunnerId,
  type RunnerBinaryInspectionV1,
} from "@mn/contracts";
import { sha256, type KernelStore } from "@mn/kernel";
import {
  EXTERNAL_CODING_RUNNER_IDS,
  inspectCodingRunner,
  runnerConfigurationId,
  runnerPluginId,
  type CodingRunnerIdentityInspector,
} from "./coding-runners.js";

type Check = AgentReadinessV1["checks"][number];
type BinaryCheck = Omit<Check, "id">;
type Availability = "available" | "unavailable" | "unknown";

export interface CodingAgentRuntimeReadiness {
  readonly worker: Availability;
  readonly sandbox: Availability;
}

export interface CodingAgentReadinessInput {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly checkedAt: string;
  readonly activePluginIds: readonly string[];
  readonly canExecute: boolean;
  readonly modelReady: boolean;
  readonly runnerPlugins: Readonly<Partial<Record<ExternalCodingRunnerId, {
    readonly status: "healthy" | "inactive" | "degraded" | "missing_tool";
  }>>>;
  readonly runtime?: CodingAgentRuntimeReadiness;
}

export async function readAgentReadiness(input: CodingAgentReadinessInput & {
  readonly store: KernelStore;
  readonly inspector?: CodingRunnerIdentityInspector;
}): Promise<AgentReadinessReportV1> {
  const configurations = await input.store.transact(input.tenantId, transaction =>
    EXTERNAL_CODING_RUNNER_IDS.map(runnerId => transaction.getProjection<CodingRunnerConfigurationV1>(
      CODING_RUNNER_CONFIGURATION_NAMESPACE,
      runnerConfigurationId(input.workspaceId, runnerId),
    )).filter((entry): entry is CodingRunnerConfigurationV1 => Boolean(entry)));
  const binaryChecks: Partial<Record<ExternalCodingRunnerId, BinaryCheck>> = {};
  await Promise.all(EXTERNAL_CODING_RUNNER_IDS.map(async runnerId => {
    const configuration = confirmedConfiguration(input, configurations, runnerId);
    if (!configuration
      || !input.activePluginIds.some(id => id === "coding" || id === "opc")
      || !input.activePluginIds.includes(runnerPluginId(runnerId))
      || input.runnerPlugins[runnerId]?.status !== "healthy") return;
    if (!input.inspector) {
      binaryChecks[runnerId] = { status: "unknown", message: "当前部署没有受信的同节点文件检查器",
        action: "由执行节点配置受信检查器后重新检查" };
      return;
    }
    try {
      const current = await inspectCodingRunner(input.inspector, runnerId, configuration.identity.requestedPath);
      binaryChecks[runnerId] = passiveIdentityMatches(configuration.identity, current)
        ? { status: "passed", message: "当前文件与已确认的路径和摘要一致；运行版本仍需沙箱复核" }
        : { status: "blocked", message: "Runner 文件身份已变化",
          action: "重新检查并确认 CLI 的路径、版本与摘要" };
    } catch {
      binaryChecks[runnerId] = { status: "blocked", message: "已确认的 Runner 文件不存在或无法通过被动检查",
        action: "检查原生 CLI 的安装路径和访问权限，再重新确认" };
    }
  }));
  return evaluateCodingAgentReadiness({ ...input, configurations, binaryChecks });
}

export function evaluateCodingAgentReadiness(input: CodingAgentReadinessInput & {
  readonly configurations: readonly CodingRunnerConfigurationV1[];
  readonly binaryChecks?: Readonly<Partial<Record<ExternalCodingRunnerId, BinaryCheck>>>;
}): AgentReadinessReportV1 {
  const baseChecks: readonly Check[] = [
    {
      id: "task_plugin",
      status: input.activePluginIds.some(id => id === "coding" || id === "opc") ? "passed" : "blocked",
      message: input.activePluginIds.some(id => id === "coding" || id === "opc") ? "工作区已启用任务插件" : "工作区尚未启用经营或研发插件",
      ...(!input.activePluginIds.some(id => id === "coding" || id === "opc") ? { action: "启用经营或研发插件后创建任务" } : {}),
    },
    {
      id: "permission", status: input.canExecute ? "passed" : "blocked",
      message: input.canExecute ? "当前成员可以发起执行" : "当前成员没有发起执行的权限",
      ...(!input.canExecute ? { action: "由工作区 owner 或 operator 发起执行" } : {}),
    },
    {
      id: "model", status: input.modelReady ? "passed" : "blocked",
      message: input.modelReady ? "木牛已有通过探测且配置价格的模型连接" : "木牛尚无通过探测且配置价格的模型连接",
      action: "内置 Agent 使用木牛模型连接；外部 CLI 使用自己的模型账号",
    },
    availabilityCheck("worker", input.runtime?.worker ?? "unknown"),
    availabilityCheck("sandbox", input.runtime?.sandbox ?? "unknown"),
  ];
  const builtin = agent("builtin", "木牛内置 Agent", [
    ...baseChecks,
    { id: "approval", status: "required", message: "具体任务仍需资料范围和工具策略检查",
      action: "创建任务并查看执行记录；需要批准的操作会进入待办" },
  ]);
  const externals = EXTERNAL_CODING_RUNNER_IDS.map(runnerId => {
    const configuration = confirmedConfiguration(input, input.configurations, runnerId);
    const pluginActive = input.activePluginIds.includes(runnerPluginId(runnerId));
    const pluginState = input.runnerPlugins[runnerId]?.status;
    const pluginHealthy = pluginActive && pluginState === "healthy";
    const checks: Check[] = [
      ...baseChecks.filter(check => check.id !== "model"),
      { id: "runner_plugin", status: pluginHealthy ? "passed" : "blocked",
        message: !pluginActive ? "工作区尚未启用对应 Runner 插件"
          : pluginState === "missing_tool" ? "Runner 插件缺少受控执行工具"
          : pluginState === "degraded" ? "Runner 插件运行状态异常"
          : pluginHealthy ? "Runner 插件及受控执行工具可用" : "Runner 插件尚未激活",
        ...(!pluginHealthy ? { action: "由工作区 owner 启用或修复对应 Runner 插件" } : {}) },
      { id: "confirmation", status: configuration ? "passed" : "blocked",
        message: configuration ? "CLI 的路径、版本和摘要已人工确认" : "CLI 尚未确认或确认记录无效",
        ...(!configuration ? { action: "由工作区 owner 检查并确认官方原生 macOS CLI" } : {}) },
      { id: "binary_identity", ...(input.binaryChecks?.[runnerId] ?? {
        status: "unknown", message: configuration ? "尚未复查已确认的 CLI 文件" : "尚未检查 CLI 安装文件",
        action: "启用插件并确认安装文件后重新检查；不支持 npm 或 shebang 包装器",
      }) },
      { id: "authentication", status: "unknown", message: "CLI 登录态、模型权限与额度未验证",
        action: "在 CLI 中完成登录，再通过已批准的任务验证；木牛的模型密钥不会自动传给外部 Agent" },
      { id: "approval", status: "required", message: "每次调用仍需中央工具策略和批准",
        action: "在任务计划中选择该 Agent，检查执行记录和待批准事项" },
    ];
    return agent(runnerId, runnerId === "codex-cli" ? "Codex CLI" : "Claude Code", checks, configuration);
  });
  return {
    workspaceId: input.workspaceId,
    checkedAt: input.checkedAt,
    agents: [builtin, ...externals.sort((left, right) => left.agentId === "codex-cli" ? -1 : right.agentId === "codex-cli" ? 1 : 0), {
      agentId: "workbuddy", displayName: "WorkBuddy", scope: "workspace", support: "not_supported", status: "blocked",
      checks: [{ id: "adapter", status: "blocked", message: "木牛尚未接入 WorkBuddy",
        action: "WorkBuddy 桌面与 CodeBuddy Code 是不同接入对象；企业 Managed Agents 需要独立 API 适配与账号授权" }],
    }],
  };
}

function agent(
  agentId: "builtin" | ExternalCodingRunnerId,
  displayName: string,
  checks: readonly Check[],
  configuration?: CodingRunnerConfigurationV1,
): AgentReadinessV1 {
  return { agentId, displayName, scope: "workspace", support: "supported",
    status: checks.some(check => check.status === "blocked") ? "blocked" : "unverified", checks,
    ...(configuration ? { configuration } : {}) };
}

function confirmedConfiguration(
  input: Pick<CodingAgentReadinessInput, "tenantId" | "workspaceId">,
  configurations: readonly CodingRunnerConfigurationV1[],
  runnerId: ExternalCodingRunnerId,
): CodingRunnerConfigurationV1 | undefined {
  return configurations.find(configuration => configuration.tenantId === input.tenantId
    && configuration.workspaceId === input.workspaceId
    && configuration.runnerId === runnerId
    && configuration.id === runnerConfigurationId(input.workspaceId, runnerId)
    && configuration.status === "confirmed"
    && configuration.identityDigest === sha256(configuration.identity));
}

function passiveIdentityMatches(left: RunnerBinaryInspectionV1, right: RunnerBinaryInspectionV1): boolean {
  return (["requestedPath", "realPath", "sha256", "device", "inode", "byteLength", "modifiedAtMs"] as const)
    .every(field => left[field] === right[field]);
}

function availabilityCheck(id: "worker" | "sandbox", availability: Availability): Check {
  const label = id === "worker" ? "执行进程" : "隔离执行环境";
  return { id, status: availability === "available" ? "passed" : availability === "unavailable" ? "blocked" : "unknown",
    message: availability === "available" ? `${label}已由部署环境报告可用`
      : availability === "unavailable" ? `${label}不可用` : `${label}尚无可验证的状态`,
    ...(availability !== "available" ? { action: id === "worker"
      ? "检查执行进程的运行状态；Host 健康不代表任务执行正常"
      : "检查受控 sandbox；实际任务必须通过隔离检查后才能执行" } : {}) };
}
