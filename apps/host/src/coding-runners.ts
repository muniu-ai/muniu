// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

import {
  CODING_RUNNER_CONFIGURATION_NAMESPACE,
  type CodingRunnerConfigurationV1,
  type ExternalCodingRunnerId,
  type RunnerBinaryIdentityV1,
} from "@mn/contracts";
import { KernelError, sha256, type KernelStore, type KernelTransaction } from "@mn/kernel";
import { inspectRunnerBinary as inspectClaudeCli } from "@mn/runner-claude-cli";
import { inspectRunnerBinary as inspectCodexCli } from "@mn/runner-codex-cli";

const SHA256 = /^[0-9a-f]{64}$/u;
export const EXTERNAL_CODING_RUNNER_IDS = ["claude-cli", "codex-cli"] as const;

export interface CodingRunnerIdentityInspector {
  inspect(runnerId: ExternalCodingRunnerId, binaryPath: string): Promise<RunnerBinaryIdentityV1>;
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

export async function inspectCodingRunner(
  inspector: CodingRunnerIdentityInspector | undefined,
  runnerId: ExternalCodingRunnerId,
  binaryPath: string,
): Promise<RunnerBinaryIdentityV1> {
  assertAbsoluteBinaryPath(binaryPath);
  if (!inspector) {
    throw new KernelError(
      "RUNNER_INSPECTION_UNAVAILABLE",
      "当前部署没有可用的 Runner 身份检查器",
      "在执行 Runner 的受信 Worker 环境中配置检查器",
    );
  }
  const identity = await inspector.inspect(runnerId, binaryPath);
  assertRunnerIdentityShape(identity, binaryPath);
  return Object.freeze({ ...identity });
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
  readonly identity: RunnerBinaryIdentityV1;
  readonly occurredAt: string;
  readonly correlationId: string;
}): CodingRunnerConfigurationV1 {
  if (!input.expectedVersion.trim() || !SHA256.test(input.expectedSha256)) {
    throw new KernelError(
      "INVALID_BODY",
      "Runner 版本或 SHA-256 无效",
      "使用检查结果中的完整版本和 SHA-256",
    );
  }
  if (input.identity.version !== input.expectedVersion
    || input.identity.sha256 !== input.expectedSha256) {
    throw new KernelError(
      "RUNNER_RECONFIRMATION_REQUIRED",
      "Runner 身份与待确认的版本或摘要不一致",
      "重新检查并确认当前 Runner",
    );
  }
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
  const identityDigest = sha256(input.identity);
  const next: CodingRunnerConfigurationV1 = {
    id,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    runnerId: input.runnerId,
    status: "confirmed",
    identity: { ...input.identity },
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
      version: input.identity.version,
      sha256: input.identity.sha256,
      binaryPathDigest: sha256(input.identity.realPath),
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
      "先检查并确认二进制绝对路径、版本和 SHA-256",
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

function assertRunnerIdentityShape(identity: RunnerBinaryIdentityV1, requestedPath: string): void {
  if (identity.requestedPath !== requestedPath
    || !isAbsolute(identity.realPath)
    || !identity.version.trim()
    || !SHA256.test(identity.sha256)
    || !identity.device || !identity.inode
    || !Number.isSafeInteger(identity.byteLength) || identity.byteLength < 1
    || !Number.isFinite(identity.modifiedAtMs)) {
    throw new KernelError(
      "RUNNER_BINARY_INVALID",
      "Runner 身份检查结果无效",
      "检查受信 Runner 身份检查器",
    );
  }
}
