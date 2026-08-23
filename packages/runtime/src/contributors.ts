// SPDX-License-Identifier: Apache-2.0

export const CONTRIBUTOR_CHANNELS = Object.freeze([
  "thread.beforeStart",
  "thread.started",
  "turn.beforeStart",
  "turn.started",
  "turn.completed",
  "context.collect",
  "tools.collect",
  "approval.requested",
  "items.ordered",
  "tokenUsage.recorded",
  "config.changed",
  "skill.invoked"
] as const);

export type ContributorChannel = (typeof CONTRIBUTOR_CHANNELS)[number];

export interface Contributor<TPayload = unknown, TResult = unknown> {
  readonly id: string;
  readonly priority?: number;
  contribute(payload: TPayload): TResult | Promise<TResult>;
}

interface RegisteredContributor {
  readonly id: string;
  readonly priority: number;
  readonly sequence: number;
  readonly contribute: Contributor["contribute"];
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function payloadSnapshot<T>(value: T): T {
  try {
    return deepFreeze(structuredClone(value));
  } catch (error: unknown) {
    throw new TypeError("contributor payload must be structured-cloneable", { cause: error });
  }
}

export class ContributorBus {
  static readonly channels = CONTRIBUTOR_CHANNELS;

  readonly #contributors = new Map<ContributorChannel, RegisteredContributor[]>();
  #sequence = 0;
  #disposed = false;

  register<TPayload, TResult>(
    channel: ContributorChannel,
    contributor: Contributor<TPayload, TResult>
  ): () => void {
    if (this.#disposed) throw new Error("contributor bus is disposed");
    if (!CONTRIBUTOR_CHANNELS.includes(channel)) throw new TypeError("contributor channel is invalid");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(contributor.id)) {
      throw new TypeError("contributor identifier is invalid");
    }
    if (typeof contributor.contribute !== "function") throw new TypeError("contributor handler is invalid");
    const priority = contributor.priority ?? 100;
    if (!Number.isSafeInteger(priority)) throw new TypeError("contributor priority must be an integer");
    const entries = this.#contributors.get(channel) ?? [];
    if (entries.some((entry) => entry.id === contributor.id)) {
      throw new Error(`contributor ${contributor.id} is already registered for ${channel}`);
    }
    const entry: RegisteredContributor = Object.freeze({
      id: contributor.id,
      priority,
      sequence: this.#sequence++,
      contribute: contributor.contribute.bind(contributor)
    });
    entries.push(entry);
    entries.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
    this.#contributors.set(channel, entries);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.#contributors.get(channel);
      if (!current) return;
      const index = current.indexOf(entry);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.#contributors.delete(channel);
    };
  }

  async emit<TPayload, TResult>(channel: ContributorChannel, payload: TPayload): Promise<readonly TResult[]> {
    if (this.#disposed) throw new Error("contributor bus is disposed");
    if (!CONTRIBUTOR_CHANNELS.includes(channel)) throw new TypeError("contributor channel is invalid");
    const snapshot = payloadSnapshot(payload);
    const results: TResult[] = [];
    for (const contributor of [...(this.#contributors.get(channel) ?? [])]) {
      results.push(await contributor.contribute(snapshot) as TResult);
    }
    return Object.freeze(results);
  }

  list(channel?: ContributorChannel): readonly Readonly<{
    channel: ContributorChannel;
    id: string;
    priority: number;
  }>[] {
    const channels = channel === undefined ? CONTRIBUTOR_CHANNELS : [channel];
    return Object.freeze(channels.flatMap((candidate) =>
      (this.#contributors.get(candidate) ?? []).map((entry) => Object.freeze({
        channel: candidate,
        id: entry.id,
        priority: entry.priority
      }))
    ));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#contributors.clear();
  }
}
