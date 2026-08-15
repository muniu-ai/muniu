import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderInputFromPreset } from "@mn/provider-catalog";
import type { ProviderRecord } from "@mn/provider-catalog";
import {
  inspectLocalConfig,
  cleanupShellEnvConflicts,
  parseToml,
  projectCodexProxyConfig,
  projectClaudeProvider,
  projectCodexProvider,
  stringifyToml,
  restoreLiveConfigProjection
} from "../src/index.js";

test("Claude projection writes settings with backup in temporary HOME", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-claude-home-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });
  await mkdir(join(homeDir, ".claude"), { recursive: true });
  await writeFile(
    join(homeDir, ".claude", "settings.json"),
    `${JSON.stringify({ env: { EXISTING: "1" } }, null, 2)}\n`
  );

  const provider = providerRecord("claude-1", "claude-official", {
    apiKeyRef: { type: "env", ref: "ANTHROPIC_API_KEY" }
  });
  const result = await projectClaudeProvider(provider, {
    homeDir,
    env: { ANTHROPIC_API_KEY: "sk-ant-test" }
  });
  const settings = JSON.parse(
    await readFile(join(homeDir, ".claude", "settings.json"), "utf8")
  );

  assert.equal(result.changed, true);
  assert.ok(result.backupPath);
  assert.equal(settings.env.EXISTING, "1");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(settings.env.ANTHROPIC_API_KEY, "sk-ant-test");
  assert.equal(settings.skipIntroduction, true);
});

test("Codex projection preserves auth.json by default", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-codex-home-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });
  await mkdir(join(homeDir, ".codex"), { recursive: true });
  await writeFile(join(homeDir, ".codex", "auth.json"), "{\"token\":\"official\"}\n");

  const provider = providerRecord("codex-1", "deepseek", {
    apiKeyRef: { type: "env", ref: "OPENAI_API_KEY" }
  });
  const result = await projectCodexProvider(provider, {
    homeDir,
    env: { OPENAI_API_KEY: "sk-deepseek-test" }
  });
  const config = await readFile(join(homeDir, ".codex", "config.toml"), "utf8");
  const auth = await readFile(join(homeDir, ".codex", "auth.json"), "utf8");

  assert.equal(result.changed, true);
  assert.match(config, /model_provider = "codex_1"/);
  assert.match(config, /wire_api = "chat"/);
  assert.match(config, /experimental_bearer_token = "sk-deepseek-test"/);
  assert.equal(auth, "{\"token\":\"official\"}\n");
});

test("TOML helper preserves simple arrays for Codex MCP config", () => {
  const parsed = parseToml(
    [
      "[mcp_servers.weather]",
      "command = \"node\"",
      "args = [\"server.js\", \"--flag,with-comma\"]",
      "",
      "[mcp_servers.weather.env]",
      "WEATHER_TOKEN = \"test\""
    ].join("\n")
  );
  const serverTable = parsed.tables["mcp_servers.weather"];
  const envTable = parsed.tables["mcp_servers.weather.env"];
  assert.ok(serverTable);
  assert.ok(envTable);

  assert.deepEqual(serverTable.args, [
    "server.js",
    "--flag,with-comma"
  ]);
  assert.equal(envTable.WEATHER_TOKEN, "test");
  assert.match(
    stringifyToml(parsed),
    /args = \[\s*"server\.js", "--flag,with-comma"\s*\]/
  );
});

test("TOML helper safely round-trips complex valid TOML", () => {
  const input = [
    "# keep this user comment",
    "# duplicate comment",
    "# duplicate comment",
    "title = \"TOML Example\" # keep inline context",
    "description = \"\"\"",
    "A multiline value with # text that is not a comment.",
    "\"\"\"",
    "",
    "[\"quoted.table\"]",
    "\"quoted.key\" = \"kept\"",
    "",
    "[[products]]",
    "name = \"Hammer\"",
    "sku = 738594937",
    "",
    "[[products]]",
    "name = \"Nail\"",
    "colors = [\"gray\", \"black\"]",
    "",
    "[model_providers.custom]",
    "base_url = \"https://old.example\""
  ].join("\n");

  const parsed = parseToml(input);
  parsed.tables["model_providers.custom"] = {
    ...parsed.tables["model_providers.custom"],
    base_url: "https://new.example",
    wire_api: "responses"
  };
  const output = stringifyToml(parsed);
  const reparsed = parseToml(output);

  assert.equal(
    output,
    `${input.replace('base_url = "https://old.example"', 'base_url = "https://new.example"')}\nwire_api = "responses"\n`
  );
  assert.equal(reparsed.values.description, "A multiline value with # text that is not a comment.\n");
  assert.equal(
    (reparsed.sourceData["quoted.table"] as Record<string, unknown>)["quoted.key"],
    "kept"
  );
  assert.deepEqual(
    (reparsed.sourceData.products as Array<Record<string, unknown>>).map((item) => item.name),
    ["Hammer", "Nail"]
  );
  assert.equal(reparsed.tables["model_providers.custom"]?.base_url, "https://new.example");
  assert.equal(reparsed.tables["model_providers.custom"]?.wire_api, "responses");
});

test("TOML helper updates dotted keys without defining a duplicate table", () => {
  const input = [
    "# dotted provider stays dotted",
    'model_providers.custom.base_url = "https://old.example"',
    'model_providers.custom.wire_api = "chat"'
  ].join("\n");
  const parsed = parseToml(input);
  parsed.tables["model_providers.custom"] = {
    ...parsed.tables["model_providers.custom"],
    base_url: "https://new.example",
    model_catalog_json: '{"models":[]}'
  };
  const output = stringifyToml(parsed);
  assert.match(output, /model_providers\.custom\.base_url = "https:\/\/new\.example"/);
  assert.match(output, /model_providers\.custom\.model_catalog_json =/);
  assert.doesNotMatch(output, /\[model_providers\.custom\]/);
  assert.equal(
    parseToml(output).tables["model_providers.custom"]?.base_url,
    "https://new.example"
  );
});

test("TOML helper updates inline provider tables without duplicate definitions", () => {
  const input =
    'model_providers = { custom = { base_url = "https://old.example", wire_api = "chat" } }\n';
  const parsed = parseToml(input);
  parsed.tables["model_providers.custom"] = {
    ...parsed.tables["model_providers.custom"],
    base_url: "https://new.example",
    name: "Custom"
  };
  const output = stringifyToml(parsed);
  assert.equal((output.match(/model_providers\s*=/g) ?? []).length, 1);
  assert.doesNotMatch(output, /\[model_providers\.custom\]/);
  const reparsed = parseToml(output);
  assert.equal(reparsed.tables["model_providers.custom"]?.base_url, "https://new.example");
  assert.equal(reparsed.tables["model_providers.custom"]?.name, "Custom");
});

test("doctor reports env conflicts with masked values", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-doctor-home-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });
  const result = await inspectLocalConfig(homeDir, {
    OPENAI_API_KEY: "sk-openai-test-value"
  });

  assert.equal(result.configDirectories.length, 2);
  assert.deepEqual(result.envConflicts, [
    {
      name: "OPENAI_API_KEY",
      maskedValue: "sk-o...alue",
      source: "process.env"
    }
  ]);
});

test("doctor plans and cleans shell profile env conflicts with backup", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-doctor-cleanup-home-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });
  await writeFile(
    join(homeDir, ".zshrc"),
    [
      "export OPENAI_API_KEY=\"sk-file-openai-value\"",
      "# export ANTHROPIC_API_KEY=ignored",
      "export ANTHROPIC_BASE_URL=https://anthropic.example",
      "echo keep"
    ].join("\n") + "\n"
  );

  const report = await inspectLocalConfig(homeDir, {
    OPENAI_API_KEY: "sk-process-openai-value"
  });
  assert.equal(
    report.envConflicts.some(
      (conflict) =>
        conflict.name === "OPENAI_API_KEY" &&
        conflict.source === "process.env"
    ),
    true
  );
  assert.equal(
    report.envConflicts.some(
      (conflict) =>
        conflict.name === "OPENAI_API_KEY" &&
        conflict.source === "shell_profile" &&
        conflict.line === 1
    ),
    true
  );

  const dryRun = await cleanupShellEnvConflicts(homeDir, {
    dryRun: true,
    envNames: ["OPENAI_API_KEY"],
    env: {
      OPENAI_API_KEY: "sk-process-openai-value"
    }
  });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.removed.length, 1);
  assert.equal(dryRun.manualActions.length, 1);
  assert.equal(dryRun.manualActions[0]?.command, "unset OPENAI_API_KEY");
  assert.equal(dryRun.changedFiles[0]?.backupPath, undefined);
  assert.match(await readFile(join(homeDir, ".zshrc"), "utf8"), /OPENAI_API_KEY/);

  const confirmed = await cleanupShellEnvConflicts(homeDir, {
    dryRun: false,
    envNames: ["OPENAI_API_KEY"],
    mniuRoot: join(homeDir, ".mniu"),
    now: new Date("2026-01-02T03:04:05.000Z")
  });
  assert.equal(confirmed.dryRun, false);
  assert.equal(confirmed.removed.length, 1);
  assert.ok(confirmed.changedFiles[0]?.backupPath);
  const cleaned = await readFile(join(homeDir, ".zshrc"), "utf8");
  assert.doesNotMatch(cleaned, /OPENAI_API_KEY/);
  assert.match(cleaned, /ANTHROPIC_BASE_URL/);
  assert.match(cleaned, /echo keep/);
  assert.match(
    await readFile(confirmed.changedFiles[0]?.backupPath ?? "", "utf8"),
    /OPENAI_API_KEY/
  );
});

test("doctor cleans complex shell profile env conflict forms", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-doctor-complex-shell-home-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });
  await mkdir(join(homeDir, ".config", "fish", "conf.d"), { recursive: true });
  await writeFile(
    join(homeDir, ".zprofile"),
    [
      "typeset -gx OPENAI_API_KEY=sk-zsh-openai-value",
      "typeset -gx KEEP_THIS=value"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, ".bash_profile"),
    [
      "declare -x ANTHROPIC_API_KEY=\"sk-bash-anthropic-value\"",
      "echo keep-bash"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, ".config", "fish", "conf.d", "mniu.fish"),
    [
      "set -Ux ANTHROPIC_BASE_URL https://fish.example",
      "set -Ux KEEP_THIS value"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, ".tcshrc"),
    [
      "setenv OPENAI_API_KEY sk-tcsh-openai-value",
      "setenv KEEP_THIS value"
    ].join("\n") + "\n"
  );

  const report = await inspectLocalConfig(homeDir, {});
  const shellConflicts = report.envConflicts.filter(
    (conflict) => conflict.source === "shell_profile"
  );
  assert.equal(shellConflicts.length, 4);
  assert.equal(
    shellConflicts.some((conflict) =>
      conflict.sourcePath?.endsWith(join(".config", "fish", "conf.d", "mniu.fish"))
    ),
    true
  );

  const dryRun = await cleanupShellEnvConflicts(homeDir, { dryRun: true });
  assert.equal(dryRun.removed.length, 4);
  assert.match(await readFile(join(homeDir, ".zprofile"), "utf8"), /OPENAI_API_KEY/);

  const confirmed = await cleanupShellEnvConflicts(homeDir, {
    dryRun: false,
    mniuRoot: join(homeDir, ".mniu"),
    now: new Date("2026-01-03T04:05:06.000Z")
  });
  assert.equal(confirmed.dryRun, false);
  assert.equal(confirmed.removed.length, 4);
  assert.equal(confirmed.changedFiles.length, 4);
  assert.equal(confirmed.changedFiles.every((file) => Boolean(file.backupPath)), true);

  assert.doesNotMatch(await readFile(join(homeDir, ".zprofile"), "utf8"), /OPENAI_API_KEY/);
  assert.match(await readFile(join(homeDir, ".zprofile"), "utf8"), /KEEP_THIS/);
  assert.doesNotMatch(
    await readFile(join(homeDir, ".bash_profile"), "utf8"),
    /ANTHROPIC_API_KEY/
  );
  assert.match(await readFile(join(homeDir, ".bash_profile"), "utf8"), /echo keep-bash/);
  assert.doesNotMatch(
    await readFile(join(homeDir, ".config", "fish", "conf.d", "mniu.fish"), "utf8"),
    /ANTHROPIC_BASE_URL/
  );
  assert.match(
    await readFile(join(homeDir, ".config", "fish", "conf.d", "mniu.fish"), "utf8"),
    /KEEP_THIS/
  );
  assert.doesNotMatch(await readFile(join(homeDir, ".tcshrc"), "utf8"), /OPENAI_API_KEY/);
  assert.match(await readFile(join(homeDir, ".tcshrc"), "utf8"), /KEEP_THIS/);
});

test("doctor reports and can explicitly clean launchd and IDE env conflicts", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-doctor-readonly-env-home-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });
  await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
  await mkdir(
    join(homeDir, "Library", "Application Support", "Code", "User"),
    { recursive: true }
  );
  await writeFile(
    join(homeDir, "Library", "LaunchAgents", "dev.muniu.env.plist"),
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>Label</key>",
      "  <string>dev.muniu.env</string>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>OPENAI_API_KEY</key>",
      "    <string>sk-launch-openai-value</string>",
      "  </dict>",
      "</dict>",
      "</plist>"
    ].join("\n") + "\n"
  );
  await writeFile(
    join(homeDir, "Library", "Application Support", "Code", "User", "settings.json"),
    [
      "{",
      "  // VS Code user settings can inject env into integrated terminals.",
      "  \"terminal.integrated.env.osx\": {",
      "    \"ANTHROPIC_BASE_URL\": \"https://ide.example\",",
      "    \"KEEP_THIS\": \"value\"",
      "  }",
      "}"
    ].join("\n") + "\n"
  );

  const report = await inspectLocalConfig(homeDir, {});
  const launchAgentConflict = report.envConflicts.find(
    (conflict) => conflict.source === "launch_agent"
  );
  const ideConflict = report.envConflicts.find(
    (conflict) => conflict.source === "ide_settings"
  );
  assert.equal(launchAgentConflict?.name, "OPENAI_API_KEY");
  assert.match(launchAgentConflict?.maskedValue ?? "", /^sk-l\.\.\.alue$/);
  assert.equal(launchAgentConflict?.line, 8);
  assert.equal(ideConflict?.name, "ANTHROPIC_BASE_URL");
  assert.match(ideConflict?.maskedValue ?? "", /^http\.\.\.mple$/);
  assert.equal(ideConflict?.line, 4);

  const dryRun = await cleanupShellEnvConflicts(homeDir, { dryRun: true });
  assert.equal(dryRun.removed.length, 0);

  const scopedDryRun = await cleanupShellEnvConflicts(homeDir, {
    dryRun: true,
    sources: ["launch_agent", "ide_settings"]
  });
  assert.equal(scopedDryRun.removed.length, 2);
  assert.equal(scopedDryRun.changedFiles.length, 2);
  assert.equal(
    scopedDryRun.removed.some((item) => item.source === "launch_agent"),
    true
  );
  assert.equal(
    scopedDryRun.removed.some((item) => item.source === "ide_settings"),
    true
  );
  assert.match(
    await readFile(join(homeDir, "Library", "LaunchAgents", "dev.muniu.env.plist"), "utf8"),
    /OPENAI_API_KEY/
  );

  const confirmed = await cleanupShellEnvConflicts(homeDir, {
    dryRun: false,
    sources: ["launch_agent", "ide_settings"],
    mniuRoot: join(homeDir, ".mniu"),
    now: new Date("2026-01-04T05:06:07.000Z")
  });
  assert.equal(confirmed.dryRun, false);
  assert.equal(confirmed.removed.length, 2);
  assert.equal(confirmed.changedFiles.every((file) => Boolean(file.backupPath)), true);

  const cleanedLaunchAgent = await readFile(
    join(homeDir, "Library", "LaunchAgents", "dev.muniu.env.plist"),
    "utf8"
  );
  assert.doesNotMatch(cleanedLaunchAgent, /OPENAI_API_KEY/);
  assert.match(cleanedLaunchAgent, /EnvironmentVariables/);
  const cleanedIdeSettings = await readFile(
    join(homeDir, "Library", "Application Support", "Code", "User", "settings.json"),
    "utf8"
  );
  assert.doesNotMatch(cleanedIdeSettings, /ANTHROPIC_BASE_URL/);
  assert.match(cleanedIdeSettings, /KEEP_THIS/);
});

test("Codex proxy projection restores only when live hash still matches", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-codex-proxy-home-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });
  await mkdir(join(homeDir, ".codex"), { recursive: true });
  const configPath = join(homeDir, ".codex", "config.toml");
  await writeFile(configPath, "model_provider = \"old\"\nmodel = \"old-model\"\n");

  const provider = providerRecord("codex-proxy-1", "deepseek");
  const projection = await projectCodexProxyConfig(provider, {
    homeDir,
    proxyBaseUrl: "http://127.0.0.1:15721"
  });
  const proxyConfig = await readFile(configPath, "utf8");
  assert.match(proxyConfig, /base_url = "http:\/\/127.0.0.1:15721\/v1"/);
  assert.match(proxyConfig, /experimental_bearer_token = "mniu-local-proxy"/);

  const restore = await restoreLiveConfigProjection({
    targetPath: projection.targetPath,
    backupPath: projection.backupPath,
    expectedLiveConfigHash: projection.liveConfigHash
  });
  assert.equal(restore.restored, true);
  assert.equal(await readFile(configPath, "utf8"), "model_provider = \"old\"\nmodel = \"old-model\"\n");

  const secondProjection = await projectCodexProxyConfig(provider, {
    homeDir,
    proxyBaseUrl: "http://127.0.0.1:15721"
  });
  await writeFile(configPath, "model_provider = \"user-edit\"\n");
  const conflict = await restoreLiveConfigProjection({
    targetPath: secondProjection.targetPath,
    backupPath: secondProjection.backupPath,
    expectedLiveConfigHash: secondProjection.liveConfigHash
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.reason, "live_config_changed");
});

function providerRecord(
  id: string,
  presetId: string,
  overrides: Partial<ProviderRecord> = {}
): ProviderRecord {
  const input = createProviderInputFromPreset(presetId, overrides);
  return {
    id,
    app: input.app,
    name: input.name,
    kind: input.kind,
    apiFormat: input.apiFormat,
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel,
    modelReasoningEffort: input.modelReasoningEffort,
    disableResponseStorage: input.disableResponseStorage ?? true,
    wireApi: input.wireApi,
    apiKeyRef: input.apiKeyRef,
    modelCatalog: input.modelCatalog ?? [],
    config: input.config ?? {},
    enabled: false,
    sortOrder: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}
