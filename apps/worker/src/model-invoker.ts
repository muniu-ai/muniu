// SPDX-License-Identifier: Apache-2.0

import type { ModelRequest, ModelResponse } from "@mn/agent-runtime";

export type ByokProviderId = "openai" | "deepseek" | "anthropic";

export interface ByokModelInvocation {
  readonly presetId: ByokProviderId;
  readonly model: string;
  readonly apiKey: string;
  readonly request: ModelRequest;
  readonly signal: AbortSignal;
}

export type ByokModelInvoker = (input: ByokModelInvocation) => Promise<ModelResponse>;

export type ModelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ByokModelInvokerOptions {
  readonly fetch?: ModelFetch;
  readonly timeoutMs?: number;
}

export class ModelTransportError extends Error {
  readonly code = "MODEL_TRANSPORT_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "ModelTransportError";
  }
}

const PROVIDER_ENDPOINTS: Readonly<Record<ByokProviderId, string>> = {
  openai: "https://api.openai.com/v1/responses",
  deepseek: "https://api.deepseek.com/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};

export function createByokModelInvoker(options: ByokModelInvokerOptions = {}): ByokModelInvoker {
  const fetchModel = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("模型调用超时时间必须是正整数毫秒");
  }
  return async (input) => {
    assertInvocation(input);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort("模型调用超时"), timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout.signal]);
    try {
      let response: Response;
      try {
        response = await fetchModel(PROVIDER_ENDPOINTS[input.presetId], requestOptions(input, signal));
      } catch {
        if (input.signal.aborted) throw new ModelTransportError("模型调用已取消");
        if (timeout.signal.aborted) throw new ModelTransportError("模型调用超时");
        throw new ModelTransportError("无法连接模型厂商");
      }
      if (!response.ok) {
        throw new ModelTransportError(`模型厂商返回 HTTP ${response.status}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ModelTransportError("模型厂商返回了无效响应");
      }
      const text = extractText(input.presetId, payload);
      if (!text) throw new ModelTransportError("模型厂商未返回文本结果");
      return { text, toolCalls: [] };
    } finally {
      clearTimeout(timer);
    }
  };
}

function requestOptions(input: ByokModelInvocation, signal: AbortSignal): RequestInit {
  const common = {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
  } satisfies RequestInit;
  if (input.presetId === "openai") {
    return {
      ...common,
      headers: { ...common.headers, authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({ model: input.model, input: input.request.messages, store: false }),
    };
  }
  if (input.presetId === "deepseek") {
    return {
      ...common,
      headers: { ...common.headers, authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.model,
        messages: input.request.messages,
        stream: false,
      }),
    };
  }
  const system = input.request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages = input.request.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: message.content }));
  return {
    ...common,
    headers: {
      ...common.headers,
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 4096,
      ...(system ? { system } : {}),
      messages,
    }),
  };
}

function extractText(provider: ByokProviderId, payload: unknown): string {
  if (!isObject(payload)) return "";
  if (provider === "openai") {
    if (typeof payload.output_text === "string") return payload.output_text;
    if (!Array.isArray(payload.output)) return "";
    return payload.output.flatMap((output) => {
      if (!isObject(output) || !Array.isArray(output.content)) return [];
      return output.content.flatMap((content) =>
        isObject(content) && content.type === "output_text" && typeof content.text === "string"
          ? [content.text]
          : []);
    }).join("");
  }
  if (provider === "deepseek") {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    return isObject(choice) && isObject(choice.message) && typeof choice.message.content === "string"
      ? choice.message.content
      : "";
  }
  if (!Array.isArray(payload.content)) return "";
  return payload.content.flatMap((content) =>
    isObject(content) && content.type === "text" && typeof content.text === "string"
      ? [content.text]
      : []).join("");
}

function assertInvocation(input: ByokModelInvocation): void {
  if (!Object.hasOwn(PROVIDER_ENDPOINTS, input.presetId)) {
    throw new ModelTransportError("模型厂商预设不受支持");
  }
  if (!input.model.trim()) throw new ModelTransportError("模型名称不能为空");
  if (!input.apiKey.trim()) throw new ModelTransportError("模型凭据为空");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
