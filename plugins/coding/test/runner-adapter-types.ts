import type { ClaudeCliRunner } from "../../runner-claude-cli/src/index.ts";
import type { CodexCliRunner } from "../../runner-codex-cli/src/index.ts";
import type { CodingRunnerAdapter } from "../src/index.ts";

declare const claude: ClaudeCliRunner;
declare const codex: CodexCliRunner;

const compatibleAdapters: readonly CodingRunnerAdapter[] = [claude, codex];
void compatibleAdapters;
