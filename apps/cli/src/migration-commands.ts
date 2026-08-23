// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  applyLocalAppServerV3Migration,
  inspectLocalAppServerV3Migration,
  rollbackLocalAppServerV3Migration
} from "@mn/agent-session";

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function validateArgs(args: readonly string[]): void {
  const allowedFlags = new Set(["--dry-run", "--apply", "--rollback"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--root") {
      index += 1;
      continue;
    }
    if (!allowedFlags.has(argument)) throw new Error(`Unknown migration option: ${argument}`);
  }
}

export async function migrationCommand(
  subcommand: string | undefined,
  args: readonly string[]
): Promise<void> {
  if (subcommand !== "app-server-v3") {
    throw new Error(`Unknown migration command: ${subcommand ?? ""}`);
  }
  validateArgs(args);
  const selected = ["--dry-run", "--apply", "--rollback"].filter((flag) => args.includes(flag));
  if (selected.length > 1) throw new Error("Select exactly one migration mode: --dry-run, --apply, or --rollback.");
  const defaultRoot = join(process.env.MN_MNIU_ROOT ?? join(homedir(), ".muniu"), "agent-service");
  const root = resolve(option(args, "--root") ?? defaultRoot);
  const result = selected[0] === "--apply"
    ? await applyLocalAppServerV3Migration({ root })
    : selected[0] === "--rollback"
      ? await rollbackLocalAppServerV3Migration({ root })
      : await inspectLocalAppServerV3Migration({ root });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
