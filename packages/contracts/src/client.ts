// SPDX-License-Identifier: Apache-2.0
import { API_OPERATIONS_V2 } from "./openapi.js";
import { API_INPUT_FIELDS_V2, type ApiInputsV2 } from "./generated-api.js";
export type { ApiInputsV2 } from "./generated-api.js";

export type ApiOperationIdV2 = (typeof API_OPERATIONS_V2)[number]["operationId"];
type Operation<K> = Extract<(typeof API_OPERATIONS_V2)[number], { readonly operationId: K }>;
type PathNames<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | PathNames<Rest> : never;
type PathInput<K extends ApiOperationIdV2> = Readonly<Record<PathNames<Operation<K>["path"]>, string>>;

export function apiPath<K extends ApiOperationIdV2>(operationId: K, path: PathInput<K>, query: Readonly<Record<string, string | number | undefined>> = {}): string {
  const operation = API_OPERATIONS_V2.find((item) => item.operationId === operationId);
  if (!operation) throw new TypeError("未知 API 操作");
  const encoded = operation.path.replace(/\{([^}]+)\}/gu, (_, name: string) => {
    const value = (path as Readonly<Record<string, string>>)[name];
    if (!value || value === "." || value === "..") throw new TypeError(`缺少或无效的路径参数：${name}`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
  return `${encoded}${search.size ? `?${search}` : ""}`;
}
export function apiRequest<K extends ApiOperationIdV2>(operationId: K, input: ApiInputsV2[K]) {
  const operation = API_OPERATIONS_V2.find((item) => item.operationId === operationId)!;
  return { path: apiPath(operationId, (input.path ?? {}) as PathInput<K>), method: operation.method.toUpperCase(),
    ...("body" in input ? { body: input.body } : {}), mutation: operation.mutation };
}
export function operationInputFields(operationId: ApiOperationIdV2): readonly { readonly name: string; readonly location: string; readonly required: boolean; readonly type?: string }[] {
  return API_INPUT_FIELDS_V2[operationId];
}
