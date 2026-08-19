// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition, type ToolRunContext } from "./define-tool.js";

export interface WorkspaceToolOptions {
  readonly allowedCommands?: readonly string[];
  readonly maxReadBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxSearchFiles?: number;
  readonly maxCommandSeconds?: number;
}

function workspace(context: ToolRunContext): string {
  if (!context.cwd) throw new Error("tool execution has no workspace binding");
  return resolve(context.cwd);
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function lexicalPath(root: string, input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0") || isAbsolute(input)) {
    throw new Error("workspace path must be a non-empty relative path");
  }
  const target = resolve(root, input);
  if (!inside(root, target)) throw new Error("workspace path is outside the workspace");
  return target;
}

async function boundExistingPath(root: string, input: unknown): Promise<string> {
  const target = lexicalPath(root, input);
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
  if (!inside(rootReal, targetReal)) throw new Error("workspace path is outside the workspace");
  const stats = await lstat(targetReal);
  if (stats.isSymbolicLink()) throw new Error("workspace path must not be a symbolic link");
  return targetReal;
}

async function boundWritePath(root: string, input: unknown): Promise<string> {
  const target = lexicalPath(root, input);
  await mkdir(dirname(target), { recursive: true });
  const [rootReal, parentReal] = await Promise.all([realpath(root), realpath(dirname(target))]);
  if (!inside(rootReal, parentReal)) throw new Error("workspace path is outside the workspace");
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("workspace write target must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

async function readBounded(path: string, limit: number): Promise<{ content: string; truncated: boolean }> {
  const bytes = await readFile(path);
  const truncated = bytes.byteLength > limit;
  return {
    content: bytes.subarray(0, limit).toString("utf8"),
    truncated
  };
}

async function walkFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0 && files.length < limit) {
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) files.push(path);
      if (files.length >= limit) break;
    }
  }
  return files;
}

async function runProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  outputLimit: number;
  signal?: AbortSignal;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; truncated: boolean }> {
  return new Promise((resolvePromise, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("command cancelled before start"));
      return;
    }
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.byteLength <= input.outputLimit) return combined;
      truncated = true;
      return combined.subarray(0, input.outputLimit);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    const abort = () => child.kill("SIGTERM");
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (input.signal?.aborted) {
        reject(new Error("command cancelled"));
        return;
      }
      if (timedOut) {
        reject(new Error("command timed out"));
        return;
      }
      resolvePromise({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        truncated
      });
    });
  });
}

export function createWorkspaceTools(options: WorkspaceToolOptions = {}): readonly ToolDefinition[] {
  const maxReadBytes = options.maxReadBytes ?? 1024 * 1024;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  const maxSearchFiles = options.maxSearchFiles ?? 500;
  const maxCommandSeconds = options.maxCommandSeconds ?? 300;
  const allowedCommands = new Set(options.allowedCommands ?? [
    "npm", "node", "npx", "tsc", "git", "go", "cargo", "pytest", "python"
  ]);

  return Object.freeze([
    defineTool({
      name: "read_file",
      description: "Read a UTF-8 file inside the bound candidate workspace.",
      risk: "read-only",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      },
      async execute(args, context) {
        const root = workspace(context);
        const path = await boundExistingPath(root, args.path);
        const stats = await lstat(path);
        if (!stats.isFile()) throw new Error("read target must be a regular file");
        return { path: String(args.path), ...await readBounded(path, maxReadBytes) };
      }
    }),
    defineTool({
      name: "list_files",
      description: "List regular files below a directory in the bound workspace.",
      risk: "read-only",
      parameters: {
        type: "object",
        properties: { path: { type: "string", default: "." } },
        additionalProperties: false
      },
      async execute(args, context) {
        const root = workspace(context);
        const path = await boundExistingPath(root, args.path ?? ".");
        const files = await walkFiles(path, maxSearchFiles);
        const canonicalRoot = await realpath(root);
        return {
          files: files.map((file) => relative(canonicalRoot, file)),
          truncated: files.length >= maxSearchFiles
        };
      }
    }),
    defineTool({
      name: "search_text",
      description: "Search UTF-8 workspace files for a literal text fragment.",
      risk: "read-only",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string", default: "." }
        },
        required: ["query"],
        additionalProperties: false
      },
      async execute(args, context) {
        const query = String(args.query);
        if (!query) throw new Error("search query must not be empty");
        const root = workspace(context);
        const base = await boundExistingPath(root, args.path ?? ".");
        const canonicalRoot = await realpath(root);
        const files = (await lstat(base)).isFile() ? [base] : await walkFiles(base, maxSearchFiles);
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const file of files) {
          const { content } = await readBounded(file, maxReadBytes);
          const lines = content.split(/\r?\n/u);
          for (let index = 0; index < lines.length; index += 1) {
            if (!lines[index]!.includes(query)) continue;
            matches.push({ path: relative(canonicalRoot, file), line: index + 1, text: lines[index]!.slice(0, 2000) });
            if (matches.length >= 200) return { matches, truncated: true };
          }
        }
        return { matches, truncated: files.length >= maxSearchFiles };
      }
    }),
    defineTool({
      name: "write_file",
      description: "Write a complete UTF-8 file inside the bound workspace.",
      risk: "side-effecting",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false
      },
      async execute(args, context) {
        const root = workspace(context);
        const target = await boundWritePath(root, args.path);
        const temporary = `${target}.muniu-${randomUUID()}.tmp`;
        await writeFile(temporary, String(args.content), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, target);
        return { path: String(args.path), bytes: Buffer.byteLength(String(args.content), "utf8") };
      }
    }),
    defineTool({
      name: "apply_patch",
      description: "Replace one exact text fragment in a UTF-8 workspace file.",
      risk: "side-effecting",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" }
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false
      },
      async execute(args, context) {
        const root = workspace(context);
        const target = await boundExistingPath(root, args.path);
        const content = await readFile(target, "utf8");
        const oldText = String(args.oldText);
        if (!oldText || !content.includes(oldText)) throw new Error("patch target text was not found");
        if (content.indexOf(oldText) !== content.lastIndexOf(oldText)) {
          throw new Error("patch target text is ambiguous");
        }
        const updated = content.replace(oldText, String(args.newText));
        const temporary = `${target}.muniu-${randomUUID()}.tmp`;
        await writeFile(temporary, updated, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, target);
        return { path: String(args.path), replacements: 1 };
      }
    }),
    defineTool({
      name: "run_command",
      description: "Run an allowlisted executable without a shell in the bound workspace.",
      risk: "side-effecting",
      parameters: {
        type: "object",
        properties: {
          executable: { type: "string" },
          args: { type: "array", items: { type: "string" }, default: [] },
          cwd: { type: "string", default: "." },
          timeoutSeconds: { type: "integer", default: 300 }
        },
        required: ["executable"],
        additionalProperties: false
      },
      async execute(args, context) {
        const executable = String(args.executable);
        if (!allowedCommands.has(executable)) throw new Error(`command ${executable} is not allowlisted`);
        const root = workspace(context);
        const cwd = await boundExistingPath(root, args.cwd ?? ".");
        if (!(await lstat(cwd)).isDirectory()) throw new Error("command cwd must be a directory");
        const commandArgs = args.args === undefined ? [] : args.args;
        if (!Array.isArray(commandArgs) || commandArgs.some((value) => typeof value !== "string")) {
          throw new Error("command args must be strings");
        }
        const timeoutSeconds = Math.min(
          maxCommandSeconds,
          Math.max(1, Number(args.timeoutSeconds ?? maxCommandSeconds))
        );
        return runProcess({
          executable,
          args: commandArgs,
          cwd,
          timeoutMs: timeoutSeconds * 1000,
          outputLimit: maxOutputBytes,
          ...(context.signal === undefined ? {} : { signal: context.signal })
        });
      }
    })
  ]);
}
