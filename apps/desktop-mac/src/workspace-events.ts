// SPDX-License-Identifier: Apache-2.0
export type WorkspaceConnectionState = "connecting" | "connected" | "disconnected";
interface Subscriber { readonly change: () => void; readonly state?: (state: WorkspaceConnectionState) => void }

export class WorkspaceEventStream {
  private readonly subscribers = new Set<Subscriber>();
  private source?: EventSource;
  private timer?: ReturnType<typeof setTimeout>;
  private cursor: number;
  private failures = 0;
  private state: WorkspaceConnectionState = "connecting";
  private closed = false;
  constructor(private readonly url: URL, private readonly storageKey: string, private readonly onEmpty: () => void) {
    try { this.cursor = validPosition(sessionStorage.getItem(storageKey)) ?? 0; } catch { this.cursor = 0; }
  }
  subscribe(change: () => void, state?: (state: WorkspaceConnectionState) => void): () => void {
    const subscriber: Subscriber = { change, ...(state ? { state } : {}) };
    this.subscribers.add(subscriber); state?.(this.state);
    if (!this.source && !this.timer) this.connect();
    let released = false;
    return () => {
      if (released) return;
      released = true; this.subscribers.delete(subscriber);
      if (this.subscribers.size) return;
      this.closed = true; this.source?.close();
      if (this.timer) clearTimeout(this.timer);
      this.onEmpty();
    };
  }
  private updateState(state: WorkspaceConnectionState) {
    this.state = state;
    for (const subscriber of this.subscribers) subscriber.state?.(state);
  }
  private changed() { for (const subscriber of this.subscribers) subscriber.change(); }
  private saveCursor() { try { sessionStorage.setItem(this.storageKey, String(this.cursor)); } catch { /* Storage may be disabled. */ } }
  private connect() {
    if (this.closed) return;
    this.timer = undefined; this.url.searchParams.set("after", String(this.cursor));
    const source = new EventSource(this.url); this.source = source;
    const current = () => !this.closed && source === this.source;
    source.addEventListener("open", () => {
      if (!current()) return;
      this.failures = 0; this.updateState("connected"); this.changed();
    });
    source.addEventListener("kernel", event => {
      if (!current()) return;
      this.cursor = Math.max(this.cursor, validPosition((event as MessageEvent).lastEventId) ?? this.cursor);
      this.saveCursor(); this.changed();
    });
    source.addEventListener("cursor", event => {
      if (!current()) return;
      const reported = validPosition((event as MessageEvent).lastEventId);
      if (reported === undefined) return;
      const reset = reported < this.cursor; this.cursor = reported; this.saveCursor();
      if (reset) this.changed();
    });
    source.addEventListener("error", () => {
      if (!current()) return;
      source.close(); this.source = undefined; this.failures += 1; this.updateState("disconnected");
      if (this.failures >= 2 && this.cursor > 0) { this.cursor = 0; this.saveCursor(); this.changed(); }
      this.timer = setTimeout(() => this.connect(), Math.min(2_000, this.failures * 500));
    });
  }
}

function validPosition(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const position = Number(value);
  return Number.isSafeInteger(position) ? position : undefined;
}
