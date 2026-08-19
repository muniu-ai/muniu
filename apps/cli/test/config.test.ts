import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("doctor uses apiUrl from .mn/config.json when MN_API_URL is not set", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-config-"));
  const server = createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          ok: true,
          service: "mn-api",
          executorMode: "mock",
          workspaceRoot: "/tmp/mn-worktrees"
        })
      );
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;
  env.MN_CLAUDE_BINARY = process.execPath;
  env.MN_CODEX_BINARY = process.execPath;

  const result = await execFileAsync(
    process.execPath,
    [join(process.cwd(), "dist-test", "src", "index.js"), "doctor"],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, new RegExp(`API URL: ${escapeRegExp(apiUrl)}`));
  assert.match(result.stdout, /Executor mode: mock/);
});

test("doctor env-cleanup posts dry-run and confirmed requests", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-env-cleanup-"));
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            ok: true,
            service: "mn-api",
            executorMode: "mock",
            workspaceRoot: "/tmp/mn-worktrees"
          })
        );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/system/env-cleanup") {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw) as {
          dryRun: boolean;
          names?: string[];
          sources?: string[];
        };
        requests.push({ method: request.method, url: request.url, body });
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              dryRun: body.dryRun,
              scannedFiles: [],
              changedFiles: [],
              removed: []
            })
          );
      });
      return;
    }
    response.writeHead(404).end();
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const env = {
    ...process.env,
    MN_API_URL: `http://127.0.0.1:${address.port}`
  };
  const cliPath = join(process.cwd(), "dist-test", "src", "index.js");

  const dryRun = await execFileAsync(
    process.execPath,
    [cliPath, "doctor", "env-cleanup", "--name", "OPENAI_API_KEY"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(dryRun.stdout, /"dryRun": true/);

  const confirmed = await execFileAsync(
    process.execPath,
    [cliPath, "doctor", "env-cleanup", "--name", "OPENAI_API_KEY", "--yes"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(confirmed.stdout, /"dryRun": false/);
  const scoped = await execFileAsync(
    process.execPath,
    [cliPath, "doctor", "env-cleanup", "--source", "all", "--yes"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(scoped.stdout, /"dryRun": false/);
  assert.deepEqual(requests.map((request) => request.body), [
    { dryRun: true, names: ["OPENAI_API_KEY"] },
    { dryRun: false, names: ["OPENAI_API_KEY"] },
    {
      dryRun: false,
      sources: ["shell_profile", "launch_agent", "ide_settings"]
    }
  ]);
});

test("diagnostics export calls configured API and writes output file", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-diagnostics-"));
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (request.url !== "/v1/system/diagnostics") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          kind: "mniu.diagnostics",
          version: 1,
          generatedAt: "2026-07-07T00:00:00.000Z",
          logs: { files: [] },
          appLogs: {
            files: [
              {
                relativePath: "ApplicationLogs/dev.muniu.desktop/mniu.log",
                tail: "password=[REDACTED]"
              }
            ]
          },
          crashReports: { files: [] }
        })
      );
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;
  const outPath = join(cwd, "diagnostics.json");

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "diagnostics",
      "export",
      "--out",
      outPath
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /Exported diagnostics/);
  assert.deepEqual(seenUrls, ["/v1/system/diagnostics"]);
  const exported = JSON.parse(await readFile(outPath, "utf8"));
  assert.equal(exported.kind, "mniu.diagnostics");
  assert.equal(
    exported.appLogs.files[0].relativePath,
    "ApplicationLogs/dev.muniu.desktop/mniu.log"
  );
  assert.match(exported.appLogs.files[0].tail, /password=\[REDACTED\]/);
});

test("provider list calls configured API with app filter", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-provider-"));
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (request.url !== "/v1/providers?app=codex") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ providers: [{ id: "provider-1", name: "DeepSeek" }] }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "provider",
      "list",
      "--app",
      "codex"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /DeepSeek/);
  assert.deepEqual(seenUrls, ["/v1/providers?app=codex"]);
});

test("provider restore previews by default and confirms with --yes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-provider-restore-"));
  const seenBodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/providers/provider-1/restore") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seenBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          provider: { id: "provider-1", name: "DeepSeek", enabled: false },
          restore: { restored: true, targetPath: "/tmp/config.toml" }
        })
      );
    });
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl: `http://127.0.0.1:${address.port}` }, null, 2)}\n`
  );
  const entry = join(process.cwd(), "dist-test", "src", "index.js");
  const env = { ...process.env };
  delete env.MN_API_URL;

  await execFileAsync(process.execPath, [entry, "provider", "restore", "provider-1", "--app", "codex"], {
    cwd,
    env,
    timeout: 10000
  });
  await execFileAsync(
    process.execPath,
    [entry, "provider", "restore", "provider-1", "--app", "codex", "--yes"],
    { cwd, env, timeout: 10000 }
  );

  assert.deepEqual(seenBodies, [
    { app: "codex", dryRun: true },
    { app: "codex", dryRun: false }
  ]);
});

test("provider add posts tool replay policy flags", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-provider-add-"));
  let seenBody: Record<string, any> | undefined;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/providers") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response
        .writeHead(201, { "content-type": "application/json" })
        .end(JSON.stringify({ id: "provider-1", name: "Replay Provider" }));
    });
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "provider",
      "add",
      "--preset",
      "openai",
      "--api-key-env",
      "OPENAI_API_KEY",
      "--replay-tool-calls",
      "--tool-readonly",
      "get_weather,list_models",
      "--tool-idempotent",
      "cache_lookup",
      "--tool-side-effect",
      "write_file"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /provider-1/);
  assert.deepEqual(seenBody?.config, {
    replayToolCalls: true,
    toolReplayPolicy: {
      tools: {
        get_weather: "readonly",
        list_models: "readonly",
        cache_lookup: "idempotent",
        write_file: "side_effect"
      }
    }
  });
});

test("provider export calls configured API and writes output file", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-provider-export-"));
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (request.url !== "/v1/providers/export?app=codex") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        version: 1,
        providers: [{ name: "Exported Provider" }]
      }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;
  const outPath = join(cwd, "providers.json");

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "provider",
      "export",
      "--app",
      "codex",
      "--out",
      outPath
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /Exported providers/);
  assert.deepEqual(seenUrls, ["/v1/providers/export?app=codex"]);
  const exported = JSON.parse(await readFile(outPath, "utf8"));
  assert.equal(exported.providers[0].name, "Exported Provider");
});

test("provider import defaults to dry-run and --yes confirms import", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-provider-import-"));
  const seenBodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/providers/import" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seenBodies.push(body);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        dryRun: body.dryRun,
        importedCount: body.dryRun ? 0 : 1,
        wouldImportCount: body.dryRun ? 1 : 0,
        skippedCount: 0,
        results: []
      }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );
  const importPath = join(cwd, "providers.json");
  await writeFile(
    importPath,
    `${JSON.stringify({
      version: 1,
      providers: [
        {
          app: "codex",
          name: "Imported Provider",
          kind: "openai_compatible",
          apiFormat: "openai_chat",
          baseUrl: "https://import.example.test/v1",
          defaultModel: "import-model"
        }
      ]
    })}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "provider",
      "import",
      "--file",
      importPath
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );
  await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "provider",
      "import",
      "--file",
      importPath,
      "--yes"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.equal((seenBodies[0] as { dryRun: boolean }).dryRun, true);
  assert.equal((seenBodies[1] as { dryRun: boolean }).dryRun, false);
  const confirmedBody = seenBodies[1] as { providers: Array<{ name: string }> };
  assert.ok(confirmedBody.providers[0]);
  assert.equal(confirmedBody.providers[0].name, "Imported Provider");
});

test("provider model-catalog sync and audit call configured API", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-provider-model-catalog-"));
  const seenBodies: unknown[] = [];
  const seenUrls: string[] = [];
  const server = createServer(async (request, response) => {
    seenUrls.push(request.url ?? "");
    if (
      request.url === "/v1/providers/provider-1/model-catalog/audit?maxAgeDays=45" &&
      request.method === "GET"
    ) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({
          providerId: "provider-1",
          status: "fresh",
          stale: false,
          maxAgeDays: 45
        }));
      return;
    }
    if (
      request.url === "/v1/providers/model-catalog/sync-due" &&
      request.method === "POST"
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seenBodies.push(body);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({
          dryRun: body.dryRun,
          checkedCount: 1,
          policyCount: 1,
          dueCount: body.dryRun ? 1 : 0,
          syncedCount: body.dryRun ? 0 : 1,
          failedCount: 0,
          results: []
        }));
      return;
    }
    if (
      request.url !== "/v1/providers/provider-1/model-catalog/sync" ||
      request.method !== "POST"
    ) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seenBodies.push(body);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        dryRun: body.dryRun,
        mode: body.mode,
        addedCount: 1,
        updatedCount: 0,
        removedCount: 0,
        unchangedCount: 0,
        previewModelCatalog: body.catalog?.models ?? []
      }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );
  const catalogPath = join(cwd, "catalog.json");
  await writeFile(
    catalogPath,
    `${JSON.stringify({
      version: 1,
      models: [
        {
          id: "file-model",
          displayName: "File Model",
          inputTokenUsdPerMillion: 0.5,
          outputTokenUsdPerMillion: 1
        }
      ]
    })}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "provider",
      "model-catalog",
      "sync",
      "provider-1",
      "--file",
      catalogPath
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );
  await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "provider",
      "model-catalog",
      "sync",
      "provider-1",
      "--url",
      "https://catalog.example.test/models.json",
      "--mode",
      "merge",
      "--max-age-days",
      "45",
      "--save-policy",
      "--refresh-interval-hours",
      "12",
      "--yes"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );
  await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "provider",
      "model-catalog",
      "audit",
      "provider-1",
      "--max-age-days",
      "45"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );
  await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "provider",
      "model-catalog",
      "sync-due",
      "--app",
      "codex",
      "--provider",
      "provider-1",
      "--limit",
      "5"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.deepEqual(seenUrls, [
    "/v1/providers/provider-1/model-catalog/sync",
    "/v1/providers/provider-1/model-catalog/sync",
    "/v1/providers/provider-1/model-catalog/audit?maxAgeDays=45",
    "/v1/providers/model-catalog/sync-due"
  ]);
  const fileBody = seenBodies[0] as {
    dryRun: boolean;
    mode: string;
    catalog: { models: Array<{ id: string }> };
  };
  assert.equal(fileBody.dryRun, true);
  assert.equal(fileBody.mode, "replace");
  assert.ok(fileBody.catalog.models[0]);
  assert.equal(fileBody.catalog.models[0].id, "file-model");
  const urlBody = seenBodies[1] as {
    dryRun: boolean;
    mode: string;
    sourceUrl: string;
    maxAgeDays: number;
    savePolicy: boolean;
    refreshIntervalHours: number;
  };
  assert.equal(urlBody.dryRun, false);
  assert.equal(urlBody.mode, "merge");
  assert.equal(urlBody.sourceUrl, "https://catalog.example.test/models.json");
  assert.equal(urlBody.maxAgeDays, 45);
  assert.equal(urlBody.savePolicy, true);
  assert.equal(urlBody.refreshIntervalHours, 12);
  const syncDueBody = seenBodies[2] as {
    dryRun: boolean;
    app: string;
    providerIds: string[];
    limit: number;
  };
  assert.equal(syncDueBody.dryRun, true);
  assert.equal(syncDueBody.app, "codex");
  assert.deepEqual(syncDueBody.providerIds, ["provider-1"]);
  assert.equal(syncDueBody.limit, 5);
});

test("proxy status calls configured API", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-proxy-"));
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (request.url !== "/v1/proxy/status") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ proxy: { status: "stopped", port: 15721 } }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [join(process.cwd(), "dist-test", "src", "index.js"), "proxy", "status"],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /stopped/);
  assert.deepEqual(seenUrls, ["/v1/proxy/status"]);
});

test("proxy health calls configured API with app filter", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-proxy-health-"));
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (request.url !== "/v1/proxy/health?app=codex") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ health: [{ providerId: "provider-1", state: "healthy" }] }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "proxy",
      "health",
      "--app",
      "codex"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /healthy/);
  assert.deepEqual(seenUrls, ["/v1/proxy/health?app=codex"]);
});

test("proxy health-reset calls configured API with provider and app", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-proxy-health-reset-"));
  const seen: Array<{ url: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    seen.push({ url: request.url ?? "", body });
    if (request.method !== "POST" || request.url !== "/v1/proxy/health/reset") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ providerId: "provider-1", app: "codex", resetCount: 1 }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "proxy",
      "health-reset",
      "--app",
      "codex",
      "provider-1"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /resetCount/);
  assert.deepEqual(seen, [
    {
      url: "/v1/proxy/health/reset",
      body: { providerId: "provider-1", app: "codex" }
    }
  ]);
});

test("usage summary calls configured API with filters", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-usage-"));
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (request.url !== "/v1/usage/summary?app=codex&providerId=provider-1&runId=run-1&candidateId=codex-1&limit=50") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        summary: {
          requestCount: 1,
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16
        }
      }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "usage",
      "summary",
      "--app",
      "codex",
      "--provider",
      "provider-1",
      "--run",
      "run-1",
      "--candidate",
      "codex-1",
      "--limit",
      "50"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /totalTokens/);
  assert.deepEqual(seenUrls, [
    "/v1/usage/summary?app=codex&providerId=provider-1&runId=run-1&candidateId=codex-1&limit=50"
  ]);
});

test("session list and show call configured API with filters", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-session-"));
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (
      request.url ===
      "/v1/sessions?app=codex&homeDir=%2Ftmp%2Fmn-home&limit=5&offset=10&query=build&redact=true"
    ) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ sessions: [{ id: "codex:abc", title: "Build" }] }));
      return;
    }
    if (
      request.url ===
      "/v1/sessions/codex%3Aabc?app=codex&homeDir=%2Ftmp%2Fmn-home&redact=true"
    ) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ session: { id: "codex:abc", messages: [] } }));
      return;
    }
    if (
      request.url ===
      "/v1/sessions/codex%3Aabc/export?app=codex&homeDir=%2Ftmp%2Fmn-home&redact=true"
    ) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            version: 1,
            kind: "mniu.session.export",
            redacted: true,
            session: { id: "codex:abc", title: "Build", messages: [] }
          })
        );
      return;
    }
    response.writeHead(404).end();
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const listResult = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "session",
      "list",
      "--app",
      "codex",
      "--home",
      "/tmp/mn-home",
      "--limit",
      "5",
      "--offset",
      "10",
      "--query",
      "build",
      "--redact"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );
  assert.match(listResult.stdout, /Build/);

  const showResult = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "session",
      "show",
      "codex:abc",
      "--app",
      "codex",
      "--home",
      "/tmp/mn-home",
      "--redact"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );
  assert.match(showResult.stdout, /codex:abc/);
  const exportPath = join(cwd, "session-export.json");
  const exportResult = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "session",
      "export",
      "codex:abc",
      "--app",
      "codex",
      "--home",
      "/tmp/mn-home",
      "--out",
      exportPath
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );
  assert.match(exportResult.stdout, /Exported session codex:abc/);
  const exported = JSON.parse(await readFile(exportPath, "utf8"));
  assert.equal(exported.redacted, true);
  assert.equal(exported.session.title, "Build");
  assert.deepEqual(seenUrls, [
    "/v1/sessions?app=codex&homeDir=%2Ftmp%2Fmn-home&limit=5&offset=10&query=build&redact=true",
    "/v1/sessions/codex%3Aabc?app=codex&homeDir=%2Ftmp%2Fmn-home&redact=true",
    "/v1/sessions/codex%3Aabc/export?app=codex&homeDir=%2Ftmp%2Fmn-home&redact=true"
  ]);
});

test("run artifacts calls configured API", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-run-artifacts-"));
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (
      request.url !==
      "/v1/runs/run-1/artifacts?candidateId=codex-1&kind=log&persisted=true"
    ) {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          artifacts: [
            {
              id: "codex-1:stdout",
              kind: "log",
              path: "mn://runs/run-1/candidates/codex-1/stdout.txt"
            }
          ]
        })
      );
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "run",
      "artifacts",
      "run-1",
      "--candidate",
      "codex-1",
      "--kind",
      "log",
      "--persisted",
      "true"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /codex-1:stdout/);
  assert.deepEqual(seenUrls, [
    "/v1/runs/run-1/artifacts?candidateId=codex-1&kind=log&persisted=true"
  ]);
});

test("run artifact downloads configured API content", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-run-artifact-"));
  const outputPath = join(cwd, "stdout.txt");
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (request.url !== "/v1/runs/run-1/artifacts/codex-1%3Astdout") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="stdout.txt"'
      })
      .end("downloaded artifact\n");
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "run",
      "artifact",
      "run-1",
      "codex-1:stdout",
      "--out",
      outputPath
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /stdout\.txt/);
  assert.equal(await readFile(outputPath, "utf8"), "downloaded artifact\n");
  assert.deepEqual(seenUrls, ["/v1/runs/run-1/artifacts/codex-1%3Astdout"]);
});

test("run artifacts-download saves configured API archive", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-run-artifacts-archive-"));
  const outputPath = join(cwd, "artifacts.tar");
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (request.url !== "/v1/runs/run-1/artifacts/archive?candidateId=codex-1&kind=log") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, {
        "content-type": "application/x-tar",
        "content-disposition": 'attachment; filename="run-1-artifacts.tar"'
      })
      .end("tar archive payload");
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "run",
      "artifacts-download",
      "run-1",
      "--candidate",
      "codex-1",
      "--kind",
      "log",
      "--out",
      outputPath
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /artifacts\.tar/);
  assert.equal(await readFile(outputPath, "utf8"), "tar archive payload");
  assert.deepEqual(seenUrls, [
    "/v1/runs/run-1/artifacts/archive?candidateId=codex-1&kind=log"
  ]);
});

test("run cleanup posts configured API when confirmed", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-run-cleanup-"));
  const seenRequests: Array<{ method?: string; url?: string }> = [];
  const server = createServer(async (request, response) => {
    seenRequests.push({ method: request.method, url: request.url });
    if (
      request.method !== "POST" ||
      request.url !== "/v1/runs/run-1/workspaces/cleanup"
    ) {
      response.writeHead(404).end();
      return;
    }

    let bodyBytes = 0;
    for await (const chunk of request) {
      bodyBytes += Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    assert.equal(bodyBytes > 0, true);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ results: [{ candidateId: "codex-1", status: "deleted" }] }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "run",
      "cleanup",
      "run-1",
      "--yes"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /deleted/);
  assert.deepEqual(seenRequests, [
    { method: "POST", url: "/v1/runs/run-1/workspaces/cleanup" }
  ]);
});

test("artifact-store summary and cleanup call configured API", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-artifact-store-"));
  const seenRequests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/artifacts/store") {
      seenRequests.push({ method: request.method, url: request.url });
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ totalRuns: 1, totalArtifacts: 2, totalBytes: 42 }));
      return;
    }

    if (request.method === "POST" && request.url === "/v1/artifacts/store/cleanup") {
      let body = "";
      for await (const chunk of request) {
        body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      }
      const parsed = JSON.parse(body);
      seenRequests.push({ method: request.method, url: request.url, body: parsed });
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ dryRun: parsed.dryRun, candidateRuns: 1, deleted: [] }));
      return;
    }

    response.writeHead(404).end();
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;
  const cliPath = join(process.cwd(), "dist-test", "src", "index.js");

  const summary = await execFileAsync(
    process.execPath,
    [cliPath, "artifact-store", "summary"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(summary.stdout, /totalRuns/);

  const dryRun = await execFileAsync(
    process.execPath,
    [cliPath, "artifact-store", "cleanup", "--keep-latest-runs", "1"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(dryRun.stdout, /candidateRuns/);

  const confirmed = await execFileAsync(
    process.execPath,
    [cliPath, "artifact-store", "cleanup", "--keep-latest-runs", "1", "--yes"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(confirmed.stdout, /candidateRuns/);

  const quotaDryRun = await execFileAsync(
    process.execPath,
    [cliPath, "artifact-store", "cleanup", "--max-bytes", "4096"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(quotaDryRun.stdout, /candidateRuns/);

  const remoteDryRun = await execFileAsync(
    process.execPath,
    [cliPath, "artifact-store", "cleanup", "--keep-latest-runs", "1", "--scope", "remote"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(remoteDryRun.stdout, /candidateRuns/);

  assert.deepEqual(seenRequests, [
    { method: "GET", url: "/v1/artifacts/store" },
    {
      method: "POST",
      url: "/v1/artifacts/store/cleanup",
      body: { dryRun: true, keepLatestRuns: 1 }
    },
    {
      method: "POST",
      url: "/v1/artifacts/store/cleanup",
      body: { dryRun: false, keepLatestRuns: 1 }
    },
    {
      method: "POST",
      url: "/v1/artifacts/store/cleanup",
      body: { dryRun: true, maxBytes: 4096 }
    },
    {
      method: "POST",
      url: "/v1/artifacts/store/cleanup",
      body: { dryRun: true, scope: "remote", keepLatestRuns: 1 }
    }
  ]);
});

test("run resume posts configured API and prints replacement run", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-run-resume-"));
  const seenRequests: Array<{ method?: string; url?: string }> = [];
  const server = createServer(async (request, response) => {
    seenRequests.push({ method: request.method, url: request.url });
    if (request.method !== "POST" || request.url !== "/v1/runs/run-1/resume") {
      response.writeHead(404).end();
      return;
    }

    let bodyBytes = 0;
    for await (const chunk of request) {
      bodyBytes += Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    assert.equal(bodyBytes > 0, true);
    response
      .writeHead(201, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          resumedFromRunId: "run-1",
          run: { id: "run-2", status: "queued" }
        })
      );
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "run",
      "resume",
      "run-1"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /run-2/);
  assert.deepEqual(seenRequests, [
    { method: "POST", url: "/v1/runs/run-1/resume" }
  ]);
});

test("mcp list calls configured API with app filter", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-mcp-"));
  const seenUrls: string[] = [];
  const server = createServer((request, response) => {
    seenUrls.push(request.url ?? "");
    if (request.url !== "/v1/mcp/servers?app=claude") {
      response.writeHead(404).end();
      return;
    }

    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ servers: [{ id: "mcp-1", name: "weather" }] }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "mcp",
      "list",
      "--app",
      "claude"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /weather/);
  assert.deepEqual(seenUrls, ["/v1/mcp/servers?app=claude"]);
});

test("prompt activate posts app home and dry-run payload", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-prompt-"));
  const seenBodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/prompts/presets/prompt-1/activate" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    seenBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ activation: { id: "activation-1" } }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "prompt",
      "activate",
      "prompt-1",
      "--app",
      "codex",
      "--home",
      "/tmp/mn-home",
      "--dry-run"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /activation-1/);
  assert.deepEqual(seenBodies, [
    { app: "codex", homeDir: "/tmp/mn-home", dryRun: true }
  ]);
});

test("skill install posts app mode home and dry-run payload", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-skill-"));
  const seenBodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/skills/skill-1/install" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    seenBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ installation: { id: "installation-1" } }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "skill",
      "install",
      "skill-1",
      "--app",
      "claude",
      "--mode",
      "symlink",
      "--home",
      "/tmp/mn-home",
      "--dry-run"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /installation-1/);
  assert.deepEqual(seenBodies, [
    { app: "claude", mode: "symlink", homeDir: "/tmp/mn-home", dryRun: true }
  ]);
});

test("skill registry-sync posts signed registry options", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-skill-registry-"));
  const seenBodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/skills/registry/sync" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    seenBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ skills: [{ name: "review", status: "new" }] }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "skill",
      "registry-sync",
      "--url",
      "https://registry.example.test/skills.json",
      "--require-signature",
      "--require-release-metadata",
      "--public-key",
      "public-key",
      "--trusted-public-key",
      "key-2026=trusted-key",
      "--revoked-public-key-id",
      "key-2025",
      "--yes"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /review/);
  assert.deepEqual(seenBodies, [
    {
      registryUrl: "https://registry.example.test/skills.json",
      dryRun: false,
      requireSignature: true,
      requireReleaseMetadata: true,
      publicKey: "public-key",
      trustedPublicKeys: [{ id: "key-2026", publicKey: "trusted-key" }],
      revokedPublicKeyIds: ["key-2025"]
    }
  ]);
});

test("skill registry-profile manages trusted registry profiles", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-skill-registry-profile-"));
  const seenRequests: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    body?: unknown;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    seenRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body
    });

    if (request.url === "/v1/skills/registry/profiles" && request.method === "POST") {
      response
        .writeHead(201, { "content-type": "application/json" })
        .end(JSON.stringify({ id: "profile-1", name: "Trusted Registry" }));
      return;
    }
    if (request.url === "/v1/skills/registry/profiles" && request.method === "GET") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ profiles: [{ id: "profile-1", name: "Trusted Registry" }] }));
      return;
    }
    if (
      request.url === "/v1/skills/registry/profiles/profile-1/sync" &&
      request.method === "POST"
    ) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ skills: [{ name: "review", status: "new" }] }));
      return;
    }
    if (
      request.url === "/v1/skills/registry/profiles/profile-1" &&
      request.method === "DELETE"
    ) {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;
  env.MN_API_TOKEN = "enterprise-cli-token";
  const cli = join(process.cwd(), "dist-test", "src", "index.js");

  const add = await execFileAsync(
    process.execPath,
    [
      cli,
      "skill",
      "registry-profile",
      "add",
      "--name",
      "Trusted Registry",
      "--url",
      "https://registry.example.test/skills.json",
      "--require-signature",
      "--require-release-metadata",
      "--trusted-public-key",
      "key-2026=trusted-key",
      "--revoked-public-key-id",
      "key-2025"
    ],
    { cwd, env, timeout: 10000 }
  );
  assert.match(add.stdout, /profile-1/);

  const list = await execFileAsync(
    process.execPath,
    [cli, "skill", "registry-profile", "list"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(list.stdout, /Trusted Registry/);

  const sync = await execFileAsync(
    process.execPath,
    [cli, "skill", "registry-profile", "sync", "profile-1", "--yes"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(sync.stdout, /review/);

  const remove = await execFileAsync(
    process.execPath,
    [cli, "skill", "registry-profile", "delete", "profile-1"],
    { cwd, env, timeout: 10000 }
  );
  assert.match(remove.stdout, /Deleted registry profile profile-1/);

  assert.deepEqual(seenRequests, [
    {
      method: "POST",
      url: "/v1/skills/registry/profiles",
      authorization: "Bearer enterprise-cli-token",
      body: {
        name: "Trusted Registry",
        registryUrl: "https://registry.example.test/skills.json",
        requireSignature: true,
        requireReleaseMetadata: true,
        trustedPublicKeys: [{ id: "key-2026", publicKey: "trusted-key" }],
        revokedPublicKeyIds: ["key-2025"]
      }
    },
    {
      method: "GET",
      url: "/v1/skills/registry/profiles",
      authorization: "Bearer enterprise-cli-token",
      body: undefined
    },
    {
      method: "POST",
      url: "/v1/skills/registry/profiles/profile-1/sync",
      authorization: "Bearer enterprise-cli-token",
      body: { dryRun: false }
    },
    {
      method: "DELETE",
      url: "/v1/skills/registry/profiles/profile-1",
      authorization: "Bearer enterprise-cli-token",
      body: undefined
    }
  ]);
});

test("run posts queue priority when requested", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-run-priority-"));
  const seenBodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/tasks/task-priority/runs") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    seenBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response
      .writeHead(201, { "content-type": "application/json" })
      .end(JSON.stringify({
        id: "run-priority",
        taskId: "task-priority",
        status: "queued"
      }));
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "run",
      "--task",
      "task-priority",
      "--queue-only",
      "--priority",
      "-7"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /run-priority/);
  assert.deepEqual(seenBodies, [
    {
      queueOnly: true,
      wait: false,
      queuePriority: -7
    }
  ]);
});

test("run worker claims a queued job and finishes it", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-run-worker-"));
  const projectRoot = join(cwd, "project");
  const workspaceRoot = join(cwd, "worktrees");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "worker-project", version: "1.0.0" }, null, 2)}\n`
  );

  const events: unknown[] = [];
  const updates: unknown[] = [];
  const claimBodies: Record<string, any>[] = [];
  const eventBodies: Record<string, any>[] = [];
  const updateBodies: Record<string, any>[] = [];
  const finishBodies: Record<string, any>[] = [];
  let finishedRun: { status?: string; candidates?: unknown[] } | undefined;
  const project = {
    id: "project-worker",
    name: "worker project",
    rootPath: projectRoot,
    defaultBranch: "main",
    services: []
  };
  const task = {
    id: "task-worker",
    projectId: project.id,
    title: "worker task",
    intent: "implement",
    targetServices: [],
    prompt: "make no changes",
    acceptanceCriteria: ["mock executor completes"],
    strategy: {
      providers: ["claude"],
      candidates: 1,
      sandbox: "workspace-write",
      requiredGates: [],
      humanApproval: "never",
      timeoutSeconds: 60
    }
  };
  const queuedRun = {
    id: "run-worker",
    taskId: task.id,
    projectId: project.id,
    status: "queued",
    candidates: [],
    gates: [],
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z"
  };
  const queueItem = {
    runId: queuedRun.id,
    projectId: project.id,
    taskId: task.id,
    status: "running",
    ownerId: "cli-worker-test"
  };

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>)
      : {};

    if (request.method === "POST" && request.url === "/v1/run-jobs/queue/claim") {
      claimBodies.push(body);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ item: queueItem, claimToken: "claim-token" }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/run-jobs/queue/run-worker/heartbeat") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ item: queueItem }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/run-jobs/queue/run-worker/events") {
      eventBodies.push(body);
      events.push(body.event);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ item: queueItem }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/run-jobs/queue/run-worker/update") {
      updateBodies.push(body);
      updates.push(body.run);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ run: body.run, item: queueItem }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/run-jobs/queue/run-worker/finish") {
      finishBodies.push(body);
      finishedRun = body.run;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({
          run: body.run,
          item: { ...queueItem, status: "completed" }
        }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/projects/project-worker") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(project));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/tasks/task-worker") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(task));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/runs/run-worker") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(queuedRun));
      return;
    }

    response.writeHead(404).end();
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "run",
      "worker",
      "--once",
      "--mock",
      "--owner",
      "cli-worker-test",
      "--ttl-ms",
      "60000",
      "--capacity",
      "3",
      "--workspace-root",
      workspaceRoot
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /"status": "completed"/);
  assert.equal(claimBodies[0]?.capacity, 3);
  assert.equal(eventBodies[0]?.capacity, 3);
  assert.equal(updateBodies[0]?.capacity, 3);
  assert.equal(finishBodies[0]?.capacity, 3);
  assert.equal(finishedRun?.status, "completed");
  assert.equal(finishedRun?.candidates?.length, 1);
  assert.equal(
    events.some((event) =>
      JSON.stringify(event).includes("mock claude completed")
    ),
    true
  );
  assert.equal(
    updates.some((update) => JSON.stringify(update).includes("claude-1")),
    true
  );
});

test("enterprise worker registers and claims with machine JWT capabilities", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-enterprise-worker-"));
  const requests: Array<{
    url: string;
    authorization?: string;
    body: Record<string, any>;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : {};
    requests.push({
      url: request.url ?? "",
      authorization:
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined,
      body
    });
    if (request.url === "/v1/run-jobs/workers/heartbeat") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ worker: { ownerId: "worker-machine", status: "idle" } })
      );
      return;
    }
    if (request.url === "/v1/run-jobs/queue/claim") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ item: null, claimToken: null })
      );
      return;
    }
    response.writeHead(404).end();
  });
  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "run",
      "worker",
      "--enterprise",
      "--once",
      "--mock",
      "--language",
      "javascript",
      "--tool",
      "node"
    ],
    {
      cwd,
      env: {
        ...process.env,
        MN_API_URL: `http://127.0.0.1:${address.port}`,
        MN_API_TOKEN: `e30.${Buffer.from(JSON.stringify({ sub: "worker-machine" })).toString("base64url")}.signature`,
        MN_WORKER_INSTANCE_ID: "worker-pod-1"
      },
      timeout: 10_000
    }
  );
  assert.match(result.stdout, /No claimable run jobs/u);
  assert.deepEqual(
    requests.map((request) => request.url),
    ["/v1/run-jobs/workers/heartbeat", "/v1/run-jobs/queue/claim"]
  );
  assert.equal(requests.every((request) => request.authorization?.startsWith("Bearer e30.")), true);
  const heartbeat = requests[0]!.body;
  const claim = requests[1]!.body;
  assert.equal(heartbeat.ownerId, "worker-machine@worker-pod-1");
  assert.equal(claim.ownerId, "worker-machine@worker-pod-1");
  assert.deepEqual(heartbeat.capabilities, claim.capabilities);
  assert.deepEqual(claim.capabilities.providers, ["builtin"]);
  assert.deepEqual(claim.capabilities.languages, ["javascript"]);
  assert.deepEqual(claim.capabilities.tools, ["node"]);
  assert.equal(claim.capabilities.sandboxBackends[0].enforcement, "enforced");
  assert.equal(
    claim.capabilities.sandboxBackends[0].capabilities.includes("runtime-inspection"),
    true
  );
});

test("enterprise worker fails closed before heartbeat for an external CLI compatibility runtime", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        join(process.cwd(), "dist-test", "src", "index.js"),
        "run",
        "worker",
        "--enterprise",
        "--once",
        "--owner",
        "worker-machine",
        "--provider",
        "claude"
      ],
      {
        env: {
          ...process.env,
          MN_API_URL: "http://127.0.0.1:1",
          MN_API_TOKEN: "machine-token"
        },
        timeout: 10_000
      }
    ),
    (error: any) => {
      assert.match(error.stderr ?? "", /Claude\/Codex compatibility execution is unavailable/u);
      assert.doesNotMatch(error.stderr ?? "", /ECONNREFUSED/u);
      return true;
    }
  );
});

test("run workers lists worker fleet state", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mn-cli-run-workers-"));
  const server = createServer((request, response) => {
    if (
      request.method === "GET" &&
      request.url === "/v1/run-jobs/workers?state=running&ownerId=cli-worker-test"
    ) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            workers: [
              {
                ownerId: "cli-worker-test",
                state: "running",
                status: "running",
                activeRunId: "run-worker",
                lastSeenAt: "2026-07-06T00:00:01.000Z",
                heartbeatExpiresAt: "2026-07-06T00:01:01.000Z",
                completedRunCount: 1,
                failedRunCount: 0,
                cancelledRunCount: 0,
                releasedRunCount: 0
              }
            ],
            summary: {
              total: 1,
              idle: 0,
              running: 1,
              stale: 0
            }
          })
        );
      return;
    }

    response.writeHead(404).end();
  });

  t.after(async () => {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  const apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(join(cwd, ".mn"), { recursive: true });
  await writeFile(
    join(cwd, ".mn", "config.json"),
    `${JSON.stringify({ apiUrl }, null, 2)}\n`
  );

  const env = { ...process.env };
  delete env.MN_API_URL;

  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "src", "index.js"),
      "run",
      "workers",
      "--state",
      "running",
      "--owner",
      "cli-worker-test"
    ],
    {
      cwd,
      env,
      timeout: 10000
    }
  );

  assert.match(result.stdout, /"ownerId": "cli-worker-test"/);
  assert.match(result.stdout, /"activeRunId": "run-worker"/);
  assert.match(result.stdout, /"running": 1/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
