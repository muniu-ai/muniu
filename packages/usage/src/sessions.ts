import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { ManagedAgentApp } from "@mn/provider-catalog";
import { normalizeUsageFromJson, type TokenUsage } from "./usage.js";

export interface SessionIndexOptions {
  homeDir: string;
  apps?: ManagedAgentApp[];
  limit?: number;
  offset?: number;
  query?: string;
  redact?: boolean;
}

export interface SessionSummary {
  id: string;
  app: ManagedAgentApp;
  sourcePath: string;
  sourceRoot: string;
  title: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount: number;
  model?: string;
  providerId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  text?: string;
  timestamp?: string;
  model?: string;
  toolName?: string;
  usage?: TokenUsage;
  rawType?: string;
}

export interface SessionDetail extends SessionSummary {
  messages: SessionMessage[];
}

export interface SessionExportDocument {
  version: 1;
  kind: "mniu.session.export";
  exportedAt: string;
  redacted: boolean;
  session: SessionDetail;
}

interface SessionSource {
  app: ManagedAgentApp;
  sourceRoot: string;
  rootPath: string;
}

interface ParsedLine {
  message?: SessionMessage;
  sessionId?: string;
  cwd?: string;
  model?: string;
  providerId?: string;
  timestamp?: string;
}

interface ParsedSessionFile {
  summary: SessionSummary;
  messages?: SessionMessage[];
  searchText?: string;
}

interface SessionSummaryCacheEntry {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
  searchText?: string;
}

const sessionSummaryCache = new Map<string, SessionSummaryCacheEntry>();

export async function indexLocalSessions(
  options: SessionIndexOptions
): Promise<SessionSummary[]> {
  const summaries: SessionSummary[] = [];
  const queryTokens = queryTokensFrom(options.query);
  for (const source of sessionSources(options.homeDir, options.apps)) {
    for (const file of await listJsonlFiles(source.rootPath)) {
      const entry = await cachedSessionSummary(source, file, Boolean(queryTokens));
      if (!entry || !matchesQuery(entry.searchText, queryTokens)) continue;
      summaries.push(options.redact ? redactSessionSummary(entry.summary) : entry.summary);
    }
  }
  const limit = Math.max(0, options.limit ?? 100);
  const offset = Math.max(0, options.offset ?? 0);
  return summaries
    .sort(compareSessions)
    .slice(offset, offset + limit);
}

export async function readLocalSession(
  id: string,
  options: SessionIndexOptions
): Promise<SessionDetail | undefined> {
  for (const source of sessionSources(options.homeDir, options.apps)) {
    for (const file of await listJsonlFiles(source.rootPath)) {
      if (sessionId(source.app, file) === id) {
        const parsed = await parseSessionFile(source, file, true, false);
        if (!parsed) return undefined;
        const detail = {
          ...parsed.summary,
          messages: parsed.messages ?? []
        };
        return options.redact ? redactSessionDetail(detail) : detail;
      }
    }
  }
  return undefined;
}

export async function exportLocalSession(
  id: string,
  options: SessionIndexOptions
): Promise<SessionExportDocument | undefined> {
  const session = await readLocalSession(id, options);
  if (!session) return undefined;
  return {
    version: 1,
    kind: "mniu.session.export",
    exportedAt: new Date().toISOString(),
    redacted: Boolean(options.redact),
    session
  };
}

function sessionSources(
  homeDir: string,
  apps?: ManagedAgentApp[]
): SessionSource[] {
  const targets = apps ?? ["claude", "codex"];
  const sources: SessionSource[] = [];
  if (targets.includes("codex")) {
    sources.push(
      {
        app: "codex",
        sourceRoot: "codex_sessions",
        rootPath: join(homeDir, ".codex", "sessions")
      },
      {
        app: "codex",
        sourceRoot: "codex_archived_sessions",
        rootPath: join(homeDir, ".codex", "archived_sessions")
      }
    );
  }
  if (targets.includes("claude")) {
    sources.push(
      {
        app: "claude",
        sourceRoot: "claude_projects",
        rootPath: join(homeDir, ".claude", "projects")
      },
      {
        app: "claude",
        sourceRoot: "claude_sessions",
        rootPath: join(homeDir, ".claude", "sessions")
      }
    );
  }
  return sources;
}

async function cachedSessionSummary(
  source: SessionSource,
  sourcePath: string,
  collectSearchable: boolean
): Promise<SessionSummaryCacheEntry | undefined> {
  let fileInfo;
  try {
    fileInfo = await lstat(sourcePath);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  if (!fileInfo.isFile()) return undefined;
  const key = `${source.app}:${sourcePath}`;
  const cached = sessionSummaryCache.get(key);
  if (
    cached &&
    cached.mtimeMs === fileInfo.mtimeMs &&
    cached.size === fileInfo.size &&
    (!collectSearchable || cached.searchText !== undefined)
  ) {
    return cached;
  }
  const parsed = await parseSessionFile(source, sourcePath, false, collectSearchable);
  if (!parsed) {
    sessionSummaryCache.delete(key);
    return undefined;
  }
  const entry: SessionSummaryCacheEntry = {
    mtimeMs: fileInfo.mtimeMs,
    size: fileInfo.size,
    summary: parsed.summary,
    ...(parsed.searchText ? { searchText: parsed.searchText } : {})
  };
  sessionSummaryCache.set(key, entry);
  return entry;
}

async function parseSessionFile(
  source: SessionSource,
  sourcePath: string,
  includeMessages: boolean,
  collectSearchable: boolean
): Promise<ParsedSessionFile | undefined> {
  const messages: SessionMessage[] = [];
  const searchableParts = collectSearchable ? [source.sourceRoot, sourcePath] : [];
  const pushSearchable = (value: string | undefined): void => {
    if (collectSearchable && value) searchableParts.push(value);
  };
  let sessionTitle = "";
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let providerId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let messageCount = 0;

  try {
    const lines = createInterface({
      input: createReadStream(sourcePath, { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = parseSessionLine(parsedJson);
      cwd = parsed.cwd ?? cwd;
      model = parsed.model ?? model;
      providerId = parsed.providerId ?? providerId;
      pushSearchable(parsed.cwd);
      pushSearchable(parsed.model);
      pushSearchable(parsed.providerId);
      const timestamp = parsed.message?.timestamp ?? parsed.timestamp;
      if (timestamp) {
        createdAt = earlierIso(createdAt, timestamp);
        updatedAt = laterIso(updatedAt, timestamp);
        pushSearchable(timestamp);
      }
      if (!parsed.message) continue;
      pushSearchable(parsed.message.text);
      pushSearchable(parsed.message.rawType);
      pushSearchable(parsed.message.toolName);
      messageCount += 1;
      const usage = parsed.message.usage;
      if (usage) {
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        totalTokens += usage.totalTokens;
      }
      if (!sessionTitle && parsed.message.role === "user" && parsed.message.text) {
        sessionTitle = compactText(parsed.message.text, 80);
      }
      if (includeMessages) messages.push(parsed.message);
    }
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  const summary: SessionSummary = {
    id: sessionId(source.app, sourcePath),
    app: source.app,
    sourcePath,
    sourceRoot: source.sourceRoot,
    title: sessionTitle || basename(sourcePath, ".jsonl"),
    ...(cwd ? { cwd } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    messageCount,
    ...(model ? { model } : {}),
    ...(providerId ? { providerId } : {}),
    inputTokens,
    outputTokens,
    totalTokens
  };

  pushSearchable(summary.title);
  return {
    summary,
    ...(includeMessages ? { messages } : {}),
    ...(collectSearchable ? { searchText: searchableParts.join("\n").toLowerCase() } : {})
  };
}

function parseSessionLine(value: unknown): ParsedLine {
  const event = isRecord(value) ? value : {};
  const payload = firstRecord(event.payload);
  const message = firstRecord(event.message, payload?.message, payload);
  const response = firstRecord(event.response, payload?.response);
  const payloadContent = message === payload ? undefined : payload?.content;
  const rawType = readString(payload?.type) ?? readString(event.type);
  const explicitRole = readRole(event.role) ?? readRole(message?.role);
  const role = explicitRole ?? roleFromType(rawType);
  const usage = normalizeUsageFromJson(
    firstRecord(
      event.usage,
      message?.usage,
      payload?.usage,
      response?.usage,
      payload?.response
    ) ?? {}
  );
  const usageOrUndefined = usage.totalTokens > 0 ? usage : undefined;
  const text = extractText(
    event.text,
    event.content,
    message?.content,
    payloadContent,
    textPayloadMessage(rawType, payload?.message),
    response?.output_text,
    response?.output,
    payload?.text,
    payload?.delta,
    payload?.item,
    payload?.stdout,
    payload?.stderr
  );
  const timestamp =
    readString(event.timestamp) ??
    readString(event.created_at) ??
    readString(event.time) ??
    readString(payload?.timestamp) ??
    readString(message?.timestamp);
  const model =
    readString(event.model) ??
    readString(message?.model) ??
    readString(payload?.model) ??
    readString(response?.model);
  return {
    sessionId:
      readString(event.session_id) ??
      readString(event.conversation_id) ??
      readString(event.thread_id) ??
      readString(payload?.session_id),
    cwd:
      readString(event.cwd) ??
      readString(event.working_directory) ??
      readString(payload?.cwd) ??
      readString(payload?.working_directory),
    model,
    providerId:
      readString(event.provider_id) ??
      readString(event.providerId) ??
      readString(payload?.provider_id) ??
      readString(payload?.providerId),
    timestamp,
    message: explicitRole || text || usageOrUndefined
      ? {
          role: role ?? "unknown",
          ...(text ? { text } : {}),
          ...(timestamp ? { timestamp } : {}),
          ...(model ? { model } : {}),
          ...(readString(event.tool_name) ?? readString(payload?.tool_name)
            ? { toolName: readString(event.tool_name) ?? readString(payload?.tool_name) }
            : {}),
          ...(usageOrUndefined ? { usage: usageOrUndefined } : {}),
          ...(rawType ? { rawType } : {})
        }
      : undefined
  };
}

function redactSessionSummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    sourcePath: redactPath(summary.sourcePath),
    title: redactSensitiveText(summary.title),
    ...(summary.cwd ? { cwd: redactPath(summary.cwd) } : {})
  };
}

function redactSessionDetail(detail: SessionDetail): SessionDetail {
  return {
    ...redactSessionSummary(detail),
    messages: detail.messages.map(redactSessionMessage)
  };
}

function redactSessionMessage(message: SessionMessage): SessionMessage {
  return {
    ...message,
    ...(message.text ? { text: redactSensitiveText(message.text) } : {})
  };
}

function redactSensitiveText(value: string): string {
  return redactPath(value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1****")
    .replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1****")
    .replace(
      /\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*\s*[:=]\s*["']?)[^\s"',;]+/gi,
      "$1****"
    );
}

function redactPath(value: string): string {
  return value
    .replace(/\/Users\/[^/\s]+/g, "/Users/<user>")
    .replace(/\/home\/[^/\s]+/g, "/home/<user>");
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) return [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  await collectJsonlFiles(root, files);
  return files.sort();
}

async function collectJsonlFiles(root: string, files: string[]): Promise<void> {
  const dir = await opendir(root);
  for await (const entry of dir) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(path, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
}

function sessionId(app: ManagedAgentApp, sourcePath: string): string {
  const hash = createHash("sha256").update(sourcePath).digest("hex").slice(0, 16);
  return `${app}:${hash}`;
}

function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const updated = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  if (updated !== 0) return updated;
  return a.sourcePath.localeCompare(b.sourcePath);
}

function earlierIso(current: string | undefined, next: string): string {
  if (!current) return next;
  return Date.parse(next) < Date.parse(current) ? next : current;
}

function laterIso(current: string | undefined, next: string): string {
  if (!current) return next;
  return Date.parse(next) > Date.parse(current) ? next : current;
}

function readRole(value: unknown): SessionMessage["role"] | undefined {
  if (value === "user" || value === "assistant" || value === "system" || value === "tool") {
    return value;
  }
  return undefined;
}

function roleFromType(value: string | undefined): SessionMessage["role"] | undefined {
  if (!value) return undefined;
  if (value.includes("user")) return "user";
  if (value.includes("assistant") || value.includes("agent") || value.includes("response")) {
    return "assistant";
  }
  if (value.includes("system")) return "system";
  if (value.includes("tool") || value.includes("function")) return "tool";
  return undefined;
}

function textPayloadMessage(
  rawType: string | undefined,
  value: unknown
): string | undefined {
  if (!rawType) return undefined;
  if (
    rawType.includes("user") ||
    rawType.includes("assistant") ||
    rawType.includes("agent") ||
    rawType === "message"
  ) {
    return readString(value);
  }
  return undefined;
}

function extractText(...values: unknown[]): string | undefined {
  const fragments = values.flatMap((value) => textFragments(value));
  const text = fragments.join("\n").trim();
  return text || undefined;
}

function textFragments(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => textFragments(item));
  if (!isRecord(value)) return [];
  const directText =
    readString(value.text) ??
    readString(value.output_text) ??
    readString(value.input_text) ??
    readString(value.content);
  if (directText) return [directText];
  return textFragments(value.content)
    .concat(textFragments(value.message))
    .concat(textFragments(value.delta))
    .concat(textFragments(value.output));
}

function compactText(value: string, maxLength: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength - 1)}…`;
}

function queryTokensFrom(value: string | undefined): string[] | undefined {
  const tokens = value?.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tokens && tokens.length > 0 ? tokens : undefined;
}

function matchesQuery(searchText: string | undefined, queryTokens: string[] | undefined): boolean {
  if (!queryTokens) return true;
  if (!searchText) return false;
  return queryTokens.every((token) => searchText.includes(token));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
