// SPDX-License-Identifier: Apache-2.0

import { invoke } from "@tauri-apps/api/core";
import type {
  JsonValue,
  ServerRequestMethod,
  ServerRequestParams,
  ServerRequestResult
} from "@mn/app-server-protocol";
import { BrowserWebSocketRpcChannel, MuniuClient } from "@mn/sdk/browser";

interface AppServerConnectionDescriptor {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly token: string;
}

export interface DesktopApprovalRequest {
  readonly id: string;
  readonly method: ServerRequestMethod;
  readonly params: JsonValue;
}

interface PendingApproval extends DesktopApprovalRequest {
  readonly resolve: (result: unknown) => void;
}

const approvals = new Map<string, PendingApproval>();
const approvalSubscribers = new Set<(requests: readonly DesktopApprovalRequest[]) => void>();
let clientPromise: Promise<MuniuClient> | undefined;

function publishApprovals(): void {
  const visible = [...approvals.values()].map(({ resolve: _resolve, ...request }) => request);
  for (const subscriber of approvalSubscribers) subscriber(visible);
}

function approvalId(method: ServerRequestMethod, params: unknown): string {
  const record = params as { approvalId?: unknown; itemId?: unknown; callId?: unknown };
  const value = record.approvalId ?? record.itemId ?? record.callId;
  return typeof value === "string" && value ? value : `${method}:${crypto.randomUUID()}`;
}

function waitForApproval<M extends Extract<ServerRequestMethod, `${string}/requestApproval`>>(
  method: M,
  params: ServerRequestParams<M>
): Promise<ServerRequestResult<M>> {
  const id = approvalId(method, params);
  return new Promise((resolve) => {
    approvals.set(id, {
      id,
      method,
      params: params as JsonValue,
      resolve: (value) => resolve(value as ServerRequestResult<M>)
    });
    publishApprovals();
  });
}

async function connectionDescriptor(): Promise<AppServerConnectionDescriptor> {
  const envUrl = import.meta.env.VITE_MN_APP_SERVER_URL as string | undefined;
  const envToken = import.meta.env.VITE_MN_APP_SERVER_TOKEN as string | undefined;
  if (envUrl && envToken) return { schemaVersion: 1, url: envUrl, token: envToken };
  return invoke<AppServerConnectionDescriptor>("read_app_server_connection");
}

async function connect(): Promise<MuniuClient> {
  const descriptor = await connectionDescriptor();
  const channel = await BrowserWebSocketRpcChannel.connect({
    url: descriptor.url,
    token: descriptor.token
  });
  const client = new MuniuClient({
    channel,
    clientInfo: { name: "muniu-desktop", version: "0.2.0", title: "木牛 Desktop" },
    approvalHandler: waitForApproval
  });
  await client.connect();
  return client;
}

export function desktopAppServerClient(): Promise<MuniuClient> {
  clientPromise ??= connect().catch((error: unknown) => {
    clientPromise = undefined;
    throw error;
  });
  return clientPromise;
}

export function subscribeDesktopApprovals(
  subscriber: (requests: readonly DesktopApprovalRequest[]) => void
): () => void {
  approvalSubscribers.add(subscriber);
  subscriber([...approvals.values()].map(({ resolve: _resolve, ...request }) => request));
  return () => approvalSubscribers.delete(subscriber);
}

export function decideDesktopApproval(id: string, accepted: boolean): void {
  const pending = approvals.get(id);
  if (!pending) throw new Error("Approval request is no longer pending");
  approvals.delete(id);
  if (pending.method === "item/permissions/requestApproval") {
    const params = pending.params as { permissions?: JsonValue };
    pending.resolve({ permissions: accepted ? params.permissions ?? {} : {}, scope: "turn" });
  } else {
    pending.resolve({ decision: accepted ? "accept" : "decline" });
  }
  publishApprovals();
}

export async function resetDesktopAppServerClient(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  if (pending) await (await pending).close();
}
