import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activatePromptPreset,
  discoverSkillSources,
  hashSkillRegistryReleasePayload,
  hashSkillRegistryFiles,
  installSkill,
  projectMcpServer,
  readPromptLiveFile,
  skillRegistryReleaseSignaturePayload,
  skillRegistrySignaturePayload,
  syncSkillRegistry,
  uninstallSkill,
  type McpServerRecord,
  type PromptActivationRecord,
  type PromptPresetRecord,
  type SkillRegistryFile,
  type SkillRecord
} from "../src/index.js";

test("projects the same MCP server to Claude and Codex config formats", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-ext-mcp-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  const server: McpServerRecord = {
    id: "mcp-1",
    name: "weather",
    command: "node",
    args: ["server.js"],
    env: { WEATHER_TOKEN: "test" },
    apps: ["claude", "codex"],
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const results = await projectMcpServer(server, { homeDir });

  assert.equal(results.length, 2);
  const claudeConfig = JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.deepEqual(claudeConfig.mcpServers.weather, {
    command: "node",
    args: ["server.js"],
    env: { WEATHER_TOKEN: "test" }
  });
  const codexConfig = await readFile(join(homeDir, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, /\[mcp_servers\.weather\]/);
  assert.match(codexConfig, /command = "node"/);
  assert.match(codexConfig, /args = \[\s*"server\.js"\s*\]/);
  assert.match(codexConfig, /\[mcp_servers\.weather\.env\]/);
  assert.match(codexConfig, /WEATHER_TOKEN = "test"/);
  assert.doesNotMatch(codexConfig, /args_json|env_json/);
});

test("prompt activation backfills live edits before switching presets", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-ext-prompt-"));
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  const previousPreset: PromptPresetRecord = {
    id: "prompt-old",
    name: "Old",
    content: "old content\n",
    apps: ["claude"],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const previous = await activatePromptPreset(previousPreset, {
    app: "claude",
    homeDir
  });
  await writeFile(join(homeDir, ".claude", "CLAUDE.md"), "manual live edit\n");
  const previousActivation: PromptActivationRecord = {
    id: "activation-1",
    promptId: previousPreset.id,
    app: "claude",
    targetPath: previous.targetPath,
    liveConfigHash: previous.liveConfigHash,
    activatedAt: new Date(0).toISOString()
  };

  const nextPreset: PromptPresetRecord = {
    id: "prompt-next",
    name: "Next",
    content: "next content",
    apps: ["claude"],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const result = await activatePromptPreset(nextPreset, {
    app: "claude",
    homeDir,
    previousActivation
  });

  assert.equal(result.backfill?.promptId, "prompt-old");
  assert.equal(result.backfill?.content, "manual live edit\n");
  assert.equal(await readFile(join(homeDir, ".claude", "CLAUDE.md"), "utf8"), "next content\n");
  const live = await readPromptLiveFile(homeDir, "claude");
  assert.equal(live.exists, true);
  assert.equal(live.content, "next content\n");
});

test("discovers skills from mniu and agents source roots", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-ext-skill-discover-"));
  const mniuRoot = join(homeDir, ".mniu");
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  await mkdir(join(mniuRoot, "skills", "review"), { recursive: true });
  await writeFile(
    join(mniuRoot, "skills", "review", "SKILL.md"),
    "---\nname: review\nversion: 1.0.0\ndescription: Review changes.\n---\n"
  );
  await mkdir(join(homeDir, ".agents", "skills", "legacy"), { recursive: true });
  await writeFile(
    join(homeDir, ".agents", "skills", "legacy", "SKILL.md"),
    "---\nname: legacy\n---\n"
  );

  const sources = await discoverSkillSources({ homeDir, mniuRoot });

  assert.deepEqual(
    sources.map((source) => [source.name, source.sourceRoot]),
    [["legacy", "agents"], ["review", "mniu"]]
  );
  assert.equal(sources.find((source) => source.name === "review")?.version, "1.0.0");
});

test("installs skills by copy or symlink and backs up before uninstall", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-ext-skill-install-"));
  const mniuRoot = join(homeDir, ".mniu");
  const sourcePath = join(mniuRoot, "skills", "review");
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  await mkdir(sourcePath, { recursive: true });
  await writeFile(join(sourcePath, "SKILL.md"), "# Review\n");
  await writeFile(join(sourcePath, "notes.md"), "source notes\n");
  const skill: SkillRecord = {
    id: "skill-1",
    name: "review",
    sourcePath,
    apps: ["claude", "codex"],
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  const copyResult = await installSkill(skill, {
    app: "claude",
    homeDir,
    mniuRoot,
    mode: "copy"
  });
  assert.equal(copyResult.changed, true);
  assert.equal(
    await readFile(join(homeDir, ".claude", "skills", "review", "SKILL.md"), "utf8"),
    "# Review\n"
  );

  await writeFile(join(homeDir, ".claude", "skills", "review", "SKILL.md"), "# Manual edit\n");
  const uninstallResult = await uninstallSkill(skill, {
    app: "claude",
    homeDir,
    mniuRoot
  });
  assert.equal(uninstallResult.changed, true);
  assert.ok(uninstallResult.backupPath);
  assert.equal(
    await readFile(join(uninstallResult.backupPath, "SKILL.md"), "utf8"),
    "# Manual edit\n"
  );

  const symlinkResult = await installSkill(skill, {
    app: "codex",
    homeDir,
    mniuRoot,
    mode: "symlink"
  });
  assert.equal(symlinkResult.changed, true);
  const codexTarget = join(homeDir, ".codex", "skills", "review");
  assert.equal((await lstat(codexTarget)).isSymbolicLink(), true);
  assert.equal(await readlink(codexTarget), sourcePath);
});

test("syncs signed skill registry with version-aware source updates", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mn-ext-skill-registry-"));
  const mniuRoot = join(homeDir, ".mniu");
  const registryPath = join(homeDir, "registry.json");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const publicKeyId = "registry-2026-a";
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  const writeRegistry = async (version: string, title: string) => {
    const files: SkillRegistryFile[] = [
      {
        path: "SKILL.md",
        content: `---\nname: review\nversion: ${version}\ndescription: Review changes.\n---\n# ${title}\n`
      },
      { path: "notes.md", content: `${title} notes\n` }
    ];
    const sha256 = hashSkillRegistryFiles(files);
    const entry = {
      name: "review",
      version,
      description: "Review changes.",
      apps: ["claude", "codex"] as SkillRecord["apps"],
      files,
      sha256,
      publicKeyId
    };
    const signature = sign(
      null,
      Buffer.from(skillRegistrySignaturePayload(entry)),
      privateKey
    ).toString("base64");
    const registry = {
      version: 1 as const,
      publicKeys: [{ id: publicKeyId, publicKey: publicKeyDer }],
      revokedPublicKeyIds: ["registry-2025-retired"],
      signatureAlgorithm: "ed25519" as const,
      skills: [{ ...entry, signature }]
    };
    const releaseMetadata = {
      version: 1 as const,
      sequence: 1,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      registrySha256: hashSkillRegistryReleasePayload(registry),
      publicKeyId
    };
    const releaseSignature = sign(
      null,
      Buffer.from(skillRegistryReleaseSignaturePayload(releaseMetadata)),
      privateKey
    ).toString("base64");
    await writeFile(
      registryPath,
      `${JSON.stringify({
        ...registry,
        releaseMetadata: { ...releaseMetadata, signature: releaseSignature }
      }, null, 2)}\n`
    );
  };

  await writeRegistry("1.0.0", "Review v1");
  const releasedRegistry = await readFile(registryPath, "utf8");
  const unsignedReleaseRegistry = JSON.parse(releasedRegistry) as Record<string, unknown>;
  delete unsignedReleaseRegistry.releaseMetadata;
  await writeFile(registryPath, `${JSON.stringify(unsignedReleaseRegistry, null, 2)}\n`);
  await assert.rejects(
    () =>
      syncSkillRegistry({
        registryUrl: registryPath,
        homeDir,
        mniuRoot,
        dryRun: true,
        requireSignature: true,
        requireReleaseMetadata: true
      }),
    /release metadata required/
  );
  await writeFile(registryPath, releasedRegistry);

  const dryRun = await syncSkillRegistry({
    registryUrl: registryPath,
    homeDir,
    mniuRoot,
    dryRun: true,
    requireSignature: true,
    requireReleaseMetadata: true,
    revokedPublicKeyIds: ["registry-2024-revoked"]
  });
  assert.equal(dryRun.skills[0]?.status, "new");
  assert.equal(dryRun.skills[0]?.signatureVerified, true);
  assert.equal(dryRun.skills[0]?.publicKeyId, publicKeyId);
  assert.equal(dryRun.releaseMetadata?.signatureVerified, true);
  assert.equal(dryRun.releaseMetadata?.publicKeyId, publicKeyId);
  assert.equal(dryRun.skills[0]?.applied, false);

  const firstSync = await syncSkillRegistry({
    registryUrl: registryPath,
    homeDir,
    mniuRoot,
    requireSignature: true,
    requireReleaseMetadata: true
  });
  assert.equal(firstSync.skills[0]?.status, "new");
  assert.equal(firstSync.skills[0]?.applied, true);
  assert.equal(
    await readFile(join(mniuRoot, "skills", "review", "SKILL.md"), "utf8"),
    "---\nname: review\nversion: 1.0.0\ndescription: Review changes.\n---\n# Review v1\n"
  );

  const installedSkill: SkillRecord = {
    id: "skill-1",
    name: "review",
    sourcePath: join(mniuRoot, "skills", "review"),
    description: "Review changes.",
    version: "1.0.0",
    apps: ["claude", "codex"],
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const current = await syncSkillRegistry({
    registryUrl: registryPath,
    homeDir,
    mniuRoot,
    installedSkills: [installedSkill],
    requireSignature: true,
    requireReleaseMetadata: true
  });
  assert.equal(current.skills[0]?.status, "current");
  assert.equal(current.skills[0]?.applied, false);

  await writeRegistry("1.1.0", "Review v2");
  const updated = await syncSkillRegistry({
    registryUrl: registryPath,
    homeDir,
    mniuRoot,
    installedSkills: [installedSkill],
    requireSignature: true,
    requireReleaseMetadata: true,
    now: new Date("2026-01-01T00:00:00.000Z")
  });
  assert.equal(updated.skills[0]?.status, "update");
  assert.ok(updated.skills[0]?.backupPath);
  assert.equal(
    await readFile(join(updated.skills[0].backupPath, "SKILL.md"), "utf8"),
    "---\nname: review\nversion: 1.0.0\ndescription: Review changes.\n---\n# Review v1\n"
  );
  assert.equal(
    await readFile(join(mniuRoot, "skills", "review", "SKILL.md"), "utf8"),
    "---\nname: review\nversion: 1.1.0\ndescription: Review changes.\n---\n# Review v2\n"
  );

  await writeRegistry("1.0.0", "Review v1 again");
  const downgrade = await syncSkillRegistry({
    registryUrl: registryPath,
    homeDir,
    mniuRoot,
    installedSkills: [{ ...installedSkill, version: "1.1.0" }],
    requireSignature: true,
    requireReleaseMetadata: true
  });
  assert.equal(downgrade.skills[0]?.status, "downgrade");
  assert.equal(downgrade.skills[0]?.applied, false);
  assert.equal(
    await readFile(join(mniuRoot, "skills", "review", "SKILL.md"), "utf8"),
    "---\nname: review\nversion: 1.1.0\ndescription: Review changes.\n---\n# Review v2\n"
  );

  await assert.rejects(
    () =>
      syncSkillRegistry({
        registryUrl: registryPath,
        homeDir,
        mniuRoot,
        requireSignature: true,
        requireReleaseMetadata: true,
        revokedPublicKeyIds: [publicKeyId]
      }),
    /public key revoked/
  );
});
