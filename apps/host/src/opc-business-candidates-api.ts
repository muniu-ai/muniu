// SPDX-License-Identifier: Apache-2.0
import { parseCreateOpcBusinessCandidateV2, parseDecideOpcBusinessCandidateV2 } from "@mn/contracts";
import { KernelError } from "@mn/kernel";
import { readBoundedJsonBody } from "./http-body.js";
import { createOpcBusinessCandidate, decideOpcBusinessCandidate, getOpcBusinessCandidate, listOpcBusinessCandidates, type OpcBusinessCandidateOptions } from "./opc-business-candidates.js";
export interface OpcBusinessCandidateRequestOptions extends Omit<OpcBusinessCandidateOptions, "workspaceId"> {
  readonly request: Request; readonly mutationKey?: string;
}
function invalid(): never { throw new KernelError("OPC_CANDIDATE_REQUEST_INVALID", "经营候选请求字段无效", "核对工作区和候选操作字段"); }
function text(value: string | null): string { if (!value?.trim() || value.length > 200) invalid(); return value; }
export async function dispatchOpcBusinessCandidateRequest(options: OpcBusinessCandidateRequestOptions): Promise<{ readonly status: number; readonly data: unknown } | undefined> {
  const url = new URL(options.request.url);
  const collection = url.pathname === "/v2/plugins/opc/business/candidates";
  const item = /^\/v2\/plugins\/opc\/business\/candidates\/([^/]+)(?:\/(decisions))?$/u.exec(url.pathname);
  if (!collection && !item) return undefined;
  if (options.request.method === "GET") {
    if (item?.[2]) return undefined;
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => !["workspaceId", ...(collection ? ["goalId"] : [])].includes(key)) || new Set(keys).size !== keys.length) invalid();
    const workspaceId = text(url.searchParams.get("workspaceId"));
    const scoped = { ...options, workspaceId };
    return { status: 200, data: collection ? await listOpcBusinessCandidates(scoped, url.searchParams.has("goalId") ? text(url.searchParams.get("goalId")) : undefined)
      : await getOpcBusinessCandidate(scoped, text(decodeURIComponent(item![1]!))) };
  }
  if (options.request.method !== "POST" || (!collection && !item?.[2])) return undefined;
  if (url.searchParams.size) invalid();
  const key = options.mutationKey ?? options.request.headers.get("Idempotency-Key");
  if (!key?.trim() || key.length > 200) throw new KernelError("IDEMPOTENCY_KEY_REQUIRED", "候选变更需要幂等键", "为本次操作提供 Idempotency-Key");
  const body = await readBoundedJsonBody(options.request, { maxBytes: 16 * 1024 });
  if (collection) {
    let input;
    try { input = parseCreateOpcBusinessCandidateV2(body); } catch { return invalid(); }
    return { status: 201, data: await createOpcBusinessCandidate({ ...options, workspaceId: input.workspaceId }, input, key) };
  }
  let input;
  try { input = parseDecideOpcBusinessCandidateV2(body); } catch { return invalid(); }
  return { status: 200, data: await decideOpcBusinessCandidate({ ...options, workspaceId: input.workspaceId }, text(decodeURIComponent(item![1]!)), input, key) };
}
