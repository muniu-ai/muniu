// SPDX-License-Identifier: Apache-2.0

import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  EnterpriseBuiltinJsonValue,
  EnterpriseBuiltinToolCallV1,
  EnterpriseBuiltinToolResultV1
} from "@mn/core";

import type { DockerAgentSandbox } from "./dockerSandboxAgentExecutor.js";

export interface EnterpriseBuiltinWorkspaceToolExecutionOptions {
  readonly backend: DockerAgentSandbox;
  readonly leaseId: string;
  readonly hostWorkspacePath: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly call: EnterpriseBuiltinToolCallV1;
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal;
}

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const MAX_COMMAND_SECONDS = 300;

/** Executes one model-requested operation through the already inspected
 * candidate runtime. The worker has no model credential and the API has no
 * host workspace path. */
export async function executeEnterpriseBuiltinWorkspaceTool(
  options: EnterpriseBuiltinWorkspaceToolExecutionOptions
): Promise<EnterpriseBuiltinToolResultV1> {
  validateCallBinding(options);
  try {
    const result = options.call.name === "run_command"
      ? await runCommand(options)
      : await runFileTool(options);
    return Object.freeze({
      schemaVersion: 1,
      callId: options.call.callId,
      ok: true,
      result
    });
  } catch {
    return Object.freeze({
      schemaVersion: 1,
      callId: options.call.callId,
      ok: false,
      error: "sandbox workspace tool execution failed"
    });
  }
}

function validateCallBinding(options: EnterpriseBuiltinWorkspaceToolExecutionOptions): void {
  if (
    options.call.executionId !== options.executionId ||
    options.call.sessionId !== options.sessionId
  ) {
    throw new Error("enterprise builtin tool call execution binding changed");
  }
  const containerWorkspace = options.backend.containerPath(
    options.leaseId,
    options.hostWorkspacePath
  );
  if (options.call.workspacePath !== containerWorkspace) {
    throw new Error("enterprise builtin tool call workspace binding changed");
  }
  if (!Number.isSafeInteger(options.timeoutSeconds) || options.timeoutSeconds < 1) {
    throw new TypeError("enterprise builtin tool timeout is invalid");
  }
}

async function runFileTool(
  options: EnterpriseBuiltinWorkspaceToolExecutionOptions
): Promise<EnterpriseBuiltinJsonValue> {
  const execution = await options.backend.execute(options.leaseId, {
    executable: "node",
    args: ["-e", FILE_TOOL_RUNTIME],
    cwd: options.hostWorkspacePath,
    timeoutSeconds: Math.min(60, options.timeoutSeconds),
    stdin: JSON.stringify({ name: options.call.name, args: options.call.args }),
    ...(options.signal ? { signal: options.signal } : {})
  });
  if (execution.exitCode !== 0 || Buffer.byteLength(execution.stdout, "utf8") > MAX_RESULT_BYTES) {
    throw new Error("sandbox file tool returned invalid output");
  }
  let value: unknown;
  try {
    value = JSON.parse(execution.stdout) as unknown;
  } catch {
    throw new Error("sandbox file tool returned invalid JSON");
  }
  assertJsonValue(value, "$result");
  return value;
}

async function runCommand(
  options: EnterpriseBuiltinWorkspaceToolExecutionOptions
): Promise<EnterpriseBuiltinJsonValue> {
  const args = exactObject(options.call.args, ["executable"], ["args", "cwd", "timeoutSeconds"]);
  const executable = stringValue(args.executable, "executable", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(executable)) {
    throw new TypeError("command executable must be a bare runtime tool name");
  }
  const commandArgs = args.args === undefined ? [] : args.args;
  if (
    !Array.isArray(commandArgs) ||
    commandArgs.length > 256 ||
    commandArgs.some((value) => typeof value !== "string" || value.length > 32_768 || value.includes("\0"))
  ) {
    throw new TypeError("command args are invalid");
  }
  const cwdInput = args.cwd === undefined ? "." : stringValue(args.cwd, "cwd", 4_096);
  const cwd = await existingWorkspaceDirectory(options.hostWorkspacePath, cwdInput);
  const requestedTimeout = args.timeoutSeconds === undefined
    ? MAX_COMMAND_SECONDS
    : numberValue(args.timeoutSeconds, "timeoutSeconds");
  const timeoutSeconds = Math.max(
    1,
    Math.min(MAX_COMMAND_SECONDS, options.timeoutSeconds, requestedTimeout)
  );
  const execution = await options.backend.execute(options.leaseId, {
    executable,
    args: commandArgs,
    cwd,
    timeoutSeconds,
    ...(options.signal ? { signal: options.signal } : {})
  });
  const stdout = boundedText(execution.stdout, MAX_COMMAND_OUTPUT_BYTES);
  const stderr = boundedText(
    execution.stderr,
    Math.max(0, MAX_COMMAND_OUTPUT_BYTES - Buffer.byteLength(stdout.value, "utf8"))
  );
  return {
    exitCode: execution.exitCode,
    stdout: stdout.value,
    stderr: stderr.value,
    truncated: stdout.truncated || stderr.truncated
  };
}

async function existingWorkspaceDirectory(rootInput: string, childInput: string): Promise<string> {
  if (!childInput || childInput.includes("\0") || isAbsolute(childInput)) {
    throw new TypeError("command cwd must be a relative workspace path");
  }
  const root = await realpath(rootInput);
  const lexical = resolve(root, childInput);
  if (!inside(root, lexical)) throw new TypeError("command cwd escaped the workspace");
  const target = await realpath(lexical);
  if (!inside(root, target) || !(await lstat(target)).isDirectory()) {
    throw new TypeError("command cwd is not a workspace directory");
  }
  return target;
}

function inside(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tool arguments must be an object");
  }
  const result = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some((key) => !allowed.has(key))
  ) {
    throw new TypeError("tool arguments do not match the schema");
  }
  return result;
}

function stringValue(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value || value.length > maxLength || value.includes("\0")) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function numberValue(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as number;
}

function boundedText(value: string, limit: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limit) return { value, truncated: false };
  return { value: bytes.subarray(0, limit).toString("utf8"), truncated: true };
}

function assertJsonValue(value: unknown, path: string, depth = 0): asserts value is EnterpriseBuiltinJsonValue {
  if (depth > 64) throw new TypeError(`${path} exceeds JSON nesting limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertJsonValue(item, `${path}[${index}]`, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new TypeError(`${path} contains an unsafe key`);
      }
      assertJsonValue(item, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new TypeError(`${path} is not JSON`);
}

const FILE_TOOL_RUNTIME = String.raw`
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX_READ = 128 * 1024;
const MAX_WRITE = 1024 * 1024;
const MAX_FILES = 500;
const MAX_MATCHES = 200;

function exact(value, required, optional) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("arguments must be an object");
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("arguments do not match schema");
  }
  return value;
}
function string(value, field, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.includes("\0")) throw new Error(field + " is invalid");
  return value;
}
function inside(root, target) {
  const suffix = path.relative(root, target);
  return suffix === "" || (!path.isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + path.sep));
}
function lexical(root, input) {
  const child = string(input, "path");
  if (path.isAbsolute(child)) throw new Error("path must be relative");
  const target = path.resolve(root, child);
  if (!inside(root, target)) throw new Error("path escaped workspace");
  return target;
}
async function existing(root, input) {
  const target = lexical(root, input);
  const canonical = await fs.realpath(target);
  if (!inside(root, canonical)) throw new Error("path escaped workspace");
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error("symbolic links are not allowed");
  }
  return canonical;
}
async function writeTarget(root, input) {
  const target = lexical(root, input);
  const segments = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      const stats = await fs.lstat(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("write parent is unsafe");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(cursor, { mode: 0o755 });
      await fs.chmod(cursor, 0o755);
    }
  }
  const parent = await fs.realpath(path.dirname(target));
  if (!inside(root, parent)) throw new Error("write parent escaped workspace");
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("write target is unsafe");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return target;
}
async function readBounded(file) {
  const handle = await fs.open(file, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("read target is not a file");
    const length = Math.min(stats.size, MAX_READ);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, 0);
    return { content: bytes.toString("utf8"), truncated: stats.size > MAX_READ };
  } finally { await handle.close(); }
}
async function walk(root) {
  const files = [];
  const queue = [root];
  while (queue.length && files.length < MAX_FILES) {
    const directory = queue.shift();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(item);
      else if (entry.isFile()) files.push(item);
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}
async function atomicWrite(target, content) {
  const temporary = target + ".muniu-" + crypto.randomUUID() + ".tmp";
  let mode = 0o644;
  try {
    const existing = await fs.lstat(target).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.mode & 0o111) mode = 0o755;
    await fs.writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, target);
    await fs.chmod(target, mode);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > 2 * MAX_WRITE) throw new Error("request is too large");
  }
  const request = JSON.parse(raw);
  const name = string(request.name, "name");
  const args = request.args;
  const root = await fs.realpath(process.cwd());
  if (name === "read_file") {
    const value = exact(args, ["path"], []);
    const file = await existing(root, value.path);
    return { path: value.path, ...(await readBounded(file)) };
  }
  if (name === "list_files") {
    const value = exact(args, [], ["path"]);
    const base = await existing(root, value.path === undefined ? "." : value.path);
    if (!(await fs.lstat(base)).isDirectory()) throw new Error("list path is not a directory");
    const files = await walk(base);
    return { files: files.map((file) => path.relative(root, file)), truncated: files.length >= MAX_FILES };
  }
  if (name === "search_text") {
    const value = exact(args, ["query"], ["path"]);
    const query = string(value.query, "query");
    const base = await existing(root, value.path === undefined ? "." : value.path);
    const files = (await fs.lstat(base)).isFile() ? [base] : await walk(base);
    const matches = [];
    for (const file of files) {
      const content = (await readBounded(file)).content;
      const lines = content.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) continue;
        matches.push({ path: path.relative(root, file), line: index + 1, text: lines[index].slice(0, 512) });
        if (matches.length >= MAX_MATCHES) return { matches, truncated: true };
      }
    }
    return { matches, truncated: files.length >= MAX_FILES };
  }
  if (name === "write_file") {
    const value = exact(args, ["path", "content"], []);
    const content = string(value.content, "content", true);
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE) throw new Error("content is too large");
    const target = await writeTarget(root, value.path);
    await atomicWrite(target, content);
    return { path: value.path, bytes: Buffer.byteLength(content, "utf8") };
  }
  if (name === "apply_patch") {
    const value = exact(args, ["path", "oldText", "newText"], []);
    const oldText = string(value.oldText, "oldText");
    const newText = string(value.newText, "newText", true);
    const target = await existing(root, value.path);
    const current = await fs.readFile(target, "utf8");
    if (Buffer.byteLength(current, "utf8") > 4 * MAX_READ) throw new Error("patch target is too large");
    if (!current.includes(oldText) || current.indexOf(oldText) !== current.lastIndexOf(oldText)) throw new Error("patch target is missing or ambiguous");
    const updated = current.replace(oldText, newText);
    if (Buffer.byteLength(updated, "utf8") > 4 * MAX_READ) throw new Error("patch result is too large");
    await atomicWrite(target, updated);
    return { path: value.path, replacements: 1 };
  }
  throw new Error("unsupported file tool");
}
main().then((value) => process.stdout.write(JSON.stringify(value))).catch(() => process.exit(1));
`;
