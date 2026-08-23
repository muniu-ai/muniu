// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "@mn/agent-protocol";

export type ContextEntrySource =
  | "systemInvariant"
  | "signedGovernanceSpec"
  | "appDeveloperInstructions"
  | "repositoryInstructions"
  | "selectedSkill"
  | "userInput"
  | "toolResult";

export interface ContextEntry {
  readonly source: ContextEntrySource;
  readonly text: string;
}

export interface ContextAssemblyInput {
  readonly systemInvariants?: readonly string[];
  readonly signedGovernanceSpec?: readonly string[];
  readonly appDeveloperInstructions?: readonly string[];
  readonly repositoryInstructions?: readonly string[];
  readonly selectedSkills?: readonly string[];
  readonly userInputs?: readonly string[];
  readonly toolResults?: readonly string[];
}

export interface AssembledContext {
  readonly entries: readonly ContextEntry[];
  readonly instructionSources: readonly ContextEntrySource[];
}

export interface ContextManagerOptions {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly safetyMarginTokens: number;
}

export interface ContextCompactionInput {
  readonly previousSummary?: string;
  readonly goal?: string;
  readonly pendingApprovals: readonly string[];
  readonly plan: readonly string[];
  readonly diff?: string;
  readonly artifactRefs: readonly string[];
  readonly entries: readonly ContextEntry[];
  readonly summarize: (input: Readonly<{
    previousSummary?: string;
    goal?: string;
    pendingApprovals: readonly string[];
    plan: readonly string[];
    diff?: string;
    artifactRefs: readonly string[];
    entries: readonly ContextEntry[];
  }>) => Promise<string>;
}

export interface CompactedContext {
  readonly previousSummary?: string;
  readonly summary: string;
  readonly goal?: string;
  readonly pendingApprovals: readonly string[];
  readonly plan: readonly string[];
  readonly diff?: string;
  readonly artifactRefs: readonly string[];
}

export class ContextCompactionError extends Error {
  constructor(cause?: unknown) {
    super("context compaction failed; the turn was not truncated", { cause });
    this.name = "ContextCompactionError";
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
}

function texts(value: readonly string[] | undefined, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} must contain strings`);
  }
  return Object.freeze([...value]);
}

export class ContextManager {
  readonly compactionThresholdTokens: number;

  constructor(options: ContextManagerOptions) {
    assertPositiveInteger(options.contextWindowTokens, "context window");
    assertPositiveInteger(options.maxOutputTokens, "maximum output");
    assertPositiveInteger(options.safetyMarginTokens, "context safety margin");
    const reserved = options.contextWindowTokens
      - options.maxOutputTokens
      - options.safetyMarginTokens;
    if (reserved < 1) throw new TypeError("context reserves leave no input capacity");
    this.compactionThresholdTokens = Math.min(
      Math.floor(options.contextWindowTokens * 0.85),
      reserved
    );
  }

  assemble(input: ContextAssemblyInput): AssembledContext {
    const groups: ReadonlyArray<readonly [ContextEntrySource, readonly string[]]> = [
      ["systemInvariant", texts(input.systemInvariants, "system invariants")],
      ["signedGovernanceSpec", texts(input.signedGovernanceSpec, "Governance and Spec instructions")],
      ["appDeveloperInstructions", texts(input.appDeveloperInstructions, "app developer instructions")],
      ["repositoryInstructions", texts(input.repositoryInstructions, "repository instructions")],
      ["selectedSkill", texts(input.selectedSkills, "selected skills")],
      ["userInput", texts(input.userInputs, "user inputs")],
      ["toolResult", texts(input.toolResults, "tool results")]
    ];
    const entries = groups.flatMap(([source, values]) => values.map((text) => ({ source, text })));
    const instructionSources = groups
      .slice(0, 5)
      .filter(([, values]) => values.length > 0)
      .map(([source]) => source);
    return deepFreeze({ entries, instructionSources });
  }

  needsCompaction(inputTokens: number): boolean {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
      throw new TypeError("context token count must be a non-negative integer");
    }
    return inputTokens >= this.compactionThresholdTokens;
  }

  async compact(input: ContextCompactionInput): Promise<CompactedContext> {
    const preserved = deepFreeze({
      ...(input.previousSummary === undefined ? {} : { previousSummary: input.previousSummary }),
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      pendingApprovals: texts(input.pendingApprovals, "pending approvals"),
      plan: texts(input.plan, "plan"),
      ...(input.diff === undefined ? {} : { diff: input.diff }),
      artifactRefs: texts(input.artifactRefs, "artifact references"),
      entries: input.entries.map((entry) => ({ source: entry.source, text: entry.text }))
    });
    let summary: string;
    try {
      summary = await input.summarize(preserved);
    } catch (error: unknown) {
      throw new ContextCompactionError(error);
    }
    if (typeof summary !== "string" || summary.trim().length === 0) {
      throw new ContextCompactionError(new TypeError("context summary is empty"));
    }
    const { entries: _entries, ...retained } = preserved;
    return deepFreeze({ ...retained, summary });
  }
}
