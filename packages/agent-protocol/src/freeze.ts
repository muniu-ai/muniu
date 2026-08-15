/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/llm/llm/src/call-config.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: retained only the cycle-safe immutable publication helper.
 */

export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const pending: (
    | { kind: "visit"; node: unknown }
    | { kind: "property"; source: Record<string, unknown>; key: string }
  )[] = [{ kind: "visit", node: value }];
  while (pending.length > 0) {
    const task = pending.pop();
    if (task === undefined) continue;
    if (task.kind === "property") {
      pending.push({ kind: "visit", node: task.source[task.key] });
      continue;
    }
    const node = task.node;
    if (node === null || typeof node !== "object") continue;
    if (node instanceof AbortSignal) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    const keys = Object.keys(node);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key !== undefined) pending.push({ kind: "property", source: node as Record<string, unknown>, key });
    }
  }
  return value;
}
