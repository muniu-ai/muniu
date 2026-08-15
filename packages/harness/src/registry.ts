import type {
  ContextFragmentInput,
  ContextSource,
  GateRunner,
  SandboxBackend
} from "./types.js";
import { cloneSafeJsonValue, deepFreezeJson } from "./redaction.js";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ownEnumerableDataProperty<T>(value: object, key: PropertyKey): T {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${String(key)} must be an own enumerable data property`);
  }
  return descriptor.value as T;
}

function callableDataProperty<T>(value: object, key: PropertyKey): T {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`${String(key)} must be a data function`);
      }
      return descriptor.value as T;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new TypeError(`${String(key)} must be a data function`);
}

function requireIdentifier(value: string, kind: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${kind} id must be a non-empty trimmed string`);
  }
  return value;
}

export class CapabilityRegistry {
  readonly #gates = new Map<string, GateRunner>();
  readonly #sandboxes = new Map<string, SandboxBackend>();
  readonly #contextSources = new Map<string, ContextSource>();

  registerGateRunner(runner: GateRunner): void {
    const id = requireIdentifier(
      cloneSafeJsonValue(ownEnumerableDataProperty(runner, "id")),
      "Gate runner"
    );
    if (this.#gates.has(id)) {
      throw new Error(`Gate runner ${id} is already registered`);
    }
    const version = cloneSafeJsonValue<string>(
      ownEnumerableDataProperty(runner, "version")
    );
    const languageSnapshot = cloneSafeJsonValue<readonly string[]>(
      ownEnumerableDataProperty(runner, "languages")
    );
    const languages = Object.freeze([...languageSnapshot]);
    const run = callableDataProperty<GateRunner["run"]>(runner, "run");
    this.#gates.set(id, Object.freeze({
      id,
      version,
      languages,
      run(request: Parameters<GateRunner["run"]>[0]) {
        return Reflect.apply(run, runner, [request]);
      }
    }));
  }

  registerSandboxBackend(backend: SandboxBackend): void {
    const id = requireIdentifier(
      cloneSafeJsonValue(ownEnumerableDataProperty(backend, "id")),
      "Sandbox backend"
    );
    if (this.#sandboxes.has(id)) {
      throw new Error(`Sandbox backend ${id} is already registered`);
    }
    const version = cloneSafeJsonValue<string>(
      ownEnumerableDataProperty(backend, "version")
    );
    const enforcement = cloneSafeJsonValue<SandboxBackend["enforcement"]>(
      ownEnumerableDataProperty(backend, "enforcement")
    );
    const capabilitySnapshot = cloneSafeJsonValue<readonly string[]>(
      ownEnumerableDataProperty(backend, "capabilities")
    );
    const capabilities = Object.freeze([...capabilitySnapshot]);
    const runtimeImage = Object.hasOwn(backend, "runtimeImage")
      ? deepFreezeJson(cloneSafeJsonValue(
          ownEnumerableDataProperty<NonNullable<SandboxBackend["runtimeImage"]>>(
            backend,
            "runtimeImage"
          )
        ))
      : undefined;
    const prepare = callableDataProperty<SandboxBackend["prepare"]>(
      backend,
      "prepare"
    );
    this.#sandboxes.set(id, Object.freeze({
      id,
      version,
      enforcement,
      capabilities,
      ...(runtimeImage ? { runtimeImage } : {}),
      prepare(request: Parameters<SandboxBackend["prepare"]>[0]) {
        return Reflect.apply(prepare, backend, [request]);
      }
    }));
  }

  registerContextSource(source: ContextSource): void {
    const id = requireIdentifier(
      cloneSafeJsonValue(ownEnumerableDataProperty(source, "id")),
      "Context source"
    );
    if (this.#contextSources.has(id)) {
      throw new Error(`Context source ${id} is already registered`);
    }
    const collect = callableDataProperty<ContextSource["collect"]>(
      source,
      "collect"
    );
    this.#contextSources.set(id, Object.freeze({
      id,
      collect(request: Parameters<ContextSource["collect"]>[0]) {
        return Reflect.apply(collect, source, [request]);
      }
    }));
  }

  getGateRunner(id: string): GateRunner | undefined {
    return this.#gates.get(id);
  }

  getSandboxBackend(id: string): SandboxBackend | undefined {
    return this.#sandboxes.get(id);
  }

  listGateRunners(): readonly GateRunner[] {
    return [...this.#gates.values()].sort((left, right) =>
      compareCodeUnits(left.id, right.id)
    );
  }

  listSandboxBackends(): readonly SandboxBackend[] {
    return [...this.#sandboxes.values()].sort((left, right) =>
      compareCodeUnits(left.id, right.id)
    );
  }

  listContextSources(): readonly ContextSource[] {
    return [...this.#contextSources.values()].sort((left, right) =>
      compareCodeUnits(left.id, right.id)
    );
  }
}

export function createStaticContextSource(
  id: string,
  fragments: readonly ContextFragmentInput[]
): ContextSource {
  requireIdentifier(id, "Context source");
  const snapshot = deepFreezeJson(cloneSafeJsonValue(fragments));
  return Object.freeze({
    id,
    collect() {
      return cloneSafeJsonValue(snapshot);
    }
  });
}
