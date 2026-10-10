// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentOsApiError, type AgentOsClient } from '../api';
export function reuseFailure(error: unknown): string { return error instanceof AgentOsApiError ? `${error.detail.message}。${error.detail.action}` : '操作未完成，请核对连接后重试。'; }
type Pending = { work: () => Promise<unknown>; uncertain: boolean };
type Action = { pending?: Pending; busy: boolean; error?: string; success?: boolean; listeners: Set<() => void> };
const stores = new WeakMap<AgentOsClient, Map<string, Action>>();
export function useReuseAction(api: AgentOsClient, workspaceId: string, slot: string, onSuccess: () => void) {
  let map = stores.get(api); if (!map) { map = new Map(); stores.set(api, map); }
  const id = `${workspaceId}:${slot}`;
  let existing = map.get(id); if (!existing) { existing = { busy: false, listeners: new Set() }; map.set(id, existing); }
  const store = existing, [, changed] = useState(0), done = useRef(onSuccess); done.current = onSuccess;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; const notify = () => changed(value => value + 1); store.listeners.add(notify); return () => { mounted.current = false; store.listeners.delete(notify); }; }, [store]);
  const notify = () => store.listeners.forEach(listener => listener());
  async function execute(request: Pending) {
    if (store.busy) return;
    store.busy = true; store.error = undefined; store.success = false; notify();
    try { await request.work(); store.pending = undefined; store.success = true; if (mounted.current) done.current(); }
    catch (error) { if (!request.uncertain && error instanceof AgentOsApiError && error.status < 500) store.pending = undefined; else request.uncertain = true; store.error = reuseFailure(error); }
    finally { store.busy = false; notify(); }
  }
  return { busy: store.busy, locked: store.busy || Boolean(store.pending), error: store.error, success: store.success, pending: Boolean(store.pending),
    retry: () => { if (store.pending) void execute(store.pending); },
    run: (work: (key: string) => Promise<unknown>) => { if (store.pending || store.busy) return; const key = crypto.randomUUID(), request = { work: () => work(key), uncertain: false }; store.pending = request; void execute(request); } };
}
export function useReuseRead<T>(api: AgentOsClient, workspaceId: string, load: () => Promise<T>) {
  const [value, setValue] = useState<{ load: () => Promise<T>; data: T }>(), [error, setError] = useState<string>(), epoch = useRef(0);
  const reload = useCallback(async () => { const request = ++epoch.current; setValue(undefined); setError(undefined); try { const next = await load(); if (request === epoch.current) setValue({ load, data: next }); } catch (caught) { if (request === epoch.current) setError(reuseFailure(caught)); } }, [load]);
  useEffect(() => { let timer: ReturnType<typeof setTimeout> | undefined; void reload(); const stop = api.watchWorkspaceEvents(workspaceId, () => { epoch.current++; setValue(undefined); if (!timer) timer = setTimeout(() => { timer = undefined; void reload(); }, 150); }); return () => { epoch.current++; stop(); if (timer) clearTimeout(timer); }; }, [api, workspaceId, reload]);
  return { value: value?.load === load ? value.data : undefined, error, reload };
}
