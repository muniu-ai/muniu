import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createProviderInputFromPreset } from "@mn/provider-catalog";
import { FileLocalStore, LocalSecretVault, SqliteLocalStore } from "../src/index.js";

function legacyProviderFixture() {
  return {
    version: 1,
    providers: [
      {
        id: "legacy-unified",
        app: "unified",
        name: "Legacy unified",
        kind: "relay",
        apiFormat: "openai_chat",
        baseUrl: "https://legacy.example.test/v1",
        defaultModel: "legacy-model",
        modelCatalog: [{ id: "legacy-model", displayName: "Legacy model" }],
        config: {},
        enabled: true,
        enabledApps: ["claude", "agent"],
        sortOrder: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  };
}

test("file local store persists providers as local SSOT", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-store-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const store = new FileLocalStore({ rootDir });
  const provider = await store.createProvider(
    createProviderInputFromPreset("deepseek")
  );
  await store.enableProvider(provider.id, "codex");

  const reloaded = new FileLocalStore({ rootDir });
  const enabled = await reloaded.getEnabledProvider("codex");

  assert.equal(enabled?.id, provider.id);
  assert.equal(enabled?.enabled, true);
});

test("unified provider activation is isolated per app", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-unified-provider-store-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const store = new FileLocalStore({ rootDir });
  const unified = await store.createProvider({
    app: "unified",
    name: "Unified",
    kind: "relay",
    apiFormat: "openai_chat",
    baseUrl: "https://unified.example.test/v1",
    defaultModel: "unified-model"
  });
  const codex = await store.createProvider({
    app: "codex",
    name: "Codex only",
    kind: "openai_compatible",
    apiFormat: "openai_chat",
    baseUrl: "https://codex.example.test/v1",
    defaultModel: "codex-model"
  });
  const agent = await store.createProvider(
    createProviderInputFromPreset("deepseek-official")
  );

  await store.enableProvider(unified.id, "claude");
  assert.equal((await store.getEnabledProvider("claude"))?.id, unified.id);
  assert.equal(await store.getEnabledProvider("codex"), undefined);

  await store.enableProvider(codex.id, "codex");
  assert.equal((await store.getEnabledProvider("claude"))?.id, unified.id);
  assert.equal((await store.getEnabledProvider("codex"))?.id, codex.id);
  assert.equal(await store.getEnabledProvider("agent"), undefined);

  await store.enableProvider(agent.id, "agent");
  assert.equal((await store.getEnabledProvider("agent"))?.id, agent.id);
  assert.equal((await store.getEnabledProvider("claude"))?.id, unified.id);
  assert.equal((await store.getEnabledProvider("codex"))?.id, codex.id);
  const persistedUnified = await store.getProvider(unified.id);
  assert.deepEqual(persistedUnified?.enabledConsumers, ["claude"]);
  assert.equal(persistedUnified?.enabledApps, undefined);
  assert.equal(persistedUnified?.enabled, true);

  const persistedAgent = await store.getProvider(agent.id);
  assert.deepEqual(persistedAgent?.enabledConsumers, ["agent"]);
  assert.equal(persistedAgent?.enabledApps, undefined);

  const codexView = await store.listProviders("codex");
  assert.equal(codexView.find((provider) => provider.id === unified.id)?.enabled, false);
  assert.equal(codexView.find((provider) => provider.id === codex.id)?.enabled, true);
});

test("legacy JSON enabledApps remains readable without rewriting the fixture", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-legacy-json-provider-store-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const dataFile = join(rootDir, "mniu.db.json");
  const original = `${JSON.stringify(legacyProviderFixture(), null, 2)}\n`;
  await writeFile(dataFile, original, "utf8");

  const store = new FileLocalStore({ rootDir });
  const claude = await store.getEnabledProvider("claude");
  const agent = await store.getEnabledProvider("agent");

  assert.equal(claude?.id, "legacy-unified");
  assert.deepEqual(claude?.enabledConsumers, ["claude"]);
  assert.deepEqual(claude?.enabledApps, ["claude"]);
  assert.equal(agent, undefined);
  assert.equal(await readFile(dataFile, "utf8"), original);
});

test("legacy SQLite enabledApps remains readable without rewriting the fixture", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-legacy-sqlite-provider-store-"));
  t.after(async () => rm(rootDir, { recursive: true, force: true }));
  const databaseFile = join(rootDir, "mniu.db");
  const original = JSON.stringify(legacyProviderFixture());
  const fixtureDatabase = new DatabaseSync(databaseFile);
  fixtureDatabase.exec(`
    create table local_state (
      key text primary key,
      value text not null
    )
  `);
  fixtureDatabase
    .prepare("insert into local_state (key, value) values (?, ?)")
    .run("data", original);
  fixtureDatabase.close();

  const store = new SqliteLocalStore({ rootDir });
  const claude = await store.getEnabledProvider("claude");
  const agent = await store.getEnabledProvider("agent");
  store.close();

  assert.equal(claude?.id, "legacy-unified");
  assert.deepEqual(claude?.enabledConsumers, ["claude"]);
  assert.deepEqual(claude?.enabledApps, ["claude"]);
  assert.equal(agent, undefined);

  const verificationDatabase = new DatabaseSync(databaseFile);
  const row = verificationDatabase
    .prepare("select value from local_state where key = ?")
    .get("data") as { value: string };
  verificationDatabase.close();
  assert.equal(row.value, original);
});

test("local secret vault stores only encrypted payload on disk", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-vault-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const vault = new LocalSecretVault(rootDir);
  const ref = await vault.saveSecret("sk-test-secret-value");
  const value = await vault.readSecret(ref.ref);

  assert.equal(ref.type, "local_encrypted");
  assert.equal(ref.maskedValue, "sk-t...alue");
  assert.equal(value, "sk-test-secret-value");
  await vault.deleteSecret(ref.ref, "local_encrypted");
  assert.equal(await vault.readSecret(ref.ref, "local_encrypted"), undefined);
});

test("local secret vault can store provider secrets in macOS keychain backend", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-keychain-vault-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const saved = new Map<string, string>();
  const calls: string[][] = [];
  const optionValue = (args: string[], option: string): string => {
    const value = args[args.indexOf(option) + 1];
    assert.ok(value);
    return value;
  };
  const vault = new LocalSecretVault(rootDir, {
    backend: "keychain",
    keychain: {
      service: "dev.muniu.test",
      accountPrefix: "test:",
      runSecurity: async (args) => {
        calls.push(args);
        const account = optionValue(args, "-a");
        if (args[0] === "add-generic-password") {
          saved.set(account, optionValue(args, "-w"));
          return "";
        }
        if (args[0] === "find-generic-password") {
          const value = saved.get(account);
          if (!value) throw Object.assign(new Error("The specified item could not be found."), { code: 44 });
          return `${value}\n`;
        }
        if (args[0] === "delete-generic-password") {
          saved.delete(account);
          return "";
        }
        throw new Error(`unexpected security command: ${args.join(" ")}`);
      }
    }
  });

  const ref = await vault.saveSecret("sk-keychain-secret-value");
  const value = await vault.readSecret(ref.ref, "keychain");

  assert.equal(ref.type, "keychain");
  assert.equal(ref.maskedValue, "sk-k...alue");
  assert.equal(value, "sk-keychain-secret-value");
  assert.ok(calls.some((args) => args[0] === "add-generic-password"));
  assert.ok(calls.some((args) => args[0] === "find-generic-password"));
  await vault.deleteSecret(ref.ref, "keychain");
  assert.equal(await vault.readSecret(ref.ref, "keychain"), undefined);
  assert.ok(calls.some((args) => args[0] === "delete-generic-password"));
  await assert.rejects(access(join(rootDir, "secrets")));
});

test("sqlite local store persists providers through the same SSOT contract", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-sqlite-store-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const store = new SqliteLocalStore({ rootDir });
  const provider = await store.createProvider(
    createProviderInputFromPreset("claude-official")
  );
  await store.enableProvider(provider.id, "claude");
  store.close();

  const reloaded = new SqliteLocalStore({ rootDir });
  t.after(() => {
    reloaded.close();
  });
  const enabled = await reloaded.getEnabledProvider("claude");

  assert.equal(enabled?.id, provider.id);
});

test("store keeps separate provider and proxy takeover projections", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-projection-store-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const store = new FileLocalStore({ rootDir });
  const provider = await store.createProvider(
    createProviderInputFromPreset("deepseek")
  );
  await store.saveProjection({
    providerId: provider.id,
    app: "codex",
    purpose: "provider",
    targetPath: "/tmp/config.toml",
    liveConfigHash: "provider-hash"
  });
  await store.saveProjection({
    providerId: provider.id,
    app: "codex",
    purpose: "proxy_takeover",
    targetPath: "/tmp/config.toml",
    liveConfigHash: "proxy-hash"
  });

  const providerProjection = await store.getLatestProjection({
    app: "codex",
    purpose: "provider"
  });
  const proxyProjection = await store.getLatestProjection({
    app: "codex",
    purpose: "proxy_takeover"
  });

  assert.equal(providerProjection?.liveConfigHash, "provider-hash");
  assert.equal(proxyProjection?.liveConfigHash, "proxy-hash");
});

test("store filters proxy request logs by run and candidate", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-proxy-log-store-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const store = new FileLocalStore({ rootDir });
  await store.appendProxyRequestLog({
    id: "log-1",
    app: "codex",
    providerId: "provider-1",
    model: "model-a",
    inputTokens: 3,
    outputTokens: 4,
    statusCode: 200,
    latencyMs: 10,
    runId: "run-1",
    candidateId: "codex-1",
    createdAt: "2026-01-01T00:00:01.000Z"
  });
  await store.appendProxyRequestLog({
    id: "log-2",
    app: "codex",
    providerId: "provider-1",
    model: "model-a",
    inputTokens: 5,
    outputTokens: 6,
    statusCode: 200,
    latencyMs: 12,
    runId: "run-2",
    candidateId: "codex-1",
    createdAt: "2026-01-01T00:00:02.000Z"
  });

  const byRun = await store.listProxyRequestLogs({ runId: "run-1" });
  assert.deepEqual(byRun.map((log) => log.id), ["log-1"]);

  const byCandidate = await store.listProxyRequestLogs({
    runId: "run-2",
    candidateId: "codex-1"
  });
  assert.deepEqual(byCandidate.map((log) => log.id), ["log-2"]);
});

test("store persists provider health and opens/closes circuit", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-health-store-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const store = new FileLocalStore({ rootDir });
  const provider = await store.createProvider(
    createProviderInputFromPreset("deepseek")
  );

  await store.recordProviderHealthEvent({
    providerId: provider.id,
    app: "codex",
    ok: false,
    statusCode: 500,
    retryable: true,
    failureThreshold: 3,
    circuitOpenMs: 60_000,
    occurredAt: "2099-07-05T00:00:00.000Z"
  });
  await store.recordProviderHealthEvent({
    providerId: provider.id,
    app: "codex",
    ok: false,
    statusCode: 504,
    retryable: true,
    failureThreshold: 3,
    circuitOpenMs: 60_000,
    occurredAt: "2099-07-05T00:00:01.000Z"
  });
  const opened = await store.recordProviderHealthEvent({
    providerId: provider.id,
    app: "codex",
    ok: false,
    statusCode: 429,
    retryable: true,
    failureThreshold: 3,
    circuitOpenMs: 60_000,
    occurredAt: "2099-07-05T00:00:02.000Z"
  });

  assert.equal(opened.state, "circuit_open");
  assert.equal(opened.consecutiveFailures, 3);
  assert.equal(opened.circuitOpenUntil, "2099-07-05T00:01:02.000Z");

  const reloaded = new FileLocalStore({ rootDir });
  const persisted = await reloaded.getProviderHealth(provider.id, "codex");
  assert.equal(persisted?.state, "circuit_open");

  const closed = await reloaded.recordProviderHealthEvent({
    providerId: provider.id,
    app: "codex",
    ok: true,
    statusCode: 200,
    latencyMs: 12,
    occurredAt: "2099-07-05T00:00:03.000Z"
  });

  assert.equal(closed.state, "healthy");
  assert.equal(closed.consecutiveFailures, 0);
  assert.equal(closed.lastLatencyMs, 12);
});

test("store resets provider health by app", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-health-reset-store-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const store = new FileLocalStore({ rootDir });
  const provider = await store.createProvider(
    createProviderInputFromPreset("deepseek")
  );
  await store.recordProviderHealthEvent({
    providerId: provider.id,
    app: "codex",
    ok: false,
    retryable: true,
    failureThreshold: 1,
    occurredAt: "2099-07-05T00:00:00.000Z"
  });
  await store.recordProviderHealthEvent({
    providerId: provider.id,
    app: "claude",
    ok: false,
    retryable: true,
    failureThreshold: 1,
    occurredAt: "2099-07-05T00:00:01.000Z"
  });

  const removed = await store.resetProviderHealth({ providerId: provider.id, app: "codex" });
  assert.equal(removed.length, 1);
  assert.equal(removed[0]?.app, "codex");
  assert.equal(removed[0]?.state, "circuit_open");
  assert.equal(await store.getProviderHealth(provider.id, "codex"), undefined);
  assert.equal((await store.getProviderHealth(provider.id, "claude"))?.state, "circuit_open");

  const remainingRemoved = await store.resetProviderHealth({ providerId: provider.id });
  assert.deepEqual(remainingRemoved.map((health) => health.app), ["claude"]);
  assert.deepEqual(await store.listProviderHealth({ providerId: provider.id }), []);
});

test("store persists MCP servers and prompt presets", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-extension-store-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const store = new FileLocalStore({ rootDir });
  const server = await store.createMcpServer({
    name: "weather",
    command: "node",
    args: ["weather.js"],
    env: { WEATHER_TOKEN: "test" },
    apps: ["claude", "codex"]
  });
  const prompt = await store.createPromptPreset({
    name: "Review",
    content: "Review carefully.",
    apps: ["codex"]
  });
  await store.savePromptActivation({
    promptId: prompt.id,
    app: "codex",
    targetPath: "/tmp/AGENTS.md",
    liveConfigHash: "hash-1"
  });

  const reloaded = new FileLocalStore({ rootDir });
  const codexServers = await reloaded.listMcpServers("codex");
  const claudePrompts = await reloaded.listPromptPresets("claude");
  const latestActivation = await reloaded.getLatestPromptActivation("codex");

  assert.equal(codexServers[0]?.id, server.id);
  assert.deepEqual(codexServers[0]?.args, ["weather.js"]);
  assert.deepEqual(codexServers[0]?.env, { WEATHER_TOKEN: "test" });
  assert.equal(claudePrompts.length, 0);
  assert.equal(latestActivation?.promptId, prompt.id);
  assert.equal(latestActivation?.liveConfigHash, "hash-1");
});

test("store persists skills and installation records", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-skill-store-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const store = new FileLocalStore({ rootDir });
  const skill = await store.createSkill({
    name: "review",
    sourcePath: "/tmp/skills/review",
    apps: ["claude", "codex"],
    version: "1.0.0"
  });
  await store.saveSkillInstallation({
    skillId: skill.id,
    app: "claude",
    mode: "copy",
    sourcePath: "/tmp/skills/review",
    targetPath: "/tmp/home/.claude/skills/review",
    installedHash: "dir:hash-1"
  });

  const reloaded = new FileLocalStore({ rootDir });
  assert.equal((await reloaded.listSkills("codex"))[0]?.id, skill.id);
  assert.equal((await reloaded.getSkillInstallation(skill.id, "claude"))?.installedHash, "dir:hash-1");

  await reloaded.deleteSkill(skill.id);
  assert.equal((await reloaded.listSkills()).length, 0);
  assert.equal(await reloaded.getSkillInstallation(skill.id, "claude"), undefined);
});

test("store persists skill registry trust profiles", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "mn-registry-profile-store-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const store = new FileLocalStore({ rootDir });
  const profile = await store.createSkillRegistryTrustProfile({
    name: "Trusted Registry",
    registryUrl: "/tmp/registry.json",
    requireSignature: true,
    requireReleaseMetadata: true,
    trustedPublicKeys: [{ id: "registry-2026", publicKey: "public-key" }],
    revokedPublicKeyIds: ["registry-2025"]
  });

  const reloaded = new FileLocalStore({ rootDir });
  assert.equal((await reloaded.listSkillRegistryTrustProfiles())[0]?.id, profile.id);
  assert.equal(
    (await reloaded.getSkillRegistryTrustProfile(profile.id))?.requireReleaseMetadata,
    true
  );
  assert.deepEqual(
    (await reloaded.getSkillRegistryTrustProfile(profile.id))?.trustedPublicKeys,
    [{ id: "registry-2026", publicKey: "public-key" }]
  );

  const updated = await reloaded.updateSkillRegistryTrustProfile(profile.id, {
    name: "Trusted Registry v2",
    requireReleaseMetadata: false,
    revokedPublicKeyIds: ["registry-2025", "registry-2024"]
  });
  assert.equal(updated.name, "Trusted Registry v2");
  assert.equal(updated.requireReleaseMetadata, false);
  assert.deepEqual(updated.revokedPublicKeyIds, ["registry-2025", "registry-2024"]);

  await reloaded.deleteSkillRegistryTrustProfile(profile.id);
  assert.equal((await reloaded.listSkillRegistryTrustProfiles()).length, 0);
});
