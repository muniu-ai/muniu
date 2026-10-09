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
    const headers: Record<string, string> = preset.probeKind === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${apiKey}` };
    const signal = AbortSignal.timeout(10_000);
    const deadline = Date.now() + 10_000;
    const fetchPage = async (endpoint: string): Promise<Record<string, unknown>> => {
      let response: Response;
      try {
        signal.throwIfAborted();
        response = await (options.fetch ?? fetch)(endpoint, { headers, redirect: "error", signal });
      } catch {
        throw new KernelError("MODEL_PROBE_FAILED", "无法连接模型厂商", "检查网络、API Key 所属地域和厂商服务后重试", true);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new KernelError("MODEL_PROBE_FAILED", response.status === 401 || response.status === 403 ? "模型密钥无效或地域不匹配" : "模型厂商探测失败",
          "检查 API Key、所属地域和厂商服务状态后重试", response.status >= 500);
      }
      return readBoundedJsonBody(response, { maxBytes: 1024 * 1024, timeoutMs: Math.max(1, deadline - Date.now()) });
    };
    let models: string[] = [];
    try {
      if (preset.probeKind === "dashscope") {
        // The native catalog is paginated and has a different envelope from Chat Completions.
        let total: number | undefined;
        for (let page = 1; page <= 100; page++) {
          const endpoint = new URL("/api/v1/models", preset.endpoint);
          endpoint.searchParams.set("name", "qwen");
          endpoint.searchParams.set("page_no", String(page));
          endpoint.searchParams.set("page_size", "100");
          const body = await fetchPage(endpoint.href);
          if (body.success !== true || !isObject(body.output)) throw new Error();
          const output = body.output;
          if (!Number.isSafeInteger(output.total) || (output.total as number) < 0 || (output.total as number) > 10_000
            || output.page_no !== page || !Array.isArray(output.models) || output.models.length > 100) throw new Error();
          if (total !== undefined && output.total !== total) throw new Error();
          total = output.total as number;
          const next = output.models.map(item => modelId(item, "model"));
          if (next.some(id => models.includes(id)) || new Set(next).size !== next.length) throw new Error();
          models.push(...next);
          if (models.length === total) break;
          if (!next.length || models.length > total || page === 100) throw new Error();
        }
      } else {
        const body = await fetchPage(`${preset.endpoint.replace(/\/$/u, "")}/models`);
        if (!Array.isArray(body.data) || body.data.length > 10_000) throw new Error();
        models = [...new Set(body.data.map(item => modelId(item, "id")))];
      }
    } catch (error) {
      if (error instanceof KernelError && error.code === "MODEL_PROBE_FAILED") throw error;
      throw new KernelError("MODEL_PROBE_FAILED", "厂商返回的模型列表无效", "检查厂商服务状态后重试");
    }
    if (!models.length) throw new KernelError("MODEL_PROBE_FAILED", "厂商未返回可用模型", "检查账号权限后重试");
    const defaultModel = selectPricedModel(preset.id, models);
    if (!defaultModel) throw new KernelError("MODEL_PRICE_UNAVAILABLE", "账号没有已配置参考价格的模型", "选择已支持的模型厂商，或等待补充该模型的价格与调用策略");
    return { models, defaultModel };
  };
}

export const defaultModelProbe = createModelProbe();

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelId(value: unknown, field: "model" | "id"): string {
  if (!isObject(value) || typeof value[field] !== "string" || !value[field].trim() || value[field].length > 512) throw new Error();
  return value[field];
}
