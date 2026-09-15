// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { createProjectionFacts, type JsonObject } from "@mn/contracts";
import { IdempotencyConflictError, StreamVersionConflictError } from "./types.js";
import type { WrappedDataKey } from "./encryption.js";
import type { KernelStoreCompatible } from "./types.js";

export const KEY_REVOCATION_NAMESPACE = "kernel.key-revocation";

export interface KeyRevocation {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly wrappedKey: WrappedDataKey;
  readonly actorId: string;
  readonly status: "pending" | "running" | "needs_reconciliation" | "completed";
  readonly streamVersion: number;
  readonly lastRequestId?: string;
  readonly startedAt?: string;
  readonly requestedAt: string;
}

export interface DrainKeyRevocationsOptions {
  readonly store: KernelStoreCompatible;
  readonly tenantId: string;
  readonly purpose?: string;
  readonly revocationId?: string;
  readonly requestId?: string;
  readonly actorId?: string;
  readonly now?: () => string;
  readonly keyProvider: {
    revokeKey?(wrapped: WrappedDataKey): Promise<void>;
    isKeyRevoked?(wrapped: WrappedDataKey): Promise<boolean>;
  };
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Key revocation IO timed out")), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Returns unresolved requests. Recovery inspects unknown outcomes but never repeats them. */
export async function drainKeyRevocations(options: DrainKeyRevocationsOptions): Promise<number> {
  const now = options.now ?? (() => new Date().toISOString());
  const pending = () => options.store.transact(options.tenantId, tx => tx.listProjections<KeyRevocation>(KEY_REVOCATION_NAMESPACE)
    .filter(record => record.status !== "completed" && (!options.purpose || record.wrappedKey.context.purpose === options.purpose)
      && (!options.revocationId || record.id === options.revocationId)));
  const transition = (record: KeyRevocation, status: KeyRevocation["status"]) => options.store.transact(options.tenantId, tx => {
    const current = tx.getProjection<KeyRevocation>(KEY_REVOCATION_NAMESPACE, record.id);
    if (!current || current.streamVersion !== record.streamVersion || current.status === "completed") return undefined;
    const timestamp = now();
    const next: KeyRevocation = { ...current, status, streamVersion: current.streamVersion + 1,
      ...(status === "running" ? { startedAt: timestamp, lastRequestId: current.lastRequestId ?? options.requestId ?? `recovery:${record.id}:${record.streamVersion}` } : {}) };
    tx.putProjection(KEY_REVOCATION_NAMESPACE, record.id, next);
    const inboxId = `key-revocation:${record.id}`;
    const priorInbox = tx.getProjection<JsonObject>("inbox", inboxId);
    const inbox: JsonObject | undefined = status === "needs_reconciliation" ? {
      id: inboxId, tenantId: options.tenantId, workspaceId: record.workspaceId, kind: "reconciliation",
      title: "密钥删除需要核对", summary: "删除结果尚未确认；再次删除必须由人明确发起。",
      risk: "历史备份可能仍可解密", resourceSummary: record.wrappedKey.context.purpose,
      revocationId: record.id, streamVersion: next.streamVersion,
      createdAt: timestamp, status: "open",
    } : status === "completed" && priorInbox ? { ...priorInbox, status: "resolved" } : undefined;
    if (inbox) tx.putProjection("inbox", inboxId, inbox);
    const event = tx.appendEvent({ tenantId: options.tenantId, aggregateType: "keyRevocation", aggregateId: record.id,
      expectedStreamVersion: record.streamVersion, type: `key.revocation_${status}`,
      actorId: options.actorId ?? "system:key-revocation", generation: 0, correlationId: `key-revocation:${record.id}`,
      publicPayload: { workspaceId: record.workspaceId, status,
        ...(inbox ? { projectionFacts: createProjectionFacts([{ namespace: "inbox", id: inboxId, value: inbox }]) } : {}) } });
    tx.putOutbox({ id: `key-revocation:${record.id}:${next.streamVersion}`, tenantId: options.tenantId,
      topic: event.type, payload: { eventId: event.id, revocationId: record.id }, availableAt: timestamp });
    return next;
  });
  const confirmed = async (record: KeyRevocation): Promise<boolean> => {
    try { return await bounded(options.keyProvider.isKeyRevoked?.(record.wrappedKey) ?? Promise.resolve(false)); }
    catch { return false; }
  };
  for (const candidate of await pending()) {
    if (candidate.tenantId !== options.tenantId || candidate.wrappedKey.context.tenantId !== options.tenantId) {
      throw new Error("Key revocation cannot cross tenants");
    }
    let current = candidate;
    if (current.status !== "pending") {
      if (await confirmed(current)) { await transition(current, "completed"); continue; }
      if (current.status === "running" && Date.parse(now()) - Date.parse(current.startedAt ?? now()) < 30_000) continue;
      if (current.status === "running") await transition(current, "needs_reconciliation");
      continue;
    }
    if (!options.keyProvider.revokeKey) continue;
    const started = await transition(current, "running");
    if (!started) continue;
    current = started;
    try {
      await bounded(options.keyProvider.revokeKey(current.wrappedKey));
      if (!await confirmed(current)) throw new Error("Wrapping key revocation was not confirmed");
      await transition(current, "completed");
    } catch {
      await transition(current, await confirmed(current) ? "completed" : "needs_reconciliation");
    }
  }
  return (await pending()).length;
}

/** Call only after Host has authorized a workspace owner to request a new irreversible call. */
export async function requestKeyRevocationRetry(options: {
  readonly store: KernelStoreCompatible; readonly tenantId: string; readonly actorId: string;
  readonly revocationId: string; readonly expectedStreamVersion: number; readonly requestId: string;
  readonly now?: () => string;
}): Promise<void> {
  await options.store.transact(options.tenantId, tx => {
    const scope = `key-revocation.retry:${options.revocationId}`;
    const digest = createHash("sha256").update(JSON.stringify({ actorId: options.actorId,
      expectedStreamVersion: options.expectedStreamVersion })).digest("hex");
    const receipt = tx.getIdempotency(scope, options.requestId);
    if (receipt) {
      if (receipt.requestDigest !== digest) throw new IdempotencyConflictError(options.tenantId, options.requestId);
      return;
    }
    const current = tx.getProjection<KeyRevocation>(KEY_REVOCATION_NAMESPACE, options.revocationId);
    if (!current || current.tenantId !== options.tenantId) throw new Error("Key revocation does not exist");
    if (current.streamVersion !== options.expectedStreamVersion) throw new StreamVersionConflictError(
      options.tenantId, "keyRevocation", current.id, options.expectedStreamVersion, current.streamVersion);
    if (current.status !== "needs_reconciliation") throw new Error("Only an unknown key revocation may be retried");
    const timestamp = options.now?.() ?? new Date().toISOString();
    tx.putProjection(KEY_REVOCATION_NAMESPACE, current.id, { ...current, status: "pending",
      streamVersion: current.streamVersion + 1, lastRequestId: options.requestId });
    const event = tx.appendEvent({ tenantId: options.tenantId, aggregateType: "keyRevocation", aggregateId: current.id,
      expectedStreamVersion: current.streamVersion, type: "key.revocation_retry_requested", actorId: options.actorId,
      generation: 0, correlationId: `key-revocation:${current.id}`, publicPayload: { workspaceId: current.workspaceId } });
    tx.putOutbox({ id: `key-revocation-retry:${event.id}`, tenantId: options.tenantId, topic: event.type,
      payload: { eventId: event.id }, availableAt: timestamp });
    tx.putIdempotency({ tenantId: options.tenantId, scope, key: options.requestId, requestDigest: digest,
      response: { id: current.id, accepted: true }, createdAt: timestamp });
  });
}
