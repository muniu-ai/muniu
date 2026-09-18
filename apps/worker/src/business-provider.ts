// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseBusinessDecisionV1, parseBusinessObjectSnapshotV1, parseEffectAdmissionV1, parseEffectReceiptV1, parseSalesInquirySnapshotV1 } from "@mn/contracts";
import { KernelError } from "@mn/kernel";
import type { BusinessProviderPorts } from "./business-actions.js";

/** The deployment supplies credentials; URLs, credentials and provider bodies never enter errors. */
export function createSalesBusinessProvider(options: {
  readonly endpoint: string;
  readonly tokenResolver: () => Promise<string>;
  readonly allowInsecureHttp?: boolean;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): BusinessProviderPorts {
  const endpoint = new URL(options.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !(endpoint.protocol === "https:" || (options.allowInsecureHttp && endpoint.protocol === "http:"))) {
    throw new Error("业务服务地址必须使用受信的 HTTPS 地址");
  }
  const send = async (path: string, value: unknown): Promise<unknown> => {
    const token = await options.tokenResolver();
    if (!token || /[\r\n]/u.test(token)) throw new Error("业务服务凭据不可用");
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${endpoint.toString().replace(/\/$/u, "")}/${path}`, {
        method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(value), signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      if (!response.ok) throw new Error("request rejected");
      const body = await response.text();
      if (Buffer.byteLength(body) > 1_048_576) throw new Error("response too large");
      const parsed = JSON.parse(body) as unknown;
      return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
    } catch {
      throw new KernelError("BUSINESS_PROVIDER_UNAVAILABLE", "业务服务未返回可确认的结果", "核对业务服务与操作状态，勿直接重发");
    }
  };
  return {
    inquiries: { read: async input => parseSalesInquirySnapshotV1(await send("inquiries", input)) },
    snapshots: { read: async input => parseBusinessObjectSnapshotV1(await send("snapshots", input)) },
    decisions: { read: async input => parseBusinessDecisionV1(await send("decisions", input)) },
    actions: { admit: async input => parseEffectAdmissionV1(await send("actions/admit", input)),
      execute: async input => parseEffectReceiptV1(await send("actions/execute", input)) },
    receipts: { lookup: async input => { const value = await send("actions/lookup", input); return value === null ? undefined : parseEffectReceiptV1(value); },
      reconcile: async input => { const value = await send("actions/reconcile", input); return value === null ? undefined : parseEffectReceiptV1(value); } },
  };
}

export function businessAuthorityTokenResolver(profile: "local" | "enterprise"): () => Promise<string> {
  return async () => {
    const file = process.env.MUNIU_BUSINESS_AUTHORITY_TOKEN_FILE?.trim() || process.env.MUNIU_OS_AUTHORITY_TOKEN_FILE?.trim();
    if (file) {
      if (!isAbsolute(file)) throw new Error("业务执行授权凭据必须使用绝对文件路径");
      return (await readFile(file, "utf8")).trim();
    }
    if (profile === "local" && process.env.MUNIU_OS_AUTHORITY_TOKEN) return process.env.MUNIU_OS_AUTHORITY_TOKEN;
    throw new Error("业务执行授权服务凭据未配置");
  };
}

export interface BusinessProviderConfiguration {
  readonly businessProvider: BusinessProviderPorts;
  readonly businessWorkspaceScopes: readonly { readonly tenantId: string; readonly workspaceId: string }[];
  readonly businessAuthorityTokenResolver: () => Promise<string>;
}

export async function loadBusinessProviderConfiguration(profile: "local" | "enterprise"): Promise<BusinessProviderConfiguration | undefined> {
  const endpoint = process.env.MUNIU_SALES_URL?.trim();
  if (!endpoint) return undefined;
  const scopesFile = process.env.MUNIU_BUSINESS_WORKSPACE_SCOPES_FILE?.trim();
  if (!scopesFile || !isAbsolute(scopesFile)) throw new Error("业务工作区配置必须使用绝对文件路径");
  const scopes = JSON.parse(await readFile(scopesFile, "utf8")) as unknown;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some(value => !value || typeof value !== "object"
    || Object.keys(value).some(key => !["tenantId", "workspaceId"].includes(key))
    || typeof value.tenantId !== "string" || !value.tenantId.trim()
    || typeof value.workspaceId !== "string" || !value.workspaceId.trim())) throw new Error("业务工作区配置无效");
  const tokenResolver = async () => {
    const file = process.env.MUNIU_SALES_TOKEN_FILE?.trim();
    if (file) {
      if (!isAbsolute(file)) throw new Error("业务凭据必须使用绝对文件路径");
      return (await readFile(file, "utf8")).trim();
    }
    if (profile === "local" && process.env.MUNIU_SALES_TOKEN) return process.env.MUNIU_SALES_TOKEN;
    throw new Error("业务服务凭据未配置");
  };
  const authorityResolver = businessAuthorityTokenResolver(profile);
  if (!(await tokenResolver()) || !(await authorityResolver())) throw new Error("业务服务凭据不能为空");
  const url = new URL(endpoint);
  const allowInsecureHttp = profile === "local" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return { businessProvider: createSalesBusinessProvider({ endpoint, tokenResolver, allowInsecureHttp }),
    businessWorkspaceScopes: scopes, businessAuthorityTokenResolver: authorityResolver };
}
