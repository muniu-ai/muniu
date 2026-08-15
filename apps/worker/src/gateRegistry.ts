import type { GateId } from "@mn/core";

export interface GateCommandResolution {
  readonly executable: string;
  readonly args: readonly string[];
  readonly display: string;
  readonly versionArgs: readonly string[];
}

export interface GateResolutionContext {
  readonly gateId: GateId;
  readonly cwd: string;
  readonly language: string;
  readonly declaredCommands?: Readonly<
    Record<string, Readonly<{ executable: string; args: readonly string[] }>>
  >;
  readonly facts?: GateEvaluationFacts;
  readonly signal?: AbortSignal;
}

export interface GateEvaluationFacts {
  readonly spec?: unknown;
  readonly previousSpec?: unknown;
  readonly coveredSpecClauseIds?: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly allowedPaths?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly contractDocuments?: readonly GateContractDocument[];
  readonly rollbackPaths?: readonly string[];
}

export interface GateContractDocument {
  readonly type: "openapi" | "asyncapi";
  readonly path: string;
  readonly content: string;
  readonly previousContent?: string;
}

export interface GateEvaluationArtifact {
  readonly kind: "log" | "sarif" | "junit" | "coverage" | "contract" | "other";
  readonly contentType: string;
  readonly content: string;
}

export interface GateEvaluationResult {
  readonly status:
    | "pass"
    | "fail"
    | "error"
    | "skipped"
    | "unsupported"
    | "cancelled";
  readonly summary: string;
  readonly log?: string;
  readonly artifacts?: readonly GateEvaluationArtifact[];
}

export interface GateRunnerV2 {
  readonly id: string;
  readonly version: string;
  readonly gateIds: readonly GateId[];
  readonly languages: readonly string[];
  resolveCommand?(
    context: GateResolutionContext
  ): GateCommandResolution | undefined | Promise<GateCommandResolution | undefined>;
  evaluate?(
    context: GateResolutionContext
  ): GateEvaluationResult | Promise<GateEvaluationResult>;
}

/** A mechanically executable runner. The narrower type keeps command-only
 * factory consumers from having to treat resolveCommand as optional. */
export interface CommandGateRunnerV2 extends GateRunnerV2 {
  resolveCommand(
    context: GateResolutionContext
  ): GateCommandResolution | undefined | Promise<GateCommandResolution | undefined>;
}

function requireIdentity(value: string, field: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class GateRegistryV2 {
  readonly #runners = new Map<string, GateRunnerV2>();
  readonly #byGateAndLanguage = new Map<string, GateRunnerV2>();

  register(runner: GateRunnerV2): void {
    const id = requireIdentity(runner.id, "Gate runner id");
    requireIdentity(runner.version, "Gate runner version");
    if (this.#runners.has(id)) {
      throw new Error(`Gate runner ${id} is already registered`);
    }
    if (runner.gateIds.length === 0 || runner.languages.length === 0) {
      throw new TypeError(`Gate runner ${id} must declare gates and languages`);
    }
    if (typeof runner.resolveCommand !== "function" && typeof runner.evaluate !== "function") {
      throw new TypeError(`Gate runner ${id} must implement resolveCommand or evaluate`);
    }
    const identities: string[] = [];
    for (const gateId of runner.gateIds) {
      requireIdentity(gateId, `Gate runner ${id} gate id`);
      for (const language of runner.languages) {
        requireIdentity(language, `Gate runner ${id} language`);
        const identity = `${gateId}\0${language}`;
        if (this.#byGateAndLanguage.has(identity)) {
          throw new Error(
            `Gate capability ${gateId}/${language} is already registered`
          );
        }
        identities.push(identity);
      }
    }
    this.#runners.set(id, runner);
    for (const identity of identities) this.#byGateAndLanguage.set(identity, runner);
  }

  resolve(gateId: GateId, language: string): GateRunnerV2 | undefined {
    return (
      this.#byGateAndLanguage.get(`${gateId}\0${language}`) ??
      this.#byGateAndLanguage.get(`${gateId}\0*`)
    );
  }

  list(): readonly GateRunnerV2[] {
    return [...this.#runners.values()].sort((left, right) =>
      compareCodeUnits(left.id, right.id)
    );
  }
}
