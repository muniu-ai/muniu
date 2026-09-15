// SPDX-License-Identifier: Apache-2.0
import { Context } from "@deepseek-ai/cordis";

import {
  CONTRIBUTION_KINDS,
  type ContributionByKind,
  type ContributionKind,
  type ContributionResource,
  type ScopeIdentity,
  type ScopeLevel,
} from "./types.js";

const CHILD_LEVELS: Readonly<Record<ScopeLevel, readonly ScopeLevel[]>> = {
  tenant: ["workspace"],
  workspace: ["thread"],
  thread: ["execution"],
  execution: ["subagent"],
  subagent: ["subagent"],
};

interface SharedScopeState {
  generation: number;
  activated: boolean;
}

interface Registration<T extends ContributionResource = ContributionResource> {
  readonly token: symbol;
  readonly contribution: T;
}

export class ScopeDisposedError extends Error {
  constructor() {
    super("Scope 已清理");
    this.name = "ScopeDisposedError";
  }
}

class ImmutableContributionMap<T> implements ReadonlyMap<string, T> {
  readonly #values: Map<string, T>;

  constructor(values: Iterable<readonly [string, T]>) {
    this.#values = new Map(values);
  }

  get size(): number { return this.#values.size; }
  get(key: string): T | undefined { return this.#values.get(key); }
  has(key: string): boolean { return this.#values.has(key); }
  entries(): MapIterator<[string, T]> { return this.#values.entries(); }
  keys(): MapIterator<string> { return this.#values.keys(); }
  values(): MapIterator<T> { return this.#values.values(); }
  forEach(callbackfn: (value: T, key: string, map: ReadonlyMap<string, T>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[string, T]> { return this.#values[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return "ReadonlyMap"; }

  set(): never { throw new Error("贡献快照是只读的"); }
  delete(): never { throw new Error("贡献快照是只读的"); }
  clear(): never { throw new Error("贡献快照是只读的"); }
}

export interface ContributionsByKind {
  readonly prompt: ReadonlyMap<string, ContributionByKind["prompt"]>;
  readonly llm: ReadonlyMap<string, ContributionByKind["llm"]>;
  readonly tool: ReadonlyMap<string, ContributionByKind["tool"]>;
  readonly skill: ReadonlyMap<string, ContributionByKind["skill"]>;
  readonly job: ReadonlyMap<string, ContributionByKind["job"]>;
  readonly subagent: ReadonlyMap<string, ContributionByKind["subagent"]>;
}

export class TurnContributions {
  constructor(
    readonly generation: number,
    readonly byKind: ContributionsByKind,
  ) {
    Object.freeze(byKind);
    Object.freeze(this);
  }

  get<K extends ContributionKind>(kind: K, id: string): ContributionByKind[K] | undefined {
    return this.byKind[kind].get(id) as ContributionByKind[K] | undefined;
  }

  list<K extends ContributionKind>(kind: K): readonly ContributionByKind[K][] {
    return [...this.byKind[kind].values()] as ContributionByKind[K][];
  }
}

export interface ScopeRegistration {
  dispose(): void;
}

export class AgentScope {
  readonly context: Context;
  readonly ready: Promise<void>;
  readonly #ownsRoot: boolean;
  readonly #children = new Set<AgentScope>();
  readonly #registrations: { [K in ContributionKind]: Map<string, Registration<ContributionByKind[K]>> };
  readonly #retiredContributions: ContributionResource[] = [];
  readonly #disposeCallbacks: Array<() => void | Promise<void>> = [];
  #disposed = false;
  #disposing = false;
  #disposal?: Promise<void>;

  private constructor(
    readonly level: ScopeLevel,
    readonly id: string,
    readonly identity: ScopeIdentity,
    readonly parent: AgentScope | undefined,
    private readonly shared: SharedScopeState,
    compositionRoot?: Context,
  ) {
    this.#registrations = {
      prompt: new Map(),
      llm: new Map(),
      tool: new Map(),
      skill: new Map(),
      job: new Map(),
      subagent: new Map(),
    };
    this.#ownsRoot = !parent && !compositionRoot;
    const owner = parent?.context ?? compositionRoot ?? new Context();
    const isolated = owner.isolate("session").isolate("tool").isolate("model").isolate("agentScopeContributions");
    const fiber = isolated.plugin({
      name: `agent-scope:${level}`,
      apply: (context: Context) => {
        context.provide("agentScopeContributions", this.#registrations);
        context.effect(() => () => this.#disposeResources());
      },
    });
    this.context = fiber.ctx;
    this.ready = Promise.all([parent?.ready, Promise.resolve(fiber)]).then(() => undefined);
  }

  static tenant(tenantId: string, initialGeneration = 1, compositionRoot?: Context): AgentScope {
    if (tenantId.length === 0) throw new Error("tenant id 不能为空");
    if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 1) {
      throw new Error("Scope 初始 generation 必须是正整数");
    }
    return new AgentScope(
      "tenant",
      tenantId,
      { tenantId, subagentPath: [] },
      undefined,
      { generation: initialGeneration, activated: false },
      compositionRoot,
    );
  }

  get disposed(): boolean { return this.#disposed; }

  createChild(level: ScopeLevel, id: string): AgentScope {
    this.#assertActive();
    if (!CHILD_LEVELS[this.level].includes(level)) {
      throw new Error(`${this.level} Scope 只能创建 ${CHILD_LEVELS[this.level].join(" 或 ")} Scope`);
    }
    if (id.length === 0) throw new Error("Scope id 不能为空");
    const identity = scopeIdentity(this.identity, level, id);
    const child = new AgentScope(level, id, identity, this, this.shared);
    this.#children.add(child);
    return child;
  }

  register<K extends ContributionKind>(
    kind: K,
    contribution: ContributionByKind[K],
  ): ScopeRegistration {
    this.#assertActive();
    if (contribution.id.length === 0) throw new Error("贡献 id 不能为空");
    const registrations = this.#registrations[kind] as Map<string, Registration<ContributionByKind[K]>>;
    const previous = registrations.get(contribution.id);
    if (previous !== undefined) this.#retiredContributions.push(previous.contribution);
    const token = Symbol(contribution.id);
    registrations.set(contribution.id, { token, contribution });
    if (this.shared.activated) this.shared.generation += 1;
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        const current = registrations.get(contribution.id);
        if (current?.token !== token) return;
        registrations.delete(contribution.id);
        this.#retiredContributions.push(contribution);
        if (this.shared.activated) this.shared.generation += 1;
      },
    };
  }

  onDispose(callback: () => void | Promise<void>): ScopeRegistration {
    this.#assertActive();
    this.#disposeCallbacks.push(callback);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        const index = this.#disposeCallbacks.indexOf(callback);
        if (index >= 0) this.#disposeCallbacks.splice(index, 1);
      },
    };
  }

  resolveTurn(): TurnContributions {
    this.#assertActive();
    this.shared.activated = true;
    const lineage: AgentScope[] = [];
    for (let current: AgentScope | undefined = this; current !== undefined; current = current.parent) {
      current.#assertActive();
      lineage.unshift(current);
    }
    const resolved = Object.fromEntries(CONTRIBUTION_KINDS.map((kind) => [kind, new Map()])) as {
      [K in ContributionKind]: Map<string, ContributionByKind[K]>;
    };
    for (const scope of lineage) {
      for (const kind of CONTRIBUTION_KINDS) {
        const target = resolved[kind] as Map<string, ContributionResource>;
        const local = scope.#registrations[kind] as Map<string, Registration>;
        for (const [id, registration] of local) target.set(id, registration.contribution);
      }
    }
    return new TurnContributions(this.shared.generation, {
      prompt: new ImmutableContributionMap(resolved.prompt),
      llm: new ImmutableContributionMap(resolved.llm),
      tool: new ImmutableContributionMap(resolved.tool),
      skill: new ImmutableContributionMap(resolved.skill),
      job: new ImmutableContributionMap(resolved.job),
      subagent: new ImmutableContributionMap(resolved.subagent),
    });
  }

  dispose(): Promise<void> {
    this.#disposing = true;
    return this.#disposal ??= this.#ownsRoot ? this.context.root.fiber.dispose() : this.context.fiber.dispose();
  }

  async #disposeResources(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    for (const child of [...this.#children].reverse()) {
      try { await child.dispose(); } catch (error: unknown) { errors.push(error); }
    }
    this.#children.clear();
    for (const kind of [...CONTRIBUTION_KINDS].reverse()) {
      const registrations = this.#registrations[kind] as Map<string, Registration>;
      for (const registration of [...registrations.values()].reverse()) {
        try { registration.contribution.dispose?.(); } catch (error: unknown) { errors.push(error); }
      }
      registrations.clear();
    }
    for (const contribution of [...this.#retiredContributions].reverse()) {
      try { contribution.dispose?.(); } catch (error: unknown) { errors.push(error); }
    }
    this.#retiredContributions.length = 0;
    for (const callback of [...this.#disposeCallbacks].reverse()) {
      try { await callback(); } catch (error: unknown) { errors.push(error); }
    }
    this.#disposeCallbacks.length = 0;
    if (this.parent !== undefined) this.parent.#children.delete(this);
    this.shared.generation += 1;
    if (errors.length > 0) throw new AggregateError(errors, "Scope 清理失败");
  }

  #assertActive(): void {
    if (this.#disposed || this.#disposing || this.context.fiber.uid === null) throw new ScopeDisposedError();
  }
}

function scopeIdentity(parent: ScopeIdentity, level: ScopeLevel, id: string): ScopeIdentity {
  switch (level) {
    case "workspace": return { tenantId: parent.tenantId, workspaceId: id, subagentPath: [] };
    case "thread": return { ...parent, threadId: id };
    case "execution": return { ...parent, executionId: id };
    case "subagent": return { ...parent, subagentPath: [...parent.subagentPath, id] };
    case "tenant": throw new Error("tenant Scope 不能作为子 Scope");
  }
}
