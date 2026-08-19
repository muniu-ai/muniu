import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteText,
  backupFileIfExists,
  fileExists,
  readTextIfExists
} from "./fs.js";
import { managedEnvNames, scanEnvConflicts } from "./secrets.js";
import type { EnvConflict, ManagedEnvName } from "./types.js";

export type EnvCleanupSource = "shell_profile" | "launch_agent" | "ide_settings";

export interface ConfigDirectoryStatus {
  app: "claude" | "codex";
  configDir: string;
  exists: boolean;
  primaryConfigPath: string;
  primaryConfigExists: boolean;
}

export interface LocalDoctorResult {
  configDirectories: ConfigDirectoryStatus[];
  envConflicts: EnvConflict[];
}

export interface EnvCleanupRemovedLine {
  name: ManagedEnvName;
  maskedValue: string;
  source: EnvCleanupSource;
  sourcePath: string;
  line: number;
}

export interface EnvCleanupChangedFile {
  path: string;
  backupPath?: string;
  removed: EnvCleanupRemovedLine[];
}

export interface EnvCleanupManualAction {
  name: ManagedEnvName;
  maskedValue: string;
  source: "process.env";
  command: string;
  note: string;
}

export interface EnvCleanupResult {
  dryRun: boolean;
  scannedFiles: string[];
  changedFiles: EnvCleanupChangedFile[];
  removed: EnvCleanupRemovedLine[];
  manualActions: EnvCleanupManualAction[];
}

export interface EnvCleanupOptions {
  dryRun?: boolean;
  envNames?: ManagedEnvName[];
  sources?: EnvCleanupSource[];
  env?: NodeJS.ProcessEnv;
  mniuRoot?: string;
  now?: Date;
}

export async function inspectLocalConfig(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<LocalDoctorResult> {
  const claudeDir = join(homeDir, ".claude");
  const codexDir = join(homeDir, ".codex");
  const claudeConfig = join(claudeDir, "settings.json");
  const codexConfig = join(codexDir, "config.toml");
  const [
    shellProfileConflicts,
    launchAgentConflicts,
    ideSettingsConflicts
  ] = await Promise.all([
    scanShellProfileEnvConflicts(homeDir),
    scanLaunchAgentEnvConflicts(homeDir),
    scanIdeSettingsEnvConflicts(homeDir)
  ]);
  return {
    configDirectories: [
      {
        app: "claude",
        configDir: claudeDir,
        exists: await fileExists(claudeDir),
        primaryConfigPath: claudeConfig,
        primaryConfigExists: await fileExists(claudeConfig)
      },
      {
        app: "codex",
        configDir: codexDir,
        exists: await fileExists(codexDir),
        primaryConfigPath: codexConfig,
        primaryConfigExists: await fileExists(codexConfig)
      }
    ],
    envConflicts: [
      ...scanEnvConflicts(env),
      ...shellProfileConflicts,
      ...launchAgentConflicts,
      ...ideSettingsConflicts
    ]
  };
}

export async function cleanupShellEnvConflicts(
  homeDir: string,
  options: EnvCleanupOptions = {}
): Promise<EnvCleanupResult> {
  const dryRun = options.dryRun ?? true;
  const targetNames = new Set(options.envNames ?? managedEnvNames);
  const targetSources = new Set(options.sources ?? ["shell_profile"]);
  const backupRoot = options.mniuRoot ?? join(homeDir, ".muniu");
  const scannedFiles: string[] = [];
  const changedFiles: EnvCleanupChangedFile[] = [];

  if (targetSources.has("shell_profile")) {
    const shellPaths = await shellEnvProfilePaths(homeDir);
    scannedFiles.push(...shellPaths);
    for (const path of shellPaths) {
      const content = await readTextIfExists(path);
      if (content === undefined) continue;
      const result = removeShellEnvConflicts(content, path, targetNames);
      if (result.removed.length === 0) continue;
      changedFiles.push(
        await applyEnvCleanupChange(path, result.content, result.removed, dryRun, backupRoot, options)
      );
    }
  }

  if (targetSources.has("launch_agent")) {
    const launchAgentPaths = await listFiles(
      join(homeDir, "Library", "LaunchAgents"),
      (name) => name.endsWith(".plist")
    );
    scannedFiles.push(...launchAgentPaths);
    for (const path of launchAgentPaths) {
      const content = await readTextIfExists(path);
      if (content === undefined) continue;
      const result = removeLaunchAgentEnvConflicts(content, path, targetNames);
      if (result.removed.length === 0) continue;
      changedFiles.push(
        await applyEnvCleanupChange(path, result.content, result.removed, dryRun, backupRoot, options)
      );
    }
  }

  if (targetSources.has("ide_settings")) {
    const paths = ideSettingsPaths(homeDir);
    scannedFiles.push(...paths);
    for (const path of paths) {
      const content = await readTextIfExists(path);
      if (content === undefined) continue;
      const result = removeIdeSettingsEnvConflicts(content, path, targetNames);
      if (result.removed.length === 0) continue;
      changedFiles.push(
        await applyEnvCleanupChange(path, result.content, result.removed, dryRun, backupRoot, options)
      );
    }
  }

  return {
    dryRun,
    scannedFiles,
    changedFiles,
    removed: changedFiles.flatMap((file) => file.removed),
    manualActions: processEnvManualActions(options.env ?? {}, targetNames)
  };
}

export async function scanShellProfileEnvConflicts(
  homeDir: string
): Promise<EnvConflict[]> {
  const conflicts: EnvConflict[] = [];
  for (const path of await shellEnvProfilePaths(homeDir)) {
    const content = await readTextIfExists(path);
    if (content === undefined) continue;
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      const match = parseShellEnvLine(line, path, index + 1);
      if (match) {
        conflicts.push({ ...match, source: "shell_profile" });
      }
    });
  }
  return conflicts;
}

export async function scanLaunchAgentEnvConflicts(
  homeDir: string
): Promise<EnvConflict[]> {
  const conflicts: EnvConflict[] = [];
  const launchAgentDir = join(homeDir, "Library", "LaunchAgents");
  const paths = await listFiles(launchAgentDir, (name) => name.endsWith(".plist"));
  for (const path of paths) {
    const content = await readTextIfExists(path);
    if (content === undefined) continue;
    conflicts.push(...parseLaunchAgentEnvConflicts(content, path));
  }
  return conflicts;
}

export async function scanIdeSettingsEnvConflicts(
  homeDir: string
): Promise<EnvConflict[]> {
  const conflicts: EnvConflict[] = [];
  for (const path of ideSettingsPaths(homeDir)) {
    const content = await readTextIfExists(path);
    if (content === undefined) continue;
    conflicts.push(...parseIdeSettingsEnvConflicts(content, path));
  }
  return conflicts;
}

async function shellEnvProfilePaths(homeDir: string): Promise<string[]> {
  const fixedPaths = [
    ".zshrc",
    ".zprofile",
    ".bashrc",
    ".bash_profile",
    ".profile",
    ".cshrc",
    ".tcshrc",
    join(".config", "fish", "config.fish")
  ].map((path) => join(homeDir, path));

  const fishConfDir = join(homeDir, ".config", "fish", "conf.d");
  let fishConfPaths: string[] = [];
  try {
    const entries = await readdir(fishConfDir, { withFileTypes: true });
    fishConfPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".fish"))
      .map((entry) => join(fishConfDir, entry.name))
      .sort();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  return [...fixedPaths, ...fishConfPaths];
}

async function listFiles(
  directory: string,
  include: (name: string) => boolean
): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && include(entry.name))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    return [];
  }
}

function ideSettingsPaths(homeDir: string): string[] {
  const macUserSettingsRoots = [
    "Code",
    "Code - Insiders",
    "Cursor",
    "Windsurf",
    "VSCodium"
  ].map((name) => join(homeDir, "Library", "Application Support", name, "User"));
  const xdgUserSettingsRoots = [
    "Code",
    "Code - Insiders",
    "Cursor",
    "Windsurf",
    "VSCodium"
  ].map((name) => join(homeDir, ".config", name, "User"));

  return [...macUserSettingsRoots, ...xdgUserSettingsRoots].map((root) =>
    join(root, "settings.json")
  );
}

function parseLaunchAgentEnvConflicts(
  content: string,
  sourcePath: string
): EnvConflict[] {
  const conflicts: EnvConflict[] = [];
  const envDictMatch = content.match(
    /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/i
  );
  const envDict = envDictMatch?.[1];
  if (!envDict) return conflicts;
  const envDictOffset = envDictMatch.index ?? 0;

  for (const name of managedEnvNames) {
    const escapedName = escapeRegExp(name);
    const match = envDict.match(
      new RegExp(`<key>\\s*${escapedName}\\s*<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`, "i")
    );
    if (!match) continue;
    const keyIndex = content.indexOf(`<key>${name}</key>`, envDictOffset);
    conflicts.push({
      name,
      maskedValue: maskDetectedValue(unescapeXml(match[1] ?? "")),
      source: "launch_agent",
      sourcePath,
      line: lineNumberAt(content, keyIndex)
    });
  }
  return conflicts;
}

function parseIdeSettingsEnvConflicts(
  content: string,
  sourcePath: string
): EnvConflict[] {
  const settings = parseJsonObject(stripJsonComments(content));
  if (!settings) return [];

  const conflicts: EnvConflict[] = [];
  const envBlocks = [
    settings["terminal.integrated.env.osx"],
    settings["terminal.integrated.env.linux"],
    settings["terminal.integrated.env.windows"]
  ];

  for (const envBlock of envBlocks) {
    if (!isPlainRecord(envBlock)) continue;
    for (const name of managedEnvNames) {
      const value = envBlock[name];
      if (typeof value !== "string" || value.length === 0) continue;
      conflicts.push({
        name,
        maskedValue: maskDetectedValue(value),
        source: "ide_settings",
        sourcePath,
        line: findJsonKeyLine(content, name)
      });
    }
  }
  return conflicts;
}

function removeShellEnvConflicts(
  content: string,
  sourcePath: string,
  targetNames: Set<ManagedEnvName>
): { content: string; removed: EnvCleanupRemovedLine[] } {
  const lines = content.split("\n");
  const removed: EnvCleanupRemovedLine[] = [];
  const kept = lines.filter((line, index) => {
    const match = parseShellEnvLine(line, sourcePath, index + 1);
    if (!match || !targetNames.has(match.name)) return true;
    removed.push(match);
    return false;
  });
  return { content: kept.join("\n"), removed };
}

function processEnvManualActions(
  env: NodeJS.ProcessEnv,
  targetNames: Set<ManagedEnvName>
): EnvCleanupManualAction[] {
  return scanEnvConflicts(env)
    .filter((conflict) => targetNames.has(conflict.name))
    .map((conflict) => ({
      name: conflict.name,
      maskedValue: conflict.maskedValue,
      source: "process.env",
      command: `unset ${conflict.name}`,
      note: "Run this in the parent shell, then restart affected Claude/Codex terminals or IDE windows."
    }));
}

function removeLaunchAgentEnvConflicts(
  content: string,
  sourcePath: string,
  targetNames: Set<ManagedEnvName>
): { content: string; removed: EnvCleanupRemovedLine[] } {
  const envDictMatch = content.match(
    /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/i
  );
  const envDict = envDictMatch?.[1];
  if (!envDict) return { content, removed: [] };

  const envDictStart =
    (envDictMatch.index ?? 0) + envDictMatch[0].indexOf(envDict);
  const removed: EnvCleanupRemovedLine[] = [];
  const updatedDict = envDict.replace(
    /(\s*<key>\s*(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|OPENAI_API_KEY)\s*<\/key>\s*<string>([\s\S]*?)<\/string>)/gi,
    (full, _pair, name: ManagedEnvName, value: string, offset: number) => {
      if (!targetNames.has(name)) return full;
      removed.push({
        name,
        maskedValue: maskDetectedValue(unescapeXml(value ?? "")),
        source: "launch_agent",
        sourcePath,
        line: lineNumberAt(content, envDictStart + offset) ?? 1
      });
      return "";
    }
  );

  if (removed.length === 0) return { content, removed };
  return {
    content:
      content.slice(0, envDictStart) +
      updatedDict +
      content.slice(envDictStart + envDict.length),
    removed
  };
}

function removeIdeSettingsEnvConflicts(
  content: string,
  sourcePath: string,
  targetNames: Set<ManagedEnvName>
): { content: string; removed: EnvCleanupRemovedLine[] } {
  const settings = parseJsonObject(stripJsonComments(content));
  if (!settings) return { content, removed: [] };

  const removed: EnvCleanupRemovedLine[] = [];
  for (const key of [
    "terminal.integrated.env.osx",
    "terminal.integrated.env.linux",
    "terminal.integrated.env.windows"
  ]) {
    const envBlock = settings[key];
    if (!isPlainRecord(envBlock)) continue;
    for (const name of targetNames) {
      const value = envBlock[name];
      if (typeof value !== "string" || value.length === 0) continue;
      removed.push({
        name,
        maskedValue: maskDetectedValue(value),
        source: "ide_settings",
        sourcePath,
        line: findJsonKeyLine(content, name) ?? 1
      });
      delete envBlock[name];
    }
    if (Object.keys(envBlock).length === 0) delete settings[key];
  }

  return {
    content: removed.length ? `${JSON.stringify(settings, null, 2)}\n` : content,
    removed
  };
}

async function applyEnvCleanupChange(
  path: string,
  content: string,
  removed: EnvCleanupRemovedLine[],
  dryRun: boolean,
  backupRoot: string,
  options: EnvCleanupOptions
): Promise<EnvCleanupChangedFile> {
  let backupPath: string | undefined;
  if (!dryRun) {
    backupPath = await backupFileIfExists(
      path,
      join(backupRoot, "backups"),
      "env-profile-cleanup",
      options.now
    );
    await atomicWriteText(path, content);
  }
  return { path, backupPath, removed };
}

function stripJsonComments(content: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === "\"") {
        inString = false;
      }
      continue;
    }

    if (current === "\"") {
      inString = true;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      ) {
        if (content[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }

    output += current;
  }
  return output;
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseShellEnvLine(
  line: string,
  sourcePath: string,
  lineNumber: number
): EnvCleanupRemovedLine | undefined {
  if (/^\s*#/.test(line)) return undefined;
  const exportMatch = line.match(
    /^\s*export\s+(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|OPENAI_API_KEY)=(.*)$/
  );
  if (exportMatch) {
    return {
      name: exportMatch[1] as ManagedEnvName,
      maskedValue: maskShellValue(exportMatch[2] ?? ""),
      source: "shell_profile",
      sourcePath,
      line: lineNumber
    };
  }

  const shellAssignmentMatch = line.match(
    /^\s*(?:declare|typeset)\s+-[A-Za-z]*x[A-Za-z]*\s+(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|OPENAI_API_KEY)=(.*)$/
  );
  if (shellAssignmentMatch) {
    return {
      name: shellAssignmentMatch[1] as ManagedEnvName,
      maskedValue: maskShellValue(shellAssignmentMatch[2] ?? ""),
      source: "shell_profile",
      sourcePath,
      line: lineNumber
    };
  }

  const fishMatch = line.match(
    /^\s*set\s+-[A-Za-z]*x[A-Za-z]*\s+(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|OPENAI_API_KEY)\s+(.+)$/
  );
  if (fishMatch) {
    return {
      name: fishMatch[1] as ManagedEnvName,
      maskedValue: maskShellValue(fishMatch[2] ?? ""),
      source: "shell_profile",
      sourcePath,
      line: lineNumber
    };
  }

  const cshMatch = line.match(
    /^\s*setenv\s+(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|OPENAI_API_KEY)\s+(.+)$/
  );
  if (cshMatch) {
    return {
      name: cshMatch[1] as ManagedEnvName,
      maskedValue: maskShellValue(cshMatch[2] ?? ""),
      source: "shell_profile",
      sourcePath,
      line: lineNumber
    };
  }
  return undefined;
}

function maskShellValue(rawValue: string): string {
  const uncommented = rawValue.replace(/\s+#.*$/, "").trim();
  return maskDetectedValue(uncommented);
}

function maskDetectedValue(rawValue: string): string {
  const unquoted = rawValue.trim().replace(/^['"]|['"]$/g, "");
  if (unquoted.length <= 8) return "****";
  return `${unquoted.slice(0, 4)}...${unquoted.slice(-4)}`;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineNumberAt(content: string, index: number): number | undefined {
  if (index < 0) return undefined;
  return content.slice(0, index).split("\n").length;
}

function findJsonKeyLine(content: string, key: string): number | undefined {
  return lineNumberAt(content, content.indexOf(`"${key}"`));
}
