// SPDX-License-Identifier: Apache-2.0

import type { Asset } from "@mn/contracts";
import { KernelError, type KernelStore } from "@mn/kernel";
import type { OpportunityAggregate } from "@mn/plugin-opc";
import type { ContentAddressedStorage, KeyProvider } from "@mn/storage";

import { readAssetContent } from "./assets.js";

const INTERVIEW_MEDIA_TYPES = new Set(["text/plain", "text/markdown"]);

interface OpcSourceOptions {
  readonly store: KernelStore;
  readonly cas?: ContentAddressedStorage;
  readonly protectedPayloadKeyProvider?: KeyProvider;
  readonly tenantId: string;
  readonly workspaceId: string;
}

export interface HydratedOpcOpportunity {
  readonly opportunity: OpportunityAggregate & {
    readonly interviews: readonly (OpportunityAggregate["interviews"][number] & {
      readonly rawRecord: string;
    })[];
  };
  readonly interviewRawRecords: ReadonlyMap<string, string>;
}

export async function validateOpcCommandSources(
  options: OpcSourceOptions & {
    readonly command: string;
    readonly input: unknown;
  },
): Promise<void> {
  const input = asRecord(options.input);
  if (options.command === "record_signal" && input.sourceKind === "file") {
    const assetId = requiredAssetId(input.sourceAssetId, "sourceAssetId");
    await loadSourceAsset(options, assetId);
  }
  if (options.command === "record_interview") {
    if (Object.hasOwn(input, "rawRecord")) {
      throw new KernelError(
        "OPC_PROTECTED_ASSET_REQUIRED",
        "访谈原文不能直接写入命令",
        "先上传受保护文本附件，再提交 rawRecordAssetId",
      );
    }
    const assetId = requiredAssetId(input.rawRecordAssetId, "rawRecordAssetId");
    const asset = await loadSourceAsset(options, assetId);
    assertInterviewAsset(asset);
    const content = await readSourceContent(options, asset);
    try {
      decodeUtf8(content);
    } finally {
      content.fill(0);
    }
  }
}

export async function hydrateOpcOpportunity(
  options: OpcSourceOptions & { readonly opportunity: OpportunityAggregate },
): Promise<HydratedOpcOpportunity> {
  const interviewRawRecords = new Map<string, string>();
  const interviews = [];
  for (const signal of options.opportunity.signals) {
    if (signal.sourceKind !== "file") continue;
    const asset = await loadSourceAsset(options, signal.sourceAssetId ?? "");
    const content = await readSourceContent(options, asset);
    content.fill(0);
  }
  for (const interview of options.opportunity.interviews) {
    const asset = await loadSourceAsset(options, interview.rawRecordAssetId);
    assertInterviewAsset(asset);
    const content = await readSourceContent(options, asset);
    let rawRecord: string;
    try {
      rawRecord = decodeUtf8(content);
    } finally {
      content.fill(0);
    }
    interviewRawRecords.set(interview.rawRecordAssetId, rawRecord);
    interviews.push({ ...interview, rawRecord });
  }
  return {
    opportunity: { ...options.opportunity, interviews },
    interviewRawRecords,
  };
}

async function loadSourceAsset(options: OpcSourceOptions, assetId: string): Promise<Asset> {
  const asset = await options.store.transact(options.tenantId, (transaction) =>
    transaction.getProjection<Asset>("asset", assetId));
  if (!asset) {
    throw new KernelError(
      "OPC_ASSET_NOT_FOUND",
      "OPC 引用的附件不存在或已删除",
      "重新上传附件并更新引用",
    );
  }
  if (asset.tenantId !== options.tenantId) {
    throw new KernelError(
      "OPC_ASSET_NOT_FOUND",
      "OPC 引用的附件不存在或已删除",
      "重新上传附件并更新引用",
    );
  }
  if (asset.workspaceId !== options.workspaceId) {
    throw new KernelError(
      "OPC_ASSET_SCOPE_MISMATCH",
      "OPC 不能引用其他工作区的附件",
      "选择当前工作区中的附件",
    );
  }
  return asset;
}

async function readSourceContent(options: OpcSourceOptions, asset: Asset): Promise<Buffer> {
  if (!options.cas) {
    throw new KernelError(
      "ASSET_STORE_UNAVAILABLE",
      "OPC 引用的附件暂时无法读取",
      "检查对象存储连接后重试",
      true,
    );
  }
  return readAssetContent({
    store: options.store,
    cas: options.cas,
    tenantId: options.tenantId,
    asset,
    ...(options.protectedPayloadKeyProvider
      ? { protectedPayloadKeyProvider: options.protectedPayloadKeyProvider }
      : {}),
  });
}

function assertInterviewAsset(asset: Asset): void {
  if (!asset.protected) {
    throw new KernelError(
      "OPC_INTERVIEW_ASSET_NOT_PROTECTED",
      "访谈原文必须使用受保护附件",
      "重新上传并启用受保护存储",
    );
  }
  if (!INTERVIEW_MEDIA_TYPES.has(asset.mediaType)) {
    throw new KernelError(
      "OPC_INTERVIEW_ASSET_TYPE_INVALID",
      "访谈原文只接受纯文本或 Markdown",
      "上传 UTF-8 编码的 .txt 或 .md 文件",
    );
  }
}

function decodeUtf8(content: Uint8Array): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (!value.trim()) throw new Error("empty");
    return value;
  } catch {
    throw new KernelError(
      "OPC_INTERVIEW_ASSET_ENCODING_INVALID",
      "访谈原文不是有效的非空 UTF-8 文本",
      "将文件转换为 UTF-8 后重新上传",
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredAssetId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new KernelError(
      "OPC_ASSET_REFERENCE_REQUIRED",
      `${field} 必须引用已上传的附件`,
      "先上传附件，再提交返回的 Asset ID",
    );
  }
  return value.trim();
}
