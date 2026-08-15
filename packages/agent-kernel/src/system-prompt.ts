/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/core/system-prompt/src/index.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: retained deterministic section joining and variable rendering;
 * removed Cordis services, plugin extension points, and runtime discovery.
 */

export interface SystemPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

const VARIABLE_PATTERN = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu;

export class StaticSystemPrompt {
  private readonly sections: readonly SystemPromptSection[];
  private readonly variables: Readonly<Record<string, string>>;

  constructor(sections: readonly SystemPromptSection[], variables: Readonly<Record<string, string>> = {}) {
    const names = new Set<string>();
    for (const section of sections) {
      if (section.name.length === 0) throw new Error("prompt section name must not be empty");
      if (!Number.isFinite(section.order)) throw new Error("prompt section order must be finite");
      if (names.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered`);
      names.add(section.name);
    }
    this.sections = sections
      .map((section, index) => ({ section: { ...section }, index }))
      .sort((left, right) => left.section.order - right.section.order || left.index - right.index)
      .map(({ section }) => Object.freeze(section));
    this.variables = Object.freeze({ ...variables });
  }

  render(overrides: Readonly<Record<string, string>> = {}): string {
    const variables = { ...this.variables, ...overrides };
    return this.sections
      .map(({ text }) => text.replace(VARIABLE_PATTERN, (_match, name: string) => {
        const value = variables[name];
        if (value === undefined) throw new Error(`unknown prompt variable "${name}"`);
        return value;
      }).trim())
      .filter((text) => text.length > 0)
      .join("\n\n");
  }
}
