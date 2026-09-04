// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

import {
  CODING_RUNNER_CONFIGURATION_NAMESPACE,
  type CodingRunnerConfigurationV1,
  type ExternalCodingRunnerId,
  type RunnerBinaryIdentityV1,
  type RunnerBinaryInspectionV1,
} from "@mn/contracts";
import { KernelError, sha256, type KernelStore, type KernelTransaction } from "@mn/kernel";
import { passivelyInspectRunnerBinary as inspectClaudeCli } from "@mn/runner-claude-cli";
import { passivelyInspectRunnerBinary as inspectCodexCli } from "@mn/runner-codex-cli";

const SHA256 = /^[0-9a-f]{64}$/u;
export const EXTERNAL_CODING_RUNNER_IDS = ["claude-cli", "codex-cli"] as const;

export interface CodingRunnerIdentityInspector {
  inspect(runnerId: ExternalCodingRunnerId, binaryPath: string): Promise<RunnerBinaryInspectionV1>;
}

export const localCodingRunnerIdentityInspector: CodingRunnerIdentityInspector = {
  inspect(runnerId, binaryPath) {
    return runnerId === "claude-cli"
      ? inspectClaudeCli(binaryPath)
      : inspectCodexCli(binaryPath);
  },
};

export function parseExternalCodingRunnerId(value: string): ExternalCodingRunnerId {
  if (value === "claude-cli" || value === "codex-cli") return value;
  throw new KernelError(
    "CODING_RUNNER_NOT_FOUND",
    `Coding Runner ${value} 不存在`,
    "选择 builtin、claude-cli 或 codex-cli",
  );
}

export function runnerConfigurationId(
  workspaceId: string,
  runnerId: ExternalCodingRunnerId,
): string {
  return `${workspaceId}:${runnerId}`;
}

export function runnerToolId(runnerId: ExternalCodingRunnerId): string {
  return runnerId === "claude-cli" ? "runner.claude.execute" : "runner.codex.execute";
}

export function runnerPluginId(runnerId: ExternalCodingRunnerId): string {
  return runnerId === "claude-cli" ? "runner-claude-cli" : "runner-codex-cli";
}

export async function inspectCodingRunner(
  inspector: CodingRunnerIdentityInspector | undefined,
  runnerId: ExternalCodingRunnerId,
  binaryPath: string,
): Promise<RunnerBinaryInspectionV1> {
  assertAbsoluteBinaryPath(binaryPath);
  if (!inspector) {
    throw new KernelError(
      "RUNNER_INSPECTION_UNAVAILABLE",
      "当前部署没有可用的 Runner 身份检查器",
      "配置受信的被动检查器，并使用官方原生安装提供的 macOS Mach-O CLI",
    );
  }
  const inspection = await inspector.inspect(runnerId, binaryPath);
  assertRunnerInspectionShape(inspection, binaryPath);
  return Object.freeze({
    requestedPath: inspection.requestedPath,
    realPath: inspection.realPath,
    sha256: inspection.sha256,
    device: inspection.device,
    inode: inspection.inode,
    byteLength: inspection.byteLength,
    modifiedAtMs: inspection.modifiedAtMs,
  });
}

export async function listCodingRunners(
  store: KernelStore,
  tenantId: string,
  workspaceId: string,
): Promise<readonly unknown[]> {
  const configurations = await store.transact(tenantId, (transaction) =>
    transaction.listProjections<CodingRunnerConfigurationV1>(CODING_RUNNER_CONFIGURATION_NAMESPACE)
      .filter((configuration) => configuration.workspaceId === workspaceId));
  return [
    { runnerId: "builtin", external: false, status: "ready" },
    ...EXTERNAL_CODING_RUNNER_IDS.map((runnerId) => {
      const configuration = configurations.find((entry) => entry.runnerId === runnerId);
      return configuration
        ? { ...configuration, external: true }
        : { runnerId, external: true, status: "not_configured" };
    }),
  ];
}

export function confirmCodingRunner(input: {
  readonly transaction: KernelTransaction;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly runnerId: ExternalCodingRunnerId;
  readonly expectedStreamVersion: number;
  readonly expectedVersion: string;
  readonly expectedSha256: string;
  readonly inspection: RunnerBinaryInspectionV1;
  readonly occurredAt: string;
  readonly correlationId: string;
}): CodingRunnerConfigurationV1 {
  if (!input.expectedVersion.trim()
    || input.expectedVersion !== input.expectedVersion.trim()
    || input.expectedVersion.length > 256
    || /[\r\n]/u.test(input.expectedVersion)
    || !SHA256.test(input.expectedSha256)) {
    throw new KernelError(
      "INVALID_BODY",
      "Runner 版本或 SHA-256 无效",
      "填写人工核实的单行版本和被动检查返回的完整 SHA-256",
    );
  }
  if (input.inspection.sha256 !== input.expectedSha256) {
    throw new KernelError(
      "RUNNER_RECONFIRMATION_REQUIRED",
      "Runner 摘要与待确认的 SHA-256 不一致",
      "重新被动检查官方原生 macOS Mach-O CLI；不支持 npm 或 shebang wrapper",
    );
  }
  const identity: RunnerBinaryIdentityV1 = {
    ...input.inspection,
    version: input.expectedVersion,
  };
  const id = runnerConfigurationId(input.workspaceId, input.runnerId);
  const current = input.transaction.getProjection<CodingRunnerConfigurationV1>(
    CODING_RUNNER_CONFIGURATION_NAMESPACE,
    id,
  );
  const actualVersion = current?.streamVersion ?? 0;
  if (actualVersion !== input.expectedStreamVersion) {
    throw new KernelError(
      "STREAM_VERSION_CONFLICT",
      `对象版本冲突：期望 ${input.expectedStreamVersion}，实际 ${actualVersion}`,
      "刷新 Runner 配置后重试",
      true,
    );
  }
  const identityDigest = sha256(identity);
  const next: CodingRunnerConfigurationV1 = {
    id,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    runnerId: input.runnerId,
    status: "confirmed",
    identity,
    identityDigest,
    confirmedBy: input.actorId,
    confirmedAt: input.occurredAt,
    streamVersion: actualVersion + 1,
    createdAt: current?.createdAt ?? input.occurredAt,
    updatedAt: input.occurredAt,
  };
  input.transaction.putProjection(CODING_RUNNER_CONFIGURATION_NAMESPACE, id, next);
  input.transaction.appendEvent({
    tenantId: input.tenantId,
    aggregateType: "coding.runner",
    aggregateId: id,
    expectedStreamVersion: actualVersion,
    type: "coding.runner_confirmed",
    actorId: input.actorId,
    generation: 0,
    correlationId: input.correlationId,
    publicPayload: {
      workspaceId: input.workspaceId,
      runnerId: input.runnerId,
      version: identity.version,
      sha256: identity.sha256,
      binaryPathDigest: sha256(identity.realPath),
      identityDigest,
    },
  });
  return next;
}

export async function requireConfirmedCodingRunner(
  store: KernelStore,
  tenantId: string,
  workspaceId: string,
  runnerId: ExternalCodingRunnerId,
): Promise<CodingRunnerConfigurationV1> {
  const configuration = await store.transact(tenantId, (transaction) =>
    transaction.getProjection<CodingRunnerConfigurationV1>(
      CODING_RUNNER_CONFIGURATION_NAMESPACE,
      runnerConfigurationId(workspaceId, runnerId),
    ));
  if (!configuration || configuration.status !== "confirmed") {
    throw new KernelError(
      "CODING_RUNNER_CONFIRMATION_REQUIRED",
      `Runner ${runnerId} 尚未确认`,
      "先启用对应插件并确认官方原生 macOS Mach-O CLI；不支持 npm 或 shebang wrapper",
    );
  }
  return configuration;
}

function assertAbsoluteBinaryPath(binaryPath: string): void {
  if (!binaryPath || binaryPath.includes("\0") || !isAbsolute(binaryPath)) {
    throw new KernelError(
      "RUNNER_BINARY_INVALID",
      "Runner 二进制必须使用不含空字节的绝对路径",
      "选择可执行文件的绝对路径",
    );
  }
}

function assertRunnerInspectionShape(inspection: RunnerBinaryInspectionV1, requestedPath: string): void {
  if (inspection.requestedPath !== requestedPath
    || !isAbsolute(inspection.realPath)
    || !SHA256.test(inspection.sha256)
    || !inspection.device || !inspection.inode
    || !Number.isSafeInteger(inspection.byteLength) || inspection.byteLength < 1
    || !Number.isFinite(inspection.modifiedAtMs)) {
    throw new KernelError(
      "RUNNER_BINARY_INVALID",
      "Runner 身份检查结果无效",
      "检查受信 Runner 身份检查器",
    );
  }
}
