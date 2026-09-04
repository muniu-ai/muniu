// SPDX-License-Identifier: Apache-2.0

import type { ModelMessage, ModelRequest, ModelResponse, ModelToolCall } from "@mn/agent-runtime";
import type { JsonObject } from "@mn/contracts";

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
    const tools = toolDescriptors(input.request.availableToolIds);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort("模型调用超时"), timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout.signal]);
    try {
      let response: Response;
      try {
        response = await fetchModel(PROVIDER_ENDPOINTS[input.presetId], requestOptions(input, signal, tools));
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
      const result = extractResponse(input.presetId, payload, tools);
      if (!result.text && result.toolCalls.length === 0) {
        throw new ModelTransportError("模型厂商未返回文本或工具调用");
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
}

interface ProviderToolDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

function requestOptions(
  input: ByokModelInvocation,
  signal: AbortSignal,
  tools: readonly ProviderToolDescriptor[],
): RequestInit {
  const common = {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
  } satisfies RequestInit;
  if (input.presetId === "openai") {
    return {
      ...common,
      headers: { ...common.headers, authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.model,
        input: providerMessages(input.request.messages),
        store: false,
        ...(tools.length > 0 ? {
          tools: tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: genericObjectSchema(),
            strict: false,
          })),
        } : {}),
      }),
    };
  }
  if (input.presetId === "deepseek") {
    return {
      ...common,
      headers: { ...common.headers, authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.model,
        messages: providerMessages(input.request.messages),
        stream: false,
        ...(tools.length > 0 ? {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: genericObjectSchema(),
            },
          })),
        } : {}),
      }),
    };
  }
  const normalizedMessages = providerMessages(input.request.messages);
  const system = normalizedMessages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages = normalizedMessages
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
      ...(tools.length > 0 ? {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: genericObjectSchema(),
        })),
      } : {}),
    }),
  };
}

function extractResponse(
  provider: ByokProviderId,
  payload: unknown,
  tools: readonly ProviderToolDescriptor[],
): ModelResponse {
  return {
    text: extractText(provider, payload),
    toolCalls: extractToolCalls(provider, payload, tools),
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

function extractToolCalls(
  provider: ByokProviderId,
  payload: unknown,
  tools: readonly ProviderToolDescriptor[],
): readonly ModelToolCall[] {
  if (!isObject(payload)) return [];
  const byName = new Map(tools.map((tool) => [tool.name, tool.id]));
  let calls: readonly unknown[] = [];
  if (provider === "openai") {
    calls = Array.isArray(payload.output)
      ? payload.output.filter((item) => isObject(item) && item.type === "function_call")
      : [];
  } else if (provider === "deepseek") {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const message = isObject(choice) && isObject(choice.message) ? choice.message : undefined;
    calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  } else {
    calls = Array.isArray(payload.content)
      ? payload.content.filter((item) => isObject(item) && item.type === "tool_use")
      : [];
  }
  const parsed = calls.map((value, index): ModelToolCall => {
    if (!isObject(value)) throw new ModelTransportError("模型厂商返回了无效工具调用");
    if (provider === "deepseek") {
      if (!isObject(value.function)) throw new ModelTransportError("模型厂商返回了无效工具调用");
      return toolCall(
        requiredText(value.id, `tool-${index + 1}`),
        requiredText(value.function.name),
        parseToolArguments(value.function.arguments),
        byName,
      );
    }
    if (provider === "anthropic") {
      return toolCall(
        requiredText(value.id, `tool-${index + 1}`),
        requiredText(value.name),
        jsonObject(value.input),
        byName,
      );
    }
    return toolCall(
      requiredText(value.call_id ?? value.id, `tool-${index + 1}`),
      requiredText(value.name),
      parseToolArguments(value.arguments),
      byName,
    );
  });
  if (new Set(parsed.map((call) => call.id)).size !== parsed.length) {
    throw new ModelTransportError("模型厂商返回了重复的工具调用 id");
  }
  return parsed;
}

function toolDescriptors(ids: readonly string[]): readonly ProviderToolDescriptor[] {
  return [...new Set(ids)].map((id, index) => ({
    id,
    name: `mn_tool_${index + 1}`,
    description: `木牛受控工具：${id}`,
  }));
}

function toolCall(
  id: string,
  providerName: string,
  arguments_: JsonObject,
  byName: ReadonlyMap<string, string>,
): ModelToolCall {
  return {
    id,
    toolId: byName.get(providerName) ?? providerName,
    arguments: arguments_,
  };
}

function providerMessages(messages: readonly ModelMessage[]): readonly {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}[] {
  return messages.map((message) => message.role === "tool"
    ? {
        role: "user" as const,
        content: `[工具 ${message.name ?? "unknown"} 的结果]\n${message.content}`,
      }
    : { role: message.role, content: message.content });
}

function genericObjectSchema(): JsonObject {
  return { type: "object", additionalProperties: true };
}

function parseToolArguments(value: unknown): JsonObject {
  if (isObject(value)) return structuredClone(value) as JsonObject;
  if (typeof value !== "string") throw new ModelTransportError("工具调用参数不是 JSON 对象");
  try {
    return jsonObject(JSON.parse(value));
  } catch (error) {
    if (error instanceof ModelTransportError) throw error;
    throw new ModelTransportError("工具调用参数不是有效 JSON");
  }
}

function jsonObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new ModelTransportError("工具调用参数不是 JSON 对象");
  return structuredClone(value) as JsonObject;
}

function requiredText(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (fallback !== undefined) return fallback;
  throw new ModelTransportError("模型厂商返回了无效工具调用");
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
