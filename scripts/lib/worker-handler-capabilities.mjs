// SPDX-License-Identifier: Apache-2.0

const JOB_KIND_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

export function parseWorkerSupportedKinds(raw) {
  let value;
  try {
    value = JSON.parse(raw ?? "");
  } catch {
    throw new Error("MN_WORKER_SUPPORTED_KINDS 必须是 JSON 数组");
  }
  if (!Array.isArray(value) || value.length === 0
    || value.some((kind) => typeof kind !== "string"
      || kind.trim() !== kind
      || !JOB_KIND_PATTERN.test(kind))
    || new Set(value).size !== value.length) {
    throw new Error("MN_WORKER_SUPPORTED_KINDS 必须是非空、无重复的合法 Job kind 数组");
  }
  return [...value].sort();
}
