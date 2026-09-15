// SPDX-License-Identifier: Apache-2.0
import { KernelError, selectPricedModel, type ProviderPreset } from "@mn/kernel";
import { readBoundedJsonBody } from "./http-body.js";

export interface ModelProbeResult {
  readonly models: readonly string[];
  readonly defaultModel: string;
}
export type ModelProbe = (input: { readonly preset: ProviderPreset; readonly apiKey: string }) => Promise<ModelProbeResult>;

export function createModelProbe(options: { readonly fetch?: typeof fetch } = {}): ModelProbe {
  return async ({ preset, apiKey }) => {
    const endpoint = `${preset.endpoint.replace(/\/$/u, "")}${preset.id === "openai" ? "" : "/v1"}/models`;
    const headers: Record<string, string> = preset.probeKind === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${apiKey}` };
    const deadline = Date.now() + 10_000;
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(endpoint, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new KernelError("MODEL_PROBE_FAILED", "无法连接模型厂商", "检查网络和 API Key 后重试", true);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new KernelError("MODEL_PROBE_FAILED", response.status === 401 || response.status === 403 ? "模型密钥无效" : "模型厂商探测失败",
        "检查 API Key 和厂商服务状态后重试", response.status >= 500);
    }
    let models: string[];
    try {
      const body = await readBoundedJsonBody(response, { maxBytes: 1024 * 1024, timeoutMs: Math.max(1, deadline - Date.now()) });
      if (!Array.isArray(body.data) || body.data.length > 10_000) throw new Error();
      models = body.data.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)
          || typeof item.id !== "string" || !item.id.trim() || item.id.length > 512) throw new Error();
        return item.id;
      });
      models = [...new Set(models)];
    } catch { throw new KernelError("MODEL_PROBE_FAILED", "厂商返回的模型列表无效", "检查厂商服务状态后重试"); }
    if (!models.length) throw new KernelError("MODEL_PROBE_FAILED", "厂商未返回可用模型", "检查账号权限后重试");
    const defaultModel = selectPricedModel(preset.id, models);
    if (!defaultModel) throw new KernelError("MODEL_PRICE_UNAVAILABLE", "账号没有已配置参考价格的模型", "选择其他厂商连接");
    return { models, defaultModel };
  };
}

export const defaultModelProbe = createModelProbe();
